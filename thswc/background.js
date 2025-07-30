// 后台服务worker，处理定时刷新逻辑
let refreshInterval = 30; // 默认30秒
let selectorName = '';
let stockList = [];
let targetUrls = [];

init();

chrome.action.onClicked.addListener(() => {
    chrome.storage.local.get('popupWindowId', ({ popupWindowId }) => {
        if (popupWindowId !== null && popupWindowId !== undefined) {
            chrome.windows.remove(popupWindowId, () => {
                chrome.storage.local.set({ popupWindowId: null });
            });
        } else {
            chrome.windows.getCurrent((currentWindow) => {
                chrome.windows.create({
                    url: chrome.runtime.getURL('popup.html'),
                    type: 'popup',
                    width: 600,
                    height: 436 + (stockList.length - 2) * 45,
                    left: currentWindow.width - 400,
                    top: 50
                }, (newWindow) => {
                    chrome.storage.local.set({ popupWindowId: newWindow.id });
                });
            });
        }
    })
});

// 监听窗口关闭
chrome.windows.onRemoved.addListener((closedWindowId) => {
    chrome.storage.local.get('popupWindowId', ({ popupWindowId }) => {
        if (closedWindowId === popupWindowId) {
            chrome.storage.local.set({ popupWindowId: null });
        }
    })
    chrome.alarms.clear('refreshTimer');
    init();
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
            targetUrls = stockList ? stockList.filter(item => !item.stopRunning).map(item => item.url) : [];
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
    chrome.alarms.clear('refreshTimer');
}

// 定时器触发时刷新页面
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'refreshTimer') {
        if (targetUrls.length > 0) {
            let delay = 0;
            targetUrls.forEach(url => {
                delay += getRandomTime();
                setTimeout(() => {
                    chrome.tabs.query({ url: url }, (tabs) => {
                        if (tabs.length > 0) {
                            chrome.tabs.reload(tabs[0].id);
                        } else {
                            chrome.tabs.create({ url: url });
                        }
                    });
                }, delay)
            })
        }
    }
});

// 延迟刷新反风控
function getRandomTime() {
    return Math.floor(Math.random() * (1200 - 3500) + 3500);
}