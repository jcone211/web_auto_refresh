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
let activePortfolio = '持仓';
// 默认组合（不可删除、不可重命名）
const DEFAULT_PORTFOLIOS = ['默认', '持仓', '观察'];
let stockList = [];
let editUrl = undefined;
let keyPoints = []; // 要点列表：[{ text, weight }]
let editingKeyPointIndex = -1; // 编辑中的要点索引，-1 表示新增模式
let events = []; // 事件列表：[{ id, keyPointText, content, time, status }]
let editingEventId = null; // 编辑中的事件 ID，null 表示新增模式
let eventFilterKeyPoint = ''; // 事件按要点筛选值，'' 表示全部
let autoResizeWindow = false; // 切换组合时专属窗口自动伸缩
let defaultPortfolio = '持仓'; // 打开插件时默认显示的组合，默认「持仓」
let hideKeyPoints = false; // 隐藏首页「要点管理」图标

// 抓取规则（解析在 parsers.js，按域名派发）
const selectorsEnum = {
    "wc1": { // 同花顺问财
        name: ".code-info-bar .code-name",
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
const overlayEl = document.getElementById('stockEditOverlay');
const closeBtnEl = overlayEl.querySelector('.close-btn');
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
// 要点管理
const openKeyPointsBtnEl = document.getElementById('openKeyPointsBtn');
const keyPointsOverlayEl = document.getElementById('keyPointsOverlay');
const closeKeyPointsBtnEl = document.getElementById('closeKeyPointsBtn');
const keyPointTextInputEl = document.getElementById('keyPointText');
const keyPointWeightInputEl = document.getElementById('keyPointWeight');
const addKeyPointBtnEl = document.getElementById('addKeyPointBtn');
const keyPointsListEl = document.getElementById('keyPointsList');
// 事件管理
const tabKeyPointsBtnEl = document.getElementById('tabKeyPointsBtn');
const tabEventsBtnEl = document.getElementById('tabEventsBtn');
const tabKeyPointsContentEl = document.getElementById('tabKeyPointsContent');
const tabEventsContentEl = document.getElementById('tabEventsContent');
const eventKeyPointSelectEl = document.getElementById('eventKeyPointSelect');
const eventContentInputEl = document.getElementById('eventContent');
const eventDateInputEl = document.getElementById('eventDate');
const addEventBtnEl = document.getElementById('addEventBtn');
const eventsListEl = document.getElementById('eventsList');
const eventFilterSelectEl = document.getElementById('eventFilterSelect');
const clearEventFilterBtnEl = document.getElementById('clearEventFilterBtn');
// 全局设置
const openSettingsBtnEl = document.getElementById('openSettingsBtn');
const settingsOverlayEl = document.getElementById('settingsOverlay');
const closeSettingsBtnEl = document.getElementById('closeSettingsBtn');
const autoResizeToggleEl = document.getElementById('autoResizeWindowToggle');
const defaultPortfolioSelectEl = document.getElementById('defaultPortfolioSelect');
const hideKeyPointsToggleEl = document.getElementById('hideKeyPointsToggle');

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
        requestResizePopup();
    });
}

function refreshCombos() {
    // 无组合时仅隐藏标签（分页仍在同行），chips 容器由渲染函数清空
    comboLabelEl.style.display = Object.keys(portfolios).length ? '' : 'none';
    renderComboSwitches(portfolios, activePortfolio, comboSwitchesEl, { onSwitch: switchPortfolio, onDelete: deletePortfolio, onAdd: addPortfolio });
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
            // 仅列表视图显示切换组合按钮
            onMoveToCombo: currentView === 'list' ? (stock, btn) => showMoveComboDropdown(stock, btn) : undefined,
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
    requestResizePopup();
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
    requestResizePopup();
}

// 命名保留字检查
function isReservedPortfolioName(name) {
    return DEFAULT_PORTFOLIOS.includes(name);
}

// 重名检查
function isDuplicatePortfolioName(name) {
    return portfolios[name] !== undefined;
}

// 删除组合：默认组合不可删；活动组合须先切走（避免活动指针悬空）；删除前 confirm 防误触
function deletePortfolio(name) {
    if (!portfolios[name]) return;
    if (DEFAULT_PORTFOLIOS.includes(name)) { alert(`默认组合「${name}」不可删除`); return; }
    if (name === activePortfolio) { alert('当前组合使用中，请先切换到其他组合再删除'); return; }
    if (!confirm(`删除组合「${name}」？组合内的股票快照将一并删除`)) return;
    delete portfolios[name];
    chrome.storage.local.set({ portfolios }, refreshCombos);
}

// 新建组合：弹窗命名，创建空组合并切换到该组合
function addPortfolio() {
    const name = promptComboName('新建组合（不超过4字）：');
    if (name === null) return;
    if (isReservedPortfolioName(name)) { alert(`「${name}」为默认组合名称，请更换其他名称`); return; }
    if (isDuplicatePortfolioName(name)) { alert(`组合「${name}」已存在，请更换其他名称`); return; }
    portfolios[name] = { stockList: [], selectorName };
    chrome.storage.local.set({ portfolios }, () => {
        switchPortfolio(name);
        refreshCombos();
    });
}

// 切换组合下拉框：显示在按钮旁，选择后将股票移动到目标组合
function showMoveComboDropdown(stock, anchorEl) {
    // 关闭已有下拉框
    closeMoveComboDropdown();
    const dropdown = document.createElement('div');
    dropdown.className = 'move-combo-dropdown';
    dropdown.id = 'moveComboDropdown';
    // 获取所有组合名称（排除当前活动组合）
    const comboNames = Object.keys(portfolios).filter(name => name !== activePortfolio);
    if (comboNames.length === 0) {
        dropdown.textContent = '无其他组合';
        dropdown.className += ' empty';
    } else {
        comboNames.forEach(name => {
            const item = document.createElement('div');
            item.className = 'move-combo-item';
            item.textContent = name;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                moveStockToCombo(stock, name);
                closeMoveComboDropdown();
            });
            dropdown.appendChild(item);
        });
    }
    // 定位下拉框（相对按钮）
    const rect = anchorEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = `${rect.bottom + 2}px`;
    dropdown.style.left = `${rect.left - 60}px`;
    document.body.appendChild(dropdown);
    // 点击外部关闭
    setTimeout(() => {
        document.addEventListener('click', closeMoveComboDropdownOnClick);
    }, 0);
}

function closeMoveComboDropdownOnClick(e) {
    const dropdown = document.getElementById('moveComboDropdown');
    if (dropdown && !dropdown.contains(e.target)) {
        closeMoveComboDropdown();
    }
}

function closeMoveComboDropdown() {
    const dropdown = document.getElementById('moveComboDropdown');
    if (dropdown) {
        dropdown.remove();
    }
    document.removeEventListener('click', closeMoveComboDropdownOnClick);
}

// 将股票从当前组合移动到目标组合
function moveStockToCombo(stock, targetComboName) {
    if (!portfolios[targetComboName]) return;
    // 从当前组合的 stockList 中移除
    const idx = stockList.indexOf(stock);
    if (idx !== -1) {
        stockList.splice(idx, 1);
    }
    // 添加到目标组合的 stockList
    if (!portfolios[targetComboName].stockList) {
        portfolios[targetComboName].stockList = [];
    }
    portfolios[targetComboName].stockList.push(stock);
    // 同步更新当前组合的存储
    portfolios[activePortfolio].stockList = stockList;
    chrome.storage.local.set({ portfolios }, () => {
        renderStockList();
        refreshCombos();
    });
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

// 全量导出：导出插件全部数据和配置
async function handleExport() {
    if (!confirm('将导出插件全部数据和配置（所有组合、要点、事件、设置等），确定继续？')) return;
    const localData = await storageGet(chrome.storage.local, ['stockList', 'portfolios', 'activePortfolio', 'currentView', 'keyPoints', 'events']);
    const syncData = await storageGet(chrome.storage.sync, ['refreshInterval', 'selectorName', 'pageSize', 'autoResizeWindow', 'defaultPortfolio', 'hideKeyPoints']);
    const payload = {
        version: 2,
        type: 'full-backup',
        exportedAt: new Date().toISOString(),
        local: {
            stockList: localData.stockList || [],
            portfolios: localData.portfolios || {},
            activePortfolio: localData.activePortfolio || '持仓',
            currentView: localData.currentView || 'list',
            keyPoints: localData.keyPoints || [],
            events: localData.events || [],
        },
        sync: {
            refreshInterval: syncData.refreshInterval,
            selectorName: syncData.selectorName,
            pageSize: syncData.pageSize,
            autoResizeWindow: syncData.autoResizeWindow,
            defaultPortfolio: syncData.defaultPortfolio,
            hideKeyPoints: syncData.hideKeyPoints,
        },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.download = `thswc_full_backup_${comboTimestamp()}.json`;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
}

// 全量导入：导入插件全部数据和配置（覆盖当前数据）
async function handleImport(file) {
    let text;
    try { text = await file.text(); } catch { alert('文件读取失败'); return; }
    let data;
    try { data = JSON.parse(text); } catch { alert('JSON 解析失败'); return; }
    // 验证格式
    if (!data || typeof data !== 'object') {
        alert('无效文件：不是有效的 JSON 对象'); return;
    }
    if (data.type !== 'full-backup') {
        if (!confirm('该文件不是全量备份格式，可能无法完整恢复。确定继续导入？')) return;
    }
    if (!confirm('导入将覆盖当前全部数据（所有组合、要点、事件、设置），确定继续？')) return;

    // 恢复 local 数据
    if (data.local && typeof data.local === 'object') {
        const localSet = {};
        if (Array.isArray(data.local.stockList)) localSet.stockList = data.local.stockList;
        if (data.local.portfolios && typeof data.local.portfolios === 'object') localSet.portfolios = data.local.portfolios;
        if (typeof data.local.activePortfolio === 'string') localSet.activePortfolio = data.local.activePortfolio;
        if (typeof data.local.currentView === 'string') localSet.currentView = data.local.currentView;
        if (Array.isArray(data.local.keyPoints)) localSet.keyPoints = data.local.keyPoints;
        if (Array.isArray(data.local.events)) localSet.events = data.local.events;
        if (Object.keys(localSet).length) {
            await new Promise(r => chrome.storage.local.set(localSet, r));
        }
    }

    // 恢复 sync 数据
    if (data.sync && typeof data.sync === 'object') {
        const syncSet = {};
        if (typeof data.sync.refreshInterval === 'number') syncSet.refreshInterval = data.sync.refreshInterval;
        if (typeof data.sync.selectorName === 'string') syncSet.selectorName = data.sync.selectorName;
        if (typeof data.sync.pageSize === 'number') syncSet.pageSize = data.sync.pageSize;
        if (typeof data.sync.autoResizeWindow === 'boolean') syncSet.autoResizeWindow = data.sync.autoResizeWindow;
        if (typeof data.sync.defaultPortfolio === 'string') syncSet.defaultPortfolio = data.sync.defaultPortfolio;
        if (typeof data.sync.hideKeyPoints === 'boolean') syncSet.hideKeyPoints = data.sync.hideKeyPoints;
        if (Object.keys(syncSet).length) {
            await new Promise(r => chrome.storage.sync.set(syncSet, r));
        }
    }

    // 刷新当前页面状态
    await initState();
    renderStockList();
    refreshCombos();
    loadKeyPoints();
    loadEvents();
    alert('导入完成，全部数据已恢复');
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

// 初始化状态（从 background 获取最新数据）
async function initState() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
            if (!response) { resolve(); return; }
            intervalInput.value = Number.isFinite(response.refreshInterval)
                ? response.refreshInterval
                : 60;
            selectorName = response.selectorName || 'wc1';
            selectorEl.value = selectorName;
            stockList = response.stockList || [];
            pageSize = response.pageSize || 10;
            currentView = 'list'; // 每次打开弹窗固定股票列表视图，不记忆上次的垃圾池
            chrome.runtime.sendMessage({ action: 'setView', view: 'list' }); // 同步后台视图与存储，调度仍按股票列表
            portfolios = response.portfolios || {};
            activePortfolio = response.activePortfolio || '持仓';
            updateStatus(false);
            updateViewToggleUI();
            resolve();
        });
    });
}

// 首次初始化
initState().then(() => {
    // 加载全局设置（默认组合、自动伸缩开关），应用默认组合后再做首次渲染
    chrome.storage.sync.get(['defaultPortfolio', 'autoResizeWindow', 'hideKeyPoints'], (result) => {
        autoResizeWindow = !!result.autoResizeWindow;
        hideKeyPoints = !!result.hideKeyPoints;
        applyKeyPointsVisibility();
        const dp = result.defaultPortfolio || '持仓';
        // 存储的默认组合若已被删除，回退到固定默认「持仓」
        defaultPortfolio = portfolios[dp] ? dp : '持仓';
        // 默认组合有效且与当前不同时，打开弹窗直接切到该组合（覆盖上次关闭时的组合）
        if (portfolios[dp] && dp !== activePortfolio) {
            activePortfolio = dp;
            stockList = portfolios[dp].stockList || [];
            selectorName = portfolios[dp].selectorName || 'wc1';
            selectorEl.value = selectorName;
            chrome.storage.local.set({ activePortfolio, stockList });
            chrome.storage.sync.set({ selectorName });
            currentPage = 1;
            currentSort = 'default';
            chrome.runtime.sendMessage({ action: 'refresh' }); // 监控运行中则立即按新组合重排刷新任务
        }
        refreshCombos();
        renderStockList();
        // 组合标签行渲染后补一次 resize，修正初始高度差值（不受设置开关限制）
        const count = stockList.filter(s => currentView === 'trash' ? s.inTrash : !s.inTrash).length;
        chrome.runtime.sendMessage({ action: 'resizePopupWindow', rows: Math.min(count, pageSize) });
    });
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

// 刷新间隔输入即改即存：原先只在点「开始」时写入 storage，改值后直接关闭弹窗
// 会丢改动、重开时回到旧值；改为 change 时立即持久化（监控周期仍以点「开始」生效）
intervalInput.addEventListener('change', () => {
    const v = parseInt(intervalInput.value, 10);
    if (Number.isFinite(v)) {
        chrome.storage.sync.set({ refreshInterval: v });
    }
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

// ---------------- 要点管理 ----------------
// 加载要点数据
function loadKeyPoints() {
    chrome.storage.local.get(['keyPoints'], (result) => {
        keyPoints = result.keyPoints || [];
        renderKeyPointsList();
    });
}

// 保存要点数据
function saveKeyPoints() {
    chrome.storage.local.set({ keyPoints });
}

// 渲染要点列表（按权重从大到小排序）
function renderKeyPointsList() {
    keyPointsListEl.innerHTML = '';
    // 按权重降序排序
    const sorted = [...keyPoints].sort((a, b) => b.weight - a.weight);
    if (sorted.length === 0) {
        keyPointsListEl.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">暂无要点，请添加</div>';
        return;
    }
    sorted.forEach((kp, idx) => {
        const realIdx = keyPoints.indexOf(kp);
        const item = document.createElement('div');
        item.className = 'keypoint-item';
        item.innerHTML = `
            <span class="keypoint-seq">${idx + 1}、</span>
            <span class="keypoint-text" title="点击查看该要点的所有事件记录">${escapeHtml(kp.text)}</span>
            <span class="keypoint-weight">(${kp.weight})</span>
            <div class="keypoint-actions">
                <button class="keypoint-action-btn keypoint-edit-btn" data-idx="${realIdx}">编辑</button>
                <button class="keypoint-action-btn keypoint-delete-btn" data-idx="${realIdx}">删除</button>
            </div>
        `;
        keyPointsListEl.appendChild(item);
    });
    // 点击要点文本：跳转到对应事件记录列表
    keyPointsListEl.querySelectorAll('.keypoint-text').forEach(el => {
        el.addEventListener('click', () => filterEventsByKeyPoint(el.textContent));
    });
    // 要点增删改后刷新事件筛选下拉（保留当前选中值）
    updateEventFilterSelect();
    // 绑定编辑和删除事件
    keyPointsListEl.querySelectorAll('.keypoint-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => editKeyPoint(parseInt(btn.dataset.idx)));
    });
    keyPointsListEl.querySelectorAll('.keypoint-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteKeyPoint(parseInt(btn.dataset.idx)));
    });
}

// HTML 转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 打开要点管理弹窗
function openKeyPoints() {
    keyPointsOverlayEl.style.display = 'flex';
    resetKeyPointForm();
    resetEventForm();
    renderKeyPointsList();
    updateEventKeyPointSelect();
    switchTab('keypoints');
}

// 关闭要点管理弹窗
function closeKeyPoints() {
    keyPointsOverlayEl.style.display = 'none';
    resetKeyPointForm();
}

// ---------------- 全局设置 ----------------
function openSettings() {
    autoResizeToggleEl.checked = autoResizeWindow;
    hideKeyPointsToggleEl.checked = hideKeyPoints;
    // 填充默认组合下拉框（始终有活动组合可选）
    defaultPortfolioSelectEl.innerHTML = '';
    Object.keys(portfolios).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        defaultPortfolioSelectEl.appendChild(opt);
    });
    defaultPortfolioSelectEl.value = defaultPortfolio;
    settingsOverlayEl.style.display = 'flex';
}

// 按「隐藏要点管理」开关控制首页要点管理图标的显隐
function applyKeyPointsVisibility() {
    openKeyPointsBtnEl.style.display = hideKeyPoints ? 'none' : '';
}

function closeSettings() {
    settingsOverlayEl.style.display = 'none';
}

// 请求插件弹窗按当前活动股票数量调整高度
function requestResizePopup() {
    if (!autoResizeWindow) return;
    const count = stockList.filter(s => currentView === 'trash' ? s.inTrash : !s.inTrash).length;
    const rows = Math.min(count, pageSize);
    chrome.runtime.sendMessage({ action: 'resizePopupWindow', rows });
}

// 重置表单
function resetKeyPointForm() {
    keyPointTextInputEl.value = '';
    keyPointWeightInputEl.value = '';
    editingKeyPointIndex = -1;
    addKeyPointBtnEl.textContent = '添加';
}

// 添加或更新要点
function addOrUpdateKeyPoint() {
    const text = keyPointTextInputEl.value.trim();
    const weight = parseInt(keyPointWeightInputEl.value);
    if (!text) { alert('请输入要点内容'); return; }
    if (!weight || weight < 1 || weight > 99) { alert('权重必须为 1-99 的数字'); return; }

    if (editingKeyPointIndex === -1) {
        // 新增模式
        keyPoints.push({ text, weight });
    } else {
        // 编辑模式
        keyPoints[editingKeyPointIndex] = { text, weight };
    }
    saveKeyPoints();
    renderKeyPointsList();
    resetKeyPointForm();
}

// 编辑要点
function editKeyPoint(idx) {
    const kp = keyPoints[idx];
    if (!kp) return;
    keyPointTextInputEl.value = kp.text;
    keyPointWeightInputEl.value = kp.weight;
    editingKeyPointIndex = idx;
    addKeyPointBtnEl.textContent = '更新';
    keyPointTextInputEl.focus();
}

// 删除要点
function deleteKeyPoint(idx) {
    if (!confirm('确定删除该要点？')) return;
    keyPoints.splice(idx, 1);
    saveKeyPoints();
    renderKeyPointsList();
    if (editingKeyPointIndex === idx) {
        resetKeyPointForm();
    } else if (editingKeyPointIndex > idx) {
        editingKeyPointIndex--;
    }
}

// 事件绑定
openKeyPointsBtnEl.addEventListener('click', openKeyPoints);
closeKeyPointsBtnEl.addEventListener('click', closeKeyPoints);
addKeyPointBtnEl.addEventListener('click', addOrUpdateKeyPoint);
keyPointsOverlayEl.addEventListener('click', (e) => {
    if (e.target === keyPointsOverlayEl) closeKeyPoints();
});

// 全局设置事件绑定
openSettingsBtnEl.addEventListener('click', openSettings);
closeSettingsBtnEl.addEventListener('click', closeSettings);
settingsOverlayEl.addEventListener('click', (e) => {
    if (e.target === settingsOverlayEl) closeSettings();
});
autoResizeToggleEl.addEventListener('change', () => {
    autoResizeWindow = autoResizeToggleEl.checked;
    chrome.storage.sync.set({ autoResizeWindow });
});

defaultPortfolioSelectEl.addEventListener('change', () => {
    defaultPortfolio = defaultPortfolioSelectEl.value;
    chrome.storage.sync.set({ defaultPortfolio });
});

hideKeyPointsToggleEl.addEventListener('change', () => {
    hideKeyPoints = hideKeyPointsToggleEl.checked;
    chrome.storage.sync.set({ hideKeyPoints });
    applyKeyPointsVisibility();
});

// 初始化加载要点数据
loadKeyPoints();

// ---------------- 事件管理 ----------------
// 加载事件数据
function loadEvents() {
    chrome.storage.local.get(['events'], (result) => {
        events = (result.events || []).map(event => {
            // 兼容旧版：旧版将归档写入 status，无法恢复归档前状态时默认按「准确」处理
            if (event.status === 'archived') {
                return { ...event, status: 'accurate', archived: true };
            }
            return { ...event, archived: !!event.archived };
        });
        renderEventsList();
        updateEventKeyPointSelect();
    });
}

// 保存事件数据
function saveEvents() {
    chrome.storage.local.set({ events });
}

// 生成唯一 ID
function generateEventId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// 更新事件关联要点下拉框
function updateEventKeyPointSelect() {
    const currentValue = eventKeyPointSelectEl.value;
    eventKeyPointSelectEl.innerHTML = '<option value="">选择关联要点</option>';
    keyPoints.forEach(kp => {
        const option = document.createElement('option');
        option.value = kp.text;
        option.textContent = kp.text;
        eventKeyPointSelectEl.appendChild(option);
    });
    if (currentValue) {
        eventKeyPointSelectEl.value = currentValue;
    }
}

// 渲染事件列表（按时间倒序，支持按要点筛选）
function renderEventsList() {
    eventsListEl.innerHTML = '';
    // 按要点筛选
    const filtered = eventFilterKeyPoint
        ? events.filter(e => e.keyPointText === eventFilterKeyPoint)
        : events;
    if (filtered.length === 0) {
        eventsListEl.innerHTML = `<div style="text-align:center;color:#999;padding:20px;">${eventFilterKeyPoint ? '该要点暂无事件记录' : '暂无事件，请添加'}</div>`;
        return;
    }
    // 按日期、要点和状态合并为同一张卡片
    const sorted = [...filtered].sort((a, b) => new Date(b.time) - new Date(a.time));
    const groups = [];
    const groupMap = new Map();
    sorted.forEach(event => {
        const key = [event.time, event.keyPointText || '', event.status, !!event.archived].join(' ');
        let group = groupMap.get(key);
        if (!group) {
            group = { events: [], keyPointText: event.keyPointText || '', time: event.time, status: event.status, archived: !!event.archived };
            groupMap.set(key, group);
            groups.push(group);
        }
        group.events.push(event);
    });
    groups.forEach((group, groupIndex) => {
        const item = document.createElement('div');
        item.className = 'event-item';
        if (group.archived) item.classList.add('archived');
        const statusText = group.status === 'accurate' ? '准确' : group.status === 'wrong' ? '误判' : '待预测';
        const statusControl = group.archived
            ? `<span class="event-status ${group.status} archived">${statusText}</span>`
            : `<select class="event-status-select" data-group-index="${groupIndex}">
                <option value="pending" ${group.status === 'pending' ? 'selected' : ''}>待预测</option>
                <option value="accurate" ${group.status === 'accurate' ? 'selected' : ''}>准确</option>
                <option value="wrong" ${group.status === 'wrong' ? 'selected' : ''}>误判</option>
               </select>`;
        const canArchive = !group.archived && (group.status === 'accurate' || group.status === 'wrong');
        const archiveBtn = canArchive ? `<button class="event-icon-btn event-archive-btn" data-group-index="${groupIndex}" title="归档"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v11H4zM3 5h18v3H3zM8 13h8M12 10v7m0 0-3-3m3 3 3-3"/></svg></button>` : '';
        const contentRows = group.events.map(event => `
            <div class="event-content-row">
                <div class="event-content">${escapeHtml(event.content)}</div>
            </div>
        `).join('');
        const rowActions = group.events.map(event => `
            ${group.archived ? '' : `<button class="event-icon-btn event-edit-btn" data-id="${event.id}" title="编辑"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-.7 4.7L8 20l11-11a2.1 2.1 0 0 0-3-3zM14 7l3 3"/></svg></button>`}
            <button class="event-icon-btn event-delete-btn" data-id="${event.id}" title="删除"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg></button>
        `).join('');
        item.innerHTML = `
            <div class="event-meta">
                <span class="event-time">${group.time}</span>
                ${group.keyPointText ? `<span class="event-keypoint-tag" title="${escapeHtml(group.keyPointText)}">${escapeHtml(group.keyPointText)}</span>` : ''}
            </div>
            <div class="event-content-list">${contentRows}</div>
            <div class="event-footer">
                ${statusControl}
                <div class="event-actions">${archiveBtn}${rowActions}</div>
            </div>
        `;
        eventsListEl.appendChild(item);
    });
    // 同一张卡片内的状态和归档操作作用于该卡片的全部事件
    eventsListEl.querySelectorAll('.event-status-select').forEach(el => {
        el.addEventListener('change', () => setEventGroupStatus(groups[el.dataset.groupIndex], el.value));
    });
    eventsListEl.querySelectorAll('.event-archive-btn').forEach(el => {
        el.addEventListener('click', () => archiveEventGroup(groups[el.dataset.groupIndex]));
    });
    // 绑定编辑和删除事件
    eventsListEl.querySelectorAll('.event-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => editEvent(btn.dataset.id));
    });
    eventsListEl.querySelectorAll('.event-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteEvent(btn.dataset.id));
    });
}

// 刷新「按要点筛选」下拉框（保留当前选中值；被删要点则重置为全部）
function updateEventFilterSelect() {
    const stillExists = keyPoints.some(kp => kp.text === eventFilterKeyPoint);
    if (eventFilterKeyPoint && !stillExists) eventFilterKeyPoint = '';
    eventFilterSelectEl.innerHTML = '<option value="">全部要点</option>';
    keyPoints.forEach(kp => {
        const option = document.createElement('option');
        option.value = kp.text;
        option.textContent = kp.text;
        eventFilterSelectEl.appendChild(option);
    });
    eventFilterSelectEl.value = eventFilterKeyPoint || '';
}

// 直接设置事件状态（替代原点击轮换）
function setEventStatus(id, status) {
    const event = events.find(e => e.id === id);
    if (!event || event.archived) return;
    if (!['pending', 'accurate', 'wrong'].includes(status)) return;
    event.status = status;
    saveEvents();
    renderEventsList();
}

// 批量设置同一卡片内事件的状态
function setEventGroupStatus(group, status) {
    if (!group || group.archived || !['pending', 'accurate', 'wrong'].includes(status)) return;
    group.events.forEach(event => { event.status = status; });
    saveEvents();
    renderEventsList();
}

// 批量归档同一卡片内事件
function archiveEventGroup(group) {
    if (!group || group.archived || !['accurate', 'wrong'].includes(group.status)) return;
    if (!confirm('归档后该卡片内事件将无法编辑和修改状态，只能删除。确定归档？')) return;
    group.events.forEach(event => { event.archived = true; });
    saveEvents();
    renderEventsList();
}

// 归档事件：仅「准确」和「误判」状态可归档，归档后保留原状态且仅可删除
function archiveEvent(id) {
    const event = events.find(e => e.id === id);
    if (!event || event.archived || !['accurate', 'wrong'].includes(event.status)) return;
    if (!confirm('归档后该事件将无法编辑和修改状态，只能删除。确定归档？')) return;
    event.archived = true;
    saveEvents();
    renderEventsList();
}

// 添加或更新事件
function addOrUpdateEvent() {
    const keyPointText = eventKeyPointSelectEl.value;
    const content = eventContentInputEl.value.trim();
    const time = eventDateInputEl.value;
    if (!content) { alert('请输入事件内容'); return; }
    if (!time) { alert('请选择日期'); return; }

    if (editingEventId === null) {
        // 新增模式
        events.push({
            id: generateEventId(),
            keyPointText,
            content,
            time,
            status: 'pending',
            archived: false
        });
    } else {
        // 编辑模式
        const event = events.find(e => e.id === editingEventId);
        if (event) {
            event.keyPointText = keyPointText;
            event.content = content;
            event.time = time;
        }
    }
    saveEvents();
    renderEventsList();
    resetEventForm();
}

// 编辑事件
function editEvent(id) {
    const event = events.find(e => e.id === id);
    if (!event || event.archived) return;
    eventKeyPointSelectEl.value = event.keyPointText || '';
    eventContentInputEl.value = event.content;
    eventDateInputEl.value = event.time;
    editingEventId = id;
    addEventBtnEl.textContent = '更新';
    eventContentInputEl.focus();
}

// 删除事件
function deleteEvent(id) {
    if (!confirm('确定删除该事件？')) return;
    events = events.filter(e => e.id !== id);
    saveEvents();
    renderEventsList();
    if (editingEventId === id) {
        resetEventForm();
    }
}

// 重置事件表单
function resetEventForm() {
    eventKeyPointSelectEl.value = '';
    eventContentInputEl.value = '';
    eventDateInputEl.value = new Date().toISOString().split('T')[0];
    editingEventId = null;
    addEventBtnEl.textContent = '添加';
}

// 标签页切换
function switchTab(tab, keepEventContext = false) {
    if (tab === 'keypoints') {
        tabKeyPointsBtnEl.classList.add('active');
        tabEventsBtnEl.classList.remove('active');
        tabKeyPointsContentEl.style.display = 'block';
        tabEventsContentEl.style.display = 'none';
    } else {
        tabEventsBtnEl.classList.add('active');
        tabKeyPointsBtnEl.classList.remove('active');
        tabEventsContentEl.style.display = 'block';
        tabKeyPointsContentEl.style.display = 'none';
        // 直接点击事件记录 tab 时清空关联要点和筛选条件；跳转时保留对应要点
        if (!keepEventContext) {
            eventKeyPointSelectEl.value = '';
            eventFilterKeyPoint = '';
        }
        updateEventKeyPointSelect();
        updateEventFilterSelect();
        renderEventsList();
    }
}

// 从要点列表点击要点项，跳转到事件记录列表并按该要点筛选
function filterEventsByKeyPoint(text) {
    eventFilterKeyPoint = text;
    eventKeyPointSelectEl.value = text;
    switchTab('events', true);
}

// 事件管理事件绑定
tabKeyPointsBtnEl.addEventListener('click', () => switchTab('keypoints'));
tabEventsBtnEl.addEventListener('click', () => switchTab('events'));
addEventBtnEl.addEventListener('click', addOrUpdateEvent);
eventFilterSelectEl.addEventListener('change', () => {
    eventFilterKeyPoint = eventFilterSelectEl.value;
    renderEventsList();
});
clearEventFilterBtnEl.addEventListener('click', () => {
    eventFilterKeyPoint = '';
    eventFilterSelectEl.value = '';
    renderEventsList();
});

// 初始化加载事件数据
loadEvents();
