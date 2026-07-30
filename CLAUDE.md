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
2. **background.js（service worker）调度**：用 `chrome.alarms`（alarm 名固定为 `refreshTimer`）按周期触发；对每个目标 URL `chrome.tabs.query` → 存在则 reload，不存在则 create。
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

## 已知问题（待修复）

修改相关代码时注意以下问题；修复后请同步删除对应条目。

### 真实 bug

1. **thswc 多股票只刷新一个标签页**（thswc/background.js:137）：`chrome.tabs.query({ url })` 按 match pattern 匹配，忽略 query string。所有股票 URL 的 path 都是 `/unifiedwap/result`（只有 `?w=` 不同）→ 每个 URL 都命中全部问财标签页，`tabs[0]` 永远刷新 id 最小的同一个标签，其余股票数据不更新。需按完整 URL 精确过滤（如 `tabs.find(t => t.url === url)`）。
2. **关闭任意浏览器窗口都会停掉监控**（base/background.js:45、thswc/background.js:66）：`windows.onRemoved` 中 `chrome.alarms.clear('refreshTimer')` 在 if 外无条件执行，关闭无关窗口即静默停止定时刷新。应移入 `closedWindowId === popupWindowId` 分支。
3. **`doc.getElementsById` 方法不存在**（base/popup.js:111、thswc/popup.js 的 `getTargetData`）：DOM 只有 `getElementById`。base 中输入 `#` 开头的选择器会抛 TypeError 使监听静默失效；thswc 处目前是死代码但同样错。
4. **base 的 witchItem 设置不回显、不持久**（base/background.js:79、:84）：`getStatus` 返回对象缺少 `witchItemInput`（popup 每次重开 fallback 到 1）；`startRefresh(interval, url, selectorName)` 形参遮蔽模块级 `selectorName`，且未接收第 4 个参数，持久化的始终是旧值。
5. **thswc 阈值通知无「已通知」标记**（thswc/popup.js port handler）：涨跌幅越过阈值后只要持续在阈值外，每次抓取（约 30s）都重复弹系统通知。需在 stock 上加通知标记，触发后置位、回到区间内再清除。
6. **编辑股票保存的空判断写反**（thswc/popup.js `saveStockBtnEl`）：`if (list.length < 0)` 恒为假，应为 `=== 0`；filter 不到时会访问 `list[0]` 抛错，保存静默失败。

### 次要问题

7. **累积 setTimeout 可能丢尾部刷新**（thswc/background.js:133-145）：每只股票延迟累加（最多 3.5s/只），超过约 8 只时总延迟可能超过 MV3 service worker 约 30s 存活期，尾部定时器被杀；总延迟还可能超过刷新间隔造成批次重叠。
8. **XSS 面**（thswc/popup.js `renderStock`）：`stock.name` 来自第三方页面文本，直接拼入 `tr.innerHTML`，页面内容可注入 HTML 在 popup 中执行。应改用 `textContent` 构建单元格。
9. **popup 窗口高度竞态**（thswc/background.js:54）：窗口高度按 `stockList.length` 计算，但 stockList 异步加载未完成时点开图标会按空列表尺寸创建，之后不调整。
10. **SPA 监听是死代码**（base/content.js:44-46）：`pushstate`/`replacestate` 非标准事件，浏览器不会触发，实际只有 `popstate` 生效。

## 编码约定

- 界面文案与注释使用中文；变量名、消息 action 名使用英文。
- 消息协议两套字段并存：`action`（控制指令：`startRefresh` / `stopRefresh` / `getStatus` / `refresh`）与 `type`（数据上报：`DOCUMENT_CAPTURED`），新增消息沿用此风格。
