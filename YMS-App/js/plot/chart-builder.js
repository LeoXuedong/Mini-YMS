/* ==========================================================================
   YMS · plot/chart-builder.js
   ---------------------------------------------------------------------------
   职责：把 Aggregate 的「单图数据（chart）」构建成 ECharts option：
     · 科研质感调色板 + 注册 'yms-registered' 主题（registerTheme）
     · 标题 / 副标题（合并信息 + 拟合公式与 R² + 抽稀提示，多行 \n）
     · 轴：由 YMS.Axis 生成（智能轴 + 抗拥挤 + 轴标题留白），并按样式应用
       字号 / 粗细 / 颜色 / 小数位 / 时间样式 / Y Min·Max / 对数轴
     · 系列：line / bar（含 Hist 用 bar 呈现）/ scatter / boxplot
       Box 且 style.boxMedianLine → 追加 name='中位数连线' 的 line 系列
       拟合曲线（chart.fit）→ 追加 line 系列（showSymbol:false, z:10，颜色区分）
     · tooltip：分类轴 trigger:'axis'，散点 trigger:'item'，显示系列名 + X + Y
     · grid：由 Axis 的 gridBottom / gridLeft / gridRight 与标题块高度推导
     · 四边外框（迭代 2）：主轴（下/左）之外补上边 X / 右边 Y 两条「外框轴」——
       axisLine.show:true（与主轴同色、宽 1）、axisTick/axisLabel/splitLine 全隐藏、silent:true；
       上边轴与主轴同刻度数据；外框轴一律**追加在最后**（契约 §3.3）
     · 智能 Y 范围（迭代 2 + 迭代 4 修复）：默认（yMin/yMax 皆空）且非对数轴时，按本图实际
       绘制的数值调用 Axis.smartRange（hist 下限固定 0）；用户显式填 Min/Max 时一律以用户
       为准（左轴）；结果写入 option.__yRange / option.__yRanges 供自测
     · 内部网格线仅由 style.showGrid 控制（默认 false），不影响外框（外框永远显示）

   迭代 4（docs/DEV-SPEC-迭代4.md §3.3）：
     1) 多 Y 轴：每条 series 带 yAxisIndex（0=左轴 / 1=右轴，只用 0/1）。
        option.yAxis 顺序固定：[0] 左轴（必有）→ [1] 右轴（仅当有 series 挂右轴时才存在）
        → 外框轴追加在最后。右轴 position:'right'、name = 挂右轴的数据名连接；
        左右轴各自独立执行智能范围（只按挂在该轴上的 series 计算；右轴恒为自动范围，
        用户 Min/Max 只作用于左轴 —— 面板只有一个 Min/Max 控件，见完成报告"已知限制"）。
     2) 横轴统计行（stats.show）：仅分类轴图型（line/bar/box/hist）生效，用多行
        xAxis.axisLabel 实现（第 1 行类别名 + 每勾选量一行）；统计量按 vcols[0] 计算
        （与"Box 中位数连线只用首个 Value 列"的既有约定一致）；grid.bottom 按行数
        +13px/行 增大；关闭时完全恢复现状（回归红线）。
        文本形如 'Mean 93.21' / 'Median 93.40' / 'Std 1.02' / 'RNG 4.10' / 'Nu% 1.09' /
        'N 512' / 'Min 89.1' / 'Max 93.2' / 'Q1 …' / 'Q3 …'；Nu% = Std / |Mean| × 100
        （用**已打印的** Std 与 Mean 数值计算，保证标签自洽）。
     3) 颜色/符号分组：series 颜色由 group.colorBy 取值映射（同值同色、不同值不同色，
        取 PALETTE/派生色），符号由 group.symbolBy 取值映射（SYMBOLS 常量）；
        两列留空 = 保持现状（按 series 序号取 PALETTE + line 用 circle）。
     4) 叠加同图（display='overlay'）：同图多 series，名称含组标签（= Aggregate.seriesKey）。

   迭代 5（显示抗拥挤 · 图例）：
     · 图例条目数（去重后的 series 名数量）> LEGEND_SCROLL_MIN(6) 时，legend.type='scroll'
       且 legend.height = LEGEND_SCROLL_MAX_H(44px) ≈ 2 行 —— 高基数列（如 colorBy='Lot'）
       产生的几十条图例不再铺满半屏；layoutBox 按同一高度预留 grid.top，保证不遮挡数据区。
     · 条目 ≤ 6 时完全保持现状（普通单行图例，无 height/type）—— 回归红线。

   迭代 6（箱宽自适应 + 统计行左置表头）：
     · A) 箱宽（Box 间距）：箱线图的 boxWidth 不再写死 [8,32]，改为按**当前类别带宽**自适应 ——
       band = 绘图区宽 / 类别数，上限 = clamp(round(band × 0.72), 2, 32)，下限 2px（避免消失），
       最终写成 [2, 上限] 数组交给 ECharts。ECharts 的箱线布局本身为
       「实际箱宽 = min(max(自然槽宽, 下限), 上限)」，自然槽宽 = 0.8 × 真实带宽 − 2
       （多 Value 同图时 ECharts 自动把多个 boxplot 系列并排、总占用仍 = 0.8 × 带宽 − 2），
       故实际箱宽恒 ≤ 0.8 × 带宽 → **相邻 Box 两侧永远留有空隙、绝不接触**（实测见 iter6 自测）。
       绘图区宽：浏览器内量取首张卡片真实 .chart-body 宽度（同一网格列宽一致）减去 grid 左右留白；
       无 DOM（Node sandbox / 未渲染）时回退 ASSUME_PLOT_W(520) —— 见 estimatePlotWidth。
     · B) X 轴标签与 Box 一一对应：轴侧策略见 axis.js 迭代 6（interval:'auto' + hideOverlap:true，
       仅类别 > 200 才退回固定抽稀）。本文件不再做任何按索引抽稀。
     · C) 统计行「名称与数值分离」：
         - 刻度标签只写数值：statLinesFor 产出每类「纯数值行」（'\n' 连接，行序 = stats.items
           = Aggregate.STAT_ORDER），如 '93.21\n1.02\n4.10\n1.09\n512'；不再重复写 'Mean 93.21'。
         - 名称移到 X 轴最左侧的固定表头（ECharts graphic 元素）：第 1 行 = X 轴列名（如 'Lot'），
           其后每行 = 一个启用的统计量名（Mean/Median/Std/RNG/Nu%/N/Min/Max/Q1/Q3），
           顺序与数值行严格一致 → 与右侧数值行**逐行对齐**（同字号、同行高 13px）。
         - 接口分工（必须与 axis.js 顶部注释一致）：
             chart-builder → Axis.categoryAxis(cats, { statLines, statHeader, measurePx })
             Axis 返回 xRes.header = { text, rows, fontSize, lineHeight, width, colW, rightX, bottom,
                                       leftX, statMode, rotate, rowH, rotH, labelPx, labelTop,
                                       gridLeftExtra }（无统计行时为 null）
             chart-builder → 把 grid.left 加上 header.gridLeftExtra；行名 / 数值行 / 方框统一由
                             axisTableLayout() + axisBlockGraphic() 画出（迭代 9 起，取代迭代 6 的
                             headerGraphic 单块多行文本）
         - 关闭统计行（stats.show=false）时：无 statLines、无 statHeader、无 graphic、无 grid.left
           额外预留 —— 行为与迭代 5 完全一致（回归红线）。

   禁止在本文件内创建 ECharts 实例（实例由 PlotView / Fullscreen 管理）。
   调用签名：buildOption(chart, work, index)  —— chart 为 Aggregate.chartOf() 的结果；
             为容错也支持 buildOption(work, index)（内部自行取 chartOf）。
  迭代 7（图内无标题 + X 轴旋转消费 + 数据表格）：
     · A) 图内 Title 置空：opt.title.text = ''（卡片头 .card-title / 页签仍显示标题，那是 DOM 层）；
        opt.title.subtext 只保留拟合公式 / 抽稀提示等行（「合并…」那行已由 aggregate 移除）。
     · B) 消费 style.xRotate（0|30|45|60|90|'auto'）：交由 Axis.categoryAxis 处理（本文件只透传
        style）；轴侧规则见 axis.js 迭代 7。
     · C) 数据表格（plot.table.show）：在绘图区**下方**用 ECharts graphic 画一张真表格 ——
        行：第 1 行 = 表头（每个可见类别一列，写类别名）；其后每个 Value 系列一行（行名 = 图例里
        的系列名，值 = 该系列该类别下的**图面聚合值**：line/bar 用 mean、box 用 median、
        hist 用频数）；stats.show 同时开启时再接上勾选的统计量行（作用于 vcols[0]）。
        列：与 X 轴类别带同源 —— 列中心 = grid.left + (i + 0.5) × band
        （band = (容器宽 − grid.left − grid.right) / 类别数）→ 每列恒对准其正下方的 Box / 刻度；
        列数放不下时按几何抽稀（每列最小 TABLE.MIN_COL_W px，超出即每 ceil(类别数/可放列数)
        列画 1 列 —— 画出来的列永远对准其 Box）。
        样式：表头 / 行头底色 = --panel-alt（运行时读 CSS 变量，取不到用兜底色）、行间浅色分隔线、
        数值右对齐、列宽相等、字号 10.5px。
        纵向：表格底边距容器底边 TABLE.PAD_BOTTOM（全屏视图让开底部 dataZoom slider），
        表格高度计入 grid.bottom —— 与容器高度无关，缩放不错位。
        第五轮（用户需求「把合并显示的分组行 + 横轴参数行和最下方的统计行对调」）：
        行序改为**自上而下** = 统计量行（顺序仍按 STAT_ORDER）→ 系列行 → 分组行（级 0 起，N 级）
        → 横轴参数行（叶子类别名 + 左侧列名，最下一行）。行数 nAll 不变（数据行 + 表头 + N 行
        分组行），只改纵向顺序；**左侧行名列与自己的行共用同一槽位**，故不会错位。
        槽位唯一来源 = tableRowSlots()；元数据 option.__table.layout = { order, nStat, nSeries,
        groupRowCount, headerSlot, statBottoms[], seriesBottoms[], groupBottoms[], headerBottom }
        —— bottom 为 graphic 实际绘制值（越大越靠上），自测断言
        Math.min(statBottoms) > Math.max(groupBottoms)（= 统计行整体在分组行上方）。
        关闭表格（plot.table.show=false）的轴层通道**不受影响**，仍按迭代 6 / 28 的顺序绘制。
        开启表格时 X 轴刻度标签**只显示类别名**（统计数值移入表格），关闭时与迭代 6 完全一致。
  迭代 8（需求 5：横轴坐标表格方框 · 含左侧行名）：
     · 新增配置字段 **plot.table.frame**（布尔，**默认 false**；由 store.js defaultTable() 提供，
       设置区控件 id = #ps-table-frame，文案「表格方框（含左侧行名）」）。
       true = 给「横轴坐标表格」画**完整方框 + 行·列分隔线**，并把**左侧行名列框进框内**；
       false = 与迭代 6 / 迭代 7 现状**逐元素一致**（回归红线：不新增任何 graphic 元素）。
     · 「横轴坐标表格」按当前生效的形态自动选择（两者互斥，因为开启数据表格时统计数值已移入表格）：
         ① 数据表格开启（plot.table.show=true）→ 作用域 = 迭代 7 的表格区块
            （tableGraphic(m, frame=true)）：在既有上下外框 / 行分隔线 / 单元格竖线之外，
            补上 **左外框、右外框、行头列分隔线** 三条竖线 → 完整方框，行名列（行头列）落在框内。
         ② 数据表格未开启但统计行开启（stats.show=true）→ 作用域 = axisTableLayout() 描述的区块：
            left = 行名列左边界、rowHeadRight = 行名文字实测宽 + 内边距、right = 绘图区右缘
            （旋转非零时按旋转标签包围盒外扩，上限容器右缘）、
            bottom / height 由**最终 grid.bottom + 字号**推导（见迭代 9）。
            axisBlockGraphic() 画 4 条外框 + (rows-1) 条行分隔线 + 1 条行名列分隔线 + 列分隔线
            （类别带边界，几何抽稀，上限 FRAME_MAX_COLS 条）→ 左侧行名列同样在框内。
     · 关闭（默认）时 **完全不构建几何、不产生 graphic 元素**，故默认渲染与迭代 7 逐元素一致。
     · 自测可读元数据（ECharts 忽略未知顶层字段）：
         option.__table.frame / option.__table.frameEdges        ← 数据表格形态
         option.__axisTable = { on, frame, mode, left, right, bottom, height, base, labelTop, rotH,
                                rows, statRows, rowH, rowHeadRight, colW, rotate, fontSize,
                                colLines, rowLines, edges, frameLines, elements,
                                numRows, numColsDrawn, numColsSkipped, rowHeadInsideFrame, reason }
         option.__axisTableSpec                                  ← 重算用规格（全屏 reflowAxisTable）

   迭代 9（三条报障的修法 · 只旋转类别名 / 方框包住全部内容 / 全屏行名与数据行对齐）：
     · A) 旋转非零且启用统计行时，X 轴刻度标签**只写类别名**（axis.js 的 statMode='graphic'）；
          统计数值改由 graphic **水平逐行**绘制在旋转标签块**下方**（每统计量一行，行高 = 字号×1.18，
          与左侧行名同源）；每列数值水平居中于该类别带中心（与 Box / 刻度对齐）；
          数值列按几何**贪心抽稀**（宁可缺一个也不重叠；列太密不降精度，只有数值宽于整个数值区
          才降精度，仍放不下则整列不绘）。
          rotate === 0 时一律保持迭代 6~8 的现状（多行标签 + 单块多行表头）—— 回归红线，逐值不变。
     · B) 方框包住全部内容：行名列宽 = 行名文字**实测宽度**（canvas measureText）+ 内边距
          （'Mean' 不再被裁、分隔线不压字）；方框上边 = 旋转标签块顶端（不旋转 = 标签首行顶端）
          + FRAME_PAD_T(2)，下边 = 最后一行数值底部 - FRAME_PAD_B(2)；
          右边界按旋转标签包围盒外扩（ROT_SPILL_PAD = 4px），上限「容器宽 - 1」；
          grid.bottom 由 axis.js 按「标签块 + 数值行 + 标题留距 + 余量」给出（上限 280）。
     · C) 全屏对齐：enhanceOption 抬高 grid.bottom（+34）/ 放大字号（+2）之后，fullscreen.js 调
          ChartBuilder.reflowAxisTable(option) —— 按**最终** grid.bottom + 字号重算全部行锚点并
          替换 graphic 元素（labelTop = 最终 grid.bottom − 7 单一来源），
          卡片与全屏的行名行 ↔ 数值行像素中心偏差实测 ≤ 0.5px（曾错位 34px）。
   迭代 10（设置与对齐）：
     · C) 行名列与上方 Y 轴区左右边界对齐：axisTableLayout 的 rowHeadRight 由「文字宽 + 内边距」
          改为**绘图区左边界 gridLeft**（左边界仍 = 容器左缘 + FRAME_LEFT = 4）→ 行名列宽度 = 整个
          左侧留白（gridLeft − 4），行名右对齐到 gridLeft − 3；表格主体本就自 gridLeft 起，
          故方框的左侧区域与主体连成一张表、中间不再留 70px 缺口。
          axis 模式（rotate=0）的单块多行文本同步按「块右边界 = 锚点」定位（此前块左边界 = 4，
          名字贴在容器最左）；graphic 模式（旋转非零）本来就按锚点定位，无需改动。
   迭代 13（用户报障「横轴 label 与数据显示需要对齐」）：
     · graphic 模式下数值的抽稀不再自成一套：与类别名**共用** YMS.Axis.keptIndices 给出的
       kept 集合（类别名足迹 vs 数值足迹，两者都放得下才保留），并把这个集合用**函数**形式
       装进 xAxis.axisLabel.interval（keptIntervalFn）——于是「显示的类别名」恰好等于
       「画出数值的类别」，一一对应；数值位置仍严格对准该类别中心。
     · 全屏 / dataZoom 重算（reflowAxisTable）会用新几何重新算 kept 并同步回 interval，
       避免「标签按旧集合、数值按新几何」再次错位。
     · axis 模式（xRotate=0 且 stats.rotate=0）完全不动：interval 仍 'auto'，数值在同一个
       多行标签文本块里，天然对齐（回归红线）。
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;

  /* --------------------------------------------------------------- 调色板 */
  /* 科研质感：冷蓝 / 青绿 / 铜金 / 紫 / 砖红 / 钢灰 */
  var PALETTE = ['#0b6e99', '#0f9d8f', '#b8860b', '#7b5ea7', '#c0392b', '#4a6fa5', '#8a6d3b', '#2f7d5c'];
  var FIT_PALETTE = ['#b8860b', '#c0392b', '#7b5ea7', '#0f9d8f', '#4a6fa5', '#8a6d3b'];
  var MEDIAN_COLOR = '#c0392b';
  var PALETTE_ALT = PALETTE.concat(['#3a8dbe', '#6b8f71', '#a3563b', '#5b6bab']);
  /* 分组符号（契约 §3.3：SYMBOLS 常量） */
  var SYMBOLS = ['circle', 'rect', 'roundRect', 'triangle', 'diamond', 'pin', 'arrow'];

  var AXIS_COLOR = '#b6c0c9';
  var GRID_COLOR = '#e9edf0';
  /* 迭代 5（显示抗拥挤）：图例条目多时改为「可滚动 + 限高 2 行」，grid.top 相应让位（不遮挡数据区） */
  var LEGEND_SCROLL_MIN = 6;      // 条目 ≤ 6：保持现状（单行普通图例 —— 回归红线）
  var LEGEND_SCROLL_MAX_H = 44;   // 条目 > 6：图例限高 ≈ 2 行（2 × 行高 16 + itemGap 12）
  var TOOLBOX = {
    show: true, right: 10, top: 4, itemSize: 13,
    feature: {
      restore: { show: true, title: '还原（重置缩放）' },
      saveAsImage: {
        show: true, title: '保存为图片', name: 'YMS-Chart',
        backgroundColor: '#ffffff', pixelRatio: 2, excludeComponents: ['toolbox']
      }
    }
  };

  /* ------------------------------------------------------------- 小工具 */
  function num(v, dft) {
    var n = Number(v);
    return (v === null || v === undefined || v === '' || !isFinite(n)) ? dft : n;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  /** 单值是否「没有数」：null / undefined / '' / 窗口外占位 '-' / 非有限数（任务 H ② tooltip 用） */
  function nilVal(v) {
    if (v === null || v === undefined || v === '') return true;
    if (typeof v === 'string' && v.trim() === '-') return true;
    return !isFinite(Number(v));
  }
  /** 箱线图五数是否全都有值（任缺一致 = 该系列在该类别没有数据 → tooltip 整行不列出） */
  function boxFiveFilled(arr) {
    if (!arr || arr.length < 5) return false;
    for (var i = 0; i < 5; i++) if (nilVal(arr[i])) return false;
    return true;
  }

  /* --------------------------------------------- 箱宽自适应（迭代 6 · A） */
  /* ECharts 箱线布局（vendor/echarts.min.js BoxplotLayout）：
       band   = 分类轴真实带宽 = 绘图区宽 / 类别数
       h      = 0.8 × band − 2                      ← 同轴全部 boxplot 系列的总占用宽度
       槽宽 p = (h − c × (系列数−1)) / 系列数，c = h / 系列数 × 0.3（系列之间自动错位）
       实际箱宽 = min(max(p, boxWidth[0]), boxWidth[1])
     故：把下限压到 2px（旧值 8px 正是「band < 8 时相邻 Box 相互压叠」的根因），
         上限取 clamp(band × 0.72, 2, 32)（少类别时不至于过宽）→ 实际箱宽恒 ≤ 0.8 × band，
         两侧必然留白，且多系列自动并排互不重叠。 */
  var BOX_MIN_W = 2;             // 箱宽下限（px）：极窄带宽下箱体不消失
  var BOX_RATIO = 0.72;          // 箱宽 / 带宽
  var BOX_MAX_W = 32;            // 箱宽上限（px）
  /* ---------------------------------------------------------- 任务 F 常量 */
  /* 图例默认图元尺寸 —— 与 store.js 的 DEFAULT_LEGEND 必须逐项相等（零视觉变化的来源） */
  var LEGEND_ITEM_W = 14;
  var LEGEND_ITEM_H = 9;
  var LEGEND_ITEM_GAP = 12;
  var LEGEND_TEXT_COLOR = '#4a5866';
  var LEGEND_SIDE_GAP = 10;      // left/right：图例矩形与绘图区之间的横向间距
  var LEGEND_BOTTOM_GAP = 8;     // bottom：图例矩形与绘图区（含轴块）之间的纵向间距
  var LEGEND_BOTTOM_PAD_CARD = 4;   // 卡片：图例底边距容器底
  var LEGEND_BOTTOM_PAD_FS = 34;    // 全屏：让开底部 dataZoom slider
  var LEGEND_TEXT_STUB = 8;      // 图例符号与文字之间的间隙（ECharts 内部固定 5 + 余量）
  var ASSUME_PLOT_W = 520;       // 无 DOM 时假定的绘图区宽度（px，与 Axis.POLICY.ASSUME_PLOT_W 同源）

  /* 迭代 8（跨路对齐 · 与 plot-view.js 同源）：无右轴时**最终生效**的 grid.right。
     两条渲染路径的右侧留白不同，表格列中心 / 方框几何必须按各自**最终生效值**算宽度，
     否则列会整体与 Box 错位（实测差 6px → 40 类时末列偏差约 6px，超出「≤1px」契约）：
       · 卡片路径：plot-view.js 的 tightenOption（迭代 8）把「无右轴」的 grid.right 18 → 12；
       · 全屏路径：fullscreen.js 直接复用 buildOption 结果（只加 grid.bottom），**不做**该归一 → 仍为 18。
     优先读取 YMS.PlotView 导出的常量（该路若将来导出即自动同源），否则用同值兜底。 */
  var GRID_RIGHT_NOAXIS = 12;     // 卡片路径（plot-view.js tightenOption 的归一值）
  var GRID_RIGHT_FS = 18;         // 全屏路径（fullscreen.js 未归一的原值）
  /* 迭代 15：Y 轴左侧留白下限（与 Axis.POLICY.GRID_LEFT_MIN 同源；旧值是硬编码 48） */
  var AXIS_GRID_LEFT_MIN = (YMS.Axis && YMS.Axis.POLICY && YMS.Axis.POLICY.GRID_LEFT_MIN) || 60;
  function tableGridRight(rightRes, fsMode) {
    if (rightRes) return Math.max(num(rightRes.gridRight, 24), 24);   // 有右轴：按右轴标题宽度留白
    if (fsMode) return GRID_RIGHT_FS;
    var pv = (YMS.PlotView && YMS.PlotView.GRID_RIGHT_NOAXIS !== undefined)
      ? Number(YMS.PlotView.GRID_RIGHT_NOAXIS) : NaN;
    return isFinite(pv) ? pv : GRID_RIGHT_NOAXIS;
  }

  /* ------------------------------------- 数据表格常量（迭代 7 · C） */
  var TABLE = {
    FONT: 10.5,            // 字号（契约 10~11px）
    LINE_H: 12,            // 文本行高（垂直居中用）
    ROW_H: 16,             // 每行高度（表头行与数据行一致）
    CELL_PAD: 4,           // 单元格内文本与列边界的距离
    PAD_LEFT: 4,           // 表格左边界（距容器左边缘）
    HEAD_GAP: 6,           // 行头列右边界与绘图区左边界之间的间距
    MIN_COL_W: 46,         // 单列最小宽度：放不下就按几何抽稀
    MAX_CELL_W: 78,        // 抽稀时单元格宽度上限（显示间距大于它时按它取，数值更靠近其 Box）
    GAP: 8,                // 表格顶边与坐标区（X 轴标题）之间的间距（计入 grid.bottom）
    PAD_BOTTOM: 4,         // 卡片视图：表格底边距容器底边
    FS_PAD_BOTTOM: 34,     // 全屏视图：让开底部 dataZoom slider（height 20 + bottom 4 + 余量）
    BG: '#f7f9fa',         // 表头 / 行头兜底底色（--panel-alt 的浅色值）
    LINE: '#e9edf0',       // 行间分隔线（与图内网格线同色）
    FRAME: '#d7dee4',      // 表格上下外框线
    TEXT: '#4a5866'        // 表内文字（与轴标签同色）
  };
  var MIN_PLOT_H = 60;           // 绘图区最小高度（表格放不下时让位，见 buildOption 空间保护）
  /* 迭代 8（需求 5）：横轴坐标表格方框 —— 类别极多时列分隔线的上限（超出的按几何抽稀） */
  var FRAME_MAX_COLS = 24;
  /* 任务 G：表格通道「不抽稀」的下限带宽（px）—— 带宽低于此值时列宽连一个字高都放不下，
     全部画出来只会糊成一团（不是「少画几列」而是「画了也读不出」），此时才退回抽稀。 */
  var MIN_LEGIBLE_BAND = 9;
  var CHAR_W_RATIO = 0.58;       // 中英混排平均字符宽度 / 字号（与 Axis.POLICY 同源）
  /**
   * 由「绘图区宽 + 类别数」算出 boxWidth 数组（[下限, 上限]）
   * @param {number} plotW 绘图区可用宽度（px）
   * @param {number} count 类别数
   * @returns {[number, number]} ECharts series.boxWidth（数组形式）
   */
  function boxWidthFor(plotW, count, ratio) {
    var band = num(plotW, ASSUME_PLOT_W) / Math.max(1, num(count, 1));
    var r = num(ratio, BOX_RATIO);                       // 任务 F：plot.mark.boxRatio（默认 = BOX_RATIO）
    var cap = clamp(Math.round(band * r), BOX_MIN_W, BOX_MAX_W);
    return [BOX_MIN_W, cap];
  }

  /* ------------------------------------- 任务 H · 箱体槽位模型（唯一来源） */
  /**
   * 每个类别「同时有数据的箱体系数」的最大值 = 槽位数 lanes。
   * 为什么需要它：ECharts 的箱线布局（vendor/echarts.min.js BoxplotLayout）把**同轴全部 boxplot
   * 系列**按系列序号均分 0.8×带宽 —— offset_i = ((i+0.5)/N − 0.5) × band × 0.8，N = 系列总数，
   * 与「该类别里这些系列到底有没有数据」无关。分组图（splitBy / 颜色分组）常常一类只有 2~3 个
   * 系列有数据，于是同一类的箱体被摊在 0.8×带宽的固定槽位上、整体偏心（实测全屏 25-75% 时
   * 列心 145.9px、箱心 128.37px，左偏 17.53px；每类只画出 3 个箱子却占着 12 份槽位）。
   * 槽位数按**全部类别**（不是当前缩放窗口）统计 → 缩放时箱宽恒定、不会一缩一胀。
   * @param {Array<object>} plans series 计划（含 median 派生计划，内部过滤）
   * @returns {number} lanes ≥ 1
   */
  function boxLanesOf(plans) {
    var cnt = {}, i, k, d, mx = 0;
    for (i = 0; i < plans.length; i++) {
      var p = plans[i];
      if (!p || p.kind !== 'boxplot' || !p.data) continue;
      for (k = 0; k < p.data.length; k++) {
        var it = p.data[k];
        /* 空箱的约定是 [null,null,null,null,null]（见 catPlans）→ 只认首值有限者为「有数据」 */
        if (!it || it.length < 5 || it[0] === null || it[0] === undefined) continue;
        if (!isFinite(Number(it[0]))) continue;
        cnt[k] = num(cnt[k], 0) + 1;
      }
    }
    for (d in cnt) { if (Object.prototype.hasOwnProperty.call(cnt, d) && cnt[d] > mx) mx = cnt[d]; }
    return mx < 1 ? 1 : mx;
  }
  /**
   * 箱体槽位几何：band（带宽）/ lanes（每类槽位数）/ step（槽位间距）/ boxW（每槽箱宽）。
   * lanes = 1 时**完全沿用旧口径**（boxW 返回 null → 调用方仍用 boxWidthFor），保证
   * 「每条 Value 一条 series」的常规箱线图箱宽一像素不改（回归红线：图元零变化）。
   * lanes ≥ 2 时：step = 0.8 × band / lanes（ECharts 本来给全部系列的总占用宽度），
   *               箱宽 = step × 0.92 − 描边宽 → 相邻箱之间留 8% 槽位空隙。
   *               减描边是必须的：图元包围盒 = 形状宽 + borderWidth（实测 3.38 → 4.58、
   *               9.18 → 10.38，差恒为 1.2 = 默认描边），不减会让同类相邻箱互相压边。
   * @param {number} [borderW] 箱体描边宽（plot.mark.boxLineWidth，默认 1.2）
   * @returns {{lanes:number, band:number, step:number, boxW:(Array|null), w:(number|null)}}
   */
  /**
   * 同类箱体的槽距（px）：0.8 × 带宽 / lanes，**上限 BOX_MAX_W + 2**。
   * 上限的意义：缩放到只剩 3~4 个类别时带宽可达 300px+，无上限会让同类三个箱体被拉到
   * 相距 100px 的「孤岛」（虽然包围盒中心仍等于列心，但看不出它们属于同一类）。
   * 缩放后重算（reflowAxisTable）与对位（alignBoxSeries）必须共用本函数，否则箱宽与槽距漂移。
   */
  function boxStepOf(band, lanes) {
    var st = num(band, 0) * 0.8 / Math.max(1, num(lanes, 1));
    var cap = BOX_MAX_W + 2;
    return st > cap ? cap : st;
  }
  /** 由槽距反推箱宽（图元包围盒 = 形状宽 + 描边宽，故先减描边；再夹在 [2, 32]） */
  function boxWidthOfStep(step, borderW) {
    var bw = Math.max(0, num(borderW, 1.2));
    return clamp(Math.round((num(step, 0) * 0.92 - bw) * 100) / 100, BOX_MIN_W, BOX_MAX_W);
  }
  function boxLaneModel(plans, plotW, count, ratio, borderW) {
    var lanes = boxLanesOf(plans);
    var band = num(plotW, ASSUME_PLOT_W) / Math.max(1, num(count, 1));
    var step = boxStepOf(band, lanes);
    if (lanes <= 1) return { lanes: 1, band: band, step: step, boxW: null, w: null };
    var w = boxWidthOfStep(step, borderW);
    return { lanes: lanes, band: band, step: step, boxW: [w, w], w: w };
  }
  /**
   * 量取「ECharts 画布所在的容器」尺寸（px）—— 表格列几何的基准。
   * 全屏视图优先量全屏容器（选项在 fullscreen.js 里被 +34 grid.bottom / 字号 +2 之后再渲染，
   * 但列中心只取决于容器宽与 grid 左右，故按全屏容器量取才能在全屏内也对齐）；
   * 否则量当前卡片的 .chart-body。量不到（Node sandbox 自测）返回 {mode:'none', w:0, h:0}。
   * @returns {{mode:'card'|'fs'|'none', w:number, h:number}}
   */
  function measureHost(hostEl) {
    var none = { mode: 'none', w: 0, h: 0 };
    /** 取元素尺寸：优先 clientWidth（ECharts 自身用的就是它）；无 clientWidth（桩 DOM）回退矩形宽 */
    function sizeOf(el) {
      if (!el) return null;
      var w = num(el.clientWidth, 0), h = num(el.clientHeight, 0);
      if (!(w > 0) && typeof el.getBoundingClientRect === 'function') {
        try {
          var r = el.getBoundingClientRect();
          w = Math.round(num(r && r.width, 0));
          h = Math.round(num(r && r.height, 0));
        } catch (e2) { w = 0; h = 0; }
      }
      return (w > 0) ? { w: w, h: h } : null;
    }
    try {
      var doc = global.document;
      if (!doc || typeof doc.querySelector !== 'function') return none;
      /* 迭代 11（用户报障「数据未显示」）：**必须量正在渲染的那张卡片**。
         旧实现固定 querySelector 取第一张卡片宽度，同页卡片宽度不一致时（末行曾被拉宽到
         1.5×），其余卡片仍按首卡宽度算表格列宽/类别带 → 统计表只画到前 ~2/3、右侧类别
         没有标签与数值。调用方（plot-view / fullscreen）传入当前容器元素。 */
      var own = sizeOf(hostEl);
      if (own) {
        /* 全屏宿主（#fullscreen-root 内）仍要标记 mode='fs'：表格 bottom 内边距 / dataZoom 让位
           按 mode 分支，误判成 'card' 会让全屏表格与列中心错位（iter7_table E1/E2 回归点）。 */
        var inFs = false;
        try {
          inFs = !!(hostEl && typeof hostEl.closest === 'function' && hostEl.closest('#fullscreen-root'));
        } catch (e3) { inFs = false; }
        return { mode: inFs ? 'fs' : 'card', w: own.w, h: own.h };
      }
      var fsOpen = !!(YMS.Fullscreen && typeof YMS.Fullscreen.isOpen === 'function' && YMS.Fullscreen.isOpen());
      if (fsOpen) {
        var fs = sizeOf(doc.querySelector('#fullscreen-root .fs-body'));
        if (fs) return { mode: 'fs', w: fs.w, h: fs.h };
      }
      var card = sizeOf(doc.querySelector('#plot-canvas-wrap .chart-card .chart-body'));
      if (card) return { mode: 'card', w: card.w, h: card.h };
    } catch (e) { /* 量不到 → 回退假定宽度 */ }
    return none;
  }
  /**
   * 估算绘图区可用宽度（px）—— 箱宽自适应的几何基准
   * 浏览器内量取 ECharts 容器的真实宽度（同一 CSS 网格内各列等宽）后减去 grid 左右留白；
   * 无 DOM（Node sandbox 自测）或量不到时回退 ASSUME_PLOT_W + 留白（等价于绘图区 520px）。
   * @param {number} gridLeft  已含统计表头预留的 grid.left
   * @param {number} gridRight grid.right
   */
  function estimatePlotWidth(gridLeft, gridRight) {
    var gl = num(gridLeft, 0), gr = num(gridRight, 0);
    var w = measureHost().w;
    if (!isFinite(w) || w < 80) w = ASSUME_PLOT_W + gl + gr;
    return clamp(w - gl - gr, 120, 6000);
  }
  /**
   * 读取 CSS 变量（表格底色用 --panel-alt；取不到或非浏览器环境回退兜底色）
   * @param {string} name 变量名（含 --）
   * @param {string} dft 兜底值
   */
  function cssVar(name, dft) {
    try {
      if (global.document && global.getComputedStyle && global.document.documentElement) {
        var v = global.getComputedStyle(global.document.documentElement).getPropertyValue(name);
        if (v && String(v).trim()) return String(v).trim();
      }
    } catch (e) { /* 忽略：用兜底色 */ }
    return dft;
  }
  /** graphic 字体串（与表内文字统一样式） */
  function tableFont() {
    return 'normal ' + TABLE.FONT + 'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  }
  /* 文本像素宽度测量用的一次性 canvas（懒创建）。
     注意：本 ECharts 构建里 graphic 文本的 style.textAlign / textVerticalAlign **在画布上不生效**
     （实测：三种对齐的墨迹都从锚点向右/向下开始），故表内文本一律以「左对齐 + 按实测宽度左移」
     的方式定位 —— 与渲染结果严格一致，且不依赖版本行为。 */
  var _measureCtx = null;
  /**
   * 文本像素宽度（优先用 canvas measureText，与渲染同字体；无 DOM 时按字符宽度估算）
   * @param {string} text
   * @param {number} [fontPx] 字号（缺省 = 数据表格字号 TABLE.FONT；迭代 9：轴标签/行名按轴字号实测）
   * @returns {number} 宽度（px）
   */
  function textPx(text, fontPx) {
    var s = (text === null || text === undefined) ? '' : String(text);
    if (!s) return 0;
    var fp = num(fontPx, 0);
    var font = (fp > 0) ? ('normal ' + fp + 'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif') : tableFont();
    try {
      if (global.document && typeof global.document.createElement === 'function') {
        if (!_measureCtx) {
          var cv = global.document.createElement('canvas');
          _measureCtx = (cv && typeof cv.getContext === 'function') ? cv.getContext('2d') : null;
        }
        if (_measureCtx && typeof _measureCtx.measureText === 'function') {
          _measureCtx.font = font;
          var w = _measureCtx.measureText(s).width;
          if (isFinite(w) && w > 0) return w;
        }
      }
    } catch (e) { /* 回退估算 */ }
    return s.length * (fp > 0 ? fp : TABLE.FONT) * CHAR_W_RATIO;
  }
  /**
   * 迭代 28：横轴是否启用「第二层分组行」
   *   数据来源 = aggregate 给每个类别附的 groupLabel（多列 X 里的分组参数列取值）/ subLabel（其余列）。
   *   至少有一个组含 ≥2 个 bar 才启用 —— 否则（一 bar 一组）合并省不下任何标签，白占一行留白。
   * @param {Array<object>} cats 类别数组
   * @returns {{on:boolean, groupLabels:Array<string>, subLabels:Array<string>}}
   */
  function groupMergeOf(cats) {
    var n = cats ? cats.length : 0, i, L;
    var off = { on: false, levels: 0, levelValues: [], groupLabels: [], subLabels: [] };
    if (n < 2) return off;
    /* N 级：分组层 = X 轴除最后一列外的所有列（aggregate 已按级写进 cat.groupLabels） */
    var nL = (cats[0] && cats[0].groupLabels) ? cats[0].groupLabels.length : 0;
    if (!nL || cats[0].subLabel === undefined) return off;
    var lv = [], sl = new Array(n);
    for (L = 0; L < nL; L++) lv.push(new Array(n));
    for (i = 0; i < n; i++) {
      var c = cats[i] || {};
      if (!c.groupLabels || c.groupLabels.length !== nL || c.subLabel === undefined) return off;
      for (L = 0; L < nL; L++) {
        var v = c.groupLabels[L];
        lv[L][i] = (v === null || v === undefined) ? '' : String(v);
      }
      sl[i] = String(c.subLabel);
    }
    /* 至少有一级真能合并（该级 runs < n）才启用 —— 全部级都「一 bar 一组」时白占留白 */
    var on = false;
    for (L = 0; L < nL; L++) {
      var runs = 1;
      for (i = 1; i < n; i++) if (lv[L][i] !== lv[L][i - 1]) runs++;
      if (runs < n) on = true;
    }
    if (!on) return off;
    return { on: true, levels: nL, levelValues: lv, groupLabels: lv[0], subLabels: sl };
  }

  /**
   * 迭代 21：按**容器实际高度**定横轴底部留白（唯一来源 = YMS.Axis.bottomFit）。
   *
   * 卡片：容器高 = .chart-body 高；全屏：容器高 = .fs-body 高（另加 dataZoom slider 带）。
   * 与 Axis.categoryAxis 内部那次（无容器上限）相比，这里会按容器收敛：
   *   ① 缩标签字号（≥ 9px）② 放宽绘图区下限 ③ 减少统计行数 —— 都不裁标签。
   *
   * @param {object} xRes   YMS.Axis.categoryAxis 的返回值（就地更新 gridBottom / statRows / nameGap / 字号）
   * @param {object} o      { containerH, gridTop, extraBottom }
   * @returns {object|null} bottomFit 几何（失败时 null，调用方保持既有值）
   */
  function applyBottomFit(xRes, o) {
    var AX = YMS.Axis;
    if (!AX || typeof AX.bottomFit !== 'function' || !xRes || !xRes.xAxis) return null;
    /* rotate=0 且统计量不旋转 → 多行标签路径：沿用迭代 4~19 公式（逐值不变，回归红线）。
       该路径的标签块本身含统计行，不存在「标签与统计行两带相加」的问题。 */
    if (xRes.statMode === 'axis') return null;
    o = o || {};
    var lbl = xRes.xAxis.axisLabel || {};
    var baseFont = num(xRes.fontPx, num(lbl.fontSize, 11));
    var fit = AX.bottomFit({
      statInline: (xRes.statMode === 'axis' && num(xRes.statRows, 0) > 0),
      rotate: (xRes.policy && xRes.policy.rotate) || 0,
      statRotate: num(xRes.statRotate, 0),
      statRows: num(xRes.statRowsAll, xRes.statRows),
      labelPx: num(xRes.labelPx, 0),
      maxStatPx: num(xRes.maxStatPx, 0),
      fontPx: baseFont,
      containerH: num(o.containerH, 0),
      gridTop: num(o.gridTop, 24),
      extraBottom: num(o.extraBottom, 0),
      /* 迭代 28：第二层分组行占的高度（0 = 无分组行，逐值不变） */
      groupBand: Math.max(0, num(o.groupBand, 0))
    });
    if (!fit) return null;
    xRes.gridBottom = fit.bottom;
    xRes.statRows = fit.rows;                 // 实际绘制的统计行数
    xRes.nameGap = fit.nameGap;
    xRes.statRowH = fit.rowH;
    xRes.labelTop = fit.labelTop;
    xRes.fit = fit;
    if (fit.fontPx !== baseFont) {
      /* 容器太矮 → 标签字号按比例缩小（≥ 9px）；轴标题字号同步，绝不裁字 */
      xRes.xAxis.axisLabel.fontSize = fit.fontPx;
      if (xRes.xAxis.nameTextStyle) xRes.xAxis.nameTextStyle.fontSize = fit.fontPx;
      if (xRes.header) {
        xRes.header.fontSize = fit.fontPx;
        xRes.header.lineHeight = (xRes.statMode === 'graphic') ? fit.rowH : axisPolicyNum('STAT_ROW_H', 13);
      }
    }
    xRes.xAxis.nameGap = fit.nameGap;
    /* 迭代 28：分组行把类别标签块整体下推（axisLabel.margin = 轴标签间距 + 分组行带） */
    if (xRes.xAxis.axisLabel) xRes.xAxis.axisLabel.margin = Math.round(num(fit.labelGap, axisPolicyNum('AXIS_LABEL_MARGIN', 7)));
    if (xRes.header) {
      xRes.header.labelTop = fit.labelTop;
      xRes.header.rotH = fit.rotH;
      xRes.header.rowH = fit.rowH;
      xRes.header.statRowH = fit.rowH;
      xRes.header.statRowsShown = fit.rows;
      xRes.header.shrunkFont = fit.shrunkFont;
      if (xRes.statMode === 'graphic') xRes.header.bottom = Math.max(0, fit.rowsBottom);
    }
    return fit;
  }

  /**
   * 迭代 21：底部留白几何的元数据快照（ECharts 忽略未知顶层字段；自测与文档引用）
   * @param {object} f Axis.bottomFit 的返回值
   */
  function fitMeta(f) {
    if (!f) return null;
    return {
      bottom: f.bottom, need: f.need, extra: f.extra,
      labelGap: f.labelGap, rotH: f.rotH, rowH: f.rowH, rowGap: f.rowGap,
      groupBand: num(f.groupBand, 0),
      rows: f.rows, rowsAll: f.rowsAll, droppedRows: f.droppedRows,
      labelTop: f.labelTop, rowsBottom: f.rowsBottom, rowsTop: f.rowsTop,
      titleBand: f.titleBand, nameGap: f.nameGap,
      fontPx: f.fontPx, shrunkFont: f.shrunkFont,
      containerH: f.containerH, gridTop: f.gridTop,
      plotH: f.plotH, cap: f.cap, overflow: f.overflow, rowClearance: f.rowClearance
    };
  }
  /**
   * 迭代 6 · C：左置统计表头已并入 axisBlockGraphic（统一由 axisTableLayout 的几何驱动，
   * 避免「表头多行文本」与「行名逐行文本」两套定位逻辑分叉）；此处保留一处说明以免误加回。
   */
  function esc(s) { return YMS.util && YMS.util.escapeHtml ? YMS.util.escapeHtml(s) : String(s); }
  function pickStyle(chart) {
    var base = (YMS.Store && YMS.Store.DEFAULT_STYLE) || {};
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    var st = chart && chart.style;
    if (st) Object.keys(st).forEach(function (k) { out[k] = st[k]; });
    return out;
  }
  /** 数值格式化（小数位 / 时间样式） */
  function fmtVal(v, type, decimals, timeStyle) {
    if (v === null || v === undefined || v !== v) return '';
    if (type === T.TIME) return T.formatTime(v, timeStyle || 'datetime');
    return YMS.util.fmtNumber(v, (decimals === '' ? null : decimals));
  }
  /** hex → rgba（分组色做半透明填充用） */
  function hexToRgba(hex, alpha) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    var n = parseInt(h, 16);
    if (!isFinite(n)) return 'rgba(11,110,153,' + alpha + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }
  /** HSL → hex（调色板用尽后派生颜色，保证不同分组取值颜色不同） */
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    function f(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    var r = Math.round(f(p, q, h + 1 / 3) * 255), g = Math.round(f(p, q, h) * 255), b = Math.round(f(p, q, h - 1 / 3) * 255);
    function h2(v2) { var s2 = v2.toString(16); return s2.length < 2 ? '0' + s2 : s2; }
    return '#' + h2(r) + h2(g) + h2(b);
  }
  /** 分组取值 → 颜色（同值同色；index < 0 = 未分组，返回 null 交回序号调色板） */
  function colorFor(idx) {
    var i = Math.floor(num(idx, -1));
    if (i < 0) return null;
    if (i < PALETTE_ALT.length) return PALETTE_ALT[i];
    return hslToHex(i * 137.508, 0.5, 0.44 + 0.05 * ((i % 3) - 1));
  }

  /* ------------------------------------------- 迭代 11：分组配色（自定义色） */
  /**
   * 用户自定义配色表 = plot.group.colors（{ '<分组键>': '#rrggbb' }）。
   * 优先取 chart.group.colors（自测可注入），否则读 Store；无配置返回 null。
   */
  function colorMapOf(chart) {
    if (chart && chart.group && chart.group.colors && typeof chart.group.colors === 'object') {
      return chart.group.colors;
    }
    var p = (YMS.Store && YMS.Store.state) ? YMS.Store.state.plot : null;
    var m = (p && p.group) ? p.group.colors : null;
    return (m && typeof m === 'object') ? m : null;
  }
  /** 计划 p 的分组配色键（规则与设置区同源：YMS.groupColorKey —— 颜色分组取值 / 系列键） */
  function planColorKey(p, chart) {
    var g = (chart && chart.group) || {};
    var key = (YMS.groupColorKey && typeof YMS.groupColorKey === 'function')
      ? YMS.groupColorKey(g.colorBy, p.colorLabel, p.key)
      : p.key;
    return key;
  }
  /** 取某分组键的自定义色；未自定义 / 非法值 → null（交回原调色板逻辑，保证零回归） */
  function customColorOf(cmap, key) {
    if (!cmap || key === undefined || key === null) return null;
    var v = cmap[String(key)];
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) return null;
    return v;
  }
  /** 分组取值 → 符号（index < 0 = 未分组，返回 null 交回现状默认） */
  function symbolFor(idx) {
    var i = Math.floor(num(idx, -1));
    if (i < 0) return null;
    return SYMBOLS[i % SYMBOLS.length];
  }

  /* --------------------------------------------------------------- 主题 */
  /** 读 CSS 自定义属性（迭代 12：ECharts 主题跟随 4 套 UI 主题，否则深色底上文字仍是深色） */
  function cssVar(name, fallback) {
    try {
      var st = global.getComputedStyle ? global.getComputedStyle(document.documentElement) : null;
      var v = st ? String(st.getPropertyValue(name) || '').trim() : '';
      return v || fallback;
    } catch (e) { return fallback; }
  }

  /* ------------------------------------------- 迭代 17：图内颜色跟随主题 */
  /* 历史遗留：轴/网格/标题/图例/横轴表格的文字颜色在本模块与 Axis 里写死为「浅色主题取值」
     （#4a5866 = light 的 --ink-soft、#16202a = --ink、#e9edf0 = --grid-line、
       #b6c0c9 / #c2cad2 = --border-strong、#7d8b98 = --ink-dim）。
     深色主题下这些字面量会变成「深字压深底」（图内轴标签不可读），所以未自定义颜色时
     统一改用当前主题令牌：
       · light 主题的令牌值 == 这些字面量 → 默认浅色视觉零变化（回归红线）
       · dark / ion / paper / 新增三套 → 轴标签、图例、标题、网格线、横轴表格自然跟随换肤
     用户显式选过的颜色（如 #ff0000 / #0000ff）不在映射表里，原样保留（验收「样式」依赖此语义）。 */
  var LEGACY_COLOR_TO_TOKEN = {
    '#4a5866': '--ink-soft',
    '#16202a': '--ink',
    '#7d8b98': '--ink-dim',
    '#b6c0c9': '--border-strong',
    '#c2cad2': '--border-strong',
    '#e9edf0': '--grid-line'
  };
  var COLOR_KEYS = { color: 1, fill: 1, stroke: 1, borderColor: 1, backgroundColor: 1 };

  /** 递归把 option 里「仍是历史默认色」的颜色值替换为当前主题令牌值 */
  function themeFollowColors(node, tokenMap) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) themeFollowColors(node[i], tokenMap);
      return;
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k];
      if (typeof v === 'string') {
        var tok = COLOR_KEYS[k] ? LEGACY_COLOR_TO_TOKEN[v.toLowerCase()] : null;
        if (tok && tokenMap[tok]) node[k] = tokenMap[tok];
      } else if (v && typeof v === 'object') {
        themeFollowColors(v, tokenMap);
      }
    }
  }

  /** 注册 ECharts 主题（app.js 启动时调用；无 echarts 时安全返回 false） */
  function registerTheme() {
    var ec = global.echarts;
    if (!ec || typeof ec.registerTheme !== 'function') return false;
    try {
      var C_INK = cssVar('--ink', '#16202a');
      var C_SOFT = cssVar('--ink-soft', '#4a5866');
      var C_DIM = cssVar('--ink-dim', '#7d8b98');
      var C_LINE = cssVar('--grid-line', GRID_COLOR);
      var C_AXIS = cssVar('--border-strong', AXIS_COLOR);
      var C_ACC = cssVar('--accent', '#0b6e99');
      var C_ACC_H = cssVar('--accent-hover', '#0a5b7e');
      var C_PANEL = cssVar('--panel', '#141b23');
      var C_BORDER = cssVar('--border-strong', '#2a3540');
      ec.registerTheme('yms-registered', {
        color: PALETTE_ALT,
        backgroundColor: 'transparent',
        textStyle: {
          fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
        },
        title: {
          textStyle: { color: C_INK, fontSize: 13, fontWeight: 600 },
          subtextStyle: { color: C_DIM, fontSize: 11 }
        },
        legend: { textStyle: { color: C_SOFT } },
        categoryAxis: {
          axisLine: { lineStyle: { color: C_AXIS } },
          axisTick: { lineStyle: { color: C_AXIS } },
          axisLabel: { color: C_SOFT },
          splitLine: { lineStyle: { color: C_LINE } },
          splitArea: { show: false }
        },
        valueAxis: {
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: C_SOFT },
          splitLine: { lineStyle: { color: C_LINE } },
          splitArea: { show: false }
        },
        tooltip: {
          backgroundColor: C_PANEL,
          borderColor: C_BORDER,
          borderWidth: 1,
          textStyle: { color: C_INK, fontSize: 12 },
          axisPointer: { lineStyle: { color: C_AXIS }, crossStyle: { color: C_AXIS } }
        },
        boxplot: {
          itemStyle: { borderColor: C_ACC },
          emphasis: { itemStyle: { borderColor: C_ACC_H, shadowBlur: 4 } }
        }
      });
    } catch (e) {
      if (global.console && console.error) console.error('[YMS.ChartBuilder] registerTheme 失败', e);
      return false;
    }
    return true;
  }

  /* ------------------------------------------------ 图例 / 图元样式（任务 F） */
  /**
   * 取 plot.legend（用户设置）→ 与默认值合并成完整对象。
   * 数据来源优先级：chart.legend（aggregate 透传） > Store.state.plot.legend > 默认值。
   * @returns {object} 11 个字段齐全的图例设置
   */
  function legendOf(chart) {
    var dft = (YMS.Store && YMS.Store.DEFAULT_LEGEND) || {
      position: 'top', orient: 'auto', textColor: LEGEND_TEXT_COLOR, bgColor: null,
      borderColor: null, borderWidth: 0, padding: 0,
      itemWidth: LEGEND_ITEM_W, itemHeight: LEGEND_ITEM_H, itemGap: LEGEND_ITEM_GAP, scrollMode: 'auto'
    };
    var src = (chart && chart.legend) ||
      (YMS.Store && YMS.Store.state && YMS.Store.state.plot && YMS.Store.state.plot.legend) || {};
    var out = {}, k;
    for (k in dft) if (Object.prototype.hasOwnProperty.call(dft, k)) out[k] = dft[k];
    for (k in src) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
    if (['top', 'bottom', 'left', 'right'].indexOf(out.position) < 0) out.position = 'top';
    if (['auto', 'horizontal', 'vertical'].indexOf(out.orient) < 0) out.orient = 'auto';
    if (['auto', 'on', 'off'].indexOf(out.scrollMode) < 0) out.scrollMode = 'auto';
    return out;
  }
  /** 取 plot.mark（几何 / 线型 / 形状；**不含任何系列颜色**）→ 完整对象 */
  function markOf(chart) {
    var dft = (YMS.Store && YMS.Store.DEFAULT_MARK) || {
      boxRatio: BOX_RATIO, boxLineWidth: 1.2, barRatio: 0.88, barRadius: 0,
      lineWidth: 1.8, lineType: 'solid', showSymbol: true, symbolSize: 5, symbolShape: 'circle',
      scatterSize: 6, scatterOpacity: 0.72, scatterShape: 'circle'
    };
    var src = (chart && chart.mark) ||
      (YMS.Store && YMS.Store.state && YMS.Store.state.plot && YMS.Store.state.plot.mark) || {};
    var out = {}, k;
    for (k in dft) if (Object.prototype.hasOwnProperty.call(dft, k)) out[k] = dft[k];
    for (k in src) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
    return out;
  }
  /** 图例实际排列方向：auto → 上下横排 / 左右竖排 */
  function legendOrientOf(lg) {
    if (lg.orient === 'horizontal' || lg.orient === 'vertical') return lg.orient;
    return (lg.position === 'left' || lg.position === 'right') ? 'vertical' : 'horizontal';
  }
  /** 图例是否需要滚动（auto = 现状「条目 > LEGEND_SCROLL_MIN 才滚动」） */
  function legendScrollOf(lg, legendCount) {
    if (lg.scrollMode === 'on') return true;
    if (lg.scrollMode === 'off') return false;
    return num(legendCount, 0) > LEGEND_SCROLL_MIN;
  }
  /** 图例矩形宽度估算（left/right 让位用）：符号 + 间隙 + 最长条目文字 + 内/外距 */
  function legendWidthOf(lg, legendNames, fontPx) {
    var maxW = 0;
    for (var i = 0; i < (legendNames || []).length; i++) {
      var w = textPx(legendNames[i], fontPx);
      if (w > maxW) maxW = w;
    }
    var pad = num(lg.padding, 0) * 2 + (num(lg.borderWidth, 0) > 0 ? num(lg.borderWidth, 0) * 2 : 0);
    return Math.ceil(num(lg.itemWidth, LEGEND_ITEM_W) + LEGEND_TEXT_STUB + maxW + pad + 6);
  }

  /** 线型 → lineStyle 对象（solid 不写 type：与改动前逐字相同） */
  function lineStyleOf(width, lineType, color) {
    var o = { width: width };
    if (lineType === 'dashed' || lineType === 'dotted') o.type = lineType;
    o.color = color;
    return o;
  }
  /** 形状：默认 circle 时沿用现有分组符号（gSymbol），显式选择时覆盖 */
  function symbolOf(shape, gSymbol) {
    var s = shape || 'circle';
    return (s !== 'circle') ? s : (gSymbol || 'circle');
  }
  /** bar/hist 柱宽：默认（0.88）原样输出旧字段；改值后按「占带宽比例」换算 barCategoryGap */
  function applyBarGeometry(ser, mk) {
    var r = num(mk.barRatio, 0.88);
    if (Math.abs(r - 0.88) < 1e-9) {
      ser.barMaxWidth = 42;
      ser.barCategoryGap = '12%';
    } else {
      ser.barCategoryGap = Math.round((1 - r) * 100) + '%';
    }
    var rad = num(mk.barRadius, 0);
    if (rad > 0) {
      if (!ser.itemStyle) ser.itemStyle = {};
      ser.itemStyle.borderRadius = rad;
    }
    return ser;
  }

  /* ------------------------------------------------------- 标题块与 grid */
  /**
   * 依据样式与副标题行数计算标题块高度、legend 位置、grid
   * @param {number} [statRows] 预留（统计行已并入 xRes.gridBottom）
   * @param {number} [gridRightPx] 右侧留白（右轴存在时按其标题宽度留白，默认 18）
   * @param {number} [legendCount] 图例条目数（迭代 5）：> LEGEND_SCROLL_MIN 时按
   *        「滚动 + 限高 2 行」预留图例高度，保证 grid.top ≥ 图例实际占用高度
   */
  function layoutBox(style, subtext, showLegend, xRes, yRes, gridRightPx, legendCount, lg) {
    var lh = 1.35;
    var titleH = num(style.titleSize, 13) * lh;
    var subLines = subtext ? String(subtext).split('\n').length : 0;
    var subH = subLines ? subLines * (11 * lh) + 2 : 0;
    var rowH = Math.max(16, num(style.legendSize, 11) * lh);
    /* 任务 F：图例位置 / 滚动模式由 plot.legend 决定；lg 缺省 = 现状（top + auto） */
    var legStyle = lg || { position: 'top', scrollMode: 'auto' };
    var scroll = legendScrollOf(legStyle, legendCount);
    var legendScroll = !!showLegend && scroll;
    var legendH = showLegend ? (legendScroll ? LEGEND_SCROLL_MAX_H : rowH + 4) : 0;
    var pos = legStyle.position || 'top';
    var top = 6;
    var legendTop = top + titleH + subH;
    /* 顶部：图例在上 → grid.top 让位（与改前逐值相同）；
       底部 / 左右：图例不占顶部带 → grid.top 只留 6px 间隙（图例在绘图区之外的带里） */
    var gridTop = (pos === 'top')
      ? Math.round(legendTop + legendH + 6)
      : Math.round(legendTop + 6);
    return {
      legendTop: Math.round(legendTop),
      legendScroll: legendScroll,
      legendH: legendH,
      legendRowH: rowH,
      legendPos: pos,
      gridTop: gridTop,
      gridLeft: (yRes && yRes.gridLeft) ? yRes.gridLeft : AXIS_GRID_LEFT_MIN,
      gridBottom: (xRes && xRes.gridBottom) ? xRes.gridBottom : 44,
      gridRight: num(gridRightPx, 18)
    };
  }

  /* --------------------------------------------------------- tooltip 格式化 */
  /**
   * 分类轴 tooltip（meta：series 名 → {vc, cats}，供分组/叠加时取对应组的统计量）
   */
  function makeAxisTooltip(chart, cats, meta) {
    return function (params) {
      var arr = Array.isArray(params) ? params : [params];
      /* 迭代 15 修复：①外框轴/同点重复回调会让同一数据点出现多次 → 按「系列名+dataIndex」去重；
         ②ECharts 在类目轴上给 boxplot 的 value 首位是类别下标（[idx,min,Q1,中位,Q3,max]），
           旧代码直接取 value[0..4] 导致 min/Q1/中位/Q3/max 整体错位一格 → 长度 ≥6 时 slice(1)。 */
      var seen = {}, uniq = [];
      for (var k = 0; k < arr.length; k++) {
        var q = arr[k];
        if (!q || !q.seriesName) continue;
        var key = q.seriesName + '#' + (q.dataIndex === undefined || q.dataIndex === null ? '' : q.dataIndex);
        if (seen[key]) continue;
        seen[key] = 1; uniq.push(q);
      }
      arr = uniq;
      if (!arr.length) return '';
      var di = arr[0].dataIndex;
      var headCat = (cats && cats[di]) ? cats[di] : null;
      var head = (headCat && (headCat.fullLabel || headCat.label)) || arr[0].axisValueLabel;
      var lines = ['<b>' + esc(head) + '</b>'];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        var m = (meta && meta[p.seriesName]) ? meta[p.seriesName] : null;
        var vc = m ? m.vc : null;
        var text;
        var bv = null;
        if (p.seriesType === 'boxplot') {
          bv = (p.value && p.value.length >= 6) ? p.value.slice(1) : p.value;
          /* 任务 H ②（用户报障「有些只存在 min，Q1，中位数等，但是不显示数值」）：
             该系列在该类别**没有数据**时 ECharts 仍把点带进 params（value = [null×5]
             或窗口外的 '-' 占位）—— 旧代码照印五个标签、数值全空。整行不列出。 */
          if (!boxFiveFilled(bv)) continue;
          text = 'min ' + fmtVal(bv[0], T.NUMBER, vc ? vc.decimals : null) +
            ' · Q1 ' + fmtVal(bv[1], T.NUMBER, vc ? vc.decimals : null) +
            ' · 中位 ' + fmtVal(bv[2], T.NUMBER, vc ? vc.decimals : null) +
            ' · Q3 ' + fmtVal(bv[3], T.NUMBER, vc ? vc.decimals : null) +
            ' · max ' + fmtVal(bv[4], T.NUMBER, vc ? vc.decimals : null);
        } else {
          text = fmtVal(p.value, vc ? vc.type : T.NUMBER, vc ? vc.decimals : null, vc ? vc.timeStyle : null);
        }
        var extra = '';
        var sCats = (m && m.cats) ? m.cats : cats;
        if (sCats && sCats[di] && sCats[di].stats && vc && sCats[di].stats[vc.name] && p.seriesType !== 'boxplot') {
          var s = sCats[di].stats[vc.name];
          if (s && s.n) extra = '  <span style="opacity:.7">(n=' + s.n + ')</span>';
        }
        lines.push(p.marker + ' ' + esc(p.seriesName) + '：' + esc(text) + extra);
      }
      /* 任务 H ②：该类别下所有系列都没有数据 → 不弹只带标题的空 tooltip */
      if (lines.length <= 1) return '';
      return lines.join('<br/>');
    };
  }
  /** 散点 tooltip（meta 同上） */
  function makeItemTooltip(chart, meta) {
    var xCol = (chart.xCols && chart.xCols[0]) || {};
    return function (p) {
      if (!p) return '';
      var m = (meta && meta[p.seriesName]) ? meta[p.seriesName] : null;
      var vc = m ? m.vc : null;
      var cats = (m && m.cats) ? m.cats : chart.cats;
      var xText, yText;
      if (cats && p.value && p.value.length >= 2 && xCol.type === T.STRING) {
        var ci = Math.round(p.value[0]);
        /* 迭代 15 ③：合并组 tooltip 用 fullLabel（代表值 + 完整范围），无则回落类别名 */
        xText = (cats[ci] ? (cats[ci].fullLabel || cats[ci].label) : String(p.value[0]));
      } else {
        xText = fmtVal(p.value ? p.value[0] : null, xCol.type, xCol.decimals, xCol.timeStyle);
      }
      yText = fmtVal(p.value ? p.value[1] : null, vc ? vc.type : T.NUMBER, vc ? vc.decimals : null, vc ? vc.timeStyle : null);
      return p.marker + ' ' + esc(p.seriesName) + '<br/>' +
        esc(xCol.name || 'X') + ' = ' + esc(xText) + '<br/>' +
        esc(vc ? vc.name : 'Y') + ' = ' + esc(yText);
    };
  }

  /* --------------------------------------------------- 外框轴 / 智能 Y 范围 */
  /**
   * 生成「外框轴」（上边 X / 右边 Y）：只画轴线，不画刻度、标签、网格，且不响应鼠标。
   * @param {object} main 主轴 option 片段（下边 X / 左边 Y；右轴存在时传右轴，保证边框与可见轴一致）
   * @param {string} pos  'top' | 'right'
   * @param {boolean} isX 是否 X 轴
   * @returns {object} ECharts 轴 option 片段（silent:true —— 契约 §3.3：外框轴追加在最后）
   */
  function frameAxis(main, pos, isX) {
    var m = main || {};
    var ls = (m.axisLine && m.axisLine.lineStyle) || {};
    var ax = {
      type: m.type || 'value',
      position: pos,
      name: '',
      silent: true,
      axisLine: { show: true, onZero: false, lineStyle: { color: ls.color || AXIS_COLOR, width: 1, type: ls.type || 'solid' } },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false },
      splitArea: { show: false },
      axisPointer: { show: false }
    };
    if (isX) {
      if (ax.type === 'category') {
        ax.data = (m.data || []).slice();                // 与主轴同一份刻度数据，保证网格对齐
        ax.boundaryGap = m.boundaryGap !== false;
      } else { ax.min = (m.min === undefined ? null : m.min); ax.max = (m.max === undefined ? null : m.max); }
    } else {
      ax.min = (m.min === undefined ? null : m.min);     // 与可见轴范围完全一致（含智能/显式/对数）
      ax.max = (m.max === undefined ? null : m.max);
      if (ax.type === 'log') ax.logBase = m.logBase || 10;
    }
    return ax;
  }

  /**
   * 智能 Y 范围：仅当用户未显式指定 Min/Max 且非对数轴时生效（用户显式 → 不覆盖）
   * 只按「挂在该轴上的 series 集合」计算（契约 §3.3：左右轴各自独立）
   * @param {Array<object>} plans 该轴上的 series 计划（各自带 rangeVals）
   * @returns {{min,max,step,dataMin,dataMax,rawMin,rawMax,n,loFixed,hiFixed}|null}
   */
  function smartYRange(plans, type, yAxis) {
    if (!plans || !plans.length) return null;
    if (yAxis && yAxis.type === 'log') return null;
    if (!YMS.Axis || typeof YMS.Axis.smartRange !== 'function') return null;
    var vals = [];
    for (var i = 0; i < plans.length; i++) {
      var rv = plans[i].rangeVals;
      if (rv && rv.length) vals.push(rv);
    }
    if (!vals.length) return null;
    return YMS.Axis.smartRange(vals, { zeroMin: type === 'hist' });
  }
  /** 把智能范围写回轴对象 */
  function applyRange(axis, range) {
    if (!axis || !range) return null;
    axis.min = range.min;
    axis.max = range.max;
    if (isFinite(range.step) && range.step > 0) axis.interval = range.step;   // 刻度整齐
    return range;
  }

  /* -------------------------------------------------- 横轴统计行（迭代 4 / 迭代 6） */
  /* 迭代 6 · C：统计量「名称」与「数值」分离 ——
       数值行只写数值（如 '93.21'），名称交由 X 轴最左侧的固定表头（graphic）统一标出。
       两者行序都恒为 stats.items = Aggregate.STAT_ORDER，故可逐行对齐。 */
  var STAT_LABEL = {
    mean: 'Mean', median: 'Median', std: 'Std', rng: 'RNG', nupct: 'Nu%',
    n: 'N', min: 'Min', max: 'Max', q1: 'Q1', q3: 'Q3'
  };
  /** 统计行小数位：取 Value 列设置的小数位（空 = 2，与契约示例 '93.21' 一致） */
  function statDecimals(vc) {
    var d = vc ? vc.decimals : null;
    if (d === null || d === undefined || d === '') return 2;
    d = Math.floor(num(d, 2));
    return d < 0 ? 0 : (d > 6 ? 6 : d);
  }
  /** 打印后的数值（用于 Nu% 与标签自洽；null = 无值） */
  function printedNum(v, dec) {
    if (v === null || v === undefined || typeof v !== 'number' || v !== v || !isFinite(v)) return null;
    return Number(v.toFixed(dec));
  }
  function printedText(v, dec) {
    var p = printedNum(v, dec);
    return p === null ? null : p.toFixed(dec);
  }
  /**
   * 单个统计量的「数值文本」（迭代 6：**不带名称前缀**；无值 = '—'，保证行数稳定不串行）
   * §5.3：Nu% = Std / |Mean| × 100，用已打印的 Std/Mean 计算，保证与数值行自洽
   */
  function statValueText(key, s, dec) {
    var dash = '—';
    if (!s) return dash;
    switch (key) {
      case 'mean': { var t = printedText(s.mean, dec); return t === null ? dash : t; }
      case 'median': { var t2 = printedText(s.median, dec); return t2 === null ? dash : t2; }
      case 'std': { var t3 = printedText(s.std, dec); return t3 === null ? dash : t3; }
      case 'rng': {
        var mn = printedNum(s.min, dec), mx = printedNum(s.max, dec);
        if (mn === null || mx === null) return dash;
        return (mx - mn).toFixed(dec);
      }
      case 'nupct': {
        var m2 = printedNum(s.mean, dec), sd2 = printedNum(s.std, dec);
        if (m2 === null || sd2 === null || m2 === 0) return dash;
        return (sd2 / Math.abs(m2) * 100).toFixed(2);
      }
      case 'n': return (s.n === null || s.n === undefined) ? dash : String(s.n);
      case 'min': { var t4 = printedText(s.min, dec); return t4 === null ? dash : t4; }
      case 'max': { var t5 = printedText(s.max, dec); return t5 === null ? dash : t5; }
      case 'q1': { var t6 = printedText(s.q1, dec); return t6 === null ? dash : t6; }
      case 'q3': { var t7 = printedText(s.q3, dec); return t7 === null ? dash : t7; }
    }
    return dash;
  }
  /** 每个类别的统计数值行（多行 '\n' 连接，**只含数值**）；无统计量时返回 null（= 不启用统计行） */
  function statLinesFor(cats, vc, items) {
    if (!cats || !cats.length || !items || !items.length || !vc) return null;
    var dec = statDecimals(vc);
    var out = new Array(cats.length);
    for (var i = 0; i < cats.length; i++) {
      var st = (cats[i] && cats[i].stats) ? cats[i].stats[vc.name] : null;
      var parts = [];
      for (var k = 0; k < items.length; k++) parts.push(statValueText(items[k], st, dec));
      out[i] = parts.join('\n');
    }
    return out;
  }
  /**
   * 左置统计表头各行文字（迭代 6 · C）——
   * 第 1 行 = X 轴列名（如 'Lot'），其后每行 = 一个启用的统计量名；
   * 行序与 statLinesFor 的数值行严格一致 → 逐行对齐；行数恒 = 1 + items.length。
   */
  function statHeaderFor(xName, items) {
    var out = [(xName === null || xName === undefined || xName === '') ? 'X' : String(xName)];
    for (var i = 0; i < (items || []).length; i++) out.push(STAT_LABEL[items[i]] || String(items[i]));
    return out;
  }
  /** 统计项归一化（顺序恒为 STAT_ORDER；非法值剔除） */
  function normStatItems(items) {
    var A = YMS.Aggregate;
    if (A && typeof A._normalizeStatItems === 'function') return A._normalizeStatItems(items);
    var order = (A && A.STAT_ORDER) ? A.STAT_ORDER : ['mean', 'median', 'std', 'rng', 'nupct', 'n', 'min', 'max', 'q1', 'q3'];
    var picked = [], i;
    for (i = 0; i < (items || []).length; i++) {
      if (order.indexOf(items[i]) >= 0 && picked.indexOf(items[i]) < 0) picked.push(items[i]);
    }
    var out = [];
    for (i = 0; i < order.length; i++) if (picked.indexOf(order[i]) >= 0) out.push(order[i]);
    return out;
  }

  /* ============================ 数据表格（迭代 7 · C） ============================ */
  /** 取表格开关：优先 chart.table（自测注入），其次 Store.state.plot.table（设置区开关） */
  function tableCfgOf(chart) {
    if (chart && chart.table && typeof chart.table === 'object') return chart.table;
    var p = (YMS.Store && YMS.Store.state) ? YMS.Store.state.plot : null;
    return (p && p.table && typeof p.table === 'object') ? p.table : null;
  }
  /** 该图型是否支持数据表格（散点无「每类别聚合值」，数值 X 轴无类别） */
  function tableSupported(type, xIsValue) {
    if (xIsValue) return false;
    return type === 'line' || type === 'bar' || type === 'box' || type === 'hist';
  }
  /** 取计划 p 在第 j 个类别上的类别对象（分组时各组 gcats 与轴类别同序同长） */
  function planCat(p, cats, j) {
    if (p.gcats && p.gcats.length === cats.length) return p.gcats[j];
    return cats[j];
  }
  /** 单个数值 → 表格单元格文本（'—' = 无值；hist 频数取整） */
  function tableCell(v, dec, isCount) {
    if (v === null || v === undefined || typeof v !== 'number' || v !== v || !isFinite(v)) return '—';
    if (isCount) return String(Math.round(v));
    return YMS.util.fmtNumber(v, dec);
  }
  /**
   * 表格数据行：每个 Value 系列一行（图面聚合值）+ 勾选的统计量行（作用于 vcols[0]）
   *   line/bar → mean；box → median；hist → 频数；中位数连线/拟合曲线等派生系列不另占行
   *   （中位数连线与 box 行的中位数值重复）；散点不列入（无每类别聚合值）。
   * @returns {Array<{name:string, cells:string[], kind:string}>}
   */
  function tableRowsFor(plans, cats, vcol0, statItems, paintOf) {
    var rows = [], i, j;
    for (i = 0; i < plans.length; i++) {
      var p = plans[i];
      if (p.kind === 'median' || p.kind === 'scatter') continue;
      var vc = p.vc || vcol0;
      var dec = statDecimals(vc);
      var cells = new Array(cats.length);
      for (j = 0; j < cats.length; j++) {
        var c = planCat(p, cats, j);
        var v = null;
        if (p.hist) {
          v = num(c && c.count, null);
        } else {
          var st = (c && c.stats) ? c.stats[vc.name] : null;
          if (st && st.n) v = (p.kind === 'boxplot') ? st.median : st.mean;
        }
        cells[j] = tableCell(v, dec, !!p.hist);
      }
      rows.push({
        name: p.name, cells: cells, kind: 'series',
        /* 迭代 11：自定义分组色时行名随该色（未自定义 → null，沿用原表格文字色） */
        color: (typeof paintOf === 'function') ? paintOf(p) : null
      });
    }
    var items = statItems || [];
    if (items.length) {
      var dec2 = statDecimals(vcol0);
      for (i = 0; i < items.length; i++) {
        var cs = new Array(cats.length);
        for (j = 0; j < cats.length; j++) {
          var st2 = (cats[j] && cats[j].stats) ? cats[j].stats[vcol0.name] : null;
          cs[j] = statValueText(items[i], st2, dec2);
        }
        rows.push({ name: STAT_LABEL[items[i]] || String(items[i]), cells: cs, kind: 'stat' });
      }
    }
    return rows;
  }
  /**
   * 表格**纵向行序**（第五轮 · 用户需求：把「统计行」与「分组行 + 横轴参数行」上下对调）
   *
   * 返回的是每行的**槽位**（slot，0 = 最上一行），只改顺序不改数据：
   *   自上而下 = ① 统计行（STAT_ORDER 顺序）→ ② 系列行 → ③ 分组行（级 0 在最上）→ ④ 横轴参数行（表头，最下方）
   * 统计数据（rows 数组本身）不动 → 行数 nAll = rows.length + 1 + N 行分组行，与改前逐值相等。
   * 唯一的顺序权威：tableModel 用它算槽位、tableGraphic 用它定位 —— 两者共用一个对象，不可能错位。
   * @param {Array<{kind:string}>} rows 数据行（'series' | 'stat'）
   * @param {number} groupCount 分组行数（= 分组级数）
   */
  function tableRowSlots(rows, groupCount) {
    var n = (rows || []).length, i;
    var g = Math.max(0, num(groupCount, 0));
    var nStat = 0, nSeries = 0;
    for (i = 0; i < n; i++) { if (rows[i] && rows[i].kind === 'stat') nStat++; else nSeries++; }
    var rowSlots = new Array(n), si = 0, sj = 0;
    for (i = 0; i < n; i++) {
      rowSlots[i] = (rows[i] && rows[i].kind === 'stat') ? (si++) : (nStat + (sj++));
    }
    var groupSlots = new Array(g);
    for (i = 0; i < g; i++) groupSlots[i] = nStat + nSeries + i;
    return {
      nStat: nStat, nSeries: nSeries, groupCount: g,
      rowSlots: rowSlots, groupSlots: groupSlots,
      headerSlot: n + g,                       // 最下一行 = 横轴参数行（表头）
      nAll: n + 1 + g
    };
  }
  /**
   * 表格几何模型：列 = 「与 X 轴类别带同源」的可见列（放不下按几何抽稀），行 = 表头 + 数据行。
   * 列中心 cx = gridLeft + (i + 0.5) × band（band = (容器宽 − gridLeft − gridRight) / 类别数），
   * 故每列恒对准其正下方的 Box / 刻度（实测误差 ≤ 1px，见 iter7 自测）。
   * @param {{cats:Array, labels:Array, rows:Array, host:object, gridLeft:number, gridRight:number}} o
   * @returns {object|null} null = 不画（容器过窄 / 无类别）
   */
  function tableModel(o) {
    var cats = o.cats || [], labels = o.labels || null, rows = o.rows || [];
    var n = cats.length;
    if (!n || !rows.length) return null;
    var host = o.host || { mode: 'none', w: 0, h: 0 };
    if (!(host.w > 0)) return null;

    /* ① 行头列（系列名 / 统计量名 / 列名）所需左预留：不足才加宽 grid.left（不无故压缩绘图区） */
    var charW = TABLE.FONT * CHAR_W_RATIO;
    var headName = o.headName || 'X';
    var nameChars = String(headName).length, k;
    for (k = 0; k < rows.length; k++) {
      var rn = (rows[k].name === null || rows[k].name === undefined) ? '' : String(rows[k].name);
      if (rn.length > nameChars) nameChars = rn.length;
    }
    var rowHeadW = Math.ceil(nameChars * charW) + TABLE.CELL_PAD * 2;
    var needExtra = Math.max(0, (rowHeadW + TABLE.PAD_LEFT + TABLE.HEAD_GAP) - num(o.gridLeft, 48));
    var gridLeft = num(o.gridLeft, 48) + needExtra;

    /* ② 列：几何抽稀（每列至少 MIN_COL_W px；画出来的列永远对准其 Box） */
    var plotW = host.w - gridLeft - num(o.gridRight, 18);
    if (!(plotW > TABLE.MIN_COL_W)) return null;
    var band = plotW / n;
    var maxCols = Math.max(1, Math.floor(plotW / TABLE.MIN_COL_W));
    var step = Math.max(1, Math.ceil(n / maxCols));
    var idx = [], i;
    for (i = 0; i < n; i += step) idx.push(i);
    if (n > 1 && idx[idx.length - 1] !== n - 1) {
      var d = (n - 1) - idx[idx.length - 1];
      if (d >= step * 0.6 || idx.length === 1) idx.push(n - 1);
      else idx[idx.length - 1] = n - 1;
    }
    /* 单元格宽：不抽稀时 = 类别带（列恰好铺满绘图区，标准表格观感）；
       抽稀时 = 显示间距（step × band，上限 MAX_CELL_W）—— 单元格随其 Box 居中，数值右对齐不外溢 */
    var cellW = (step > 1) ? Math.min(step * band, TABLE.MAX_CELL_W) : band;
    if (!(cellW > 0)) cellW = band;                                    // 防御：常量缺失/异常时回到带宽
    var leftEdge = TABLE.PAD_LEFT, rightEdge = gridLeft + plotW;
    var cols = new Array(idx.length);
    for (i = 0; i < idx.length; i++) {
      var ci = idx[i];
      var cx = gridLeft + (ci + 0.5) * band;                           // 列中心 = 该类别带中心
      var cl = Math.max(leftEdge, cx - cellW / 2);
      var cr = Math.min(rightEdge, cx + cellW / 2);
      var tChars = Math.max(2, Math.floor((
        Math.min(2 * (cx - gridLeft + TABLE.HEAD_GAP), 2 * (cr - cx)) - TABLE.CELL_PAD * 2) / charW));
      var raw = (labels && labels[ci] !== undefined && labels[ci] !== null) ? String(labels[ci])
        : String((cats[ci] && cats[ci].label) || '');
      cols[i] = {
        i: ci,
        cx: cx,
        cellL: Math.round(cl * 100) / 100,
        cellR: Math.round(cr * 100) / 100,
        label: YMS.Axis.truncateLabel(raw, tChars)                      // 超宽截断，保证相邻列不压字
      };
    }

    /* ③ 纵向：底边距容器底边固定（与容器高度无关）；表格高度计入 grid.bottom */
    /* 迭代 28：第二层分组行 = 表格**首行**（每格 = 一个组，跨列合并；与图上分组边界左右对齐） */
    var gLevelsM = [], gi2, lvM;
    if (o.group) {
      if (o.group.levels && o.group.levels.length) {
        for (gi2 = 0; gi2 < o.group.levels.length; gi2++) {
          lvM = o.group.levels[gi2];
          if (lvM && num(lvM.h, 0) > 0 && lvM.runs && lvM.runs.length) gLevelsM.push(lvM);
        }
      } else if (num(o.group.h, 0) > 0 && o.group.runs && o.group.runs.length) {
        gLevelsM.push({ h: num(o.group.h, 0), runs: o.group.runs });
      }
    }
    /** 一级分组行 → 表格合并格（跨列；left/right 与图上该级分组边界同源） */
    function groupRowCells(lvX) {
      var arr = [];
      for (var q2 = 0; q2 < lvX.runs.length; q2++) {
        var gr2 = lvX.runs[q2];
        var glx2 = gridLeft + num(gr2.i0, 0) * band, grx2 = gridLeft + (num(gr2.i1, 0) + 1) * band;
        arr.push({
          label: (gr2.label === null || gr2.label === undefined) ? '' : String(gr2.label),
          index0: num(gr2.i0, 0), index1: num(gr2.i1, 0), count: num(gr2.count, 1),
          left: Math.round(glx2 * 100) / 100, right: Math.round(grx2 * 100) / 100,
          cx: Math.round((glx2 + grx2) / 2 * 100) / 100, span: Math.round((grx2 - glx2) * 100) / 100
        });
      }
      return arr;
    }
    var gCellsByLevel = [];
    for (gi2 = 0; gi2 < gLevelsM.length; gi2++) gCellsByLevel.push(groupRowCells(gLevelsM[gi2]));
    /* __table.groupCells 恒 = 级 0 的格（向上兼容）；N 级用 groupCellsByLevel */
    var gCells = gCellsByLevel.length ? gCellsByLevel[0] : [];
    var gOn = gCells.length > 0;
    var gRowCount = gCellsByLevel.length;
    /* 第五轮（用户需求：统计行 vs 分组/横轴参数行 上下对调）：
       纵向槽位由 tableRowSlots 唯一给出；nAll 仍是「数据行 + 表头 + N 行分组行」——
       行数逐值不变，变的只是谁在最上面 */
    var lay = tableRowSlots(rows, gRowCount);
    var nAll = lay.nAll;
    var tableH = nAll * TABLE.ROW_H;
    var padBottom = (host.mode === 'fs') ? TABLE.FS_PAD_BOTTOM : TABLE.PAD_BOTTOM;
    var gridBottom = num(o.xGridBottom, 44) + TABLE.GAP + tableH + padBottom;

    return {
      on: true,
      hostMode: host.mode, containerW: host.w, containerH: host.h,
      plotW: plotW, band: band, step: step,
      cols: cols, colCount: n, shownCount: cols.length, cellW: cellW,
      rows: rows, headerLabel: YMS.Axis.truncateLabel(String(headName), Math.max(2, Math.floor((rowHeadW - TABLE.CELL_PAD * 2) / charW))),
      rowNames: rows.map(function (r) { return r.name; }),
      nAll: nAll, tableH: tableH, padBottom: padBottom,
      /* 迭代 28：分组行（跨列合并）；第五轮起分组行位于**表格下部**（紧挨横轴参数行之上） */
      groupOn: gOn, groupCells: gCells, groupCellsByLevel: gCellsByLevel,
      groupRowCount: gRowCount, rowShift: gRowCount,
      /* 第五轮：纵向行序（slot 0 = 最上一行）= 统计行 → 系列行 → 分组行(级 0 起) → 横轴参数行 */
      layout: lay,
      rowHeadRight: gridLeft - TABLE.HEAD_GAP, leftEdge: leftEdge, rightEdge: rightEdge,
      gridLeft: gridLeft, gridLeftExtra: needExtra, gridBottom: gridBottom,
      font: tableFont()
    };
  }

  /** 一个 1px/整块矩形 graphic（用 left + bottom 定位，与容器高度无关） */
  function tableRect(left, bottom, w, h, fill) {
    return {
      type: 'rect', left: Math.round(left), bottom: Math.round(bottom),
      shape: { x: 0, y: 0, width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) },
      style: { fill: fill },
      silent: true, z: 20
    };
  }
  /**
   * 一个表内文本 graphic —— 用「锚点 + 实测文本宽度」定位（不依赖 textAlign 在画布上的生效情况）：
   *   align='right'  → 文本右边界落在 anchorX
   *   align='center' → 文本中心落在 anchorX
   * 竖直：bottom = 行底边距容器底边 + 2（盒顶落在行内，视觉基本居中；见 TABLE.LINE_H）
   * @param {number} anchorX 对齐锚点（px，距容器左边缘）
   * @param {number} bottom 底边距容器底边（px）
   * @param {string} text 文本
   * @param {'right'|'center'|'left'} align 对齐方式
   * @param {string} fill 颜色
   * @param {string} [font] 字体串
   */
  function tableText(anchorX, bottom, text, align, fill, font) {
    var ax = num(anchorX, 0);
    var w = textPx(text);
    var left = (align === 'right') ? (ax - w) : ((align === 'center') ? (ax - w / 2) : ax);
    return {
      type: 'text', left: Math.round(left * 100) / 100, bottom: Math.round(bottom),
      style: {
        text: text, fill: fill, font: font || tableFont(),
        textAlign: 'left', textVerticalAlign: 'top', lineHeight: TABLE.LINE_H
      },
      silent: true, z: 21
    };
  }
  /**
   * 把表格模型画成 graphic 元素数组（表头 / 行头底色 + 行列分隔线 + 全部单元格文本）
   * @param {object} m tableModel 的结果
   * @param {boolean} [frame] 迭代 8（需求 5）：是否补成「完整方框（含左侧行名列）」
   *        ① true  → 另加 左外框 / 右外框 / 行头列分隔线 三条竖线（上下外框与行分隔线原本就有）
   *        ② false → 与迭代 7 逐元素一致（回归红线）
   * @returns {Array<object>} ECharts graphic 元素（顶层元素，位置相对容器）
   */
  function tableGraphic(m, frame) {
    if (!m) return [];
    var els = [];
    var bg = cssVar('--panel-alt', TABLE.BG);
    var rowH = TABLE.ROW_H, nAll = m.nAll;
    /* ===== 第五轮：纵向行序（用户需求：统计行搬到上方，分组行 + 横轴参数行搬到最下方）=====
       槽位 slot 0 = 最上一行；slotBottom(slot) = 该行「行底边距容器底边」（越大越靠上）。
       每行的**左置行名列文字**与它的单元格共用同一个 slot → 行序怎么换都不会错位。 */
    var lay = m.layout || tableRowSlots(m.rows, (m.groupCellsByLevel || []).length);
    function slotBottom(slot) { return m.padBottom + (nAll - 1 - slot) * rowH; }
    function slotText(slot) { return slotBottom(slot) + Math.round((rowH - TABLE.LINE_H) / 2); }
    var headerSlot = num(lay.headerSlot, nAll - 1);
    var rowSlots = lay.rowSlots || [];
    var groupSlots = lay.groupSlots || [];
    var gCells = m.groupCells || [];
    var gByLevel = (m.groupCellsByLevel && m.groupCellsByLevel.length) ? m.groupCellsByLevel : (gCells.length ? [gCells] : []);
    /* 数据行（统计 + 系列）恒连续占表格最上方的一段 → 行头列底色 / 类别竖线按整段画 */
    var nData = m.rows.length;
    var dataBottom = m.padBottom + (nAll - nData) * rowH;
    /* 实际绘制出去的 bottom（供 __table.layout 断言：统计行整体在分组行上方） */
    var placed = { statBottoms: [], seriesBottoms: [], groupBottoms: [], headerTextBottom: null };
    /** 分组级 li 的槽位（缺 layout 时按「统计+系列之后」兜底，与新规则一致） */
    function groupSlotOf(li) {
      if (groupSlots.length > li) return num(groupSlots[li], 0);
      return num(lay.nStat, 0) + num(lay.nSeries, 0) + li;
    }
    /** 数据行 r 的槽位（缺 layout 时退化为 rows 数组顺序，不至于 NaN） */
    function rowSlotOf(r) { return (rowSlots.length > r) ? num(rowSlots[r], r) : r; }

    /* ① 底色：横轴参数行整行 + 行头列（数据行整段；统计行在上、系列行在其下） */
    els.push(tableRect(m.leftEdge, slotBottom(headerSlot), m.rightEdge - m.leftEdge, rowH, bg));
    if (nData > 0) {
      els.push(tableRect(m.leftEdge, dataBottom, m.rowHeadRight - m.leftEdge, nData * rowH, bg));
    }
    /* ② 横线：上下外框 + 每行之间（浅色分隔线）—— 行序变了，横线网格不变 */
    for (var j = 0; j <= nAll; j++) {
      var bo = m.padBottom + j * rowH;
      var outer = (j === 0 || j === nAll);
      els.push(tableRect(m.leftEdge, bo, m.rightEdge - m.leftEdge, 1, outer ? TABLE.FRAME : TABLE.LINE));
    }
    /* ③ 竖线：每个可见单元格的左右边界（不抽稀时 = 类别带边界，正好铺满；抽稀时 = 显示间距）
       分组行是跨列合并单元格 → 那一段不画类别竖线。分组行位于**下部**，故竖线拆成两段：
       横轴参数行（最下一行）一段 + 数据行（最上方整段）一段。 */
    var bounds = [], q;
    for (q = 0; q < m.cols.length; q++) {
      bounds.push(m.cols[q].cellL, m.cols[q].cellR);
    }
    for (q = 0; q < bounds.length; q++) {
      var x = Math.round(bounds[q] * 100) / 100;
      if (bounds.indexOf(x) !== q) continue;                           // 相邻列的公共边界只画一次
      els.push(tableRect(x, m.padBottom, 1, rowH, TABLE.LINE));
      if (nData > 0) els.push(tableRect(x, dataBottom, 1, nData * rowH, TABLE.LINE));
    }
    /* 分组行的组边界竖线（每格左沿 + 末格右沿）—— 这就是「跨列合并」的可见分隔 */
    for (var glv2 = 0; glv2 < gByLevel.length; glv2++) {
      var gRowL = gByLevel[glv2], gcb = slotBottom(groupSlotOf(glv2));
      for (q = 0; q < gRowL.length; q++) {
        els.push(tableRect(gRowL[q].left, gcb, 1, rowH, TABLE.FRAME));
        if (q === gRowL.length - 1) els.push(tableRect(gRowL[q].right, gcb, 1, rowH, TABLE.FRAME));
      }
    }
    /* 迭代 8（需求 5）frame = true：补上 左外框 / 右外框 / 行头列分隔线 三条竖线 →
       表格变成完整方框，且**左侧行名列（行头列）被框在框内**（否则只有上下两条外框线） */
    if (frame) {
      els.push(tableRect(m.leftEdge, m.padBottom, 1, nAll * rowH, TABLE.FRAME));
      els.push(tableRect(m.rowHeadRight, m.padBottom, 1, nAll * rowH, TABLE.FRAME));
      els.push(tableRect(m.rightEdge - 1, m.padBottom, 1, nAll * rowH, TABLE.FRAME));
    }
    /* ④ 文本：横轴参数行 = 类别名（居中于列中心 = 其 Box 中心，位于**最下一行**）；
          行头 = 统计量名 / 系列名（右对齐，跟着自己那行走）；单元格数值右对齐到单元格右边界 */
    for (q = 0; q < m.cols.length; q++) {
      els.push(tableText(m.cols[q].cx, slotText(headerSlot), m.cols[q].label, 'center', TABLE.TEXT, m.font));
    }
    /* 分组行文本（每组一个居中标签，跨该组全部列；超宽按组宽截断，绝不越出格线）
       —— 第五轮：分组行整块位于数据行之下、横轴参数行之上（级 0 仍在最上） */
    if (m.groupOn) {
      for (var glv3 = 0; glv3 < gByLevel.length; glv3++) {
        var gRowT = gByLevel[glv3];
        var gRowB = slotText(groupSlotOf(glv3));
        placed.groupBottoms.push(gRowB);
        for (q = 0; q < gRowT.length; q++) {
          var gcell = gRowT[q], gtxt = String(gcell.label);
          var maxCh = Math.max(1, Math.floor((gcell.span - TABLE.CELL_PAD * 2) / (TABLE.FONT * CHAR_W_RATIO)));
          if (gtxt.length > maxCh) gtxt = YMS.Axis.truncateLabel(gtxt, maxCh);
          els.push(tableText(gcell.cx, gRowB, gtxt, 'center', TABLE.TEXT, m.font));
        }
      }
    }
    placed.headerTextBottom = slotText(headerSlot);
    els.push(tableText(m.rowHeadRight, placed.headerTextBottom, m.headerLabel, 'right', TABLE.TEXT, m.font));
    for (var r = 0; r < m.rows.length; r++) {
      var row = m.rows[r], jr = slotText(rowSlotOf(r));
      (row.kind === 'stat' ? placed.statBottoms : placed.seriesBottoms).push(jr);
      els.push(tableText(m.rowHeadRight, jr, String(row.name), 'right',
        row.color || (row.kind === 'stat' ? '#5d6b78' : TABLE.TEXT), m.font));
      for (q = 0; q < m.cols.length; q++) {
        var c = m.cols[q];
        var cell = (row.cells && c.i < row.cells.length) ? row.cells[c.i] : '';
        if (cell === '' || cell === null || cell === undefined) continue;
        els.push(tableText(c.cellR - TABLE.CELL_PAD, jr, String(cell), 'right', TABLE.TEXT, m.font));
      }
    }
    /* 第五轮：把**实际绘制出去**的 bottom 交回模型（__table.layout 直接读它做断言） */
    m.placed = placed;
    return els;
  }

  /* ============ 横轴坐标表格（迭代 8 · 需求 5：含左侧行名；迭代 9：只旋转类别名 + 数值水平 + 包住全部内容） ============
     迭代 9 三条报障的修法（几何全部集中在本节，唯一来源）：
       ① 旋转非零时刻度标签只写**类别名**（axis.js 的 formatter），统计数值改由 graphic
          逐行水平绘制在旋转标签块**下方**（每统计量一行，行高 = 字号 × 1.18，与左侧行名同源）；
          每列数值水平居中于该类别带中心（与 Box / 刻度对齐）；数值列按几何**贪心抽稀**。
       ② 方框包住「行名列 + 旋转标签块 + 全部数值行」：行名列宽 = 行名文字**实测宽度**
          （textPx，canvas measureText）+ 两侧内边距；方框上边 = 旋转标签块顶端（不旋转 = 标签首行顶端），
          下边 = 最后一行数值底部；左/右边界恒落在容器内（left ≥ 0、right ≤ 容器宽）。
       ③ 所有行锚点由**最终 grid.bottom + 最终字号**推导：全屏路径（fullscreen.js）抬高
          grid.bottom（+34）/ 放大字号（+2）之后调用 reflowAxisTable() 重算并替换 graphic 元素 ——
          「行锚点按旧 grid.bottom 算」的 34px 错位归零。
     ※ 与 axis.js 的分工：axis.js 负责旋转角 / 统计行文本 / grid.bottom / grid.left 预留 / 行高与
       「旋转标签块高」两个纯函数（YMS.Axis.rowHFor / rotatedBlockH）；本文件负责把
       「行名 + 数值行 + 方框」画成 graphic，并按最终 grid.bottom 重新推导几何。 */
  var FRAME_LEFT = 4;            // 方框左边界（距容器左边缘，与 Axis.POLICY.HEADER_PAD 同值）
  /* 任务 E ②：行名文字右沿到 grid.left 的最小间距（px）—— 行名列不许贴到轴线上 */
  var ROWNAME_GAP = 4;
  var FRAME_PAD_T = 2;           // 方框上边与旋转标签块顶端的间距（px）
  var FRAME_PAD_B = 2;           // 方框下边与最后一行数值底部的间距（px）
  var NUM_MIN_GAP = 4;           // 相邻两个 kept 类别之间要求的最小空隙（px，迭代 13 起类别名与数值共用）
  /* 迭代 12 的 ROT_NUM_GAP(0.5) 在迭代 13 被收敛：数值旋转时统一用 NUM_MIN_GAP —— 旋转投影宽度
     已含字高，仍要求 4px 空隙只是更保守（宁可少显示也不错位），且与类别名集合保持同一判定。 */
  var ROT_SPILL_PAD = 4;         // 方框右边界相对旋转标签包围盒的额外余量（px，实测墨迹偏右 2~3px）
  var AXIS_ROW_STAT_COLOR = '#5d6b78';   // 统计量行名色（与数据表格的统计行同观感）

  /** 行名 / 数值行行高（与 axis.js 的 YMS.Axis.rowHFor 同源 → 只有一个定义） */
  function rowHOf(fontPx) {
    var AX = YMS.Axis;
    if (AX && typeof AX.rowHFor === 'function') return AX.rowHFor(fontPx);
    return Math.max(13, Math.round(num(fontPx, 11) * 1.18));
  }
  /** 旋转标签块高（与 axis.js 的 YMS.Axis.rotatedBlockH 同源） */
  function rotBlockHOf(rotate, labelPx, fontPx) {
    var AX = YMS.Axis;
    if (AX && typeof AX.rotatedBlockH === 'function') return AX.rotatedBlockH(rotate, labelPx, fontPx);
    return (num(rotate, 0) > 0) ? Math.round(num(labelPx, 0)) : Math.round(num(fontPx, 11) * 1.4);
  }
  function axisPolicyNum(key, dft) {
    var P = (YMS.Axis && YMS.Axis.POLICY) ? YMS.Axis.POLICY : {};
    return num(P[key], dft);
  }
  /** 行名 / 数值行文本的 graphic 元素（手动按实测宽度偏移定位，不依赖 ECharts 的 textAlign 行为） */
  /**
   * 任务 E ②：graphic 模式下**实际绘制**的行名集合（行名列宽只按这些文字实测）。
   * 旧实现把 headerTexts[0]（= 全部 X 列名拼成的字符串，如「Tool_Group-Chamber_Group-Layer-Lot」，
   * 全屏 13px 下实测 223px）也算进行名列宽 → grid.left 被撑到 261，左侧 0~164 全空；
   * 而真正画出来的行名只有 Mean/Std/Nu%/Lot/Layer/Chamber_Group/Tool_Group（最宽 94px）。
   * @param {string[]} headerTexts [0]=叶子参数行名（无 paramNames 时用），[1..]=统计量行名
   * @param {{leaf?:string, levels?:string[]}|null} paramNames 各级参数行名（= X 列名）
   * @returns {string[]} 实际绘制的行名文本
   */
  function rowNameTextsOf(headerTexts, paramNames) {
    var ht = headerTexts || [];
    var pn = (paramNames && typeof paramNames === 'object') ? paramNames : null;
    var out = [], i, v;
    v = (pn && pn.leaf !== undefined && pn.leaf !== null) ? pn.leaf
      : ((ht[0] === undefined || ht[0] === null) ? '' : ht[0]);
    out.push(String(v));
    for (i = 1; i < ht.length; i++) out.push((ht[i] === undefined || ht[i] === null) ? '' : String(ht[i]));
    if (pn && pn.levels && pn.levels.length) {
      for (i = 0; i < pn.levels.length; i++) {
        out.push((pn.levels[i] === undefined || pn.levels[i] === null) ? '' : String(pn.levels[i]));
      }
    }
    return out;
  }
  /** 行名列宽度 = 实测文字宽 + 两侧内边距（HEADER_TEXT_PAD） */
  function rowNameColW(texts, fontPx) {
    var pad = axisPolicyNum('HEADER_TEXT_PAD', 3);
    var w = 0, i, px;
    for (i = 0; i < (texts || []).length; i++) {
      px = textPx((texts[i] === undefined || texts[i] === null) ? '' : String(texts[i]), fontPx);
      if (px > w) w = px;
    }
    return { textPx: w, colW: Math.ceil(w) + pad * 2, pad: pad };
  }
  /**
   * 任务 E ②：grid.left 紧算 = max(Y 轴区实测留白, 方框左缘 + 行名列宽 + 行名右沿间距)。
   * 不再无条件叠加「X 轴全名」的表头预留（那才是 261 里 199px 的来源）。
   */
  function tightGridLeft(yPad, nameTextPx, fontPx) {
    var pad = axisPolicyNum('HEADER_TEXT_PAD', 3);
    var need = FRAME_LEFT + Math.ceil(num(nameTextPx, 0)) + pad * 2 + ROWNAME_GAP;
    return Math.round(Math.max(num(yPad, 0), need));
  }
  function axisRowText(anchorX, bottom, text, align, fontPx, fill) {
    var ax = num(anchorX, 0);
    var w = textPx(text, fontPx);
    var left = (align === 'right') ? (ax - w) : (ax - w / 2);
    return {
      type: 'text', left: Math.round(left * 100) / 100, bottom: Math.round(bottom),
      __axisBlock: true,
      style: {
        text: text, fill: fill || TABLE.TEXT,
        font: 'normal ' + num(fontPx, 11) + 'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
        textAlign: 'left', textVerticalAlign: 'top', lineHeight: rowHOf(fontPx)
      },
      silent: true, z: 21
    };
  }

  /* ========================== 迭代 12（需求 ③）：统计量旋转 ==========================
     约定（实测 zrender/ECharts 行为，见 build/ 下探针结论）：
       · graphic 文本设 `rotation`（**弧度**，元素级属性）+ `left` / `bottom` 时，
         ECharts 以「**旋转后的包围盒**」定位：盒左边 = left、盒下边 = 容器高 − bottom。
       · 故要把旋转文本的墨迹中心准确落在 (cx, 行带中心)：
           left   = cx − W′/2
           bottom = 行带底 + 行高/2 − H′/2
         其中 W′ = |w·cosθ| + |h·sinθ|、H′ = |w·sinθ| + |h·cosθ|（w = 实测文本宽、h = 行盒高）
         —— 两个式子都只用「距容器底边」表达，与容器高度无关（缩放 / 全屏不错位）。 */
  /** 统计量旋转角归一化（chart-builder 内部：与 axis.js 同一规则） */
  function normStatRot(v) {
    var AX = YMS.Axis;
    if (AX && typeof AX.statRotateOf === 'function') return AX.statRotateOf(v);
    var n = Number(v);
    return (n === 30 || n === 45 || n === 60 || n === 90) ? n : 0;
  }
  /** 统计量旋转角（读 chart.stats.rotate；aggregate 未透传时回落到 Store.plot.stats.rotate） */
  function statRotOf(chart) {
    var v = (chart && chart.stats) ? chart.stats.rotate : undefined;
    if (v === undefined || v === null) {
      var st = (YMS.Store && YMS.Store.state) ? YMS.Store.state.plot : null;
      v = (st && st.stats) ? st.stats.rotate : 0;
    }
    return normStatRot(v);
  }
  /** 数值行行带高度（与 axis.js 同源：θ=0 → 13；θ≠0 → sinθ·宽 + cosθ·字号 + 4） */
  function statRowHOf(rot, maxW, fontPx) {
    var AX = YMS.Axis;
    if (AX && typeof AX.statRowHFor === 'function') return AX.statRowHFor(rot, maxW, fontPx);
    var r = num(rot, 0);
    if (!(r > 0)) return rowHOf(fontPx);
    var th = r * Math.PI / 180;
    return Math.round(Math.ceil(Math.abs(Math.sin(th)) * Math.max(0, num(maxW, 0)) +
      Math.abs(Math.cos(th)) * num(fontPx, 11) + 4));
  }
  /** 旋转文本包围盒宽（水平投影）—— 抽稀判定用 */
  function rotBoxWOf(w, h, rot) {
    var AX = YMS.Axis;
    if (AX && typeof AX.rotBoxW === 'function') return AX.rotBoxW(w, h, rot);
    var r = num(rot, 0);
    if (!(r > 0)) return num(w, 0);
    var th = r * Math.PI / 180;
    return Math.abs(num(w, 0) * Math.cos(th)) + Math.abs(num(h, 0) * Math.sin(th));
  }
  /** 旋转文本包围盒高（竖向占用） */
  function rotBoxHOf(w, h, rot) {
    var AX = YMS.Axis;
    if (AX && typeof AX.rotBoxH === 'function') return AX.rotBoxH(w, h, rot);
    var r = num(rot, 0);
    if (!(r > 0)) return num(h, 0);
    var th = r * Math.PI / 180;
    return Math.abs(num(w, 0) * Math.sin(th)) + Math.abs(num(h, 0) * Math.cos(th));
  }
  /**
   * 按角度绘制的统计数值文本（旋转后的包围盒中心 = (left + W′/2, bottom 上方的行带中心)）
   * @param {number} left   旋转后包围盒左边（距容器左边缘）
   * @param {number} bottom 旋转后包围盒下边（距容器底边）
   * @param {string} text   数值文本
   * @param {number} rotDeg 旋转角（度）
   */
  function axisRotText(left, bottom, text, rotDeg, fontPx, fill) {
    return {
      type: 'text',
      left: Math.round(num(left, 0) * 100) / 100,
      bottom: Math.round(num(bottom, 0)),
      rotation: num(rotDeg, 0) * Math.PI / 180,
      __axisBlock: true,
      style: {
        text: text, fill: fill || TABLE.TEXT,
        font: 'normal ' + num(fontPx, 11) + 'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
        textAlign: 'left', textVerticalAlign: 'top', lineHeight: rowHOf(fontPx)
      },
      silent: true, z: 21
    };
  }
  /**
   * 数值文本「超宽 → 先降精度」（只做**不改变数值含义**的降位：如 '13.00' → '13.0' → '13'）；
   * 已合规或无法安全降位时返回原值，仍不合规（超过方框内宽）由调用方判为「不绘」。
   */
  function compactNumText(text, availW, fontPx) {
    var s = (text === null || text === undefined) ? '' : String(text);
    if (!s || textPx(s, fontPx) <= availW) return s;
    var m = /^-?\d+(?:\.(\d+))?$/.exec(s.trim());
    if (!m) return s;
    var v = Number(s);
    if (!isFinite(v)) return s;
    var dec = m[1] ? m[1].length : 0;
    for (var d = dec - 1; d >= 0; d--) {
      var cand = v.toFixed(d);
      if (textPx(cand, fontPx) <= availW) return cand;
    }
    return s;
  }
  /**
   * 横轴坐标表格几何（迭代 9 · 唯一来源）。
   * 输入 = 最终 grid.bottom + 最终字号 + 类别标签 + 统计数值行文本；输出 = 行名列 / 数值行 /
   * 方框的全部锚点（一律以「距容器底边」表达 → 与容器高度无关，缩放 / 全屏不错位）。
   * @param {object} o { labels, statLines, headerTexts, statRows, rotate, lineHeight,
   *                     gridBottom, fontSize, gridLeft, gridRight, host, centerOf }
   *        centerOf(i) → 类别 i 的像素中心 x（迭代 9 · dataZoom 缩放态由 fullscreen.js 用
   *        ECharts 自身的刻度映射传入；缺省 = gridLeft + (i + 0.5) × 带宽）
   * @returns {object|null} null = 不画（无类别 / 无行名）
   */
  function axisTableLayout(o) {
    o = o || {};
    var headerTexts = o.headerTexts || [];
    var labels = o.labels || [];
    /* 迭代 30（任务 D ①）：参数行的行名 = 对应 X 列名（叶子列 + 各级列），由 o.paramNames 传入。
       顺序只由 X 列序决定：叶子列 = 最后一个 X 列，级 L = 第 L+1 个 X 列。 */
    var paramNames = (o.paramNames && typeof o.paramNames === 'object') ? o.paramNames : null;
    var leafName = (paramNames && paramNames.leaf !== undefined && paramNames.leaf !== null) ? String(paramNames.leaf) : '';
    var levelNames = (paramNames && paramNames.levels && paramNames.levels.length) ? paramNames.levels : [];
    var n = labels.length;
    var statRows = Math.max(0, Math.floor(num(o.statRows, 0)));
    var rows = statRows + 1;
    if (!n || headerTexts.length < 1) return null;
    var fontPx = num(o.fontSize, 11);
    var rotate = num(o.rotate, 0);
    /* 迭代 12（需求 ③）：统计量自身旋转角（与 rotate = 类别名旋转角完全独立） */
    var statRotate = normStatRot(o.statRotate);
    var host = o.host || { mode: 'none', w: 0, h: 0 };
    var gl = num(o.gridLeft, 0), gr = num(o.gridRight, 0);
    var w = (host && num(host.w, 0) > 0) ? num(host.w, 0) : (ASSUME_PLOT_W + gl + gr);
    var plotW = Math.max(1, w - gl - gr);
    var gridBottom = num(o.gridBottom, 0);
    var labelMargin = axisPolicyNum('AXIS_LABEL_MARGIN', 7);
    /* 迭代 28：第二层分组行（同一组一个居中标签，横跨该组全部 bar）
       —— 分组行占「轴线与类别标签块之间」的一段高度，故标签块整体下移 gBand。 */
    var gRow = o.group || null;
    /* N 级分组行：每级各一条带（级 0 靠绘图区 = 最上，编号递增向下）。
       底部留白 = 全部级的 (行高 + 级间距) 之和 —— 绝不裁掉任何一级的标签。 */
    var gLevelsIn = [], gq0, lvIn;
    if (gRow && gRow.levels && gRow.levels.length) {
      for (gq0 = 0; gq0 < gRow.levels.length; gq0++) {
        lvIn = gRow.levels[gq0];
        if (lvIn && num(lvIn.h, 0) > 0 && lvIn.runs && lvIn.runs.length) gLevelsIn.push(lvIn);
      }
    } else if (gRow && num(gRow.h, 0) > 0 && gRow.runs && gRow.runs.length) {
      gLevelsIn.push({ h: Math.round(num(gRow.h, 0)), gap: num(gRow.gap, 0), runs: gRow.runs });
    }
    var gH = gLevelsIn.length ? Math.round(num(gLevelsIn[0].h, 0)) : 0;
    var gGap = gLevelsIn.length ? Math.max(0, Math.round(num(gLevelsIn[0].gap, 3))) : 0;
    var gBand = 0;
    for (gq0 = 0; gq0 < gLevelsIn.length; gq0++) {
      gBand += Math.round(num(gLevelsIn[gq0].h, 0)) + Math.max(0, Math.round(num(gLevelsIn[gq0].gap, 3)));
    }
    var labelMarginEff;
    /* 第六轮（轴层通道 · 用户报障）：纵向次序改为「统计行 → 分组带 → 轴标签」。
       labelMarginEff（= 轴线到类别标签块顶端的距离）必须把**统计行带**也算进去，
       故推迟到 rowH / statMode 定稿后再算（见下方 statBandH 处）。 */

    /* 迭代 21：标签块与统计行带之间的最小间距（与 Axis.bottomFit 的 BOTTOM_ROW_GAP 同源） */
    var rowGap = axisPolicyNum('BOTTOM_ROW_GAP', 3);
    var lineH = num(o.lineHeight, axisPolicyNum('STAT_ROW_H', 13));
    /* 迭代 12：statRotate ≠ 0 也必须走 graphic（多行刻度标签只有一个夹角）。
       迭代 21：axis.js 判定为 graphic（刻度标签只写类别名）时 **一律沿用** —— 即使因容器太矮
       把统计行数降到 0，也不能退回「多行标签」口径（否则会多画一块行名表头、与单行刻度标签错位）。 */
    var statMode = (o.forceGraphic === true) ? 'graphic'
      : (((rotate !== 0 || statRotate !== 0) && statRows > 0) ? 'graphic' : 'axis');
    var statLines0 = o.statLines || [];
    /* 数值文本最大宽度（行带高度 / 抽稀投影宽度都用它；rotate=0 时逐值不变） */
    var maxStatW = 0;
    for (i = 0; i < statLines0.length; i++) {
      var sl0 = (statLines0[i] === null || statLines0[i] === undefined) ? '' : String(statLines0[i]);
      if (sl0 === '') continue;
      var parts0 = sl0.split('\n');
      for (var k0 = 0; k0 < parts0.length; k0++) {
        var pw0 = textPx(parts0[k0], fontPx);
        if (pw0 > maxStatW) maxStatW = pw0;
      }
    }
    var rowH = (statMode === 'graphic')
      ? statRowHOf(statRotate, maxStatW, fontPx)
      : Math.max(1, Math.round(lineH));
    /* 旋转数值文本的未旋转行盒高（= axisRowText 的 lineHeight，ECharts 以此计旋转包围盒） */
    var statBoxLineH = rowHOf(fontPx);
    /* 第六轮：统计行**独立成带**（graphic 模式）时，它整块排在分组带之上。
       statBandH = 行间距 + 各统计行行高之和；多行标签路径（axis 模式）统计行就在标签块内部 → 0。 */
    var statBandH = (statMode === 'graphic' && statRows > 0) ? (rowGap + statRows * rowH) : 0;
    /* 迭代 30（任务 D ①）：轴线 → 类别标签块顶端的距离 = 轴标签间距 + 统计行带。
       分组带已移到类别标签行**之下**（自上而下：统计行 → 标签行(叶子列) → 级 N-1 … 级 0），
       故不再计入本距离；grid.bottom 的总和不变（顺序无关）。 */
    labelMarginEff = labelMargin + statBandH;
    var pad = axisPolicyNum('HEADER_TEXT_PAD', 3);

    /* ① 旋转标签块高：按最长类别标签**实测宽度**（rotate=0 时不旋转 → 块高 = 单行行盒高） */
    var maxLabelPx = 0, i, t, lw;
    for (i = 0; i < n; i++) {
      t = (labels[i] === null || labels[i] === undefined) ? '' : String(labels[i]);
      lw = textPx(t, fontPx);
      if (lw > maxLabelPx) maxLabelPx = lw;
    }
    var rotH = rotBlockHOf(rotate, maxLabelPx, fontPx);

    /* ② 纵向锚点：labelTop = 刻度标签块顶端；colBase = 统计行带底边；方框上下边由它们推出
       第六轮（不变式）：统计行**整块在分组带之上**，分组带在标签块之上
         labelTop      = gridBottom − (轴标签间距 + 统计行带 + 分组带)
         分组带         ∈ [labelTop, labelTop + gBand]
         colBase       = labelTop + gBand + 行间距（统计行带底边）
         统计行带       ∈ [colBase, colBase + statRows×rowH]
       ⇒ 屏幕坐标「统计行带顶边 ≥ 绘图区下沿 + 轴标签间距」→ 永不侵入绘图区；
         「标签块与统计行之间隔着整条分组带（≥ 0）」→ 永不重叠。
       grid.bottom 由 Axis.bottomFit 按同一组量相加给出（总和与次序无关 → 数值不变）。 */
    var labelTop = Math.round(gridBottom - labelMarginEff);
    var statBase = Math.round(labelTop + (statBandH > 0 ? rowGap : 0));
    var statTop = statBase + (statMode === 'graphic' ? statRows * rowH : 0);
    /* 迭代 30（任务 D ①）：**参数行栈**（自上而下）= 叶子标签行 → 级 N-1 → … → 级 0。
       几何：标签块底边 = labelTop − labelBlockH；此后每一级向下 = 上一带底边 − 本级 gap − 本级 h。
       级 0（第一个 X 列）自然落在**最底部** —— 顺序由 X 列序推导，不是整块翻转。 */
    var labelBlockH = (statMode === 'graphic') ? rotH : Math.round(rows * rowH);
    var labelBlockBottom = Math.round(labelTop - labelBlockH);
    var levelBottoms = new Array(gLevelsIn.length), lbCur = labelBlockBottom, lbL, lbGap, lbH;
    for (lbL = gLevelsIn.length - 1; lbL >= 0; lbL--) {
      lbGap = Math.max(0, Math.round(num(gLevelsIn[lbL].gap, 3)));
      lbH = Math.round(num(gLevelsIn[lbL].h, 0));
      levelBottoms[lbL] = Math.round(lbCur - lbGap - lbH);
      lbCur = levelBottoms[lbL];
    }
    /* 参数行栈的**最底边**（距容器底）= 最下面那一级（级 0）的下边；无分组级时 = 标签块底边 */
    var stackBottomY = gLevelsIn.length ? Math.round(Math.min.apply(null, levelBottoms)) : labelBlockBottom;
    var colBase, frameBottom, frameTop;
    if (statMode === 'graphic') {
      colBase = statBase;
      /* 最低的元素现在是**参数行栈最下一行**（级 0）→ 方框下边贴它 */
      frameBottom = Math.max(0, stackBottomY - FRAME_PAD_B);
      /* 方框上边 = 统计行带顶边（无统计行时退化为标签块顶端） */
      frameTop = Math.max(labelTop, statTop) + FRAME_PAD_T;
    } else {
      colBase = Math.round(labelTop - rows * rowH);
      frameBottom = Math.max(0, stackBottomY - FRAME_PAD_B);
      frameTop = Math.max(labelTop, colBase + rows * rowH);
    }
    /* 迭代 28：分组行在标签块之上 —— 方框上边随之上移，整块把分组行包进来 */
    if (gBand > 0) frameTop = Math.max(frameTop, labelTop + gBand);
    gBand = Math.max(0, Math.min(gBand, frameTop - frameBottom));
    frameBottom = Math.max(0, frameBottom);
    var frameH = Math.max(1, frameTop - frameBottom);

    /* ③ 行名列（迭代 10 · 需求 C）：**右边界 = 绘图区左边界 gridLeft**，左边界 = 容器左缘 + FRAME_LEFT。
       即「行名列的左右边界与上方 Y 轴区（Y 轴标题 + 刻度那一列）严格一致」，表格主体紧接 gridLeft
       开始 → 方框的左侧区域与主体连成一张表，中间不留缺口（迭代 9 时行名列只有文字宽 + 内边距，
       右边界 ≈ 38px 而 gridLeft ≈ 108px，中间 70px 空隙让方框看着断成两块）。
       行名文字仍右对齐到 rowHeadRight − 内边距（文字实测宽度见 ③b），列宽足够；
       容器极窄（gridLeft 不足以容纳文字 + 内边距）时兜底取「最小可用宽」，保证文字永不越出左外框。 */
    /* 任务 E ②：行名列宽按**实际绘制**的行名实测（graphic 模式不再把 X 轴全名算进来）；
       axis 模式（多行标签块 = 所有 headerTexts 一次性右对齐绘制）保持旧口径 —— 回归红线。 */
    var nameTexts = (statMode === 'graphic') ? rowNameTextsOf(headerTexts, paramNames) : headerTexts;
    var nameW = 0;
    for (i = 0; i < nameTexts.length; i++) {
      var hs = (nameTexts[i] === null || nameTexts[i] === undefined) ? '' : String(nameTexts[i]);
      var hw = textPx(hs, fontPx);
      if (hw > nameW) nameW = hw;
    }
    var left = Math.max(0, FRAME_LEFT);
    var colWMin = Math.ceil(nameW) + pad * 2;          // 行名列装得下行名的最小宽度
    var glSafe = (gl > 0) ? gl : (left + colWMin);     // 无 gridLeft（Node 桩环境）时退化为最小宽
    var rowHeadRight = Math.round(Math.max(glSafe, left + colWMin));
    var colW = rowHeadRight - left;
    /* 行名文字右沿锚点：距轴线（= grid.left）至少 ROWNAME_GAP(4px)，绝不贴到轴线上。
       多留 1px 余量：文字实测宽度与 textPx 估算有 ~0.005px 的亚像素差（实测 painted 右沿
       = 锚点 + 0.0045），故 graphic 模式锚点取 ROWNAME_GAP + 1 → 实测间距恒 ≥ 4px。
       axis 模式（多行标签块）保持旧的 −pad 口径不动 —— 回归红线。 */
    var nameGapRight = (statMode === 'graphic')
      ? Math.round(Math.max(ROWNAME_GAP + 1, pad))
      : Math.round(pad);

    /* ④ 横向：列分隔线 = 类别带边界（极多时几何抽稀）；右边界 = 绘图区右边界。
       迭代 9 · B：旋转标签以「类别带中心」对齐，最右一块会向右溢出绘图区（实测 120 类 / 90° 时
       溢出 5~8px）→ 方框右边界按旋转标签的水平半宽外扩（**仅旋转非零时**，rotate=0 逐值不变），
       并以「容器宽 - 1」为上限（绝不越出容器）。 */
    var band = plotW / Math.max(1, n);
    var plotR = gl + plotW;
    var lastBandCx = plotR - band / 2;                 // 最右一块类别带的中心（= 其标签对齐中心）
    var spillR = 0;
    if (rotate !== 0) {
      var th = rotate * Math.PI / 180;
      var lineHpx = fontPx * axisPolicyNum('ROT_LINE_H_RATIO', 1.4);
      var labelHalfW = Math.max((Math.abs(maxLabelPx * Math.cos(th)) + Math.abs(lineHpx * Math.sin(th))) / 2,
        lineHpx / 2);
      /* 方框右边界 ≥ 最右一块标签的右边界（含 ROT_SPILL_PAD 余量）：
         实测旋转文本的墨迹会偏向包围盒右侧 2~3px（基线上移），故给 4px 余量 */
      spillR = Math.max(0, (lastBandCx + labelHalfW + ROT_SPILL_PAD) - plotR);
    }
    var right = Math.max(rowHeadRight + 1, plotR + spillR);
    right = Math.min(right, Math.max(rowHeadRight + 1, Math.round(w) - 1));
    /* 列分隔线 = 类别带边界；缩放态（centerOf 提供）改取「相邻类别中心的中点」→ 分隔线跟着缩放走 */
    var centerOf = (typeof o.centerOf === 'function') ? o.centerOf : null;
    function cxOf(idx) {
      var cx = centerOf ? centerOf(idx) : (gl + (idx + 0.5) * band);
      return (typeof cx === 'number' && isFinite(cx)) ? cx : (gl + (idx + 0.5) * band);
    }
    /* 迭代 30（任务 D ②）：缩放态下的当前带宽 + 可见类别窗口。
       band 由相邻类别中心的实测间距给出（ECharts 自身刻度映射 → 缩放后必变小）；
       窗口 = 中心落在 [gl − band/2, plotR + band/2] 内的类别索引区间（含两端半露的类别）。 */
    var zBand = band, zV0 = 0, zV1 = n - 1;
    if (centerOf && n > 1) {
      var diffs = [];
      for (i = 1; i < n; i++) diffs.push(cxOf(i) - cxOf(i - 1));
      diffs.sort(function (a, b2) { return a - b2; });
      var medD = diffs[Math.floor(diffs.length / 2)];
      if (typeof medD === 'number' && isFinite(medD) && medD > 0) zBand = medD;
      /* 窗口 = **整条类别带都落在绘图区内**的索引区间（边缘半露的类别不计 —— 它的格宽会被
         gl/plotR 截断，span 就不再等于 count × 带宽，与「合并格跨度 == 可见类别数 × 带宽」冲突） */
      var lo = gl - 0.5, hi = plotR + 0.5;
      var first = -1, last = -1;
      for (i = 0; i < n; i++) {
        var cxi = cxOf(i);
        if (cxi - zBand / 2 >= lo && cxi + zBand / 2 <= hi) { if (first < 0) first = i; last = i; }
      }
      if (first >= 0) { zV0 = first; zV1 = last; }
    }
    /**
     * 迭代 30（任务 D ②）：一个分组 run 的**当前**横向几何 + 可见计数。
     *   全量态（无 centerOf）：left/right = 类别带边界（带宽 = plotW / n），count = run 全量；
     *   缩放态：left/right = 该 run 可见部分的**首/末类别中心的半带宽外沿**
     *           → span == count × 当前带宽（误差 ≤1px），count == 该 run 在窗口内的类别数。
     * @returns {null|{i0:number,i1:number,count:number,left:number,right:number}}
     */
    function groupCellGeo(gr, lvIdx) {
      var r0 = num(gr.i0, 0), r1 = num(gr.i1, r0);
      if (!centerOf) {
        return {
          i0: r0, i1: r1, count: Math.max(1, num(gr.count, r1 - r0 + 1)),
          left: Math.round((gl + r0 * band) * 100) / 100,
          right: Math.round((gl + (r1 + 1) * band) * 100) / 100
        };
      }
      /* 缩放态：把 run 夹到可见窗口内；完全不可见 → 不出格 */
      var c0 = Math.max(r0, zV0), c1 = Math.min(r1, zV1);
      if (c1 < c0) return null;
      var lx = Math.max(gl, cxOf(c0) - zBand / 2);
      var rx = Math.min(plotR, cxOf(c1) + zBand / 2);
      return {
        i0: c0, i1: c1, count: c1 - c0 + 1,
        left: Math.round(lx * 100) / 100, right: Math.round(rx * 100) / 100
      };
    }
    var colXs = [];
    if (centerOf && n > 1) {
      var mids = [], prev = null;
      for (i = 0; i < n; i++) {
        var cxp = cxOf(i);
        if (prev !== null && cxp >= gl && prev <= plotR) mids.push((prev + cxp) / 2);
        prev = cxp;
      }
      var stepM = Math.max(1, Math.ceil(mids.length / FRAME_MAX_COLS));
      for (i = 0; i < mids.length; i += stepM) colXs.push(mids[i]);
    } else if (n > 1) {
      var stepC = Math.max(1, Math.ceil(n / FRAME_MAX_COLS));
      for (i = stepC; i < n; i += stepC) colXs.push(gl + i * band);
      if (colXs.length > FRAME_MAX_COLS) colXs = colXs.slice(0, FRAME_MAX_COLS);
    }

    /* ⑤ 数值行（graphic 模式）：**与类别名共用一个 kept 集合**（迭代 13）
       —— 类别名足迹（旋转后 |w·cosθ| + |h·sinθ|）与数值足迹（多统计量取最宽投影）
          都不与上一个 kept 类别重叠时才保留；标签与数值同用这一个集合，故
          「每个画出的数值正上方都有类别名、每个显示的类别名下方都有数值行」。
          抽稀粒度取两者较差者（宁可少显示，也不错位）。
       旧实现（迭代 9~12）数值另跑一套「与上一已绘值间隙 ≥ NUM_MIN_GAP」的贪心 ——
       与 ECharts 按**标签足迹**的抽稀集合不一致，正是用户看到「label 与数据不对齐」的成因。 */
    var statLines = o.statLines || [];
    var numRows = [], numCols = [];
    var skipped = 0, keptFlags = null, keptCount = 0, keptIdx = [];
    var cellR = gl + plotW;
    var availW = Math.max(8, cellR - gl);
    if (statMode === 'graphic') {
      /* ⑤a 数值行文本定稿：超宽先降精度（只做不改变数值含义的降位），仍超宽 → 该列不绘 */
      var numTexts = new Array(n);
      for (i = 0; i < n; i++) {
        numTexts[i] = null;
        var line = (statLines[i] === null || statLines[i] === undefined) ? '' : String(statLines[i]);
        if (line === '') continue;
        var parts = line.split('\n'), widest = 0, k, pv;
        for (k = 0; k < parts.length; k++) {
          pv = textPx(parts[k], fontPx);
          if (pv > widest) widest = pv;
        }
        if (!(widest > 0)) continue;
        if (widest > availW) {
          var wAfter = 0;
          for (k = 0; k < parts.length; k++) {
            parts[k] = compactNumText(parts[k], availW, fontPx);
            pv = textPx(parts[k], fontPx);
            if (pv > wAfter) wAfter = pv;
          }
          widest = wAfter;
          if (widest > availW) continue;             // 仍放不下 → 不绘（绝不越界）
        }
        numTexts[i] = parts;
      }
      /* ⑤b 统一抽稀（唯一来源 = YMS.Axis.keptIndices）：类别名与数值共用同一 kept 集合 */
      var AXk = YMS.Axis;
      var keptRes = (AXk && typeof AXk.keptIndices === 'function')
        ? AXk.keptIndices({
          n: n, labels: labels, numTexts: numTexts, fontSize: fontPx,
          rotate: rotate, statRotate: statRotate,
          labelLineH: fontPx * axisPolicyNum('ROT_LINE_H_RATIO', 1.4),
          statLineH: statBoxLineH, centerOf: cxOf,
          leftBound: gl, rightBound: cellR, gap: NUM_MIN_GAP,
          requireValue: true, measurePx: textPx
        })
        : null;
      if (!keptRes) {                                // 兜底（axis.js 未就绪时不让整块消失）
        keptRes = { kept: [], indices: [], count: 0 };
        for (i = 0; i < n; i++) {
          keptRes.kept[i] = !!numTexts[i];
          if (numTexts[i]) keptRes.indices.push(i);
        }
        keptRes.count = keptRes.indices.length;
      }
      keptFlags = keptRes.kept; keptCount = keptRes.count; keptIdx = keptRes.indices.slice();
      /* ===== 任务 G（用户报障「缩放后不是每个 box 正下方都有自己的数据」）=====
         表格通道**不再抽稀**：窗口内每个有数值的类别都保留一列。
         旧行为（keptIndices 的「与上一 kept 足迹重叠就跳过」）会让缩放后
         一部分 box 下方没有数据列（用户看到的「数据只集中在一处」就是它）。
         只有带宽窄到连一个字都放不下（< MIN_LEGIBLE_BAND）才退回旧抽稀 ——
         那已经不是「少几列」，而是任何画法都读不出来。 */
      var winLo = centerOf ? zV0 : 0, winHi = centerOf ? zV1 : n - 1;
      if (!(centerOf && zBand < MIN_LEGIBLE_BAND)) {
        keptFlags = new Array(n);
        keptIdx = [];
        for (i = 0; i < n; i++) keptFlags[i] = false;
        for (i = winLo; i <= winHi; i++) {
          if (!numTexts[i]) continue;               // 该类别没有数值文本（缺数据）→ 不出列
          keptFlags[i] = true;
          keptIdx.push(i);
        }
        keptCount = keptIdx.length;
      }
      /* ⑤c 只对 kept 集合绘数值：位置仍严格对准该类别中心（与刻度标签同一锚点）
         任务 G：kept 集合已改为「窗口内全部有数值的类别」（见上），不再是抽稀集合。 */
      for (var qi = 0; qi < keptIdx.length; qi++) {
        i = keptIdx[qi];
        var partsK = numTexts[i];
        if (!partsK) continue;
        var cx = cxOf(i);
        if (!(typeof cx === 'number' && isFinite(cx))) continue;
        var widestK = 0, pvK;
        for (k = 0; k < partsK.length; k++) {
          pvK = textPx(partsK[k], fontPx);
          if (pvK > widestK) widestK = pvK;
        }
        var projW = (statRotate > 0) ? rotBoxWOf(widestK, statBoxLineH, statRotate) : widestK;
        var col = { i: i, cx: Math.round(cx * 100) / 100, w: Math.round(projW * 10) / 10, texts: partsK };
        if (statRotate > 0) {
          /* 逐行（逐统计量）算「旋转包围盒」宽高：文本宽各不相同 → 逐条居中 */
          col.cells = [];
          for (k = 0; k < statRows; k++) {
            var ctext = (k < partsK.length) ? partsK[k] : '';
            var cw = textPx(ctext, fontPx);
            var bw = rotBoxWOf(cw, statBoxLineH, statRotate);
            var bh = rotBoxHOf(cw, statBoxLineH, statRotate);
            var bandBottom = colBase + (statRows - 1 - k) * rowH;
            col.cells.push({
              text: ctext, w: Math.round(cw * 10) / 10, boxW: Math.round(bw * 10) / 10, boxH: Math.round(bh * 10) / 10,
              left: Math.round((cx - bw / 2) * 100) / 100,
              bottom: Math.round(bandBottom + rowH / 2 - bh / 2)
            });
          }
        }
        numCols.push(col);
      }
      skipped = n - numCols.length;
      for (i = 0; i < statRows; i++) numRows.push({ k: i, bottom: colBase + (statRows - 1 - i) * rowH });
    }

    /* ⑥ 行名逐行锚点：第 1 行（X 轴列名）**顶端对齐**到行名列顶部单元格顶端（= 旋转标签块顶端，
       与「数据文本块顶端」对齐；实测黑盒 lane D1/D2 要求偏差 ≤1.5px），
       其后每行与数值行**逐行同锚点**（中心完全重合 → 偏差 0） */
    var nameRows = [];
    var paramRows = [];
    if (statMode === 'graphic') {
      var nameLineH = rowHOf(fontPx);          // 迭代 12：行名文本自身的行盒高（数值行带可能更高）
      for (i = 0; i < rows; i++) {
        var txt = (headerTexts[i] === null || headerTexts[i] === undefined) ? '' : String(headerTexts[i]);
        if (i === 0) {
          /* 迭代 30：首行 = **叶子参数行**（X 最后一列）的行名，竖直居中于该行带内
             （该行带现在紧贴统计行下方，是参数行栈的第一行） */
          nameRows.push({
            i: 0, kind: 'head',
            text: leafName || txt,
            bottom: Math.round(labelBlockBottom + (labelBlockH - nameLineH) / 2)
          });
        } else {
          var bandB = colBase + (statRows - i) * rowH;
          nameRows.push({
            i: i, text: txt, kind: 'stat',
            bottom: Math.round(bandB + rowH / 2 - nameLineH / 2)
          });
        }
      }
      /* 迭代 30：各分组级的行名跟着自己的行走（级 L 的行带 = groupLevels 的 bottom/h） */
      for (i = 0; i < gLevelsIn.length; i++) {
        var pvN = (levelNames[i] === null || levelNames[i] === undefined) ? '' : String(levelNames[i]);
        if (!pvN) continue;
        var pHi = Math.round(num(gLevelsIn[i].h, 0));
        paramRows.push({
          level: i, name: pvN,
          bottom: levelBottoms[i] + Math.round((pHi - nameLineH) / 2),
          bandBottom: levelBottoms[i], bandH: pHi
        });
      }
    }
    /* 迭代 28：分组行单元格（每格 = 一个组，横跨 count×band；文字居中；放不下 → 90°）
       位置一律用**最新带宽**重算（全屏 / 缩放后带宽变），旋转角沿用预算期的判定
       —— 保证「留白高度」与「实际绘制」永远是同一个决定。 */
    var groupCells = [], groupLevels = [], groupBottom = 0;
    var gLx;
    if (gLevelsIn.length) {
      /* 迭代 30：纵向位置全部来自上面推导的 levelBottoms（级 N-1 → 级 0 自上而下），
         不再「由下往上累加」的旧算法 —— 旧算法把级 0 放在最上（紧贴绘图区）。 */
      for (gLx = 0; gLx < gLevelsIn.length; gLx++) {
        var lvC = gLevelsIn[gLx], hC = Math.round(num(lvC.h, 0));
        var gapC = Math.max(0, Math.round(num(lvC.gap, 3))), botC = levelBottoms[gLx];
        var cellsC = [], rotC = 0;
        for (i = 0; i < lvC.runs.length; i++) {
          var gr = lvC.runs[i];
          var cellGeo = groupCellGeo(gr, gLx);
          if (!cellGeo) continue;                       // 缩放窗口内不可见 → 不出格
          var tw = textPx(gr.label, fontPx), rotD = num(gr.rotate, 0) > 0 ? 90 : 0;
          if (rotD > 0) rotC++;
          cellsC.push({
            i: i, level: gLx, index0: cellGeo.i0, index1: cellGeo.i1, count: cellGeo.count,
            label: (gr.label === null || gr.label === undefined) ? '' : String(gr.label),
            left: cellGeo.left, right: cellGeo.right,
            cx: Math.round((cellGeo.left + cellGeo.right) / 2 * 100) / 100,
            span: Math.round((cellGeo.right - cellGeo.left) * 100) / 100,
            textPx: Math.round(tw * 100) / 100, rotate: rotD,
            merged: cellGeo.count > 1,                  // 「连续重复才跨列合并」——count=1 不算合并格
            bottom: botC, h: hC
          });
        }
        groupLevels.push({
          index: gLx, cells: cellsC, count: cellsC.length,
          h: hC, gap: gapC, band: hC + gapC, rotate: rotC > 0 ? 90 : 0, rotCount: rotC,
          /* 迭代 30：本级的行底边（距容器底）+ 行名（= 该级对应的 X 列名） */
          bottom: botC, top: botC + hC,
          name: (levelNames && levelNames[gLx] !== undefined && levelNames[gLx] !== null) ? String(levelNames[gLx]) : '',
          mergedCells: cellsC.filter(function (c) { return c.merged; }).length,
          countSum: cellsC.reduce(function (a, c) { return a + num(c.count, 0); }, 0)
        });
        if (gLx === 0) { groupCells = cellsC; groupBottom = botC; }
      }
    }

    /* ⑦ X 轴标题锚点（距轴线）：全部下方块之下再留 TITLE_GAP（graphic 模式才需下移）
       第六轮：labelMarginEff 已含统计行带 → 这里**不能**再加一次 statBandH
       任务 E ③：参数行栈（gBand）在标签行**之下**，标题必须再跨过整条参数行带 →
         nameGap = 轴标签间距 + 统计行带 + 旋转标签块 + **参数行带** + TITLE_GAP
       （= axis.js bottomFit 里同一组量之和，二者同源）
       ⇒ 标题整块落在最后一行参数行之下，与任何参数行的绘制矩形不相交。 */
    var titleGap = axisPolicyNum('TITLE_GAP', 10);
    var nameGap = (statMode === 'graphic')
      ? Math.round(labelMarginEff + rotH + gBand + titleGap)
      : Math.round(labelMarginEff + rotH);

    /* ===== 任务 G · 逐列模型（唯一来源：__axisTableSpec.cols）=====
       口径：**当前可见类别**一列一个 —— 缩放态窗口 = [zV0, zV1]（带宽取 ECharts 刻度实测 zBand），
       全量态 = 全部类别（带宽 = plotW / n）。每列带：
         · label     = 叶子参数行（X 最后一列）在该列的文本
         · levels[]  = 各级分组行在该列的覆盖格（合并格：cx/span/count 与该格完全一致）
         · statLines = 该列统计行逐行文本（Mean / Std / Nu% …）
         · cx / span / left / right = 列几何（cx 就是 box 的类别中心，span 就是当前带宽）
       与绘制同源：cx = cxOf(i)（绘制数值文本用的同一个锚点），span = zBand。
       自测直接按这份模型逐列断言（列数 / 空文本 / 对位 / 列宽 / 无重叠），不必再猜。 */
    var colModel = [], ci2, lab2, st2, lvCells2, hit2, gcs2, lvI2, gcI2, cxCol2;
    for (ci2 = zV0; ci2 <= zV1; ci2++) {
      lab2 = (labels[ci2] === null || labels[ci2] === undefined) ? '' : String(labels[ci2]);
      st2 = (statLines[ci2] === null || statLines[ci2] === undefined) ? '' : String(statLines[ci2]);
      lvCells2 = [];
      for (lvI2 = 0; lvI2 < groupLevels.length; lvI2++) {
        gcs2 = groupLevels[lvI2].cells || [];
        hit2 = null;
        for (gcI2 = 0; gcI2 < gcs2.length; gcI2++) {
          if (ci2 >= gcs2[gcI2].index0 && ci2 <= gcs2[gcI2].index1) { hit2 = gcs2[gcI2]; break; }
        }
        lvCells2.push(hit2 ? {
          name: groupLevels[lvI2].name || '', label: hit2.label,
          cx: hit2.cx, span: hit2.span, i0: hit2.index0, i1: hit2.index1, count: hit2.count
        } : null);
      }
      cxCol2 = cxOf(ci2);
      if (!(typeof cxCol2 === 'number' && isFinite(cxCol2))) cxCol2 = gl + (ci2 + 0.5) * band;
      colModel.push({
        i: ci2, label: lab2, statText: st2, statLines: st2 ? st2.split('\n') : [],
        cx: Math.round(cxCol2 * 100) / 100,
        span: Math.round(zBand * 100) / 100,
        left: Math.round((cxCol2 - zBand / 2) * 100) / 100,
        right: Math.round((cxCol2 + zBand / 2) * 100) / 100,
        leaf: leafName || '',
        levels: lvCells2,
        drawn: !!(keptFlags && keptFlags[ci2])
      });
    }

    return {
      on: true, mode: statMode, rows: rows, statRows: statRows,
      hostMode: (host && host.mode) || 'none', containerW: Math.round(w), containerH: num(host && host.h, 0),
      gridLeft: gl, gridRight: gr, plotW: plotW, band: band, categories: n,
      rotate: rotate, fontSize: fontPx, lineHeight: lineH, rowH: rowH, nameGap: nameGap,
      /* 迭代 21：行带几何（不变式自检：rowTop ≤ labelBandBottom ≤ labelTop） */
      rowGap: rowGap, labelTop: labelTop,
      labelBandBottom: Math.round(labelTop - rotH),
      /* 第六轮：统计行带（距容器底）底边 / 顶边 + 分组带上沿 —— 与绘制同源 */
      colBase: colBase, statBase: statBase, statTop: statTop,
      statBandH: Math.round(statBandH),
      groupTop: Math.round(labelTop + gBand),
      order: 'stat,label,param',
      rowTop: Math.round(labelTop - rotH),
      /* 迭代 12：统计量旋转角 / 数值文本最大宽度 / 未旋转行盒高（旋转包围盒计算基准） */
      statRotate: statRotate, maxStatW: Math.round(maxStatW * 100) / 100, statBoxLineH: statBoxLineH,
      maxLabelPx: Math.round(maxLabelPx), rotH: rotH,
      base: colBase, bottom: Math.round(frameBottom), height: Math.round(frameH),
      left: left, right: right, rowHeadRight: rowHeadRight, colW: colW, rowNamePad: pad,
      /* 任务 E ②：graphic 模式下列宽只按实际绘制的行名实测（axis 模式保持旧口径） */
      nameTexts: nameTexts.slice(),
      /* Y 轴区实测留白（grid.left 的下限，供全屏重算做紧算比较） */
      yPad: num(o.yPad, gl),
      /* 迭代 10：行名文字实测宽度 + 右对齐锚点（= rowHeadRight − 内边距）——axis 模式的
         单块多行文本按「块右边界 = 锚点」定位（块内各行 textAlign:right） */
      nameW: Math.round(nameW * 100) / 100, nameRight: Math.min(rowHeadRight, glSafe) - nameGapRight,
      colXs: colXs, numRows: numRows, numCols: numCols, nameRows: nameRows, numSkipped: skipped,
      /* 迭代 30（任务 D ①）：参数行栈（自上而下 = 叶子列 → 级 N-1 → … → 级 0）
         · paramRows[k].name = 该行对应的 **X 列名**，bottom/bandBottom/bandH = 该行实际行带
         · paramOrder = 自下而上的 X 列名序列（= X 列序，因为自下而上正好是第一列在最底） */
      paramRows: paramRows,
      paramOrder: (function () {
        var out = [];
        for (var pL = 0; pL < gLevelsIn.length; pL++) {
          out.push((levelNames[pL] === null || levelNames[pL] === undefined) ? '' : String(levelNames[pL]));
        }
        out.push(leafName || (headerTexts[0] === null || headerTexts[0] === undefined ? '' : String(headerTexts[0])));
        return out;                                   // 自下而上 = [级0, 级1, …, 叶子]
      })(),
      levelNames: levelNames.slice(),
      leafName: leafName,
      labelBlockBottom: labelBlockBottom, labelBlockH: labelBlockH, stackBottom: stackBottomY,
      /* 迭代 30（任务 D ②）：缩放态窗口（band = 当前带宽，v0/v1 = 可见类别索引区间） */
      zoom: centerOf ? {
        band: Math.round(zBand * 1000) / 1000,
        v0: zV0, v1: zV1, count: zV1 - zV0 + 1
      } : null,
      rowSeps: (function () {
        var out = [], kk;
        for (kk = 1; kk <= statRows; kk++) out.push(Math.round(colBase + kk * rowH));
        out.push(Math.round(labelTop));
        for (kk = 0; kk < gLevelsIn.length; kk++) out.push(Math.round(levelBottoms[kk] + Math.round(num(gLevelsIn[kk].h, 0))));
        return out;
      })(),
      /* 迭代 13：统一抽稀集合（类别名与数值共用）—— chart-builder 用它设置 axisLabel.interval，
         重算路径（reflowAxisTable）也用同一次计算的结果，保证标签集合 == 数值集合 */
      kept: keptFlags, keptArr: keptIdx, keptCount: keptCount,
      headerTexts: headerTexts, statLines: statLines, labels: labels,
      /* 迭代 28：第二层分组行（h=0 = 未启用；cells 每格 = 一个组，left/right = 该组左右边界） */
      groupOn: (gH > 0 && groupCells.length > 0), groupH: gH, groupGap: gGap, groupBand: Math.round(gBand),
      /* 任务 G：可见列模型（逐列几何 + 参数行 + 统计行，缩放态自动收缩到窗口） */
      cols: colModel, colLo: zV0, colHi: zV1, colCount: colModel.length,
      bandCur: Math.round(zBand * 1000) / 1000,
      colWindow: {
        lo: zV0, hi: zV1, count: colModel.length,
        band: Math.round(zBand * 1000) / 1000,
        zoomed: !!centerOf,
        minLegibleBand: MIN_LEGIBLE_BAND
      },
      groupBottom: groupBottom, groupCells: groupCells, labelMargin: labelMarginEff,
      /* N 级：每级独立一条带（groupCells = 级 0，groupLevels = 全部级） */
      groupLevels: groupLevels, groupRowCount: groupLevels.length,
      groupRuns: (gRow && gRow.runs) ? gRow.runs : null
    };
  }
  /**
   * 横轴统计块的 graphic 元素（迭代 9 · 唯一来源：卡片 / 全屏 / 无方框三态共用）
   *   · axis 模式（不旋转）：左置表头 = 一次性多行文本（与迭代 6 逐元素一致）
   *   · graphic 模式（旋转非零）：行名逐行文本 + 数值逐行文本（水平，居中于列）
   *   · frame = true：另加行名列底色 + 完整方框 + 行分隔线 + 行名列分隔线 + 列分隔线
   * @param {object} m axisTableLayout 的结果
   * @param {string} color 文字色（与 X 轴标签同色）
   * @param {boolean} frame 是否画方框
   * @returns {Array<object>} ECharts graphic 元素
   */
  function axisBlockGraphic(m, color, frame) {
    if (!m || !m.on) return [];
    var els = [];
    var fill = color || TABLE.TEXT;
    var x0 = m.left, x1 = Math.max(m.left + 2, m.right);
    var b0 = m.bottom, h = Math.max(1, m.height);
    if (m.mode === 'axis') {
      /* ① 左置表头：一次性多行文本（块内各行右对齐；与迭代 6 逐元素一致）
         迭代 10：块**右边界**落在 rowHeadRight − 内边距（= 绘图区左边界 − 3px），
         与「行名列与 Y 轴区左右边界对齐」一致；块左边界 ≥ 方框左外框（文字永不越框）。 */
      var anchorX = num(m.nameRight, num(m.rowHeadRight, 0) - num(m.rowNamePad, 0));
      var blockLeft = Math.max(num(m.left, 0), anchorX - num(m.nameW, 0));
      els.push({
        type: 'text', left: Math.round(blockLeft * 100) / 100, bottom: Math.max(0, num(m.base, 0)),
        silent: true, z: 30, __axisBlock: true,
        style: {
          text: m.headerTexts.join('\n'),
          fill: fill,
          font: 'normal ' + m.fontSize + 'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
          textAlign: 'right', textVerticalAlign: 'top', lineHeight: m.lineHeight
        }
      });
    } else {
      /* ② graphic 模式：行名（右对齐到行名列右边界） + 数值（水平居中于类别带中心） */
      var q, r2, c2, v;
      for (q = 0; q < m.nameRows.length; q++) {
        r2 = m.nameRows[q];
        var elNm = axisRowText(m.nameRight, r2.bottom, r2.text, 'right', m.fontSize,
          (r2.kind === 'stat') ? AXIS_ROW_STAT_COLOR : fill);
        if (r2.kind === 'head') elNm.__paramRow = -1;      // 迭代 30：叶子参数行的行名
        els.push(elNm);
      }
      /* 迭代 30（任务 D ①）：各分组参数行的左置行名 —— 跟着自己的行带走（不许错位） */
      for (q = 0; q < (m.paramRows || []).length; q++) {
        var pr = m.paramRows[q];
        if (!pr || !pr.name) continue;
        var elPr = axisRowText(m.nameRight, pr.bottom, pr.name, 'right', m.fontSize, fill);
        elPr.__paramRow = num(pr.level, 0);
        els.push(elPr);
      }
      for (q = 0; q < m.numCols.length; q++) {
        c2 = m.numCols[q];
        if (m.statRotate > 0 && c2.cells) {
          /* 迭代 12：数值按 stats.rotate 旋转绘制（包围盒中心 = 类别中心 x + 该统计量的行带中心） */
          for (var kc = 0; kc < c2.cells.length; kc++) {
            var cell = c2.cells[kc];
            if (!cell || cell.text === '') continue;
            var elNum = axisRotText(cell.left, cell.bottom, cell.text, m.statRotate, m.fontSize, fill);
            elNum.__statRow = kc;                 // 第六轮：标记统计行序号（__statBlock 直接读实际 bottom）
            els.push(elNum);
          }
          continue;
        }
        for (var k = 0; k < m.numRows.length; k++) {
          v = (k < c2.texts.length) ? c2.texts[k] : '';
          if (v === '') continue;
          var elRow = axisRowText(c2.cx, m.numRows[k].bottom, v, 'center', m.fontSize, fill);
          elRow.__statRow = k;                    // 第六轮：同样标记（rotate=0 的水平数值行）
          els.push(elRow);
        }
      }
    }
    /* 迭代 28：第二层分组行 —— 每组只画 1 个居中标签，横跨该组全部 bar；
       组边界竖线 = colspan 的可见分隔（文字放不下本组宽度时才转 90°，见 groupAxisModel）。 */
    /* N 级：逐级各画一条带（级 0 在最上）—— 每条带内每组一个居中标签 + 组边界竖线 */
    var gBands = (m.groupLevels && m.groupLevels.length) ? m.groupLevels
      : ((m.groupOn && m.groupCells && m.groupCells.length) ? [{ cells: m.groupCells }] : []);
    for (var glq = 0; glq < gBands.length; glq++) {
      var gCellsL = (gBands[glq] && gBands[glq].cells) || [];
      if (!gCellsL.length) continue;
      var gc, gq;
      var gLineH = rowHOf(m.fontSize);
      for (gq = 0; gq < gCellsL.length; gq++) {
        gc = gCellsL[gq];
        var gEl;
        if (gc.rotate > 0) {
          var gbw = rotBoxWOf(gc.textPx, gLineH, 90);
          var gbh = rotBoxHOf(gc.textPx, gLineH, 90);
          gEl = axisRotText(gc.cx - gbw / 2, gc.bottom + (gc.h - gbh) / 2, gc.label, 90, m.fontSize, fill);
        } else {
          gEl = axisRowText(gc.cx, gc.bottom + (gc.h - gLineH) / 2, gc.label, 'center', m.fontSize, fill);
        }
        gEl.__groupBand = glq;          // 第六轮：标记分组级（__statBlock 直接读实际 bottom）
        els.push(gEl);
      }
      /* 组边界竖线（每格左沿 + 末格右沿）：分隔组与组，左右外沿与图上分组边界严格重合 */
      for (gq = 0; gq < gCellsL.length; gq++) {
        gc = gCellsL[gq];
        els.push(tableRect(gc.left, gc.bottom, 1, gc.h, frame ? TABLE.FRAME : TABLE.LINE));
        if (gq === gCellsL.length - 1) els.push(tableRect(gc.right, gc.bottom, 1, gc.h, frame ? TABLE.FRAME : TABLE.LINE));
      }
      /* 本带的上/下边线：上边 = 靠近轴线侧，下边 = 与下一级（或类别标签行）分隔 */
      var gLeft = gCellsL[0].left, gRight = gCellsL[gCellsL.length - 1].right;
      els.push(tableRect(gLeft, gCellsL[0].bottom + gCellsL[0].h, Math.max(1, gRight - gLeft), 1, frame ? TABLE.FRAME : TABLE.LINE));
      els.push(tableRect(gLeft, gCellsL[0].bottom - 1, Math.max(1, gRight - gLeft), 1, frame ? TABLE.FRAME : TABLE.LINE));
    }
    if (!frame) return els;
    /* ③ 行名列底色（与数据表格行头同观感 → 一眼可见行名被框在框内） */
    if (m.rowHeadRight > m.left + 1) {
      els.push(tableRect(m.left, b0, m.rowHeadRight - m.left, h, cssVar('--panel-alt', TABLE.BG)));
    }
    /* ④ 完整方框：上 / 下 / 左 / 右 四条边 */
    els.push(tableRect(x0, b0, x1 - x0, 1, TABLE.FRAME));
    els.push(tableRect(x0, b0 + h - 1, x1 - x0, 1, TABLE.FRAME));
    els.push(tableRect(x0, b0, 1, h, TABLE.FRAME));
    els.push(tableRect(x1 - 1, b0, 1, h, TABLE.FRAME));
    /* ⑤ 行分隔线（行名列各单元格边界 = 数值行 / 参数行边界）+ 行名列分隔线
       迭代 30：行边界改为显式锚点（统计行 → 叶子参数行 → 各级参数行），不再按 rows 均分。
       迭代 30：组边界竖线在**下方**（参数行栈），故类别列分隔线只画参数行栈以外的那一段。 */
    var seps = m.rowSeps || null, rs;
    if (seps && seps.length) {
      for (rs = 0; rs < seps.length; rs++) els.push(tableRect(x0, seps[rs], x1 - x0, 1, TABLE.LINE));
    } else {
      for (var r = 1; r < m.rows; r++) els.push(tableRect(x0, m.base + r * m.rowH, x1 - x0, 1, TABLE.LINE));
    }
    if (m.rowHeadRight > m.left + 1) els.push(tableRect(m.rowHeadRight, b0, 1, h, TABLE.FRAME));
    /* ⑥ 列分隔线（类别带边界，已按几何抽稀）—— 参数行区域不画类别竖线（那一段是合并单元格） */
    var gStackH = num(m.groupBand, 0);
    for (var c = 0; c < m.colXs.length; c++) {
      els.push(tableRect(m.colXs[c], b0 + gStackH, 1, Math.max(1, h - gStackH), TABLE.LINE));
    }
    /* 迭代 9 · C：标记本块元素，全屏重算（reflowAxisTable）时可整体替换 */
    for (var z = 0; z < els.length; z++) els[z].__axisBlock = true;
    return els;
  }
  /**
   * 第六轮（用户报障：轴层统计行仍在分组带之下）：把**实际绘制出去**的统计行 / 分组带纵向位置
   * 汇总成 `option.__statBlock`，供自测与文档直接断言（不另算一遍几何）。
   *
   * 读数约定与 ECharts 一致：`bottom` = 元素（旋转后包围盒）**下边距容器底边**的距离，
   * **越大越靠上**。目标不变式：`min(statBottoms) > max(groupBottoms)`
   * （统计行整块在分组带之上），且分组带整体在类别标签块之上。
   *
   * @param {Array<object>} els axisBlockGraphic 产出的 graphic 元素（带 __statRow / __groupBand 标记）
   * @param {object} m     axisTableLayout 的几何
   * @returns {object|null} null = 本次没有轴层区块
   */
  function statBlockOf(els, m) {
    if (!m) return null;
    var stat = [], grp = [], param = [], statRowsSeen = {}, grpCells = 0;
    for (var i = 0; i < (els || []).length; i++) {
      var e = els[i];
      if (!e || e.type !== 'text') continue;
      var b = Math.round(num(e.bottom, 0) * 100) / 100;
      if (e.__statRow !== undefined) {
        /* 同一统计行在各列共用同一个 bottom → 去重后即「统计行数」 */
        if (!statRowsSeen[b]) { statRowsSeen[b] = 1; stat.push(b); }
      } else if (e.__groupBand !== undefined) {
        grp.push(b); grpCells++;
      } else if (e.__paramRow !== undefined) {
        /* 迭代 30：参数行的左置行名（level = -1 → 叶子参数行） */
        param.push({
          level: num(e.__paramRow, -1),
          name: (e.style && e.style.text !== undefined) ? String(e.style.text) : '',
          bottom: b
        });
      }
    }
    stat.sort(function (a, b2) { return b2 - a; });     // 自上而下 = bottom 递减
    grp.sort(function (a, b2) { return b2 - a; });
    var grpRows = [];
    for (var k = 0; k < grp.length; k++) if (grpRows.indexOf(grp[k]) < 0) grpRows.push(grp[k]);
    return {
      order: (m.order || 'stat,group,label'),
      /* 统计行：每个统计量一行（去重后的实际 graphic bottom，自上而下递减） */
      statBottoms: stat,
      rows: stat.length,
      /* 分组带：**逐格**实际 bottom（= 各级分组格数之和）+ 去重后的「每级一行」位置 */
      groupBottoms: grp,
      groupCells: grpCells,
      groupRowBottoms: grpRows,
      groupRows: grpRows.length,
      /* 类别标签块高（旋转标签的竖向占用）= 轴层标签块的几何高度 */
      labelH: Math.round(num(m.rotH, 0)),
      /* 统计行行带高（判断「行名是否与统计数值同一行带」用） */
      rowH: Math.round(num(m.rowH, 0)),
      rowGap: Math.round(num(m.rowGap, 0)),
      /* 与绘制同源的锚点（距容器底）：标签块顶端 / 统计带底边 / 统计带顶边 / 分组带上沿 */
      labelTop: Math.round(num(m.labelTop, 0)),
      statBase: Math.round(num(m.statBase, 0)),
      statTop: Math.round(num(m.statTop, 0)),
      groupTop: Math.round(num(m.groupTop, 0)),
      gridBottom: Math.round(num(m.nameGap, 0)),
      /* 迭代 30（任务 D ①）：参数行栈 —— 自上而下的行名 / 行底边 + 自下而上的行名序列 */
      paramRows: param.slice().sort(function (a, b2) { return b2.bottom - a.bottom; }),
      paramOrder: (m.paramOrder || []).slice(),
      mode: m.mode
    };
  }

  /**
   * 迭代 13：把 kept 集合包成 ECharts `axisLabel.interval` 回调。
   * ECharts 对函数型 interval 的处理（echarts 5.6 `rb()`）：逐 tick 调用 `fn(tickValue, rawLabel)`，
   * 返回真才出标签 —— 类别轴 tickValue 即**数据索引**（dataZoom 缩放后仍是原始索引），
   * 故这里按索引查 kept 即可，与数值绘制的集合严格相同。
   * @param {Array<boolean>} kept 每个类别是否显示
   * @returns {function} interval 回调（索引越界一律返回 false，零异常）
   */
  function keptIntervalFn(kept) {
    return function (idx) {
      var i = Number(idx);
      if (!isFinite(i) || i < 0) return false;
      return !!(kept && kept[i] === true);
    };
  }

  /** 自测 / 文档可读的横轴表格元数据（ECharts 忽略未知顶层字段） */
  function axisTableMeta(m, frame, elementCount) {
    return {
      on: true, frame: !!frame, mode: m.mode,
      hostMode: m.hostMode, containerW: m.containerW,
      gridLeft: m.gridLeft, gridRight: m.gridRight,
      plotW: Number(m.plotW.toFixed(2)), band: Number(m.band.toFixed(3)), categories: m.categories,
      rotate: m.rotate, fontSize: m.fontSize,
      left: m.left, right: Number(m.right.toFixed(2)),
      bottom: Math.round(m.bottom), height: Math.round(m.height),
      base: Math.round(m.base), labelTop: m.labelTop, rotH: m.rotH, maxLabelPx: m.maxLabelPx,
      rows: m.rows, statRows: m.statRows, rowH: m.rowH, rowHeadRight: m.rowHeadRight, colW: m.colW,
      /* 迭代 12：统计量旋转（与 rotate 独立）+ 数值文本最大宽度 */
      statRotate: num(m.statRotate, 0), maxStatW: m.maxStatW,
      rowNameW: m.nameW, rowNameRight: m.nameRight,
      rowHeadInsideFrame: m.rowHeadRight > m.left && m.rowHeadRight < m.right,
      edges: 4, frameLines: frame ? 4 : 0, rowLines: m.rows - 1,
      colLines: m.colXs.length,
      numRows: m.numRows.length, numColsDrawn: m.numCols.length, numColsSkipped: m.numSkipped,
      /* 迭代 13：统一抽稀集合的规模（类别名与数值同集合 → labelsShown === numColsDrawn）
         axis 模式（rotate=0 且 stats.rotate=0）走旧多行标签口径，没有 kept 集合（null） */
      keptCount: (m.mode === 'graphic') ? num(m.keptCount, 0) : null,
      labelsShown: (m.mode === 'graphic') ? num(m.keptCount, 0) : null,
      elements: num(elementCount, 0)
    };
  }
  /**
   * 迭代 9 · C / 迭代 21：按**最终容器高度**重算横轴表格几何并替换 graphic 元素。
   * 调用时机：全屏路径（fullscreen.js）在 enhanceOption 放大字号（+2）之后 ——
   *          卡片路径由 buildOption 直接按最终值构建，无需重算。
   *
   * 迭代 21 改变：不再「旧 grid.bottom + 34 抬高、不够再抬」，而是用 **全屏容器实际高度**
   * 从零重算（Axis.bottomFit 同一来源）：
   *   grid.bottom = 轴标签间距 + 标签块 + 行间距 + 统计行带 + 轴标题带 + slider 带
   *   同时回写 axisLabel.fontSize（容器太矮才缩，≥ 9px）、nameGap、kept 集合、行锚点。
   *   全屏高 ≠ 卡片高 → 必须真重算（否则行锚点仍按卡片高度摆放，与标签/数值错位）。
   *
   * @param {object} option buildOption 的结果（已在原对象上完成全屏调整）
   * @param {{centerOf?:function, containerH?:number}} [opts] centerOf(i) → 类别 i 的当前像素中心 x
   *        （dataZoom 缩放态由 fullscreen.js 传入 ECharts 自身刻度映射；缺省 = 带宽推导）
   *        containerH：容器实际高度（缺省 = measureHost()，全屏下即 .fs-body 高）
   * @returns {boolean} 是否完成重算
   */
  function reflowAxisTable(option, opts) {
    opts = opts || {};
    if (!option || typeof option !== 'object') return false;
    var spec = option.__axisTableSpec;
    if (!spec) return false;
    var g = Array.isArray(option.grid) ? option.grid[0] : option.grid;
    if (!g || typeof g.bottom !== 'number') return false;
    var xa = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
    if (!xa) return false;
    var fontPx = (xa.axisLabel && num(xa.axisLabel.fontSize, 0) > 0) ? num(xa.axisLabel.fontSize, 11) : num(spec.fontSize, 11);
    var rotate = xa.axisLabel ? num(xa.axisLabel.rotate, num(spec.rotate, 0)) : num(spec.rotate, 0);
    var host = measureHost();
    if (!(num(host.w, 0) > 0)) host = { mode: spec.hostMode, w: num(spec.containerW, 0), h: num(spec.containerH, 0) };
    var labels = (xa.data && xa.data.length) ? xa.data.map(function (v) { return String(v); })
      : ((spec.labelsAll && spec.labelsAll.length) ? spec.labelsAll.slice() : (spec.labels || []));
    var centerOf = (typeof opts.centerOf === 'function') ? opts.centerOf : null;
    /* 任务 G：规格里的 statLines 已改为「可见窗口」口径 → 重算必须读全量数组 statLinesAll，
       否则第二次缩放只会拿上一次窗口的几行重排（窗口越缩越少、顺序错乱）。 */
    var statLines = (spec.statLinesAll && spec.statLinesAll.length) ? spec.statLinesAll.slice() : (spec.statLines || []);
    /* 统计行「请求行数」= 每个类别数值文本的最大行数（spec.statLines 保留全部行） */
    var rowsAll = Math.max(0, Math.floor(num(spec.statRows, 0)));
    for (var i = 0; i < statLines.length; i++) {
      var sl = (statLines[i] === null || statLines[i] === undefined) ? '' : String(statLines[i]);
      if (!sl) continue;
      var pc = sl.split('\n').length;
      if (pc > rowsAll) rowsAll = pc;
    }
    /* 按**最终字号**实测标签 / 数值文本宽度（全屏 +2 后必然变宽 → 留白随之变高） */
    var maxLabelPx = 0, maxStatPx = 0, q;
    for (q = 0; q < labels.length; q++) {
      var lw = textPx(labels[q], fontPx);
      if (lw > maxLabelPx) maxLabelPx = lw;
    }
    for (q = 0; q < statLines.length; q++) {
      var s2 = (statLines[q] === null || statLines[q] === undefined) ? '' : String(statLines[q]);
      if (!s2) continue;
      var parts2 = s2.split('\n');
      for (var k2 = 0; k2 < parts2.length; k2++) {
        var pw2 = textPx(parts2[k2], fontPx);
        if (pw2 > maxStatPx) maxStatPx = pw2;
      }
    }
    /* 容器实际高度：优先调用方给定（全屏 .fs-body 实测），否则取 measureHost() */
    var containerH = num(opts.containerH, 0);
    if (!(containerH > 0)) containerH = num(host.h, 0);
    var AX = YMS.Axis;
    var inlineMode = (spec.mode === 'axis');
    var extraBottom = (spec.hostMode === 'fs' || (opts.sliderBand !== undefined && opts.sliderBand !== null))
      ? num(opts.sliderBand, 30) : 0;
    var fit = (!inlineMode && AX && typeof AX.bottomFit === 'function') ? AX.bottomFit({
      statInline: false,
      rotate: rotate, statRotate: num(spec.statRotate, 0),
      statRows: rowsAll, labelPx: maxLabelPx, maxStatPx: maxStatPx, fontPx: fontPx,
      containerH: containerH, gridTop: num(g.top, 24),
      /* 迭代 28：第二层分组行（全屏沿用卡片期的行高，留白与绘制同源） */
      groupBand: num(spec.groupBand, 0),
      /* 全屏底部有 dataZoom slider（height 20 + bottom 4）→ 预留 30px 带 */
      extraBottom: extraBottom
    }) : null;
    var rowsShown = fit ? fit.rows : rowsAll;
    var fontUsed = fit ? fit.fontPx : fontPx;
    if (fit) {
      g.bottom = fit.bottom;
      if (xa.axisLabel) {
        xa.axisLabel.fontSize = fontUsed;
        xa.axisLabel.margin = Math.round(num(fit.labelGap, 7));
      }
      if (xa.nameTextStyle) xa.nameTextStyle.fontSize = fontUsed;
      option.__axisFit = fitMeta(fit);           // 自测 / 文档可读（全屏重算后的几何）
    } else if (inlineMode) {
      /* 多行标签路径（rotate=0 且统计量不旋转）：grid.bottom 沿用卡片值（旧公式），
         全屏只需在底部再加 slider 带（旧实现由 enhanceOption 的 +34 提供） */
      g.bottom = Math.round(num(g.bottom, 0) + extraBottom);
    }
    function layout(gridBottom) {
      return axisTableLayout({
        labels: labels, statLines: statLines, headerTexts: spec.headerTexts,
        statRows: rowsShown, rotate: rotate, lineHeight: spec.lineHeight,
        /* 迭代 28：第二层分组行随规格一起重算（列位置按全屏新带宽重算） */
        group: spec.group || null,
        /* 迭代 30：参数行的行名（X 列名）随规格一起重算 */
        paramNames: spec.paramNames || null,
        /* 迭代 21：沿用构建时的绘制归属（graphic 模式下即使行数降到 0 也不退回多行标签） */
        forceGraphic: (spec.mode === 'graphic'),
        /* 迭代 12：统计量旋转角随规格一起重算（全屏字号 +2 → 行带高度随之放大） */
        statRotate: num(spec.statRotate, 0),
        gridBottom: gridBottom, fontSize: fontUsed, centerOf: centerOf,
        gridLeft: num(g.left, spec.gridLeft), gridRight: num(g.right, spec.gridRight),
        yPad: num(spec.yPad, 0), host: host
      });
    }
    /* 任务 E ②：全屏字号 +2 后行名变宽 → grid.left 按「构建路径同一口径」紧算
       （max(Y 轴区实测留白, 方框左缘 + 行名实测宽 + 两侧内边距 + ROWNAME_GAP)） */
    if (spec.mode === 'graphic') {
      var rnTight = rowNameColW(rowNameTextsOf(spec.headerTexts, spec.paramNames), fontUsed);
      g.left = tightGridLeft(num(spec.yPad, 0) > 0 ? num(spec.yPad, 0) : num(g.left, 0), rnTight.textPx, fontUsed);
    }
    var m = layout(num(g.bottom, 0));
    if (!m) return false;
    /* 兜底（迭代 21）：几何值仍不足时按行带底边 + 标题带抬高，绝不让数值行侵入标签块 */
    var need = axisTableNeedBottom(m);
    if (num(g.bottom, 0) < need) {
      g.bottom = Math.round(need);
      m = layout(g.bottom);
      if (!m) return false;
    }
    /* 任务 E ①（用户报障「缩放时 box 跑到坐标轴区域外」）：
       boxplot 的 clip:true 不生效 —— 窗口外的箱体仍被 ECharts 按「类别中心 = rect.x + (i+0.5-lo)/span×w」
       映射到 grid 左/右外侧画出（实测 24 条里 12 条越界，最远到 x=-380）。
       故在**重算阶段**按 xAxis 的 extent（lo..hi）过滤 series.data：
       窗口外的项置 null（索引不变 → 类别下标仍与 xAxis 一一对应，缩放后不错位），
       保证任何被绘制的箱体像素 x 都落在 [grid.x, grid.x + grid.w] 内。 */
    var ext = (opts.extent && isFinite(num(opts.extent.lo, NaN)) && isFinite(num(opts.extent.hi, NaN)))
      ? { lo: Math.round(num(opts.extent.lo, 0)), hi: Math.round(num(opts.extent.hi, 0)) } : null;
    var nCat = num(m.categories, 0);
    var full = !ext || (ext.lo <= 0 && ext.hi >= nCat - 1);
    var dropped = 0, keptSeries = 0, seriesTouched = 0;
    if (nCat > 0 && Array.isArray(option.series)) {
      for (var sIdx = 0; sIdx < option.series.length; sIdx++) {
        var ser = option.series[sIdx];
        if (!ser || !Array.isArray(ser.data)) continue;
        if (ser.type !== 'boxplot' && ser.type !== 'line') continue;
        if (ser.data.length !== nCat) continue;            // 非类别轴系列（拟合线等）不动
        seriesTouched++;
        /* 窗口外的项一律置 ECharts 的空值标记 '-'（**不能置 null**：实测 boxplot 的布局对 null 项
           抛 "Cannot read properties of null (reading 'value')"，整条 series 会被丢弃、坐标区消失）。 */
        for (var dIdx = 0; dIdx < ser.data.length; dIdx++) {
          var inWin = full || (dIdx >= ext.lo && dIdx <= ext.hi);
          var cell = ser.data[dIdx];
          var isEmpty = (cell === null || cell === undefined || cell === '-');
          if (inWin) { if (!isEmpty) keptSeries++; continue; }
          if (!isEmpty) { ser.data[dIdx] = '-'; dropped++; }
        }
      }
    }
    option.__boxFilter = {
      on: true, extent: ext, full: full, categories: nCat,
      seriesTouched: seriesTouched, dropped: dropped, kept: keptSeries,
      policy: "filter-by-xAxis-extent (empty-marker '-', index preserved)"
    };
    /* 任务 H：缩放 / 全屏重算后，箱宽与槽距必须按**本次实际可见带宽**重算 ——
       buildOption 的箱宽是按「全部类别」的估计带宽算的，缩放到 3~4 个类别时带宽变大，
       若箱宽不跟着放大就会出现「箱体又细又散」（25-75% 实测 9.38px 宽、20px 槽距）。
       槽距上限见 boxStepOf —— 箱体始终成组，不会被拉成孤岛。 */
    if (option.__boxLayout && option.__boxLayout.on && Array.isArray(option.series)) {
      var laneH = Math.max(1, num(option.__boxLayout.lanes, 1));
      /* bandCur = 本次实际可见带宽（缩放态 = zBand，未缩放 = plotW / n） */
      var bandH = num(m.bandCur, num(m.band, option.__boxLayout.band));
      var stepH = boxStepOf(bandH, laneH);
      var wH = boxWidthOfStep(stepH, option.__boxLayout.borderW);
      for (var sH = 0; sH < option.series.length; sH++) {
        var serH = option.series[sH];
        if (!serH || serH.type !== 'boxplot') continue;
        serH.boxWidth = [wH, wH];
      }
      option.__boxLayout.band = Math.round(bandH * 1000) / 1000;
      option.__boxLayout.step = Math.round(stepH * 1000) / 1000;
      option.__boxLayout.boxW = wH;
    }
    if (xa.axisLabel && m.mode === 'graphic') {
      /* X 轴标题下移到数值行之下（axis 模式的标签块高度由 lineHeight 固定，nameGap 不变） */
      xa.nameGap = m.nameGap;
      /* 迭代 13：重算后的 kept 集合必须同步回 axisLabel.interval —— 否则全屏 / dataZoom 后
         标签仍按「卡片未缩放时」的集合显示，而数值已按新几何重排 → 又变成两套集合。 */
      if (m.kept) {
        xa.axisLabel.interval = keptIntervalFn(m.kept);
        option.__axisKept = { n: m.categories, indices: m.keptArr.slice(), count: m.keptCount };
      }
    }
    var color = (xa.axisLabel && xa.axisLabel.color) ? xa.axisLabel.color : TABLE.TEXT;
    var kept = [];
    var gi = option.graphic;
    if (Array.isArray(gi)) {
      for (var i = 0; i < gi.length; i++) if (!(gi[i] && gi[i].__axisBlock)) kept.push(gi[i]);
    }
    var els = axisBlockGraphic(m, color, spec.frame === true);
    option.graphic = kept.concat(els);
    option.__axisTable = spec.frame === true
      ? axisTableMeta(m, true, els.length)
      : { on: false, frame: false, wanted: false, reason: '开关未开启（默认关闭）' };
    /* 第六轮：全屏重算后同步刷新轴层纵向次序元数据（读的是本次实际画出去的 els） */
    option.__statBlock = statBlockOf(els, m);
    /* 迭代 30（任务 D ②）：缩放 / 全屏重算后同步刷新 __groupAxis —— 与绘制同源，
       合并格的 left/right/**count**（= 当前窗口内的可见类别数）与 span 必须一起更新，
       否则元数据仍是卡片未缩放时的全量口径（用户看到的却是缩放后的图）。 */
    if (m.groupLevels && m.groupLevels.length) {
      var lvRe = [], glRe, gbRe = 0;
      for (glRe = 0; glRe < m.groupLevels.length; glRe++) {
        var LR = m.groupLevels[glRe];
        var cellsR = (LR.cells || []).map(function (c) {
          return {
            label: c.label, i0: c.index0, i1: c.index1, count: c.count,
            left: c.left, right: c.right, cx: c.cx, span: c.span, merged: !!c.merged,
            textPx: c.textPx, rotate: c.rotate
          };
        });
        gbRe += num(LR.band, 0);
        lvRe.push({
          index: LR.index, h: LR.h, gap: LR.gap, band: LR.band, rotate: LR.rotate,
          rotCount: cellsR.filter(function (c2) { return c2.rotate > 0; }).length,
          count: cellsR.length, cells: cellsR,
          counts: cellsR.map(function (c2) { return c2.count; }),
          name: LR.name || '', bottom: num(LR.bottom, 0), top: num(LR.top, 0),
          mergedCells: num(LR.mergedCells, 0), countSum: num(LR.countSum, 0)
        });
      }
      option.__groupAxis = {
        on: true, source: 'axis',
        h: m.groupH, gap: m.groupGap, band: gbRe,
        runs: lvRe[0].count, n: m.categories,
        /* bandW = **当前**带宽（缩放态由 ECharts 刻度映射实测；全量态 = plotW / n） */
        bandW: (m.zoom && m.zoom.band) ? Number(m.zoom.band.toFixed(3)) : Number(m.band.toFixed(3)),
        rotCount: lvRe[0].cells.filter(function (c2) { return c2.rotate > 0; }).length,
        cells: lvRe[0].cells,
        labels: (option.__groupAxis && option.__groupAxis.labels) ? option.__groupAxis.labels : [],
        levels: lvRe, levelCount: lvRe.length,
        cellsByLevel: lvRe.map(function (L2) { return L2.count; }),
        zoom: m.zoom || null
      };
    }
    option.__axisTableSpec = axisSpecOf(m, spec.frame === true);
    return true;
  }
  /** 需要的 grid.bottom（迭代 9：旋转标签块 + 数值行 + 标题 + 余量；graphic 模式才有额外要求） */
  function axisTableNeedBottom(m) {
    if (!m || m.mode !== 'graphic') return 0;
    var titleH = Math.round(num(m.fontSize, 11) * 1.4);
    return Math.round(m.nameGap + titleH + 6);
  }
  /** 生成 / 更新横轴表格规格（供 reflowAxisTable 重算；只放重算必需的纯数据） */
  function axisSpecOf(m, frame) {
    return {
      mode: (m && m.mode) || 'axis',
      statRows: m ? m.statRows : 0,
      rotate: m ? m.rotate : 0,
      /* 迭代 12：统计量旋转角（全屏重算必须沿用，否则数值角度会被打回 0） */
      statRotate: m ? num(m.statRotate, 0) : 0,
      fontSize: m ? m.fontSize : 11,
      lineHeight: m ? m.lineHeight : 13,
      headerTexts: m ? m.headerTexts.slice() : [],
      /* 任务 G：labels / statLines 改为**与 cols 对齐的可见窗口**口径（缩放后只剩窗口内的列），
         全量数组另存 labelsAll / statLinesAll —— 重算（reflowAxisTable）只读 All 那两个。 */
      statLines: (m && m.cols) ? m.cols.map(function (c) { return c.statText; }) : (m ? m.statLines.slice() : []),
      labels: (m && m.cols) ? m.cols.map(function (c) { return c.label; }) : (m ? m.labels.slice() : []),
      statLinesAll: m ? m.statLines.slice() : [],
      labelsAll: m ? m.labels.slice() : [],
      /* 任务 G：逐列模型（可见列；每列 cx / span / 参数行 / 统计行） */
      cols: (m && m.cols) ? m.cols.map(function (c) {
        return {
          i: c.i, label: c.label, statText: c.statText, statLines: (c.statLines || []).slice(),
          cx: c.cx, span: c.span, left: c.left, right: c.right,
          leaf: c.leaf, drawn: !!c.drawn,
          levels: (c.levels || []).map(function (L) {
            return L ? { name: L.name, label: L.label, cx: L.cx, span: L.span, i0: L.i0, i1: L.i1, count: L.count } : null;
          })
        };
      }) : [],
      colLo: m ? num(m.colLo, 0) : 0,
      colHi: m ? num(m.colHi, 0) : 0,
      colCount: (m && m.cols) ? m.cols.length : 0,
      bandW: m ? num(m.bandCur, num(m.band, 0)) : 0,
      colWindow: (m && m.colWindow) ? m.colWindow : null,
      hostMode: m ? m.hostMode : 'none',
      containerW: m ? m.containerW : 0,
      containerH: m ? m.containerH : 0,
      gridLeft: m ? m.gridLeft : 0,
      gridRight: m ? m.gridRight : 0,
      /* 任务 E ②：Y 轴区实测留白（grid.left 紧算的下限，全屏重算与构建路径同源） */
      yPad: m ? num(m.yPad, 0) : 0,
      paramNames: m && m.leafName !== undefined
        ? { leaf: m.leafName, levels: (m.levelNames || []).slice() }
        : null,
      /* 迭代 28：第二层分组行规格（全屏 / 缩放重算沿用同一批组与同一行高，
         旋转角保持预算期的判定 → 留白高度与绘制永远一致） */
      group: (m && m.groupOn) ? (function () {
        function runsOf(cells) {
          return (cells || []).map(function (c) {
            return { label: c.label, i0: c.index0, i1: c.index1, count: c.count, rotate: c.rotate, textPx: c.textPx };
          });
        }
        var lvAll = (m.groupLevels && m.groupLevels.length)
          ? m.groupLevels
          : [{ h: m.groupH, gap: m.groupGap, rotate: 0, cells: m.groupCells }];
        return {
          /* N 级：全部级随规格一起重算（全屏 / 缩放后每级各自按新带宽重排） */
          levels: lvAll.map(function (L) {
            return { h: L.h, gap: L.gap, rotate: L.rotate, runs: runsOf(L.cells) };
          }),
          h: m.groupH, gap: m.groupGap, runs: runsOf(m.groupCells)
        };
      })() : null,
      groupBand: m ? num(m.groupBand, 0) : 0,
      /* 迭代 30（任务 D ①）：参数行的行名（叶子列 + 各级列）= X 列名，全屏 / 缩放重算沿用 */
      paramNames: {
        leaf: (m && m.leafName) ? String(m.leafName) : '',
        levels: (m && m.levelNames) ? m.levelNames.slice() : []
      },
      frame: !!frame
    };
  }

  /* ------------------------------------------------------------- 系列构建 */
  /** 生成拟合曲线采样点（200 点，等距；predict 由 YMS.Fitting 提供） */
  function fitCurvePoints(fit, xs) {
    if (!fit || typeof fit.predict !== 'function' || !xs || !xs.length) return [];
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < xs.length; i++) {
      var v = xs[i];
      if (v !== v || !isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn) || !isFinite(mx)) return [];
    if (mn === mx) { mx = mn + 1; }
    var pts = [], N = 200;
    for (var k = 0; k <= N; k++) {
      var x = mn + (mx - mn) * (k / N);
      var y = fit.predict(x);
      if (y === null || y === undefined || y !== y || !isFinite(y)) continue;
      pts.push([x, y]);
    }
    return pts;
  }

  /** 取「挂在该轴上的数据名」（去重后 ' / ' 连接，供 Y 轴标题/右轴 name，契约 §3.3） */
  function axisTitleOf(plans) {
    var seen = [], out = [];
    for (var i = 0; i < plans.length; i++) {
      var nm = plans[i].vcName || plans[i].name;
      if (!nm || seen.indexOf(nm) >= 0) continue;
      seen.push(nm);
      out.push(nm);
    }
    return out.join(' / ');
  }

  /**
   * 分类轴图型（line / bar / box）的 series 计划
   * 未分组时与迭代 3 完全一致（每条 Value 列一条 series，名称 = 列名）
   */
  function catPlans(chart, groups, axisSide, cats, type) {
    var vcols = chart.valueCols || [];
    var plans = [];
    var lists = groups || null;
    function push(vc, g) {
      var labels = g ? (g.labels || []) : [];
      var key = YMS.Aggregate.seriesKey(vc.name, labels);
      var gcats = g ? (g.cats || []) : cats;
      var data = new Array(gcats.length), rangeVals = [], i, st;
      for (i = 0; i < gcats.length; i++) {
        var c = gcats[i];
        st = (c && c.stats) ? c.stats[vc.name] : null;
        if (type === 'box') {
          data[i] = (st && st.n) ? [st.min, st.q1, st.median, st.q3, st.max] : [null, null, null, null, null];
          if (st && st.n) { if (isFinite(st.min)) rangeVals.push(st.min); if (isFinite(st.max)) rangeVals.push(st.max); }
        } else {
          data[i] = (st && st.n) ? st.mean : null;
          if (st && st.n && isFinite(st.mean)) rangeVals.push(st.mean);
        }
      }
      plans.push({
        key: key, name: key, vc: vc, vcName: vc.name, kind: type === 'box' ? 'boxplot' : (type === 'bar' ? 'bar' : 'line'),
        data: data, rangeVals: rangeVals, gcats: gcats,
        groupLabel: g ? g.label : '', labels: labels,
        /* 迭代 11：颜色分组列取值（分组配色键的来源，见 planColorKey） */
        colorLabel: g ? (g.colorLabel || '') : '',
        colorIdx: g ? g.colorIdx : -1, symbolIdx: g ? g.symbolIdx : -1,
        side: YMS.Aggregate.sideOf(axisSide, key, vc.name)
      });
    }
    if (lists) {
      lists.forEach(function (g) { vcols.forEach(function (vc) { push(vc, g); }); });
    } else {
      vcols.forEach(function (vc) { push(vc, null); });
    }
    return plans;
  }

  /** 直方图 series 计划（频数柱；沿用迭代 3 名称 '频数' 与外观） */
  function histPlans(chart, axisSide, cats) {
    var vc = (chart.valueCols || [])[0] || {};
    var data = new Array(cats.length), rangeVals = [];
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i] || {};
      data[i] = c.count || 0;
      rangeVals.push(isFinite(c.count) ? c.count : 0);
    }
    var key = YMS.Aggregate.seriesKey(vc.name, []);
    return [{
      key: key, name: '频数', vc: vc, vcName: '频数', kind: 'bar', hist: true,
      data: data, rangeVals: rangeVals, gcats: cats, groupLabel: '', labels: [],
      colorLabel: '',                                     /* 直方图不支持颜色分组（迭代 11 同规则） */
      colorIdx: -1, symbolIdx: -1, side: YMS.Aggregate.sideOf(axisSide, key, vc.name)
    }];
  }

  /** 散点 series 计划（数据来自 chart.raw.series，含分组元信息） */
  function scatterPlans(chart, axisSide) {
    var vcols = chart.valueCols || [];
    var sd = (chart.raw && chart.raw.series) ? chart.raw.series : [];
    var plans = [];
    for (var i = 0; i < sd.length; i++) {
      var s = sd[i], vc = null, j;
      for (j = 0; j < vcols.length; j++) if (vcols[j].name === s.colName) vc = vcols[j];
      var data = new Array(s.xs.length);
      for (j = 0; j < s.xs.length; j++) data[j] = [s.xs[j], s.ys[j]];
      var key = s.key || YMS.Aggregate.seriesKey(s.colName, s.labels || []);
      plans.push({
        key: key, name: key, vc: vc, vcName: s.colName, kind: 'scatter',
        data: data, rangeVals: s.ys, large: s.xs.length > 4000,
        groupLabel: s.groupLabel || '', labels: s.labels || [],
        colorLabel: s.colorLabel || '',                   /* 迭代 11：颜色分组取值（散点 raw series 已带） */
        colorIdx: (s.colorIdx === undefined ? -1 : s.colorIdx),
        symbolIdx: (s.symbolIdx === undefined ? -1 : s.symbolIdx),
        side: YMS.Aggregate.sideOf(axisSide, key, s.colName)
      });
    }
    return plans;
  }

  /** Box 中位数连线计划（可被图例单独控制；分组时每组一条） */
  function medianPlans(chart, groups, cats, axisSide, style, hasBox) {
    if (!hasBox || style.boxMedianLine === false || !cats.length || cats.length <= 1) return [];
    var v0 = (chart.valueCols || [])[0];
    if (!v0) return [];
    var out = [];
    var lists = groups || null;
    function push(g) {
      var gcats = g ? (g.cats || []) : cats;
      var data = new Array(gcats.length);
      for (var i = 0; i < gcats.length; i++) {
        var st = (gcats[i] && gcats[i].stats) ? gcats[i].stats[v0.name] : null;
        data[i] = (st && st.n) ? st.median : null;
      }
      var labels = g ? (g.labels || []) : [];
      var key = YMS.Aggregate.seriesKey('中位数连线', labels);
      out.push({
        key: key, name: groups ? key : '中位数连线', vc: v0, vcName: v0.name, kind: 'median',
        data: data, rangeVals: [], gcats: gcats, groupLabel: g ? g.label : '', labels: labels,
        colorLabel: g ? (g.colorLabel || '') : '',        /* 迭代 11：中位数连线随该组自定义色 */
        colorIdx: (g && g.colorIdx !== undefined) ? g.colorIdx : -1, symbolIdx: -1,
        side: YMS.Aggregate.sideOf(axisSide, YMS.Aggregate.seriesKey(v0.name, labels), v0.name)
      });
    }
    if (lists) lists.forEach(push); else push(null);
    return out;
  }

  /**
   * 构建 ECharts option
   * @param {object} chart Aggregate.chartOf() 的结果（或直接传 work + index）
   * @param {object} work  Work（可省略）
   * @param {number} index 扁平序号（可省略）
   * @returns {object} ECharts option
   */
  function buildOption(chart, work, index, hostEl) {
    /* 容错：buildOption(work, index) */
    if (chart && !chart.cats && chart.pages && YMS.Aggregate && YMS.Aggregate.chartOf) {
      var w = chart;
      chart = YMS.Aggregate.chartOf(w, work);
      work = w;
    }
    if (!chart || typeof chart !== 'object') return null;

    try {
      var style = pickStyle(chart);
      /* 任务 F：图例样式 / 图元样式（缺省 = 与改动前写死的值逐项相同） */
      var lg = legendOf(chart);
      var mk = markOf(chart);
      var type = chart.type || 'line';
      var cats = chart.cats || [];
      var vcols = chart.valueCols || [];
      var vcol0 = vcols[0] || {};
      var scatterData = (chart.raw && chart.raw.series) ? chart.raw.series : null;
      var groups = (chart.groups && chart.groups.length) ? chart.groups : null;
      var axisSide = chart.axisSide || {};
      /* 迭代 11：分组配色表（{分组键: #rrggbb}）；为空 = 全部沿用原调色板（零回归） */
      var cmap = colorMapOf(chart);
      var statsCfg = chart.stats || { show: false, items: [] };
      /* 迭代 12（需求 ③）：统计量旋转角（与 style.xRotate 完全独立；默认 0 = 不旋转） */
      var statRotate = statRotOf(chart);
      var subtext = chart.subtext || '';
      var xIsValue = (type === 'scatter' && scatterData && !cats.length);
      /* 迭代 7 · C：数据表格开关（设置区 plot.table.show；自测可经 chart.table 注入）
         迭代 8（需求 5）：table.frame = 横轴坐标表格方框（含左侧行名）开关，默认 false */
      var tableCfg = tableCfgOf(chart);
      var frameOn = !!(tableCfg && tableCfg.frame === true);
      /* 迭代 30（任务 D ③）：**数据表格通道已停用** —— 用户要求「用注释摘掉，不要删代码」。
         tableModel / tableGraphic / tableRowsFor / tableCfgOf 等全部保留（供回溯），
         只在调用处短路：tableWanted 恒为 false。
         原判据（保留备查）：!!(tableCfg && tableCfg.show === true) && tableSupported(type, xIsValue)
         plot.table.frame（轴层统计块的方框）不受影响；store.js 的 plot.table 字段保留
         （老 .yms 模板照常载入，不报错）。 */
      var tableWanted = false;
      var host = measureHost(hostEl);

      /* ---------------- 横轴统计行（仅分类轴图型；契约 §3.3） ---------------- */
      var statRows = 0;
      var xRes;
      var specStatLines = null, specStatHeader = null;
      /* 迭代 28：第二层分组行（gmerge = 是否合并；gmodel = 几何模型，留白预算与绘制共用）
         第四轮（修复）：gmerge **在两条通道判断之前无条件算出** —— 统计行通道（plot.table.show=false）
         与数据表格通道（plot.table.show=true）必须拿到同一份分组结论。上一轮只在
         `statOn = !tableWanted && ...` 之后算，且 tableModel 没收到 group 参数，
         于是「表格接管横轴时分组行消失」被当成已知限制记了下来（错误行为被断言钉死）。 */
      var gmerge = (cats && cats.length >= 2 && !xIsValue)
        ? groupMergeOf(cats) : { on: false, levels: 0, levelValues: [], groupLabels: [], subLabels: [] };
      var gmodel = null;
      if (xIsValue) {
        var xc0 = (chart.xCols && chart.xCols[0]) || {};
        xRes = YMS.Axis.valueAxis({
          name: chart.xAxisName || xc0.name || '', style: style, type: xc0.type,
          decimals: xc0.decimals, timeStyle: xc0.timeStyle, isX: true, id: 'x-main'
        });
        xRes.xAxis = xRes.yAxis;          // 数值 X 轴：valueAxis 返回的轴对象即 X 轴
        xRes.gridBottom = 40;             // 数值 X 轴下方只放标题
      } else {
        var statItems = (statsCfg.show === true) ? normStatItems(statsCfg.items) : [];
        /* 迭代 7 · C：开启表格时 X 轴刻度标签只写类别名（统计数值移入表格），不再挂左置表头
           任务 G ②（用户口径「横轴坐标自动合并功能在其他绘图时也要启用」）：
           scatter 也走同一条分类轴通道 —— 补进名单后它才有 statLines / __axisTableSpec /
           __groupAxis（旧实现漏掉 scatter，于是 scatter 既没有统计行也没有分组带）。
           hist 不列入：它的 X 轴是**数值分箱**（xIsValue=true），没有分类维度可合并，
           设置区「防拥挤合并」下方有一行可见说明（见 plot-settings.js buildMergeGroup）。 */
        var statOn = !tableWanted && statItems.length &&
          (type === 'line' || type === 'bar' || type === 'box' || type === 'scatter' || type === 'hist');
        /* 迭代 6 · C：数值行（只含数值）+ 左置表头（列名 + 统计量名），行序同为 STAT_ORDER */
        var statLines = statOn ? statLinesFor(cats, vcol0, statItems) : null;
        var statHeader = (statOn && statLines)
          ? statHeaderFor(chart.xAxisName || (chart.xCols && chart.xCols[0] ? chart.xCols[0].name : ''), statItems)
          : null;
        specStatLines = statLines;
        specStatHeader = statHeader;
        /* 迭代 28 / 第四轮：多列 X 含分组参数列 → 第一层标签只画其余列（组名由第二层合并标签负责，
           不再逐 bar 重复）；分组结论已在上方无条件算出（统计行通道 / 数据表格通道共用），
           这里**两条通道都要**把第一层标签的组名前缀剥掉。 */
        var axisCats = cats;
        if (gmerge.on) {
          axisCats = new Array(cats.length);
          for (var gz = 0; gz < cats.length; gz++) axisCats[gz] = { key: cats[gz].key, label: gmerge.subLabels[gz] };
        }
        xRes = YMS.Axis.categoryAxis(axisCats, {
          axisName: chart.xAxisName || '', style: style, statLines: statLines, statHeader: statHeader,
          /* 迭代 12：统计量旋转角（独立于 style.xRotate，由 plot.stats.rotate 决定） */
          statRotate: statRotate,
          /* 迭代 9：把 canvas 实测文本宽度交给 axis.js —— 行名列宽 / 旋转标签块高 / grid.bottom /
             grid.left 预留全部按实测值算（'Mean' 不再被裁；无 DOM 时 textPx 回退字符估算） */
          measurePx: textPx
        });
        statRows = xRes.statRows || 0;
      }

      /* ---------------- series 计划（含分组 → 轴位 / 颜色 / 符号） ---------------- */
      var plans;
      if (type === 'scatter' && scatterData) plans = scatterPlans(chart, axisSide);
      else if (type === 'hist') plans = histPlans(chart, axisSide, cats);
      else plans = catPlans(chart, groups, axisSide, cats, type);
      if (type === 'box') {
        plans = plans.concat(medianPlans(chart, groups, cats, axisSide, style, true));
      }
      var i, p;

      /* ---------------- Y 轴：[0] 左轴 → [1] 右轴（若有挂右轴的数据）→ 外框轴 ---------------- */
      var leftPlans = [], rightPlans = [];
      for (i = 0; i < plans.length; i++) {
        if (plans[i].side === 'right') rightPlans.push(plans[i]); else leftPlans.push(plans[i]);
      }
      var dataPlans = function (arr) {
        /* 只统计真正的数据 series（中位数连线是派生系列，不参与轴范围） */
        return arr.filter(function (x) { return x.kind !== 'median'; });
      };
      var leftName = axisTitleOf(dataPlans(leftPlans));
      if (type === 'hist') leftName = '频数';
      var leftRes = YMS.Axis.valueAxis({
        name: leftName, style: style, type: (type === 'hist' ? T.NUMBER : vcol0.type),
        decimals: style.yDecimals, timeStyle: vcol0.timeStyle, isX: false,
        id: 'y-left', position: 'left'
      });
      /* 直方图的 Y 轴标题恒为"频数"，且不套用 Value 的小数位格式化 */
      if (type === 'hist') leftRes.yAxis.name = style.showYAxisTitle === false ? '' : '频数';

      var hasUserRange = !(style.yMin === null || style.yMin === undefined || style.yMin === '') ||
        !(style.yMax === null || style.yMax === undefined || style.yMax === '');
      var leftRange = hasUserRange ? null : smartYRange(dataPlans(leftPlans), type, leftRes.yAxis);
      applyRange(leftRes.yAxis, leftRange);
      /* 迭代 15（需求 ②）：范围写回后按**真实刻度文本**重算左侧留白 + 标题锚点
         （valueAxis 阶段还不知道智能范围，刻度宽度无从量起 —— 这里是唯一权威来源） */
      if (YMS.Axis && typeof YMS.Axis.axisPad === 'function') {
        var lPad = YMS.Axis.axisPad(leftRes.yAxis, {
          decimals: (type === 'hist' ? null : style.yDecimals),
          isTime: (type !== 'hist' && vcol0.type === T.TIME), timeStyle: vcol0.timeStyle
        });
        leftRes.gridLeft = lPad.gridLeft; leftRes.gridRight = lPad.gridRight; leftRes.nameGap = lPad.nameGap;
      }

      var rightRes = null, rightRange = null;
      if (rightPlans.length) {
        var rvc = (dataPlans(rightPlans)[0] || {}).vc || vcol0;
        rightRes = YMS.Axis.valueAxis({
          name: axisTitleOf(dataPlans(rightPlans)), style: style,
          type: (type === 'hist' ? T.NUMBER : rvc.type),
          decimals: style.yDecimals, timeStyle: rvc.timeStyle, isX: false,
          id: 'y-right', position: 'right', autoMinMax: true
        });
        /* 右轴恒为独立自动范围（用户 Min/Max 只作用于左轴） */
        rightRange = smartYRange(dataPlans(rightPlans), type, rightRes.yAxis);
        applyRange(rightRes.yAxis, rightRange);
        /* 迭代 15（需求 ②⑤）：右轴同样按真实刻度文本重算右侧留白（标题不裁不叠） */
        if (YMS.Axis && typeof YMS.Axis.axisPad === 'function') {
          var rPad = YMS.Axis.axisPad(rightRes.yAxis, {
            decimals: style.yDecimals,
            isTime: (type !== 'hist' && rvc.type === T.TIME), timeStyle: rvc.timeStyle
          });
          rightRes.gridLeft = rPad.gridLeft; rightRes.gridRight = rPad.gridRight; rightRes.nameGap = rPad.nameGap;
        }
      }
      var yAxes = [leftRes.yAxis];
      if (rightRes) yAxes.push(rightRes.yAxis);
      yAxes.push(frameAxis(rightRes ? rightRes.yAxis : leftRes.yAxis, 'right', false));

      /* ---------------- 箱宽（迭代 6 · A：按当前类别带宽自适应，相邻 Box 不接触） ---------------- */
      /* 先算出与 layoutBox 一致的 grid 左右留白（含统计表头预留），用作绘图区宽度基准 */
      /* 迭代 11（用户报障：左侧大片空白、右侧数据被挤）：行名列只在**真的放不下**时才加宽 grid.left。
         行名列画在绘图区下方的横向带里、右边界对齐 gridLeft−3；只要既有 Y 轴留白（标题+刻度，
         实测 61px）容得下它（约 37px）就无需额外预留。旧实现无条件加上 hColW+HEADER_PAD，
         实测 grid.left 61 → 98（占 448px 卡片的 22%），白吃 37px、绘图区少 11%。 */
      var gridLeftAxis = (leftRes.gridLeft) ? leftRes.gridLeft : AXIS_GRID_LEFT_MIN;
      var headerExtra = (xRes.header && xRes.header.gridLeftExtra) ? xRes.header.gridLeftExtra : 0;
      if (headerExtra > 0 && headerExtra + 3 <= gridLeftAxis) headerExtra = 0;
      var gridLeftBase = gridLeftAxis + headerExtra;
      /* 任务 E ②（用户报障「这里太空了」）：graphic 模式下 grid.left **紧算** ——
         只含「Y 轴区实测留白」与「实际绘制的行名实测宽 + 间距」两者中的大者；
         旧口径把 X 轴全名（34 字符拼串）当行名列宽预留，实测全屏 261px 里有 199px 是空的。
         axis 模式（多行标签块真的会画那串全名）保持旧口径 —— 回归红线。 */
      var paramNames = (function () {
        if (!gmerge.on) return null;
        var xc = chart.xCols || [], lvn = [], pi;
        for (pi = 0; pi < gmerge.levels; pi++) {
          lvn.push((xc[pi] && xc[pi].name) ? String(xc[pi].name) : ('X' + (pi + 1)));
        }
        var leafC = xc[gmerge.levels] || null;
        return { leaf: leafC && leafC.name ? String(leafC.name) : '', levels: lvn };
      })();
      var headGraphic = (xRes.statMode === 'graphic');
      if (headGraphic) {
        var nameTightW = rowNameColW(rowNameTextsOf(specStatHeader || [chart.xAxisName || ''], paramNames),
          num(xRes.header ? xRes.header.fontSize : 11, 11));
        gridLeftBase = tightGridLeft(gridLeftAxis, nameTightW.textPx, num(xRes.header ? xRes.header.fontSize : 11, 11));
        /* 最终 grid.left = box.gridLeft(Y 轴留白) + extraLeftFinal → 这里给出差额，落到紧算值 */
        headerExtra = Math.max(0, gridLeftBase - gridLeftAxis);
      }
      var gridRightBase = tableGridRight(rightRes, host.mode === 'fs');
      /* 迭代 28：第二层分组行模型 —— 用**最终**绘图区宽度算组宽（组宽 < 文字宽 + 留白 →
         该组标签转 90°；否则横排 0°）。留白预算（bottomFit）与 graphic 绘制共用这一份模型。 */
      if (gmerge.on) {
        /* N 级：每级一条带（除最后一列外每一列各一级） */
        gmodel = YMS.Axis.groupAxisLevels({
          labels: xRes.labels, levelValues: gmerge.levelValues,
          plotW: estimatePlotWidth(gridLeftBase, gridRightBase),
          fontPx: num(xRes.fontPx, 11), measurePx: textPx
        });
        if (!gmodel) gmerge = { on: false, levels: 0, levelValues: [], groupLabels: [], subLabels: [] };
      }
      /* ---------------- 数据表格几何（迭代 7 · C：列 = 类别带，行 = 系列 + 统计量） ------------- */
      var tableM = tableWanted ? tableModel({
        cats: cats, labels: xRes.labels,
        rows: tableRowsFor(plans, cats, vcol0, statItems, function (p) {
          /* 迭代 11：横轴统计表行名跟随该系列的自定义色（未自定义 → null = 原色） */
          return customColorOf(cmap, planColorKey(p, chart));
        }),
        headName: chart.xAxisName || ((chart.xCols && chart.xCols[0]) ? chart.xCols[0].name : ''),
        host: host, gridLeft: gridLeftBase, gridRight: gridRightBase,
        xGridBottom: xRes.gridBottom,
        /* 第四轮（修复）：数据表格首行 = 分组行（一组一个格，跨列合并，左右边界与图上该组 bar 对齐）。
           组几何直接复用 groupAxisModel 的 runs（含 i0/i1/count/label），不另写一套判定；
           行高 = 表格行高 TABLE.ROW_H（tableModel 自带把分组行计入 nAll / tableH）。 */
        /* N 级：首部 N 行分组行（级 0 在上）—— 直接复用分组模型的各级 runs，不另写判定 */
        group: (gmodel && gmodel.levels && gmodel.levels.length) ? { levels: gmodel.levels } : null
      }) : null;
      var tableSkip = tableWanted && !tableM ? '绘图区过窄或无数据行' : '';
      var tableExtra = tableM ? tableM.gridLeftExtra : 0;
      var boxLane = (type === 'box')
        ? boxLaneModel(plans, estimatePlotWidth(gridLeftBase + tableExtra, gridRightBase), cats.length, mk.boxRatio, num(mk.boxLineWidth, 1.2))
        : null;
      var boxW = (type === 'box')
        ? (boxLane.boxW || boxWidthFor(estimatePlotWidth(gridLeftBase + tableExtra, gridRightBase), cats.length, mk.boxRatio))
        : null;

      /* ---------------- 系列 ---------------- */
      var series = [];
      var meta = {};                       // series 名 → {vc, cats}（tooltip / 图例用）
      var seriesDataCount = 0;
      var labelCfg = null;
      if (style.showValueLabels) {
        labelCfg = {
          show: true, position: 'top', fontSize: 10, color: '#4a5866',
          formatter: function (p) {
            if (p.seriesType === 'boxplot' && p.value && p.value.length >= 5) return fmtVal(p.value[2], T.NUMBER, null);
            return fmtVal(p.value, vcol0.type, style.yDecimals, vcol0.timeStyle);
          }
        };
      }
      for (i = 0; i < plans.length; i++) {
        p = plans[i];
        if (p.kind === 'median') seriesDataCount++;
        var yIdx = p.side === 'right' ? 1 : 0;
        /* 迭代 11：自定义色优先（group.colors[分组键]），否则沿用原「分组色 → 序号调色板」逻辑 */
        var gCustom = customColorOf(cmap, planColorKey(p, chart));
        var gColor = gCustom || colorFor(p.colorIdx);
        var gSymbol = symbolFor(p.symbolIdx);
        meta[p.name] = { vc: p.vc || vcol0, cats: p.gcats || cats };
        var ser;
        if (p.kind === 'median') {
          var mc = gColor || MEDIAN_COLOR;
          ser = {
            name: p.name, type: 'line', data: p.data,
            symbol: 'circle', symbolSize: 5, showSymbol: true,
            connectNulls: false, smooth: false,
            lineStyle: { width: 1.6, color: mc },
            itemStyle: { color: mc },
            yAxisIndex: yIdx, z: 6
          };
        } else if (p.kind === 'boxplot') {
          ser = {
            name: p.name, type: 'boxplot', data: p.data,
            boxWidth: boxW || [BOX_MIN_W, BOX_MAX_W],   // 迭代 6 · A：按带宽自适应（见文件头注释）
            itemStyle: gColor
              ? { color: hexToRgba(gColor, 0.18), borderColor: gColor, borderWidth: num(mk.boxLineWidth, 1.2) }
              : { color: 'rgba(11,110,153,.18)', borderColor: PALETTE[0], borderWidth: num(mk.boxLineWidth, 1.2) },
            emphasis: { itemStyle: { borderColor: '#0a5b7e', shadowBlur: 4, shadowColor: 'rgba(10,91,126,.35)' } },
            yAxisIndex: yIdx, z: 4
          };
          if (labelCfg) ser.label = labelCfg;
        } else if (p.kind === 'scatter') {
          var sc = gColor || PALETTE[i % PALETTE.length];
          ser = {
            name: p.name, type: 'scatter', data: p.data,
            symbolSize: num(mk.scatterSize, 6), large: !!p.large, largeThreshold: 4000,
            itemStyle: { color: sc, opacity: num(mk.scatterOpacity, 0.72) },
            emphasis: { itemStyle: { opacity: 1 } },
            yAxisIndex: yIdx, z: 5
          };
          /* 任务 F：symbolShape（默认 circle 时沿用分组符号 gSymbol，且默认不写 symbol 字段 → 零变化） */
          if (gSymbol) ser.symbol = gSymbol;
          if (mk.scatterShape && mk.scatterShape !== 'circle') ser.symbol = mk.scatterShape;
          if (labelCfg) ser.label = labelCfg;
        } else if (p.hist) {
          ser = {
            name: p.name, type: 'bar', data: p.data,
            itemStyle: { color: PALETTE[0], opacity: 0.88, borderColor: '#0a5b7e', borderWidth: 0.6 },
            emphasis: { itemStyle: { color: '#0a5b7e' } },
            yAxisIndex: yIdx
          };
          applyBarGeometry(ser, mk);
          if (labelCfg) ser.label = labelCfg;
        } else {
          /* line / bar */
          var lc = gColor || PALETTE[i % PALETTE.length];
          ser = {
            name: p.name, type: (p.kind === 'bar' ? 'bar' : 'line'), data: p.data,
            symbol: symbolOf(mk.symbolShape, gSymbol),
            symbolSize: num(mk.symbolSize, 5),
            /* showSymbol：默认 true = 沿用现状「类别 ≤ 120 才画点」；显式关闭则一律不画 */
            showSymbol: (mk.showSymbol === false) ? false : (cats.length <= 120),
            connectNulls: false, smooth: false,
            lineStyle: lineStyleOf(num(mk.lineWidth, 1.8), mk.lineType, lc),
            itemStyle: { color: lc },
            yAxisIndex: yIdx, z: 3
          };
          if (p.kind === 'bar') applyBarGeometry(ser, mk);
          if (labelCfg) ser.label = labelCfg;
        }
        series.push(ser);
      }

      /* ---------------- 拟合曲线（叠加为 line 系列） ---------------- */
      if (chart.fit) {
        Object.keys(chart.fit).forEach(function (name, k) {
          var f = chart.fit[name];
          if (!f || !f.ok) return;
          var xs = null, side = 'left', vc = null;
          for (var q = 0; q < plans.length; q++) {
            if (plans[q].key === name || (plans[q].vc && plans[q].vc.name === name && plans[q].kind === 'scatter')) {
              side = plans[q].side;
              vc = plans[q].vc;
            }
          }
          if (scatterData) {
            for (var q2 = 0; q2 < scatterData.length; q2++) {
              if (scatterData[q2].colName === name || scatterData[q2].key === name) {
                xs = scatterData[q2].xsAll || scatterData[q2].xs;
              }
            }
          }
          var pts = fitCurvePoints(f, xs);
          if (!pts.length) return;
          var fitColor = FIT_PALETTE[k % FIT_PALETTE.length];
          series.push({
            name: '拟合曲线' + (Object.keys(chart.fit).length > 1 ? '（' + name + '）' : ''),
            type: 'line', data: pts, showSymbol: false, smooth: false,
            connectNulls: false,
            lineStyle: { width: 1.8, type: [6, 4], color: fitColor },
            itemStyle: { color: fitColor },
            yAxisIndex: side === 'right' ? 1 : 0,
            z: 10, silent: false
          });
          meta['拟合曲线' + (Object.keys(chart.fit).length > 1 ? '（' + name + '）' : '')] = { vc: vc, cats: cats };
        });
      }

      /* ---------------- 标题 / 图例 / grid / tooltip ---------------- */
      var showLegend = style.showLegend !== false &&
        (series.length > 1 || type === 'scatter' || (type === 'box' && style.boxMedianLine !== false && cats.length > 1));
      /* 图例条目数 = 去重后的 series 名数量（ECharts 图例按 series 名生成条目） */
      var legendCount = 0, legendNames = [];
      for (i = 0; i < series.length; i++) {
        var nm = series[i] ? series[i].name : null;
        if (nm === null || nm === undefined || nm === '') continue;
        if (legendNames.indexOf(nm) >= 0) continue;
        legendNames.push(nm);
        legendCount++;
      }
      var box = layoutBox(style, subtext, showLegend, xRes, leftRes, rightRes ? Math.max(rightRes.gridRight, 24) : 18, legendCount, lg);
      /* 迭代 21：按**容器实际高度**定横轴底部留白（标签块 + 统计行带相加；不封顶裁字）。
         全屏容器（.fs-body）另需给 dataZoom slider 留 30px 带 —— 与 slider 的 bottom:4 / height:20 同源。
         返回值同时回写 xRes.gridBottom / statRows / nameGap / 字号，下游一律读 xRes。 */
      var bottomFitRes = null;
      if (!xIsValue) {
        bottomFitRes = applyBottomFit(xRes, {
          containerH: num(host.h, 0),
          gridTop: box.gridTop,
          extraBottom: (host.mode === 'fs') ? axisPolicyNum('FS_SLIDER_BAND', 30) : 0,
          /* 迭代 28：分组行占的高度计入底部留白（0 = 逐值不变）
             第四轮：数据表格已接管横轴时，分组行画在**表格首行**（高度已由 tableM.tableH 计入），
             这里必须传 0，否则分组带会被双算 → 绘图区白白变矮。 */
          groupBand: (!tableM && gmodel) ? gmodel.band : 0
        });
        if (bottomFitRes) {
          statRows = xRes.statRows;                    // 实际绘制的统计行数（容器太矮时才减少）
          box.gridBottom = xRes.gridBottom;
        } else if (gmodel && !tableM) {
          /* 多行标签路径（rotate=0 且统计量不旋转）不经过 bottomFit（回归红线）→
             这里按同一公式补上分组行带，并把类别标签块整体下推同样的高度。
             第四轮：表格接管横轴时不补（分组行在表格首行，高度已计入 tableM.tableH）。 */
          xRes.gridBottom = Math.round(num(xRes.gridBottom, 0) + gmodel.band);
          if (xRes.xAxis && xRes.xAxis.axisLabel) {
            xRes.xAxis.axisLabel.margin = Math.round(num(xRes.xAxis.axisLabel.margin, axisPolicyNum('AXIS_LABEL_MARGIN', 7)) + gmodel.band);
          }
          box.gridBottom = xRes.gridBottom;
        }
      }
      /* 迭代 7 · C：表格高度计入 grid.bottom；空间保护 —— 绘图区至少保留 MIN_PLOT_H，
         放不下时让位（本次不画表格，回到迭代 6 的布局），保证任何卡片高度下都不重叠 */
      var extraLeftFinal = headerExtra;
      if (tableM) {
        extraLeftFinal = tableM.gridLeftExtra;
        /* 迭代 21：表格底部留白同样从最终 grid.bottom 起算（不沿用旧 gridBottom） */
        tableM.gridBottom = num(box.gridBottom, xRes.gridBottom) + TABLE.GAP + tableM.tableH + tableM.padBottom;
        box.gridBottom = tableM.gridBottom;
        if (tableM.containerH > 0 && (box.gridTop + box.gridBottom) > tableM.containerH - MIN_PLOT_H) {
          tableM = null; tableExtra = 0; extraLeftFinal = headerExtra;
          box.gridBottom = (xRes && xRes.gridBottom) ? xRes.gridBottom : box.gridBottom;
          tableSkip = '可用高度不足（保护绘图区）';
        }
      }
      /* ---------------- 图例（任务 F：plot.legend 接管样式与位置） ---------------- */
      /* 让位口径：
         · top    —— 与改前逐值相同（grid.top 已在 layoutBox 里让位）；
         · bottom —— grid.bottom += 图例高 + 8（轴块整体上移，图例落在最底部空带，不压参数行）；
         · left/right —— grid.left / grid.right += 实测文字宽推出的图例矩形宽 + 10。
         靠左/右时 tightenOption 的 grid.right 归一必须让路（见 plot-view.js 的 legend 位置判断）。 */
      var legendFontPx = num(style.legendSize, 11);
      var legendOrient = legendOrientOf(lg);
      var legendSideW = (lg.position === 'left' || lg.position === 'right')
        ? legendWidthOf(lg, legendNames, legendFontPx) : 0;
      box.legendExtra = { left: 0, right: 0, bottom: 0, width: legendSideW, orient: legendOrient };
      if (showLegend) {
        if (lg.position === 'left') box.gridLeft += legendSideW + LEGEND_SIDE_GAP;
        else if (lg.position === 'right') box.gridRight += legendSideW + LEGEND_SIDE_GAP;
        else if (lg.position === 'bottom') {
          box.gridBottom += Math.round(box.legendH + LEGEND_BOTTOM_GAP);
          box.legendExtra.bottom = Math.round(box.legendH + LEGEND_BOTTOM_GAP);
        }
        if (lg.position === 'left') box.legendExtra.left = legendSideW + LEGEND_SIDE_GAP;
        if (lg.position === 'right') box.legendExtra.right = legendSideW + LEGEND_SIDE_GAP;
      }
      /* 键顺序与改动前保持一致（show → top → left → itemWidth → itemHeight → itemGap → textStyle），
         这样「不改设置」时 option.legend 的 JSON 文本逐字相等（零变化红线）。 */
      var legendCfg = { show: showLegend };
      /* 位置：top = 现状（top + 居中）；其它三边按边对齐，图例矩形整块落在绘图区之外 */
      if (lg.position === 'top') {
        legendCfg.top = box.legendTop;
        legendCfg.left = 'center';
      }
      legendCfg.itemWidth = num(lg.itemWidth, LEGEND_ITEM_W);
      legendCfg.itemHeight = num(lg.itemHeight, LEGEND_ITEM_H);
      legendCfg.itemGap = num(lg.itemGap, LEGEND_ITEM_GAP);
      legendCfg.textStyle = { fontSize: legendFontPx, color: lg.textColor || LEGEND_TEXT_COLOR };
      if (lg.position === 'bottom') {
        legendCfg.left = 'center';
        legendCfg.bottom = (host.mode === 'fs') ? LEGEND_BOTTOM_PAD_FS : LEGEND_BOTTOM_PAD_CARD;
      } else if (lg.position === 'left') {
        legendCfg.left = 2;
        legendCfg.top = box.legendTop;
      } else if (lg.position === 'right') {
        legendCfg.right = 2;
        legendCfg.top = box.legendTop;
      }
      /* orient：ECharts 默认 horizontal → 只在需要竖排时写字段（默认零变化） */
      if (legendOrient === 'vertical') legendCfg.orient = 'vertical';
      /* 颜色只作用于图例显示层（文字 / 底 / 边框）；系列颜色仍走原配色面板 */
      if (lg.bgColor) legendCfg.backgroundColor = lg.bgColor;
      if (num(lg.borderWidth, 0) > 0) {
        legendCfg.borderWidth = num(lg.borderWidth, 0);
        if (lg.borderColor) legendCfg.borderColor = lg.borderColor;
      }
      if (num(lg.padding, 0) > 0) legendCfg.padding = num(lg.padding, 0);
      /* 迭代 5：条目 > 6 → 可滚动图例 + 限高 2 行（grid.top 已在 layoutBox 让位，不遮挡数据）
         任务 F：scrollMode = on 强制滚动 / off 强制普通（auto = 保持现状判定） */
      if (box.legendScroll) {
        legendCfg.type = 'scroll';
        legendCfg.height = LEGEND_SCROLL_MAX_H;
        legendCfg.pageIconSize = 10;
        legendCfg.pageButtonGap = 2;
        legendCfg.pageButtonItemGap = 3;
        legendCfg.pageButtonPosition = 'end';
      }
      var option = {
        color: PALETTE_ALT,
        animationDuration: 260,
        title: {
          /* 迭代 7 · A：图内不再画标题（Title 已在卡片头 / 页签显示），只保留副标题行
             （拟合公式与 R²、抽稀提示等；「合并…」那行已由 aggregate 移除） */
          text: '',
          subtext: subtext,
          left: 6, top: 2, itemGap: 4,
          textStyle: { fontSize: num(style.titleSize, 13), fontWeight: 600, color: '#16202a' },
          subtextStyle: { fontSize: 11, color: '#7d8b98', lineHeight: 13, align: 'left' },
          textAlign: 'left'
        },
        /* 迭代 6 · C：grid.left 额外为左置统计表头预留；迭代 7 · C：开启表格时改为表格行头列预留
           （无表头 / 无表格时 extra = 0，行为不变）；grid.bottom 计入表格高度 */
        grid: { left: box.gridLeft + extraLeftFinal, right: box.gridRight, top: box.gridTop, bottom: box.gridBottom, containLabel: false },
        /* 四边外框：主轴（下/左）+ 上边 X / 右边 Y 外框轴（只画线，永远显示，不受 showGrid 影响） */
        xAxis: [xRes.xAxis, frameAxis(xRes.xAxis, 'top', true)],
        yAxis: yAxes,
        legend: legendCfg,
        tooltip: {
          trigger: (type === 'scatter') ? 'item' : 'axis',
          confine: true,
          appendToBody: true,
          axisPointer: type === 'bar' || type === 'hist' ? { type: 'shadow' } : { type: 'line' },
          formatter: (type === 'scatter') ? makeItemTooltip(chart, meta) : makeAxisTooltip(chart, cats, meta)
        },
        series: series
      };
      /* 迭代 11：所有系列夹到绘图区内。箱线图的箱体/须线是「预先统计好的五数概括」，
         一旦用户把 Y 轴 Min/Max 收窄（合法操作），ECharts 不会重算箱体，不夹就会出现
         箱体与须线穿出绘图区、压到图例与横轴表格上（用户实测现象）。 */
      for (var sClip = 0; sClip < series.length; sClip++) {
        if (series[sClip] && series[sClip].clip === undefined) series[sClip].clip = true;
      }
      /* 自测可读的自定义字段（ECharts 忽略未知顶层字段）：
         __yRange = 左轴智能范围（迭代 2 兼容）；__yRanges = 左右轴各自的范围（迭代 4） */
      option.__yRange = leftRange || null;
      option.__yRanges = { left: leftRange || null, right: rightRange || null };
      option.__statRows = statRows;
      /* 任务 F：图例几何快照（位置 / 排列 / 让位量 / 估算矩形宽）—— 自测与 fullscreen 复用 */
      option.__legend = {
        position: lg.position, orient: legendOrient, show: showLegend,
        widthPx: legendSideW, extra: box.legendExtra,
        itemWidth: num(lg.itemWidth, LEGEND_ITEM_W), itemHeight: num(lg.itemHeight, LEGEND_ITEM_H),
        itemGap: num(lg.itemGap, LEGEND_ITEM_GAP), scrollMode: lg.scrollMode
      };
      /* 任务 F：图元设置快照（设置区 / 自测读取；不含任何颜色字段） */
      option.__mark = {
        boxRatio: num(mk.boxRatio, BOX_RATIO), boxLineWidth: num(mk.boxLineWidth, 1.2),
        barRatio: num(mk.barRatio, 0.88), barRadius: num(mk.barRadius, 0),
        lineWidth: num(mk.lineWidth, 1.8), lineType: mk.lineType,
        showSymbol: mk.showSymbol !== false, symbolSize: num(mk.symbolSize, 5), symbolShape: mk.symbolShape,
        scatterSize: num(mk.scatterSize, 6), scatterOpacity: num(mk.scatterOpacity, 0.72),
        scatterShape: mk.scatterShape
      };
      /* 迭代 21：底部留白几何快照（容器高 / 字号与行数降级 / 不变式余量 —— 自测与文档引用） */
      option.__axisFit = fitMeta(bottomFitRes);
      /* 迭代 9：横轴统计块几何（唯一来源 = axisTableLayout）—— 行名 / 数值行 / 方框全部由
         「最终 grid.bottom + 字号 + 实测文本宽度」推导。需要构建的两种情形：
           ① 方框开关开启（要画方框）；② 旋转非零（统计数值改由 graphic 水平逐行绘制）。
         数据表格已接管横轴表格（tableM 存在）时由 tableGraphic(..., frameOn) 负责，此处不重复。 */
      var axisFrameM = null, axisFrameEls = [];
      if (!tableM && ((statRows > 0 && xRes.header) || gmodel)) {
        axisFrameM = axisTableLayout({
          labels: xRes.labels, statLines: specStatLines,
          /* 迭代 28：无统计行但开了分组行时，行名列仍要有第一行文字（X 轴名） */
          headerTexts: specStatHeader || [(chart.xAxisName || '')],
          statRows: statRows, rotate: (xRes.policy && xRes.policy.rotate) || 0,
          /* 迭代 28：第二层分组行（同一组一个居中标签，跨该组全部 bar） */
          group: gmodel,
          /* 迭代 30（任务 D ①）：参数行行名 = X 列名（叶子列 = 最后一个 X 列，级 L = 第 L+1 个 X 列）
             任务 E②：与 grid.left 紧算共用同一份 paramNames（单一口径） */
          paramNames: paramNames,
          /* 迭代 21：沿用 axis.js 的绘制归属判定（graphic = 刻度标签只写类别名） */
          forceGraphic: (xRes.statMode === 'graphic'),
          /* 迭代 12：统计量旋转角（默认 0 → 与迭代 9 逐值一致） */
          statRotate: statRotate,
          lineHeight: xRes.header.lineHeight, gridBottom: num(box.gridBottom, xRes.gridBottom),
          fontSize: num(xRes.header.fontSize, 11),
          /* grid.right 必须取**最终生效值**（与数据表格同源）：卡片路径 plot-view.tightenOption 会把
             「无右轴」的 18 归一为 12 → 若这里用原始 18，列中心会整体偏 ~6px（实测 5.75px） */
          gridLeft: box.gridLeft + extraLeftFinal,
          gridRight: tableGridRight(rightRes, host.mode === 'fs'),
          /* 任务 E ②：Y 轴区实测留白（全屏重算做 grid.left 紧算时的下限） */
          yPad: gridLeftAxis,
          host: host
        });
      }
      if (axisFrameM) axisFrameEls = axisBlockGraphic(axisFrameM, style.xAxisColor || '#4a5866', frameOn);
      /* 任务 E ③：X 轴标题锚点与「参数行栈」同源 —— graphic 模式下 title 必须落在最后一行参数行之下，
         故一律采用 axisTableLayout 的 nameGap（= 轴标签间距 + 统计带 + 标签块 + 参数行带 + TITLE_GAP） */
      if (axisFrameM && axisFrameM.mode === 'graphic' && xRes.xAxis && num(axisFrameM.groupBand, 0) >= 0) {
        xRes.xAxis.nameGap = axisFrameM.nameGap;
      }
    /* 迭代 13：类别名的显示集合 == 数值的绘制集合。
       用户报障「横轴 label 与数据显示需要对齐」的根因是两套抽稀规则（ECharts 按标签足迹 auto +
       chart-builder 按数值足迹另跑贪心）。现改为：两者共用同一 kept 集合 ——
       axisLabel.interval 用**函数**形式逐索引返回 kept[i]，数值也只对 kept 绘制。
       · 函数型 interval 下 ECharts 不再自行加/减 min·max 标签（5.6 `rb()` 只过滤），
         故「显示的类别名」恰好是 kept 集合；hideOverlap 保留作兜底（kept 按保守足迹算，永远不触发）。
       · axis 模式（rotate=0 且 stats.rotate=0）**不动**：标签与数值在同一 label 块里，天然对齐。 */
    if (axisFrameM && axisFrameM.mode === 'graphic' && axisFrameM.kept &&
        xRes.xAxis && xRes.xAxis.axisLabel) {
      xRes.xAxis.axisLabel.interval = keptIntervalFn(axisFrameM.kept);
      /* 自测 / 文档可读：本次实际使用的 kept 索引集合（ECharts 忽略未知顶层字段） */
      option.__axisKept = {
        n: axisFrameM.categories,
        indices: axisFrameM.keptArr.slice(),
        count: axisFrameM.keptCount
      };
    }
      /* 迭代 7 · C：数据表格（ECharts graphic，画在绘图区下方；位置全部相对容器底边 → 缩放不错位）
         迭代 8：frameOn=true 时补成完整方框（含左侧行名列） */
      var tableEls = tableM ? tableGraphic(tableM, frameOn) : [];
      var graphicEls = [];
      if (tableEls.length) graphicEls = graphicEls.concat(tableEls);
      if (axisFrameEls.length) graphicEls = graphicEls.concat(axisFrameEls);
      if (graphicEls.length) option.graphic = graphicEls;
      /* 自测 / 文档可读的表格信息（ECharts 忽略未知顶层字段） */
      option.__table = tableM ? {
        on: true, mode: tableM.hostMode, containerW: Math.round(tableM.containerW),
        gridLeft: tableM.gridLeft, gridLeftExtra: tableM.gridLeftExtra, gridRight: gridRightBase,
        gridBottom: tableM.gridBottom, plotW: Number(tableM.plotW.toFixed(2)),
        band: Number(tableM.band.toFixed(3)), step: tableM.step,
        colCount: tableM.colCount, shownCount: tableM.shownCount, cellW: Number(tableM.cellW.toFixed(2)),
        cols: tableM.cols.map(function (c) {
          return { i: c.i, cx: Number(c.cx.toFixed(2)), cellL: c.cellL, cellR: c.cellR, label: c.label };
        }),
        rows: tableM.rows.map(function (r) { return { name: r.name, kind: r.kind, cells: r.cells }; }),
        rowNames: tableM.rowNames, nAll: tableM.nAll, tableH: tableM.tableH,
        padBottom: tableM.padBottom, font: TABLE.FONT, rowH: TABLE.ROW_H,
        rowHeadRight: tableM.rowHeadRight, leftEdge: tableM.leftEdge, rightEdge: tableM.rightEdge,
        /* 第四轮：表格首行 = 分组行（跨列合并）——每格只覆盖该组的列，count = 该组 bar 数 */
        groupOn: !!tableM.groupOn,
        groupCells: (tableM.groupCells || []).map(function (c) {
          return { label: c.label, i0: c.index0, i1: c.index1, count: c.count,
            left: c.left, right: c.right, cx: c.cx, span: c.span };
        }),
        /* N 级：首部 N 行分组行（级 0 在上）—— groupCells 恒 = 级 0 */
        groupCellsByLevel: (tableM.groupCellsByLevel || []).map(function (g) {
          return (g || []).map(function (c) {
            return { label: c.label, i0: c.index0, i1: c.index1, count: c.count,
              left: c.left, right: c.right, cx: c.cx, span: c.span };
          });
        }),
        groupRowCount: num(tableM.groupRowCount, 0),
        /* 第五轮（用户需求：统计行在上、分组行 + 横轴参数行在最下）：
           纵向行序 + **实际绘制出去的 graphic bottom**（越大越靠上）。
           自测用 Math.min(statBottoms) > Math.max(groupBottoms) 断言统计行整体在上方。 */
        layout: {
          order: 'stat,series,group,param',
          nStat: num(tableM.layout && tableM.layout.nStat, 0),
          nSeries: num(tableM.layout && tableM.layout.nSeries, 0),
          groupRowCount: num(tableM.groupRowCount, 0),
          headerSlot: num(tableM.layout && tableM.layout.headerSlot, 0),
          statBottoms: (tableM.placed && tableM.placed.statBottoms) ? tableM.placed.statBottoms.slice() : [],
          seriesBottoms: (tableM.placed && tableM.placed.seriesBottoms) ? tableM.placed.seriesBottoms.slice() : [],
          groupBottoms: (tableM.placed && tableM.placed.groupBottoms) ? tableM.placed.groupBottoms.slice() : [],
          headerBottom: (tableM.placed && tableM.placed.headerTextBottom !== null) ? tableM.placed.headerTextBottom : null
        },
        /* 迭代 8：方框开关生效情况（frameEdges 描述完整方框的 4 条边，rowHeadRight 落在框内） */
        frame: !!frameOn,
        frameEdges: {
          left: tableM.leftEdge, right: tableM.rightEdge,
          bottom: tableM.padBottom, top: tableM.padBottom + tableM.nAll * TABLE.ROW_H,
          rowHeadRight: tableM.rowHeadRight,
          rowHeadInside: tableM.rowHeadRight > tableM.leftEdge && tableM.rowHeadRight < tableM.rightEdge,
          frameLines: frameOn ? 3 : 0
        },
        elements: tableEls.length
      } : { on: false, wanted: !!tableWanted, reason: tableSkip || (tableWanted ? '' : '未开启或无类别') };
      /* 迭代 8（需求 5）/ 迭代 9：横轴坐标表格（数据表格未开启时作用于「行名列 + 标签块 + 数值行」块）
         —— 元数据由 axisTableMeta 统一生成；方框开关关闭时保持既有「未开启」形态（回归红线） */
      option.__axisTableSpec = axisFrameM ? axisSpecOf(axisFrameM, frameOn) : null;
      /* 任务 H：箱体槽位记录（alignBoxSeries 与自测共用；ECharts 忽略未知顶层字段）
         · lanes = 每类最多几个箱体系列同时有数据（槽位数）
         · step  = 槽位间距（px，按构建时的估计带宽算；对齐时以 __axisTableSpec.bandW 实测值重算）
         · note  = 为什么「箱数 = 该类别有数据的系列数」而不是系列总数 */
      option.__boxLayout = boxLane ? {
        on: true, lanes: boxLane.lanes,
        band: Math.round(boxLane.band * 1000) / 1000,
        step: Math.round(boxLane.step * 1000) / 1000,
        boxW: boxLane.w, borderW: num(mk.boxLineWidth, 1.2),
        /* ECharts 只为**有数据的点**建图元：空箱 [null×5]（含窗口外的 '-' 占位）不建图元，
           故「每类箱数」天然等于该类别有数据的系列数，不需要额外隐藏 */
        note: '空箱（[null×5] / 窗口外 "-" 占位）ECharts 不建图元 → 箱数 = 该类别有数据的系列数'
      } : null;
      /* 第六轮：轴层通道纵向次序 = 统计行 → 分组带 → 轴标签（实际绘制的 graphic bottom，
         供自测直接断言 min(statBottoms) > max(groupBottoms)） */
      option.__statBlock = axisFrameM ? statBlockOf(axisFrameEls, axisFrameM) : null;
      option.__axisTable = (axisFrameM && frameOn)
        ? axisTableMeta(axisFrameM, true, axisFrameEls.length)
        : {
          on: false, frame: false, wanted: !!frameOn,
          reason: !frameOn ? '开关未开启（默认关闭）' : (tableM ? '已由数据表格方框接管' : '无横轴统计表格（未显示统计行或图型不支持）')
        };
      /* 迭代 28 / 第四轮：第二层分组行元数据（自测 / 文档引用；ECharts 忽略未知顶层字段）
         · source='axis'  → 统计行通道（plot.table.show=false），几何来自 axisTableLayout
         · source='table' → 数据表格通道（plot.table.show=true），几何来自 tableModel 的首行合并格
         两条通道共用一个 __groupAxis 形状，调用方（自测 / 文档）不必分辨通道。 */
      var gaCells = null, gaSrc = null, gaLevels = null;
      function gaCellOf(c, gr) {
        return {
          label: c.label, i0: c.index0, i1: c.index1, count: c.count,
          left: c.left, right: c.right, cx: c.cx, span: c.span,
          merged: !!c.merged,
          textPx: gr ? gr.textPx : 0, rotate: gr ? gr.rotate : 0
        };
      }
      if (gmodel && axisFrameM && axisFrameM.groupOn) {
        gaSrc = 'axis';
        gaLevels = (axisFrameM.groupLevels || []).map(function (L2) {
          var cells2 = (L2.cells || []).map(function (c) { return gaCellOf(c, c); });
          return {
            index: L2.index, h: L2.h, gap: L2.gap, band: L2.band, rotate: L2.rotate,
            rotCount: cells2.filter(function (c) { return c.rotate > 0; }).length,
            count: cells2.length, cells: cells2,
            counts: cells2.map(function (c) { return c.count; }),
            /* 迭代 30（任务 D ①/②）：该级行带位置 + 行名（X 列名）+ 合并格统计 */
            name: L2.name || '',
            bottom: num(L2.bottom, 0), top: num(L2.top, 0),
            mergedCells: num(L2.mergedCells, 0),
            countSum: num(L2.countSum, 0)
          };
        });
        gaCells = gaLevels.length ? gaLevels[0].cells : null;
      } else if (gmodel && tableM && tableM.groupOn) {
        gaSrc = 'table';
        var gbRows = tableM.groupCellsByLevel || [];
        gaLevels = gbRows.map(function (row, li) {
          var srcL = (gmodel.levels && gmodel.levels[li]) ? gmodel.levels[li] : null;
          var cells2 = (row || []).map(function (c, ci2) {
            var gr = (srcL && srcL.runs) ? srcL.runs[ci2] : null;
            return gaCellOf(c, gr);
          });
          return {
            index: li, h: TABLE.ROW_H, gap: 0, band: TABLE.ROW_H,
            rotate: srcL ? num(srcL.angle, 0) : 0,
            rotCount: cells2.filter(function (c) { return c.rotate > 0; }).length,
            count: cells2.length, cells: cells2,
            counts: cells2.map(function (c) { return c.count; })
          };
        });
        gaCells = gaLevels.length ? gaLevels[0].cells : null;
      }
      var gaTotalBand = 0;
      if (gaLevels) for (var gaL0 = 0; gaL0 < gaLevels.length; gaL0++) gaTotalBand += num(gaLevels[gaL0].band, 0);
      option.__groupAxis = (gaCells && gaCells.length) ? {
        on: true, source: gaSrc,
        h: (gaSrc === 'table') ? TABLE.ROW_H : axisFrameM.groupH,
        gap: (gaSrc === 'table') ? 0 : axisFrameM.groupGap,
        band: gaTotalBand,
        runs: gaCells.length,
        n: (gaSrc === 'table') ? tableM.colCount : axisFrameM.categories,
        bandW: Number(((gaSrc === 'table') ? tableM.band : axisFrameM.band).toFixed(3)),
        rotCount: gaCells.filter(function (c) { return c.rotate > 0; }).length,
        cells: gaCells,
        labels: gmerge.subLabels.slice(),
        /* N 级：级 0 在最上（靠绘图区 / 表格首行），编号递增向下 */
        levels: gaLevels || [],
        levelCount: (gaLevels || []).length,
        cellsByLevel: (gaLevels || []).map(function (L3) { return L3.count; })
      }
        : { on: false, merged: !!gmerge.on, levels: [], levelCount: 0, cellsByLevel: [] };
      /* dataZoom 若将来在此追加，xAxisIndex/yAxisIndex 必须覆盖 [0,1]（含上/右外框轴） */
      if (Object.keys(TOOLBOX).length) option.toolbox = TOOLBOX;
      /* 迭代 17：图内颜色统一跟随当前主题令牌（详见 themeFollowColors 注释） */
      themeFollowColors(option, {
        '--ink-soft': cssVar('--ink-soft', '#4a5866'),
        '--ink': cssVar('--ink', '#16202a'),
        '--ink-dim': cssVar('--ink-dim', '#7d8b98'),
        '--border-strong': cssVar('--border-strong', '#b6c0c9'),
        '--grid-line': cssVar('--grid-line', GRID_COLOR)
      });
      return option;
    } catch (e) {
      if (global.console && console.error) console.error('[YMS.ChartBuilder] buildOption 失败', e);
      return { title: { text: (chart && chart.title) || '', subtext: '图表配置构建失败' }, series: [] };
    }
  }

  /* ------------------------------------------- 任务 H · 箱体↔数据列对位 */
  /**
   * 把**已渲染**的箱体按类别重新摆到它自己的数据列正下方（幂等）。
   *
   * 背景见 boxLanesOf 注释：ECharts 的箱线布局按「同轴系列总数 N」均分带宽，
   * 分组图里一类常只有 2~3 个系列有数据 → 箱体整体偏心（实测左偏 17.53px）。
   *
   * 契约（每个可见类别 i）：
   *   ① 该类全部箱体的几何包围盒中心 == 该列列心 cx（误差 ≤ 1px）
   *      cx 直接取 __axisTableSpec.cols[i].cx —— 与表格数值行用的是同一份列几何（同源，不可能漂移）
   *   ② 箱数 == 该类别有数据的系列数（ECharts 对空箱不建图元，天然成立；这里只统计并回报）
   *   ③ 类别 ↔ 列一一对应（双向差集回报在 orphans 里）
   * 排布：该类 m 个箱体按**系列序号**从左到右，槽距 step = 0.8 × 带宽 / lanes，
   *      目标列心 = cx + (k − (m−1)/2) × step → 无论 m = lanes 还是 m < lanes，包围盒中心恒等于 cx。
   *
   * 位移手段：boxplot 的图元是 boxplotBoxPath，shape.points 已经是绝对画布坐标（el.x 初值 0），
   * 所以只能改 el.x（zrender 的平移变换）；命中测试走同一变换，悬浮/tooltip 仍对着箱子本体。
   * 每次重渲染（setOption）ECharts 都会重建图元 → 卡片 / 全屏 / 缩放后都必须再调用一次本函数。
   *
   * @param {object} inst ECharts 实例
   * @returns {{ok:boolean, reason?:string, lanes:number, step:number, cols:Array, orphans:object, moved:number, note:string}|null}
   */
  function alignBoxSeries(inst) {
    if (!inst || typeof inst.getOption !== 'function') return null;
    var op = null, spec = null, lay = null;
    try { op = inst.getOption(); } catch (e0) { return null; }
    spec = op ? op.__axisTableSpec : null;
    lay = op ? op.__boxLayout : null;
    if (!spec || !spec.cols || !spec.cols.length) return null;      // 无横轴表格几何 → 无从对位
    var lanes = lay && lay.lanes ? lay.lanes : 1;
    var bandW = num(spec.bandW, 0);
    if (!(bandW > 0)) return null;
    var step = boxStepOf(bandW, lanes);

    /* ① 收集真实画出来的箱体图元（series 序号 + dataIndex + 当前包围盒中心） */
    var items = [], sers = null;
    try { sers = inst.getModel().getSeries(); } catch (e1) { return null; }
    for (var s = 0; s < sers.length; s++) {
      var sm = sers[s];
      if (!sm || sm.subType !== 'boxplot') continue;
      var data = null;
      try { data = sm.getData(); } catch (e2) { continue; }
      if (!data) continue;
      for (var d = 0; d < data.count(); d++) {
        var el = null;
        try { el = data.getItemGraphicEl(d); } catch (e3) { el = null; }
        if (!el) continue;
        /* 图例关掉的系列：图元仍在图形树里，但自身或某级父组被标 ignore → **不能**计入包围盒，
           否则「幽灵箱体」会把整列的对位带偏（实测图例开关后残留 2.5px 偏位就是这个原因）。 */
        var skipIgn = !!el.ignore;
        for (var pp = el.parent; pp && !skipIgn; pp = pp.parent) { if (pp.ignore) skipIgn = true; }
        if (skipIgn) continue;
        if (sm.isFiltered && sm.isFiltered()) continue;
        var r = el.getBoundingRect().clone();
        var m = el.getComputedTransform ? el.getComputedTransform() : el.transform;
        if (m) r.applyTransform(m);
        if (!isFinite(r.x) || !isFinite(r.width)) continue;
        items.push({ s: s, d: d, el: el, cx: r.x + r.width / 2 });
      }
    }

    /* ② 按类别分组（组内按系列序号排） */
    var byCat = {}, order = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      if (!byCat[it.d]) { byCat[it.d] = []; order.push(it.d); }
      byCat[it.d].push(it);
    }
    order.sort(function (a, b) { return a - b; });

    /* ③ 列索引 → 列心（__axisTableSpec.cols 是唯一来源） */
    var colByI = {};
    for (var c = 0; c < spec.cols.length; c++) colByI[spec.cols[c].i] = spec.cols[c];

    var moved = 0, colsOut = [], boxNoCol = [], colNoBox = [], counted = {};
    for (var oi = 0; oi < order.length; oi++) {
      var di = order[oi], list = byCat[di];
      list.sort(function (a2, b2) { return a2.s - b2.s; });
      var col = colByI[di];
      if (!col) { boxNoCol.push(di); continue; }
      counted[di] = 1;
      var m2 = list.length, minX = Infinity, maxX = -Infinity;
      for (var q2 = 0; q2 < m2; q2++) {
        var q3 = list[q2];
        var target = col.cx + (q2 - (m2 - 1) / 2) * step;
        var dx = target - q3.cx;
        if (Math.abs(dx) > 0.005) {
          q3.el.x = num(q3.el.x, 0) + dx;
          moved++;
          q3.cx = target;
        }
        minX = Math.min(minX, q3.cx - q3.el.getBoundingRect().width / 2);
        maxX = Math.max(maxX, q3.cx + q3.el.getBoundingRect().width / 2);
      }
      colsOut.push({
        i: di, n: m2, cx: Math.round(col.cx * 100) / 100,
        /* 摆好之后的实测包围盒中心（自测直接读这份，与图元实测互为交叉验证） */
        bboxCx: Math.round(((minX + maxX) / 2) * 100) / 100,
        dx: Math.round(((minX + maxX) / 2 - col.cx) * 100) / 100
      });
    }
    for (var c2 = 0; c2 < spec.cols.length; c2++) {
      var ci = spec.cols[c2].i;
      if (!counted[ci]) colNoBox.push(ci);
    }

    var rec = {
      ok: true, lanes: lanes, step: Math.round(step * 100) / 100,
      bandW: bandW, cols: colsOut,
      boxCount: items.length, moved: moved,
      orphans: { boxNoCol: boxNoCol, colNoBox: colNoBox },
      note: '空箱（[null×5] / 窗口外 "-" 占位）ECharts 不建图元 → 箱数 = 该类别有数据的系列数；' +
        '位移落 el.x（boxplotBoxPath 的 shape.points 为绝对坐标）'
    };
    try { inst.__boxAlign = rec; } catch (e4) { /* 只读实例也能跑（沙盒） */ }
    YMS.ChartBuilder.__boxAlign = rec;
    return rec;
  }

  YMS.ChartBuilder = {
    PALETTE: PALETTE,
    PALETTE_ALT: PALETTE_ALT,
    FIT_PALETTE: FIT_PALETTE,
    SYMBOLS: SYMBOLS,
    TOOLBOX: TOOLBOX,
    /** 迭代 7 · C：数据表格样式常量（测试 / 文档引用） */
    TABLE: TABLE,
    registerTheme: registerTheme,
    buildOption: buildOption,
    /**
     * 迭代 9 · C：按**最终** grid.bottom / 字号重算横轴统计块（行名 + 数值行 + 方框）并替换 graphic 元素。
     * 供全屏路径（fullscreen.js）在抬高 grid.bottom（+34）/ 放大字号（+2）之后调用 ——
     * 保证卡片与全屏下的行锚点都由同一来源推导（行名行 ↔ 数值行像素中心偏差 ≤ 1px）。
     */
    reflowAxisTable: reflowAxisTable,
    /**
     * 任务 H：箱体↔数据列横向对位（每个可见类别：全部箱体的包围盒中心 = 该列列心，误差 ≤ 1px）。
     * 必须在**每次 setOption 之后**调用（卡片渲染 / 全屏渲染 / 缩放后重渲染三条路径）。
     * 幂等：按「当前中心 → 目标中心」求差，重复调用不会累加位移。
     */
    alignBoxSeries: alignBoxSeries,
    /** 分组取值 → 颜色 / 符号（设置面板与自测可复用） */
    colorFor: colorFor,
    symbolFor: symbolFor,
    /** 迭代 11：计划 → 分组配色键（规则同设置区；自测可复用） */
    colorKeyOf: planColorKey,
    /** 供图例副标题等复用 */
    fmtVal: fmtVal
  };
})(typeof window !== 'undefined' ? window : this);
