import {
    getDateTime, Mutex, safeDecodeUrl, normalizeUrl, calcImportPercent,
    percentToTargetPrice, targetPriceToPercent, numOrNull
} from "./utils.js";

let selectorName = '';
const mutex = new Mutex();
const port = chrome.runtime.connect({ name: 'popup-connection' });

// 列表视图状态
let currentView = 'list';   // 'list' 股票列表 | 'trash' 垃圾池
let currentPage = 1;
let pageSize = 10;
let currentSort = 'default'; // 'default' | 'percent-asc' | 'percent-desc' | 'importPercent-asc' | 'importPercent-desc'

let stockList = [];
let editUrl = undefined;

const selectorsEnum = {
    "wc1": {
        name: ".input-base-copy", //名称
        dqj: ".code-info-bar .price", //当前价
        zdf: ".code-info-bar .rise-fall",   //涨跌幅(+1.20)元
        percent: ".code-info-bar .rise-fall-rate" //涨跌幅(/+1.0%)
    }
}

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
const addOrDelDivEl = document.getElementById('addOrDelDiv');
const addDivEl = document.getElementById('addDiv');
const delDivEl = document.getElementById('delDiv');
const stockUrlEl = document.getElementById('stockUrl');
const stockNameEl = document.getElementById('stockName');
const startPriceEl = document.getElementById('startPrice');
const currentPriceEl = document.getElementById('currentPrice');
const percentEl = document.getElementById('percent');
const targetPriceEl = document.getElementById('targetPrice');
const targetPercentLeEl = document.getElementById('targetPercentLe');
const targetPercentGeEl = document.getElementById('targetPercentGe');
const dailyLePriceInputEl = document.getElementById('dailyLePriceInput');
const dailyGePriceInputEl = document.getElementById('dailyGePriceInput');
const importPriceInputEl = document.getElementById('importPriceInput');
const importCurrentPriceEl = document.getElementById('importCurrentPrice');
const importPercentEl = document.getElementById('importPercent');
const importTargetPriceEl = document.getElementById('importTargetPrice');
const importTargetPercentLeEl = document.getElementById('importTargetPercentLe');
const importTargetPercentGeEl = document.getElementById('importTargetPercentGe');
const importLePriceInputEl = document.getElementById('importLePriceInput');
const importGePriceInputEl = document.getElementById('importGePriceInput');
const trashToggleDivEl = document.getElementById('trashToggleDiv');
const trashToggleBtnEl = document.getElementById('trashToggleBtn');
const viewTitleEl = document.getElementById('viewTitle');
const viewListBtnEl = document.getElementById('viewListBtn');
const viewTrashBtnEl = document.getElementById('viewTrashBtn');
const paginationBarEl = document.getElementById('paginationBar');
const exportBtnEl = document.getElementById('exportBtn');
const importBtnEl = document.getElementById('importBtn');
const importFileInputEl = document.getElementById('importFileInput');
const sortToggleEls = document.querySelectorAll('.sort-toggle');

// storage.get 的 Promise 包装（回调兼容写法）
function storageGet(area, keys) {
    return new Promise(resolve => area.get(keys, resolve));
}

// 监听来自 background 的消息
port.onMessage.addListener(async (message) => {
    if (message.type === 'DOCUMENT_CAPTURED') {
        await mutex.lock();
        try {
            const messageUrl = message.documentData.url;
            const index = stockList.findIndex(item => item.url === messageUrl);
            if (index === -1) {
                return;
            }
            const stock = stockList[index];
            // 已停止的股票不解析、不通知（页面可能被手动刷新等方式加载）
            if (stock.stopRunning) {
                return;
            }
            const parser = new DOMParser();

            if (message.documentData.html) {
                const doc = parser.parseFromString(message.documentData.html, 'text/html');
                if (selectorsEnum[selectorName] !== undefined) {
                    const selector = selectorsEnum[selectorName];
                    if (selectorName === 'wc1') {
                        let name = getTargetData(doc, selector.name);
                        if (name) {
                            name = name.replace(/\s*\(.*?\)/, '');
                            stock.name = name;
                        } else {
                            console.error("名称为null，当前价为", parseFloat(getTargetData(doc, selector.dqj)), messageUrl);
                            return;
                        }
                        let dqj = parseFloat(getTargetData(doc, selector.dqj));
                        let zdf = parseFloat(getTargetData(doc, selector.zdf));
                        let percent = getTargetData(doc, selector.percent);
                        if (percent) {
                            percent = percent.replace('%', '').replace('/', '');
                            percent = parseFloat(percent);
                        }
                        const kpj = (dqj - zdf).toFixed(2);
                        if (kpj && kpj !== 'NaN') {
                            stock.startPrice = kpj;
                        }
                        if (dqj) {
                            stock.currentPrice = dqj;
                            // 初始价格首次抓取自动回填，之后仅可手动修改
                            if (stock.importPrice == null) {
                                stock.importPrice = dqj;
                            }
                        }
                        if (percent) {
                            stock.percent = percent;
                            // 当日阈值判断（锁存：越界通知一次，回区间复位）
                            const dailyHit = (stock.targetPercentLe && percent <= parseFloat(stock.targetPercentLe))
                                || (stock.targetPercentGe && percent >= parseFloat(stock.targetPercentGe));
                            if (dailyHit) {
                                if (!stock.notifiedDaily) {
                                    stock.notifiedDaily = true;
                                    createChromeNotification(stock, 'daily', percent);
                                }
                            } else {
                                stock.notifiedDaily = false;
                            }
                        }
                        // 导入以来阈值判断（与当日阈值独立锁存）
                        const importPercent = calcImportPercent(stock.currentPrice, stock.importPrice);
                        const importHit = importPercent !== null && (
                            (stock.importTargetPercentLe && importPercent <= parseFloat(stock.importTargetPercentLe))
                            || (stock.importTargetPercentGe && importPercent >= parseFloat(stock.importTargetPercentGe)));
                        if (importHit) {
                            if (!stock.notifiedImport) {
                                stock.notifiedImport = true;
                                createChromeNotification(stock, 'import', importPercent);
                            }
                        } else {
                            stock.notifiedImport = false;
                        }
                        lastUpdateTimeEl.textContent = getDateTime();
                        chrome.storage.local.set({ stockList }, () => {
                            renderStockList();
                        });
                    }
                }
            }
        } catch (err) {
            console.error('数据更新错误:', err);
            lastUpdateTimeEl.textContent = '数据更新失败 ' + getDateTime();
        } finally {
            mutex.unlock();
        }
    }
});

closeBtnEl.addEventListener("click", closeModal);
window.addEventListener("click", (event) => {
    if (event.target === overlayEl) {
        closeModal();
    }
});

// 加载保存的设置
chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
        intervalInput.value = response.refreshInterval || 60;
        selectorEl.value = response.selectorName || '';
        stockList = response.stockList || [];
        pageSize = response.pageSize || 10;
        currentView = response.currentView || 'list';
        updateStatus(false);
        updateViewToggleUI();
        renderStockList();
    }
});

// 快速打开文本框
quickOpenEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && quickOpenEl.value) {
        event.preventDefault();
        const names = quickOpenEl.value
            .split(/[\s,，、；;|\/]+/)
            .filter(item => item && !/^-+$/.test(item));
        names.forEach((item) => {
            const url = `https://www.iwencai.com/unifiedwap/result?w=${item}&querytype=stock`;
            chrome.tabs.create({ url: url });
        })
    }
});

// 开始按钮
startBtn.addEventListener('click', () => {
    let interval = parseInt(intervalInput.value);
    selectorName = selectorEl.value;

    if (interval < 30) {
        interval = 30;
        intervalInput.value = 30;
    }

    if (!selectorName) {
        alert('请选择选择器名称');
        return;
    }

    chrome.runtime.sendMessage({
        action: 'startRefresh',
        interval: interval,
        selectorName: selectorName
    }, (response) => {
        if (response && response.status === 'started') {
            updateStatus(true);
        }
    });
});

// 停止按钮
stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopRefresh' }, (response) => {
        if (response && response.status === 'stopped') {
            updateStatus(false);
        }
    });
});

// 添加股票按钮
addStockEl.addEventListener('click', () => {
    overlayEl.style.display = "flex";
    lastMonitorEl.style.display = "";
    clearEditForm();
    editUrl = undefined;
    delDivEl.remove();
    trashToggleDivEl.style.display = "none";
    addDivEl.classList.add('single');
});

// 保存股票按钮
saveStockBtnEl.addEventListener('click', () => {
    const rawUrl = stockUrlEl.value;
    if (!rawUrl) {
        alert('请输入网址');
        return;
    }
    const name = stockNameEl.value;
    const tLe = targetPercentLeEl.value;
    const tGe = targetPercentGeEl.value;
    const iLe = importTargetPercentLeEl.value;
    const iGe = importTargetPercentGeEl.value;
    if (editUrl) {
        const item = stockList.find(s => s.url === editUrl);
        if (!item) {
            alert('保存失败，请关闭重试');
            return;
        }
        item.name = name;
        item.targetPercentLe = tLe;
        item.targetPercentGe = tGe;
        item.importTargetPercentLe = iLe;
        item.importTargetPercentGe = iGe;
        // 初始价格输入框留空时保持原值
        const newImportPrice = numOrNull(importPriceInputEl.value);
        if (newImportPrice !== null) {
            item.importPrice = newImportPrice;
        }
        // 阈值变更后重置通知标记，确保新阈值能再次触发通知
        item.notifiedDaily = false;
        item.notifiedImport = false;
    } else {
        const url = normalizeUrl(rawUrl);
        if (!url) {
            alert('网址格式不正确');
            return;
        }
        if (stockList.some(s => s.url === url)) {
            alert('网址已存在');
            return;
        }
        stockList.push({
            url: url,
            name: name,
            startPrice: null,
            currentPrice: null,
            percent: null,
            importPrice: numOrNull(importPriceInputEl.value),
            targetPercentLe: tLe,
            targetPercentGe: tGe,
            importTargetPercentLe: iLe,
            importTargetPercentGe: iGe,
            stopRunning: false,
            notifiedDaily: false,
            notifiedImport: false,
            inTrash: false,
        });
    }
    chrome.storage.local.set({ stockList }, () => {
        renderStockList();
        closeModal();
        chrome.runtime.sendMessage({ action: 'refresh' });
    });
});

//删除股票按钮
delStockBtnEl.addEventListener('click', () => {
    if (!editUrl) return;
    const index = stockList.findIndex(item => item.url === editUrl);
    if (index !== -1) {
        stockList.splice(index, 1);
        chrome.storage.local.set({ stockList }, () => {
            renderStockList();
            closeModal();
            chrome.runtime.sendMessage({ action: 'refresh' });
        });
    }
});

// 详情页「加入/移出垃圾池」按钮
trashToggleBtnEl.addEventListener('click', () => {
    const item = stockList.find(s => s.url === editUrl);
    if (!item) return;
    item.inTrash = !item.inTrash;
    chrome.storage.local.set({ stockList }, () => {
        renderStockList();
        closeModal();
        chrome.runtime.sendMessage({ action: 'refresh' });
    });
});

// 视图切换：股票列表 / 垃圾池
viewListBtnEl.addEventListener('click', () => switchView('list'));
viewTrashBtnEl.addEventListener('click', () => switchView('trash'));

function switchView(view) {
    if (currentView === view) return;
    currentView = view;
    chrome.storage.local.set({ currentView: view });
    // background 按新视图重排刷新任务
    chrome.runtime.sendMessage({ action: 'setView', view });
    currentPage = 1;
    updateViewToggleUI();
    renderStockList();
}

function updateViewToggleUI() {
    viewTitleEl.textContent = currentView === 'trash' ? '垃圾池' : '股票列表';
    viewListBtnEl.classList.toggle('active', currentView === 'list');
    viewTrashBtnEl.classList.toggle('active', currentView === 'trash');
}

// 导出数据为 JSON 文件
exportBtnEl.addEventListener('click', async () => {
    const localData = await storageGet(chrome.storage.local, ['stockList']);
    const syncData = await storageGet(chrome.storage.sync, ['refreshInterval', 'selectorName', 'pageSize']);
    const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: {
            refreshInterval: syncData.refreshInterval,
            selectorName: syncData.selectorName,
            pageSize: syncData.pageSize,
        },
        stockList: localData.stockList || [],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    a.download = `thswc-export-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
});

// 导入 JSON 文件（按 URL 合并：同 URL 覆盖、新 URL 追加、其余保留）
importBtnEl.addEventListener('click', () => importFileInputEl.click());
importFileInputEl.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        handleImport(file);
    }
    e.target.value = ''; // 允许重复导入同一文件
});

async function handleImport(file) {
    let text;
    try {
        text = await file.text();
    } catch {
        alert('文件读取失败');
        return;
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        alert('JSON 解析失败');
        return;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.stockList)) {
        alert('无效文件：缺少 stockList 数组');
        return;
    }
    // 逐条清洗：url 必填且格式有效，数值/字符串/布尔字段规整
    const cleanList = [];
    for (const raw of data.stockList) {
        if (!raw || typeof raw !== 'object') continue;
        const url = normalizeUrl(raw.url);
        if (!url) continue;
        cleanList.push({
            url,
            name: String(raw.name || ''),
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
        });
    }
    // 按 URL 合并
    const localData = await storageGet(chrome.storage.local, ['stockList']);
    const urlMap = new Map((localData.stockList || []).map(s => [s.url, s]));
    for (const item of cleanList) {
        urlMap.set(item.url, item);
    }
    const merged = Array.from(urlMap.values());
    await new Promise(resolve => chrome.storage.local.set({ stockList: merged }, resolve));
    // 恢复设置（仅类型合法的字段）
    if (data.settings && typeof data.settings === 'object') {
        const syncSet = {};
        if (typeof data.settings.refreshInterval === 'number') syncSet.refreshInterval = data.settings.refreshInterval;
        if (typeof data.settings.selectorName === 'string') syncSet.selectorName = data.settings.selectorName;
        if (typeof data.settings.pageSize === 'number') syncSet.pageSize = data.settings.pageSize;
        if (Object.keys(syncSet).length) {
            await new Promise(resolve => chrome.storage.sync.set(syncSet, resolve));
            if (syncSet.pageSize) pageSize = syncSet.pageSize;
            if (syncSet.selectorName) {
                selectorName = syncSet.selectorName;
                selectorEl.value = syncSet.selectorName;
            }
            if (syncSet.refreshInterval) intervalInput.value = syncSet.refreshInterval;
        }
    }
    stockList = merged;
    currentPage = 1;
    renderStockList();
    chrome.runtime.sendMessage({ action: 'refresh' });
    alert(`导入完成：有效 ${cleanList.length} 条，合并后共 ${merged.length} 条`);
}

// 表头排序切换：默认 → 降序 → 升序 → 默认
sortToggleEls.forEach(el => {
    el.addEventListener('click', () => {
        const field = el.getAttribute('data-field');
        if (currentSort === field + '-desc') {
            currentSort = field + '-asc';
        } else if (currentSort === field + '-asc') {
            currentSort = 'default';
        } else {
            currentSort = field + '-desc';
        }
        currentPage = 1;
        renderStockList();
    });
});

// 目标涨跌幅 ⇄ 目标价 双向联动（目标价仅 UI 派生，保存时只存涨跌幅）
bindPercentPriceLink(targetPercentLeEl, dailyLePriceInputEl, () => editingStock()?.startPrice ?? null);
bindPercentPriceLink(targetPercentGeEl, dailyGePriceInputEl, () => editingStock()?.startPrice ?? null);
bindPercentPriceLink(importTargetPercentLeEl, importLePriceInputEl, () => numOrNull(importPriceInputEl.value));
bindPercentPriceLink(importTargetPercentGeEl, importGePriceInputEl, () => numOrNull(importPriceInputEl.value));

[targetPercentLeEl, targetPercentGeEl].forEach(el => {
    el.addEventListener('input', refreshDailyTargetText);
});
[importTargetPercentLeEl, importTargetPercentGeEl].forEach(el => {
    el.addEventListener('input', () => refreshImportDerived());
});

// 初始价格编辑：实时重算导入以来涨跌幅与导入目标价
importPriceInputEl.addEventListener('input', () => {
    refreshImportDerived();
    refreshAllPriceInputs();
});

function bindPercentPriceLink(percentEl, priceEl, getBase) {
    percentEl.addEventListener('input', () => {
        const base = getBase();
        priceEl.value = percentToTargetPrice(base, percentEl.value) ?? '';
        priceEl.disabled = base == null;
    });
    priceEl.addEventListener('input', () => {
        percentEl.value = targetPriceToPercent(getBase(), priceEl.value) ?? '';
    });
}

// 从html中获取目标数据
function getTargetData(doc, selectorName) {
    let targetData = '';
    if (selectorName.startsWith("#")) {
        targetData = doc.getElementById(selectorName.substring(1));
    } else {
        targetData = doc.querySelector(selectorName);
    }
    if (targetData) {
        return targetData.textContent;
    }
    return null;
}

// 当前视图 + 排序后的列表（null 值恒排末尾）
function getViewList() {
    const filtered = stockList.filter(s => currentView === 'trash' ? s.inTrash : !s.inTrash);
    if (currentSort === 'default') return filtered;
    const idx = currentSort.lastIndexOf('-');
    const field = currentSort.slice(0, idx);
    const dir = currentSort.slice(idx + 1) === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
        const va = field === 'percent' ? numOrNull(a.percent) : calcImportPercent(a.currentPrice, a.importPrice);
        const vb = field === 'percent' ? numOrNull(b.percent) : calcImportPercent(b.currentPrice, b.importPrice);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va - vb) * dir;
    });
}

// 渲染股票列表（分页）
function renderStockList() {
    const list = getViewList();
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const pageItems = list.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    stockTableEl.innerHTML = '';
    for (const stock of pageItems) {
        stockTableEl.appendChild(renderStock(stock));
    }
    renderPagination(list.length, totalPages);
    renderSortToggles();
}

// 渲染分页栏
function renderPagination(total, totalPages) {
    paginationBarEl.innerHTML = '';
    const prevBtn = document.createElement('button');
    prevBtn.textContent = '‹';
    prevBtn.disabled = currentPage <= 1;
    prevBtn.addEventListener('click', () => {
        currentPage--;
        renderStockList();
    });
    const info = document.createElement('span');
    info.textContent = `第 ${currentPage}/${totalPages} 页，共 ${total} 条`;
    const nextBtn = document.createElement('button');
    nextBtn.textContent = '›';
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.addEventListener('click', () => {
        currentPage++;
        renderStockList();
    });
    const sizeLabel = document.createElement('label');
    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.min = '1';
    sizeInput.className = 'page-size-input';
    sizeInput.value = pageSize;
    sizeInput.addEventListener('change', () => {
        let v = parseInt(sizeInput.value);
        if (!v || v < 1) v = 1;
        pageSize = v;
        sizeInput.value = v;
        chrome.storage.sync.set({ pageSize: v });
        currentPage = 1;
        renderStockList();
    });
    sizeLabel.append('每页 ', sizeInput, ' 条');
    paginationBarEl.append(prevBtn, info, nextBtn, sizeLabel);
}

// 更新排序切换钮状态
function renderSortToggles() {
    sortToggleEls.forEach(el => {
        const field = el.getAttribute('data-field');
        if (currentSort.startsWith(field + '-')) {
            el.classList.add('active');
            el.textContent = currentSort.endsWith('asc') ? '↑' : '↓';
        } else {
            el.classList.remove('active');
            el.textContent = '⇅';
        }
    });
}

// 渲染股票列表单条数据
function renderStock(stock) {
    const tr = document.createElement('tr');
    // 用 createElement/textContent 构建整行，避免第三方页面文本（如 stock.name）注入 HTML
    // 名称 + 复制图标
    const nameTd = document.createElement('td');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = stock.name ? stock.name : '-';
    nameTd.appendChild(nameSpan);
    if (stock.name) {
        const copyImg = document.createElement('img');
        copyImg.src = "./icons/copy.svg";
        copyImg.className = "copy-icon";
        copyImg.title = "复制名称";
        copyImg.addEventListener('click', () => copyText(stock.name, copyImg));
        nameTd.appendChild(copyImg);
    }
    tr.appendChild(nameTd);

    // 初始价格
    const importPriceTd = document.createElement('td');
    importPriceTd.textContent = stock.importPrice != null ? stock.importPrice : '-';
    tr.appendChild(importPriceTd);

    const startPriceTd = document.createElement('td');
    startPriceTd.textContent = stock.startPrice ? stock.startPrice : '-';
    tr.appendChild(startPriceTd);

    const currentPriceTd = document.createElement('td');
    if (stock.startPrice && stock.currentPrice) {
        const priceEl = document.createElement('span');
        priceEl.className = stock.startPrice > stock.currentPrice ? 'fall' : 'rise';
        priceEl.textContent = stock.currentPrice;
        currentPriceTd.appendChild(priceEl);
    } else {
        currentPriceTd.textContent = '-';
    }
    tr.appendChild(currentPriceTd);

    // 涨跌幅：当日 / 导入以来 两行
    const percentTd = document.createElement('td');
    const percentWrap = document.createElement('div');
    percentWrap.className = 'percent-dual';
    const dailySpan = document.createElement('span');
    const dailyVal = numOrNull(stock.percent);
    if (dailyVal !== null) {
        dailySpan.className = dailyVal > 0 ? 'rise' : (dailyVal < 0 ? 'fall' : '');
        dailySpan.textContent = dailyVal + '%';
    } else {
        dailySpan.textContent = '-';
    }
    const importSpan = document.createElement('span');
    const importVal = calcImportPercent(stock.currentPrice, stock.importPrice);
    importSpan.className = 'import-percent';
    if (importVal !== null) {
        if (importVal > 0) importSpan.classList.add('rise');
        if (importVal < 0) importSpan.classList.add('fall');
        importSpan.textContent = importVal + '%';
    } else {
        importSpan.textContent = '-';
    }
    percentWrap.append(dailySpan, importSpan);
    percentTd.appendChild(percentWrap);
    tr.appendChild(percentTd);

    // 操作列
    const td = document.createElement('td');
    const div = document.createElement('div');
    const editImg = document.createElement('img');
    editImg.src = "./icons/edit.svg";
    editImg.className = "edit";
    editImg.addEventListener('click', () => openEdit(stock));
    const stopImg = document.createElement('img');
    stopImg.src = stock.stopRunning ? "./icons/stop.svg" : "./icons/select.svg";
    stopImg.className = "edit";
    stopImg.style.marginLeft = "5px";
    stopImg.addEventListener('click', () => {
        stock.stopRunning = !stock.stopRunning;
        chrome.storage.local.set({ stockList }, () => {
            renderStockList();
            chrome.runtime.sendMessage({ action: 'refresh' });
        });
    });
    div.appendChild(editImg);
    div.appendChild(stopImg);
    td.appendChild(div);
    tr.appendChild(td);
    return tr;
}

// 复制文本到剪贴板（含 fallback）
async function copyText(text, imgEl) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }
    if (imgEl) {
        imgEl.classList.add('copied');
        setTimeout(() => imgEl.classList.remove('copied'), 500);
    }
}

// 打开编辑弹窗
function openEdit(stock) {
    overlayEl.style.display = "flex";
    lastMonitorEl.style.display = "";
    editUrl = stock.url;
    renderEditForm(stock);
    stockUrlEl.disabled = true;
}

// 当前正在编辑的股票（新增模式返回 undefined）
function editingStock() {
    return stockList.find(s => s.url === editUrl);
}

// 填充编辑表单
function renderEditForm(stock) {
    // 网址以 UTF-8 解码形态显示，存储保持编码形态
    stockUrlEl.value = safeDecodeUrl(stock.url);
    stockNameEl.value = stock.name ? stock.name : '';
    // 当日情况
    startPriceEl.textContent = stock.startPrice ? stock.startPrice : '-';
    renderCurrentPriceEl(currentPriceEl, stock);
    const dailyVal = numOrNull(stock.percent);
    percentEl.textContent = dailyVal !== null ? dailyVal + '%' : '-';
    // 导入以来
    importPriceInputEl.value = stock.importPrice != null ? stock.importPrice : '';
    renderCurrentPriceEl(importCurrentPriceEl, stock);
    refreshImportDerived();
    // 目标涨跌幅
    targetPercentLeEl.value = stock.targetPercentLe ? stock.targetPercentLe : '';
    targetPercentGeEl.value = stock.targetPercentGe ? stock.targetPercentGe : '';
    importTargetPercentLeEl.value = stock.importTargetPercentLe ? stock.importTargetPercentLe : '';
    importTargetPercentGeEl.value = stock.importTargetPercentGe ? stock.importTargetPercentGe : '';
    refreshDailyTargetText();
    refreshAllPriceInputs();
    // 垃圾池按钮（仅编辑已有股票时显示）
    trashToggleDivEl.style.display = "flex";
    trashToggleBtnEl.value = stock.inTrash ? "移出垃圾池" : "加入垃圾池";
}

// 渲染现价单元格（相对开盘价涨跌配色）
function renderCurrentPriceEl(container, stock) {
    container.textContent = '';
    if (stock.startPrice && stock.currentPrice) {
        const priceEl = document.createElement('span');
        priceEl.className = stock.startPrice > stock.currentPrice ? 'fall' : 'rise';
        priceEl.textContent = stock.currentPrice;
        container.appendChild(priceEl);
    } else {
        container.textContent = '-';
    }
}

// 刷新「当日目标价」展示（≤x ≥y）
function refreshDailyTargetText() {
    const stock = editingStock();
    targetPriceEl.textContent = getTargetPriceStr(stock?.startPrice ?? null, targetPercentLeEl.value, targetPercentGeEl.value);
}

// 刷新「导入以来」派生展示：涨跌幅、目标价文本
function refreshImportDerived() {
    const base = numOrNull(importPriceInputEl.value);
    const stock = editingStock();
    const ip = stock ? calcImportPercent(stock.currentPrice, base) : null;
    importPercentEl.textContent = ip !== null ? ip + '%' : '-';
    importPercentEl.className = ip !== null && ip !== 0 ? (ip > 0 ? 'rise' : 'fall') : '';
    importTargetPriceEl.textContent = getTargetPriceStr(base, importTargetPercentLeEl.value, importTargetPercentGeEl.value);
}

// 刷新 4 个联动目标价输入框的值与禁用态
function refreshAllPriceInputs() {
    const stock = editingStock();
    const dailyBase = stock?.startPrice ?? null;
    setPriceInput(dailyLePriceInputEl, dailyBase, targetPercentLeEl.value);
    setPriceInput(dailyGePriceInputEl, dailyBase, targetPercentGeEl.value);
    const importBase = numOrNull(importPriceInputEl.value);
    setPriceInput(importLePriceInputEl, importBase, importTargetPercentLeEl.value);
    setPriceInput(importGePriceInputEl, importBase, importTargetPercentGeEl.value);
}

function setPriceInput(input, base, percent) {
    input.disabled = base == null;
    input.value = percentToTargetPrice(base, percent) ?? '';
}

// 目标价字符串：≤x ≥y，基准价缺失返回 -
function getTargetPriceStr(base, le, ge) {
    const parts = [];
    const pl = percentToTargetPrice(base, le);
    const pg = percentToTargetPrice(base, ge);
    if (pl !== null) parts.push('≤' + pl);
    if (pg !== null) parts.push('≥' + pg);
    return parts.length ? parts.join(' ') : '-';
}

// 清空表单（新增模式）
function clearEditForm() {
    stockUrlEl.value = '';
    stockNameEl.value = '';
    targetPercentLeEl.value = '';
    targetPercentGeEl.value = '';
    importTargetPercentLeEl.value = '';
    importTargetPercentGeEl.value = '';
    importPriceInputEl.value = '';
    startPriceEl.textContent = '-';
    currentPriceEl.textContent = '-';
    percentEl.textContent = '-';
    targetPriceEl.textContent = '-';
    importCurrentPriceEl.textContent = '-';
    importPercentEl.textContent = '-';
    importPercentEl.className = '';
    importTargetPriceEl.textContent = '-';
    refreshAllPriceInputs();
}

// 更新开始/停止UI状态
function updateStatus(isActive) {
    if (isActive) {
        startBtn.disabled = true;
        startBtn.style.cursor = "default";
        stopBtn.disabled = false;
        stopBtn.style.cursor = "pointer";
    } else {
        startBtn.disabled = false;
        startBtn.style.cursor = "pointer";
        stopBtn.disabled = true;
        stopBtn.style.cursor = "default";
    }
}

function createChromeNotification(stock, type, percentValue) {
    const label = type === 'import' ? '导入以来涨跌幅' : '当日涨跌幅';
    const direction = percentValue > 0 ? '涨幅' : '跌幅';
    chrome.notifications.create({
        type: "basic",
        iconUrl: "./icons/icon.png",
        title: "股价已达预定值",
        message: `【${stock.name}】${label}${direction}已达到${percentValue}%`,
        priority: 2
    })
}

// 关闭弹窗
function closeModal() {
    lastMonitorEl.style.display = "block";
    overlayEl.style.display = "none";
    stockUrlEl.disabled = false;
    addOrDelDivEl.appendChild(delDivEl);
    addDivEl.classList.remove('single');
}
