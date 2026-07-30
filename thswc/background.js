// 后台服务worker，处理定时刷新逻辑
let refreshInterval = 30; // 默认30秒
let selectorName = '';
let currentView = 'list'; // 当前列表视图：'list' 股票列表 | 'trash' 垃圾池
let popupPort = null;

// 各股票一次性刷新 alarm 的名称前缀
const STOCK_ALARM_PREFIX = 'refreshStock:';

init();

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'popup-connection') {
        popupPort = port;
        port.onDisconnect.addListener(() => {
            popupPort = null;
        });
    }
});

// 监听标签页更新，动态注入脚本
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !isIwencaiUrl(tab.url)) return;

    chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
    }).catch(err => console.error('脚本执行失败:', err));
});

function isIwencaiUrl(url) {
    if (!url) return false;

    try {
        const { hostname } = new URL(url);
        return hostname === 'iwencai.com' || hostname.endsWith('.iwencai.com');
    } catch {
        return false;
    }
}



chrome.action.onClicked.addListener(() => {
    chrome.storage.local.get('popupWindowId', ({ popupWindowId }) => {
        if (popupWindowId !== null && popupWindowId !== undefined) {
            chrome.windows.remove(popupWindowId, () => {
                chrome.storage.local.set({ popupWindowId: null });
            });
        } else {
            // 分页后窗口高度按每页条数算，避免按全量股票列表撑高
            chrome.storage.local.get(['stockList'], (localData) => {
                chrome.storage.sync.get(['pageSize'], (syncData) => {
                    const stockCount = (localData.stockList || []).length;
                    const pageSize = syncData.pageSize || 10;
                    const rows = Math.min(stockCount, pageSize);
                    chrome.windows.getCurrent((currentWindow) => {
                        chrome.windows.create({
                            url: chrome.runtime.getURL('popup.html'),
                            type: 'popup',
                            width: 704,
                            height: 484 + Math.max(rows - 2, 0) * 56,
                            left: currentWindow.width - 400,
                            top: 50
                        }, (newWindow) => {
                            chrome.storage.local.set({ popupWindowId: newWindow.id });
                        });
                    });
                });
            });
        }
    })
});

// 监听窗口关闭：仅当关闭的是插件弹窗时停止监控
chrome.windows.onRemoved.addListener((closedWindowId) => {
    chrome.storage.local.get('popupWindowId', ({ popupWindowId }) => {
        if (closedWindowId !== popupWindowId) return;
        chrome.storage.local.set({ popupWindowId: null });
        chrome.alarms.clearAll();
    });
});

// 初始化：先做幂等迁移，再加载设置
function init() {
    ensureMigrated().then(() => {
        chrome.storage.sync.get(['refreshInterval', 'selectorName'], (result) => {
            if (result.refreshInterval) {
                refreshInterval = result.refreshInterval;
            }
            if (result.selectorName) {
                selectorName = result.selectorName;
            }
        });
    });
}

// 幂等迁移：确保 stockList 在 storage.local 且字段已补齐。
// background 是唯一迁移执行者，popup 只经 getStatus 读迁移后的数据。
function ensureMigrated() {
    if (ensureMigrated.promise) return ensureMigrated.promise;
    ensureMigrated.promise = new Promise((resolve) => {
        chrome.storage.local.get(['stockList', 'currentView'], (localResult) => {
            if (localResult.currentView) {
                currentView = localResult.currentView;
            }
            const finish = (list) => {
                chrome.storage.local.set({ stockList: list }, resolve);
            };
            if ('stockList' in localResult) {
                // 已迁移过，仅补齐老数据字段
                finish(migrateStockFields(localResult.stockList || []));
            } else {
                // 首次迁移：sync → local
                chrome.storage.sync.get(['stockList'], (syncResult) => {
                    if (syncResult.stockList) {
                        chrome.storage.sync.remove('stockList');
                    }
                    finish(migrateStockFields(syncResult.stockList || []));
                });
            }
        });
    });
    return ensureMigrated.promise;
}

// 老数据字段补齐（importPrice 不补，保持 null 由首次抓取回填）
function migrateStockFields(list) {
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        if (!('importTargetPercentLe' in item)) item.importTargetPercentLe = '';
        if (!('importTargetPercentGe' in item)) item.importTargetPercentGe = '';
        if (!('notifiedDaily' in item)) {
            item.notifiedDaily = item.notified ?? false;
            delete item.notified;
        }
        if (!('notifiedImport' in item)) item.notifiedImport = false;
        if (!('inTrash' in item)) item.inTrash = false;
    }
    return list;
}

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startRefresh') {
        startRefresh(request.interval, request.selectorName);
        sendResponse({ status: 'started' });
    } else if (request.action === 'stopRefresh') {
        stopRefresh();
        sendResponse({ status: 'stopped' });
    } else if (request.action === 'getStatus') {
        // 等迁移完成后直接读 storage 响应，避免模块缓存滞后于 popup 的写入
        ensureMigrated().then(() => {
            chrome.storage.local.get(['stockList'], (localResult) => {
                chrome.storage.sync.get(['refreshInterval', 'selectorName', 'pageSize'], (syncResult) => {
                    sendResponse({
                        refreshInterval: syncResult.refreshInterval,
                        selectorName: syncResult.selectorName,
                        pageSize: syncResult.pageSize || 10,
                        currentView,
                        stockList: localResult.stockList || []
                    });
                });
            });
        });
        return true; // 异步 sendResponse
    } else if (request.action === 'refresh') {
        init();
    } else if (request.action === 'setView') {
        currentView = request.view === 'trash' ? 'trash' : 'list';
        chrome.storage.local.set({ currentView });
        // 只清各股票一次性 alarm（不能 clearAll，否则会误删周期性 refreshTimer）
        chrome.alarms.getAll((alarms) => {
            alarms.filter(a => a.name.startsWith(STOCK_ALARM_PREFIX))
                .forEach(a => chrome.alarms.clear(a.name));
            // 监控运行中则立即按新视图重排
            chrome.alarms.get('refreshTimer', (alarm) => {
                if (alarm) scheduleStockAlarms();
            });
        });
        sendResponse({ status: 'ok' });
    } else if (request.type === 'DOCUMENT_CAPTURED') {
        if (popupPort) {
            popupPort.postMessage(request);
        }
        sendResponse({ status: 'received', forwarded: !!popupPort });
    }
});

// 开始定时刷新
function startRefresh(interval, sn) {
    refreshInterval = interval;
    selectorName = sn;
    chrome.storage.sync.set({ refreshInterval, selectorName });
    // 创建定时器
    chrome.alarms.create('refreshTimer', {
        delayInMinutes: 0,
        periodInMinutes: refreshInterval / 60
    });
}

// 停止定时刷新
function stopRefresh() {
    // 同时清掉主定时器和已排队的各股票一次性 alarm
    chrome.alarms.clearAll();
}

// 定时器触发时刷新页面
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'refreshTimer') {
        scheduleStockAlarms();
    } else if (alarm.name.startsWith(STOCK_ALARM_PREFIX)) {
        const url = alarm.name.slice(STOCK_ALARM_PREFIX.length);
        // 直接从 storage 读最新列表与视图，避免 service worker 冷启动时状态缺失
        chrome.storage.local.get(['stockList', 'currentView'], ({ stockList, currentView: view }) => {
            const v = view || 'list';
            const stillActive = (stockList || []).some(item =>
                item.url === url
                && !item.stopRunning
                && (v === 'trash' ? item.inTrash : !item.inTrash));
            if (!stillActive) return;
            refreshStockTab(url);
        });
    }
});

// 为当前视图下的每只股票排一个一次性 alarm，随机延迟错开反风控；
// alarm 由浏览器进程托管，不随 service worker 回收而丢失，股票数量不受限
function scheduleStockAlarms() {
    chrome.storage.local.get(['stockList', 'currentView'], ({ stockList, currentView: view }) => {
        const v = view || 'list';
        const urls = (stockList || [])
            .filter(item => !item.stopRunning && (v === 'trash' ? item.inTrash : !item.inTrash))
            .map(item => item.url);
        let delay = 0;
        urls.forEach(url => {
            delay += getRandomTime();
            chrome.alarms.create(STOCK_ALARM_PREFIX + url, { when: Date.now() + delay });
        });
    });
}

// 刷新（或新打开）单只股票的标签页
function refreshStockTab(url) {
    chrome.tabs.query({ url: url }, (tabs) => {
        // query 的 url 参数按 match pattern 语义匹配、不区分 query string，
        // 各股票 path 相同会互相命中，需按完整 URL 精确过滤
        const target = tabs.find(t => t.url === url);
        if (target) {
            chrome.tabs.reload(target.id);
        } else {
            chrome.tabs.create({ url: url });
        }
    });
}

// 延迟刷新反风控
function getRandomTime() {
    return Math.floor(Math.random() * (3500 - 1200) + 1200);
}
