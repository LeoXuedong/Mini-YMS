# YMS 自动化测试骨架

把 2026-10-21 修复的三项行为（H-1 非有限值 / M-6 CSV 注入 / M-2 筛选空值）固化成**回归断言**。
纯 Node + Playwright 驱动真实 Chromium 打开 `file://` 应用，断言打在**真实数值**上
（列统计、导出字节、视图行数、DOM 文案），不写「没报错即通过」。

---

## 怎么跑

```bash
# 在 D:\AI Agent\Hermes\YMS 下
node YMS-App/test/run.js
```

末行是汇总行：

```
用例：3 / 3 通过 · 断言：121 / 121 通过 · 耗时 3.2s
PASS 121 / 121
```

失败时末行为 `FAIL a / b（失败 n 条）` 且**退出码为 1**（可直接接 CI）。

### 常用参数

| 参数 | 作用 |
|---|---|
| `--app=<路径到 index.html>` | 指向另一份应用副本（有效性自证就靠它跑 `pre_fix_app`） |
| `--only=h1,m6,m2` | 只跑匹配到的用例（按文件名子串） |
| `--include-todo` | 额外**实测** 4 项未修问题当前的真实行为（信息性质，不计退出码） |
| `--help` | 用法 |

---

## 前置条件（一次性）

| 依赖 | 位置 / 说明 |
|---|---|
| Node.js | 本机 v24（`node -v`） |
| Playwright | ① `require('playwright')` ② `hermes-agent/node_modules/playwright` ③ 环境变量 `PLAYWRIGHT_PATH` |
| Chromium | ① 环境变量 `PLAYWRIGHT_CHROMIUM` ② `hermes/tools/chromium-1208/chrome-win64/chrome.exe` ③ `ms-playwright/chromium-1228|1247` ④ Playwright 默认解析 |

三条依赖解析都写在 `helpers/launch.js`，**任一环命中即可**；全都不命中会抛一条中文错误，
告诉你三种装法。不需要 GUI（headless 模式），不需要联网，不需要构建步骤。

---

## 目录结构与职责

```
test/
  run.js               入口：启动浏览器 → 逐个用例开新 page → 收断言 → 出汇总行 + 退出码
  helpers/
    launch.js          Playwright / Chromium 依赖解析 + file:// 打开 index.html + 收集 pageerror
    app.js             常用动作封装：导入 CSV / 计算列 / 列统计 / 导出 CSV / 读回 XLSX /
                       驱动筛选面板（含内联选择行）/ RFC4180 解析器
  cases/
    h1-non-finite.js       H-1 非有限值：1/0、log(0)、exp(1000) → valid=0 / missing=3 /
                           nonFinite=3 / 统计不出现 ∞ / XLSX 无 t:'e'；反例 Val*2 手算对齐
    m6-csv-injection.js    M-6 CSV 注入：= @ DDE 文本化、-2/-0.5/+3 放行、-2+3 转义、
                           RFC4180 引号与多行字段往返不变
    m2-filter-empty.js     M-2 筛选空值：未填值不参与过滤（视图不塌成 0）、行内「未填值 · 不生效」、
                           面板摘要「筛选 0 条（1 条未填值，不生效）」、缺失/非缺失仍生效
    todo-pending.js        4 项未修问题（M-1 / M-3 / M-4 / S-2）的 todo 占位 + 实测探针
  PROGRESS.md         进度备忘（撞迭代上限时从这里续）
```

### 用例模块契约

```js
module.exports = {
  id: 'm6-csv-injection',            // 唯一 id（--only 用它匹配）
  title: '人类可读标题',
  async run(ctx) {                   // ctx = { page, app, t, errors, require }
    const { page, t } = ctx;
    t.eq('标签', 实际值, 期望值);      // 每条断言一行输出
  }
};
```

`t` 提供：`ok(label, cond, detail)` / `eq` / `ne` / `near(label, actual, expected, tol)` /
`isNull` / `finiteOrNull` / `contains` / `noErrors`。

**加新用例**：在 `cases/` 建文件 → 把文件名加进 `run.js` 顶部的 `CASE_FILES` 数组。
用例运行时各自独立 page（独立应用状态），互不污染。

---

## 有效性自证（证明测试真能抓回归）

测试绿不代表有覆盖。做法：把应用退回修复前状态再跑一遍，**必须全红**。

```bash
cd "C:/Users/Xuedong/AppData/Local/hermes/kanban/boards/yms/workspaces/t_259af92e"
rm -rf pre_fix_app && cp -r "D:/AI Agent/Hermes/YMS/YMS-App" pre_fix_app
rm -rf pre_fix_app/test
cp -r "D:/AI Agent/Hermes/YMS/build/bak_fix_20261021/." pre_fix_app/   # 12 个文件的修复前副本

cd "D:/AI Agent/Hermes/YMS"
node YMS-App/test/run.js --app="C:/Users/Xuedong/AppData/Local/hermes/kanban/boards/yms/workspaces/t_259af92e/pre_fix_app/index.html"
```

实测结果：`FAIL 70 / 121（失败 51 条）`，退出码 1，三个用例全红。
详细失败原文见 `知识库\软件项目\YMS-测试骨架-20261021.md` 第 4 节。

---

## 已知限制

1. **只能跑在有 Playwright + Chromium 的机器上**；交付包（免安装版 zip）里没有 node_modules，双击用户跑不了。
2. **headless 无 GUI**，但会加载 `vendor/echarts.min.js`、`vendor/xlsx.full.min.js`，单次全跑约 3s（本机实测），
   首次启动浏览器多约 1s。
3. **`test/` 在 `YMS-App/` 里**：`build/package.py` 会 `os.walk(YMS-App)` 整目录打包 →
   下次打包会把 `test/` 一起打进交付 zip（文件数不再是 44）。若不希望交付包带测试，需要在 `package.py` 的
   `dirs[:]` 排除列表里加 `test`（本轮按「不改产品代码/打包脚本」的约束**未改**）。
4. 覆盖的是**本轮三项修复的回归**，不是全功能回归；`build/tests/` 里的历史套件仍是主验收。
5. `--include-todo` 的 4 项是**信息输出**，不产生 pass/fail、不影响退出码；修好一项就把对应条目从
   `todo-pending.js` 删掉，改写成正式断言。
