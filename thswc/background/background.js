import { stripSign, effectiveStockUrl, isKnownMarketPrefix } from '../shared/utils.js';

// 诊断日志开关：排查完成后置 false 可停止周期性刷屏
const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.log('[thswc:bg]', ...args); };

// 后台服务worker，处理定时刷新逻辑
let refreshInterval = 30; // 默认30秒
let selectorName = '';
let currentView = 'list'; // 当前列表视图：'list' 股票列表 | 'trash' 垃圾池
let popupPort = null;

// 各股票一次性刷新 alarm 的名称前缀
const STOCK_ALARM_PREFIX = 'refreshStock:';

init();

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'popup-connection') {
        popupPort = port;
        port.onDisconnect.addListener(() => {
            popupPort = null;
        });
    }
});

// 监听标签页更新，动态注入脚本
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !isMonitoredUrl(tab.url)) return;

    chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
    }).catch(err => console.error('脚本执行失败:', err));
});

function isMonitoredUrl(url) {
    if (!url) return false;

    try {
        const { hostname } = new URL(url);
        return hostname === 'iwencai.com' || hostname.endsWith('.iwencai.com')
            || hostname === 'xueqiu.com' || hostname.endsWith('.xueqiu.com');
    } catch {
        return false;
    }
}



chrome.action.onClicked.addListener(() => {
    chrome.storage.local.get('popupWindowId', ({ popupWindowId }) => {
        if (popupWindowId !== null && popupWindowId !== undefined) {
            chrome.windows.remove(popupWindowId, () => {
                chrome.storage.local.set({ popupWindowId: null });
            });
        } else {
            // 分页后窗口高度按每页条数算，避免按全量股票列表撑高
            chrome.storage.local.get(['stockList', 'currentView'], (localData) => {
                chrome.storage.sync.get(['pageSize'], (syncData) => {
                    const view = localData.currentView || 'list';
                    const stockCount = (localData.stockList || []).filter(s => view === 'trash' ? s.inTrash : !s.inTrash).length;
                    const pageSize = syncData.pageSize || 10;
                    const rows = Math.min(stockCount, pageSize);
                    chrome.windows.getCurrent((currentWindow) => {
                        chrome.windows.create({
                            url: chrome.runtime.getURL('popup.html'),
                            type: 'popup',
                            width: 570,
                            height: 492 + Math.max(rows - 2, 0) * 56,
                            left: currentWindow.width - 400,
                            top: 50
                        }, (newWindow) => {
                            chrome.storage.local.set({ popupWindowId: newWindow.id });
                        });
                    });
                });
            });
        }
    })
});

// 监听窗口关闭：仅当关闭的是插件弹窗时停止监控
chrome.windows.onRemoved.addListener((closedWindowId) => {
    chrome.storage.local.get('popupWindowId', ({ popupWindowId }) => {
        if (closedWindowId !== popupWindowId) return;
        chrome.storage.local.set({ popupWindowId: null });
        chrome.alarms.clearAll();
    });
});

// 初始化：先做幂等迁移，再加载设置
function init() {
    ensureMigrated().then(() => {
        chrome.storage.sync.get(['refreshInterval', 'selectorName'], (result) => {
            if (result.refreshInterval) {
                refreshInterval = result.refreshInterval;
            }
            if (result.selectorName) {
                selectorName = result.selectorName;
            }
        });
    });
}

// 幂等迁移：确保 stockList 在 storage.local 且字段已补齐。
// background 是唯一迁移执行者，popup 只经 getStatus 读迁移后的数据。
function ensureMigrated() {
    if (ensureMigrated.promise) return ensureMigrated.promise;
    ensureMigrated.promise = new Promise((resolve) => {
        chrome.storage.local.get(['stockList', 'currentView', 'portfolios', 'activePortfolio'], (localResult) => {
            if (localResult.currentView) {
                currentView = localResult.currentView;
            }
            const finish = (list) => {
                const migratedList = migrateStockFields(list);
                // 组合迁移：若尚无 portfolios，则以当前列表 + 选择器建「默认」组合
                if ('portfolios' in localResult) {
                    chrome.storage.local.set({ stockList: migratedList }, resolve);
                } else {
                    chrome.storage.sync.get(['selectorName'], (syncSel) => {
                        const portfolios = { '默认': { stockList: migratedList, selectorName: syncSel.selectorName || '' } };
                        chrome.storage.local.set({ stockList: migratedList, portfolios, activePortfolio: '默认' }, resolve);
                    });
                }
            };
            if ('stockList' in localResult) {
                // 已迁移过，仅补齐老数据字段
                finish(migrateStockFields(localResult.stockList || []));
            } else {
                // 首次迁移：sync → local
                chrome.storage.sync.get(['stockList'], (syncResult) => {
                    if (syncResult.stockList) {
                        chrome.storage.sync.remove('stockList');
                    }
                    finish(migrateStockFields(syncResult.stockList || []));
                });
            }
        });
    });
    return ensureMigrated.promise;
}

// 老数据字段补齐（importPrice 不补，保持 null 由首次抓取回填）
function migrateStockFields(list) {
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        if (!('importTargetPercentLe' in item)) item.importTargetPercentLe = '';
        if (!('importTargetPercentGe' in item)) item.importTargetPercentGe = '';
        if (!('notifiedDaily' in item)) {
            item.notifiedDaily = item.notified ?? false;
            delete item.notified;
        }
        if (!('notifiedImport' in item)) item.notifiedImport = false;
        if (!('inTrash' in item)) item.inTrash = false;
        if (!('code' in item)) item.code = '';
        if (!('prefix' in item)) {
            item.prefix = '';
        } else if (item.prefix && !isKnownMarketPrefix(item.prefix)) {
            // 旧版正则曾把股票名里的字母（如京东方A 的 A）误存为前缀：
            // 清空后生效地址回退存储 URL，下次抓取自动回填正确前缀
            item.prefix = '';
        }
        if (!('createdAt' in item)) item.createdAt = null;
        if (!('pinned' in item)) item.pinned = false;
        if (!('pinOrder' in item)) item.pinOrder = null;
    }
    return list;
}

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startRefresh') {
        startRefresh(request.interval, request.selectorName);
        sendResponse({ status: 'started' });
    } else if (request.action === 'stopRefresh') {
        stopRefresh();
        sendResponse({ status: 'stopped' });
    } else if (request.action === 'getStatus') {
        // 等迁移完成后直接读 storage 响应，避免模块缓存滞后于 popup 的写入
        ensureMigrated().then(() => {
            chrome.storage.local.get(['stockList', 'portfolios', 'activePortfolio'], (localResult) => {
                chrome.storage.sync.get(['refreshInterval', 'selectorName', 'pageSize'], (syncResult) => {
                    sendResponse({
                        refreshInterval: syncResult.refreshInterval,
                        selectorName: syncResult.selectorName,
                        pageSize: syncResult.pageSize || 10,
                        currentView,
                        stockList: localResult.stockList || [],
                        portfolios: localResult.portfolios || {},
                        activePortfolio: localResult.activePortfolio || '默认'
                    });
                });
            });
        });
        return true; // 异步 sendResponse
    } else if (request.action === 'refresh') {
        init();
        // 选择器/列表可能已变更：运行中则立即按最新生效地址重排各股票 alarm
        chrome.alarms.get('refreshTimer', (alarm) => {
            if (!alarm) return;
            chrome.alarms.getAll((alarms) => {
                alarms.filter(a => a.name.startsWith(STOCK_ALARM_PREFIX))
                    .forEach(a => chrome.alarms.clear(a.name));
                scheduleStockAlarms();
            });
        });
    } else if (request.action === 'setView') {
        currentView = request.view === 'trash' ? 'trash' : 'list';
        chrome.storage.local.set({ currentView });
        // 只清各股票一次性 alarm（不能 clearAll，否则会误删周期性 refreshTimer）
        chrome.alarms.getAll((alarms) => {
            alarms.filter(a => a.name.startsWith(STOCK_ALARM_PREFIX))
                .forEach(a => chrome.alarms.clear(a.name));
            // 监控运行中则立即按新视图重排
            chrome.alarms.get('refreshTimer', (alarm) => {
                if (alarm) scheduleStockAlarms();
            });
        });
        sendResponse({ status: 'ok' });
    } else if (request.type === 'DOCUMENT_CAPTURED') {
        dbg('收到抓取, popupPort 已连接=' + !!popupPort, request.documentData.url);
        if (popupPort) {
            popupPort.postMessage(request);
        }
        sendResponse({ status: 'received', forwarded: !!popupPort });
    }
});

// 开始定时刷新
function startRefresh(interval, sn) {
    refreshInterval = interval;
    selectorName = sn;
    chrome.storage.sync.set({ refreshInterval, selectorName });
    // 创建定时器
    chrome.alarms.create('refreshTimer', {
        delayInMinutes: 0,
        periodInMinutes: refreshInterval / 60
    });
}

// 停止定时刷新
function stopRefresh() {
    // 同时清掉主定时器和已排队的各股票一次性 alarm
    chrome.alarms.clearAll();
}

// 定时器触发时刷新页面
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'refreshTimer') {
        scheduleStockAlarms();
    } else if (alarm.name.startsWith(STOCK_ALARM_PREFIX)) {
        const url = alarm.name.slice(STOCK_ALARM_PREFIX.length);
        // 直接从 storage 读最新列表/视图/选择器，避免 service worker 冷启动时状态缺失；
        // alarm 名里是生效地址（xq1 下可能是拼接的雪球链接），须按生效地址反查股票
        chrome.storage.local.get(['stockList', 'currentView'], ({ stockList, currentView: view }) => {
            chrome.storage.sync.get(['selectorName'], ({ selectorName }) => {
                const v = view || 'list';
                const stillActive = (stockList || []).some(item =>
                    effectiveStockUrl(item, selectorName) === url
                    && !item.stopRunning
                    && (v === 'trash' ? item.inTrash : !item.inTrash));
                if (!stillActive) return;
                refreshStockTab(url);
            });
        });
    }
});

// 为当前视图下的每只股票排一个一次性 alarm，随机延迟错开反风控；
// alarm 由浏览器进程托管，不随 service worker 回收而丢失，股票数量不受限
function scheduleStockAlarms() {
    chrome.storage.local.get(['stockList', 'currentView'], ({ stockList, currentView: view }) => {
        chrome.storage.sync.get(['selectorName'], ({ selectorName }) => {
            const v = view || 'list';
            // 刷新地址按选择器生效：xq1 下已知代码的股票改刷拼接的雪球链接
            const urls = (stockList || [])
                .filter(item => !item.stopRunning && (v === 'trash' ? item.inTrash : !item.inTrash))
                .map(item => effectiveStockUrl(item, selectorName));
            dbg('排程刷新:', v, '视图下共', urls.length, '只', urls);
            let delay = 0;
            urls.forEach(url => {
                delay += getRandomTime();
                chrome.alarms.create(STOCK_ALARM_PREFIX + url, { when: Date.now() + delay });
            });
        });
    });
}

// 刷新（或新打开）单只股票的标签页
function refreshStockTab(url) {
    // tabs.query 的 url 按 match pattern 匹配，query string 也参与比较：
    // 问财标签页地址携带 sign= 时间戳，按存储的无 sign URL 精确查询必然 0 命中，
    // 导致每个周期都误开新标签。故按同站 origin/* 粗查，再用剔 sign 的 URL 精确过滤。
    let query;
    try {
        query = { url: new URL(url).origin + '/*' };
    } catch {
        query = {};
    }
    chrome.tabs.query(query, (tabs) => {
        const target = tabs.find(t => stripSign(t.url) === stripSign(url));
        dbg('刷新匹配:', url, '| 同站标签', tabs.length, '个 →',
            target ? ('重载已有标签 ' + target.url) : '无匹配标签，新开');
        if (target) {
            chrome.tabs.reload(target.id);
        } else {
            chrome.tabs.create({ url: url, active: false }); // 后台打开，不抢焦点
        }
    });
}

// 延迟刷新反风控
function getRandomTime() {
    return Math.floor(Math.random() * (3500 - 1200) + 1200);
}
