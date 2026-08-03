import {
    Mutex, getDateTime, normalizeUrl, stripSign, numOrNull,
    calcImportPercent, selectorKeyForUrl, effectiveStockUrl, etfPrefixForCode
} from '../shared/utils.js';
import { parseWc1, parseXq1 } from './parsers.js';
import { applyThresholds } from './notifications.js';
import { renderStock, renderPagination, renderSortToggles, renderComboSwitches } from './render.js';
import { createEditForm } from './editform.js';

const mutex = new Mutex();

// service worker 回收/重启会断开长连接：自动重连，避免弹窗静默停更；
// 扩展上下文失效（重载扩展）时 connect 抛错即停止重连，重开弹窗恢复
let port = null;
function connectPort() {
    try {
        port = chrome.runtime.connect({ name: 'popup-connection' });
    } catch {
        return;
    }
    port.onMessage.addListener(handleCaptured);
    port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
}
connectPort();

// 诊断日志开关：置 false 可停止逐次抓取的 info 刷屏（warn/error 始终保留）
const DEBUG = true;
const dbg = (...args) => { if (DEBUG) console.log('[thswc:popup]', ...args); };

// ---------------- 模块状态 ----------------
let selectorName = '';
let currentView = 'list';   // 'list' 股票列表 | 'trash' 垃圾池
let currentPage = 1;
let pageSize = 10;
let currentSort = 'default'; // 'default' | 'percent-asc/desc' | 'importPercent-asc/desc'
let portfolios = {};
let activePortfolio = '默认';
let stockList = [];
let editUrl = undefined;

// 抓取规则（解析在 parsers.js，按域名派发）
const selectorsEnum = {
    "wc1": { // 同花顺问财
        name: ".input-base-copy",
        code: ".diagnosisList .code",
        dqj: ".code-info-bar .price",
        zdf: ".code-info-bar .rise-fall",
        percent: ".code-info-bar .rise-fall-rate"
    },
    "xq1": { // 雪球个股页
        name: ".stock-name",
        dqj: ".stock-price .stock-current",
        zdf: ".stock-price .stock-change"
    }
};

// ---------------- DOM 引用 ----------------
const quickOpenEl = document.getElementById('quickOpen');
const lastUpdateTimeEl = document.getElementById('lastUpdateTime');
const intervalInput = document.getElementById('interval');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const selectorEl = document.getElementById('selectorName');
const addStockEl = document.getElementById('addStock');
const overlayEl = document.querySelector('.overlay');
const closeBtnEl = document.querySelector('.close-btn');
const lastMonitorEl = document.getElementById('lastMonitor');
const saveStockBtnEl = document.getElementById('saveStock');
const delStockBtnEl = document.getElementById('delStock');
const stockTableEl = document.getElementById('stockTable');
const stockUrlEl = document.getElementById('stockUrl');
const stockUrlGroupEl = document.getElementById('stockUrlGroup');
const alertDimDailyBtnEl = document.getElementById('alertDimDailyBtn');
const alertDimImportBtnEl = document.getElementById('alertDimImportBtn');
const dailyTargetGroupEl = document.getElementById('dailyTargetGroup');
const importTargetGroupEl = document.getElementById('importTargetGroup');
const stockNameEl = document.getElementById('stockName');
const stockCodeEl = document.getElementById('stockCode');
const lastUpdateAtEl = document.getElementById('lastUpdateAt');
const headerCurrentPriceEl = document.getElementById('headerCurrentPrice');
const startPriceEl = document.getElementById('startPrice');
const percentEl = document.getElementById('percent');
const targetPriceEl = document.getElementById('targetPrice');
const targetPercentLeEl = document.getElementById('targetPercentLe');
const targetPercentGeEl = document.getElementById('targetPercentGe');
const dailyLePriceInputEl = document.getElementById('dailyLePriceInput');
const dailyGePriceInputEl = document.getElementById('dailyGePriceInput');
const importPriceInputEl = document.getElementById('importPriceInput');
const importPercentEl = document.getElementById('importPercent');
const importTargetPriceEl = document.getElementById('importTargetPrice');
const importTargetPercentLeEl = document.getElementById('importTargetPercentLe');
const importTargetPercentGeEl = document.getElementById('importTargetPercentGe');
const importLePriceInputEl = document.getElementById('importLePriceInput');
const importGePriceInputEl = document.getElementById('importGePriceInput');
const trashToggleBtnEl = document.getElementById('trashToggleBtn');
const editActionsTopEl = document.getElementById('editActionsTop');
const viewTitleEl = document.getElementById('viewTitle');
const viewListBtnEl = document.getElementById('viewListBtn');
const viewTrashBtnEl = document.getElementById('viewTrashBtn');
const paginationBarEl = document.getElementById('paginationBar');
const exportBtnEl = document.getElementById('exportBtn');
const importBtnEl = document.getElementById('importBtn');
const importFileInputEl = document.getElementById('importFileInput');
const comboSwitchesEl = document.getElementById('comboSwitches');
const comboLabelEl = document.getElementById('comboLabel');
const sortToggleEls = document.querySelectorAll('.sort-toggle');

// 编辑表单（封装渲染/清空/联动）
const editForm = createEditForm({
    stockNameEl, stockCodeEl, stockUrlEl, headerCurrentPriceEl, lastUpdateAtEl,
    startPriceEl, percentEl, targetPriceEl,
    importPriceInputEl, importPercentEl, importTargetPriceEl,
    targetPercentLeEl, targetPercentGeEl, dailyLePriceInputEl, dailyGePriceInputEl,
    importTargetPercentLeEl, importTargetPercentGeEl, importLePriceInputEl, importGePriceInputEl,
    editActionsTopEl, trashToggleBtnEl,
}, { getStock: editingStock });
editForm.bindLinkage();

// ---------------- 工具 ----------------
function storageGet(area, keys) {
    return new Promise(resolve => area.get(keys, resolve));
}

function editingStock() {
    return stockList.find(s => s.url === editUrl);
}

// 保存并重渲染（启停/置顶/垃圾池/删除/保存/抓取共用）
function saveAndRender() {
    if (portfolios[activePortfolio]) portfolios[activePortfolio].stockList = stockList;
    chrome.storage.local.set({ stockList, portfolios }, () => {
        renderStockList();
        chrome.runtime.sendMessage({ action: 'refresh' });
    });
}

function refreshCombos() {
    // 无组合时仅隐藏标签（分页仍在同行），chips 容器由渲染函数清空
    comboLabelEl.style.display = Object.keys(portfolios).length ? '' : 'none';
    renderComboSwitches(portfolios, activePortfolio, comboSwitchesEl, { onSwitch: switchPortfolio, onDelete: deletePortfolio });
}

// ---------------- 抓取处理 ----------------
async function handleCaptured(message) {
    if (message.type !== 'DOCUMENT_CAPTURED') return;
    await mutex.lock();
    try {
        const messageUrl = message.documentData.url;
        dbg('收到抓取:', messageUrl);
        // 匹配双目标：存储 URL 与生效 URL（xq1 下为拼接的雪球链接，过渡期两种页面都会收到）；
        // 页面加载后 iwencai 会追加 &sign=，比较前需剔除
        const strippedMsg = stripSign(messageUrl);
        const index = stockList.findIndex(item =>
            stripSign(item.url) === strippedMsg
            || stripSign(effectiveStockUrl(item, selectorName)) === strippedMsg);
        if (index === -1) {
            console.warn('[thswc:popup] URL 匹配失败!\n  来址(剔sign):', stripSign(messageUrl),
                '\n  已存列表:', stockList.map(s => ({ 原始: s.url, 剔sign: stripSign(s.url) })));
            return;
        }
        const stock = stockList[index];
        if (stock.stopRunning) {
            dbg('该股票已停止，跳过解析:', messageUrl);
            return; // 已停止：不解析、不通知
        }

        if (!message.documentData.html) return;
        const doc = new DOMParser().parseFromString(message.documentData.html, 'text/html');
        // 解析规则按股票 url 域名派发（与下拉选择无关，支持混站点）
        const key = selectorKeyForUrl(messageUrl);
        const selector = key ? selectorsEnum[key] : null;
        if (!selector) return;
        const parsed = key === 'wc1' ? parseWc1(doc, selector) : parseXq1(doc, selector);
        if (!parsed) {
            console.error('[thswc:popup] 解析失败/名称为空（选择器可能已失效）:', messageUrl, '| 选择器:', JSON.stringify(selector));
            return;
        }
        dbg('解析成功:', key, JSON.stringify(parsed));
        stock.name = parsed.name;
        if (parsed.code) stock.code = parsed.code;
        if (parsed.prefix) stock.prefix = parsed.prefix;
        if (parsed.startPrice != null) stock.startPrice = parsed.startPrice;
        if (parsed.currentPrice != null) {
            stock.currentPrice = parsed.currentPrice;
            if (stock.importPrice == null) stock.importPrice = parsed.currentPrice; // 初始价格首次回填
        }
        if (parsed.percent != null) stock.percent = parsed.percent;
        stock.lastUpdateAt = message.documentData.timestamp || Date.now(); // 股票级最新刷新时间
        applyThresholds(stock);
        lastUpdateTimeEl.textContent = getDateTime();
        // 同步写回活动组合，避免切换组合时读到旧价格
        if (portfolios[activePortfolio]) portfolios[activePortfolio].stockList = stockList;
        chrome.storage.local.set({ stockList, portfolios }, () => renderStockList());
    } catch (err) {
        console.error('数据更新错误:', err);
        lastUpdateTimeEl.textContent = '数据更新失败 ' + getDateTime();
    } finally {
        mutex.unlock();
    }
}

// ---------------- 列表渲染 ----------------
function getViewList() {
    const filtered = stockList.filter(s => currentView === 'trash' ? s.inTrash : !s.inTrash);
    const pinned = filtered.filter(s => s.pinned)
        .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
    const rest = filtered.filter(s => !s.pinned);
    if (currentSort !== 'default') {
        const idx = currentSort.lastIndexOf('-');
        const field = currentSort.slice(0, idx);
        const dir = currentSort.slice(idx + 1) === 'asc' ? 1 : -1;
        rest.sort((a, b) => {
            const va = field === 'percent' ? numOrNull(a.percent) : calcImportPercent(a.currentPrice, a.importPrice);
            const vb = field === 'percent' ? numOrNull(b.percent) : calcImportPercent(b.currentPrice, b.importPrice);
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            return (va - vb) * dir;
        });
    }
    return [...pinned, ...rest];
}

function renderStockList() {
    const list = getViewList();
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const pageItems = list.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    stockTableEl.innerHTML = '';
    for (const stock of pageItems) {
        stockTableEl.appendChild(renderStock(stock, selectorName, {
            onEdit: () => openEdit(stock),
            onStop: () => { stock.stopRunning = !stock.stopRunning; saveAndRender(); },
            onTogglePin: (s) => {
                if (s.pinned) {
                    // 取消置顶：移到数组首位 → 落在未置顶分组的第一位（紧随置顶分组之后）
                    s.pinned = false;
                    s.pinOrder = null;
                    stockList.splice(stockList.indexOf(s), 1);
                    stockList.unshift(s);
                } else {
                    // 置顶：新置顶项排第 1，其余置顶项顺序依次 +1。
                    // 旧置顶按现有 pinOrder 相对序重编为 2..n+1（兼容旧版负数编号），新项固定为 1
                    stockList.filter(x => x.pinned && x !== s)
                        .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0))
                        .forEach((x, i) => { x.pinOrder = i + 2; });
                    s.pinned = true;
                    s.pinOrder = 1;
                }
                saveAndRender();
            },
        }));
    }
    renderPagination(paginationBarEl, { currentPage, totalPages, total: list.length, pageSize }, {
        onPrev: () => { currentPage--; renderStockList(); },
        onNext: () => { currentPage++; renderStockList(); },
        onPageSize: (v) => {
            pageSize = v;
            chrome.storage.sync.set({ pageSize: v });
            currentPage = 1;
            renderStockList();
        },
    });
    renderSortToggles(currentSort, sortToggleEls);
}

// ---------------- 视图 / 组合 ----------------
function updateViewToggleUI() {
    viewTitleEl.textContent = currentView === 'trash' ? '垃圾池' : '股票列表';
    viewListBtnEl.classList.toggle('active', currentView === 'list');
    viewTrashBtnEl.classList.toggle('active', currentView === 'trash');
}

function switchView(view) {
    if (currentView === view) return;
    currentView = view;
    chrome.storage.local.set({ currentView: view });
    chrome.runtime.sendMessage({ action: 'setView', view }); // background 按新视图重排刷新任务
    currentPage = 1;
    updateViewToggleUI();
    renderStockList();
}

function switchPortfolio(name) {
    if (!portfolios[name] || name === activePortfolio) return;
    activePortfolio = name;
    stockList = portfolios[name].stockList || [];
    selectorName = portfolios[name].selectorName || 'wc1';
    selectorEl.value = selectorName;
    chrome.storage.local.set({ activePortfolio, stockList });
    chrome.storage.sync.set({ selectorName });
    currentPage = 1;
    currentSort = 'default';
    refreshCombos();
    renderStockList();
    chrome.runtime.sendMessage({ action: 'refresh' });
}

// 删除组合：初始组合「默认」不可删；活动组合须先切走（避免活动指针悬空）；删除前 confirm 防误触
function deletePortfolio(name) {
    if (!portfolios[name]) return;
    if (name === '默认') { alert('初始组合「默认」不可删除'); return; }
    if (name === activePortfolio) { alert('当前组合使用中，请先切换到其他组合再删除'); return; }
    if (!confirm(`删除组合「${name}」？组合内的股票快照将一并删除`)) return;
    delete portfolios[name];
    chrome.storage.local.set({ portfolios }, refreshCombos);
}

// ---------------- 导入 / 导出 ----------------
function comboTimestamp() {
    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
}

function validComboName(n) {
    return typeof n === 'string' && n.trim().length > 0 && n.trim().length <= 4;
}

function nameFromFile(fileName) {
    let base = (fileName || '').replace(/\.json$/i, '');
    return base.replace(/_\d{8}-\d{6}$/, ''); // 去掉尾部时间戳
}

// 组合命名弹窗：返回有效名或 null（取消/非法）
function promptComboName(message, prefilled) {
    const input = prompt(message, prefilled || '');
    if (input === null) return null;
    const name = input.trim();
    if (!validComboName(name)) { alert('组合命名必须为1-4个字'); return null; }
    return name;
}

async function handleExport() {
    const defName = (activePortfolio && activePortfolio !== '默认') ? activePortfolio : '';
    let name = promptComboName('组合命名（不超过4字，留空则为“问财导出”）：', defName);
    if (name === null) return;
    if (name === '') name = '问财导出';
    const localData = await storageGet(chrome.storage.local, ['stockList']);
    const syncData = await storageGet(chrome.storage.sync, ['refreshInterval', 'selectorName', 'pageSize']);
    const listSnapshot = (localData.stockList || []).map(s => ({ ...s }));
    const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        portfolioName: name,
        settings: {
            refreshInterval: syncData.refreshInterval,
            selectorName: syncData.selectorName,
            pageSize: syncData.pageSize,
        },
        stockList: listSnapshot,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.download = `${name}_${comboTimestamp()}.json`;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
    // 登记/更新组合（导出即快照）
    portfolios[name] = { stockList: listSnapshot, selectorName };
    await new Promise(r => chrome.storage.local.set({ portfolios }, r));
    refreshCombos();
}

async function handleImport(file) {
    let text;
    try { text = await file.text(); } catch { alert('文件读取失败'); return; }
    let data;
    try { data = JSON.parse(text); } catch { alert('JSON 解析失败'); return; }
    if (!data || typeof data !== 'object' || !Array.isArray(data.stockList)) {
        alert('无效文件：缺少 stockList 数组'); return;
    }
    const prefilled = validComboName(nameFromFile(file.name)) ? nameFromFile(file.name) : (data.portfolioName || '');
    const name = promptComboName('组合命名（不超过4字，将作为该组合名称登记）：', prefilled);
    if (name === null) return;
    // 逐条清洗
    const cleanList = [];
    for (const raw of data.stockList) {
        if (!raw || typeof raw !== 'object') continue;
        const url = normalizeUrl(stripSign(raw.url));
        if (!url) continue;
        cleanList.push({
            url,
            name: String(raw.name || ''),
            code: String(raw.code || ''),
            prefix: String(raw.prefix || ''),
            startPrice: numOrNull(raw.startPrice),
            currentPrice: numOrNull(raw.currentPrice),
            percent: numOrNull(raw.percent),
            importPrice: numOrNull(raw.importPrice),
            targetPercentLe: String(raw.targetPercentLe ?? ''),
            targetPercentGe: String(raw.targetPercentGe ?? ''),
            importTargetPercentLe: String(raw.importTargetPercentLe ?? ''),
            importTargetPercentGe: String(raw.importTargetPercentGe ?? ''),
            stopRunning: !!raw.stopRunning,
            notifiedDaily: false,
            notifiedImport: false,
            inTrash: !!raw.inTrash,
            pinned: !!raw.pinned,
            pinOrder: numOrNull(raw.pinOrder),
            createdAt: numOrNull(raw.createdAt),
        });
    }
    // 目标组合：存在则按 URL 合并，不存在则新建
    const importedSelector = (data.settings && typeof data.settings.selectorName === 'string') ? data.settings.selectorName : selectorName;
    let targetList;
    if (portfolios[name]) {
        const urlMap = new Map((portfolios[name].stockList || []).map(s => [s.url, s]));
        for (const item of cleanList) urlMap.set(item.url, item);
        targetList = Array.from(urlMap.values());
    } else {
        targetList = cleanList;
    }
    portfolios[name] = { stockList: targetList, selectorName: importedSelector };
    await new Promise(r => chrome.storage.local.set({ portfolios }, r));
    // 导入到当前活动组合：stockList 接管合并后的同一引用，
    // 否则下一次抓取/保存的镜像（portfolios[active].stockList = stockList）会用旧数组冲掉合并结果
    if (name === activePortfolio) {
        stockList = portfolios[name].stockList;
        renderStockList();
    }
    // 全局恢复 interval/pageSize（选择器属组合，不动 sync.selectorName）
    if (data.settings && typeof data.settings === 'object') {
        const syncSet = {};
        if (typeof data.settings.refreshInterval === 'number') syncSet.refreshInterval = data.settings.refreshInterval;
        if (typeof data.settings.pageSize === 'number') syncSet.pageSize = data.settings.pageSize;
        if (Object.keys(syncSet).length) {
            await new Promise(r => chrome.storage.sync.set(syncSet, r));
            if (syncSet.pageSize) pageSize = syncSet.pageSize;
            if (syncSet.refreshInterval) intervalInput.value = syncSet.refreshInterval;
        }
    }
    refreshCombos();
    alert(`导入完成：组合「${name}」有效 ${cleanList.length} 条，共 ${targetList.length} 条（未自动切换，可在右侧勾选切换）`);
}

// ---------------- 编辑弹窗 ----------------
function openEdit(stock) {
    overlayEl.style.display = 'flex';
    lastMonitorEl.style.display = '';
    editUrl = stock.url;
    stockUrlGroupEl.style.display = 'none'; // 编辑页网址不可改，隐藏整组
    editForm.render(stock);
}

function closeModal() {
    lastMonitorEl.style.display = 'block';
    overlayEl.style.display = 'none';
    stockUrlEl.disabled = false;
}

function updateStatus(isActive) {
    startBtn.disabled = isActive;
    startBtn.classList.toggle('active', !isActive);
    stopBtn.disabled = !isActive;
    stopBtn.classList.toggle('active', isActive);
}

// ---------------- 事件接线 ----------------
closeBtnEl.addEventListener('click', closeModal);
window.addEventListener('click', (event) => { if (event.target === overlayEl) closeModal(); });

chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (!response) return;
    intervalInput.value = response.refreshInterval || 60;
    selectorName = response.selectorName || 'wc1';
    selectorEl.value = selectorName;
    stockList = response.stockList || [];
    pageSize = response.pageSize || 10;
    currentView = response.currentView || 'list';
    portfolios = response.portfolios || {};
    activePortfolio = response.activePortfolio || '默认';
    updateStatus(false);
    updateViewToggleUI();
    refreshCombos();
    renderStockList();
});

quickOpenEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && quickOpenEl.value) {
        event.preventDefault();
        const names = quickOpenEl.value.split(/[\s,，、；;|\/]+/).filter(item => item && !/^-+$/.test(item));
        names.forEach((item) => {
            // ETF 代码（159/51/58）问财不支持，直接开雪球个股页
            const etfPrefix = etfPrefixForCode(item);
            const url = etfPrefix
                ? `https://xueqiu.com/S/${etfPrefix}${item}`
                : selectorName === 'xq1'
                    ? `https://xueqiu.com/k?q=${encodeURIComponent(item)}`
                    : `https://www.iwencai.com/screener/result?w=${encodeURIComponent(item)}&querytype=stock`;
            chrome.tabs.create({ url });
        });
    }
});

// 选择器变更：持久化并镜像到活动组合，立即按新生效地址重排刷新（名称跳转也随之更新）
selectorEl.addEventListener('change', () => {
    selectorName = selectorEl.value;
    if (portfolios[activePortfolio]) portfolios[activePortfolio].selectorName = selectorName;
    chrome.storage.sync.set({ selectorName });
    chrome.storage.local.set({ portfolios });
    renderStockList();
    chrome.runtime.sendMessage({ action: 'refresh' });
});

startBtn.addEventListener('click', () => {
    let interval = parseInt(intervalInput.value);
    selectorName = selectorEl.value;
    // 空输入/非法值会得到 NaN：NaN < 30 为 false 兜不住，NaN 周期使 alarms.create 静默失败、
    // UI 却显示运行中。另注：正式打包环境 chrome.alarms 周期下限 1 分钟（解载开发模式 30 秒）
    if (!Number.isFinite(interval) || interval < 30) { interval = 30; intervalInput.value = 30; }
    if (!selectorName) { alert('请选择选择器名称'); return; }
    chrome.runtime.sendMessage({ action: 'startRefresh', interval, selectorName }, (response) => {
        if (response && response.status === 'started') updateStatus(true);
    });
});

stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopRefresh' }, (response) => {
        if (response && response.status === 'stopped') updateStatus(false);
    });
});

addStockEl.addEventListener('click', () => {
    overlayEl.style.display = 'flex';
    lastMonitorEl.style.display = '';
    editUrl = undefined; // 须先清空：clear() 内 getStock() 依赖 editUrl，否则读到上一只股票
    editForm.clear();
    editActionsTopEl.style.display = 'none';
    stockUrlGroupEl.style.display = ''; // 新增需填网址
    stockUrlEl.disabled = false;
});

saveStockBtnEl.addEventListener('click', () => {
    const rawUrl = stockUrlEl.value;
    if (!rawUrl) { alert('请输入网址'); return; }
    const tLe = targetPercentLeEl.value;
    const tGe = targetPercentGeEl.value;
    const iLe = importTargetPercentLeEl.value;
    const iGe = importTargetPercentGeEl.value;
    if (editUrl) {
        const item = stockList.find(s => s.url === editUrl);
        if (!item) { alert('保存失败，请关闭重试'); return; }
        // 名称只读（抓取自动更新），保存不回写
        item.targetPercentLe = tLe;
        item.targetPercentGe = tGe;
        item.importTargetPercentLe = iLe;
        item.importTargetPercentGe = iGe;
        const newImportPrice = numOrNull(importPriceInputEl.value);
        if (newImportPrice !== null) item.importPrice = newImportPrice; // 留空保持原值
        item.notifiedDaily = false; // 阈值变更重置通知标记
        item.notifiedImport = false;
    } else {
        const url = normalizeUrl(stripSign(rawUrl)); // 新建：先截掉 &sign= 再规范化
        if (!url) { alert('网址格式不正确'); return; }
        if (stockList.some(s => s.url === url)) { alert('网址已存在'); return; }
        stockList.push({
            url, name: '', code: '', prefix: '', // 名称留空，首次抓取自动回填
            startPrice: null, currentPrice: null, percent: null,
            importPrice: numOrNull(importPriceInputEl.value),
            targetPercentLe: tLe, targetPercentGe: tGe,
            importTargetPercentLe: iLe, importTargetPercentGe: iGe,
            stopRunning: false, notifiedDaily: false, notifiedImport: false,
            inTrash: false, pinned: false, pinOrder: null, createdAt: Date.now(),
        });
    }
    saveAndRender();
    closeModal();
});

delStockBtnEl.addEventListener('click', () => {
    if (!editUrl) return;
    const index = stockList.findIndex(item => item.url === editUrl);
    if (index === -1) return;
    stockList.splice(index, 1);
    saveAndRender();
    closeModal();
});

trashToggleBtnEl.addEventListener('click', () => {
    const item = stockList.find(s => s.url === editUrl);
    if (!item) return;
    item.inTrash = !item.inTrash;
    saveAndRender();
    closeModal();
});

// 股价提醒维度切换：当日/导入以来两组阈值折叠为一组，切换填写（两组值各自保留）
function switchAlertDim(daily) {
    dailyTargetGroupEl.style.display = daily ? '' : 'none';
    importTargetGroupEl.style.display = daily ? 'none' : '';
    alertDimDailyBtnEl.classList.toggle('active', daily);
    alertDimImportBtnEl.classList.toggle('active', !daily);
}
alertDimDailyBtnEl.addEventListener('click', () => switchAlertDim(true));
alertDimImportBtnEl.addEventListener('click', () => switchAlertDim(false));

viewListBtnEl.addEventListener('click', () => switchView('list'));
viewTrashBtnEl.addEventListener('click', () => switchView('trash'));

exportBtnEl.addEventListener('click', handleExport);
importBtnEl.addEventListener('click', () => importFileInputEl.click());
importFileInputEl.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImport(file);
    e.target.value = ''; // 允许重复导入同一文件
});

sortToggleEls.forEach(el => {
    el.addEventListener('click', () => {
        const field = el.getAttribute('data-field');
        if (currentSort === field + '-desc') currentSort = field + '-asc';
        else if (currentSort === field + '-asc') currentSort = 'default';
        else currentSort = field + '-desc';
        currentPage = 1;
        renderStockList();
    });
});
