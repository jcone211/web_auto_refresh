// 后台服务worker，处理定时刷新逻辑
let refreshInterval = 30; // 默认30秒
let targetUrl = 'https://github.com/';
let selectorName = '';

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
                    width: 360,
                    height: 580,
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
});

// 初始化时加载保存的设置
chrome.storage.local.get(['refreshInterval', 'targetUrl', 'selectorName'], (result) => {
    if (result.refreshInterval) {
        refreshInterval = result.refreshInterval;
    }
    if (result.targetUrl) {
        targetUrl = result.targetUrl;
    }
    if (result.selectorName) {
        selectorName = result.selectorName;
    }
});

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startRefresh') {
        startRefresh(request.interval, request.url, request.selectorName);
        sendResponse({ status: 'started' });
    } else if (request.action === 'stopRefresh') {
        stopRefresh();
        sendResponse({ status: 'stopped' });
    } else if (request.action === 'getStatus') {
        sendResponse({ refreshInterval, targetUrl, selectorName });
    }
});

// 开始定时刷新
function startRefresh(interval, url, selectorName) {
    refreshInterval = interval;
    targetUrl = url;

    // 保存设置
    chrome.storage.local.set({ refreshInterval, targetUrl, selectorName });
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
        chrome.tabs.query({ url: targetUrl }, (tabs) => {
            if (tabs.length > 0) {
                chrome.tabs.reload(tabs[0].id);
                chrome.runtime.sendMessage({ action: "addRefreshCount" });
            } else {
                chrome.tabs.create({ url: targetUrl });
                chrome.runtime.sendMessage({ action: "initRefreshCount" });
            }
        });
    }
});

