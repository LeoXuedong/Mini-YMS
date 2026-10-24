# 测试骨架进度备忘

> 用途：撞迭代上限时下一轮直接从断点续。
> 规则：每完成一步追加一行（时间 / 步骤 / 结论）。

| # | 步骤 | 状态 |
|---|------|------|
| 0 | 读源码确定断言锚点（__YMS__ / stats / exporter / isFilterActive） | ✅ 完成 |
| 1 | `run.js` + `helpers/launch.js` + `helpers/app.js` 能跑（一条命令出汇总行） | ✅ 完成（PASS 汇总行已出） |
| 2 | `cases/h1-non-finite.js` 通过 | ✅ 完成（60 断言） |
| 3 | `cases/m6-csv-injection.js` 通过 | ✅ 完成（29 断言） |
| 4 | `cases/m2-filter-empty.js` 通过 | ✅ 完成（32 断言） |
| 5 | `cases/todo-pending.js` 4 项 todo 落盘（默认 skip，--include-todo 可实测） | ✅ 完成（4 项均已实测当前行为） |
| 6 | 有效性自证：复制 `pre_fix_app\` + 还原 12 个备份文件 → 三条断言全红 | ✅ 完成（FAIL 70/121，失败 51 条，退出码 1） |
| 7 | 正式应用回归全绿 + 写报告 | ✅ 完成（PASS 121/121，退出码 0；报告已写） |
| 8 | M-1：备份待改文件到 `build\bak_m1_20261021\`（8 个） | ✅ 完成 |
| 9 | M-1：`YMS.num.parseLoose` 单一入口 + `inferType` 分母改「非空非缺失」 | ✅ 完成（明确缺失不计 parseFails） |
| 10 | M-1：原值/计算值分离（`Column.rawText` + `View.textAt` + 表格/筛选用 textAt） | ✅ 完成（CSV/Excel 两条导入路径都挂原文） |
| 11 | M-1：新用例 `cases/m1-numeric-text.js`（68 断言）转正，`todo-pending.js` 移除 M-1 | ✅ 完成（PASS 189/189，退出码 0） |
| 12 | M-1：有效性自证（`pre_fix_app` = bak_fix_20261021 + bak_m1_20261021） | ✅ 完成（FAIL 15 / 68，53 条红，退出码 1） |
| 13 | M-1：性能对比（10 万行 CSV 导入） | ✅ 完成（中位 999ms vs 976ms，+2.4%） |
| 14 | M-1：同步 `使用说明.md` / `js/help.js` 的类型推断说明 | ✅ 完成（交付 zip 未重打包，下次打包需重建） |
| 15 | M-3：备份 4 个待改文件到 `build\bak_m3_20261021\`（importer.js / i18n-dict-chrome.js / 使用说明.md / help.js） | ✅ 完成 |
| 16 | M-3：探针量清 `CsvParser.parseText` 真实返回（'' / `\n\n\n` / 空白 → 0 行 0 列；只有表头 → 0 行 3 列） | ✅ 完成（三种输入都确认 0×0） |
| 17 | M-3：`importer.js` 加 `emptyKindOf / noDataResult / guardEmpty`，CSV / Excel / .yms 三条路径统一判定，A 情形不碰 Store | ✅ 完成 |
| 18 | M-3：情形 B（只有表头）提示降级为 warn「仅列定义，0 行数据」（toast + 状态栏 + 处理说明） | ✅ 完成 |
| 19 | M-3：新用例 `cases/m3-empty-import.js`（78 断言）转正，`todo-pending.js` 移除 M-3（M-4 / S-2 保留） | ✅ 完成（PASS 267/267，退出码 0） |
| 20 | M-3：有效性自证（`pre_fix_app` = 还原 bak_m3 的 importer.js） | ✅ 完成（FAIL 225 / 267，M-3 单例 42 条红，其余 4 例全绿，退出码 1） |
| 21 | M-3：同步 `使用说明.md` / `js/help.js` 的空文件说明 + i18n 词库 7 条动态规则 | ✅ 完成（交付 zip 未重打包，下次打包需重建） |


## 关键实现备注（下一轮别重复踩）

- 「+」新增筛选条件会先弹**内联选择行** `.inline-picker`（`.pick-col/.pick-op/.pick-val/.pick-val2/.pick-ok`），
  必须点 `.pick-ok` 才会真正 `f.push` + `paint()`；只点 `+` 不会出现 `.filter-row`。
- 面板摘要文案（`筛选 0 条（1 条未填值，不生效）`）来自 `DataSettings.submit()` →
  写 `Store.addNote` + toast；只能点 `[data-act="submit"]` 触发（直接 `applyDataSettings` 不写摘要）。
- XLSX 断言在页面内 `YMS.Exporter.toArrayBuffer()` + `XLSX.read` 读回，判 `cell.t === 'e'` 与 `#DIV/0!`。
- CSV 断言先用 RFC4180 解析器把导出文本读回来（`helpers/app.js → parseCsv`），
  既能逐字段判前导单引号，又能证明「多行字段没被拆成两行」。
- 单引号陷阱：断言标签里出现单引号一定要用双引号字符串（本轮 `-2 无 '` 就踩过一次，报语法错）。
- **空导入（M-3）的判定只能看 `df.rowCount === 0 && df.cols.length === 0`**，不要看「文件字节数」：
  `'\n\n\n'`、`'   \n  \n'` 都有字节但解析结果同样 0 × 0；反过来 `',,,'` 解析出 4 个空表头列（`Col1..Col4`）属情形 B。
- **A 情形绝不能先 `Store.setData` 再回滚**：`setData` 会同时重置 `dataSettings`、`plot.activePage`、
  `ui.processingNotes` 和 `importedAt` —— 只回滚 df 会留下「数据没变、设置和处理说明却被清空」的隐性损坏。
  正确做法是判定前置、直接 return（`guardEmpty`）。
- 想证明「`Store.setData` 真的没被调用」，最省事的见证是 `Store.state.importedAt`：
  它每次 `setData` 都刷新，断它前后逐字相等即可，不必读私有字段。
- `YmsTemplate.load()` 内部已先写 Store，所以 `.yms` 的 A 情形必须在**调用 `load()` 之前**拦
  （0 字节 / 纯空白文本）；`columns: []` 的模板由 `validate()` 拒绝，同样不会写到一半。

## 第四轮 M-4（2026-10-21）
- 01 备份完成：build/bak_m4_20261021/ 保持相对路径（11 文件，js/core js/data js/table test）
- 02 代码改完：colNames.unique/notice/taken 单一入口 + 三条导入路径接入 + applyTable 主状态 + renameColumn 错误
- 03 回归：node YMS-App/test/run.js → PASS 358 / 358（6 用例，M-4 新增 91 条）
- 04 提示文案进主状态栏（applyTable / yms-template），实测 1680 宽不裁切（848/848）
- 05 todo 转正：cases/m4-duplicate-columns.js（91 断言，313 行）· todo-pending 只剩 S-2
- 06 有效性自证：pre_m4_app 按相对路径还原 → M-4 FAIL 47/91（44 红），其余 5 用例 267 全绿
- 07 help.js / 使用说明.md 同步；i18n 增 3 条 regPatterns（英文模式无中文残留）
- 08 终态回归：PASS 358 / 358（6 用例，5.6s）；记录已追加到 OB\知识库\软件项目\YMS-修复记录-20261021.md 第四节
- 09 复验（第二轮 run）：`node test/run.js` → PASS 358 / 358（6 用例，5.6s，退出码 0）—— 与 07/08 一致
- 10 复验：有效性自证重跑（工作区 `pre_m4_check` = 现 YMS-App + bak_m4 按相对路径还原）→ FAIL 314 / 358，M-4 47/91（44 红），其余 5 用例 267 全绿，退出码 1
- 11 复验：探针实测 A,A,B → A|A_2|B（colIndex 0/1）、A,A,A 与 A,A_2,A → A|A_2|A_3、A,A_2,A_2 → A|A_2|A_2_2、无重复 → Lot|Wafer|Yield
- 12 复验：列格式 decimals={A_2:3} → getCell A=1 / A_2=10.000 / B=100；绘图 x=A_2 取到 10/20，x=A 取到 1/2（不串列）
- 13 复验：英文模式（`__i18n.set('en')` + 400ms）状态栏 `Imported dup.csv: 1 rows x 3 cols · Header had 1 duplicate column name(s)...`，无 CJK 残留
- 14 打包待办：`build/package.py` 整目录 walk `YMS-App`（未排除 `test/`），当前 zip 仍是 10-19 产物；重建前须先加 exclude，否则测试脚本会被打进交付包

## 第五轮 S-2（2026-10-21）
- 01 备份核验：build/bak_s2_20261021/ 保持相对路径（8 文件）；md5 与改动前现行文件逐一相等（store.js 5326fd8d…）
- 02 代码改完：store.js 新增 schema 白名单 + 逐字段校验（applyRules/normRule/规则表，单一入口）+ deserialize 接入；
  yms-template.js 新增三档体量保护（32MB/50 表/100 万行/合计 200 万行）+ 报告转 note/toast
- 03 探针实测（build/probe_s2.js）：x=对象/数字 → [] 不崩；x="Lot" → ["Lot"]；未知键/__proto__ 全部丢弃、原型未被污染
- 04 体量保护实测：51 表 / 1,000,001 行 / 2,999,997 行 / 33MB 文本 → 全部拒绝且当前表（2 行、plot.x 保留）不受影响
- 05 正常往返实测：500 行夹具 → build→load 深比较 plot/dataSettings **0 处差异**；schema 覆盖 plot 19 键 / ds 7 键 / style 20 令牌
- 06 用例转正：cases/s2-yms-schema.js（121 断言）；todo-pending 清空；m4 的 11.2 改成「S-2 已转正」+ 新增 11.4（92 断言）
- 07 终态回归：node test/run.js → PASS 480 / 480（7 用例，6.4s，退出码 0）
- 08 有效性自证：pre_s2_check 按相对路径还原两文件 → S-2 FAIL 58/121（63 红），其余 6 用例 359 全绿，退出码 1

## 第六轮 迭代 25 · 按值分组（Group Mapping）（2026-10-21）
- 01 备份：build/bak_group_20261021/ 保持相对路径（10 文件）+ NEW_FILES.txt（还原时须删的 3 个新文件）；md5 与改动前逐一相等
- 02 纯函数引擎 js/data/group-map.js：distinct / normSpec / build / applyToDf / parseRules / metaOf（不改入参 df、非法参数只返回 ok:false）
- 03 数据模型：Column.order + Column.groupMap（随 columns[] 序列化）；store.js 新增 COL_META_RULES 列级白名单 + strMap 规则类型，applyColMeta 在 dfFromSpec 单一入口挂回
- 04 横轴顺序：aggregate.js toCol 带 order、orderCategories 在「无 Sorter」时按 col.order 排（未知类目排在已知之后，稳定）
- 05 UI js/table/group-ui.js：源列 / 值→组名（搜索 + 200 行）/ 组顺序 ↑↓改名删除 / 未分配二选一 / 前 5 行预览 / 批量规则 / 校验红字；右键菜单接入 column-ops.js
- 06 踩坑（已修）：输入框失焦触发的 change 会整批重绘组列表 → mousedown 目标消失 → 「组按钮第一次点没反应」；修法=值未变化时原地返回 + 只刷计数
- 07 探针实测（build/probe_group.js）：12 值→4 组、横轴 光刻|清洗|沉积|其他|未分组、两种未分配模式、.yms 往返 order 逐字还原、零 pageerror
- 08 新用例 cases/group-mapping.js（93 断言）并入 run.js → 全量 PASS 573 / 573（8 用例，12.4s）
- 09 有效性自证：pre_group_app 按相对路径还原（md5 与备份逐一相等）→ 新用例 FAIL 2/3 + 1 异常（右键菜单无此项 → #gm-dlg 超时），其余 7 用例 480/480 全绿
- 10 打包：package.py REQUIRED 增两文件 + walk 排除 test/ → 46 文件 / 3.72 MB / sha256 85f59f2f…；解压逐字节比对通过

## 第七轮 迭代 26 · 图例色阶自动配色（2026-10-21）
- 01 备份：build/bak_palette_20261021/ 保持相对路径（8 文件：index.html / css/components.css / css/plot.css / js/core/store.js / js/plot/plot-settings.js / js/help.js / 使用说明.md / test/run.js）；md5 与改动前逐一相等；新文件 js/plot/palettes.js、test/cases/palette-auto.js 未入备份
- 02 色板引擎 js/plot/palettes.js：10 套离散定性预设（tableau10/category10/set1/dark2/paired/tol-bright/tol-muted/kelly22/glasbey/grayscale）+ pickColors（循环+明度分层）+ deltaE2000（sRGB→Lab D65）+ minDeltaE；glasbey 30 色取自 colorcet glasbey_bw_minc_20 前 30 项
- 03 灰度预设按 CIELAB L*5→90 十级等间距重做：均匀灰阶的最小 ΔE 从 4.04 提到 6.02（≥5 达标）
- 04 UI：分组配色区块顶部新增 #ps-palette-auto（预设下拉 + 🎨 一键自动配色 + 色条预览 + 参考数行 + 超容量提示条）；手动路径（色块/▦/恢复默认）零改动
- 05 数据模型：plot.group.preset / autoN 两个新字段，normGroup（= S-2 白名单）同步放行，旧 .yms 缺字段归一为 ''/0
- 06 覆盖确认：手改项由「当前色 ≠ 预设按序号应得色」推导（不新增状态），有手改时弹「将覆盖已手动调整的 N 个图例颜色，继续？」
- 07 踩坑：.mini-btn 写死 width:20px → 带文字的一键按钮被压成 24px、文字溢出 53px；加 width:auto 修好（几何实测 btnW 24→102）
- 08 踩坑：Store.serialize() 的 plot 是活引用（plot: s.plot），用例里 save→改色→回灌 会污染「保存下来的文件」，必须 JSON 深拷贝快照
- 09 用例 cases/palette-auto.js 131 断言并入 run.js → 全量 PASS 704/704（9 用例，15.7s）；s2 两条断言同步到新白名单契约（字段数 3→5、往返串补 preset/autoN），用例数不变
- 10 有效性自证：pre_palette_app 按相对路径还原（md5 三份比对 SAME）→ 还原副本自带套件 PASS 573/573（改动前基线复现）；新用例打旧代码 FAIL 4/8 + 1 异常

## 第八轮 迭代 27 · 分组映射面板 UI 重做（2026-10-21）
- 01 基线实测：node YMS-App/test/run.js → PASS 706 / 706（9 用例，16.3s，退出码 0）
- 02 备份：build/bak_groupui2_20261021/ 保持相对路径（js/table/group-ui.js、js/core/i18n-dict-panels.js、css/components.css、test/cases/group-mapping.js、test/PROGRESS.md）；md5 与现行逐一相等（group-ui.js 498956db…）
- 03 新面板 js/table/group-ui.js（1056 行）：左栏值列表多选 + 虚拟滚动（ROW_H=26，只渲染可视窗口）/ 右栏三列表格（Group Name 手输 · Group Parameter 下拉复选框 · ↑↓× 操作 · 底部 + 新增分组）/ 「+」建组预填 + 焦点落组名框 / 一值一组（后加入者生效 + 提示条）
- 04 下拉复选框浮层：window 捕获阶段 mousedown/keydown（早于 util.modal 的 document 监听 → 第一下 Esc 只收浮层）、armed 免疫打开事件、面板挂 body 按锚点复用、面板内搜索（覆盖全部值、渲染上限 200）
- 05 css/components.css：新增 .gm-vlist/.gm-vrow/.gm-gtable/.gm-grp/.gm-gname/.gm-param-trigger/.gm-param-panel/.gm-msg 等；删除旧 .gm-row/.gm-in/.gm-val/.gm-groups/.gm-grp-name/.gm-grp-ren 死规则（全仓 grep 无外部引用）
- 06 i18n-dict-panels.js 迭代 27 段：19 条静态词 + 7 条 regPatterns（含「已勾选 N 个值」「N 项」「第 N 个分组还没有组名」）
- 07 探针实测：Esc/外点只收浮层不关对话框；T01 勾进「光刻」→ 从「清洗」移出并提示；1200 值打开 1.7ms / DOM 41 行
- 08 用例重写 cases/group-mapping.js（165 断言，旧 93）：6 个原语义点全保留 + 多选→+→预填→key 组名→确定 链路、冲突挪动、虚拟滚动性能；--only 实测 PASS 165/165（12.0s）
- 09 英文模式实测：面板 + 浮层 `__i18n.remaining()` = []（补 `归为「` / `」` 两条拆开的文本节点词条）
- 10 help.js L64 + 使用说明.md L194–213 按新面板改写（含「一值一组」与虚拟滚动说明）；备份已补入 build/bak_groupui2_20261021/
- 11 有效性自证：scratch/pre_groupui2_app 按相对路径还原 3 个应用文件（测试文件不动）→ md5 三份「副本=备份≠现行」→ --app 跑：仅 group-mapping FAIL 10/19 + 1 异常，其余 8 用例 613 断言全绿，退出码 1
- 12 终态回归：node YMS-App/test/run.js → PASS 778 / 778（9 用例，21.6s，退出码 0）；断言 706 → 778（group 93 → 165）
- 13 死选择器清扫：css/js 全仓 grep 旧 .gm-row/.gm-in/.gm-val/.gm-groups/.gm-grp-name/.gm-grp-cnt/.gm-rename → 0 命中；新类名 js/css 双向都有引用
- 14 截图 5 张存 cache/scratch（gm2_final_panel / gm2_final_picker / gm2_picker_conflict / gm2_1200_values / gm2_final_en*），YMS-App 内 *.png = 0

## 第九轮 迭代 28 · 横轴分组标签合并（2026-10-21）
- 01 基线：改动前 `node YMS-App/test/run.js` → PASS 778 / 778（9 用例，22.9s，退出码 0；主 Agent 复核已过）
- 02 探针 `build/probe_groupaxis.js`（4 场景，真实 file:// + 真实 submitPlot）：4 短组名 → `__groupAxis.cells` **4 = 组数**（bar 数 12）、bandW 61.583、每格 span 184.75 = 3×bandW（最大误差 **0.001px**）、rotate 全 0；不等长组（2/3/1/6）→ span 123.17 / 184.75 / 61.58 / 369.50（误差 ≤ **0.004px**）；12 长组名 → cells **12 = 组数**（bar 24）、bandW 30.792、每格 span 61.58 = 2×bandW、**rotCount 12（全部 90°）**、竖排墨迹最小间隙 **48.58px**（横排场景 161.20px / 99.62px）
- 03 顺序实测：cell 标签序列 `T004|T001|T002|T003` = 面板 order；字母序应为 `T001|T002|T003|T004` → **不是字母序**；12 长组同样按面板 order（字母序完全不同）
- 04 第一层标签：12 个批号 `L0001…L0003` ×4 组，**无组名前缀、无「组名-批号」连接符**（改造前是 `T001-L0001` / `CMP-COPPER-POLISH-LINE-1-L0001`）；每组标签在 graphic 里**只绘制 1 次**
- 05 底部留白（实测 grid 矩形：容器高 − (gridTop+gridH)）：4 短组 **128 → 115px（−13）**；12 长组 **256 → 262px（+6）**；单列 X 对照 **110 → 110px（0，零回归）**。分解（`__axisFit`）：4 短组 rotH 57→29 且新增 groupBand 15；12 长组 rotH 185→29 且新增 groupBand 162（160+2）
- 06 截图 2 张存 `…/cache/scratch/ga-now-1-4short.png`、`ga-now-2-12long.png`；`find YMS-App -name "*.png"` = **0**（未进应用目录）
- 07 新用例 `test/cases/group-axis-labels.js`（**93 断言**）+ 登记进 `test/run.js` CASE_FILES（group-mapping 之后）；`--only=group-axis-labels` → PASS 93 / 93（6.5s）
- 08 全量回归：`node YMS-App/test/run.js` → **PASS 871 / 871**（10 用例，27.6s，退出码 0）；断言 778 → 871（+93）
- 09 有效性自证：`scratch/ga_before_app` = YMS-App 整目录 + `build/bak_groupaxis_20261021` 按相对路径覆盖；md5 三份比对 → 5 文件「副本 = 备份」全部成立，其中 aggregate/axis/chart-builder/run.js「≠ 现行」，使用说明.md 与现行相同（本轮未改它）→ `--app=<副本>` 跑新用例：**82 条断言里 54 条红**（退出码 1），11 条依赖 cell 逐项的循环因 cells=[] 无法展开
- 10 已知限制：① 数据表格（`plot.table.show`）开启时横轴块改由 `tableModel` 接管 → `__groupAxis` 关闭、不画分组行（用例 6.3 记录当前行为）；② 单个组时 1 个 cell 跨全部类别，12 行会折叠成 3 个类别（组内同名批号合并），属既有聚合语义；③ 全屏路径未在本轮实测分组行（`reflowAxisTable` 复用同一 `groupAxisModel` 结果，未验证）
- 11 踩坑：① 探针 `--app=` / `--tag=` 必须按 `--k=v` 解析（写成 `argv.indexOf('--app')` 会静默回落到默认值，导致「改造前」量到的是现行代码）；② `option.__groupAxis` 只能在 `buildOption` 返回时抓（ECharts `getOption()` 丢自定义顶层字段）→ 只读包装 `YMS.ChartBuilder.buildOption`；③ 重设 `window.__capOpts = []` 必须在 `submitPlot` **之前**（提交无变化时不重建 option）；④ `submitPlot({})` 前若只改 table 不动 x/values，会因缺少数据映射而不出图（须一并给全 x/values）

## 第十轮 迭代 28 第四轮 · 修复：数据表格路径的分组合并（2026-10-22）
- 01 备份：build/bak_tblgroup_20261022/{js,test} 保持相对路径；chart-builder.js 备份 md5 b10442b7… / 现行 ba4a63bf…
- 02 根因：`gmerge = groupMergeOf(cats)` 落在 `statOn = !tableWanted && …` 之后的统计分支里，且 `tableModel({...})` 没传 `group` → 表格接管横轴时分组行为零。上一轮把该现象写成「已知限制 1」并用 6.3 断言钉死（false），验证全跑在 table.show=false。
- 03 改法：gmerge 提到 `xIsValue`/`statOn` 之前无条件算；tableModel 增 `group: {h: TABLE.ROW_H, runs: gmodel.runs}`（复用 groupAxisModel，不另写判定）；tableM 存在时 `groupBand=0`（bottomFit 与 else-if 两处，避免双算留白）；__groupAxis 支持 `source='axis'|'table'`，`__table.groupOn/groupCells` 同源输出
- 04 用例 6.x 翻转：6.3 表格开启 `__groupAxis=on`；6.3b source='table'；6.4/6.5 groupCells=4（≠12 列）；6.6 count=3|3|3|3；6.6b span=count×bandW（≤1px）；6.7 标签 T004|T001|T002|T003；6.8 i0-i1=0-2,3-5,6-8,9-11；6.9 相邻格边界衔接；6.10/6.11 __groupAxis 与首行同源；6.12/6.13 第一层只剩批号；6.14 组名各画 1 次；6.15 nAll=rows+2；6.16 行高>0
- 05 回归：`--only=group-axis-labels` PASS 109/109；`node YMS-App/test/run.js` **PASS 887 / 887**（10 用例，27.4s）—— 871 → 887（+16）
- 06 有效性自证：scratch/selfcheck_old = 现 YMS-App + 备份 js 覆盖 → `--app=` 跑新断言 **FAIL 97/109，12 条红**（exit 1）
- 07 截图：`…/cache/scratch/yms-tblgroup-20261022.png`（card 898×683，表格首行 4 格 T004|T001|T002|T003）；`find YMS-App -name "*.png"` = 0
- 08 长组名实测（build/probe_tbl_long.js）：4×长组名 2 bar/组、格宽 196px → 4 格、完整显示、rot=0，不截断
- 09 残留：无「已知限制」条目

## 2026-10-22 22:31–23:12 · 任务 A：分组标签合并 单层 → N 级

状态：**完成**（全部交付点已实测，无残留限制）

### 改动文件
- `js/plot/aggregate.js`：`groupLevelPositions()`（除最后一列外的所有 X 列 = 分组层）、
  `cat.groupLabels[]`（+ `groupLabel = groupLabels[0]` 向后兼容）、`subLabel` = 最后一列（叶子）、
  `orderCategories()` 逐级分层排序（级 0 用 groupMap 面板 order / 否则首现序 → 级 1 → … → 叶子文本序）、
  合并切段改用**最深层 tuple**（`catGroupKey`）→ 合并块绝不跨级。
- `js/plot/axis.js`：新增 `groupAxisLevels()`（每级一条带、格 = tuple 前缀连续段、
  **整级统一角度**、每级 h/gap/band/rotCount），`groupAxisModel()` 改为单层包装（逐值不变）。
- `js/plot/chart-builder.js`：`groupMergeOf()` 产 `levelValues[][]`；`axisTableLayout()` N 级带
  （级 0 靠绘图区，`Σ(h+gap)` 进底部留白）；`tableModel()/tableGraphic()` 表格首部 N 行分组行
  （`nAll = 数据行 + 表头 + N`）；`axisSpecOf()` 全屏重算携带全部级；`__groupAxis.levels` /
  `__table.groupCellsByLevel` 元数据。
- `test/run.js`：登记新用例；`test/cases/group-axis-multilevel.js`：新增 72 条断言。

### 实测数字（探针 probe_3level.js，用户真实 CSV 6000 行，X=[Tool_Group,Chamber_Group,Lot]）
改前：levels=0，cells=4（只有 Tool1..4） → 改后：**levels=2，级0 cells=4，级1 cells=8**
- 级 0：Tool1..Tool4，count = 10/11/10/6（∑=37）
- 级 1：CHM1/CHM2 逐 tool 成对，count = 5/5/5/6/4/6/3/3（∑=37 = 级 0 之和 = 总列数）
- `table.groupCellsByLevel` = [4, 8]；表格 nAll = 数据行 + 1 + 2

### 回归
- `node test/run.js`：**PASS 984 / 984**（原 912 条一条未改，全绿；+72 新断言）
- 有效性自证：备份还原到 `build/tmp/pre_ml_app/`，`--only=group-axis-multilevel --app=` → **红 47 / 72**
  （例：1.4 级数=2、1.5 levels 长度、1.8 级1 cells=8、1.20 band=各级求和、1.23 groupRowCount=2、
   2.6 合并不跨 CHM、3.7 fit.groupBand、4.6 四列→3 级 …）
- 全屏通道实测：levels=2 / cellsByLevel=[4,8] / band=30=fit.groupBand / grid.bottom=173 / 分组文字 12 个

### 备份
`build/bak_multilevel_20261022/js/plot/{aggregate,axis,chart-builder}.js` +
`build/bak_multilevel_20261022/test/cases/group-axis-labels.js`（保持相对路径）

### 截图（只在 cache/scratch，未进 YMS-App）
- `C:/Users/Xuedong/AppData/Local/hermes/cache/scratch/shot_ml_merge_auto.png`（Merge Auto，两级分组行）
- `C:/Users/Xuedong/AppData/Local/hermes/cache/scratch/shot_ml_merge_off.png`（Merge 关掉 limit=9999）
- `.../probe_3level_after.png`（探针原图）


## 第五轮 · 数据表格行序对调（统计行在上 / 分组行 + 横轴参数行在最下）

用户原话：「把所有合并显示的以及作为横轴的参数，都显示在最下方，上方显示统计数据，
即把图示两个方框的内容对调一下」。**只改 `plot.table.show = true` 的表格通道**，
`plot.table.show = false`（统计行由轴层绘制）零回归。

### 语义（自上而下，只改顺序不改数据）
1. 统计量行 `Mean` / `Std` / `Nu%`（顺序仍按 `STAT_ORDER`，行名列文字不变）
2. 系列行（图面聚合值；未指定但钉在统计行之下、分组行之上）
3. 分组行 级 0 → 级 N-1（级 0 仍最上，整块下移）
4. 横轴参数行（叶子类别名 + 左侧列名，**最下一行**）

### 代码（唯一改动文件：`js/plot/chart-builder.js`）
- 新增 `tableRowSlots(rows, groupCount)`：**槽位唯一来源**（0 = 最上一行）→
  `{ nStat, nSeries, groupSlots[], rowSlots[], headerSlot = n + g, nAll = n + 1 + g }`。
- `tableModel()`：`nAll` 改由 `tableRowSlots()` 给出（**值不变**），返回值新增 `layout`。
- `tableGraphic()`：删掉旧的 `gShift / rowBottom(j) / textBottom(j)`，全部改走
  `slotBottom(slot) / slotText(slot)`；行头列文字与单元格**共用同一槽位**（不可能错位）。
  行头列底色 / 类别竖线按「数据行整段（最上方）+ 参数行（最下一行）」两段绘制，
  分组行所在段不画类别竖线（仍是跨列合并）。
- `option.__table.layout = { order, nStat, nSeries, groupRowCount, headerSlot,
  statBottoms[], seriesBottoms[], groupBottoms[], headerBottom }`
  —— 数值 = `tableGraphic` **实际绘制出去**的 graphic `bottom`（越大越靠上），
  由 `tableGraphic` 回写 `m.placed`，不是重算一遍。
- 文件头契约注释补「第五轮」段。

### 实测数字
- 卡片视图（4 列 X = 3 级分组，Merge Auto 触发 64→32 列）：
  `nAll = 8`（1 系列 + 3 统计 + 表头 + 3 分组行）·`statBottoms=[118,102,86]`·
  `seriesBottoms=[70]`·`groupBottoms=[54,38,22]`·`headerBottom=6`
  → **min(statBottoms)=86 > max(groupBottoms)=54**
- 全屏视图（`FS_PAD_BOTTOM=34`）：`statBottoms=[148,132,116]`·`groupBottoms=[84,68,52]`·
  `headerBottom=36` → **116 > 84**（未与底部 slider 带冲突）
- `nAll` 改前后：同一配置 `rowCount + 1 + N` 逐值相等（4 列/3 级：8 = 8）

### 回归
- `node test/run.js`：**PASS 1074 / 1074**（改前 1013；+61 新断言，13/13 用例通过）
- 原有数值断言（行数 / cells 数 / 跨度 / count）**一条未改**；只把两处「表格首行 / 首部」
  这类**位置措辞**在断言标题与注释里改成「表格分组行 / 表格下部」（值、条数不动）
- 有效性自证：`build/tmp/pre_tableswap_app/`（`js/plot/chart-builder.js` 还原为备份，
  md5 三份核对：备份 = 副本 ≠ 现行）→ `--only=table-row-order --app=` **红 29 / 61**，
  含核心 1.10（min(statBottoms) > max(groupBottoms)）、1.3 layout 未暴露、1.11/1.12 行序、
  1.13 参数行位置、1.15.x 行名随行、2.4/2.5、3.1/3.2/3.4/3.5；
  未红的 32 条 = 不变量类（nAll 公式、分组格数、channel 隔离），本就该两版都绿

### 备份（保持相对路径）
`build/bak_tableswap_20261022/js/plot/chart-builder.js`、
`build/bak_tableswap_20261022/test/run.js`、
`build/bak_tableswap_20261022/test/cases/{group-axis-labels,group-axis-multilevel}.js`

### 截图（只在 cache/scratch，未进 YMS-App）
- `C:/Users/Xuedong/AppData/Local/hermes/cache/scratch/tableswap_shot1_full.png`（整屏）
- `.../tableswap_shot2_table.png`（图卡局部：统计行在上、分组行 + 参数行在下）
- `.../tableswap_shot3_fullscreen.png`（全屏通道同一行序）
- 探针：`.../probe_tableswap.js`、`.../probe_tableswap_fs.js`

### 零残留限制
无「已知限制」条目：卡片 / 全屏 / 1 级 / 3 级 / 无分组 五种形态均实测通过。

---

## 2026-10-23 · 任务 C：轴层统计行通道纵向次序（统计行在最上 → 分组带 → 轴标签）

### 为什么要这一轮（上一轮的误判）
上一轮（数据表格行序对调）只改了 `plot.table.show = true` 的**数据表格**通道；用户实际用的是
`plot.table.show = false` + `plot.stats.show = true` 的**轴层统计行**通道（统计数值竖排旋转）。
判据：他的截图里统计数值是 90° 竖排，那是 `axisTableLayout` + `axisBlockGraphic` 的画法。

### 改前 / 改后实测（同一份用户真实 CSV 前 4000 行，X=Tool_Group→Chamber_Group→Layer→Lot，
stats.items=[mean,std,nupct]，stats.rotate=90，table.show=false；探针 `probe_stats_swap.js`）
| 视图 | 改前（`D:/AI Agent/Hermes/YMS/build/bak_axisswap_20261023`） | 改后 |
|------|----------------------------------------|------|
| 卡片 graphic 实测 | minStat **37** / maxGroup **201**（分组在上） | minStat **130** / maxGroup **105** |
| 卡片 `__statBlock` | 不存在（None） | statBottoms `[185,157,126]` · groupBottoms 50 格 · labelH 29 |
| 卡片 `__axisFit.bottom` | **221** | **221**（预算总高逐值不变 → 绘图区不缩水） |
| 全屏 `__statBlock` | 不存在 | statBottoms `[218,187,152]` · groupBottoms 50 格 · labelH 34 → **152 > 129** |

### 代码（两个文件）
- `js/plot/axis.js`（`bottomFit`）：`labelGap = 轴标签间距 + 统计行带 + 分组带`（原为 `轴标签间距 + 分组带`），
  `need`（= 三者相加 + 轴标题带）**总和与次序无关 → grid.bottom 数值不变**；
  新增 `rowsBottom/rowsTop/labelBlockBottom/order:'stat,group,label'`，`rowsTop` 改为统计带顶边。
- `js/plot/chart-builder.js`（`axisTableLayout` / `axisBlockGraphic` / 新函数 `statBlockOf`）：
  - `labelMarginEff = 轴标签间距 + statBandH + 分组带`（原本只有后者），`statBandH = rowGap + statRows×rowH`；
  - 锚点改为 `labelTop = gridBottom − labelMarginEff`、`colBase（统计带底边）= labelTop + 分组带 + 行间距`；
    方框下边贴类别标签块底边、上边包住统计带顶边；
  - 行名列首行（X 轴列名）锚到**类别标签块顶端**；X 轴标题 `nameGap` 不再重复加一次统计行带（总高不变）；
  - 统计数值 / 分组格 graphic 元素打 `__statRow` / `__groupBand` 标记 →
    `option.__statBlock = { statBottoms, groupBottoms, groupRowBottoms, groupCells, labelH, rowH, rows, order,
    labelTop, statBase, statTop, groupTop, mode }`，**直接读实际画出去的 bottom，不另算**；
  - 全屏 `reflowAxisTable` 重算后同步刷新 `__statBlock`。
- 数据表格通道（`tableModel` / `tableGraphic` / `placed`）**一行未动** → 上一轮的行序保持。

### 回归
- `node test/run.js`：**PASS 1128 / 1128**（改前 1074；新用例 54 条，14/14 用例通过）
- 数据表格通道 `table-row-order.js` 全绿（`min(statBottoms)=86 > max(groupBottoms)=54` 未退化）
- 分组带数值断言（格数 / 跨度 / count / `__axisFit.groupBand`）一条未改

### 新用例 `test/cases/stats-block-order.js`（54 断言，已登记进 `test/run.js` 的 `CASE_FILES`）
- 1.x 卡片 4 列 X / 3 级分组：`__statBlock` 暴露、order、statBottoms 长度 3、
  ★ min(statBottoms)=121 > max(groupBottoms)=100、groupBottoms 格数 = Σ 各级格数、级 0 最上、
  分组带整体在标签块之上、labelH = `__axisFit.rotH`、统计带不侵入绘图区（实测余量 7）、
  graphic 实测 min(统计数值)=121 > max(分组文字)=100、rot 全 90°、行名各 1 次且同带（Δ=7/4/4）
- 2.x 全屏：★ min=152 > max=129、order 一致、grid.bottom 真重算、slider 30px 带不冲突
- 3.x 单列 X（无分组）：groupBottoms 空、统计行仍 3 行且在标签块之上、无空带（statBase − labelTop = 3）
- 4.x 2 列 X（1 级分组）：★ min=80 > max=59、格数 = 该级格数
- 5.x 数据表格通道：order `stat,series,group,param`、★ 86 > 54、nAll 公式、`__statBlock` 为 null（通道隔离）
- 6.x 登记自证：`run.js` 含文件名 + 文件真实存在

### 有效性自证（还原改动前版本跑新用例）
`C:/Users/Xuedong/AppData/Local/hermes/cache/scratch/pre_axisswap_app/`
（`js/plot/axis.js` + `chart-builder.js` 还原为 `D:/AI Agent/Hermes/YMS/build/bak_axisswap_20261023` 备份（**项目根 build/，不在 YMS-App 内**），md5 三份核对：备份 = 副本 ≠ 现行）
→ `node test/run.js --only=stats-block-order --app=<副本>/index.html`：**FAIL 24 / 54，红 30 条**（退出码 1）：
1.2/1.3/1.4/1.5（`__statBlock` 未暴露）、**1.7 核心** min>max、1.8、1.9、1.11、1.12、1.13、1.14、1.15、
**1.16 graphic 实测**、1.17、1.18、1.20、1.22、2.1/2.2/2.3/2.4/2.6/2.7、3.2/3.3/3.4/3.5、4.2/4.3/4.4。
另用探针在**同一份备份**上实测几何：minStat 37 < maxGroup 201（= 用户报的现象），
与新版本 130 > 105 对照 → 断言红的原因就是次序本身，不只是元数据缺失。

### 备份（保持相对路径，放**项目根** `D:/AI Agent/Hermes/YMS/build/`，不在 YMS-App 内）
`D:/AI Agent/Hermes/YMS/build/bak_axisswap_20261023/index.html`、`js/plot/axis.js`、`js/plot/chart-builder.js`、
`js/plot/fullscreen.js`、`test/run.js`

### 截图（只在 cache/scratch，未进 YMS-App）
- `.../cache/scratch/axisswap_card_20261023.png`（卡片视图：统计行在上 → 分组带 → 旋转标签）
- `.../cache/scratch/axisswap_fullscreen_20261023.png`（全屏视图，同序 + 底部 slider 带）
- 改前对照：`.../probe_stats_swap_before_20261023.png`

### 零残留限制
无「已知限制」条目：卡片 / 全屏 / 3 级 / 1 级 / 无分组五种形态 + 数据表格通道隔离均实测通过。

## 任务 E · 全屏缩放三处几何优化（2026-10-23）

- ① 箱体出界：`reflowAxisTable` 按 xAxis extent（lo..hi）过滤 series.data（窗口外置 null，索引不变）；
  fullscreen.js 新增 `axisExtentOf(chart)` 并把 extent 传入重算。元数据 `option.__boxFilter` 记录读数。
- ② 左侧空白：graphic 模式下 grid.left 改为紧算
  `max(Y 轴区实测留白, FRAME_LEFT + 行名实测宽 + 2×HEADER_TEXT_PAD + ROWNAME_GAP(4))`；
  行名列宽不再把「X 轴全名拼串」算进去（旧 261px 里 199px 来自它）。行名右沿锚点 = grid.left − 4。
- ③ 轴标题压参数行：`axisTableLayout` 的 nameGap 加上整条参数行带 gBand
  （= 轴标签间距 + 统计带 + 旋转标签块 + 参数行带 + TITLE_GAP），构建路径与全屏重算同源。
- 备份：`build/bak_fszoom_20261023/{js/plot/chart-builder.js, js/plot/fullscreen.js, test/run.js}`（相对路径）
- 待办：新用例 test/cases/fullscreen-zoom-geom.js + 登记 run.js + 自证（还原版跑新用例必须红）

### 任务 E · 实测读数（2026-10-23，全屏 1642×839 / 卡片 898）

| 项 | 改前 | 改后 |
|---|---|---|
| ① 全屏缩放 25-75 的箱体像素 x | 24 条全画，min -380 / max 2265（12 条出界） | 只画窗口内 12 条，154.6 / 1577.4，越界 0 |
| ① series.data | 24 条全量 | 仍 24 条（索引保留），窗口外 12 条置 `'-'`；`__boxFilter.dropped=12 kept=12` |
| ② 行名右沿 max vs grid.x | 258.0 vs 261（间距 3px） | 103.0 / 104.0 vs 108（间距 5.0px ≥4） |
| ② grid.left | 261（全屏）/ 261（卡片） | 108（全屏，净省 153px）/ 94（卡片，净省 167px） |
| ③ 轴标题 y 区间 | 740~753（压 Layer 733~746、Chamber_Group 748~761） | 785~798（参数行最下沿 776，不相交，间隔 9px） |
| ③ nameGap | 159 | 204（= 轴标签间距 + 统计带 + 旋转标签块 + 参数行带 45 + TITLE_GAP） |

选择 ③ 方案 (a)「标题移到所有参数行之下」而非 (b)「有参数行时隐藏标题」：
`grid.bottom` 的预算里本就含 titleBand（TITLE_GAP + titleH + BOTTOM_TAIL），把标题推到参数行之下
**不需要额外高度**；而标题是唯一把「Tool_Group→Chamber_Group→Layer→Lot」层级顺序写在一行的地方，
隐藏等于丢信息。实测标题下沿 798 < 容器高 839、且不与底部 dataZoom slider（815~835）冲突。

⚠ 实测坑：窗口外的 boxplot 数据项**不能置 null** —— ECharts 5 的 boxplot 布局对 null 项抛
`Cannot read properties of null (reading 'value')`，整条 series 被丢弃、坐标区消失（探针 chk4 复现）。
必须用官方空值标记 `'-'`。

### 任务 E · 验证
- 新用例 `test/cases/fullscreen-zoom-geom.js`（39 断言，已登记进 run.js 的 CASE_FILES）
- 全量 `node test/run.js` → **PASS 1113 / 1113**（改前 1074 → +39，只涨不跌；14/14 用例通过）
- `stats-block-order.js` 既有断言未改，61 条继续全绿（第 1/2/7 段在内）
- 有效性自证：`build/bak_fszoom_20261023` 还原到 scratch/before_app，`--app=` 跑新用例 → **红 17 条**
  （2.3 2.4 3.4 3.5 3.6 3.7 4.3 4.4 4.5 4.6 4.7 4.8 4.9 4.10 4.12 4.14 4.15）
- 截图（只在 cache/scratch）：fszoom_1_card_20261023.png / fszoom_2_full_nosoom_20261023.png /
  fszoom_3_full_zoom25_75_20261023.png

## 任务 I · 设置区三处 UI 调整（2026-10-24）
- [x] 读任务书 + 基线实测：17 用例 / 1257 断言全绿（100.1s）
- [x] 备份 build/bak_uidiet_20261024/（相对路径：js/plot/plot-settings.js、js/help.js、css/components.css、css/polish.css、test/cases/palette-auto.js、test/cases/zoom-table-align.js、test/run.js、使用说明.md）
- [x] I1 参考数行删除（paletteMetaText 函数删除 + #ps-palette-meta 不再渲染；预设下拉/一键/色条预览/超容量提示条保留）
- [x] I2 分组配色改下拉框（#ps-gc-select + #ps-gc-swatch + 展开 .gc-presets + 系统取色器 #ps-gc-color；gcSelectedKey 只切编辑对象）
- [x] I3 merge-on 说明行删除（仅 hist 渲染 merge-hist-na）
- [x] CSS：.gc-row/.gc-list/.gc-pal/.gc-name/.gc-more/.gc-auto-meta 死选择器清理；新增 .gc-pick/.gc-sel/.gc-pickcolor
- [x] 新用例 test/cases/settings-ui-slim.js（88 断言全绿）并登记进 run.js CASE_FILES
- [x] 断言反向守卫改写：palette-auto 1.9/1.9a/1.11/1.11b/1.11c/1.12/1.12b、5.5/5.5a/5.6/5.7、10.2/10.3/10.3b/10.4；zoom-table-align 6.11/6.11a/6.11b/6.11c
- [x] 文档同步：js/help.js（去参考数描述 + 新改色路径）、使用说明.md（6 处）、i18n-dict-panels.js 新增「自定义…」
- [x] 全量回归：18 用例 / 1354 断言全绿（基线 1257 → +97），耗时 101.5s
- [x] 有效性自证（--app= 指向 bak 还原副本，副本 md5 == 备份、!= 现行）：
      settings-ui-slim 红 18 条 + 1 异常；palette-auto 红 11 条（128/139 绿）；zoom-table-align 红 3 条（45/48 绿）
- [x] 实测高度（12 组 · box）：3 · 防拥挤合并组 122px → 70px（-52px，子元素 3 → 2）；分组配色块 519px → 174px（-345px）；hist 组 137px 不变
- [x] 截图 3 张（cache/scratch，未进 YMS-App）：shot_uidiet_1_group6.png / shot_uidiet_2_open.png / shot_uidiet_3_merge.png
- [ ] 未重打包 YMS-App-免安装版.zip（任务书本轮未要求，留待下一轮随交付说明一起打）
