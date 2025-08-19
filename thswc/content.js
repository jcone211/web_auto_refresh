let debounceTimer;
// let timer = 0;
// chrome.storage.local.get('localTimer', (result) => {
//     if (!('localTimer' in result)) {
//         chrome.storage.local.set({ localTimer: 0 });
//         timer = 0;
//     } else {
//         timer = result.localTimer;
//     }
// });

//校验+防抖
function captureVerify() {
    if (document.readyState === 'complete' &&
        document.querySelector('.wencai-logo-link') &&
        document.querySelector('.code-name')) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            captureDocument();
        }, 1000); // 增加延迟确保页面完全加载
    }
}

function captureDocument() {
    if (!chrome.runtime || !chrome.runtime.sendMessage) return;
    // console.error("发送消息次数", timer);
    // chrome.storage.local.set({ 'localTimer': ++timer });
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

// 初始抓取
// if (document.readyState === 'complete') {
//     captureDocument();
// } else {
//     window.addEventListener('load', captureDocument);
// }

// 监听动态新增元素
const observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            captureVerify();
        }
    }
});
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener('beforeunload', () => {
    observer.disconnect();
});
