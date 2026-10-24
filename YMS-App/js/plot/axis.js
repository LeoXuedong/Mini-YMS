/* ==========================================================================
   YMS · plot/axis.js
   ---------------------------------------------------------------------------
   职责：坐标轴策略（智能轴 + 抗拥挤 + 多 Y 轴）——纯函数，不依赖 DOM，可独立调用。

   轴策略表（与《使用说明》一致，必须严格实现 DEV-SPEC 3.C2）：
     · X 类别数 ≤ 8      → 旋转 0°
     · 9 ~ 20            → 旋转 45°
     · 21 ~ 80           → 旋转 30°
     · > 80              → 旋转 30° + interval = ceil(count/80) + hideOverlap
     · 标签长度 > 8 字符 → 截断 12 + '…'（完整值由 tooltip 显示；12 字符保证 L001~L006 等合并标签完整可读）
     · 标签长度 > 20     → 截断 16 + '…'
     · X 轴标题默认居中于刻度下方（nameLocation:'middle'），nameGap 随旋转角
       0°/30°/45° → 26/38/52，并据此给出 gridBottom（含标签长度修正）
     · Y 轴标题默认显示（= Value 参数名）；gridLeft 按「刻度文本实测宽 + 标题宽 + 间距」给出
       （迭代 15：nameGap = max(44, 8 + tickMaxPx + 6)，gridLeft = nameGap + 标题宽 + 4，下限 60 上限 168；
        旧实现只按标题字数估 48~110，刻度一宽就把标题挤出画布）

   本文件不读写 Store，不改 DOM；返回纯数据（ECharts option 片段）。

   补充（迭代需求）：
     · niceStep(raw)  → 1/2/2.5/5/10 × 10^k 中 ≥ raw 的最小「好看步长」
     · smartRange(vals, {zeroMin}) → 默认（未显式填 Min/Max）时的聪明 Y 范围
       {min, max, step, dataMin, dataMax, rawMin, rawMax, n, loFixed, hiFixed}；
       非负数据（直方图频数）可用 zeroMin=true 固定下限 0；
       空数据返回 null（交回 ECharts 自动）；由 ChartBuilder 调用。

   迭代 4（docs/DEV-SPEC-迭代4.md §3.3 / §3.4）：
     · valueAxis(...) 支持 { id, position:'left'|'right', autoMinMax }：
       position='right' 生成右轴（position:'right'）；autoMinMax=true 忽略
       style.yMin/yMax（右轴一律走智能范围，左右轴各自独立）；
       返回结构在原有 { yAxis, gridLeft } 上追加 { gridRight, position } ——
       既有单轴调用（只读 gridLeft）行为完全不变。
     · categoryAxis(...) 支持 opts.statLines（每类的统计行文本，多行 '\n' 连接）：
       刻度标签第 1 行仍是类别名，其后每行一个统计量；同时按行数加大 gridBottom
       （STAT_ROW_H = 13px/行）；不传 statLines 时与迭代 3 完全一致。
     · smartRange(...) 支持「只按指定 series 集合计算」：入参可混装
       数字 / 数组 / 数组的数组 / {ys|values|data} 对象（左右轴各传自己的 series）。
     · smartRange 修复既有缺陷（§3.4）：多系列量级差异大时（实测 Line + Yield/Vth/Idsat，
       数据 0.52~92.01）step 对齐把下界拉成 -50。新规则：step 对齐造成的「额外下沉」
       不得超过 MAX_PULL_PADS(3) 个 8% 留白带（正常贴边 ≤ 1 个带 → 整齐刻度保持不变，
       回归红线）；超过即判定为被 step 拉坏，下界改用契约值「数据下界 - 8% 留白」，
       上界同理收回「数据上界 + 8% 留白」。

   迭代 5（显示抗拥挤 · 仅改判定，不推翻既有策略常量）：
     · rotatePolicy(count, len, opts)：新增可选 opts { plotWidth, labelPx }。仅在既有判定
       给出 0°（count ≤ ROTATE_NONE_MAX）且「count × (labelPx + LABEL_GAP) > plotWidth」时
       升级为 45°（widthForced=true）；不传 opts 时行为与迭代 4 完全一致。
     · categoryAxis(...)：opts.plotWidth 可覆盖估算宽度（缺省 ASSUME_PLOT_W=520）；
       横轴统计行文本宽度计入估算 —— 取「类别名 / 统计行」的最长单行字符数 estChars，
       用于旋转补判与 gridBottomFor（旋转后标签变高，相应加大 grid.bottom，避免压住轴标题）。
       无统计行时 estChars === 类别名长度 → 与迭代 4 逐值一致（回归红线）。

   迭代 6（X 轴标签与 Box 一一对应 + 统计行左置表头）：
     · 【接口契约 · 与 chart-builder.js 的分工，双方必须一致】
         categoryAxis(cats, {
           statLines : Array<string>,   // 每类的**统计数值行**（多行 '\n' 连接，**只写数值**，
                                        // 如 '92.55\n1.12\n3.78'；行序 = stats.items = STAT_ORDER）
           statHeader: Array<string>    // 左置表头的**每一行文字**：第 1 行 = X 轴列名（如 'Lot'），
                                        // 其后每行 = 一个统计量名（'Mean'/'Std'/'RNG'/'Nu%'…），
                                        // 顺序与 statLines 的数值行严格一致 → 逐行对齐
         }) → { xAxis, gridBottom, policy, labels, rawLabels, statRows, header }
         · 刻度标签 = 类别名（第 1 行，沿用原截断/旋转策略）+ statLines（其后每行一个数值）
           —— 名称一律不再重复写在刻度标签里。
         · header（无 statHeader 时为 null）= { text, rows, fontSize, lineHeight, width,
           rightX, bottom, gridLeftExtra }：
             text          多行表头文本（'\n' 连接，供 ECharts graphic 直接使用）
             rows          表头行数（恒 = 1 + 启用统计量个数）
             fontSize/lineHeight  与刻度标签完全同字号同行高 → 逐行对齐
             width         表头文本估算宽度（px）
             leftX         表头文本块左边界距容器左边缘（px）——graphic 用 left:leftX
             rightX        表头文本块右边界距容器左边缘（px）≈ leftX + width
             bottom        表头底边距容器底边（px）——graphic 用 bottom:...（不依赖容器高度）
             gridLeftExtra 必须额外预留在 grid.left 的宽度（表头 + 两侧留白）
       ※ 名称 / 数值的分工：axis 负责标签文本组装、行高、grid.bottom、grid.left 预留；
         chart-builder 负责把 header 用 ECharts graphic 画出来（位置取 header.rightX / bottom）。
     · 【标签几何驱动】取消「固定索引抽稀」：xAxis.axisLabel.interval 在类别数 ≤ TICK_DENSE_HARD(200)
       时恒为 'auto'，且 hideOverlap 恒为 true —— ECharts 按真实布局与**当前缩放窗口**决定显示哪些
       标签，每个显示出来的标签必然是其正下方 Box 的标签（不会跨类别错位）。仅当类别数 > 200
       时才退回固定抽稀（极端兼容）。旋转判定改为按「多行文本块旋转 45° 后的横向投影」估算
       （statRows === 0 时与迭代 5 逐值一致 —— 回归红线）。
  迭代 7（X 轴旋转角设置 + 图内无标题）：
     · 【新增】xRotateOf(style) → 'auto' | 0 | 30 | 45 | 60 | 90
         style.xRotate 为显式角度（0/30/45/60/90）时，categoryAxis 的 rotate **强制**取该值，
         不再跑自动拥挤度判定（widthForced 恒 false）；style.xRotate === 'auto'（或字段缺省 /
         非法值）时完全走迭代 6 的既有 rotatePolicy —— 逐值一致（回归红线）。
         注意：字段缺省按 'auto' 处理 —— 默认值由 store.js 的 DEFAULT_STYLE.xRotate 提供
         （另一路负责加该字段，本文件只做消费），故未加该字段时行为与迭代 6 完全相同。
       · interval:'auto' + hideOverlap:true 的「几何驱动显示」与旋转角无关：显式 0° 时密集标签
         同样靠 ECharts 隐藏重叠标签（而不是自动旋转）。
       · NAME_GAP 增加 60/90 两档（显式大角度时 X 轴标题相应下移，grid.bottom 随之加大）。
       · 图内 Title 由 chart-builder 置空（本文件不涉及标题，仅命名说明）。
       迭代 9（只旋转类别名 + 数值行水平 + 方框几何同源）：
       · 【新增】statMode = (statRows > 0 && policy.rotate !== 0) ? 'graphic' : 'axis'
           'graphic' → axisLabel.formatter 只返回**类别名**（旋转角不变）；统计数值由 chart-builder
                       用 graphic 水平逐行画在旋转标签块下方（rotate === 0 一律 'axis'，逐值不变）。
           'axis'    → 迭代 4~8 的既有行为（多行标签：类别名 + 数值行）。
       · 【新增】opts.measurePx(text, fontPx) → number：文本像素宽度实测回调（chart-builder 传
         canvas measureText）。传入时行名列宽（header.colW / gridLeftExtra）与旋转标签块高按**实测**
         宽度计算（'Mean' 不再被裁）；不传（Node 桩环境）时回退「字符数 × 平均字符宽」估算。
       · 【新增导出】rowHFor(fontPx)（= clamp(字号×1.18, 13, 20.8)，11px → 13 = STAT_ROW_H）与
         rotatedBlockH(rotate, labelPx, fontPx)（= 块宽·|sinθ| + 行高·|cosθ|，rotate=0 时为单行高）
         —— chart-builder 的行高 / 旋转块高只有一个来源，卡片与全屏共用。
       · grid.bottom：statMode='graphic' 时 = 轴标签间距(7) + 旋转标签块高 + 数值行高 + TITLE_GAP(10)
         + 标题高度 + 6，上限由 240 放宽到 MAX_GRID_BOTTOM(280)（不裁内容）。
         header 追加字段：statMode / rotate / rowH / rotH / labelPx / labelTop / colW（供 chart-builder
         直接推导行锚点，避免两侧各算一套）。
  迭代 13（用户报障「横轴 label 与数据显示需要对齐」——统一抽稀集合）：
     · 新增 keptIndices(o)（导出）：把「类别名足迹」与「数值足迹（多统计量取最宽投影）」合成
       **一套** kept 索引集合 —— 一个类别只有两种足迹都不与上一个 kept 类别重叠时才保留，
       抽稀粒度取两者较差者（宁可少显示，也不错位）。
       足迹公式：旋转 θ 用 |w·cosθ| + |h·sinθ|，水平直接用文本实测宽度。
     · categoryAxis 的 axisLabel.formatter 改为「显示文本 → 数据索引」反查（类别名唯一时）：
       ECharts 5.6 在函数型 interval / 抽稀 / dataZoom 时把 formatter 的第二参传成**窗口内序号**
       （tick.value − extent[0]），直接当数据索引用会在缩放后串类别（实测 cat6 位置显示 cats[0]）。
     · chart-builder 侧：axisLabel.interval 用**函数**（kept[i]）→ 显示的类别名恰为 kept 集合；
       数值只对 kept 集合绘制，位置仍严格对准类别中心 → label ↔ 数值一一对应。
       xRotate=0 && stats.rotate=0（多行标签路径）**不动**，interval 仍为 'auto'（逐值不变）。
     迭代 21（用户报障「横轴长标签必须完整显示，可向上延伸」）：
     · 【查明的实拍缺陷】旧实现用 MAX_GRID_BOTTOM(280) / MAX_GRID_BOTTOM_ROT(400) **封顶**：
     长标签（如 2026-09-30 14:23:45）+ 多个统计行时「需要值」超过封顶 → grid.bottom 被压小，
     而标签块仍按真实宽度绘制 → 统计行（Median / Nu%）被挤进标签块下半段（互相叠压），
     且底部越出容器被裁。容器越矮（多图页）越严重：实测 441×253 卡片下 grid.bottom=288，
     绘图区高 −59，统计行侵入标签 147px、越界 49px。
     · 【新公式】grid.bottom 改为**相加**（bottomFit() 为唯一来源）：
       轴标签间距 + 标签块高(rotH) + 行间距 + 统计行总高(rows×rowH)
       + 轴标题带(TITLE_GAP+标题高+余量) + 容器附加带(全屏 slider)
     不变式：统计行上沿 ≥ 绘图区下沿 + rotH（标签与统计行永不重叠）。
     · 【去掉封顶裁字】上限改为「容器可用高度」：cap = min(容器高×0.55, 容器高−grid.top−120)；
     仍放不下时按序降级 ① 标签字号缩到 9px（不裁字）② 绘图区放宽到 80px ③ 减少统计行数。
     · 【不截断】旋转非零（30/45/60/90）时类别名**完整显示**（旧实现截断到 12/16 字符 + '…'）；
     空间由加大的 grid.bottom 提供（宁可把绘图区向上压，也不裁标签）。
     · 【全屏】fullscreen.js 用全屏容器**实际高度**重算（不再盲目 +34），
     并同时重排行锚点 / 轴标题 / dataZoom（延续迭代 9 的重算入口）。
     ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;

  /* ------------------------------------------------------------------ 常量 */
  var ROTATE_NONE_MAX = 8;      // ≤ 8 类：不旋转
  var ROTATE_45_MAX = 20;       // 9 ~ 20：45°
  var ROTATE_30_MAX = 80;       // 21 ~ 80：30°
  var TICK_DENSE = 80;          // > 80：每 ceil(count/80) 个刻度显示 1 个（rotatePolicy 的既有语义，保留）
  var TRUNCATE_1 = 12;          // 标签长度 > 8 → 截断 12 字符 + '…'（保留合并标签 L001~L006 两端点）
  var TRUNCATE_2 = 16;          // 标签长度 > 20 → 截断 16 字符 + '…'
  var NAME_GAP = { 0: 26, 30: 38, 45: 52, 60: 64, 90: 88 };
  /* --------------------------------------------------------------------------
     迭代 15（需求 ②）：Y 轴左侧留白不再按「标题字数」估算，改为
       gridLeft = nameGap + titlePx + Y_TITLE_PAD（下限 GRID_LEFT_MIN）
       nameGap  = max(Y_NAME_GAP_MIN, Y_TICK_MARGIN + tickMaxPx + Y_NAME_TICK_GAP)
     其中 tickMaxPx = 该轴**实际会显示的刻度文本**（min/max/interval 推导 + formatter 同源格式化后
     用 canvas measureText 实测）的最大宽度；titlePx = 竖排标题的横向占用（≈ 行高）。
     实测依据（Chromium + ECharts 5.5）：ECharts 把 Y 轴标题锚定在「轴线 − nameGap」处，
     标题右缘 = grid.left − nameGap，**与刻度文本宽度无关** —— 旧公式只按标题字数给 48~110px，
     刻度一旦变宽（1.48 / 0.475 / -1234.5）标题就被推到画布外（实测 x = -7，被裁 7px）。
     -------------------------------------------------------------------------- */
  var GRID_LEFT_MIN = 60;       // 左侧留白下限（原 48：1 字标题 + 2 位小数刻度即被裁）
  var GRID_LEFT_MAX = 168;      // 左侧留白上限（宽刻度可放宽，但别啃掉绘图区）
  var Y_TICK_MARGIN = 8;        // 刻度文本右缘到轴线的距离（= ECharts axisLabel.margin 默认值）
  var Y_NAME_TICK_GAP = 6;      // Y 轴标题右缘与刻度文本左缘的最小间距（px）
  var Y_NAME_GAP_MIN = 44;      // 标题锚点最小偏移（与迭代 4~14 的 nameGap=44 逐值一致）
  var Y_TITLE_PAD = 4;          // 标题左缘距容器左缘的最小留白（要求 ≥ 2px）
  var Y_GRID_RIGHT_MIN = 12;    // 无右轴时的右侧留白下限（与迭代 8 tightenOption 同值）
  var TITLE_W_RATIO = 1.2;      // 竖排标题横向占用 / 字号（ECharts 文本行高 ≈ 字号 × 1.0~1.2）
  var STAT_ROW_H = 13;          // 横轴统计行每行占用高度（px，契约 §3.3：每行约 13px）
                                // 迭代 6：同时作为 axisLabel.lineHeight 与左置表头的行高 → 逐行对齐
  /* 迭代 6 常量 */
  var TICK_DENSE_HARD = 200;    // 仅当类别数 > 200 才退回「固定索引抽稀」；否则交给 ECharts 按几何决定
  var HEADER_PAD = 4;           // 左置统计表头与 Y 轴区 / 容器左边缘的间距（px）
  var AXIS_LABEL_MARGIN = 7;    // 刻度标签与轴线的距离（px）—— 左置表头按同一值与其首行顶端对齐
  var MAX_PULL_PADS = 3;        // step 对齐允许的额外下沉上限（8% 留白带数，契约 §3.4）
  /* 迭代 5（显示抗拥挤）常量 —— 仅用于「类别少但标签宽」时的补判，不推翻上面的既有策略常量 */
  var CHAR_W_RATIO = 0.58;      // 中英混排平均字符宽度 / 字号
  var LABEL_GAP = 10;           // 相邻刻度标签之间需要的最小水平间距（px）
  var ASSUME_PLOT_W = 520;      // 估算的可用绘图宽度（px）：多列网格下最窄卡片的经验值
                                // （卡片宽度上限见 css/plot.css .chart-card max-width: 760px）
  /* 迭代 7（X 轴旋转角设置）常量 */
  var X_ROTATE_ALLOWED = [0, 30, 45, 60, 90];   // style.xRotate 允许的显式角度（'auto' 另计）
  /* 迭代 9（只旋转类别名 + 数值行水平 + 方框包住全部内容）常量 */
  var TITLE_GAP = 10;           // 数值行底部与 X 轴标题之间的距离（px）
  var MAX_GRID_BOTTOM = 280;    // grid.bottom 上限（迭代 9 由 240 放宽：旋转标签块 + 数值行 + 标题更高）
  var HEADER_TEXT_PAD = 3;      // 行名文字与行名列左右边界的间距（px）—— 行名列宽 = 实测文字宽 + 2×本值
  var ROW_H_RATIO = 1.18;       // 行高 / 字号（11px → 13px = STAT_ROW_H；大字号下行高随之放大）
  var ROT_LINE_H_RATIO = 1.4;   // 单行标签的竖向墨迹高 ≈ 字号 × 1.4（rotation 的 cos 分量）
  /* 迭代 12（需求 ③）：统计量旋转 —— 合法角度 / 行高余量 / grid.bottom 上限 */
  var STAT_ROTATE_ALLOWED = [0, 30, 45, 60, 90];  // plot.stats.rotate 的合法取值（其它一律按 0）
  var STAT_ROW_PAD = 4;         // 旋转数值行行高 = sinθ·文本宽 + cosθ·字号 + 本余量（px）
  var MAX_GRID_BOTTOM_ROT = 400;// 【迭代 21 起仅作历史常量导出，不再参与计算】旧「封顶」上限
  /* 迭代 13（label ↔ 数值一一对应）常量 */
  var KEPT_GAP = 2;             // 相邻两个 kept 类别（类别名 + 数值共用一个集合）之间要求的最小空隙（px）

  /* --------------------------------------------------------------------------
     迭代 21（需求 ②：横轴长标签必须完整显示）常量
     —— 底部留白 = 轴标签间距 + 标签块高 + 行间距 + 统计行带 + 轴标题带（**相加**）
     旧实现用 MAX_GRID_BOTTOM / MAX_GRID_BOTTOM_ROT 封顶 → 需要值被压小 → 统计行挤进
     标签块、底部越界被裁。新实现**不封顶**，改按容器实际可用高度收敛：
       ① 先缩标签字号（最低 LABEL_FONT_MIN，绝不裁字）
       ② 再放宽绘图区下限到 PLOT_H_HARD
       ③ 仍放不下才减少统计行数（保标签）
     -------------------------------------------------------------------------- */
  var BOTTOM_ROW_GAP = 3;       // 标签块下沿 ↔ 首个统计行上沿的最小间距（px）
  var BOTTOM_TAIL = 6;          // 轴标题底边 ↔ 容器底边的余量（px）
  var PLOT_H_MIN = 120;         // 留白上限必须保证的最小绘图区高度（px，需求原文）
  var PLOT_H_HARD = 40;         // 极矮容器：硬下限（低于此才减少统计行数）——优先保住统计行与标签完整性
  var BOTTOM_RATIO_MAX = 0.55;  // 底部留白上限 = 容器高 × 本比例（需求原文 0.55）
  var LABEL_FONT_MIN = 9;       // 极端拥挤时长标签允许缩到的最小字号（px，绝不裁字）
  var FS_SLIDER_BAND = 30;      // 全屏 dataZoom slider 占用的底部带（height 20 + bottom 4 + 余量）

  /* ------------------------------------------------------------- 小工具 */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v, dft) {
    var n = Number(v);
    return (v === null || v === undefined || v === '' || !isFinite(n)) ? dft : n;
  }
  /** 标签长度：number → 视为长度；string → 其长度；数组 → 最长元素长度 */
  function labelLen(v) {
    if (typeof v === 'number') return isFinite(v) ? Math.max(0, v) : 0;
    if (typeof v === 'string') return v.length;
    if (v && typeof v.length === 'number') {
      var max = 0;
      for (var i = 0; i < v.length; i++) {
        var s = String(v[i] === null || v[i] === undefined ? '' : v[i]);
        if (s.length > max) max = s.length;
      }
      return max;
    }
    return 0;
  }

  /* ------------------------------------------------------ 旋转 / 截断策略 */
  /**
   * 迭代 7：解析 style.xRotate（X 轴旋转角设置）
   *   显式角度（0/30/45/60/90）→ 返回数字（categoryAxis 强制该角度，跳过拥挤度判定）；
   *   'auto' / 缺省 / 空串 / null / 非法值 → 返回 'auto'（走既有 rotatePolicy）。
   *   非枚举数值（如用户手填 20）按「最接近的允许角度」收敛，保证只在 0/30/45/60/90 中取值。
   * @param {object} style 样式对象（可省略）
   * @returns {number|string} 0|30|45|60|90 或 'auto'
   */
  function xRotateOf(style) {
    var v = style ? style.xRotate : undefined;
    if (v === null || v === undefined || v === '') return 'auto';
    if (typeof v === 'string' && v.toLowerCase() === 'auto') return 'auto';
    var n = Number(v);
    if (!isFinite(n)) return 'auto';
    var best = X_ROTATE_ALLOWED[0], bd = Infinity;
    for (var i = 0; i < X_ROTATE_ALLOWED.length; i++) {
      var d = Math.abs(n - X_ROTATE_ALLOWED[i]);
      if (d < bd) { bd = d; best = X_ROTATE_ALLOWED[i]; }
    }
    return best;
  }

  /**
   * 根据类别数与标签长度给出旋转、截断、刻度间隔策略
   * @param {number} catCount     类别数
   * @param {number|string|Array} avgLabelLen 平均标签长度（数字、样例标签或标签数组）
   * @param {{plotWidth?:number, labelPx?:number}} [opts] 迭代 5 抗拥挤补判（可省略）：
   *        plotWidth = 可用绘图宽度（px，缺省 ASSUME_PLOT_W）；
   *        labelPx   = 单条标签（含统计行长行）预估像素宽度。
   *        仅当既有策略给出 0° 且「类别数 × (labelPx + LABEL_GAP) > plotWidth」时才升级为 45°；
   *        不传 opts（既有调用）时行为与迭代 4 完全一致。
   * @returns {{rotate:number, truncate:number, interval:number, hideOverlap:boolean, note:string, widthForced:boolean}}
   */
  function rotatePolicy(catCount, avgLabelLen, opts) {
    opts = opts || {};
    var count = Math.max(0, Math.floor(num(catCount, 0)));
    var len = labelLen(avgLabelLen);
    var rotate = 0, interval = 0, hideOverlap = false, widthForced = false;

    if (count > ROTATE_30_MAX) {
      rotate = 30;
      interval = Math.max(1, Math.ceil(count / TICK_DENSE));   // 每 interval 个刻度显示 1 个
      hideOverlap = true;
    } else if (count > ROTATE_45_MAX) {
      rotate = 30;
    } else if (count > ROTATE_NONE_MAX) {
      rotate = 45;
    } else {
      rotate = 0;
    }

    /* 迭代 5：类别少（≤ ROTATE_NONE_MAX）但「类别数 × 标签预估宽度」超过可用绘图宽度
       → 水平标签必然横向重叠（横轴统计行让标签更宽），补判升级为 45° */
    if (rotate === 0 && count > 0) {
      var availW = num(opts.plotWidth, 0);
      var labelPx = num(opts.labelPx, 0);
      if (availW > 0 && labelPx > 0 && count * (labelPx + LABEL_GAP) > availW) {
        rotate = 45;
        widthForced = true;
      }
    }

    var truncate = 0;
    if (len > 20) truncate = TRUNCATE_2;
    else if (len > TRUNCATE_1) truncate = TRUNCATE_1;

    var parts = ['类别数 ' + count];
    parts.push(rotate === 0 ? '标签水平显示' : ('标签旋转 ' + rotate + '°'));
    if (widthForced) parts.push('标签过宽（类别数 × 标签宽度 > 可用绘图宽度）已旋转避让');
    if (interval > 1) parts.push('刻度间隔 ' + interval + '（每 ' + (interval + 1) + ' 个刻度显示 1 个）');
    if (hideOverlap) parts.push('自动隐藏重叠标签');
    if (truncate) parts.push('标签超过 ' + (truncate === TRUNCATE_2 ? 20 : 8) + ' 字符已截断为 ' + truncate + ' 字符');
    return {
      rotate: rotate, truncate: truncate, interval: interval,
      hideOverlap: hideOverlap, widthForced: widthForced, note: parts.join('，')
    };
  }

  /**
   * 截断标签文本（保留完整值供 tooltip）
   * @param {string} text
   * @param {number} max 最大保留字符数（结果长度 = max + 1，含省略号）
   */
  function truncateLabel(text, max) {
    var s = (text === null || text === undefined) ? '' : String(text);
    var m = Math.floor(num(max, 0));
    if (m <= 0 || s.length <= m) return s;
    return s.slice(0, m) + '…';
  }

  /**
   * X 轴底部留白（grid.bottom）：保证轴标题不压刻度标签
   * @param {number} rotate 旋转角（0/30/45）
   * @param {number} nameGap 标题与轴线的距离
   * @param {number} labelChars 标签最大字符数（截断后）
   * @param {number} fontPx 轴标签字号
   * @param {number} [statRows] 统计行数（每行 +13px，契约 §3.3；不传 = 无统计行，行为与迭代 3 一致）
   */
  function gridBottomFor(rotate, nameGap, labelChars, fontPx, statRows) {
    var charW = fontPx * CHAR_W_RATIO;                          // 中英混排平均字符宽度估算
    var labelPx = Math.min(labelChars, 12) * charW;
    var extent = rotate === 0 ? fontPx * 1.5 : Math.sin(rotate * Math.PI / 180) * labelPx;
    var extra = (num(statRows, 0) > 0) ? Math.floor(num(statRows, 0)) * STAT_ROW_H : 0;
    return Math.round(clamp(nameGap + extent + 6 + extra, 34, 240));
  }

  /* -------------------------------------------------- 迭代 9：横轴表格几何（纯函数） */
  /**
   * 行名 / 数值行的行高（与 chart-builder 同源：11px → 13px = STAT_ROW_H）
   * @param {number} fontPx 轴标签字号
   * @returns {number} 行高（px）
   */
  function rowHFor(fontPx) {
    return Math.round(clamp(num(fontPx, 11) * ROW_H_RATIO, STAT_ROW_H, STAT_ROW_H * 1.6));
  }
  /**
   * 「类别名标签块」在旋转后的竖向占用（px）——数值行与 X 轴标题据此下移。
   *   rotate = 0 → 单行文本块高（字号 × 1.4）；
   *   rotate ≠ 0 → 标签块旋转后的外包高 = 文本宽 × sinθ + 行高 × cosθ
   * （实测：ECharts 把刻度标签块顶端放在轴线下方 AXIS_LABEL_MARGIN 处，本值即该块的高度）。
   * @param {number} rotate 旋转角（0/30/45/60/90）
   * @param {number} labelPx 单行标签（类别名）的像素宽度（实测优先）
   * @param {number} fontPx 轴标签字号
   * @returns {number} 高度（px，已取整）
   */
  function rotatedBlockH(rotate, labelPx, fontPx) {
    var r = num(rotate, 0), lp = Math.max(0, num(labelPx, 0)), f = num(fontPx, 11);
    var lineH = f * ROT_LINE_H_RATIO;
    if (!(r > 0)) return Math.round(lineH);
    var th = r * Math.PI / 180;
    return Math.round(Math.abs(lp * Math.sin(th)) + Math.abs(lineH * Math.cos(th)));
  }

  /* --------------------------- 迭代 28 → N 级：横轴分组行（同一组合并成一个标签） --------------------------- */
  var GROUP_CELL_PAD = 4;        // 分组标签左右留白（px）：组宽 < 文字宽 + 2×本值 → 该组标签转 90°
  var GROUP_ROW_GAP = 2;         // 每条分组带与下方（下一级 / 类别标签块）的间距（px）
  /**
   * **N 级**分组行模型（唯一来源：留白预算 / graphic 绘制 / 数据表格首行三处共用）。
   *
   * 语义（用户红线）：分组层 = X 轴的**除最后一列**之外的所有列。级 0 = 第一列（最外层），
   * 编号递增向内；每级各自成带，一格 = 其 **tuple 前缀**连续相同的全部类别（跨该组全部 bar）。
   * 同一级**统一角度**（取该级最宽的需求）：放得下 → 0°，有一格放不下 → 整级 90°。
   *
   * @param {object} o
   *   o.labels       Array<string> 叶子标签（每个 bar 一个，**不含**任何组名）
   *   o.levelValues  Array<Array<string>> 每一级每个 bar 的值（levelValues[0] = 级 0）
   *   o.plotW        number 绘图区宽度（px）
   *   o.fontPx       number 字号
   *   o.measurePx    function(文本, 字号) → px（缺省按字符宽估算）
   * @returns {null|{levels:Array, h:number, gap:number, band:number, runs:Array, n:number, ...}}
   *   levels[i] = { index, cells:[{label,i0,i1,count,span,textPx,cx,rotate,h}], h, gap, band, rotCount, rotate }
   *   null = 参数不足（无类别 / 级数据长度不符）
   */
  function groupAxisLevels(o) {
    o = o || {};
    var labels = o.labels || [], lv = o.levelValues || [];
    var n = labels.length;
    if (n < 2 || !lv.length) return null;
    var fontPx = num(o.fontPx, 11);
    var plotW = Math.max(1, num(o.plotW, ASSUME_PLOT_W));
    var band = plotW / n;
    var measure = (typeof o.measurePx === 'function') ? o.measurePx : null;
    var lineH = rowHFor(fontPx);
    var pad = GROUP_CELL_PAD, i, L, K, vals;
    for (L = 0; L < lv.length; L++) {
      vals = lv[L];
      if (!vals || vals.length !== n) return null;
    }
    var levels = [], totalBand = 0, maxRun = 0;
    for (L = 0; L < lv.length; L++) {
      /* ① 一格的覆盖范围 = 该级 **tuple 前缀（级 0..L）** 连续相同的全部类别 */
      var runs = [], cur = null, prevKey = null;
      for (i = 0; i < n; i++) {
        var key = '';
        for (K = 0; K <= L; K++) {
          var kv = lv[K][i];
          key += ((kv === null || kv === undefined) ? '' : String(kv)) + '\u0001';
        }
        if (!cur || key !== prevKey) {
          var cv = lv[L][i];
          cur = {
            label: (cv === null || cv === undefined) ? '' : String(cv),
            i0: i, i1: i, count: 0, key: key
          };
          runs.push(cur); prevKey = key;
        }
        cur.i1 = i; cur.count++;
      }
      /* ② 横向几何 + 整级统一角度（该级最宽的需求决定整级 0° / 90°） */
      var needRot = false, widest = 0, r, span, textW;
      for (i = 0; i < runs.length; i++) {
        r = runs[i];
        span = r.count * band;
        textW = measure ? num(measure(r.label, fontPx), 0) : r.label.length * fontPx * CHAR_W_RATIO;
        r.span = Math.round(span * 100) / 100;
        r.textPx = Math.round(textW * 100) / 100;
        r.cx = Math.round((o.plotW ? (band * (r.i0 + r.count / 2)) : 0) * 100) / 100;
        if (textW + pad * 2 > span) needRot = true;
        if (textW > widest) widest = textW;
      }
      var ang = needRot ? 90 : 0;
      var hh = needRot ? Math.max(lineH, Math.ceil(widest) + pad * 2) : lineH;
      var hR = Math.round(hh);
      for (i = 0; i < runs.length; i++) { runs[i].rotate = ang; runs[i].h = hR; }
      levels.push({
        index: L, cells: runs, runs: runs, count: runs.length,
        h: hR, gap: GROUP_ROW_GAP, band: hR + GROUP_ROW_GAP, angle: ang,
        rotCount: (ang > 0 ? runs.length : 0)
      });
      totalBand += hR + GROUP_ROW_GAP;
      if (runs.length > maxRun) maxRun = runs.length;
    }
    return {
      levels: levels, nLevels: levels.length,
      /* 向后兼容字段 = 级 0（单层调用方逐值不变） */
      runs: levels[0].runs, h: levels[0].h, gap: levels[0].gap, rotCount: levels[0].rotCount,
      /* band = **全部级**的带宽之和（底部留白 / 表格行数都按它算） */
      band: totalBand, maxRuns: maxRun,
      n: n, plotW: Math.round(plotW * 100) / 100, bandW: Math.round(band * 100) / 100,
      fontPx: fontPx, lineH: lineH, padded: pad
    };
  }

  /**
   * 单层包装（向后兼容：`groupAxisModel({labels, groupLabels})` 逐值不变）。
   * @returns {null|{runs:Array, h:number, gap:number, band:number, n:number, plotW:number, ...}}
   */
  function groupAxisModel(o) {
    o = o || {};
    var m = groupAxisLevels({
      labels: o.labels, levelValues: [o.groupLabels || []],
      plotW: o.plotW, fontPx: o.fontPx, measurePx: o.measurePx
    });
    if (!m) return null;
    var l0 = m.levels[0];
    /* 每个组都只有 1 个 bar → 没有可合并的东西，保持原样（不额外占一行留白） */
    if (l0.count >= m.n) return null;
    return {
      runs: l0.runs, h: l0.h, gap: l0.gap, band: l0.band,
      n: m.n, plotW: m.plotW, bandW: m.bandW, fontPx: m.fontPx, lineH: m.lineH, padded: m.padded
    };
  }

  /* ------------------------------------ 迭代 12（需求 ③）：统计量旋转几何（纯函数） */
  /**
   * 统计量旋转角归一化：只接受 0 / 30 / 45 / 60 / 90，其它（缺省 / 字符串 / 非法值）一律 0。
   * @param {*} v 任意输入（plot.stats.rotate）
   * @returns {number} 0|30|45|60|90
   */
  function statRotateOf(v) {
    var n = Number(v);
    for (var i = 0; i < STAT_ROTATE_ALLOWED.length; i++) {
      if (n === STAT_ROTATE_ALLOWED[i]) return n;
    }
    return 0;
  }
  /**
   * 统计量数值行的**行带高度**（px）—— 按旋转角由「文本宽 + 字高」算外包尺寸：
   *   θ = 0  → 既有单行行高（rowHFor，11px → 13px，**逐值不变**，回归红线）
   *   θ ≠ 0  → ceil(|sinθ|·maxTextPx + |cosθ|·fontPx + STAT_ROW_PAD)
   *            （θ=90 时 ≈ 文本宽，例如 "91.93" ≈ 30px + 4 = 34）
   * 卡片与全屏共用本函数（全屏字号 +2 时行高随之放大）。
   * @param {number} rotate     旋转角（0/30/45/60/90）
   * @param {number} maxTextPx  该统计量数值文本的最大像素宽度（实测优先）
   * @param {number} fontPx     轴标签字号
   * @returns {number} 行高（px，已取整）
   */
  function statRowHFor(rotate, maxTextPx, fontPx) {
    var r = statRotateOf(rotate);
    var f = num(fontPx, 11);
    if (!(r > 0)) return rowHFor(f);
    var th = r * Math.PI / 180;
    var w = Math.max(0, num(maxTextPx, 0));
    return Math.round(Math.ceil(Math.abs(Math.sin(th)) * w + Math.abs(Math.cos(th)) * f + STAT_ROW_PAD));
  }
  /**
   * 旋转文本的**水平投影宽度**（= ECharts/zrender 旋转后包围盒的宽）：
   *   |w·cosθ| + |h·sinθ|
   * 抽稀按本值判断是否与上一个已绘数值重叠（θ=90 时仅 ≈ 行盒高 13px → 密集类别也能全画）。
   * @param {number} w 未旋转文本宽（px）
   * @param {number} h 未旋转文本行盒高（px，= 行高）
   * @param {number} rotate 旋转角
   */
  function rotBoxW(w, h, rotate) {
    var r = statRotateOf(rotate);
    if (!(r > 0)) return num(w, 0);
    var th = r * Math.PI / 180;
    return Math.abs(num(w, 0) * Math.cos(th)) + Math.abs(num(h, 0) * Math.sin(th));
  }
  /**
   * 旋转文本的**竖向占用**（= 旋转后包围盒的高）：|w·sinθ| + |h·cosθ|
   * 用于校验「行带装得下旋转后的数值」（不裁字）与方框上下边界。
   */
  function rotBoxH(w, h, rotate) {
    var r = statRotateOf(rotate);
    if (!(r > 0)) return num(h, 0);
    var th = r * Math.PI / 180;
    return Math.abs(num(w, 0) * Math.sin(th)) + Math.abs(num(h, 0) * Math.cos(th));
  }

  /* ---------------------------- 迭代 21：横轴底部留白几何（唯一来源） */
  /**
   * 横轴底部留白的**几何模型** —— 卡片 / 全屏 / 全屏重算三条路径共用（一个来源，不可能各算一套）。
   *
   *   grid.bottom = 轴标签间距(AXIS_LABEL_MARGIN)
   *               + 统计行总高(rows × rowH) + 行间距(BOTTOM_ROW_GAP)   ← 统计行独立成带时才计
   *               + 分组带(groupBand)                                  ← 无分组行时为 0
   *               + 标签块高(rotH：旋转块 / 多行块 / 单行)
   *               + 轴标题带(TITLE_GAP + 标题高 + BOTTOM_TAIL)
   *               + 容器附加带(extraBottom：全屏 dataZoom slider)
   *   纵向次序（自上而下，距绘图区下沿越来越远）：
   *     **统计行 → 分组带 → 类别标签块 → 轴标题**
   *
   * 不变式（本文件与 chart-builder 的行锚点同源，故恒成立）：
   *   统计行带顶边（距容器底）= labelTop + groupBand + rowGap + rows×rowH
   *   ⇒ 屏幕坐标：行带顶边 y = 容器高 − bottom + AXIS_LABEL_MARGIN
   *              = 绘图区下沿 + AXIS_LABEL_MARGIN ≥ 绘图区下沿
   *   ⇒ **任何情况下统计行都不侵入绘图区、标签与统计行都不重叠**。
   *
   * 上限（取代迭代 9/12 的 280 / 400「封顶裁字」）：
   *   cap = min(容器高 × BOTTOM_RATIO_MAX, 容器高 − grid.top − PLOT_H_MIN)
   *   放不下时按顺序降级（**绝不裁标签**）：
   *     ① 标签字号逐级缩小，最低 LABEL_FONT_MIN(9px)
   *     ② 绘图区下限从 PLOT_H_MIN(120) 放宽到 PLOT_H_HARD(80)
   *     ③ 减少统计行数（rows 从末尾减，0 = 只显示标签）
   *   容器高度未知（未传 / Node 桩环境）→ 不设上限，返回完整需要值。
   *
   * @param {object} o {
   *   rotate      类别名旋转角（0/30/45/60/90）
   *   statRotate  统计量旋转角（0/30/45/60/90）
   *   statInline  true = 统计行并入刻度标签块（多行标签，等价 rotate=0 且 stats.rotate=0）
   *   statRows    统计行数（请求值）
   *   labelPx     类别名单行像素宽度（实测，fontPx 下）
   *   maxStatPx   统计数值文本最大像素宽度（实测，fontPx 下）
   *   fontPx      标签字号（px）
   *   containerH  容器高度（px；0/缺省 = 未知）
   *   gridTop     绘图区上边距（px，缺省 24）
   *   extraBottom 容器附加带（px，全屏 slider）
   * }
   * @returns {object} 几何（bottom / need / rows / fontPx / rowH / rotH / labelTop / rowsBottom /
   *          nameGap / cap / plotH / shrunkFont / droppedRows …），恒有 bottom ≥ labelTop > 0
   */
  function bottomFit(o) {
    o = o || {};
    var statInline = !!o.statInline;
    var rotate = num(o.rotate, 0);
    var statRotate = statRotateOf(o.statRotate);
    var baseFont = Math.max(1, Math.round(num(o.fontPx, 11)));
    /* 缩小下限：不低于 LABEL_FONT_MIN(9)，但用户本来就设得更小（如 8px）时不再继续缩 */
    var fontFloor = Math.min(baseFont, LABEL_FONT_MIN);
    var labelPx0 = Math.max(0, num(o.labelPx, 0));
    var maxStatPx0 = Math.max(0, num(o.maxStatPx, 0));
    var rowsAll = Math.max(0, Math.floor(num(o.statRows, 0)));
    var cH = num(o.containerH, 0);
    var gTop = Math.max(0, num(o.gridTop, 24));
    var extra = Math.max(0, num(o.extraBottom, 0));
    /* 迭代 28：第二层分组行占的额外高度（0 = 无分组行，逐值不变） */
    var groupBand = Math.max(0, num(o.groupBand, 0));
    var hasH = cH > 0;

    /** 指定字号 / 行数下的一套几何（字号变化时按比例换算实测宽度） */
    function geom(fontPx, rows) {
      var k = fontPx / baseFont;
      var labelPx = labelPx0 * k;
      var maxStatPx = maxStatPx0 * k;
      /* 标签块高：多行标签块 = (行数+1) × 行高；其余 = 旋转块高（rotate=0 时 = 单行墨迹高） */
      var rotH = statInline
        ? Math.round((rows + 1) * STAT_ROW_H)
        : rotatedBlockH(rotate, labelPx, fontPx);
      var rowH = statInline ? Math.round(STAT_ROW_H) : statRowHFor(statRotate, maxStatPx, fontPx);
      var rowGap = (statInline || rows <= 0) ? 0 : BOTTOM_ROW_GAP;
      var titleH = Math.round(fontPx * ROT_LINE_H_RATIO);
      var titleBand = TITLE_GAP + titleH + BOTTOM_TAIL;
      /* 迭代 28：分组行在轴线与标签块之间（labelBand 随之加高，标题自然下移）
         第六轮（轴层通道）：统计行整块搬到**分组带之上** →
           labelGap = 轴标签间距 + 统计行带 + 分组带（= 轴线到类别标签块顶端的距离）
         need 是三者相加的总和，**顺序无关** → grid.bottom 数值逐值不变（只改内部次序）。 */
      var labelBand = AXIS_LABEL_MARGIN + groupBand + rotH;
      var rowsBand = rows > 0 ? (rowGap + rows * rowH) : 0;
      /* 迭代 30（任务 D ①）：横轴参数行 = **X 列序的逆序** → 自上而下 =
         统计行 → 类别标签行（叶子列）→ 分组带（级 N-1 → 级 0，最后一级在**最底部**）。
         故「轴线 → 类别标签块顶端」的距离只含统计行带；分组带已移到标签行**之下**。
         need 仍是三者之和（顺序无关）→ grid.bottom 数值逐值不变。 */
      var labelGap = AXIS_LABEL_MARGIN + rowsBand;
      var need = labelBand + rowsBand + titleBand;
      return {
        fontPx: fontPx, rows: rows, rowH: rowH, rotH: rotH,
        labelPx: labelPx, maxStatPx: maxStatPx, rowGap: rowGap,
        titleH: titleH, titleBand: titleBand, labelBand: labelBand, rowsBand: rowsBand,
        labelGap: labelGap,
        need: need,
        /* 轴标题锚点（距轴线）：与下方块总高同源（顺序无关，故数值不变） */
        nameGap: Math.round(labelBand + rowsBand + TITLE_GAP)
      };
    }

    /* 上限：容器高 × 0.55 且保证绘图区 ≥ PLOT_H_MIN（含全屏 slider 附加带） */
    var cap = Infinity;
    if (hasH) {
      cap = Math.min(cH * BOTTOM_RATIO_MAX, Math.max(0, cH - gTop - PLOT_H_MIN)) - extra;
      if (!isFinite(cap) || cap < 0) cap = 0;
    }
    var g = geom(baseFont, rowsAll);
    var shrunkFont = false, droppedRows = 0;
    /* ① 缩字号（最低 9px，但不低于用户设定值）—— 宁可字号小，也不裁标签 */
    while (hasH && g.need > cap && g.fontPx > fontFloor) {
      g = geom(g.fontPx - 1, g.rows);
      shrunkFont = true;
    }
    /* ② 放宽绘图区下限（120 → 80）：优先保住字号与统计行 */
    if (hasH && g.need > cap) {
      var capHard = Math.min(cH * 0.9, Math.max(0, cH - gTop - PLOT_H_HARD)) - extra;
      if (isFinite(capHard) && capHard > cap) cap = capHard;
    }
    /* ③ 仍放不下 → 从末尾减少统计行（保标签；0 行 = 只显示标签，绝不重叠） */
    while (hasH && !statInline && g.need > cap && g.rows > 0) {
      g = geom(g.fontPx, g.rows - 1);
      droppedRows++;
    }

    var bottom = Math.round(g.need + extra);
    /* 迭代 30（任务 D ①）：labelGap = 轴标签间距 + 统计行带 → 类别标签块**顶**端（距容器底）；
       分组带在标签行之下（最底部 = 级 0 = 第一个 X 列）。 */
    var labelGap = g.labelGap;
    var labelTop = Math.round(bottom - labelGap);
    /* 统计行带（距容器底）：在标签行**之上** → 底边 = 标签块顶端 + 行间距；顶边 = 底边 + rows×rowH */
    var rowsBottom = Math.round(labelTop + (g.rows > 0 ? g.rowGap : 0));
    var rowsTop = Math.round(rowsBottom + g.rows * g.rowH);
    return {
      bottom: bottom, need: Math.round(g.need), extra: extra, cap: isFinite(cap) ? Math.round(cap + extra) : null,
      labelGap: labelGap, labelTop: labelTop,
      rotH: g.rotH, rowH: g.rowH, rowGap: g.rowGap,
      rows: g.rows, rowsAll: rowsAll, droppedRows: droppedRows,
      /* 统计行带底边（紧贴分组带上沿之上）/ 顶边 —— 与 labelTop / rotH 同源，可反推自检 */
      rowsBottom: rowsBottom, rowsTop: rowsTop,
      groupBand: groupBand,
      /* 类别标签块底边（距容器底）：下面只剩轴标题带（+ 容器附加带）；分组带在标签行下方，故再减 groupBand */
      labelBlockBottom: Math.round(labelTop - g.rotH),
      /* 迭代 30：参数行栈最底边（距容器底）= 标签块底边 − 分组带（级 0 = 第一个 X 列在最底部） */
      paramStackBottom: Math.round(labelTop - g.rotH - groupBand),
      /* 迭代 30：轴层通道自上而下的纵向顺序（统计行 → 类别标签行 → 分组带 = X 列逆序） */
      order: 'stat,label,group',
      labelBand: Math.round(g.labelBand), rowsBand: Math.round(g.rowsBand),
      titleBand: Math.round(g.titleBand), titleH: g.titleH,
      nameGap: g.nameGap, fontPx: g.fontPx, labelPx: Math.round(g.labelPx), maxStatPx: Math.round(g.maxStatPx),
      statInline: statInline, statRotate: statRotate, rotate: rotate,
      containerH: Math.round(cH), gridTop: Math.round(gTop),
      plotH: hasH ? Math.round(cH - gTop - bottom) : null,
      shrunkFont: shrunkFont, overflow: hasH ? Math.max(0, Math.round(bottom - (cH - gTop))) : 0,
      /* 不变式自检用（测试与文档引用）：统计行带顶边 − 绘图区下沿 = 轴标签间距 ≥ 7（永不压绘图区） */
      rowClearance: AXIS_LABEL_MARGIN
    };
  }

  /* ------------------------- 迭代 13：统一抽稀集合（label ↔ 数值一一对应） */
  /**
   * 迭代 13：计算「类别名 + 数值」**共用**的 kept 索引集合（唯一来源）。
   *
   * 背景（用户报障：「横轴 label 与数据显示需要对齐」）：类别名原先交给 ECharts 的
   * interval/hideOverlap 按**标签足迹**抽稀，统计数值则由 chart-builder 按**数值足迹**另跑一套贪心，
   * 两套集合不一致 → 出现「有数值没标签 / 有标签没数值」。本函数把两套合成一套：
   * 一个类别只有「它的类别名足迹」与「它的数值足迹（多统计量取最宽投影）」**都不与上一个 kept
   * 类别重叠**时才保留 —— 抽稀粒度取两者较差者（宁可少显示，也不错位）。
   *
   * 足迹公式（与 ECharts/zrender 旋转包围盒一致）：
   *   类别名（旋转 θ）：|w·cosθ| + |h·sinθ|（h = 单行墨迹高 = 字号 × 1.4；θ=90° 时 ≈ 字高）
   *   数值行（旋转 φ）  ：|w·cosφ| + |h·sinφ|（多统计量逐行算，取最大 = 最宽投影）
   *   θ = 0 / φ = 0     ：直接取文本实测宽度
   *
   * @param {object} o {
   *   n          类别数
   *   labels     Array<string> 类别名（已截断，即真正显示的文本）
   *   numTexts   Array<Array<string>> 每个类别的数值行文本（null / 空 = 该类别无值）
   *   fontSize   轴标签字号（px）
   *   rotate     类别名旋转角（0/30/45/60/90）
   *   statRotate 统计量旋转角（0/30/45/60/90）
   *   labelLineH 单行类别名的行盒高（缺省 字号 × 1.4）
   *   statLineH  数值行未旋转的行盒高（缺省 rowHFor(字号)）
   *   centerOf   function(i) → 类别 i 的像素中心 x（缺省由 gridLeft + band 推导）
   *   gridLeft / band  缺省中心推导参数
   *   leftBound / rightBound  允许绘制区间（缺省 -∞ / +∞）
   *   gap        相邻两个 kept 类别之间要求的最小空隙（px，缺省 KEPT_GAP = 2）
   *   requireValue true = 没有数值的类别也不保留（标签与数值严格一一对应）
   *   measurePx  function(text, fontPx) → 实测像素宽（缺省按字符数估算）
   * }
   * @returns {{kept:boolean[], indices:number[], count:number,
   *            labelFoot:number[], valueFoot:number[], gap:number}}
   */
  function keptIndices(o) {
    o = o || {};
    var n = Math.max(0, Math.floor(num(o.n, 0)));
    var labels = o.labels || [];
    var numTexts = o.numTexts || null;
    var fontPx = num(o.fontSize, 11);
    var rotate = num(o.rotate, 0);
    var statRotate = statRotateOf(o.statRotate);
    var labelLineH = num(o.labelLineH, fontPx * ROT_LINE_H_RATIO);
    var statLineH = num(o.statLineH, rowHFor(fontPx));
    var measure = (typeof o.measurePx === 'function') ? o.measurePx : null;
    var charW = fontPx * CHAR_W_RATIO;
    function px(s) {
      var str = (s === null || s === undefined) ? '' : String(s);
      if (measure) {
        var mv = measure(str, fontPx);
        if (typeof mv === 'number' && isFinite(mv) && mv >= 0) return mv;
      }
      return str.length * charW;
    }
    var th = rotate * Math.PI / 180;
    var cosR = Math.abs(Math.cos(th)), sinR = Math.abs(Math.sin(th));
    var gl = num(o.gridLeft, 0), band = num(o.band, 0);
    var cxOf = (typeof o.centerOf === 'function') ? o.centerOf
      : function (i) { return gl + (i + 0.5) * band; };
    var lo = num(o.leftBound, -Infinity), hi = num(o.rightBound, Infinity);
    var gap = Math.max(0, num(o.gap, KEPT_GAP));
    var needValue = !!o.requireValue;
    var kept = new Array(n), indices = [];
    var labelFoot = new Array(n), valueFoot = new Array(n);
    var prevR = null, i, k;
    for (i = 0; i < n; i++) {
      kept[i] = false; labelFoot[i] = 0; valueFoot[i] = 0;
      /* ① 类别名足迹 */
      var lw = px(labels[i]);
      var lf = (rotate > 0) ? (lw * cosR + labelLineH * sinR) : lw;
      labelFoot[i] = Math.round(lf * 100) / 100;
      /* ② 数值足迹（多统计量取最宽投影） */
      var vf = 0, parts = (numTexts && numTexts[i]) ? numTexts[i] : null;
      if (parts) {
        for (k = 0; k < parts.length; k++) {
          var pw = px(parts[k]);
          var pf = (statRotate > 0) ? rotBoxW(pw, statLineH, statRotate) : pw;
          if (pf > vf) vf = pf;
        }
      }
      valueFoot[i] = Math.round(vf * 100) / 100;
      /* ③ 判定：没有数值（标签也就不显示，保证一一对应）→ 跳过 */
      if (needValue && !(vf > 0)) continue;
      var foot = Math.max(lf, vf);
      if (!(foot > 0)) continue;
      var cx = cxOf(i);
      if (typeof cx !== 'number' || !isFinite(cx)) continue;
      var l = cx - foot / 2, r = cx + foot / 2;
      /* ④ 越出绘图区 → 不保留（数值绝不越框、不压轴标题） */
      if (l < lo || r > hi) continue;
      /* ⑤ 与上一个 kept 类别重叠 → 跳过（宁可少显示） */
      if (prevR !== null && l < prevR + gap) continue;
      kept[i] = true; indices.push(i); prevR = r;
    }
    return {
      kept: kept, indices: indices, count: indices.length,
      labelFoot: labelFoot, valueFoot: valueFoot, gap: gap
    };
  }

  /* ------------------------------------------------------------ 类别轴 */
  /**
   * 生成 X 类别轴配置 + grid.bottom
   * @param {Array<{label:string}>} cats 类别（已排序/已合并）
   * @param {{axisName?:string, style?:object, decimals?:number, timeStyle?:string,
   *          formatter?:Function, statLines?:Array<string>, plotWidth?:number}} opts
   *        statLines：每个类别附带的统计行文本（多行用 '\n' 连接）——迭代 4 横轴统计行（§3.3）；
   *        第 1 行仍是类别名（沿用原有截断/旋转策略）；不传该参数时与迭代 3 完全一致
   *        plotWidth：可用绘图宽度（px，迭代 5 抗拥挤补判；缺省 ASSUME_PLOT_W=520）
   *        style.xRotate（迭代 7）：0/30/45/60/90 = 强制该旋转角（跳过拥挤度判定）；
   *        'auto' 或缺省 = 迭代 6 的自动策略
   * @returns {{xAxis:object, gridBottom:number, policy:object, labels:string[],
   *           rawLabels:string[], statRows:number}}
   */
  function categoryAxis(cats, opts) {
    opts = opts || {};
    var style = opts.style || {};
    /* 迭代 28：第二层分组行（同一组只画一个居中标签）—— h=0 时全路径逐值不变 */
    var gRow = opts.groupRow || null;
    var groupH = (gRow && num(gRow.h, 0) > 0) ? Math.round(num(gRow.h, 0)) : 0;
    var groupGap = (groupH > 0) ? Math.max(0, Math.round(num(gRow.gap, 3))) : 0;
    var groupBand = groupH + groupGap;
    var list = cats || [];
    var rawLabels = new Array(list.length);
    var maxLen = 0, sumLen = 0, i;
    for (i = 0; i < list.length; i++) {
      var t = (list[i] && list[i].label !== undefined && list[i].label !== null) ? String(list[i].label) : '';
      rawLabels[i] = t;
      if (t.length > maxLen) maxLen = t.length;
      sumLen += t.length;
    }
    var avg = list.length ? (sumLen / list.length) : 0;

    /* 横轴统计行（迭代 4）：额外行数 = 每类统计行文本的最大行数；
       迭代 5：同时取「最长单行字符数」，把统计行文本宽度计入旋转与留白估算
       迭代 6：statLines 只含**数值**（名称移到左置表头 statHeader） */
    var statLines = opts.statLines || null;
    var statRows = 0, statChars = 0;
    if (statLines && statLines.length) {
      for (i = 0; i < statLines.length; i++) {
        var sl = String(statLines[i] === null || statLines[i] === undefined ? '' : statLines[i]);
        if (sl === '') continue;
        var slParts = sl.split('\n');
        if (slParts.length > statRows) statRows = slParts.length;
        for (var q = 0; q < slParts.length; q++) {
          if (slParts[q].length > statChars) statChars = slParts[q].length;
        }
      }
    }

    /* 左置统计表头（迭代 6 · C）：行数与文字由 chart-builder 给出（第 1 行 = X 轴列名） */
    var statHeader = (opts.statHeader && opts.statHeader.length) ? opts.statHeader : null;

    var fontSize = num(style.xAxisFontSize, 11);
    var charW = fontSize * CHAR_W_RATIO;
    var truncate = maxLen > 20 ? TRUNCATE_2 : (maxLen > TRUNCATE_1 ? TRUNCATE_1 : 0);
    var labels = rawLabels;
    if (truncate) {
      labels = new Array(rawLabels.length);
      for (i = 0; i < rawLabels.length; i++) labels[i] = truncateLabel(rawLabels[i], truncate);
    }
    var labelChars = truncate ? truncate + 1 : maxLen;              // 类别名（截断后）最长字符数
    var estChars = Math.max(labelChars, statChars);                 // 最长单行（含统计行）字符数 → 宽度估算
    /* 迭代 12（需求 ③）：统计量旋转角（0 = 不旋转，与迭代 9 逐值一致） */
    var statRotate = statRotateOf(opts.statRotate);
    /* 迭代 9：文本像素宽度测量 —— chart-builder 传 canvas measureText（实测值），
       无测量回调（Node 桩环境）时回退「字符数 × 平均字符宽」估算 */
    var measure = (typeof opts.measurePx === 'function') ? opts.measurePx : null;
    function pxOf(s) {
      var str = (s === null || s === undefined) ? '' : String(s);
      if (measure) {
        var mv = measure(str, fontSize);
        if (typeof mv === 'number' && isFinite(mv) && mv >= 0) return mv;
      }
      return str.length * charW;
    }

    /* 旋转策略：既有「类别数」判定 + 迭代 5「类别数 × 标签预估宽度 vs 可用绘图宽度」补判
       迭代 6：统计行把标签变成「多行文本块」，宽度按该块**旋转 45° 后的横向投影**估算
       （块越高，旋转后越宽）；statRows === 0 时与迭代 5 逐值一致（回归红线） */
    var labelPxForRotate = Math.min(estChars, TRUNCATE_2) * charW;
    if (statRows > 0) {
      var blkLineH = fontSize * 1.4;
      var blkH = (statRows + 1) * blkLineH;
      var blkW = estChars * charW;
      labelPxForRotate = 0.7071 * (blkW + blkH);
    }
    /* 迭代 7：显式旋转角（style.xRotate = 0/30/45/60/90）强制生效，**不再跑自动拥挤度判定**；
       'auto'（或字段缺省）→ 迭代 6 的既有 rotatePolicy（回归红线：逐值一致）。 */
    var xRotate = xRotateOf(style);
    var policy;
    if (xRotate === 'auto') {
      policy = rotatePolicy(list.length, Math.max(avg, maxLen > 20 ? maxLen : 0), {
        plotWidth: num(opts.plotWidth, ASSUME_PLOT_W),
        labelPx: labelPxForRotate
      });
      policy.truncate = truncate;
      policy.fixedRotate = false;
    } else {
      /* 显式角度：interval / hideOverlap 交给下方「几何驱动」统一处理（不在此判定拥挤度） */
      policy = {
        rotate: xRotate, truncate: truncate, interval: 0,
        hideOverlap: false, widthForced: false, fixedRotate: true,
        note: '固定旋转角 ' + xRotate + '°（设置项 X 轴旋转 ≠ 自动，跳过拥挤度判定）'
      };
    }

    var weight = style.xAxisFontWeight || 'normal';
    var color = style.xAxisColor || '#4a5866';
    var centered = style.xTitleCentered !== false;                 // 默认居中（契约）
    var nameGap = NAME_GAP[policy.rotate] !== undefined ? NAME_GAP[policy.rotate] : NAME_GAP[0];
    if (!centered) nameGap = 8;                                    // 标题贴轴右端时不占下方空间

    /* 迭代 21：旋转非零 → 类别名**完整显示**（不再截断成 12/16 字符 + '…'）。
       空间由下方 bottomFit() 给出的 grid.bottom 提供（宁可把绘图区向上压，也不裁标签）；
       rotate === 0 保留既有截断策略（水平标签截断防横向挤压，回归红线）。 */
    if (policy.rotate !== 0 && truncate) {
      labels = rawLabels;
      truncate = 0;
      labelChars = maxLen;
      policy.truncate = 0;
      policy.note += '；长标签完整显示（旋转 ' + policy.rotate + '°，向上延伸）';
    }

    /* 迭代 9 · A：旋转非零且启用统计行 → 刻度标签只写类别名，统计数值改由 graphic
       水平逐行绘制在旋转标签块**下方**（见 chart-builder.axisTableLayout）。
       rotate === 0 一律保持迭代 4~8 的既有行为（多行标签整体摆放，回归红线）。
       迭代 12（需求 ③）：**统计量自身旋转**（statRotate ≠ 0）时同样必须走 graphic —— 多行刻度标签
       只有一个夹角，装不下「类别名角度」与「数值角度」两种角度。 */
    var statMode = (statRows > 0 && (policy.rotate !== 0 || statRotate !== 0)) ? 'graphic' : 'axis';
    /* 单行类别名（截断后）的像素宽度：旋转后「类别名标签块」的竖向占用由它决定 */
    var labelPxSingle = labelChars * charW;
    if (measure && statRows > 0) {
      var mpx = 0;
      for (i = 0; i < labels.length; i++) {
        var wp = pxOf(labels[i]);
        if (wp > mpx) mpx = wp;
      }
      if (mpx > 0) labelPxSingle = mpx;
    }

    /* 迭代 5：统计行把刻度标签变成「多行文本块」。旋转后该文本块的竖向占用
       （块宽·sinθ + 块高·cosθ）远大于单行，标题若仍按 NAME_GAP 常量摆放会被标签盖住 ——
       故按需把 nameGap 推到文本块之下（grid.bottom 随之加大，保证与 X 轴标题不重叠）。
       无统计行时（statRows === 0）nameGap 与 grid.bottom 与迭代 4 逐值一致（回归红线）。 */
    /* 迭代 12：统计数值文本的最大像素宽度（旋转数值行行高 / 抽稀投影宽度都要用） */
    var maxStatPx = 0;
    if (statRows > 0 && statLines) {
      for (i = 0; i < statLines.length; i++) {
        var slp = String(statLines[i] === null || statLines[i] === undefined ? '' : statLines[i]).split('\n');
        for (var q2 = 0; q2 < slp.length; q2++) {
          var wp2 = pxOf(slp[q2]);
          if (wp2 > maxStatPx) maxStatPx = wp2;
        }
      }
    }
    /* 统计量数值行的行带高度：θ=0 → rowHFor（13，逐值不变）；θ≠0 → sinθ·宽 + cosθ·字号 + 4 */
    var statRowH = statRowHFor(statRotate, maxStatPx, fontSize);
    if (statRows > 0) {
      if (statMode === 'graphic') {
        /* 迭代 9：标签块只含类别名（单行）；数值行（statRows 行 × 行高）在其下方，
           X 轴标题再往下一档 → nameGap = 轴标签间距 + 旋转块高 + 数值行高 + 标题留距
           迭代 12：数值行行高改由 statRowHFor(statRotate) 给出（statRotate=0 时 === rowHFor） */
        var rotHg = rotatedBlockH(policy.rotate, labelPxSingle, fontSize);
        nameGap = Math.round(AXIS_LABEL_MARGIN + rotHg + statRows * statRowH + TITLE_GAP);
        /* 每格可用宽度 < 标签水平包围盒 → 标签必然互相重叠 → 交给 ECharts 隐藏重叠标签 */
        var slotG = num(opts.plotWidth, ASSUME_PLOT_W) / Math.max(1, list.length);
        var footG = policy.rotate === 0 ? labelPxSingle
          : (Math.abs(labelPxSingle * Math.cos(policy.rotate * Math.PI / 180)) +
             Math.abs(fontSize * 1.4 * Math.sin(policy.rotate * Math.PI / 180)));
        if (footG > slotG) policy.hideOverlap = true;
      } else {
        var lineH = fontSize * 1.4;
        var blockH = (statRows + 1) * lineH;                       // 类别行 + 统计行
        var blockW = estChars * charW;
        var theta = policy.rotate * Math.PI / 180;
        var occupy = policy.rotate === 0 ? blockH
          : (blockW * Math.sin(theta) + blockH * Math.cos(theta)); // 旋转后文本块竖向占用
        nameGap = Math.max(nameGap, Math.round(occupy + 6));
        /* 每格可用宽度 < 文本块水平包围盒 → 标签必然互相重叠 → 交给 ECharts 隐藏重叠标签 */
        var slot = num(opts.plotWidth, ASSUME_PLOT_W) / Math.max(1, list.length);
        var foot = policy.rotate === 0 ? blockW
          : (blockW * Math.cos(theta) + blockH * Math.sin(theta));
        if (foot > slot) policy.hideOverlap = true;
      }
    }
    var gridBottom;
    /* 迭代 21：两条路径（互相排斥）
       ① **多行标签路径**（rotate=0 且统计量不旋转）：标签块本身就含统计行，沿用迭代 4~19 的
          gridBottomFor 公式 —— 逐值不变（回归红线；iter9 E2 基线即此路径）。
       ② **统计行独立成带**（旋转 / 统计量旋转）：bottomFit() 相加并**按容器实际高度收敛**：
            轴标签间距 + 标签块高 + 行间距 + 统计行带 + 轴标题带(+ 全屏 slider 带)
          放不下时 ① 缩标签字号（≥ 9px）② 放宽绘图区下限 ③ 减少统计行数 —— 绝不裁标签。
       行锚点由 chart-builder.axisTableLayout 用**同一组常量**推导（行上沿 = 绘图区下沿 +
       rotH + 轴标签间距 + 行间距），故标签与统计行不可能重叠。 */
    var inlineMode = (policy.rotate === 0 && statRotate === 0);
    var fit;
    if (inlineMode) {
      gridBottom = gridBottomFor(policy.rotate, nameGap, estChars, fontSize, statRows) + groupBand;
      /* 伪几何（header / chart-builder 读同一批字段；数值与旧公式严格一致） */
      var inLabelGap = AXIS_LABEL_MARGIN + groupBand;
      var inLabelTop = gridBottom - inLabelGap;
      var inBlockH = (statRows + 1) * STAT_ROW_H;
      fit = {
        bottom: gridBottom, need: gridBottom, extra: 0, cap: null,
        labelGap: inLabelGap, labelTop: inLabelTop,
        rotH: inBlockH, rowH: statRowH, rowGap: 0,
        rows: statRows, rowsAll: statRows, droppedRows: 0,
        rowsBottom: inLabelTop - inBlockH, rowsTop: inLabelTop - 0,
        labelBand: inLabelGap + inBlockH, rowsBand: 0,
        titleBand: gridBottom - inLabelTop, titleH: Math.round(fontSize * ROT_LINE_H_RATIO),
        nameGap: nameGap, fontPx: fontSize, labelPx: Math.round(labelPxSingle),
        maxStatPx: Math.round(maxStatPx), statInline: true, statRotate: statRotate, rotate: 0,
        containerH: num(opts.containerH, 0), gridTop: num(opts.gridTop, 24), plotH: null,
        groupBand: groupBand,
        shrunkFont: false, overflow: 0, rowClearance: inLabelGap
      };
    } else {
      fit = bottomFit({
        statInline: (statMode === 'axis' && statRows > 0),
        rotate: policy.rotate, statRotate: statRotate,
        statRows: statRows, labelPx: labelPxSingle, maxStatPx: maxStatPx, fontPx: fontSize,
        containerH: num(opts.containerH, 0), gridTop: num(opts.gridTop, 24),
        extraBottom: num(opts.extraBottom, 0), groupBand: groupBand
      });
      gridBottom = fit.bottom;
      nameGap = fit.nameGap;                     // X 轴标题锚点：统计行带之下（不压数值）
    }
    var labelFont = fit.fontPx;                  // 容器太矮时按比例缩小（≥ LABEL_FONT_MIN = 9）
    var statRowsAll = statRows;                  // 请求的统计行数（降级前）
    statRows = fit.rows;                         // 实际绘制行数（容器实在太矮才会减少）
    statRowH = fit.rowH;                         // 与 bottomFit 同源的行带高

    /* 迭代 6：左置统计表头几何 —— 与刻度标签同字号同行高（逐行对齐）；
       位置用「距容器左边缘 rightX / 距容器底边 bottom」表达，无需知道容器尺寸。
       迭代 9 · B：行名列宽改为「行名文字实测宽度 + 内边距」（chart-builder 传 statHeaderWidth，
       缺省回退字符估算）→ 'Mean' 不再被行名列分隔线裁切；数值行改由 graphic 绘制时，
       bottom 锚到数值块底边（左列底边），方框上边则由标签块顶端决定。 */
    var header = null;
    if (statHeader) {
      var hRows = statHeader.length, hMaxChars = 0;
      for (i = 0; i < hRows; i++) {
        var hs = (statHeader[i] === null || statHeader[i] === undefined) ? '' : String(statHeader[i]);
        if (hs.length > hMaxChars) hMaxChars = hs.length;
      }
      var hWIn = measure ? 0 : Math.ceil(hMaxChars * charW);
      var hW = hWIn;
      if (measure) {
        var hmpx = 0;
        for (i = 0; i < hRows; i++) {
          var hp = pxOf(statHeader[i]);
          if (hp > hmpx) hmpx = hp;
        }
        hW = Math.round(hmpx > 0 ? hmpx : hMaxChars * charW);
      }
      var hColW = hW + HEADER_TEXT_PAD * 2;                        // 行名列总宽 = 文字宽 + 两侧内边距
      var hRowH = statRowH;                                        // 迭代 12：数值行行高（含统计量旋转）
      var hLabelTop = fit.labelTop;                                // 标签块顶端（距容器底）
      var hRotH = fit.rotH;
      /* 迭代 21：左列 / 数值块底边 = 行带底边（轴标题带之上）—— 与 bottomFit 同源 */
      var hBottom = (statMode === 'graphic')
        ? fit.rowsBottom
        : (hLabelTop - hRows * STAT_ROW_H);
      header = {
        text: statHeader.join('\n'),
        rows: hRows,
        fontSize: labelFont,
        lineHeight: (statMode === 'graphic') ? hRowH : STAT_ROW_H,
        width: hW,
        colW: hColW,
        statMode: statMode,
        rotate: policy.rotate,
        rowH: hRowH,
        rotH: hRotH,
        /* 迭代 12：统计量旋转角（与 X 轴旋转角 rotate 完全独立） */
        statRotate: statRotate,
        statRowH: statRowH,
        maxStatPx: Math.round(maxStatPx),
        labelPx: Math.round(labelPxSingle),
        labelTop: hLabelTop,
        /* 迭代 21：实际绘制的统计行数 / 请求行数 / 是否因容器太矮缩过字号（供自测与文档） */
        statRowsShown: statRows,
        statRowsAll: statRowsAll,
        shrunkFont: fit.shrunkFont,
        /* 表头文本块的左/右边界（距容器左边缘）：块内各行右对齐（graphic style.textAlign:'right'），
           故整块右边界 ≈ leftX + colW —— 与网格左侧预留区 [0, gridLeftExtra] 严格吻合 */
        leftX: HEADER_PAD,
        rightX: HEADER_PAD + hColW,
        bottom: Math.max(0, hBottom),
        gridLeftExtra: hColW + HEADER_PAD
      };
    }

    /* 迭代 6 · B：标签由几何决定 —— 取消固定索引抽稀（仅 > TICK_DENSE_HARD 类才退回），
       并一律开启 hideOverlap，保证「显示出来的标签 = 其正下方 Box 的标签」且缩放自适应 */
    var labelInterval = (list.length > TICK_DENSE_HARD)
      ? Math.max(1, Math.ceil(list.length / TICK_DENSE_HARD))
      : 'auto';

    var axisLabel = {
      rotate: policy.rotate,
      interval: labelInterval,
      hideOverlap: true,
      color: color,
      fontSize: labelFont,                   // 迭代 21：容器太矮时按比例缩小（≥ 9px），不裁字
      fontWeight: weight,
      margin: (fit && num(fit.labelGap, 0) > 0) ? Math.round(num(fit.labelGap, 0)) : AXIS_LABEL_MARGIN,
      showMinLabel: true,
      showMaxLabel: true
    };
    /* 多行标签显式设行高：与左置表头逐行对齐（同一 STAT_ROW_H = 13px） */
    if (statRows > 0) axisLabel.lineHeight = STAT_ROW_H;

    var xAxis = {
      type: 'category',
      name: opts.axisName || '',
      nameLocation: centered ? 'middle' : 'end',
      nameGap: nameGap,
      nameTextStyle: { color: color, fontSize: labelFont, fontWeight: weight, align: centered ? 'center' : 'right' },
      data: labels,
      boundaryGap: true,
      axisLabel: axisLabel,
      axisTick: { alignWithLabel: true, show: true, lineStyle: { color: '#c2cad2' } },
      axisLine: { show: true, lineStyle: { color: '#b6c0c9' } },
      splitLine: { show: style.showGrid !== false, lineStyle: { color: '#e9edf0', type: 'solid' } },
      axisPointer: { show: true }
    };
    if (statRows > 0) {
      /* 多行刻度标签：类别名 + 统计行；索引越界/异常一律回退原值（零未捕获异常）
         迭代 9 · A：statMode === 'graphic'（旋转非零）时刻度标签**只写类别名**
         —— 统计数值已改由 graphic 水平逐行绘制，不再跟着标签一起旋转
         迭代 13：ECharts 5.6 在「函数型 interval / 抽稀 / dataZoom」时把 formatter 的第二参
         传成**窗口内序号**（`makeLabelFormatter` 里 `idx = tick.value − scale.getExtent()[0]`）——
         缩放后它与数据索引不等，`labels[idx]` 会取到别的类别（实测：cat6 位置显示 cats[0]）。
         这里改用「显示文本 → 数据索引」反查（类别名唯一时成立），保证标签与数值始终指向同一类别。 */
      var labelIdxMap = null;
      (function () {
        var m = {}, dup = false, ix;
        for (ix = 0; ix < labels.length; ix++) {
          var kx = String(labels[ix]);
          if (m[kx] !== undefined) { dup = true; break; }
          m[kx] = ix;
        }
        if (!dup) labelIdxMap = m;
      })();
      function realIndex(value, idx) {
        var hit = labelIdxMap ? labelIdxMap[String(value)] : undefined;
        if (typeof hit === 'number' && hit >= 0 && hit < labels.length) return hit;
        if (typeof idx === 'number' && idx >= 0 && idx < labels.length) return idx;
        return null;
      }
      var onlyName = (statMode === 'graphic');
      xAxis.axisLabel.formatter = function (value, idx) {
        var ri = realIndex(value, idx);
        var base;
        if (ri !== null) base = labels[ri];
        else base = value;
        if (onlyName) return (base === null || base === undefined) ? '' : String(base);
        var extra = '';
        if (ri !== null && ri < statLines.length) {
          extra = (statLines[ri] === null || statLines[ri] === undefined) ? '' : String(statLines[ri]);
        }
        base = (base === null || base === undefined) ? '' : String(base);
        return extra ? (base + '\n' + extra) : base;
      };
    } else if (typeof opts.formatter === 'function') {
      xAxis.axisLabel.formatter = opts.formatter;
    }
    return {
      xAxis: xAxis, gridBottom: gridBottom, policy: policy,
      labels: labels, rawLabels: rawLabels, statRows: statRows, header: header,
      /* 迭代 9：统计数值的绘制归属（'axis' = 跟刻度标签一起；'graphic' = 水平/按角度 graphic） */
      statMode: statMode, labelPx: Math.round(labelPxSingle),
      /* 迭代 28：第二层分组行（h=0 表示未启用） */
      groupRowH: groupH, groupGap: groupGap, groupBand: groupBand,
      labelGap: (fit && num(fit.labelGap, 0) > 0) ? Math.round(num(fit.labelGap, 0)) : AXIS_LABEL_MARGIN,
      /* 迭代 12：统计量旋转角 + 数值行行高 + 数值文本最大宽度（chart-builder 同源消费） */
      statRotate: statRotate, statRowH: statRowH, maxStatPx: Math.round(maxStatPx), nameGap: nameGap,
      /* 迭代 21：底部留白几何（chart-builder / 全屏重算按容器实际高度再算一次 → 覆盖这些值） */
      fontPx: fontSize, labelFont: labelFont, statRowsAll: statRowsAll,
      bottomFit: fit, truncated: truncate > 0
    };
  }

  /* ------------------------------------------- 迭代 15：Y 轴留白（刻度实测宽） */
  /* 文本量测上下文（只建一次；无 DOM 的 Node 桩环境自动退化为字符宽度估算） */
  var _measureCtx = null, _measureTried = false;
  var MEASURE_FONT_FAMILY = 'sans-serif';   // 与 ECharts 默认 textStyle.fontFamily 一致
  function measureCtx() {
    if (_measureTried) return _measureCtx;
    _measureTried = true;
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        var cv = document.createElement('canvas');
        _measureCtx = (cv && cv.getContext) ? cv.getContext('2d') : null;
      }
    } catch (e) { _measureCtx = null; }
    return _measureCtx;
  }
  /**
   * 文本像素宽度（优先 canvas measureText 实测，与 ECharts 同字体族；无 DOM 时按字符宽度估算）
   * @param {string} s 文本
   * @param {number} fontPx 字号
   * @returns {number} 宽度（px）
   */
  function textPx(s, fontPx) {
    var str = (s === null || s === undefined) ? '' : String(s);
    if (!str) return 0;
    var px = num(fontPx, 11);
    var ctx = measureCtx();
    if (ctx && typeof ctx.measureText === 'function') {
      var w = 0;
      try {
        ctx.font = px + 'px ' + MEASURE_FONT_FAMILY;
        w = ctx.measureText(str).width;
      } catch (e) { w = 0; }
      if (isFinite(w) && w > 0) return w;
    }
    /* 回退估算：CJK / 全角按 1.0×字号，其余按 CHAR_W_RATIO×字号 */
    var sum = 0;
    for (var i = 0; i < str.length; i++) {
      sum += (str.charCodeAt(i) > 0x2E7F ? 1 : CHAR_W_RATIO) * px;
    }
    return sum;
  }
  /** 刻度标签文本（与 valueAxis 的 formatter 同源：显式小数位 → fmtNumber(d)，自动 → 去尾零） */
  function tickLabelText(v, decimals, isTime, timeStyle) {
    if (isTime) return (T && typeof T.formatTime === 'function') ? T.formatTime(v, timeStyle || 'datetime') : String(v);
    if (decimals !== null && decimals !== undefined && decimals !== '') {
      return YMS.util.fmtNumber(v, clamp(Math.floor(num(decimals, 0)), 0, 8));
    }
    return YMS.util.fmtNumber(v, null);
  }
  /**
   * 该数值轴「实际会显示」的刻度值（与 ECharts value/log 轴一致）：
   *   · 有 interval → 自 min 起按 interval 递增（末位补 max 标签）
   *   · 无 interval（ECharts 自选分割数）→ 按 4 段估算
   *   · 对数轴 → 10 的整数次幂 + 两端点
   * @param {object} axis ECharts 轴配置
   * @returns {number[]} 刻度值（最多 60 个）
   */
  function tickValuesOf(axis) {
    var min = num(axis && axis.min, NaN), max = num(axis && axis.max, NaN);
    var out = [], i, v;
    if (!isFinite(min) || !isFinite(max) || !(max > min)) return out;
    if (axis.type === 'log') {
      var base = num(axis.logBase, 10);
      if (!(base > 1)) base = 10;
      for (i = -6; i <= 12; i++) {
        v = Math.pow(base, i);
        if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) out.push(v);
        if (out.length > 24) break;
      }
      out.push(min);
      out.push(max);
      return out;
    }
    var step = num(axis.interval, NaN);
    if (!(step > 0)) step = niceStep((max - min) / 4);
    if (!(step > 0) || !isFinite(step)) step = 1;
    for (i = 0; i < 60; i++) {
      v = roundSig(min + i * step);
      if (v > max + Math.abs(step) * 1e-6) break;
      out.push(v);
    }
    if (!out.length) out.push(min);
    if (out[out.length - 1] < max - Math.abs(step) * 1e-6) out.push(max);
    /* 两端点始终量一遍：负号 / 小数位在量级端点处通常最宽 */
    out.push(min);
    out.push(max);
    return out;
  }
  /**
   * 迭代 15（需求 ②）：按「刻度文本实测最大宽度 + 标题宽度 + 间距」推导该数值轴占用的留白，
   * 并同步把 nameGap 推到「不压刻度」的位置（ECharts 的标题右缘 = 轴线 − nameGap）。
   *   nameGap  = max(Y_NAME_GAP_MIN, margin + tickMaxPx + Y_NAME_TICK_GAP)
   *   gridPad  = clamp(nameGap + titlePx + Y_TITLE_PAD, GRID_LEFT_MIN, GRID_LEFT_MAX)
   * @param {object} axis ECharts 数值轴配置（会被写回 nameGap）
   * @param {{decimals?:number|string, isTime?:boolean, timeStyle?:string, tickTexts?:string[]}} [opts]
   * @returns {{pad:number, gridLeft:number, gridRight:number, nameGap:number,
   *            tickMaxPx:number, titlePx:number, tickText:string}}
   */
  function axisPad(axis, opts) {
    opts = opts || {};
    if (!axis || typeof axis !== 'object') {
      return { pad: GRID_LEFT_MIN, gridLeft: GRID_LEFT_MIN, gridRight: Y_GRID_RIGHT_MIN, nameGap: Y_NAME_GAP_MIN, tickMaxPx: 0, titlePx: 0, tickText: '' };
    }
    var isRight = axis.position === 'right';
    var fontPx = num(axis.axisLabel && axis.axisLabel.fontSize, 11);
    var margin = num(axis.axisLabel && axis.axisLabel.margin, Y_TICK_MARGIN);
    var showTitle = !!(axis.name && String(axis.name) !== '');
    /* 竖排标题的横向占用 = 一行文字的行高 ≈ 字号 × 1.2（实测 ECharts 文本 bbox 宽 = 字号 ~ 1.1×） */
    var titlePx = showTitle ? Math.ceil(fontPx * TITLE_W_RATIO) : 0;
    /* ① 收集该轴实际会显示的刻度文本（opts.tickTexts 优先：调用方已知精确文本时直接量） */
    var texts = [];
    var i;
    if (opts.tickTexts && opts.tickTexts.length) {
      for (i = 0; i < opts.tickTexts.length; i++) texts.push(String(opts.tickTexts[i]));
    } else {
      var vals = tickValuesOf(axis);
      for (i = 0; i < vals.length; i++) texts.push(tickLabelText(vals[i], opts.decimals, opts.isTime, opts.timeStyle));
    }
    /* ② 实测最大宽度（+1px 安全余量：ECharts 文本量测与 canvas 有亚像素差） */
    var tickMaxPx = 0, tickText = '';
    for (i = 0; i < texts.length; i++) {
      var w = textPx(texts[i], fontPx);
      if (w > tickMaxPx) { tickMaxPx = w; tickText = texts[i]; }
    }
    tickMaxPx = tickMaxPx > 0 ? (tickMaxPx + 1) : 0;
    /* ③ 标题锚点：保证标题右缘与刻度文本左缘留 ≥ Y_NAME_TICK_GAP */
    var nameGap = Math.max(Y_NAME_GAP_MIN, Math.round(margin + tickMaxPx + Y_NAME_TICK_GAP));
    /* ④ 左侧留白：标题宽度 + 左缘留白（并至少 GRID_LEFT_MIN） */
    var pad = Math.round(clamp(nameGap + titlePx + Y_TITLE_PAD, GRID_LEFT_MIN, GRID_LEFT_MAX));
    axis.nameGap = nameGap;
    return {
      pad: pad,
      gridLeft: isRight ? 0 : pad,
      gridRight: isRight ? pad : 0,
      nameGap: nameGap,
      tickMaxPx: Math.round(tickMaxPx * 10) / 10,
      titlePx: titlePx,
      tickText: tickText
    };
  }

  /* ------------------------------------------------------------ 数值轴 */
  /**
   * 生成数值/时间轴配置（Y 左/右轴，或散点的数值 X 轴）
   * @param {{name?:string, style?:object, type?:string, decimals?:number, timeStyle?:string,
   *          isX?:boolean, id?:string, position?:'left'|'right', autoMinMax?:boolean,
   *          interval?:number}} opts
   *        position='right' → 生成右轴（position:'right'）；autoMinMax=true → 忽略
   *        style.yMin/yMax（右轴一律自动范围，保证左右轴各自独立，契约 §3.3）
   * @returns {{yAxis:object, gridLeft:number, gridRight:number, position:string|null}}
   *          gridLeft = 该轴占用的左侧留白（右轴为 0）；gridRight = 右侧留白（左轴为 0）
   */
  function valueAxis(opts) {
    opts = opts || {};
    var style = opts.style || {};
    var isX = !!opts.isX;
    var isRight = !isX && opts.position === 'right';
    var name = opts.name || '';
    var fontSize = isX ? num(style.xAxisFontSize, 11) : num(style.yAxisFontSize, 11);
    var weight = isX ? (style.xAxisFontWeight || 'normal') : (style.yAxisFontWeight || 'normal');
    var color = isX ? (style.xAxisColor || '#4a5866') : (style.yAxisColor || '#4a5866');
    var showTitle = isX ? true : (style.showYAxisTitle !== false);
    var isTime = (opts.type === T.TIME);

    /* yMin / yMax：空 = 自动；autoMinMax（右轴）时一律自动（左右轴各自独立范围） */
    var min = null, max = null;
    if (!opts.autoMinMax) {
      min = (style.yMin === null || style.yMin === undefined || style.yMin === '') ? null : Number(style.yMin);
      max = (style.yMax === null || style.yMax === undefined || style.yMax === '') ? null : Number(style.yMax);
      if (min !== null && !isFinite(min)) min = null;
      if (max !== null && !isFinite(max)) max = null;
      if (min !== null && max !== null && min > max) { var t = min; min = max; max = t; }
    }

    /* 对数轴（仅 Y 轴生效；log 轴要求 min > 0） */
    var log = !isX && !!style.yLog;
    if (log && min !== null && min <= 0) min = null;

    /* 刻度标签格式化：小数位（空=自动）或时间样式；opts.decimals 优先于 style.yDecimals */
    var decimals = (opts.decimals !== undefined) ? opts.decimals : style.yDecimals;
    var formatter;
    if (isTime) {
      formatter = function (v) { return T.formatTime(v, opts.timeStyle || 'datetime'); };
    } else if (decimals !== null && decimals !== undefined && decimals !== '') {
      var d = Math.floor(num(decimals, 0));
      formatter = function (v) {
        if (v === null || v === undefined || v !== v) return '';
        return YMS.util.fmtNumber(v, clamp(d, 0, 8));
      };
    }

    var axis = {
      type: log ? 'log' : 'value',
      name: showTitle ? name : '',
      nameLocation: 'middle',
      nameGap: isX ? 32 : 44,
      nameRotate: isX ? null : 90,
      nameTextStyle: { color: color, fontSize: fontSize, fontWeight: weight, align: isX ? 'center' : 'center' },
      min: min === null ? null : min,
      max: max === null ? null : max,
      scale: false,
      axisLine: { show: !isX, lineStyle: { color: '#b6c0c9' } },
      axisTick: { show: !isX, lineStyle: { color: '#c2cad2' } },
      splitLine: {
        show: !isX && style.showGrid !== false,
        lineStyle: { color: '#e9edf0', type: 'solid' }
      },
      axisLabel: { color: color, fontSize: fontSize, fontWeight: weight, margin: 8 },
      axisPointer: { show: true }
    };
    if (!isX) axis.position = isRight ? 'right' : 'left';   // 左轴显式 'left'，右轴 'right'（契约 §3.3）
    if (opts.id) axis.id = opts.id;
    if (typeof formatter === 'function') axis.axisLabel.formatter = formatter;
    if (num(opts.interval, 0) > 0) axis.interval = num(opts.interval, 0);

    /* 迭代 15（需求 ②）：按「刻度文本实测宽 + 标题宽 + 间距」给出该轴占用的留白
       （旧公式只按标题字数估 48~110px，完全没算刻度数字宽度 → 刻度变宽时标题被挤出画布）。
       此处 min/max/interval 可能尚未由 ChartBuilder 的智能范围写回，故先给一版；
       ChartBuilder.applyRange 之后会再调一次 axisPad() 用**真实刻度**重算（唯一权威来源）。 */
    var pad = axisPad(axis, { decimals: decimals, isTime: isTime, timeStyle: opts.timeStyle });

    return {
      yAxis: axis,
      gridLeft: pad.gridLeft,       // 右轴不占左侧留白（保持既有单轴调用语义）
      gridRight: pad.gridRight,     // 右轴占用的右侧留白
      nameGap: pad.nameGap, tickMaxPx: pad.tickMaxPx, titlePx: pad.titlePx,
      position: isX ? null : (isRight ? 'right' : 'left')
    };
  }

  /* -------------------------------------------------------- 智能范围（Y 轴） */
  /**
   * 取「好看」步长：1 / 2 / 2.5 / 5 / 10 × 10^k（k 为整数），返回 ≥ raw 的最小者。
   * @param {number} raw 目标步长（通常 (hi-lo)/4）
   * @returns {number} 步长（raw 非正/非有限时回退 1）
   */
  function niceStep(raw) {
    var r = Number(raw);
    if (!isFinite(r) || r <= 0) return 1;
    var exp = Math.floor(Math.log10(r));
    var base = Math.pow(10, exp);
    var f = r / base;                                   // 落在 [1, 10)
    var m = f <= 1 ? 1 : (f <= 2 ? 2 : (f <= 2.5 ? 2.5 : (f <= 5 ? 5 : 10)));
    return roundSig(m * base);
  }

  /**
   * 按数量级保留 12 位有效数字，消除 0.30000000000000004 这类浮点噪声
   * @param {number} x
   * @returns {number}
   */
  function roundSig(x) {
    var v = Number(x);
    if (!isFinite(v) || v === 0) return v;
    var sig = 12;
    var p = Math.pow(10, sig - 1 - Math.floor(Math.log10(Math.abs(v))));
    return Math.round(v * p) / p;
  }

  /**
   * 钳制边界取整（契约 §3.4 收尾）：被 step 对齐拉坏时改用「数据边界 ± 8% 留白」，
   * 那是 12 位有效数字（如 91.8984653486），配上细步长会出现 10 位小数的刻度标签。
   * 规则（按优先级）：
   *   ① 取步长的整数倍（刻度最整齐）——必须落在契约允许区间内，且不越过数据边界；
   *   ② 否则逐级放宽小数位，取第一个「朝数据方向取整、且仍不越过数据边界」的值
   *      （下界向上取整、上界向下取整，故不会违反 §3.4 的下界/上界约束）；
   *   ③ 兜底直接用契约值，并至少保证不越过数据边界。
   * @param {number} v 契约边界值（dataMin-pad 或 dataMax+pad）
   * @param {number} step 步长
   * @param {boolean} isMin 是否下界
   * @param {number} dataBound 该侧的数据边界（下界用 dataMin、上界用 dataMax）
   */
  function snapBound(v, step, isMin, dataBound) {
    var s = Math.abs(Number(step)) || 1;
    var db = Number(dataBound);
    var inRange = function (c) {
      if (!isFinite(c)) return false;
      if (isMin) return c >= v - 1e-12 && c <= db + 1e-12;
      return c <= v + 1e-12 && c >= db - 1e-12;
    };
    /* ① 步长整数倍 */
    var q = (isMin ? Math.ceil(v / s) : Math.floor(v / s)) * s;
    q = Math.round(q * 1e6) / 1e6;
    if (inRange(q)) return q;
    /* ② 逐级放宽小数位（朝数据方向取整，避免越过契约边界） */
    var dpMax = Math.min(6, Math.max(0, Math.ceil(Math.abs(Math.log(s) / Math.LN10)) + 2));
    for (var dp = 0; dp <= dpMax; dp++) {
      var f = Math.pow(10, dp);
      var c = (isMin ? Math.ceil(v * f) : Math.floor(v * f)) / f;
      if (inRange(c)) return c;
    }
    /* ③ 兜底 */
    return isMin ? Math.min(v, db) : Math.max(v, db);
  }

  /**
   * 摊平候选数值：支持 数字 / 数组 / 数组的数组 / {ys|values|data} 对象 混装，
   * 便于「只按指定 series 集合计算」某一根轴的范围（契约 §3.4：左右轴分别算）。
   * @param {Array} vals
   * @param {Array<number>} out
   * @returns {Array<number>}
   */
  function collectValues(vals, out) {
    var list = vals || [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (typeof v === 'number') { out.push(v); continue; }
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') {
        /* 数组 / typed array（注意：Array.prototype.values 是函数，必须先判 length） */
        if (typeof v.length === 'number') { collectValues(v, out); continue; }
        var inner = v.ys || v.data || (typeof v.values === 'function' ? null : v.values);
        if (inner && typeof inner.length === 'number') { collectValues(inner, out); continue; }
      }
    }
    return out;
  }

  /**
   * 根据「本图实际绘制的数值」计算聪明的 Y 轴范围（默认自动时使用）：
   *   · 留白 pad = range * 0.08；range === 0 时以 |mn|*0.05 || 0.5 上下扩展
   *   · 频数（hist）等非负数据：下限固定 0（不出现 0 基线导致的"柱子等高"）
   *   · 步长 step = niceStep((hi-lo)/4)，min/max 向 step 外扩对齐（刻度整齐）
   *   · 迭代 4 修复（契约 §3.4）：外扩造成的额外下沉超过 MAX_PULL_PADS(3) 个留白带时
   *     判定为「被 step 拉坏」（实测 Line + Yield/Vth/Idsat：数据 0.52~92.01 → -50..100），
   *     下界改用契约值「数据下界 - 8% 留白」，上界同样收回「数据上界 + 8% 留白」
   * @param {Array} vals 候选数值（非有限值自动跳过；可混装数组/对象，见 collectValues）
   * @param {{zeroMin?:boolean}} [opts] zeroMin=true 表示下限固定 0（若数据非负）
   * @returns {{min:number, max:number, step:number, dataMin:number, dataMax:number,
   *            rawMin:number, rawMax:number, n:number, loFixed:boolean, hiFixed:boolean}|null}
   *          无有效数值时返回 null（交回 ECharts 自动）
   */
  function smartRange(vals, opts) {
    opts = opts || {};
    var list = collectValues(vals, []);
    var mn = Infinity, mx = -Infinity, n = 0, i, v;
    for (i = 0; i < list.length; i++) {
      v = list[i];
      if (typeof v !== 'number' || v !== v || !isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      n++;
    }
    if (!n) return null;

    var dataMin = mn, dataMax = mx;
    var range = mx - mn;
    if (range === 0) {                                   // 全部等值：上下扩一点避免压成一条线
      var half = Math.abs(mn) * 0.05 || 0.5;
      mn = mn - half; mx = mx + half; range = mx - mn;
    }
    var pad = range * 0.08;
    var lo, hi;
    if (opts.zeroMin === true && mn >= 0) { lo = 0; hi = mx + pad; }   // 频数等非负数据：保留 0 基线
    else { lo = mn - pad; hi = mx + pad; }
    var step = niceStep((hi - lo) / 4);
    if (!isFinite(step) || step <= 0) step = 1;
    var rawMin = lo, rawMax = hi;
    var min = roundSig(Math.floor(lo / step) * step);
    var max = roundSig(Math.ceil(hi / step) * step);
    /* 契约 §3.4：step 对齐不得把范围拉坏（额外下沉/上抬 ≤ MAX_PULL_PADS 个留白带） */
    var loFixed = false, hiFixed = false;
    var padRef = pad > 0 ? pad : ((Math.abs(rawMax) + Math.abs(rawMin)) || 1) * 1e-9;
    if (rawMin - min > MAX_PULL_PADS * padRef) { min = snapBound(rawMin, step, true, dataMin); loFixed = true; }
    if (max - rawMax > MAX_PULL_PADS * padRef) { max = snapBound(rawMax, step, false, dataMax); hiFixed = true; }
    if (!(max > min)) { min = snapBound(rawMin, step, true, dataMin); max = snapBound(rawMax, step, false, dataMax); loFixed = hiFixed = true; }
    return {
      min: min, max: max, step: step, dataMin: dataMin, dataMax: dataMax,
      rawMin: rawMin, rawMax: rawMax, n: n, loFixed: loFixed, hiFixed: hiFixed
    };
  }

  YMS.Axis = {
    rotatePolicy: rotatePolicy,
    xRotateOf: xRotateOf,
    truncateLabel: truncateLabel,
    categoryAxis: categoryAxis,
    valueAxis: valueAxis,
    niceStep: niceStep,
    smartRange: smartRange,
    /* 迭代 9：横轴表格几何纯函数（chart-builder 同源引用 → 行高 / 旋转块高只有一个来源） */
    rowHFor: rowHFor,
    rotatedBlockH: rotatedBlockH,
    /* 迭代 21：横轴底部留白几何（标签块 + 统计行带相加，按容器高度收敛）—— 唯一来源 */
    bottomFit: bottomFit,
    gridBottomFor: gridBottomFor,
    /* 迭代 13：统一抽稀集合（类别名 ↔ 数值一一对应的唯一来源） */
    keptIndices: keptIndices,
    /* 迭代 28：第二层分组行模型（同一组一个居中标签；留白预算与绘制共用同一结果） */
    groupAxisModel: groupAxisModel,
    groupAxisLevels: groupAxisLevels,
    /* 迭代 15（需求 ②）：Y 轴留白按刻度文本实测宽推导（chart-builder 用真实范围复算） */
    axisPad: axisPad,
    textPx: textPx,
    tickValuesOf: tickValuesOf,
    tickLabelText: tickLabelText,
    /* 迭代 12（需求 ③）：统计量旋转 —— 角度归一化 / 行带高度 / 旋转包围盒宽高 */
    statRotateOf: statRotateOf,
    statRowHFor: statRowHFor,
    rotBoxW: rotBoxW,
    rotBoxH: rotBoxH,
    STAT_ROTATE_ALLOWED: STAT_ROTATE_ALLOWED.slice(),
    /** 策略常量（设置面板/文档引用） */
    POLICY: {
      ROTATE_NONE_MAX: ROTATE_NONE_MAX, ROTATE_45_MAX: ROTATE_45_MAX, ROTATE_30_MAX: ROTATE_30_MAX,
      TICK_DENSE: TICK_DENSE, NAME_GAP: NAME_GAP,
      GRID_LEFT_MIN: GRID_LEFT_MIN, GRID_LEFT_MAX: GRID_LEFT_MAX,
      /* 迭代 15：Y 轴留白分量（设置面板/自检引用） */
      Y_TICK_MARGIN: Y_TICK_MARGIN, Y_NAME_TICK_GAP: Y_NAME_TICK_GAP,
      Y_NAME_GAP_MIN: Y_NAME_GAP_MIN, Y_TITLE_PAD: Y_TITLE_PAD, Y_GRID_RIGHT_MIN: Y_GRID_RIGHT_MIN,
      STAT_ROW_H: STAT_ROW_H, MAX_PULL_PADS: MAX_PULL_PADS,
      CHAR_W_RATIO: CHAR_W_RATIO, LABEL_GAP: LABEL_GAP, ASSUME_PLOT_W: ASSUME_PLOT_W,
      TICK_DENSE_HARD: TICK_DENSE_HARD, HEADER_PAD: HEADER_PAD, AXIS_LABEL_MARGIN: AXIS_LABEL_MARGIN,
      X_ROTATE_ALLOWED: X_ROTATE_ALLOWED,
      /* 迭代 9 */
      TITLE_GAP: TITLE_GAP, MAX_GRID_BOTTOM: MAX_GRID_BOTTOM, HEADER_TEXT_PAD: HEADER_TEXT_PAD,
      ROW_H_RATIO: ROW_H_RATIO, ROT_LINE_H_RATIO: ROT_LINE_H_RATIO,
      /* 迭代 12 */
      STAT_ROTATE_ALLOWED: STAT_ROTATE_ALLOWED, STAT_ROW_PAD: STAT_ROW_PAD,
      MAX_GRID_BOTTOM_ROT: MAX_GRID_BOTTOM_ROT,
      /* 迭代 21（底部留白相加 / 不裁字）：容器约束与降级阈值 */
      BOTTOM_ROW_GAP: BOTTOM_ROW_GAP, BOTTOM_TAIL: BOTTOM_TAIL,
      PLOT_H_MIN: PLOT_H_MIN, PLOT_H_HARD: PLOT_H_HARD,
      BOTTOM_RATIO_MAX: BOTTOM_RATIO_MAX, LABEL_FONT_MIN: LABEL_FONT_MIN,
      FS_SLIDER_BAND: FS_SLIDER_BAND,
      /* 迭代 13 */
      KEPT_GAP: KEPT_GAP
    },
    _gridBottomFor: gridBottomFor,
    _collectValues: collectValues
  };
})(typeof window !== 'undefined' ? window : this);
