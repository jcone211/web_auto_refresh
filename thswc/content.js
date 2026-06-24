if (!window.__thswcContentInjected) {
    window.__thswcContentInjected = true;

    let debounceTimer;
    let lastCaptureAt = 0;
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
        if (document.readyState !== 'complete') return;

        const now = Date.now();
        if (now - lastCaptureAt < 3000) return;

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            lastCaptureAt = Date.now();
            captureDocument();
        }, 1000); // 增加延迟确保页面完全加载
    }

    function captureDocument() {
        if (!chrome.runtime || !chrome.runtime.sendMessage) return;

        const message = {
            type: 'DOCUMENT_CAPTURED',
            documentData: {
                title: document.title,
                url: window.location.href,
                html: document.documentElement.outerHTML,
                timestamp: Date.now()
            }
        };

        chrome.runtime.sendMessage(message);
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

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener('beforeunload', () => {
        observer.disconnect();
    });

    captureVerify();
}
