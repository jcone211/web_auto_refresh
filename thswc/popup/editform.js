import {
    percentToTargetPrice, targetPriceToPercent, calcImportPercent,
    numOrNull, formatDateTime, safeDecodeUrl
} from '../shared/utils.js';

// 渲染现价单元格（相对开盘价涨跌配色）
function renderCurrentPriceEl(container, stock) {
    container.textContent = '';
    if (stock.startPrice && stock.currentPrice) {
        const priceEl = document.createElement('span');
        priceEl.className = stock.startPrice > stock.currentPrice ? 'fall' : 'rise';
        priceEl.textContent = stock.currentPrice;
        container.appendChild(priceEl);
    } else {
        container.textContent = '-';
    }
}

// 目标价字符串：≤x ≥y，基准价缺失返回 -
function getTargetPriceStr(base, le, ge) {
    const parts = [];
    const pl = percentToTargetPrice(base, le);
    const pg = percentToTargetPrice(base, ge);
    if (pl !== null) parts.push('≤' + pl);
    if (pg !== null) parts.push('≥' + pg);
    return parts.length ? parts.join(' ') : '-';
}

function setPriceInput(input, base, percent) {
    input.disabled = base == null;
    input.value = percentToTargetPrice(base, percent) ?? '';
}

// 编辑表单工厂：els = 相关 DOM 元素集合；deps.getStock = 取当前编辑中的股票
export function createEditForm(els, deps) {
    const getStock = deps.getStock;

    function refreshDailyTargetText() {
        const stock = getStock();
        els.targetPriceEl.textContent = getTargetPriceStr(
            stock?.startPrice ?? null, els.targetPercentLeEl.value, els.targetPercentGeEl.value);
    }

    function refreshImportDerived() {
        const base = numOrNull(els.importPriceInputEl.value);
        const stock = getStock();
        const ip = stock ? calcImportPercent(stock.currentPrice, base) : null;
        els.importPercentEl.textContent = ip !== null ? ip + '%' : '-';
        els.importPercentEl.className = ip !== null && ip !== 0 ? (ip > 0 ? 'rise' : 'fall') : '';
        els.importTargetPriceEl.textContent = getTargetPriceStr(
            base, els.importTargetPercentLeEl.value, els.importTargetPercentGeEl.value);
    }

    function refreshAllPriceInputs() {
        const stock = getStock();
        const dailyBase = stock?.startPrice ?? null;
        setPriceInput(els.dailyLePriceInputEl, dailyBase, els.targetPercentLeEl.value);
        setPriceInput(els.dailyGePriceInputEl, dailyBase, els.targetPercentGeEl.value);
        const importBase = numOrNull(els.importPriceInputEl.value);
        setPriceInput(els.importLePriceInputEl, importBase, els.importTargetPercentLeEl.value);
        setPriceInput(els.importGePriceInputEl, importBase, els.importTargetPercentGeEl.value);
    }

    function bindPercentPriceLink(percentEl, priceEl, getBase) {
        percentEl.addEventListener('input', () => {
            const base = getBase();
            priceEl.value = percentToTargetPrice(base, percentEl.value) ?? '';
            priceEl.disabled = base == null;
        });
        priceEl.addEventListener('input', () => {
            percentEl.value = targetPriceToPercent(getBase(), priceEl.value) ?? '';
        });
    }

    // 绑定涨跌幅 ⇄ 目标价联动（一次性，元素为静态 HTML）
    function bindLinkage() {
        bindPercentPriceLink(els.targetPercentLeEl, els.dailyLePriceInputEl, () => getStock()?.startPrice ?? null);
        bindPercentPriceLink(els.targetPercentGeEl, els.dailyGePriceInputEl, () => getStock()?.startPrice ?? null);
        bindPercentPriceLink(els.importTargetPercentLeEl, els.importLePriceInputEl, () => numOrNull(els.importPriceInputEl.value));
        bindPercentPriceLink(els.importTargetPercentGeEl, els.importGePriceInputEl, () => numOrNull(els.importPriceInputEl.value));
        [els.targetPercentLeEl, els.targetPercentGeEl].forEach(e => e.addEventListener('input', refreshDailyTargetText));
        [els.importTargetPercentLeEl, els.importTargetPercentGeEl].forEach(e => e.addEventListener('input', refreshImportDerived));
        els.importPriceInputEl.addEventListener('input', () => {
            refreshImportDerived();
            refreshAllPriceInputs();
        });
    }

    function render(stock) {
        // 身份头：名称 + 代码 + 创建时间
        els.stockNameEl.value = stock.name ? stock.name : '';
        els.stockCodeEl.textContent = (stock.prefix && stock.code) ? (stock.prefix + ':' + stock.code) : (stock.code || '-');
        els.stockCreatedAtEl.textContent = formatDateTime(stock.createdAt);
        // 网址以 UTF-8 解码形态显示，存储保持编码形态
        els.stockUrlEl.value = safeDecodeUrl(stock.url);
        // 当日情况
        els.startPriceEl.textContent = stock.startPrice ? stock.startPrice : '-';
        renderCurrentPriceEl(els.currentPriceEl, stock);
        const dailyVal = numOrNull(stock.percent);
        els.percentEl.textContent = dailyVal !== null ? dailyVal + '%' : '-';
        // 导入以来
        els.importPriceInputEl.value = stock.importPrice != null ? stock.importPrice : '';
        renderCurrentPriceEl(els.importCurrentPriceEl, stock);
        refreshImportDerived();
        // 目标涨跌幅
        els.targetPercentLeEl.value = stock.targetPercentLe ? stock.targetPercentLe : '';
        els.targetPercentGeEl.value = stock.targetPercentGe ? stock.targetPercentGe : '';
        els.importTargetPercentLeEl.value = stock.importTargetPercentLe ? stock.importTargetPercentLe : '';
        els.importTargetPercentGeEl.value = stock.importTargetPercentGe ? stock.importTargetPercentGe : '';
        refreshDailyTargetText();
        refreshAllPriceInputs();
        // 编辑模式：显示上排操作（删除 + 垃圾池）
        els.editActionsTopEl.style.display = 'flex';
        els.trashToggleBtnEl.value = stock.inTrash ? '移出垃圾池' : '加入垃圾池';
    }

    function clear() {
        els.stockNameEl.value = '';
        els.stockCodeEl.textContent = '-';
        els.stockCreatedAtEl.textContent = '-';
        els.stockUrlEl.value = '';
        els.targetPercentLeEl.value = '';
        els.targetPercentGeEl.value = '';
        els.importTargetPercentLeEl.value = '';
        els.importTargetPercentGeEl.value = '';
        els.importPriceInputEl.value = '';
        els.startPriceEl.textContent = '-';
        els.currentPriceEl.textContent = '-';
        els.percentEl.textContent = '-';
        els.targetPriceEl.textContent = '-';
        els.importCurrentPriceEl.textContent = '-';
        els.importPercentEl.textContent = '-';
        els.importPercentEl.className = '';
        els.importTargetPriceEl.textContent = '-';
        refreshAllPriceInputs();
    }

    return { render, clear, bindLinkage };
}
