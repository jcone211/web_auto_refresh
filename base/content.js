// 监听页面加载事件
function captureDocument() {
    // 延迟500ms确保动态内容加载完成
    setTimeout(() => {
        // 检查页面是否完全加载
        if (document.readyState === 'complete') {
            chrome.runtime.sendMessage({
                type: 'DOCUMENT_CAPTURED',
                documentData: {
                    title: document.title,
                    url: window.location.href,
                    html: document.documentElement.outerHTML,
                    timestamp: Date.now()
                }
            });
        }
    }, 500);
}

// 监听页面完全加载事件
window.addEventListener('load', () => {
    // 额外延迟1秒确保所有资源加载完成
    setTimeout(captureDocument, 1000);
});

// 监听网络空闲事件(如果可用)
if (window.requestIdleCallback) {
    window.requestIdleCallback(captureDocument, { timeout: 2000 });
} else {
    // 备用方案：延迟2秒捕获
    setTimeout(captureDocument, 2000);
}

// 监听history变化(单页应用)
const handleSPANavigation = () => {
    // SPA导航后延迟1秒捕获
    setTimeout(captureDocument, 1000);
};

window.addEventListener('popstate', handleSPANavigation);
window.addEventListener('pushstate', handleSPANavigation);
window.addEventListener('replacestate', handleSPANavigation);

// 初始捕获
captureDocument();
