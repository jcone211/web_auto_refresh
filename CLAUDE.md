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

<!-- superpowers-zh:begin (do not edit between these markers) -->
# Superpowers-ZH 中文增强版

本项目已安装 superpowers-zh 技能框架（20 个 skills）。

## 核心规则

1. **设计先于编码** — 收到功能需求时，先用 brainstorming skill 做需求分析
2. **验证先于完成** — 声称完成前必须运行验证命令

> 本项目例外：无测试、无构建系统，不要求 TDD；skills 仅在显式调用时使用，不做自动匹配检查。

## 可用 Skills

Skills 位于 `.claude/skills/` 目录，每个 skill 有独立的 `SKILL.md` 文件。

- **brainstorming**: 在任何创造性工作之前必须使用此技能——创建功能、构建组件、添加功能或修改行为。在实现之前先探索用户意图、需求和设计。
- **chinese-code-review**: 中文 review 沟通参考——话术模板、分级标注（必须修复/建议修改/仅供参考）、国内团队常见反模式应对。仅在用户显式 /chinese-code-review 时调用，不要根据上下文自动触发。
- **chinese-commit-conventions**: 中文 commit 与 changelog 配置参考——Conventional Commits 中文适配、commitlint/husky/commitizen 中文模板、conventional-changelog 中文配置。仅在用户显式 /chinese-commit-conventions 时调用，不要根据上下文自动触发。
- **chinese-documentation**: 中文文档排版参考——中英文空格、全半角标点、术语保留、链接格式、中文文案排版指北约定。仅在用户显式 /chinese-documentation 时调用，不要根据上下文自动触发。
- **chinese-git-workflow**: 国内 Git 平台配置参考——Gitee、Coding.net、极狐 GitLab、CNB 的 SSH/HTTPS/凭据/CI 接入差异与镜像同步配置。仅在用户显式 /chinese-git-workflow 时调用，不要根据上下文自动触发。
- **dispatching-parallel-agents**: 当面对 2 个以上可以独立进行、无共享状态或顺序依赖的任务时使用
- **executing-plans**: 当你有一份书面实现计划需要在单独的会话中执行，并设有审查检查点时使用
- **finishing-a-development-branch**: 当实现完成、所有测试通过、需要决定如何集成工作时使用——通过提供合并、PR 或清理等结构化选项来引导开发工作的收尾
- **mcp-builder**: MCP 服务器构建方法论 — 系统化构建生产级 MCP 工具，让 AI 助手连接外部能力
- **receiving-code-review**: 收到代码审查反馈后、实施建议之前使用，尤其当反馈不明确或技术上有疑问时——需要技术严谨性和验证，而非敷衍附和或盲目执行
- **requesting-code-review**: 完成任务、实现重要功能或合并前使用，用于验证工作成果是否符合要求
- **subagent-driven-development**: 当在当前会话中执行包含独立任务的实现计划时使用
- **systematic-debugging**: 遇到任何 bug、测试失败或异常行为时使用，在提出修复方案之前执行
- **test-driven-development**: 在实现任何功能或修复 bug 时使用，在编写实现代码之前
- **using-git-worktrees**: 当需要开始与当前工作区隔离的功能开发，或在执行实现计划之前使用——通过原生工具或 git worktree 回退机制确保隔离工作区存在
- **using-superpowers**: 在开始任何对话时使用——确立如何查找和使用技能，要求在任何响应（包括澄清性问题）之前调用 Skill 工具
- **verification-before-completion**: 在宣称工作完成、已修复或测试通过之前使用，在提交或创建 PR 之前——必须运行验证命令并确认输出后才能声称成功；始终用证据支撑断言
- **workflow-runner**: 在 Claude Code / OpenClaw / Cursor 中直接运行 agency-orchestrator YAML 工作流——无需 API key，使用当前会话的 LLM 作为执行引擎。当用户提供 .yaml 工作流文件或要求多角色协作完成任务时触发。
- **writing-plans**: 当你有规格说明或需求用于多步骤任务时使用，在动手写代码之前
- **writing-skills**: 当创建新技能、编辑现有技能或在部署前验证技能是否有效时使用

## 如何使用

当任务匹配某个 skill 时，使用 `Skill` 工具加载对应 skill 并严格遵循其流程。绝不要用 Read 工具读取 SKILL.md 文件。
<!-- superpowers-zh:end -->
