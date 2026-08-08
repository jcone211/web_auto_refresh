# 默认组合扩展实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将单「默认」组合扩展为三个固定默认组合（默认、持仓、观察），按固定顺序排列，均不可删除，名称作为保留字禁止用户创建同名组合。

**架构：** 在 `popup.js` 和 `background.js` 中定义 `DEFAULT_PORTFOLIOS` 常量，修改 `ensureMigrated` 实现幂等初始化，修改 `renderComboSwitches` 实现排序和删除按钮条件渲染，扩展 `deletePortfolio` 保护范围，新增命名验证函数。

**技术栈：** Chrome Extension Manifest V3, 原生 ES2020 JavaScript

---

## 文件结构

**修改：**
- `thswc/background/background.js` - 新增 `DEFAULT_PORTFOLIOS` 常量，修改 `ensureMigrated` 函数
- `thswc/popup/popup.js` - 新增 `DEFAULT_PORTFOLIOS` 常量，修改 `deletePortfolio` 函数，新增命名验证函数，修改导入导出命名逻辑
- `thswc/popup/render.js` - 修改 `renderComboSwitches` 函数的排序和删除按钮渲染逻辑

---

## 任务 1：定义常量并修改 background.js 初始化逻辑

**文件：**
- 修改：`thswc/background/background.js:1-10`（顶部常量区）
- 修改：`thswc/background/background.js:108-130`（`ensureMigrated` 函数）

- [ ] **步骤 1：在 background.js 顶部新增 DEFAULT_PORTFOLIOS 常量**

在 `thswc/background/background.js` 文件顶部（第 1 行之前）新增：

```js
const DEFAULT_PORTFOLIOS = ['默认', '持仓', '观察'];
```

- [ ] **步骤 2：修改 ensureMigrated 函数**

将 `ensureMigrated` 函数中的 `finish` 回调修改为补全三个默认组合：

```js
const finish = (list) => {
    const migratedList = migrateStockFields(list);
    // 组合迁移：若尚无 portfolios，则以当前列表 + 选择器建「默认」组合
    chrome.storage.local.get(['portfolios', 'activePortfolio'], (localResult) => {
        const portfolios = localResult.portfolios || {};
        chrome.storage.sync.get(['selectorName'], (syncSel) => {
            const currentSelector = syncSel.selectorName || 'wc1';

            // 补全缺失的默认组合（幂等）
            DEFAULT_PORTFOLIOS.forEach(name => {
                if (!portfolios[name]) {
                    portfolios[name] = { stockList: [], selectorName: currentSelector };
                }
            });

            // 首次迁移：将原有 stockList 放入「默认」
            if (!localResult.portfolios) {
                portfolios['默认'].stockList = migratedList;
            }

            const activePortfolio = localResult.activePortfolio || '默认';
            chrome.storage.local.set({
                stockList: migratedList,
                portfolios,
                activePortfolio
            }, resolve);
        });
    });
};
```

- [ ] **步骤 3：Commit**

```bash
git add thswc/background/background.js
git commit -m "feat(thswc): expand default portfolios to three (默认/持仓/观察)"
```

---

## 任务 2：修改 popup.js 删除保护和命名验证

**文件：**
- 修改：`thswc/popup/popup.js:36-40`（顶部变量区）
- 修改：`thswc/popup/popup.js:300-308`（`deletePortfolio` 函数）
- 修改：`thswc/popup/popup.js:335-364`（`handleExport` 函数）
- 修改：`thswc/popup/popup.js:366-430`（`handleImport` 函数）

- [ ] **步骤 1：在 popup.js 顶部新增 DEFAULT_PORTFOLIOS 常量**

在 `thswc/popup/popup.js` 文件的变量声明区（第 36 行附近）新增：

```js
const DEFAULT_PORTFOLIOS = ['默认', '持仓', '观察'];
```

- [ ] **步骤 2：新增命名验证函数**

在 `deletePortfolio` 函数之前（约第 298 行）新增两个辅助函数：

```js
// 命名保留字检查
function isReservedPortfolioName(name) {
    return DEFAULT_PORTFOLIOS.includes(name);
}

// 重名检查
function isDuplicatePortfolioName(name) {
    return portfolios[name] !== undefined;
}
```

- [ ] **步骤 3：修改 deletePortfolio 函数**

将 `deletePortfolio` 函数修改为保护三个默认组合：

```js
// 删除组合：默认组合不可删；活动组合须先切走（避免活动指针悬空）；删除前 confirm 防误触
function deletePortfolio(name) {
    if (!portfolios[name]) return;
    if (DEFAULT_PORTFOLIOS.includes(name)) {
        alert(`默认组合「${name}」不可删除`);
        return;
    }
    if (name === activePortfolio) {
        alert('当前组合使用中，请先切换到其他组合再删除');
        return;
    }
    if (!confirm(`删除组合「${name}」？组合内的股票快照将一并删除`)) return;
    delete portfolios[name];
    chrome.storage.local.set({ portfolios }, refreshCombos);
}
```

- [ ] **步骤 4：修改 handleExport 函数的命名验证**

在 `handleExport` 函数中，获取用户输入名称后（约第 337 行之后）新增验证：

```js
async function handleExport() {
    const defName = (activePortfolio && !DEFAULT_PORTFOLIOS.includes(activePortfolio)) ? activePortfolio : '';
    let name = promptComboName('组合命名（不超过4字，留空则为"问财导出"）：', defName);
    if (name === null) return;

    if (isReservedPortfolioName(name)) {
        alert(`「${name}」为默认组合名称，请更换其他名称`);
        return;
    }
    if (isDuplicatePortfolioName(name)) {
        alert(`组合「${name}」已存在，请更换其他名称`);
        return;
    }

    if (name === '') name = '问财导出';
    // ... 后续逻辑不变 ...
}
```

- [ ] **步骤 5：修改 handleImport 函数的命名验证**

在 `handleImport` 函数中，获取用户输入名称后（约第 375 行之后）新增验证：

```js
async function handleImport(file) {
    // ... 前面的解析逻辑 ...
    const prefilled = validComboName(nameFromFile(file.name)) ? nameFromFile(file.name) : (data.portfolioName || '');
    const name = promptComboName('组合命名（不超过4字，将作为该组合名称登记）：', prefilled);
    if (name === null) return;

    if (isReservedPortfolioName(name)) {
        alert(`「${name}」为默认组合名称，请更换其他名称`);
        return;
    }
    if (isDuplicatePortfolioName(name)) {
        alert(`组合「${name}」已存在，请更换其他名称`);
        return;
    }

    // ... 后续清洗和写入逻辑不变 ...
}
```

- [ ] **步骤 6：Commit**

```bash
git add thswc/popup/popup.js
git commit -m "feat(thswc): protect default portfolios from deletion and naming conflicts"
```

---

## 任务 3：修改 render.js 排序和删除按钮渲染

**文件：**
- 修改：`thswc/popup/render.js:194-231`（`renderComboSwitches` 函数）

- [ ] **步骤 1：修改 renderComboSwitches 函数的排序逻辑**

将 `renderComboSwitches` 函数中的排序逻辑修改为按 `DEFAULT_PORTFOLIOS` 顺序排列：

```js
// 渲染组合切换 chip（单选语义：checkbox 外观，仅一个活动）；
// handlers = { onSwitch, onDelete }，删除钮为 chip 内独立 ×
export function renderComboSwitches(portfolios, active, container, { onSwitch, onDelete }) {
    container.innerHTML = '';
    const names = Object.keys(portfolios);

    // 排序：默认组合按 DEFAULT_PORTFOLIOS 顺序在前，其余保持登记顺序
    names.sort((a, b) => {
        const ai = DEFAULT_PORTFOLIOS.indexOf(a);
        const bi = DEFAULT_PORTFOLIOS.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return 0;
    });

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

        // 仅非默认组合渲染删除按钮
        if (!DEFAULT_PORTFOLIOS.includes(name)) {
            const del = document.createElement('span');
            del.className = 'combo-del';
            del.textContent = '×';
            del.title = '删除组合';
            del.addEventListener('click', (e) => {
                // 阻止 label 默认行为，避免误触切换 checkbox
                e.preventDefault();
                e.stopPropagation();
                onDelete(name);
            });
            label.appendChild(del);
        }

        container.appendChild(label);
    });
}
```

- [ ] **步骤 2：验证 DEFAULT_PORTFOLIOS 常量在 render.js 中可用**

确认 `render.js` 能通过模块作用域访问 `DEFAULT_PORTFOLIOS`。由于 `render.js` 是被 `popup.js` 导入的模块，需要在 `render.js` 顶部定义或导入该常量。

在 `render.js` 文件顶部（第 1 行之前）新增：

```js
const DEFAULT_PORTFOLIOS = ['默认', '持仓', '观察'];
```

- [ ] **步骤 3：Commit**

```bash
git add thswc/popup/render.js
git commit -m "feat(thswc): sort default portfolios first and hide delete buttons"
```

---

## 任务 4：集成测试与验证

**文件：** 无文件变更

- [ ] **步骤 1：清理扩展 storage 并重新加载**

在 Chrome 中：
1. 打开 `chrome://extensions`
2. 找到 thswc 扩展，点击「详情」
3. 点击「清除站点数据」
4. 返回扩展卡片，点击刷新按钮

- [ ] **步骤 2：打开 popup 验证三个默认组合**

点击扩展图标打开 popup，验证：
- 组合区域显示三个 chip：「默认」「持仓」「观察」
- 顺序为：默认 → 持仓 → 观察
- 三个 chip 均无 × 删除按钮
- 「默认」chip 处于活动状态（绿色）

- [ ] **步骤 3：验证组合切换**

点击「持仓」chip，验证：
- 「持仓」变为活动状态
- 「默认」变为非活动状态
- 列表区域清空（「持仓」组合初始为空）

- [ ] **步骤 4：验证导出命名冲突**

在「持仓」组合下点击导出图标，输入名称「默认」，验证：
- 弹窗提示「「默认」为默认组合名称，请更换其他名称」
- 导出未执行

- [ ] **步骤 5：验证导出重名冲突**

再次点击导出，输入名称「观察」，验证：
- 弹窗提示「组合「观察」已存在，请更换其他名称」

- [ ] **步骤 6：验证正常导出**

再次点击导出，输入名称「测试」，验证：
- 导出成功
- 组合区域显示四个 chip：「默认」「持仓」「观察」「测试」
- 「测试」chip 有 × 删除按钮

- [ ] **步骤 7：验证删除保护**

尝试通过 DevTools Console 执行：

```js
chrome.storage.local.get(['portfolios'], (data) => {
    delete data.portfolios['默认'];
    chrome.storage.local.set({ portfolios: data.portfolios });
});
```

然后刷新 popup，验证「默认」组合仍然存在（被 `ensureMigrated` 补全）。

- [ ] **步骤 8：验证导入命名冲突**

点击导入图标，选择刚才导出的文件，输入名称「持仓」，验证：
- 弹窗提示「「持仓」为默认组合名称，请更换其他名称」

- [ ] **步骤 9：验证删除用户组合**

点击「测试」组合的 × 按钮，验证：
- 弹出确认对话框
- 确认后「测试」组合被删除
- 只剩三个默认组合

- [ ] **步骤 10：Commit 最终验证**

```bash
git add .
git commit -m "test(thswc): verify default portfolios implementation"
```

---

## 完成标准

- [ ] 三个默认组合（默认、持仓、观察）自动创建并按顺序显示
- [ ] 默认组合无删除按钮
- [ ] 默认组合不可通过代码删除（`ensureMigrated` 幂等补全）
- [ ] 用户不能创建名为「默认」「持仓」「观察」的组合
- [ ] 用户不能创建与已有组合重名的组合
- [ ] 用户组合的删除功能正常
