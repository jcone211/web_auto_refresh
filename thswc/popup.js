import { getDateTime } from "./utils.js";

let selectorName = '';
let stockList = [
    {
        url: "https://www.iwencai.com/unifiedwap/result?w=%E8%8C%85%E5%8F%B0",
        name: "贵州茅台",
        startPrice: 1410.71,  //开盘价
        currentPrice: 1411.70,    //现价
        percent: 0.08,  //涨跌幅
        targetPercent: -3.0,  //目标涨跌幅
        targetPrice: 1368.39, //目标价格
        stopRunning: true,  //是否停止运行
    },
    {
        url: "https://www.iwencai.com/unifiedwap/result?tid=stockpick&qs=box_main_ths&w=%E4%B8%8A%E6%B5%B7%E7%89%A9%E8%B4%B8",
        name: "上海物贸",
        startPrice: 9.78,
        currentPrice: 9.94,
        percent: 0.20,
        targetPercent: -1.0,
        targetPrice: 9.68,
        stopRunning: true,  //是否运行
    },
    {
        url: "https://www.iwencai.com/unifiedwap/result?w=%E4%B8%9C%E6%96%B9%E9%9B%A8%E8%99%B9&querytype=stock",
        name: "东方雨虹",
        startPrice: 11.20,
        currentPrice: 11.19,
        percent: -0.18,
        targetPercent: -1.0,
        targetPrice: 11.09,
        stopRunning: true,  //是否运行
    },
]
let urls = [];
let editUrl = undefined;

const selectorsEnum = {
    "wc1": {
        name: ".code-name.f24", //名称
        dqj: ".price.f24.pr8.fb", //当前价
        zdf: ".rise-fall.f20",   //涨跌幅(+1.20)元
        percent: ".rise-fall-rate.f20" //涨跌幅(/+1.0%)
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
const editBtnEl = document.querySelectorAll('.edit');
const stockTableEl = document.getElementById('stockTable');
const addOrDelDivEl = document.getElementById('addOrDelDiv');
const addDivEl = document.getElementById('addDiv');
const delDivEl = document.getElementById('delDiv');

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
        urls = stockList.map(item => item.url);
        updateStatus(false);
        renderStockList()
    }
});

// 快速打开文本框
quickOpenEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && quickOpenEl.value) {
        event.preventDefault();
        const names = quickOpenEl.value.split(/[\s,，、；;|\/]+/).filter(Boolean);
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
    lastMonitorEl.style.display = "none";
    clearEditForm();
    editUrl = undefined;
    delDivEl.remove();
    addDivEl.classList.add('single');
});

// 保存股票按钮
saveStockBtnEl.addEventListener('click', () => {
    const url = document.getElementById('stockUrl').value;
    if (!url) {
        alert('请输入网址');
        return;
    }
    if (editUrl) {
        const list = stockList.filter(item => item.url === editUrl);
        if (list.length < 0) {
            alert('保存失败，请关闭重试');
            return;
        }
        const item = list[0];
        item.name = document.getElementById('stockName').value;
        item.targetPercent = document.getElementById('targetPercent').value;
    } else {
        stockList.push({
            url: url,
            name: document.getElementById('stockName').value,
            targetPercent: document.getElementById('targetPercent').value,
        });
    }
    chrome.storage.sync.set({ stockList }, () => {
        renderStockList();
        closeModal();
        chrome.runtime.sendMessage({ action: 'refresh' });
    });
});

//删除股票按钮
delStockBtnEl.addEventListener('click', () => {
    const url = document.getElementById('stockUrl').value;
    chrome.storage.sync.get(['stockList'], (data) => {
        const dataStockList = data.stockList || [];
        const index = dataStockList.findIndex((item) => item.url === url);
        if (index !== -1) {
            dataStockList.splice(index, 1);
            stockList = dataStockList;
            chrome.storage.sync.set({ stockList }, () => {
                renderStockList();
                closeModal();
                chrome.runtime.sendMessage({ action: 'refresh' });
            });
        }
    })
});

// 接收并处理页面刷新后的数据
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'DOCUMENT_CAPTURED') {
        const messageUrl = message.documentData.url;
        const index = urls.findIndex(item => item === messageUrl);
        if (index === -1) {
            return;
        }
        const stock = stockList[index];
        // 将HTML字符串转换为DOM
        // console.error(JSON.stringify(message.documentData.html));
        const parser = new DOMParser();

        if (message.documentData.html) {
            const doc = parser.parseFromString(message.documentData.html, 'text/html');
            if (selectorsEnum[selectorName] !== undefined) {
                const selector = selectorsEnum[selectorName];
                if (selectorName === 'wc1') {
                    if (!stock.name) {
                        let name = getTargetData(doc, selector.name);
                        if (name) {
                            name = name.replace(/\s*\(.*?\)/, '');
                            stock.name = name;
                        }
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
                    }
                    if (percent) {
                        stock.percent = percent;
                    }
                    //发送价格监控通知
                    if (stock.targetPercent > 0 && percent > stock.targetPercent) {
                        createChromeNotification(stock);
                    } else if (stock.targetPercent < 0 && percent < stock.targetPercent) {
                        createChromeNotification(stock);
                    }
                    lastUpdateTimeEl.textContent = getDateTime();
                    // console.error('name', stock.name, 'startPrice', stock.startPrice, 'currentPrice', stock.currentPrice, 'percent', stock.percent);
                    chrome.storage.sync.set({ stockList }, (data) => {
                        renderStockList();
                    });
                }
            } else {
                getTargetData(doc, selectorName);
            }
        }
    }
});

// 从html中获取目标数据
function getTargetData(doc, selectorName) {
    let targetData = '';
    if (selectorName.startsWith("#")) {
        targetData = doc.getElementsById(selectorName.substring(1));
    } else {
        targetData = doc.querySelector(selectorName);
    }
    if (targetData) {
        return targetData.textContent;
    }
    return null;
}

// 点击编辑图标
editBtnEl.forEach(btn => {
    btn.addEventListener('click', () => {
        const stockIndex = btn.getAttribute('data-id');
        const stock = stockList[stockIndex];
        overlayEl.style.display = "flex";
        // 填充表单数据
        document.getElementById('stockName').value = stock.name;
        document.getElementById('startPrice').value = stock.startPrice;
    })
})

// 渲染股票列表
function renderStockList() {
    stockTableEl.innerHTML = '';
    for (let i = 0; i < stockList.length; i++) {
        stockTableEl.appendChild(renderStock(i));
    }
}

// 渲染股票列表单条数据
function renderStock(stockIndex) {
    const tr = document.createElement('tr');
    const stock = stockList[stockIndex];
    tr.innerHTML = `
        <td>${stock.name ? stock.name : '-'}</td>
        <td>${stock.startPrice ? stock.startPrice : '-'}</td>
        <td>${stock.startPrice && stock.currentPrice ? '<text class="' + (stock.startPrice > stock.currentPrice ? 'fall">' : 'rise">') + stock.currentPrice + '</text>' : '-'}</td>
        <td>${stock.percent ? stock.percent + '%' : '-'}</td>
        <td>${stock.targetPercent ? stock.targetPercent + '%' : '-'}</td>`;

    const td = document.createElement('td');
    const div = document.createElement('div');
    const editImg = document.createElement('img');
    editImg.src = "./icons/edit.svg";
    editImg.className = "edit";
    editImg.setAttribute('data-id', stockIndex);
    // 给编辑按钮绑定点击事件
    editImg.addEventListener('click', () => {
        overlayEl.style.display = "flex";
        editUrl = stock.url;
        // 填充表单数据
        renderEditForm(stock);
        document.getElementById('stockUrl').disabled = true;
    });
    const stopImg = document.createElement('img');
    stopImg.src = stock.stopRunning ? "./icons/stop.svg" : "./icons/select.svg";
    stopImg.className = "edit";
    stopImg.style.marginLeft = "5px";
    stopImg.setAttribute('data-id', stockIndex);
    stopImg.addEventListener('click', () => {
        stock.stopRunning = !stock.stopRunning;
        chrome.storage.sync.set({ stockList }, (data) => {
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
function createChromeNotification(stock) {
    chrome.notifications.create({
        type: "basic",
        iconUrl: "./icons/icon.png",
        title: "股价已达预定值",
        message: "【" + stock.name + "】" + (stock.percent > 0 ? "涨幅" : "跌幅") + "已达到" + "" + stock.percent + "%",
        priority: 2
    })
}

function renderEditForm(stock) {
    document.getElementById('stockUrl').value = stock.url;
    document.getElementById('stockName').value = stock.name ? stock.name : '';
    document.getElementById('startPrice').textContent = stock.startPrice ? stock.startPrice : '-';
    if (stock.startPrice && stock.currentPrice) {
        document.getElementById('currentPrice').innerHTML = '<text class="' + (stock.startPrice > stock.currentPrice ? 'fall' : 'rise') + '">' + stock.currentPrice + '</text>';
    } else {
        document.getElementById('currentPrice').textContent = '-';
    }
    document.getElementById('percent').textContent = stock.percent ? (stock.percent + '%') : '-';
    document.getElementById('targetPercent').value = stock.targetPercent ? stock.targetPercent : null;
    if (stock.startPrice && stock.targetPercent) {
        const targetPrice = (stock.startPrice * (1 + stock.targetPercent / 100)).toFixed(2);
        document.getElementById('targetPrice').textContent = targetPrice;
    } else {
        document.getElementById('targetPrice').textContent = '-';
    }
}

function clearEditForm() {
    document.getElementById('stockUrl').value = '';
    document.getElementById('stockName').value = '';
    document.getElementById('targetPercent').value = null;
}

// 关闭弹窗
function closeModal() {
    lastMonitorEl.style.display = "block";
    overlayEl.style.display = "none";
    document.getElementById('stockUrl').disabled = false;
    addOrDelDivEl.appendChild(delDivEl);
    addDivEl.classList.remove('single');
}