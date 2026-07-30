# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

本仓库包含两个相互独立的 Chrome 扩展（Manifest V3），核心均为「定时刷新网页 + 内容变更监听」：

- `base/` —— 通用网页定时刷新器：定时刷新任意网页，可用 CSS 选择器监听页面内容变更并弹出系统通知。
- `thswc/` —— 同花顺问财（iwencai.com）股票监控：沿用 base 的数据流模式定制，解析股价/涨跌幅，达到设定阈值时通知。

两者互不依赖，各自有完整的 manifest/icons/popup，改动时不要跨目录引用。

## 开发方式

- 无构建系统、无 package.json、无测试、无 lint。全部为原生 JS（ES2020），popup.html 与 background 均以 ES module 加载（script 带 `type="module"`）。
- 根目录 `tsconfig.json` 仅供编辑器做 JS 类型提示，无 TS 源码、不参与构建。
- 开发流程：Chrome 打开 `chrome://extensions` → 开启开发者模式 →「加载已解压的扩展程序」→ 选择 `base/` 或 `thswc/` 目录。改代码后在扩展卡片上点刷新；popup 是独立窗口（`chrome.windows.create` 创建），需关闭后点击扩展图标重新打开。
- 刷新间隔下限 30 秒，由两个 popup.js 在 UI 层强制（`interval < 30` 时重置为 30）。

## 架构：共有的「抓取 → 转发 → 解析」管线

两个扩展遵循同一数据流，差异在注入方式和消息通道：

1. **content.js 抓取整页**：页面加载完成后把 `document.documentElement.outerHTML` 连同 title/url/timestamp 以 `{type: 'DOCUMENT_CAPTURED'}` 消息发给 background。
2. **background.js（service worker）调度**：用 `chrome.alarms` 按周期触发（主定时器名固定为 `refreshTimer`）。thswc 主定时器触发后为每只股票排一个一次性 alarm（名称前缀 `refreshStock:`，随机延迟反风控）；alarm 触发时对目标 URL `chrome.tabs.query` → 存在则 reload，不存在则 create。alarm 由浏览器进程托管，不随 service worker 回收丢失，因此调度不用 `setTimeout`。
3. **popup 解析与通知**：popup 用 `DOMParser` 解析收到的 HTML 字符串，按 CSS 选择器取 `textContent`，与旧值比较或做阈值判断后调用 `chrome.notifications.create` 提醒。

关键点：数据提取发生在 popup 端而非 content script——content.js 只负责搬运原始 HTML，所有选择器/解析逻辑都在 popup.js。popup 关闭期间数据不会被处理。

### base 与 thswc 的差异

| 方面 | base | thswc |
| --- | --- | --- |
| content script 注入 | manifest 静态声明 `<all_urls>` | manifest 中 `content_scripts` 为空，background 在 `tabs.onUpdated`（status=complete 且 hostname 为 iwencai.com）时用 `chrome.scripting.executeScript` 程序化注入 |
| 防重复注入 | 无 | content.js 顶层 `window.__thswcContentInjected` 标记 |
| popup 接收数据 | 直接 `chrome.runtime.onMessage` | background 经持久 port（`popup-connection`）转发，popup 只在 `port.onMessage` 一处处理（`DOCUMENT_CAPTURED` 的解析逻辑不要再用 `chrome.runtime.onMessage` 注册，会与 port 通道重复处理） |
| 持久化 | `chrome.storage.local` | `chrome.storage.sync` |
| 监控目标 | 单 URL | stockList 多只股票，每只一个标签页 |
| 反风控 | 无 | 多标签 reload 之间加随机延迟（`getRandomTime`） |

### thswc 特有细节

- popup.js 通过 `import` 使用 `utils.js`（`getDateTime`、`Mutex`）；`Mutex` 用于串行化并发的 `DOCUMENT_CAPTURED` 处理，新增异步解析逻辑时须包在 lock/unlock 内。
- 选择器表 `selectorsEnum`：目前只有 `wc1` 一组（对应 iwencai 结果页的名称/当前价/涨跌额/涨跌幅）。支持新版式 = 加一组枚举并在 popup.js 的处理分支中扩展。
- 开盘价由 `当前价 - 涨跌额` 反推（`kpj = dqj - zdf`），页面上没有直接的开盘价字段。
- 股票条目 `stopRunning: true` 表示不参与定时刷新（background 的 `targetUrls` 会过滤）；增删股票或切换启停后需发 `{action: 'refresh'}` 让 background 重载配置。
- 股票列表通过 DOM 字符串拼接渲染（`renderStock`），编辑/启停按钮在渲染时逐个绑定事件，勿依赖事件委托。

## 编码约定

- 界面文案与注释使用中文；变量名、消息 action 名使用英文。
- 消息协议两套字段并存：`action`（控制指令：`startRefresh` / `stopRefresh` / `getStatus` / `refresh`）与 `type`（数据上报：`DOCUMENT_CAPTURED`），新增消息沿用此风格。
