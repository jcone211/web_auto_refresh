// ai.js —— AI 对话窗口主逻辑（ES module）：
// 页面驱动 function-calling 循环；background 只做无状态流式代理（见 ai_backend.js）。
// 职责：port 连接与重连、消息渲染、会话管理（多会话切换）、多份接口配置切换、
// 工具定义与执行（storage 读取与组合切换 / FSA 多目录文件 / 全量刷新）、
// 会话历史与长期记忆持久化（chrome.storage.local 的 aiChats / aiMemory）。

import { getDateTime } from '../shared/utils.js';
import {
    getWorkspaceHandles, pickPrimaryWorkspace, addWorkspaceDir, removeWorkspaceDir,
    workspacePermission, reauthorizeWorkspace, readyRoot,
    listDir, readFile, writeFile, appendFile, writeUpload
} from './fsa.js';

// 诊断日志开关：置 false 可停止逐次请求刷屏（warn/error 始终保留）
const DEBUG = true;
const dbg = (...args) => { if (DEBUG) console.log('[thswc:ai]', ...args); };

// ---------------- 常量 ----------------
const MAX_TOOL_ITERATIONS = 8;      // 单次提问最多工具往返轮数
const MAX_MESSAGES = 100;           // 单会话历史上限
const MAX_MESSAGE_CHARS = 10000;    // 单条消息存储截断
const MAX_MEMORY_ITEMS = 50;        // 长期记忆条目上限
const MAX_TOOL_RESULT_CHARS = 20000; // 单条工具结果截断
const REQUEST_TIMEOUT_MS = 120000;   // 页面侧兜底超时（SW 无声死亡时恢复 UI）
const CHAT_KEY = 'aiChats';
const MEMORY_KEY = 'aiMemory';
const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_AI_MODEL = 'deepseek-chat';

// ---------------- 模块状态 ----------------
let port = null;
let sessions = {};             // 全部会话 { [chatId]: { id, title, messages, createdAt, updatedAt } }
let currentChatId = null;      // 当前会话 id
let chatMessages = [];         // 当前会话消息（仅 user/assistant，不含 tool 过程）
let memoryItems = [];          // 长期记忆 [{ id, content, ts }]
let workspaceHandles = [];     // 已授权工作目录 [{ name, handle }]，主目录在首位
let providers = [];            // 接口配置 [{ id, name, baseUrl, apiKey, model }]
let activeProviderId = '';     // 当前生效的接口配置 id
let generating = false;
let currentRequestId = 0;
let lastRequestSnapshot = null; // 最近一次失败请求快照 { messages }（重试按钮用）
let pendingImages = []; // 粘贴待发送图片：[{ dataUrl, file, name }]

// ---------------- DOM 引用 ----------------
const messagesEl = document.getElementById('messagesEl');
const scrollDownBtn = document.getElementById('scrollDownBtn');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const uploadBtn = document.getElementById('uploadBtn');
const uploadInput = document.getElementById('uploadInput');
const pastePreviews = document.getElementById('pastePreviews');
const sessionSelect = document.getElementById('sessionSelect');
const newSessionBtn = document.getElementById('newSessionBtn');
const renameSessionBtn = document.getElementById('renameSessionBtn');
const deleteSessionBtn = document.getElementById('deleteSessionBtn');
const clearChatBtn = document.getElementById('clearChatBtn');
const openAiSettingsBtn = document.getElementById('openAiSettingsBtn');
const dirStatusBar = document.getElementById('dirStatusBar');
const aiSettingsOverlay = document.getElementById('aiSettingsOverlay');
const closeAiSettingsBtn = document.getElementById('closeAiSettingsBtn');
const aiProviderSelect = document.getElementById('aiProviderSelect');
const aiProviderAddBtn = document.getElementById('aiProviderAddBtn');
const aiProviderDelBtn = document.getElementById('aiProviderDelBtn');
const aiProviderNameInput = document.getElementById('aiProviderName');
const aiBaseUrlInput = document.getElementById('aiBaseUrl');
const aiApiKeyInput = document.getElementById('aiApiKey');
const aiModelInput = document.getElementById('aiModel');

// ---------------- 工具 ----------------
const storageGet = (area, keys) => new Promise(resolve => area.get(keys, resolve));
const storageSet = (area, obj) => new Promise(resolve => area.set(obj, resolve));

// 工具定义（OpenAI function schema，全部在页面本地执行）
const TOOL_DEFS = [
    { type: 'function', function: { name: 'get_stock_list', description: '读取股票列表：不传 portfolio 读当前活动组合；传组合名读指定组合（组合名可用 get_portfolios 查询）', parameters: { type: 'object', properties: { portfolio: { type: 'string', description: '组合名，如「持仓」「观察」；缺省为当前活动组合' } }, required: [] } } },
    { type: 'function', function: { name: 'get_portfolios', description: '读取全部持仓组合结构（各组合名称与股票数量）及当前活动组合', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'switch_portfolio', description: '切换当前活动组合（影响插件弹窗显示与定时监控范围），先校验组合是否存在', parameters: { type: 'object', properties: { name: { type: 'string', description: '目标组合名' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'get_key_points', description: '读取交易要点列表（要点内容与权重）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_events', description: '读取事件记录列表（关联要点/内容/日期/状态）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_current_view', description: '读取当前列表视图（股票列表或垃圾池）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_settings', description: '读取扩展全局设置（刷新间隔/选择器/分页/cron 定时任务，不含任何密钥）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'save_memory', description: '保存一条长期记忆（用户偏好/习惯等），之后每轮对话都会注入；同时镜像到主工作目录 memory.md', parameters: { type: 'object', properties: { content: { type: 'string', description: '要记住的内容' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'refresh_all', description: '触发扩展全量刷新全部组合股票（按全局设置的数据获取方式执行）', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'list_workspaces', description: '列出已授权的全部工作目录（主目录与附加目录）及其权限状态', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'list_dir', description: '列出工作目录（或子目录）内容。root 缺省为主目录，可传附加目录名；软链接条目无法访问（浏览器安全限制）', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对所选目录的路径，空为根目录' }, root: { type: 'string', description: '工作目录名，可用 list_workspaces 查询；缺省为主目录' } }, required: [] } } },
    { type: 'function', function: { name: 'read_file', description: '读取工作目录中的文本文件（默认截断 20000 字符）', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对所选目录的文件路径' }, root: { type: 'string', description: '工作目录名，缺省为主目录' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'write_file', description: '覆盖写工作目录中的文本文件（不存在则创建，含中间目录）', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对所选目录的文件路径' }, content: { type: 'string', description: '文件内容' }, root: { type: 'string', description: '工作目录名，缺省为主目录' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'append_file', description: '向工作目录中的文本文件追加内容（不存在则创建）', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对所选目录的文件路径' }, content: { type: 'string', description: '要追加的内容' }, root: { type: 'string', description: '工作目录名，缺省为主目录' } }, required: ['path', 'content'] } } },
];

// 股票条目精简视图（列表与组合通用）
function pickStockView(s) {
    return {
        name: s.name || '(待抓取)',
        code: s.prefix ? s.prefix + ':' + s.code : (s.code || ''),
        importPrice: s.importPrice ?? null,
        startPrice: s.startPrice ?? null,
        currentPrice: s.currentPrice ?? null,
        percent: s.percent ?? null,
        inTrash: !!s.inTrash,
        stopRunning: !!s.stopRunning,
        lastUpdateAt: s.lastUpdateAt ?? null,
    };
}

// 工具执行器：name -> async (args) => 结果（字符串或对象，统一 JSON.stringify 回传模型）
const toolExecutors = {
    async get_stock_list(args) {
        const portfolio = args && args.portfolio ? String(args.portfolio).trim() : '';
        if (!portfolio) {
            const { stockList } = await storageGet(chrome.storage.local, 'stockList');
            return summarizeList(stockList || [], pickStockView);
        }
        const { portfolios } = await storageGet(chrome.storage.local, 'portfolios');
        const p = (portfolios || {})[portfolio];
        if (!p) {
            return { error: `组合「${portfolio}」不存在`, available: Object.keys(portfolios || {}) };
        }
        return summarizeList(p.stockList || [], pickStockView);
    },
    async get_portfolios() {
        const { portfolios, activePortfolio } = await storageGet(chrome.storage.local, ['portfolios', 'activePortfolio']);
        const names = Object.keys(portfolios || {});
        const structure = names.map(name => ({
            name,
            stockCount: (portfolios[name].stockList || []).length,
            selectorName: portfolios[name].selectorName || 'wc1',
        }));
        return { activePortfolio: activePortfolio || '', structure };
    },
    async switch_portfolio(args) {
        const name = String(args.name || '').trim();
        if (!name) return { error: '缺少组合名' };
        const { portfolios } = await storageGet(chrome.storage.local, ['portfolios']);
        const p = (portfolios || {})[name];
        if (!p) {
            return { error: `组合「${name}」不存在`, available: Object.keys(portfolios || {}) };
        }
        // 与 popup switchPortfolio 同款状态写入：活动组合 + 列表镜像 + 选择器
        const stockList = p.stockList || [];
        const selectorName = p.selectorName || 'wc1';
        await storageSet(chrome.storage.local, { activePortfolio: name, stockList });
        await storageSet(chrome.storage.sync, { selectorName });
        // 监控运行中则立即按新组合重排刷新任务（popup 开着时经 onChanged 同步 UI）
        chrome.runtime.sendMessage({ action: 'refresh' });
        return { ok: true, activePortfolio: name, stockCount: stockList.length };
    },
    async get_key_points() {
        const { keyPoints } = await storageGet(chrome.storage.local, 'keyPoints');
        return (keyPoints || []).map(kp => ({ text: kp.text, weight: kp.weight }));
    },
    async get_events() {
        const { events } = await storageGet(chrome.storage.local, 'events');
        return summarizeList(events || [], e => ({
            keyPointText: e.keyPointText || '',
            content: e.content,
            time: e.time,
            status: e.status,
            archived: !!e.archived,
        }));
    },
    async get_current_view() {
        const { currentView } = await storageGet(chrome.storage.local, 'currentView');
        return { currentView: currentView || 'list' };
    },
    async get_settings() {
        // 白名单键读取：天然排除 apiKey 等敏感键，双保险
        const res = await storageGet(chrome.storage.sync, ['refreshInterval', 'selectorName', 'pageSize', 'cronJobs']);
        return {
            refreshInterval: res.refreshInterval ?? null,
            selectorName: res.selectorName ?? null,
            pageSize: res.pageSize ?? null,
            cronJobs: res.cronJobs || [],
        };
    },
    async save_memory(args) {
        return addMemory(String(args.content || '').trim());
    },
    async refresh_all() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'refreshAll' }, (resp) => {
                if (chrome.runtime.lastError || !resp) {
                    resolve({ ok: false, error: '后台无响应' });
                } else {
                    resolve({ ok: true, refreshedCount: resp.count });
                }
            });
        });
    },
    async list_workspaces() {
        const dirs = [];
        for (let i = 0; i < workspaceHandles.length; i++) {
            const d = workspaceHandles[i];
            dirs.push({ name: d.name, isPrimary: i === 0, permission: await workspacePermission(d.handle) });
        }
        return { workspaces: dirs, hint: 'root 参数用目录名寻址；软链接不可访问，可把软链接指向的真实目录「添加目录」为附加根' };
    },
    async list_dir(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        return listDir(dir.handle, args && args.path || '');
    },
    async read_file(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        const r = await readFile(dir.handle, args.path);
        return {
            root: dir.name,
            path: r.path,
            size: r.size,
            truncated: r.truncated,
            content: r.truncated ? r.content + '\n（已截断，可让 AI 分段读取）' : r.content,
        };
    },
    async write_file(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        return writeFile(dir.handle, args.path, args.content);
    },
    async append_file(args) {
        const dir = await readyRoot(workspaceHandles, args && args.root);
        return appendFile(dir.handle, args.path, args.content);
    },
};

// 列表结果精简 + 截断（附 total，模型可知还有更多）
function summarizeList(list, pick, limit = 50) {
    const items = (list || []).slice(0, limit).map(pick);
    return { total: (list || []).length, shown: items.length, items };
}

// ---------------- 长期记忆 ----------------
async function loadMemory() {
    const res = await storageGet(chrome.storage.local, MEMORY_KEY);
    memoryItems = (res[MEMORY_KEY] && Array.isArray(res[MEMORY_KEY].items)) ? res[MEMORY_KEY].items : [];
}

async function saveMemoryItems() {
    await storageSet(chrome.storage.local, { [MEMORY_KEY]: { items: memoryItems, updatedAt: Date.now() } });
}

// 追加记忆：裁剪到上限；主目录已授权时镜像 workspace/memory.md（镜像失败静默，不中断对话）
async function addMemory(content) {
    if (!content) return { ok: false, error: '记忆内容不能为空' };
    memoryItems.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), content: content.slice(0, 1000), ts: Date.now() });
    if (memoryItems.length > MAX_MEMORY_ITEMS) memoryItems = memoryItems.slice(-MAX_MEMORY_ITEMS);
    await saveMemoryItems();
    let mirrored = false;
    try {
        const dir = await readyRoot(workspaceHandles, ''); // 仅主目录
        const md = memoryItems.map(m => '- ' + m.content).join('\n');
        await writeFile(dir.handle, 'memory.md', md);
        mirrored = true;
    } catch { /* 未授权或写失败：静默 */ }
    return { ok: true, mirrored };
}

// 系统提示词：每轮组装，记忆新写入后下一轮立即生效
function buildSystemPrompt() {
    const lines = [
        '你是「同花顺问财」Chrome 扩展的 AI 助手。可用工具：查看/切换持仓组合、读取股票行情、要点、事件、设置；读写用户授权的工作目录文件（主目录 + 附加目录，root 参数用目录名寻址；软链接不可访问，需授权真实目录为附加根），若设置了项目主目录，可尝试访问CLAUDE.md、.claude文件夹、.claude/skills等文件；通过 save_memory 记住用户偏好。回答使用中文。',
    ];
    if (memoryItems.length > 0) {
        lines.push('', '[长期记忆]：');
        for (const m of memoryItems) lines.push('- ' + m.content);
    }
    lines.push('', '[当前时间]：' + getDateTime());
    return { role: 'system', content: lines.join('\n') };
}

// ---------------- 会话管理（多会话） ----------------
async function loadSessions() {
    const res = await storageGet(chrome.storage.local, CHAT_KEY);
    sessions = res[CHAT_KEY] || {};
}

// 排序后的会话 id 列表（最近更新在前）
function sortedSessionIds() {
    return Object.keys(sessions).sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));
}

function renderSessionSelect() {
    sessionSelect.innerHTML = '';
    for (const id of sortedSessionIds()) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = sessions[id].title || '未命名会话';
        sessionSelect.appendChild(opt);
    }
    sessionSelect.value = currentChatId;
}

// 初始化会话：有历史则恢复最近会话，否则新建一个空会话
async function ensureChat() {
    if (currentChatId) return;
    await loadSessions();
    const ids = sortedSessionIds();
    if (ids.length > 0) {
        currentChatId = ids[0];
    } else {
        currentChatId = newChatId();
        sessions[currentChatId] = { id: currentChatId, title: '新会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
        await persistSessions();
    }
    chatMessages = sessions[currentChatId].messages || [];
}

function newChatId() {
    return 'chat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function trimChat() {
    if (chatMessages.length > MAX_MESSAGES) chatMessages = chatMessages.slice(-MAX_MESSAGES);
    for (const m of chatMessages) {
        if (typeof m.content === 'string' && m.content.length > MAX_MESSAGE_CHARS) {
            m.content = m.content.slice(0, MAX_MESSAGE_CHARS);
        }
    }
}

function persistSessions() {
    return storageSet(chrome.storage.local, { [CHAT_KEY]: sessions });
}

// 保存当前会话：标题自动填充（首条用户消息前 20 字；手动改名后不再覆盖）
function saveChat() {
    if (!currentChatId || !sessions[currentChatId]) return Promise.resolve();
    const session = sessions[currentChatId];
    session.messages = chatMessages;
    session.updatedAt = Date.now();
    if (!session.title || session.title === '新会话') {
        session.title = (chatMessages.find(m => m.role === 'user')?.content || '新会话').slice(0, 20);
    }
    return persistSessions().then(renderSessionSelect);
}

// 切换到指定会话
async function switchSession(id) {
    if (!sessions[id] || id === currentChatId) return;
    await saveChat(); // 落当前会话（含 renderSessionSelect）
    currentChatId = id;
    chatMessages = sessions[id].messages || [];
    pendingImages = [];
    renderPastePreviews();
    renderHistory();
    renderSessionSelect();
    chatInput.focus();
}

// 新建会话（命名可选）
async function createSession() {
    const name = prompt('新会话名称（可留空，默认「新会话」）：', '');
    if (name === null) return;
    const title = name.trim() || '新会话';
    const id = newChatId();
    sessions[id] = { id, title, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    await persistSessions();
    await switchSession(id);
}

// 重命名当前会话
async function renameSession() {
    const session = sessions[currentChatId];
    if (!session) return;
    const name = prompt('会话名称：', session.title || '');
    if (name === null || !name.trim()) return;
    session.title = name.trim().slice(0, 30);
    await persistSessions();
    renderSessionSelect();
}

// 删除当前会话（至少保留一个：删空后新建）
async function deleteSession() {
    const session = sessions[currentChatId];
    if (!session) return;
    if (!confirm(`删除会话「${session.title || '未命名会话'}」？消息内容将一并删除`)) return;
    delete sessions[currentChatId];
    currentChatId = null;
    const ids = sortedSessionIds();
    if (ids.length === 0) {
        const id = newChatId();
        sessions[id] = { id, title: '新会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    }
    await persistSessions();
    currentChatId = sortedSessionIds()[0];
    chatMessages = sessions[currentChatId].messages || [];
    renderHistory();
    renderSessionSelect();
}

// 清空当前会话消息（长期记忆不受影响）
async function clearSession() {
    if (!confirm('清空当前会话的全部消息？长期记忆不受影响')) return;
    chatMessages = [];
    messagesEl.innerHTML = '';
    pendingImages = [];
    renderPastePreviews();
    followStream = true;
    scrollDownBtn.hidden = true;
    await saveChat();
}

// ---------------- 接口配置（多份，手动切换） ----------------
function defaultProvider(name) {
    return { id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: name || '默认', baseUrl: DEFAULT_AI_BASE_URL, apiKey: '', model: DEFAULT_AI_MODEL };
}

// 读取配置：兼容旧版单配置键（aiBaseUrl/aiApiKey/aiModel）迁移
async function loadProviders() {
    const res = await storageGet(chrome.storage.sync, ['aiProviders', 'aiActiveProviderId', 'aiBaseUrl', 'aiApiKey', 'aiModel']);
    if (Array.isArray(res.aiProviders) && res.aiProviders.length > 0) {
        providers = res.aiProviders;
        activeProviderId = providers.some(p => p.id === res.aiActiveProviderId) ? res.aiActiveProviderId : providers[0].id;
    } else if (res.aiBaseUrl || res.aiApiKey || res.aiModel) {
        // 旧版单配置迁移为第一份配置
        providers = [{ id: 'p_default', name: '默认', baseUrl: res.aiBaseUrl || DEFAULT_AI_BASE_URL, apiKey: res.aiApiKey || '', model: res.aiModel || DEFAULT_AI_MODEL }];
        activeProviderId = 'p_default';
        await storageSet(chrome.storage.sync, { aiProviders: providers, aiActiveProviderId: activeProviderId });
    } else {
        providers = [defaultProvider('默认')];
        activeProviderId = providers[0].id;
        await storageSet(chrome.storage.sync, { aiProviders: providers, aiActiveProviderId: activeProviderId });
    }
}

// 当前生效配置（请求随带）
function activeProvider() {
    return providers.find(p => p.id === activeProviderId) || providers[0] || defaultProvider();
}

async function persistProviders() {
    await storageSet(chrome.storage.sync, { aiProviders: providers, aiActiveProviderId: activeProviderId });
}

function renderProviderSelect() {
    aiProviderSelect.innerHTML = '';
    for (const p of providers) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || '未命名';
        aiProviderSelect.appendChild(opt);
    }
    aiProviderSelect.value = activeProviderId;
}

function fillProviderInputs() {
    const p = activeProvider();
    if (!p) return;
    aiProviderNameInput.value = p.name || '';
    aiBaseUrlInput.value = p.baseUrl || '';
    aiApiKeyInput.value = p.apiKey || '';
    aiModelInput.value = p.model || '';
}

// 设置弹窗：切换配置（下拉）= 切换激活；字段修改 = 更新当前配置
function openSettings() {
    renderProviderSelect();
    fillProviderInputs();
    aiSettingsOverlay.style.display = 'flex';
}

function closeSettings() {
    aiSettingsOverlay.style.display = 'none';
}

function bindProviderEvents() {
    // 下拉切换：切换激活配置并回填
    aiProviderSelect.addEventListener('change', async () => {
        activeProviderId = aiProviderSelect.value;
        await persistProviders();
        fillProviderInputs();
    });
    // 新增配置
    aiProviderAddBtn.addEventListener('click', async () => {
        const name = prompt('新配置名称（如 DeepSeek / OpenAI / 本地）：', '配置' + (providers.length + 1));
        if (name === null) return;
        const p = defaultProvider(name.trim() || '配置' + (providers.length + 1));
        providers.push(p);
        activeProviderId = p.id;
        await persistProviders();
        renderProviderSelect();
        fillProviderInputs();
    });
    // 删除当前配置（至少保留一份）
    aiProviderDelBtn.addEventListener('click', async () => {
        if (providers.length <= 1) { alert('至少保留一份接口配置'); return; }
        const p = activeProvider();
        if (!confirm(`删除配置「${p.name}」？`)) return;
        providers = providers.filter(x => x.id !== p.id);
        if (activeProviderId === p.id) activeProviderId = providers[0].id;
        await persistProviders();
        renderProviderSelect();
        fillProviderInputs();
    });
    // 字段修改：更新当前配置
    const bindInput = (input, key) => input.addEventListener('change', async () => {
        const p = activeProvider();
        if (!p) return;
        p[key] = input.value.trim();
        await persistProviders();
        if (key === 'name') renderProviderSelect();
    });
    bindInput(aiProviderNameInput, 'name');
    bindInput(aiBaseUrlInput, 'baseUrl');
    bindInput(aiApiKeyInput, 'apiKey');
    bindInput(aiModelInput, 'model');
}

// ---------------- port 连接 ----------------
// 与 popup 同款重连模式：SW 回收/重启断开后自动重连
function connectPort() {
    try {
        port = chrome.runtime.connect({ name: 'ai-chat-connection' });
    } catch {
        return; // 扩展上下文失效（重载扩展）时停止重连
    }
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
}

const pending = new Map(); // requestId -> { timeoutId, onChunk, resolve }

function handlePortMessage(message) {
    const p = pending.get(message.requestId);
    if (!p) return;
    if (message.type === 'AI_CHAT_CHUNK') {
        p.onChunk(message.delta);
    } else if (message.type === 'AI_CHAT_DONE') {
        pending.delete(message.requestId);
        clearTimeout(p.timeoutId);
        p.resolve({ ok: true, finish_reason: message.finish_reason, tool_calls: message.tool_calls || [] });
    } else if (message.type === 'AI_CHAT_ERROR') {
        pending.delete(message.requestId);
        clearTimeout(p.timeoutId);
        p.resolve({ ok: false, error: message.message, retriable: !!message.retriable });
    } else if (message.type === 'AI_CHAT_ABORTED') {
        pending.delete(message.requestId);
        clearTimeout(p.timeoutId);
        p.resolve({ ok: false, aborted: true });
    }
}

// 单轮流式往返：当前配置随请求携带（SW 无状态）
function sendRound(apiMessages, tools, { stream = true } = {}) {
    return new Promise((resolve) => {
        const requestId = ++currentRequestId;
        const provider = activeProvider();
        let content = '';
        const timeoutId = setTimeout(() => {
            // 页面侧兜底超时：SW 无声死亡时也能恢复 UI
            pending.delete(requestId);
            resolve({ ok: false, error: '请求超时（120s），请重试', retriable: true, content });
        }, REQUEST_TIMEOUT_MS);
        pending.set(requestId, {
            timeoutId,
            onChunk: (delta) => { content += delta; appendToCurrentAssistant(delta); },
            resolve: (r) => resolve({ ...r, content }),
        });
        try {
            port.postMessage({
                action: 'aiChatStream',
                requestId,
                messages: apiMessages,
                tools,
                stream,
                baseUrl: provider.baseUrl,
                apiKey: provider.apiKey,
                model: provider.model,
            });
        } catch {
            pending.delete(requestId);
            clearTimeout(timeoutId);
            resolve({ ok: false, error: '与后台连接已断开，请稍后重试', retriable: true, content: '' });
        }
    });
}

// ---------------- function-calling 循环 ----------------
// initialMessages：可选，指定起始 apiMessages（重试用快照）；默认从会话历史构建
async function runAgentLoop(initialMessages) {
    const apiMessages = initialMessages || chatMessages.map(m => ({ role: m.role, content: m.content }));
    for (let round = 0; round < MAX_TOOL_ITERATIONS; round++) {
        currentAssistantEl = null; // 每轮新建气泡（工具往返后流式内容不能追加到上一轮气泡）
        const requestMessages = [buildSystemPrompt(), ...apiMessages];
        let result = await sendRound(requestMessages, TOOL_DEFS, { stream: true });
        if (!result.ok) {
            if (result.aborted) {
                // 用户主动停止：保留已生成的部分文本
                appendMessage('system', '已停止');
                commitAssistant(result.content);
                return;
            }
            if (result.retriable) {
                // 流式失败自动降级一次非流式
                appendMessage('system', '流式响应中断，改用非流式重试…');
                result = await sendRound(requestMessages, TOOL_DEFS, { stream: false });
            }
            if (!result.ok) {
                appendMessage('error', result.error || '请求失败');
                lastRequestSnapshot = { messages: requestMessages };
                appendActionButton('重试', retryLast);
                commitAssistant(result.content);
                return;
            }
        }
        if (result.tool_calls && result.tool_calls.length > 0) {
            // 工具往返：assistant(tool_calls) + tool 结果按序追加，进入下一轮
            apiMessages.push({
                role: 'assistant',
                content: result.content || '',
                tool_calls: result.tool_calls.map(tc => ({
                    id: tc.id, type: 'function',
                    function: { name: tc.name, arguments: tc.arguments || '{}' },
                })),
            });
            apiMessages.push(...await executeToolCalls(result.tool_calls));
            continue;
        }
        // 无工具调用：最终回复落库（commitAssistant 仅供停止/失败路径使用，此处直接入列）
        chatMessages.push({ role: 'assistant', content: result.content, ts: Date.now() });
        trimChat();
        saveChat();
        if (result.finish_reason === 'length') {
            appendActionButton('继续生成', continueGeneration);
        }
        return;
    }
    // 超过最大工具轮数：当前内容作为最终回复（避免无限循环）
    appendMessage('system', '工具调用轮数已达上限，已结束本轮');
}

// 把已渲染的部分内容写入会话历史（停止/失败路径）
function commitAssistant(content) {
    if (!content) return;
    chatMessages.push({ role: 'assistant', content, ts: Date.now() });
    trimChat();
    saveChat();
}

// 执行一批工具调用（页面本地），返回 OpenAI 规范的 tool 消息数组；渲染折叠条目
async function executeToolCalls(toolCalls) {
    const toolMessages = [];
    for (const call of toolCalls) {
        let args = {};
        try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = {}; }
        let result;
        const exec = toolExecutors[call.name];
        if (!exec) {
            result = '未知工具 ' + call.name;
        } else {
            try {
                result = await exec(args);
            } catch (err) {
                result = '工具执行失败：' + err.message;
            }
        }
        let resultText = typeof result === 'string' ? result : JSON.stringify(result);
        if (resultText.length > MAX_TOOL_RESULT_CHARS) {
            resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS) + '\n（已截断）';
        }
        renderToolEntry(call.name, call.arguments || '{}', resultText);
        toolMessages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
    return toolMessages;
}

// ---------------- 渲染 ----------------
// 滚动跟随策略：默认在底部时随生成自动跳底（followStream=true）；用户上滚阅读即停止
// 跟随，不再强制跳底打扰阅读；点「滚动到底部」按钮或滚回底部后恢复跟随。
let followStream = true;

function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

// 按当前跟随状态决定是否滚动（append 类统一走这里，避免生成中强跳）
function maybeScroll() {
    if (followStream) scrollToBottom();
}

function updateScrollBtn() {
    scrollDownBtn.hidden = isNearBottom();
}

messagesEl.addEventListener('scroll', () => {
    const nearBottom = isNearBottom();
    followStream = nearBottom;
    scrollDownBtn.hidden = nearBottom;
});

scrollDownBtn.addEventListener('click', () => {
    scrollToBottom();
    followStream = true;
    scrollDownBtn.hidden = true;
});

// 消息一律 textContent 渲染（防 XSS）；content 可为多模态数组
// [{type:'text',text} , {type:'image_url',image_url:{url}}]，图片渲染为缩略图
function appendMessage(role, content) {
    const el = document.createElement('div');
    el.className = 'msg msg-' + role;
    if (Array.isArray(content)) {
        for (const part of content) {
            if (!part) continue;
            if (typeof part === 'string' || part.type === 'text') {
                const span = document.createElement('span');
                span.textContent = (typeof part === 'string' ? part : part.text) || '';
                el.appendChild(span);
            } else if (part.type === 'image_url') {
                const url = part.image_url && part.image_url.url;
                if (url) {
                    const img = document.createElement('img');
                    img.className = 'msg-img';
                    img.src = url; // 仅本地上传生成的 data URL，无外部注入
                    el.appendChild(img);
                }
            }
        }
    } else {
        el.textContent = content ?? '';
    }
    messagesEl.appendChild(el);
    maybeScroll();
    return el;
}

let currentAssistantEl = null;

function beginAssistant() {
    currentAssistantEl = appendMessage('assistant', '');
}

function appendToCurrentAssistant(delta) {
    if (!currentAssistantEl) beginAssistant();
    currentAssistantEl.textContent += delta;
    maybeScroll();
}

// 工具调用折叠条目：头部（名称 + 参数摘要）可点击展开 JSON 结果
function renderToolEntry(name, argsJson, resultText) {
    const el = document.createElement('div');
    el.className = 'msg msg-tool';
    const head = document.createElement('div');
    head.className = 'tool-head';
    const caret = document.createElement('span');
    caret.className = 'tool-caret';
    caret.textContent = '▸';
    const label = document.createElement('span');
    label.textContent = '工具调用 ' + name + (argsJson && argsJson !== '{}' ? ' ' + argsJson.slice(0, 80) : '');
    head.append(caret, label);
    const result = document.createElement('div');
    result.className = 'tool-result';
    result.textContent = resultText;
    head.addEventListener('click', () => {
        el.classList.toggle('expanded');
    });
    el.append(head, result);
    messagesEl.appendChild(el);
    maybeScroll();
    return el;
}

// 消息流末尾的操作按钮（重试 / 继续生成）
function appendActionButton(label, onClick) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    wrap.appendChild(btn);
    messagesEl.appendChild(wrap);
    maybeScroll();
    return btn;
}

function renderHistory() {
    messagesEl.innerHTML = '';
    for (const m of chatMessages) {
        appendMessage(m.role === 'user' ? 'user' : 'assistant', m.content || '');
    }
    // 切换会话后重置跟随状态与悬浮按钮
    followStream = true;
    scrollDownBtn.hidden = true;
}

// ---------------- 工作目录状态条（多根目录） ----------------
function textSpan(text) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
}

function dirActionBtn(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await onClick(); } finally { btn.disabled = false; }
    });
    return btn;
}

// 重新加载目录列表并按权限状态渲染（每个目录独立展示授权按钮）
async function refreshDirStatus() {
    workspaceHandles = await getWorkspaceHandles();
    renderUploadState(); // 目录授权状态变化同步上传按钮可用性
    dirStatusBar.innerHTML = ''; // 元素全部自建，无注入风险
    if (workspaceHandles.length === 0) {
        dirStatusBar.append(textSpan('工作目录未授权 — 授权后可读写本地文件；软链接不可访问，可把真实目录添加为附加根'));
        dirStatusBar.append(dirActionBtn('选择目录', async () => {
            try {
                await pickPrimaryWorkspace();
            } catch (err) {
                if (err && err.name === 'AbortError') return; // 用户取消选择
                dirStatusBar.append(textSpan('选择失败：' + (err.message || err)));
                return;
            }
            await refreshDirStatus();
        }));
        dirStatusBar.append(dirActionBtn('＋添加', async () => {
            try {
                await addWorkspaceDir();
            } catch (err) {
                if (err && err.name === 'AbortError') return;
                dirStatusBar.append(textSpan('添加失败：' + (err.message || err)));
                return;
            }
            await refreshDirStatus();
        }));
        return;
    }
    dirStatusBar.append(textSpan('目录：'));
    // 主目录 + 附加目录逐个渲染
    for (let i = 0; i < workspaceHandles.length; i++) {
        const d = workspaceHandles[i];
        const perm = await workspacePermission(d.handle);
        const chip = document.createElement('span');
        chip.className = 'dir-chip';
        const name = document.createElement('span');
        name.className = 'dir-name';
        name.textContent = (i === 0 ? '主·' : '') + d.name;
        name.title = d.name;
        chip.appendChild(name);
        if (perm === 'prompt') {
            chip.appendChild(dirActionBtn('重新授权', async () => {
                try {
                    await reauthorizeWorkspace(d.handle);
                } catch (err) {
                    console.warn('[thswc:ai] 重新授权失败:', err);
                }
                await refreshDirStatus();
            }));
        }
        if (i > 0) {
            const remove = document.createElement('span');
            remove.className = 'chip-remove';
            remove.textContent = '×';
            remove.title = '移除该附加目录';
            remove.addEventListener('click', async () => {
                try {
                    await removeWorkspaceDir(d.name);
                } catch (err) {
                    alert(err.message);
                }
                await refreshDirStatus();
            });
            chip.appendChild(remove);
        }
        dirStatusBar.append(chip);
    }
    // 全局操作
    dirStatusBar.append(dirActionBtn('更换主目录', async () => {
        try {
            await pickPrimaryWorkspace();
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            console.warn('[thswc:ai] 更换主目录失败:', err);
        }
        await refreshDirStatus();
    }));
    dirStatusBar.append(dirActionBtn('＋添加', async () => {
        try {
            await addWorkspaceDir();
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            console.warn('[thswc:ai] 添加目录失败:', err);
        }
        await refreshDirStatus();
    }));
}

// ---------------- 文件上传（复制到主工作目录 + 加载到上下文） ----------------
// 上传按钮状态：未设置工作目录时置灰并提示
function renderUploadState() {
    const ok = workspaceHandles.length > 0;
    uploadBtn.disabled = !ok;
    uploadBtn.title = ok ? '上传文件到工作目录并加载到上下文' : '请先设置工作目录后再上传文件';
}

// 目标文件名防重名：已存在则追加 _1/_2…（保留扩展名）
async function uniqueUploadName(rootHandle, name) {
    let candidate = name;
    let i = 1;
    for (; ;) {
        try { await rootHandle.getFileHandle(candidate); } catch { return candidate; }
        const dot = name.lastIndexOf('.');
        candidate = (dot > 0 ? name.slice(0, dot) + '_' + i + name.slice(dot) : name + '_' + i);
        i++;
    }
}

// 上传处理：
//   图片（png/jpeg/gif/webp）→ 以多模态 image_url 消息传给模型（视觉输入，不落文本）；
//   其它文件 → 仅告知模型「文件已复制到工作目录」，内容由模型经 read_file 工具自行读取。
// 一律不把文件内容打印到对话，也不塞进上下文文本。
async function handleUploadFiles(files) {
    if (!files || files.length === 0) return;
    if (!workspaceHandles.length) { alert('请先设置工作目录：点击窗口顶部「选择目录」授权后即可上传文件'); return; }
    const dir = await readyRoot(workspaceHandles, ''); // 校验主目录权限 granted
    const imageTypes = /^image\/(png|jpe?g|gif|webp)$/i;
    const parts = []; // content 块（多模态数组）
    let imageCount = 0;
    for (const file of files) {
        const target = await uniqueUploadName(dir.handle, file.name);
        await writeUpload(dir.handle, target, file); // 复制到工作目录
        if (imageTypes.test(file.type || '')) {
            imageCount++;
            const dataUrl = await readFileAsDataURL(file);
            parts.push({ type: 'text', text: `[用户上传图片：${target}，已复制到工作目录]` });
            parts.push({ type: 'image_url', image_url: { url: dataUrl } });
        } else {
            parts.push({ type: 'text', text: `[用户上传文件：${target}，已复制到工作目录，可用 read_file 工具读取]` });
        }
        dbg('上传文件已写入工作目录:', target, file.size, '字节');
    }
    if (parts.length === 0) return;
    await ensureChat();
    chatMessages.push({ role: 'user', content: parts, ts: Date.now() });
    trimChat();
    saveChat();
    appendMessage('user', parts);
    appendMessage('system',
        files.length + ' 个文件已复制到工作目录'
        + (imageCount ? `，其中 ${imageCount} 张图片已作为视觉输入传给模型` : '，文件内容未打印，可让 AI 用 read_file 读取'));
}

// File → base64 data URL（图片多模态消息用）
function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// ---------------- 剪贴板图片粘贴（预览 → 可删 → 带文本发送） ----------------
// 粘贴图片类型 → 默认文件名扩展名
function extForMime(mime) {
    return { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '.png';
}

// 渲染待发送图片预览区（每张图带删除按钮）
function renderPastePreviews() {
    pastePreviews.innerHTML = '';
    if (pendingImages.length === 0) {
        pastePreviews.hidden = true;
        return;
    }
    pastePreviews.hidden = false;
    pendingImages.forEach((img, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'paste-preview';
        const pic = document.createElement('img');
        pic.src = img.dataUrl;
        pic.title = img.name;
        const del = document.createElement('span');
        del.className = 'paste-del';
        del.textContent = '×';
        del.title = '移除该图片';
        del.addEventListener('click', () => {
            pendingImages.splice(idx, 1);
            renderPastePreviews();
        });
        wrap.append(pic, del);
        pastePreviews.appendChild(wrap);
    });
}

// 粘贴事件：剪贴板含图片时读取为预览（阻止默认粘贴，与 GPT 官网行为一致）
function bindPastePreview() {
    chatInput.addEventListener('paste', (event) => {
        const items = event.clipboardData && event.clipboardData.items;
        if (!items) return;
        const images = [];
        for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) images.push(file);
            }
        }
        if (images.length === 0) return;
        event.preventDefault();
        images.forEach(async (file) => {
            const dataUrl = await readFileAsDataURL(file);
            pendingImages.push({
                dataUrl,
                file,
                name: file.name || ('paste_' + Date.now().toString(36) + extForMime(file.type)),
            });
            renderPastePreviews();
            chatInput.focus();
        });
    });
}

// ---------------- 发送 / 停止 / 重试 ----------------
function setGenerating(v) {
    generating = v;
    sendBtn.disabled = v;
    stopBtn.hidden = !v;
}

// 在用户手势内自动重授权：requestPermission 必须在用户手势（transient activation）中调用，
// 而工具执行发生在 LLM 往返之后、手势早已过期——因此在发送等手势时机前置触发弹框。
// 返回 true 表示本次有目录完成授权
async function reauthorizePendingInGesture() {
    let changed = false;
    for (const d of workspaceHandles) {
        let perm;
        try { perm = await workspacePermission(d.handle); } catch { continue; }
        if (perm !== 'prompt') continue;
        try {
            const result = await d.handle.requestPermission({ mode: 'readwrite' });
            if (result === 'granted') changed = true;
        } catch (err) {
            console.warn('[thswc:ai] 自动重授权失败:', d.name, err);
        }
    }
    if (changed) await refreshDirStatus();
    return changed;
}

async function handleSend() {
    const text = chatInput.value.trim();
    if (!text && pendingImages.length === 0) return;
    if (generating) return;
    // 用户手势内前置检查：有待授权目录（浏览器重启后常见）则直接弹授权框
    await reauthorizePendingInGesture();
    await ensureChat();
    followStream = true; // 发送后应能看到自己最新的消息
    scrollDownBtn.hidden = true;
    // 组装内容：文本 + 粘贴图片（多模态；图片已授权时顺带复制到工作目录）
    let content = text;
    let imageCount = 0;
    if (pendingImages.length > 0) {
        const parts = [];
        if (text) parts.push({ type: 'text', text });
        for (const img of pendingImages) {
            imageCount++;
            // 已授权工作目录时把粘贴图片也落盘（失败静默，仅视觉发送）
            try {
                if (workspaceHandles.length) {
                    const dir = await readyRoot(workspaceHandles, '');
                    const name = await uniqueUploadName(dir.handle, img.name || 'paste.png');
                    await writeUpload(dir.handle, name, img.file);
                }
            } catch (err) {
                console.warn('[thswc:ai] 粘贴图片写入工作目录失败:', err);
            }
            parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
        }
        content = parts;
    }
    appendMessage('user', content);
    chatMessages.push({ role: 'user', content, ts: Date.now() });
    trimChat();
    saveChat();
    chatInput.value = '';
    pendingImages = [];
    renderPastePreviews();
    currentAssistantEl = null;
    setGenerating(true);
    if (imageCount > 0) appendMessage('system', imageCount + ' 张图片已作为视觉输入传给模型');
    try {
        await runAgentLoop();
    } catch (err) {
        console.error('[thswc:ai] 循环异常:', err);
        appendMessage('error', '发生异常：' + err.message);
    } finally {
        setGenerating(false);
        chatInput.focus();
    }
}

function stopGeneration() {
    if (!generating) return;
    // 告知 background 中止在途请求；AI_CHAT_ABORTED 回来后保留已渲染内容
    try {
        port.postMessage({ action: 'aiChatStop', requestId: currentRequestId });
    } catch { /* 连接已断，background 会在断开时自行 abort */ }
}

async function retryLast() {
    if (generating || !lastRequestSnapshot) return;
    currentAssistantEl = null;
    setGenerating(true);
    try {
        // 快照含 system 第 0 条，去掉后作为起始 apiMessages 重发
        await runAgentLoop(lastRequestSnapshot.messages.slice(1).map(m => ({ role: m.role, content: m.content })));
    } catch (err) {
        appendMessage('error', '发生异常：' + err.message);
    } finally {
        setGenerating(false);
    }
}

async function continueGeneration() {
    if (generating) return;
    chatMessages.push({ role: 'user', content: '请继续', ts: Date.now() });
    trimChat();
    saveChat();
    appendMessage('user', '请继续');
    currentAssistantEl = null;
    setGenerating(true);
    try {
        await runAgentLoop();
    } catch (err) {
        appendMessage('error', '发生异常：' + err.message);
    } finally {
        setGenerating(false);
    }
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
    sendBtn.addEventListener('click', handleSend);
    chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSend();
        }
    });
    stopBtn.addEventListener('click', stopGeneration);
    // 会话管理
    sessionSelect.addEventListener('change', () => switchSession(sessionSelect.value));
    newSessionBtn.addEventListener('click', createSession);
    renameSessionBtn.addEventListener('click', renameSession);
    deleteSessionBtn.addEventListener('click', deleteSession);
    clearChatBtn.addEventListener('click', clearSession);
    // 文件上传
    uploadBtn.addEventListener('click', async () => {
        if (!workspaceHandles.length) {
            alert('请先设置工作目录：点击窗口顶部「选择目录」授权后即可上传文件');
            return;
        }
        await reauthorizePendingInGesture(); // 权限失效时手势内弹授权框
        const perm = await workspacePermission(workspaceHandles[0].handle);
        if (perm !== 'granted') { alert('工作目录权限未授予，无法上传'); return; }
        uploadInput.click();
    });
    uploadInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = ''; // 允许重复上传同一文件
        if (files.length) await handleUploadFiles(files);
    });
    // 剪贴板图片粘贴预览
    bindPastePreview();
    // 设置
    openAiSettingsBtn.addEventListener('click', openSettings);
    closeAiSettingsBtn.addEventListener('click', closeSettings);
    // 仅点击右上角 × 关闭：点遮罩不关闭（避免误触丢失正在编辑的配置）
    bindProviderEvents();
}

// ---------------- 初始化 ----------------
async function init() {
    connectPort();
    await loadProviders();
    // popup 全局设置改动时实时同步（两窗口同源）
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.aiProviders || changes.aiActiveProviderId) {
            loadProviders().then(() => {
                renderProviderSelect();
                fillProviderInputs();
            });
        }
    });
    await loadMemory();
    await ensureChat();
    renderHistory();
    renderSessionSelect();
    await refreshDirStatus();
    bindEvents();
    // 窗口加载后首个用户手势（任意点击，状态条按钮除外）即触发待授权目录的授权弹框；
    // 后续手势由 handleSend 前置检查兜底
    window.addEventListener('click', function autoReauthOnce(e) {
        if (!dirStatusBar.contains(e.target)) reauthorizePendingInGesture();
        window.removeEventListener('click', autoReauthOnce);
    });
    if (!activeProvider().apiKey) {
        appendMessage('system', '尚未配置 API Key：点击右上角「设置」填写后即可对话');
    }
    chatInput.focus();
}

init();
