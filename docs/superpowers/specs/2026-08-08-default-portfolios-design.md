# 默认组合扩展设计规格

## 概述

将 thswc 扩展的单「默认」组合扩展为三个固定默认组合：「默认」「持仓」「观察」。三者按固定顺序排列，均不可删除、不可重命名，且名称作为保留字禁止用户创建同名组合。

## 需求

1. **三个默认组合**：「默认」「持仓」「观察」
2. **固定顺序**：默认 → 持仓 → 观察 → 其他用户组合
3. **不可删除**：三个默认组合均无删除按钮，代码层禁止删除
4. **幂等初始化**：每次启动时检查并补全缺失的默认组合
5. **保留字保护**：用户不能创建名为「默认」「持仓」「观察」的组合，也不能创建与已有组合重名的组合

## 数据模型

### 常量定义

```js
const DEFAULT_PORTFOLIOS = ['默认', '持仓', '观察'];
```

### 存储结构（不变）

`chrome.storage.local` 中的 `portfolios` 对象：

```js
{
  '默认': { stockList: [...], selectorName: 'wc1' },
  '持仓': { stockList: [...], selectorName: 'xq1' },
  '观察': { stockList: [...], selectorName: 'wc1' },
  '用户组合A': { stockList: [...], selectorName: '...' }
}
```

`activePortfolio` 指向当前活动组合名称，默认为 `'默认'`。

## 实现变更

### 1. background.js - 初始化与迁移

**文件**：`thswc/background/background.js`

**变更点**：`ensureMigrated` 函数

**逻辑**：

- 迁移时创建三个默认组合（而非单个「默认」）
- 已有数据时，遍历 `DEFAULT_PORTFOLIOS` 补全缺失项
- 每个默认组合的 `selectorName` 取当前 `syncSel.selectorName` 或默认值

```js
function ensureMigrated() {
    // ... 现有逻辑 ...
    const finish = (list) => {
        const migratedList = migrateStockFields(list);
        chrome.storage.local.get(['portfolios', 'activePortfolio'], (localResult) => {
            const portfolios = localResult.portfolios || {};
            const currentSelector = syncSel.selectorName || 'wc1';

            // 补全缺失的默认组合
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
    };
    // ... 读取 stockList 并调用 finish ...
}
```

### 2. render.js - 组合渲染

**文件**：`thswc/popup/render.js`

**变更点**：`renderComboSwitches` 函数

**逻辑**：

- 排序：默认组合按 `DEFAULT_PORTFOLIOS` 顺序排列在前，其余保持登记顺序
- 删除按钮：仅对非默认组合渲染 × 按钮

```js
export function renderComboSwitches(portfolios, active, container, { onSwitch, onDelete }) {
    container.innerHTML = '';
    const names = Object.keys(portfolios);

    // 排序：默认组合在前（按 DEFAULT_PORTFOLIOS 顺序），其余保持原序
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
                cb.checked = true;
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

### 3. popup.js - 删除保护与命名验证

**文件**：`thswc/popup/popup.js`

#### 3.1 删除保护

**变更点**：`deletePortfolio` 函数

```js
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

#### 3.2 命名保留字检查

**新增函数**：

```js
function isReservedPortfolioName(name) {
    return DEFAULT_PORTFOLIOS.includes(name);
}

function isDuplicatePortfolioName(name) {
    return portfolios[name] !== undefined;
}
```

**变更点**：`promptComboName` 调用后的验证

在 `handleExport` 和 `handleImport` 中，获取用户输入的名称后：

```js
const name = promptComboName('...', prefilled);
if (name === null) return;

if (isReservedPortfolioName(name)) {
    alert(`「${name}」为默认组合名称，请更换其他名称`);
    return;
}

if (isDuplicatePortfolioName(name)) {
    alert(`组合「${name}」已存在，请更换其他名称`);
    return;
}
```

### 4. popup.js - 常量定义

**变更点**：模块顶部新增常量

```js
const DEFAULT_PORTFOLIOS = ['默认', '持仓', '观察'];
```

### 5. background.js - 常量定义

**变更点**：模块顶部新增常量（与 popup.js 保持一致）

```js
const DEFAULT_PORTFOLIOS = ['默认', '持仓', '观察'];
```

## 边界情况处理

### 1. 用户已清理 storage

`ensureMigrated` 幂等补全三个默认组合，`activePortfolio` 回退到 `'默认'`。

### 2. 导入文件包含默认组合名称

导入时若 `portfolioName` 为保留字，弹窗提示用户更换名称，不覆盖默认组合数据。

### 3. 导出时活动组合为默认组合

`handleExport` 中 `defName` 逻辑：若 `activePortfolio` 为默认组合，则留空（用户需手动命名或导出为「问财导出」）。

## 测试验证

1. **首次安装**：三个默认组合自动创建，顺序为「默认」「持仓」「观察」
2. **清理 storage 后重启**：缺失的默认组合自动补全
3. **删除按钮**：默认组合无 × 按钮，用户组合有 × 按钮
4. **删除保护**：尝试通过代码删除默认组合时弹窗提示
5. **命名冲突**：创建名为「默认」「持仓」「观察」或已存在的组合时弹窗提示
6. **排序**：默认组合始终在前，用户组合按创建顺序排列在后

## 文件变更清单

- `thswc/background/background.js`：新增 `DEFAULT_PORTFOLIOS` 常量，修改 `ensureMigrated`
- `thswc/popup/popup.js`：新增 `DEFAULT_PORTFOLIOS` 常量，修改 `deletePortfolio`，新增 `isReservedPortfolioName` 和 `isDuplicatePortfolioName`，修改 `handleExport` 和 `handleImport` 的命名验证
- `thswc/popup/render.js`：修改 `renderComboSwitches` 的排序和删除按钮渲染逻辑
