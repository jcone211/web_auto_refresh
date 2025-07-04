let refreshCount = 0;

const urlInput = document.getElementById('url');
const intervalInput = document.getElementById('interval');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const refreshCountEl = document.getElementById('refreshCount');

// 加载保存的设置
chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (response) {
        urlInput.value = response.targetUrl || '';
        intervalInput.value = response.refreshInterval || 60;
        updateStatus(false);
    }
});

// 开始刷新按钮点击事件
startBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    const interval = parseInt(intervalInput.value);

    if (!url) {
        alert('请输入有效的URL');
        return;
    }

    chrome.runtime.sendMessage({
        action: 'startRefresh',
        interval: interval,
        url: url
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
    }
});