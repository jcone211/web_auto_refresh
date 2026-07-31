import { calcImportPercent, numOrNull, selectorKeyForUrl } from '../shared/utils.js';

// 名称链接跳转：按股票自身域名（问财用名称搜索，雪球用 prefix+code）
export function buildJumpUrl(stock) {
    const key = selectorKeyForUrl(stock.url);
    if (key === 'xq1' && stock.prefix && stock.code) {
        return `https://xueqiu.com/S/${stock.prefix}${stock.code}`;
    }
    if (stock.name) {
        if (key === 'xq1') {
            return `https://xueqiu.com/k?q=${encodeURIComponent(stock.name)}`;
        }
        return `https://www.iwencai.com/screener/result?w=${encodeURIComponent(stock.name)}&querytype=stock`;
    }
    return stock.url;
}

// 复制文本到剪贴板（含 fallback）
export async function copyText(text, imgEl) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }
    if (imgEl) {
        imgEl.classList.add('copied');
        setTimeout(() => imgEl.classList.remove('copied'), 500);
    }
}

// 渲染单行：handlers = { onEdit, onStop, onTogglePin }（无状态，行为由调用方注入）
export function renderStock(stock, handlers) {
    const tr = document.createElement('tr');

    // 名称（可点击跳转）+ 复制图标
    const nameTd = document.createElement('td');
    if (stock.name) {
        const link = document.createElement('a');
        link.className = 'stock-link';
        link.textContent = stock.name;
        link.title = '打开对应网站';
        link.addEventListener('click', (e) => {
            e.stopPropagation();
            chrome.tabs.create({ url: buildJumpUrl(stock) });
        });
        nameTd.appendChild(link);
        const copyImg = document.createElement('img');
        copyImg.src = chrome.runtime.getURL('icons/copy.svg');
        copyImg.className = 'copy-icon';
        copyImg.title = '复制名称';
        copyImg.addEventListener('click', (e) => {
            e.stopPropagation();
            copyText(stock.name, copyImg);
        });
        nameTd.appendChild(copyImg);
    } else {
        nameTd.textContent = '-';
    }
    tr.appendChild(nameTd);

    // 初始价格
    const importPriceTd = document.createElement('td');
    importPriceTd.textContent = stock.importPrice != null ? stock.importPrice : '-';
    tr.appendChild(importPriceTd);

    // 开盘价
    const startPriceTd = document.createElement('td');
    startPriceTd.textContent = stock.startPrice ? stock.startPrice : '-';
    tr.appendChild(startPriceTd);

    // 现价（相对开盘价涨跌配色）
    const currentPriceTd = document.createElement('td');
    if (stock.startPrice && stock.currentPrice) {
        const priceEl = document.createElement('span');
        priceEl.className = stock.startPrice > stock.currentPrice ? 'fall' : 'rise';
        priceEl.textContent = stock.currentPrice;
        currentPriceTd.appendChild(priceEl);
    } else {
        currentPriceTd.textContent = '-';
    }
    tr.appendChild(currentPriceTd);

    // 涨跌幅：当日 / 导入以来 两行
    const percentTd = document.createElement('td');
    const percentWrap = document.createElement('div');
    percentWrap.className = 'percent-dual';
    const dailySpan = document.createElement('span');
    const dailyVal = numOrNull(stock.percent);
    if (dailyVal !== null) {
        dailySpan.className = dailyVal > 0 ? 'rise' : (dailyVal < 0 ? 'fall' : '');
        dailySpan.textContent = dailyVal + '%';
    } else {
        dailySpan.textContent = '-';
    }
    const importSpan = document.createElement('span');
    const importVal = calcImportPercent(stock.currentPrice, stock.importPrice);
    importSpan.className = 'import-percent';
    if (importVal !== null) {
        if (importVal > 0) importSpan.classList.add('rise');
        if (importVal < 0) importSpan.classList.add('fall');
        importSpan.textContent = importVal + '%';
    } else {
        importSpan.textContent = '-';
    }
    percentWrap.append(dailySpan, importSpan);
    percentTd.appendChild(percentWrap);
    tr.appendChild(percentTd);

    // 操作列：编辑 / 启停 / 置顶
    const td = document.createElement('td');
    const div = document.createElement('div');
    div.className = 'action-icons';
    const editImg = document.createElement('img');
    editImg.src = chrome.runtime.getURL('icons/edit.svg');
    editImg.className = 'edit';
    editImg.title = '编辑';
    editImg.addEventListener('click', () => handlers.onEdit(stock));
    const stopImg = document.createElement('img');
    stopImg.src = stock.stopRunning ? chrome.runtime.getURL('icons/stop.svg') : chrome.runtime.getURL('icons/select.svg');
    stopImg.className = 'edit';
    stopImg.style.marginLeft = '5px';
    stopImg.title = stock.stopRunning ? '已停止，点击恢复' : '运行中，点击停止';
    stopImg.addEventListener('click', () => handlers.onStop(stock));
    const pinImg = document.createElement('img');
    pinImg.className = 'edit';
    pinImg.style.marginLeft = '5px';
    pinImg.src = stock.pinned ? chrome.runtime.getURL('icons/pin.svg') : chrome.runtime.getURL('icons/to-top.svg');
    pinImg.title = stock.pinned ? '取消置顶' : '置顶到最前';
    pinImg.addEventListener('click', () => handlers.onTogglePin(stock));
    div.append(editImg, stopImg, pinImg);
    td.appendChild(div);
    tr.appendChild(td);
    return tr;
}

// 渲染分页栏：view = { currentPage, totalPages, pageSize }；handlers = { onPrev, onNext, onPageSize }
export function renderPagination(container, view, handlers) {
    container.innerHTML = '';
    const prevBtn = document.createElement('button');
    prevBtn.textContent = '‹';
    prevBtn.disabled = view.currentPage <= 1;
    prevBtn.addEventListener('click', handlers.onPrev);
    const info = document.createElement('span');
    info.textContent = `第 ${view.currentPage}/${view.totalPages} 页，共 ${view.total} 条`;
    const nextBtn = document.createElement('button');
    nextBtn.textContent = '›';
    nextBtn.disabled = view.currentPage >= view.totalPages;
    nextBtn.addEventListener('click', handlers.onNext);
    const sizeLabel = document.createElement('label');
    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.min = '1';
    sizeInput.className = 'page-size-input';
    sizeInput.value = view.pageSize;
    sizeInput.addEventListener('change', () => {
        let v = parseInt(sizeInput.value);
        if (!v || v < 1) v = 1;
        sizeInput.value = v;
        handlers.onPageSize(v);
    });
    sizeLabel.append('每页 ', sizeInput, ' 条');
    container.append(prevBtn, info, nextBtn, sizeLabel);
}

// 更新表头排序钮视觉态
export function renderSortToggles(currentSort, els) {
    els.forEach(el => {
        const field = el.getAttribute('data-field');
        if (currentSort.startsWith(field + '-')) {
            el.classList.add('active');
            el.textContent = currentSort.endsWith('asc') ? '↑' : '↓';
        } else {
            el.classList.remove('active');
            el.textContent = '⇅';
        }
    });
}

// 渲染组合切换 chip（单选语义：checkbox 外观，仅一个活动）
export function renderComboSwitches(portfolios, active, container, onSwitch) {
    container.innerHTML = '';
    const names = Object.keys(portfolios);
    if (names.length === 0) return;
    names.forEach(name => {
        const label = document.createElement('label');
        label.className = 'combo-chip' + (name === active ? ' active' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = (name === active);
        cb.addEventListener('change', () => {
            if (cb.checked) {
                onSwitch(name);
            } else {
                cb.checked = true; // 不允许取消当前活动组合
            }
        });
        const txt = document.createElement('span');
        txt.textContent = name;
        label.append(cb, txt);
        container.appendChild(label);
    });
}
