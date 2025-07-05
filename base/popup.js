let refreshCount = 0;
// 存储捕获的document数据
let capturedDocuments = {};
let selectorName = '';
//监听的旧数据，根据是否变更来判断是否有更新
let targetOldData = '';

const urlInput = document.getElementById('url');
const intervalInput = document.getElementById('interval');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const refreshCountEl = document.getElementById('refreshCount');
const selectorEl = document.getElementById('selectorName');
const monitorDataEl = document.getElementById('monitorData');
const refreshTimeEl = document.getElementById('refreshTime');

// 加载保存的设置
chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
        urlInput.value = response.targetUrl || '';
        intervalInput.value = response.refreshInterval || 60;
        selectorEl.value = response.selectorName || '';
        updateStatus(false);
    }
});

// 开始刷新按钮点击事件
startBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    const interval = parseInt(intervalInput.value);
    selectorName = selectorEl.value;

    if (!url) {
        alert('请输入有效的URL');
        return;
    }

    chrome.runtime.sendMessage({
        action: 'startRefresh',
        interval: interval,
        url: url,
        selectorName: selectorName
    }, (response) => {
        if (response && response.status === 'started') {
            updateStatus(true);
        }
    });
});

// 停止刷新按钮点击事件
stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopRefresh' }, (response) => {
        if (response && response.status === 'stopped') {
            updateStatus(false);
        }
    });
});

// 更新UI状态
function updateStatus(isActive) {
    if (isActive) {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        statusDiv.textContent = `状态: 正在刷新 ${urlInput.value} (每${intervalInput.value}秒)`;
        statusDiv.className = 'active';
    } else {
        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusDiv.textContent = '状态: 未运行';
        statusDiv.className = 'inactive';
    }
}

// 更新刷新数量
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "addRefreshCount") {
        refreshCount++;
        refreshCountEl.textContent = `已刷新次数：${refreshCount}`;
    } else if (message.action === "initRefreshCount") {
        refreshCount = 1;
        refreshCountEl.textContent = `已刷新次数：${refreshCount}`;
    } else if (message.type === 'DOCUMENT_CAPTURED') {
        // 存储捕获的document数据
        capturedDocuments[message.documentData.url] = message.documentData;

        // 将HTML字符串转换为DOM
        // console.error(JSON.stringify(message.documentData.html));
        const parser = new DOMParser();

        if (message.documentData.html) {
            const doc = parser.parseFromString(message.documentData.html, 'text/html');
            if (selectorName) {
                let targetData = '';
                if (selectorName.startsWith("#")) {
                    targetData = doc.getElementsById(selectorName.substring(1));
                } else {
                    targetData = doc.querySelector(selectorName);
                }
                monitorDataEl.textContent = `监听数据：${targetData?.textContent ? targetData.textContent : '未找到，请重新填写选择器'}`;
                // 检查是否有变化
                if (targetOldData !== '' && targetData && targetData.textContent !== targetOldData) {
                    // 发送消息给后台脚本
                    createChromeNotification(targetData.textContent);
                    refreshTimeEl.textContent = `监听数据更新时间：${new Date().toLocaleString()}`;
                }
                if (targetData) {
                    targetOldData = targetData.textContent;
                }
            }
        } else {
            monitorDataEl.textContent = `监听数据不存在`;
        }
    }
});

function createChromeNotification(msg) {
    chrome.notifications.create({
        type: "basic",
        iconUrl: "./icons/war_icon_128x128.png",
        title: "监听页面已更新",
        message: msg,
        priority: 2
    })
}