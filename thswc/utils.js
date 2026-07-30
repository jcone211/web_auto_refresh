// 安全解码 URL（含非 ASCII 的百分号编码），失败回退原值
export function safeDecodeUrl(url) {
    if (!url) return '';
    try {
        return decodeURIComponent(url);
    } catch {
        return url;
    }
}

// 规范化 URL：new URL().href 自动百分号编码并统一格式，失败返回 null
export function normalizeUrl(raw) {
    if (!raw) return null;
    try {
        return new URL(raw).href;
    } catch {
        return null;
    }
}

// 计算导入以来涨跌幅(%)，任一价格缺失或基准价为 0 返回 null
export function calcImportPercent(currentPrice, importPrice) {
    const cur = numOrNull(currentPrice);
    const base = numOrNull(importPrice);
    if (cur === null || base === null || base === 0) return null;
    return Number(((cur - base) / base * 100).toFixed(2));
}

// 涨跌幅(%) → 目标价，基准价或涨跌幅无效返回 null
export function percentToTargetPrice(basePrice, percent) {
    const base = numOrNull(basePrice);
    const p = numOrNull(percent);
    if (base === null || p === null) return null;
    return Number((base * (1 + p / 100)).toFixed(2));
}

// 目标价 → 涨跌幅(%)，基准价缺失或为 0 返回 null
export function targetPriceToPercent(basePrice, targetPrice) {
    const base = numOrNull(basePrice);
    const price = numOrNull(targetPrice);
    if (base === null || base === 0 || price === null) return null;
    return Number(((price / base - 1) * 100).toFixed(2));
}

// 转数字，空值/NaN 返回 null
export function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

export function getDateTime() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

export class Mutex {
    constructor() {
        this.locked = false;
        this.waiting = [];
    }
    async lock() {
        if (!this.locked) {
            this.locked = true;
            return;
        }
        return new Promise(resolve => this.waiting.push(resolve));
    }
    unlock() {
        if (this.waiting.length > 0) {
            const resolve = this.waiting.shift();
            resolve();
        } else {
            this.locked = false;
        }
    }
}