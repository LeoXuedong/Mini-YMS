/* ==========================================================================
   YMS · js/core/i18n-dict-chrome.js
   词库（外壳）：顶栏 / 菜单栏 / 菜单项 / 快捷方式 / 表格列表 / 状态栏 / toast
   —— 纯数据，由 YMS.I18n.reg / regPatterns 在加载时合并。
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  if (!YMS.I18n) return;
  /* ---------------------------------------------------------------- 字典 */
  /* 约定：
       · 左边 = 源码里的**中文原文逐字**（含全角标点、空格），否则命中不了；
       · 右边 = 工具型英文：简短、动词开头、首字母大写、菜单项不加句号；
       · 带变量（表名 / 行列数 / 文件名 / 秒数）的串走下方 PATTERNS，$1… 原样保留用户数据；
       · 用户数据（文件名、列名、单元格、输入值）一律不建键 —— 单元格与输入框已由
         i18n.js 的 SKIP_SELECTOR 跳过，这里也不为纯数据片段建键。 */
  var DICT = {
    /* ===== 1. 顶栏（品牌 / 芯片 / 动作按钮） ===== */
    '良率管理系统': 'Yield Management System',
    'Yield Management System · 离线数据分析工具': 'Yield Management System · Offline data analysis tool',
    '未载入数据': 'No data loaded',
    '0 行 × 0 列': '0 rows × 0 cols',
    '数据视图': 'Data view',
    '使用说明': 'Help',
    '主题': 'Theme',
    '当前文件': 'Current file',
    '行 × 列': 'Rows × cols',
    '当前视图': 'Current view',
    '切换主题（点击依次轮换）': 'Switch theme (click to cycle)',

    /* ===== 2. 菜单栏：Data ===== */
    '导入数据（CSV / TXT / Excel / .yms）': 'Import data (CSV / TXT / Excel / .yms)',
    '导出数据（CSV / Excel）': 'Export data (CSV / Excel)',
    '保存当前数据': 'Save current data',
    '保存处理后数据 + 格式 + 绘图（.yms）': 'Save processed data + formats + plots (.yms)',
    '导出 PPT 报告（按 Page 分页，含全部图表）': 'Export a PPT report (one slide per Page, all charts)',

    /* ===== 2. 菜单栏：Plot（与快捷方式 title 共用同一译名） ===== */
    '折线图': 'Line chart',
    '箱线图': 'Box chart',
    '柱状图': 'Bar chart',
    '直方图': 'Histogram',
    '散点图': 'Scatter chart',

    /* ===== 2. 菜单栏：Table（10 个转换入口） ===== */
    'Pivot · 透视（长→宽）': 'Pivot · Long to wide',
    '唯一值展开成新列，缺组合留空': 'Expand unique values into columns; missing combinations left blank',
    'Unpivot · 逆透视（宽→长）': 'Unpivot · Wide to long',
    '多列折叠成「变量 / 值」两列': 'Fold multiple columns into "Variable / Value"',
    'Transpose · 转置': 'Transpose · Swap rows and columns',
    '行列互换（可选某列作新表头）': 'Swap rows and columns (optionally use a column as header)',
    'Vertical Concat · 纵向连接': 'Vertical Concat · Stack tables',
    '多表上下拼接（并集 / 交集）': 'Stack tables vertically (union / intersection)',
    'Horizontal Concat · 横向连接': 'Horizontal Concat · Place side by side',
    '多表并排 / 按关键列对齐': 'Place tables side by side / align by key column',
    'Join · 表连接': 'Join · Key-based join',
    '按键连接（内 / 左 / 右 / 外）': 'Join by key (inner / left / right / outer)',
    'Split Column · 分列': 'Split Column · One to many',
    '按分隔符把一列拆成多列': 'Split one column into several by delimiter',
    'Merge Columns · 合并列': 'Merge Columns · Many to one',
    '多列合并成一列': 'Merge multiple columns into one',
    'Group Aggregate · 分组汇总': 'Group Aggregate · Group and summarize',
    '按列分组做 sum / mean / count …': 'Group by columns, then sum / mean / count …',
    'Dedupe · 去重': 'Dedupe · Remove duplicates',
    '按列去重（保留首行 / 末行）': 'Dedupe by column (keep first / last)',
    '请先导入数据': 'Import data first',

    /* 转换面板标题（派生表右键的子标题也用它，见 table-view.js 的 transformTitle） */
    '透视（长 → 宽）': 'Pivot (long → wide)',
    '逆透视（宽 → 长）': 'Unpivot (wide → long)',
    '转置': 'Transpose',
    '纵向连接（多表拼接）': 'Vertical concat (stack tables)',
    '横向连接（并排 / 按列）': 'Horizontal concat (side by side)',
    '表连接 Join': 'Join',
    '分列': 'Split column',
    '合并列': 'Merge columns',
    '分组汇总': 'Group aggregate',
    '去重': 'Dedupe',

    /* ===== 4. 原始表格区 / 数据显示区 ===== */
    '原始表格区': 'Raw Data',
    '右键参数查看属性': 'Right-click a column',
    '右键管理': 'Right-click to manage',
    '尚无表格': 'No tables yet',
    '尚未载入数据': 'No data loaded',
    '数据显示区': 'Data Grid',
    '共 0 行': '0 rows total',
    '· 派生': '· Derived',
    '空表': 'empty table',
    '数据表': 'Table',

    /* ===== 6. 分页器 ===== */
    '首页': 'First',
    '上一页': 'Prev',
    '下一页': 'Next',
    '末页': 'Last',
    '每页行数': 'Rows per page',
    '输入页码后回车': 'Enter page number, then press Enter',
    '视图行号': 'View row number',

    /* ===== 7. 状态栏 ===== */
    '就绪': 'Ready',
    '就绪 · 请通过 Data → Data Import 导入数据（CSV / TXT / Excel / .yms）；示例数据见包内 sample/sample_yield_data.csv':
      'Ready · Import data via Data → Data Import (CSV / TXT / Excel / .yms); sample data at sample/sample_yield_data.csv',
    '未过滤': 'Unfiltered',
    '无可用数据': 'No data available',
    '绘图：无可用数据': 'Plot: no data available',
    '绘图：请在上方「数据映射」中选择 X Label 与 Value，然后点击 Submit':
      'Plot: choose X Label and Value in "Data Mapping" above, then click Submit',
    '尚未绘图 —— 请在右侧「绘图设置区」配置 X Label / Value 后点击': 'No chart yet — set X Label / Value in Plot Settings, then click',

    /* ===== 5. 表格列表右键菜单 ===== */
    '修改转换设置…': 'Edit transform settings…',
    '设为当前': 'Set as Active',
    '当前表': 'Active table',
    '重命名': 'Rename',
    '新表名': 'New table name',
    '复制': 'Duplicate',
    '名称加 _copy': 'Name gets _copy',
    '导出 CSV': 'Export CSV',
    '删除': 'Delete',
    '需二次确认': 'Requires confirmation',
    '确定': 'OK',
    '取消': 'Cancel',

    /* 表格右键触发的确认框 / toast（table-view.js） */
    '删除表格': 'Delete Table',
    '确定删除表格': 'Delete table',
    '删除后不可恢复。': 'This cannot be undone.',
    '已删除表格': 'Deleted table',
    '已重命名为': 'Renamed to',
    '（重名自动加序号）': '(duplicate name auto-numbered)',
    '已复制为': 'Duplicated as',
    '复制失败': 'Duplicate failed',
    '重命名失败：表格不存在': 'Rename failed: table not found',
    '该表没有可导出的数据行': 'This table has no rows to export',
    '导出失败（导出模块未就绪）': 'Export failed (exporter not ready)',
    '转换模块未加载': 'Transform module not loaded',
    '列操作模块未加载': 'Column ops module not loaded',

    /* ===== 8. toast / 状态提示（外壳动作） ===== */
    '已导入': 'Imported',
    '报告导出完成': 'Report exported',
    '当前没有可显示的数据': 'No data to display',
    '无缺失': 'No missing',
    '字符（char）': 'Text (char)',
    '数值（number）': 'Numeric (number)',
    '时间（time）': 'Time (time)'
  };

  /* ------------------------------------------------- 主题名（固定注册表） */
  /* app.js 的 THEMES 是写死的 5 套；主题按钮 title / aria-label / toast 都用这两个名字拼接，
     规则替换不会回头翻译 $1 里的中文，所以这里把 5×5 组合全部展开成精确键。 */
  var THEME_ZH = ['企业蓝', '暗色仪器', '瑞士网格', '离子深色', '纸白'];
  var THEME_EN = ['Enterprise Blue', 'Dark Instrument', 'Swiss Grid', 'Ion Dark', 'Paper White'];
  (function () {
    for (var i = 0; i < THEME_ZH.length; i++) {
      DICT[THEME_ZH[i]] = THEME_EN[i];
      DICT['主题：' + THEME_ZH[i]] = 'Theme: ' + THEME_EN[i];
      for (var j = 0; j < THEME_ZH.length; j++) {
        DICT['当前主题：' + THEME_ZH[i] + '（点击切换到：' + THEME_ZH[j] + '）'] =
          'Current theme: ' + THEME_EN[i] + ' (click to switch to: ' + THEME_EN[j] + ')';
        DICT['切换主题，当前 ' + THEME_ZH[i] + '，点击切换到 ' + THEME_ZH[j]] =
          'Switch theme · current: ' + THEME_EN[i] + ' · next: ' + THEME_EN[j];
      }
    }
  })();

  /* -------------------------------------------------------------- 动态规则 */
  /* 顺序有意义：越具体的放越前（全部 ^…$ 锚定，不会互相截断）。 */
  var PATTERNS = [
    /* --- 导入 / 导出 / 模板（状态栏 + toast；文件名 $1 是用户数据，原样保留） --- */
    { re: /^已导入 (.+)：([\d,]+) 行 × ([\d,]+) 列$/, en: 'Imported $1: $2 rows × $3 cols' },
    { re: /^：([\d,]+) 行 × ([\d,]+) 列 · ([\d,]+) 行\/秒$/, en: ': $1 rows × $2 cols · $3 rows/s' },
    { re: /^：([\d,]+) 行 × ([\d,]+) 列$/, en: ': $1 rows × $2 cols' },
    { re: /^已导入 ([\d,]+) 张表：(.+)$/, en: 'Imported $1 tables: $2' },
    { re: /^已恢复模板 (.+)：([\d,]+) 行 × ([\d,]+) 列$/, en: 'Template restored $1: $2 rows × $3 cols' },
    { re: /^已保存模板：(.+)（([\d,]+) 行 × ([\d,]+) 列）$/, en: 'Template saved: $1 ($2 rows × $3 cols)' },
    { re: /^已导出 CSV：(.+)（([\d,]+) 行 × ([\d,]+) 列）$/, en: 'CSV exported: $1 ($2 rows × $3 cols)' },
    { re: /^已导出 Excel：(.+)（([\d,]+) 行 × ([\d,]+) 列）$/, en: 'Excel exported: $1 ($2 rows × $3 cols)' },
    { re: /^已导入 ([\d,]+) 张表（([\d,]+) 行）· 见左侧表格列表$/, en: 'Imported $1 tables ($2 rows) · see the table list on the left' },

    /* --- M-3 空导入语义（情形 A：取消导入；情形 B：只有表头） --- */
    { re: /^这份文件没有可导入的数据（0 行 × 0 列），已取消导入，当前数据未受影响$/, en: 'This file has no data to import (0 rows × 0 cols); import cancelled, current data untouched' },
    { re: /^这份 \.yms 模板没有可导入的数据（0 行 × 0 列），已取消导入，当前数据未受影响$/, en: 'This .yms template has no data to import (0 rows × 0 cols); import cancelled, current data untouched' },
    { re: /^工作表「(.+)」没有可导入的数据（0 行 × 0 列），已取消导入，当前数据未受影响$/, en: 'Worksheet "$1" has no data to import (0 rows × 0 cols); import cancelled, current data untouched' },
    { re: /^已导入 (.+)：只有表头（仅列定义，0 行数据）$/, en: 'Imported $1: header only (column definitions, 0 data rows)' },
    { re: /^：只有表头（仅列定义，0 行数据）$/, en: ': header only (column definitions, 0 data rows)' },
    { re: /^已导入 (.+)：仅列定义，0 行数据$/, en: 'Imported $1: column definitions only, 0 data rows' },
    { re: /^已恢复模板 (.+)：([\d,]+) 行 × ([\d,]+) 列（仅列定义，0 行数据）$/, en: 'Template restored $1: $2 rows × $3 cols (column definitions only, 0 data rows)' },

    /* --- M-4 重复列名自动改名：改名前缀（中文）后面拼的是「已译成当前语言」的改名说明，
           所以这里按「中文前缀 + 目标语言明细」整串匹配，避免混排 --- */
    { re: /^已导入 (.+)：([\d,]+) 行 × ([\d,]+) 列 · (Header had .+)$/, en: 'Imported $1: $2 rows × $3 cols · $4' },
    { re: /^已恢复模板：(.+)（([\d,]+) 行 × ([\d,]+) 列） · (Header had .+)$/, en: 'Template restored: $1 ($2 rows × $3 cols) · $4' },
    { re: /^导入提示：(Header had .+)$/, en: 'Import note: $1' },

    /* --- 表格项 title（表名 $1 是用户数据）：名称 · R 行 × C 列 · 来源/变换 X --- */
    { re: /^(.+) · ([\d,]+) 行 × ([\d,]+) 列 · 来源 (.+)$/, en: '$1 · $2 rows × $3 cols · Source $4' },
    { re: /^(.+) · ([\d,]+) 行 × ([\d,]+) 列 · 变换 (.+)$/, en: '$1 · $2 rows × $3 cols · Transform $4' },
    { re: /^(.+) · ([\d,]+) 行 × ([\d,]+) 列$/, en: '$1 · $2 rows × $3 cols' },
    { re: /^(.+) · 空表$/, en: '$1 · empty table' },

    /* --- 顶栏芯片 / 状态栏行数 --- */
    { re: /^([\d,]+) 行 × ([\d,]+) 列$/, en: '$1 rows × $2 cols' },
    { re: /^([\d,]+) \/ ([\d,]+) 行$/, en: '$1 / $2 rows' },
    { re: /^([\d,]+) 行$/, en: '$1 rows' },

    /* --- 表格列表标题 / 数据显示区计数 --- */
    { re: /^表格（([\d,]+)）$/, en: 'Tables ($1)' },
    { re: /^共 ([\d,]+) 行（原始 ([\d,]+) 行）$/, en: '$1 rows total ($2 raw)' },
    { re: /^共 ([\d,]+) 行$/, en: '$1 rows total' },

    /* --- 分页器 --- */
    { re: /^\/ ([\d,]+) 页$/, en: '/ $1 pages' },

    /* --- 状态栏过滤 / 绘图 --- */
    { re: /^过滤后 ([\d,]+) 行$/, en: '$1 rows after filtering' },
    { re: /^绘图完成：([\d,]+) 张图（([\d,]+) 页）$/, en: 'Plots rendered: $1 charts ($2 pages)' },
    { re: /^绘图完成：([\d,]+) 张图$/, en: 'Plots rendered: $1' },
    { re: /^绘图视图 · (.+)$/, en: 'Plot view · $1' },
    { re: /^数据中存在 ([\d,]+) 个缺失值$/, en: '$1 missing values in data' },
    { re: /^每页 ([\d,]+) 行，仅渲染当前页；大数据翻页可能较慢$/, en: '$1 rows per page — only the current page is rendered; paging through large data may be slow' },

    /* --- 转换结果 toast --- */
    { re: /^已生成 (.+)（([\d,]+) 行 × ([\d,]+) 列）$/, en: 'Created $1 ($2 rows × $3 cols)' },
    { re: /^已更新 (.+)（([\d,]+) 行 × ([\d,]+) 列）$/, en: 'Updated $1 ($2 rows × $3 cols)' },
    { re: /^提示：(.+)$/, en: 'Notice: $1' },
    { re: /^提示 ([\d,]+) 条，详见下方「处理说明」$/, en: '$1 notices — see "Processing notes" below' },

    /* --- 删除确认框里的「（3 行 × 3 列）？」 --- */
    { re: /^（([\d,]+) 行 × ([\d,]+) 列）？$/, en: '($1 rows × $2 cols)?' },

    /* --- 列参数清单（.raw-item 整块被跳过，这里只兜底表头 title 与缺失徽标） --- */
    { re: /^(.+) · 缺 ([\d,]+)$/, en: '$1 · $2 missing' },
    { re: /^缺 ([\d,]+)$/, en: '$1 missing' },

    /* --- 失败提示（前缀固定，冒号后是错误原文 / 文件名 / 表名） --- */
    { re: /^操作失败：(.+)$/, en: 'Operation failed: $1' },
    { re: /^脚本错误：(.+)$/, en: 'Script error: $1' },
    { re: /^未处理异常：(.+)$/, en: 'Unhandled error: $1' },
    { re: /^导入失败：(.+)$/, en: 'Import failed: $1' },
    { re: /^导出失败：(.+)$/, en: 'Export failed: $1' },
    { re: /^报告导出失败：(.+)$/, en: 'Report export failed: $1' },
    { re: /^拖拽导入失败：(.+)$/, en: 'Drag-and-drop import failed: $1' },
    { re: /^重命名失败：(.+)$/, en: 'Rename failed: $1' },
    { re: /^原始表格区渲染失败：(.+)$/, en: 'Raw tables render failed: $1' },
    { re: /^数据显示区渲染失败：(.+)$/, en: 'Data grid render failed: $1' },
    { re: /^绘图渲染失败：(.+)$/, en: 'Plot render failed: $1' }
  ];

  YMS.I18n.reg(DICT);
  YMS.I18n.regPatterns(PATTERNS);
})(window);
