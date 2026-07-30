// 后台服务worker，处理定时刷新逻辑
let refreshInterval = 30; // 默认30秒
let selectorName = '';
let stockList = [];
let popupPort = null;

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
            // 直接从 storage 读股票列表计算高度，避免模块级 stockList 尚未加载完时按空列表尺寸创建
            chrome.storage.sync.get(['stockList'], ({ stockList: storedList }) => {
                const stockCount = (storedList || []).length;
                chrome.windows.getCurrent((currentWindow) => {
                    chrome.windows.create({
                        url: chrome.runtime.getURL('popup.html'),
                        type: 'popup',
                        width: 600,
                        height: 436 + Math.max(stockCount - 2, 0) * 45,
                        left: currentWindow.width - 400,
                        top: 50
                    }, (newWindow) => {
                        chrome.storage.local.set({ popupWindowId: newWindow.id });
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

// 初始化时加载保存的设置
function init() {
    chrome.storage.sync.get(['refreshInterval', 'selectorName', 'stockList'], (result) => {
        if (result.refreshInterval) {
            refreshInterval = result.refreshInterval;
        }
        if (result.selectorName) {
            selectorName = result.selectorName;
        }
        if (result.stockList) {
            stockList = result.stockList;
        }
    });
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
        sendResponse({ refreshInterval, selectorName, stockList });
    } else if (request.action === 'refresh') {
        init();
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

// 各股票一次性刷新 alarm 的名称前缀
const STOCK_ALARM_PREFIX = 'refreshStock:';

// 定时器触发时刷新页面
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'refreshTimer') {
        // 每只股票排一个一次性 alarm，随机延迟错开反风控；
        chrome.storage.sync.get(['stockList'], ({ stockList: storedList }) => {
            const urls = (storedList || []).filter(item => !item.stopRunning).map(item => item.url);
            let delay = 0;
            urls.forEach(url => {
                delay += getRandomTime();
                chrome.alarms.create(STOCK_ALARM_PREFIX + url, { when: Date.now() + delay });
            });
        });
    } else if (alarm.name.startsWith(STOCK_ALARM_PREFIX)) {
        const url = alarm.name.slice(STOCK_ALARM_PREFIX.length);
        // 直接从 storage 读最新列表，避免 service worker 冷启动时模块级 targetUrls 尚未加载而误跳过
        chrome.storage.sync.get(['stockList'], ({ stockList: storedList }) => {
            const stillActive = (storedList || []).some(item => item.url === url && !item.stopRunning);
            if (!stillActive) return;
            refreshStockTab(url);
        });
    }
});

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