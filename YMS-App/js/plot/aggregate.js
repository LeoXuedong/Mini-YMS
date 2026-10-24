/* ==========================================================================
   YMS · plot/aggregate.js
   ---------------------------------------------------------------------------
   职责：把 YMS.Store.getView()（预处理后的只读视图）聚合为绘图所需结构：

     Work = 页(Page) → 分面(Facet) → 类别(Category) → 统计量(Stats)
            并提供按扁平序号取"单张图数据"的 chartOf(work, index)。

   统计语义（严格遵循 DEV-SPEC 3.C1）：
     · 类别键：单 X → 该列显示值；多 X → 各列显示值用 '-' 连接（Fab1-L001）；
               X 轴名 = 参数名用 '-' 连接（Fab-Lot）。
     · 类别排序：无 Sorter → 按类别键升序（数值列按数值、时间列按时间、字符列按字典序）；
                 有 Sorter → 按"该类别上 sorter 列的聚合值"（数值/时间取均值、
                 字符取字典序最小值）多级排序，dir 默认 'asc'；无效值恒排最后。
     · 防拥挤合并：上限 auto → Box 40 / Bar·Line 60 / Hist·Scatter 不限；
                  manual → plot.merge.limit（20/40/60/80/120）；none → 不限。
                  类别数 > 上限 → groupSize = ceil(类别数/上限)，相邻类别合并为一组，
                  组标签 = 该组**代表值**（组内首个类别名，如 L0064）；完整范围保留在
                  cat.range / from / to，并合成 cat.fullLabel 供 tooltip 显示
                  （如 `L0064（L0064~L0096，27 类）`）—— 迭代 15 ③ 用户口径：不再拼范围标签。
                  **组内统计一律用组内全部原始数据重算**（不允许"先算类均值再平均"）。
     · 统计量：Line/Bar → 每 Value 列 mean（另存 n/min/max/median/q1/q3/std）；
              Box → min/Q1/median/Q3/max（Q(p) = v[floor(k)] + (v[ceil(k)]-v[floor(k)])*(k-floor(k))，
                    k = p*(n-1)，与 Excel QUARTILE.INC 一致）+ mean + std；
              Hist → 第一个 Value 列分箱（bins = plot.histBins || ceil(log2(n)+1)，clamp 5..80），
                     每箱另给 mean/median/q1/q3/std/min/max（按箱内原始数据重算）。
              std = **总体标准差**（分母 N），与 df.stats.stddev 约定一致（横轴统计行 Nu% 用）。
     · Scatter：画原始数据点（不聚合、不合并）；X 首列为数值/时间列时用真实值，
                否则用类别序号并在轴上显示类别标签；点数 > 200000 时按步长抽稀渲染
                （subtext 注明"已抽稀 N/M"），拟合仍用全部点（raw.series[].xsAll/ysAll）。

   迭代 4（docs/DEV-SPEC-迭代4.md §1~§3.2，渲染层接口）：
     · display='facet'（默认）：行为与迭代 3 完全一致（回归红线）。
     · display='overlay' 且 type ∈ {line, scatter}：每个 Page 只产出 **1 个 facet**（不再按
       splitBy 拆分）；facet.groups = [{key,label,labels,cats,raw}]，组数 = splitBy 组合数；
       cats 类别域 = 各组类别的并集（沿用同一 sorter 排序 + 同一合并上限）；
       每个 groups[i].cats[j].stats 只含**该组该类别**的统计量（组内原始数据重算）。
       其它图型或 splitBy 为空时 overlay 等价于 facet（不报错，记 notes 说明）。
     · 颜色/符号分组（group.colorBy / group.symbolBy）：series 按
       「Value 列 × overlay 组 × 颜色分组取值 × 符号分组取值」拆分，
       key = YMS.Aggregate.seriesKey(列名, [组标签…])；两列留空 = 不拆分（现状）。
       分组数上限 MAX_GROUPS（超出并入最后一组并记 notes，不丢数据、不炸 DOM）；
       直方图暂不支持颜色/符号分组（记 notes 说明）。
     · seriesKey(valueColName, groupLabels[]) / seriesList(plot) 对外提供，
       供设置面板渲染轴位列表 + 测试断言（契约 §2 / §3.2）。
     · axisSide = { '<seriesKey>': 'left'|'right' }：sideOf() 先按完整 key 命中，
       再回退该 series 的 Value 列名，最后缺省 'left'（组内共用一条轴）。

  迭代 7（图内标题 / 副标题精简）：
     · chartOf() 组装的 subtext **不再包含「合并：N → M 组…」那一行**（用户要求删除图内上方的
       合并提示）；其余行（拟合公式与 R²、抽稀提示、拟合失败说明）保留并照旧渲染。
       合并信息本身不受影响：work.mergeSummary / facet.mergeNote / 页签信息栏照旧可用。

   性能：单趟扫描视图；行→分面归属、行→类别归属、行→分组归属、分桶计数全部用 typed array
        + 普通 for；统计量分桶用"计数 → 前缀和 → 填充"三步走（不产生装箱 JS 数组），
        百万行构建目标 ≤ 3s。分组（颜色/符号/叠加）为可选路径，关闭时零额外开销。

   本文件只读 YMS.Store / YMS.View / YMS.types（拟合经 YMS.Fitting，可选），
   不触碰 DOM，不创建 ECharts 实例。
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;

  /* ------------------------------------------------------------------ 常量 */
  var X_KEY_SEP = '-';               // 多列键 / 轴名连接符
  var CAT_HARD_LIMIT = 5000;         // 类别数硬上限（超过则提示）
  var CAT_KEEP = 2000;               // 超过硬上限时保留的类别数
  var MAX_FACETS = 400;              // 单次聚合的分面数软上限（防 DOM 爆炸）
  var SCATTER_MAX_POINTS = 200000;   // 散点渲染点数上限（超出按步长抽稀）
  var AUTO_MERGE_LIMIT = { line: 60, bar: 60, box: 40, hist: null, scatter: null };
  var OVERLAY_TYPES = { line: true, scatter: true };   // 叠加同图仅对这些图型生效（契约 §1）
  var MAX_GROUPS = 40;               // series 分组（颜色/符号/叠加）数安全上限
  /* 统计量显示顺序（契约 §1：stats.items 顺序即显示顺序，取 STAT_ORDER） */
  var STAT_ORDER = ['mean', 'median', 'std', 'rng', 'nupct', 'n', 'min', 'max', 'q1', 'q3'];

  /* ------------------------------------------------------------- 小工具 */
  function nowMs() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }
  function clampInt(v, lo, hi) {
    v = Math.floor(v);
    if (!isFinite(v)) v = lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }
  /** 完整样式（DEFAULT_STYLE + Store 现值），供 chartOf / ChartBuilder 使用 */
  function cloneStyle(s) {
    var out = {};
    var base = (YMS.Store && YMS.Store.DEFAULT_STYLE) || {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (s) Object.keys(s).forEach(function (k) { out[k] = s[k]; });
    return out;
  }
  /** sorter 方向：仅 'desc' 视为降序，其余（含 undefined）默认升序 */
  function dirOf(s) { return s && s.dir === 'desc' ? -1 : 1; }
  /** 有效列名过滤（不存在 / 重复 / 空串 → 剔除） */
  function validNames(names, df) {
    var out = [];
    (names || []).forEach(function (l) {
      if (typeof l !== 'string' || l === '') return;
      if (df.colIndex(l) < 0) return;
      if (out.indexOf(l) >= 0) return;
      out.push(l);
    });
    return out;
  }
  /** 列名 → 列描述（含视图小数位、时间样式） */
  function toCol(df, name) {
    var i = df.colIndex(name), c = df.cols[i];
    var ds = (YMS.Store.state && YMS.Store.state.dataSettings) || {};
    var dec = (ds.decimals && ds.decimals[name] !== undefined) ? ds.decimals[name] : null;
    return {
      ci: i, name: c.name, type: c.type, decimals: dec, timeStyle: c.timeStyle || 'datetime',
      /* 分组派生列：用户定义的类目顺序（横轴严格按它排，见 orderCategories） */
      order: (c.order && c.order.length) ? c.order : null,
      /* 迭代 28：分组派生列标记（多列 X 里的「分组参数」列 → 第二层合并标签 + 组顺序） */
      isGroupCol: !!(c.groupMap && c.groupMap.groups && c.groupMap.groups.length),
      groupMap: c.groupMap || null
    };
  }
  /** 合并上限：null = 不限 */
  function effectiveLimit(type, merge) {
    merge = merge || {};
    if (merge.mode === 'none') return null;
    if (merge.mode === 'manual') {
      var l = Number(merge.limit);
      if (isFinite(l) && l > 0) return Math.floor(l);
    }
    var auto = AUTO_MERGE_LIMIT[type];
    return (auto === undefined || auto === null) ? null : auto;
  }
  /** 合并信息文案（供 title.subtext / 页签 / 报告使用） */
  function mergeText(m) {
    if (!m || !m.applied) return '';
    return '合并：' + m.before + ' → ' + m.after + ' 组（每 ' + m.groupSize + ' 类合并' +
      (m.limit === null ? '，不限制' : '，上限 ' + m.limit) + '）';
  }
  /** 分位数（线性插值 = Excel QUARTILE.INC）；v 需升序，区间 [0, n) */
  function quantileSorted(v, n, p) {
    if (!n) return null;
    if (n === 1) return v[0];
    var k = p * (n - 1), f = Math.floor(k), c = Math.ceil(k);
    if (f === c) return v[f];
    return v[f] + (v[c] - v[f]) * (k - f);
  }
  /** 原始值 → 键片段：字符列用字典下标、数值列用数值（缺失统一为 \u0000） */
  function rawToken(type, raw) {
    if (type === T.STRING) return raw < 0 ? '\u0000' : 's' + raw;
    return (raw !== raw || (typeof raw === 'number' && !isFinite(raw))) ? '\u0000' : 'n' + raw;
  }
  /** 多列原始键（Map 分组用，不做格式化，性能友好） */
  function multiRawKey(view, pos, cols) {
    var r = view.rowIdx ? view.rowIdx[pos] : pos;
    var parts = new Array(cols.length);
    for (var k = 0; k < cols.length; k++) {
      var c = view.df.cols[cols[k].ci];
      parts[k] = rawToken(c.type, c.values[r]);
    }
    return parts.join('|');
  }
  /** 多列显示标签（'-' 连接；缺失显示 '(缺失)'） */
  function multiDisplayLabel(view, pos, cols) {
    var parts = new Array(cols.length);
    for (var k = 0; k < cols.length; k++) {
      var s = view.displayAt(pos, cols[k].ci);
      parts[k] = (s === '' || s === null || s === undefined) ? '(缺失)' : s;
    }
    return parts.join(X_KEY_SEP);
  }
  /** 指定列子集的显示标签（迭代 28：分组的第二层标签拆走后，第一层只拼其余列） */
  function labelOfCols(view, pos, cols, idxs) {
    var parts = [];
    for (var k = 0; k < idxs.length; k++) {
      var s = view.displayAt(pos, cols[idxs[k]].ci);
      parts.push((s === '' || s === null || s === undefined) ? '(缺失)' : s);
    }
    return parts.join(X_KEY_SEP);
  }
  /** 多列 X 里的「分组参数列」位置：优先取第一个带 groupMap 的派生列；无显式映射时
      把**第一列**当分组维度（迭代 29）—— 用户把「组参数」列放在 X 轴首位时，
      只要它在多根 bar 上连续重复，就该合并成一条跨列标签，不该要求先配 Group Mapping。
      单列 X 不启用（一 bar 一组无需合并）。 */
  function groupColPos(cols) {
    if (!cols || cols.length < 2) return -1;
    for (var i = 0; i < cols.length; i++) if (cols[i].isGroupCol) return i;
    return 0;
  }
  /** N 级分组：**分组层 = 除最后一列以外的所有 X 列**（按 X 顺序），最后一列是叶子标签。
      [Tool_Group, Chamber_Group, Lot] → [0,1]（2 级 + 叶子 Lot）；[Tool_Group, Lot] → [0]（1 级）；
      单列 X → []（一 bar 一组，不产生分组带）。 */
  function groupLevelPositions(cols) {
    var out = [];
    if (!cols || cols.length < 2) return out;
    for (var i = 0; i < cols.length - 1; i++) out.push(i);
    return out;
  }
  /** 列的显示值（缺失统一 '(缺失)'） */
  function levelTextAt(view, pos, col) {
    var s = view.displayAt(pos, col.ci);
    return (s === '' || s === null || s === undefined) ? '(缺失)' : s;
  }
  /** 分组层的完整 tuple 键（合并分段 / 排序分块共用） */
  function groupTupleKey(groupLabels) {
    if (!groupLabels || !groupLabels.length) return '';
    var parts = new Array(groupLabels.length);
    for (var i = 0; i < groupLabels.length; i++) {
      parts[i] = (groupLabels[i] === null || groupLabels[i] === undefined) ? '' : String(groupLabels[i]);
    }
    return parts.join('\u0001');
  }
  /** 类别的分层键：优先完整 tuple，回退单层 groupLabel（兼容旧数据形状） */
  function catGroupKey(cat) {
    if (!cat) return '';
    if (cat.groupLabels) return groupTupleKey(cat.groupLabels);
    return (cat.groupLabel === undefined || cat.groupLabel === null) ? '' : String(cat.groupLabel);
  }
  /** 除某一列以外的列下标（第一层标签用） */
  function otherIdx(cols, skip) {
    var out = [];
    for (var i = 0; i < cols.length; i++) if (i !== skip) out.push(i);
    return out;
  }
  /** 文本比较：两边都是纯数字按数值比（'L0002' < 'L0010' 仍走字典序），否则按码点 */
  function cmpText(a, b) {
    var sa = (a === null || a === undefined) ? '' : String(a);
    var sb = (b === null || b === undefined) ? '' : String(b);
    if (sa === sb) return 0;
    if (sa !== '' && sb !== '') {
      var na = Number(sa), nb = Number(sb);
      if (isFinite(na) && isFinite(nb)) return na < nb ? -1 : 1;
    }
    return sa < sb ? -1 : 1;
  }

  /* ------------------------------------------------ 迭代 4：seriesKey / 轴位 */
  /**
   * 契约 §2 的 seriesKey 规则（轴位、图例、设置面板三处必须一致）：
   *   非分组           → 列名（'Yield'）
   *   有组标签         → 列名 + '@' + 组标签用 '/' 拼接（'Yield@Fab1'、'Yield@Fab1/A'）
   *   仅符号分组的占位 → 'Yield@/A'（保留颜色位，遵循契约 §2 的拼接规则）
   * @param {string} valueColName Value 列名
   * @param {Array<string>} groupLabels 组标签（可为空数组；元素可为空串占位）
   * @returns {string}
   */
  function seriesKey(valueColName, groupLabels) {
    var col = (valueColName === null || valueColName === undefined) ? '' : String(valueColName);
    if (groupLabels && groupLabels.length) {
      var parts = [];
      for (var i = 0; i < groupLabels.length; i++) {
        var l = groupLabels[i];
        parts.push((l === null || l === undefined) ? '' : String(l));
      }
      if (parts.length) return col + '@' + parts.join('/');
    }
    return col;
  }

  /**
   * 轴位解析：先按完整 seriesKey 命中 axisSide，再回退该 series 的 Value 列名，缺省 'left'
   * @param {object} map plot.axisSide
   * @param {string} key seriesKey
   * @param {string} valueCol Value 列名
   * @returns {'left'|'right'}
   */
  function sideOf(map, key, valueCol) {
    if (map && typeof map === 'object') {
      if (map[key] === 'right') return 'right';
      if (map[key] === 'left') return 'left';
      if (valueCol !== undefined && valueCol !== null) {
        if (map[valueCol] === 'right') return 'right';
        if (map[valueCol] === 'left') return 'left';
      }
    }
    return 'left';
  }

  /** 统计量多选归一化：剔除非法值/重复，顺序恒为 STAT_ORDER（契约 §1） */
  function normalizeStatItems(items) {
    var picked = [], i;
    var src = items || [];
    for (i = 0; i < src.length; i++) {
      var k = src[i];
      if (typeof k !== 'string') continue;
      if (STAT_ORDER.indexOf(k) < 0) continue;
      if (picked.indexOf(k) >= 0) continue;
      picked.push(k);
    }
    var out = [];
    for (i = 0; i < STAT_ORDER.length; i++) if (picked.indexOf(STAT_ORDER[i]) >= 0) out.push(STAT_ORDER[i]);
    return out;
  }

  /** 分组列名有效性（'' 或不存在 → ''） */
  function validGroupName(name, df) {
    if (typeof name !== 'string' || name === '') return '';
    return df.colIndex(name) >= 0 ? name : '';
  }

  /** overlay 生效条件（契约 §3.1）：display='overlay' + line/scatter + splitBy 有效 */
  function isOverlayConfig(plot, df) {
    if (!plot || plot.display !== 'overlay') return false;
    var type = plot.type || 'scatter';
    if (!OVERLAY_TYPES[type]) return false;
    return validNames(plot.splitBy, df).length > 0;
  }

  /** splitBy 组合的显示标签列表（首现顺序，与 build 的组顺序一致；上限 200 组） */
  function splitLabelList(plot, df) {
    var names = validNames(plot.splitBy, df);
    if (!names.length) return [];
    var view = YMS.Store.getView();
    if (!view || !view.count) return [];
    var cols = names.map(function (nm) { return toCol(df, nm); });
    var seen = Object.create(null), out = [];
    for (var i = 0; i < view.count; i++) {
      var k = multiRawKey(view, i, cols);
      if (seen[k] !== undefined) continue;
      seen[k] = 1;
      out.push(multiDisplayLabel(view, i, cols));
      if (out.length >= 200) break;
    }
    return out;
  }

  /**
   * 契约 §3.2：按当前配置推导"这张图里有哪几条数据"（供设置面板渲染轴位列表 + 测试断言）
   * @param {object} [plot] 缺省取 Store.state.plot
   * @returns {Array<{key:string,label:string,valueCol:string,groupLabel:string,side:string}>}
   */
  function seriesList(plot) {
    var out = [];
    var df = (YMS.Store && YMS.Store.state) ? YMS.Store.state.df : null;
    if (!df) return out;
    plot = plot || YMS.Store.state.plot || {};
    var vNames = validNames(plot.values, df);
    if (!vNames.length) return out;
    var axisSide = (plot.axisSide && typeof plot.axisSide === 'object') ? plot.axisSide : null;
    var over = isOverlayConfig(plot, df);
    var labels = over ? splitLabelList(plot, df) : [];
    var list = labels.length ? labels : [null];
    vNames.forEach(function (vc) {
      list.forEach(function (lb) {
        var key = seriesKey(vc, lb === null ? [] : [lb]);
        out.push({
          key: key, label: key, valueCol: vc,
          groupLabel: (lb === null ? '' : lb),
          side: sideOf(axisSide, key, vc)
        });
      });
    });
    return out;
  }

  /* ================================================================ build */
  /**
   * 构建绘图数据（Work）。任何异常都被捕获为 notes，绝不抛出。
   * @returns {object} Work
   */
  function build() {
    var Store = YMS.Store;
    var t0 = nowMs();
    var plot = (Store && Store.state && Store.state.plot) || {};
    var type = plot.type || 'scatter';
    var work = {
      chartType: type,
      valueCols: [], xCols: [], xAxisName: '',
      pages: [], totalCharts: 0, notes: [], histInfo: null, mergeSummary: '',
      rows: 0, elapsedMs: 0,
      style: cloneStyle(plot.style),
      merge: { mode: (plot.merge && plot.merge.mode) || 'auto', limit: (plot.merge ? plot.merge.limit : null) },
      /* 迭代 4：渲染层配置快照（供 ChartBuilder / 自测读取） */
      display: plot.display === 'overlay' ? 'overlay' : 'facet',
      overlay: false,
      axisSide: (plot.axisSide && typeof plot.axisSide === 'object') ? plot.axisSide : {},
      group: { colorBy: '', symbolBy: '' },
      stats: { show: false, items: [] },
      /* 任务 F：图例样式 / 图元样式（设置区写入 Store，ChartBuilder 消费） */
      legend: plot.legend || null,
      mark: plot.mark || null
    };
    try {
      buildInner(work, Store, plot, type);
    } catch (err) {
      work.pages = []; work.totalCharts = 0; work.histInfo = null;
      work.notes.push('聚合失败：' + (err && err.message ? err.message : String(err)));
      if (global.console && global.console.error) global.console.error('[YMS.Aggregate]', err);
    }
    work.elapsedMs = nowMs() - t0;
    return work;
  }

  function buildInner(work, Store, plot, type) {
    if (!Store || !Store.hasData()) { work.notes.push('尚未载入数据'); return; }
    var df = Store.state.df;
    var view = Store.getView();
    if (!view || !view.count) {
      work.notes.push('视图为空：筛选条件或缺失值处理可能过滤掉了全部数据行');
      return;
    }
    work.rows = view.count;

    /* ---------------------------------------------------- 1) 解析配置 */
    var xNames = validNames(plot.x, df);
    var vNames = validNames(plot.values, df);
    if (!xNames.length) { work.notes.push('未配置 X Label：请在右侧「绘图设置区」选择后 Submit'); return; }
    if (!vNames.length) { work.notes.push('未配置 Value：请在右侧「绘图设置区」选择后 Submit'); return; }
    if ((plot.x || []).length > xNames.length) work.notes.push('部分 X Label 列已不存在（重命名/删除），已自动剔除');
    if ((plot.values || []).length > vNames.length) work.notes.push('部分 Value 列已不存在（重命名/删除），已自动剔除');
    if (type === 'hist' && vNames.length > 1) work.notes.push('直方图仅使用第一个 Value 列：' + vNames[0]);

    var xCols = xNames.map(function (nm) { return toCol(df, nm); });
    var valueCols = vNames.map(function (nm) { return toCol(df, nm); });
    work.xCols = xCols;
    work.valueCols = valueCols;
    work.xAxisName = xNames.join(X_KEY_SEP);
    valueCols.forEach(function (vc) {
      if (vc.type === T.STRING) work.notes.push('Value 列「' + vc.name + '」为字符列，无统计含义（统计量为空）');
    });

    var sorterCols = (plot.sorters || [])
      .filter(function (s) { return s && typeof s.col === 'string' && df.colIndex(s.col) >= 0; })
      .map(function (s) {
        var ci = df.colIndex(s.col);
        return { ci: ci, name: s.col, type: df.cols[ci].type, dir: dirOf(s) };
      });
    var pageCols = validNames(plot.pageBy, df).map(function (nm) { return toCol(df, nm); });
    var splitCols = validNames(plot.splitBy, df).map(function (nm) { return toCol(df, nm); });
    if ((plot.pageBy || []).length > pageCols.length) work.notes.push('部分 Page by 列已不存在，已自动剔除');
    if ((plot.splitBy || []).length > splitCols.length) work.notes.push('部分 Split by 列已不存在，已自动剔除');

    /* 迭代 4 配置：overlay / 颜色符号分组 / 横轴统计行 */
    var colorBy = validGroupName(plot.group && plot.group.colorBy, df);
    var symbolBy = validGroupName(plot.group && plot.group.symbolBy, df);
    work.group = { colorBy: colorBy, symbolBy: symbolBy };
    work.stats = {
      show: !!(plot.stats && plot.stats.show),
      items: normalizeStatItems(plot.stats && plot.stats.items)
    };
    var overlayOn = isOverlayConfig(plot, df);
    work.overlay = overlayOn;
    if (plot.display === 'overlay' && !overlayOn) {
      var t0 = plot.type || 'scatter';
      work.notes.push(OVERLAY_TYPES[t0]
        ? '「叠加同图」需要 Split by 分组列，当前未设置 → 按分面显示'
        : '「' + t0 + '」图型不支持「叠加同图」，仅 Line / Scatter 可用 → 按分面显示');
    }
    if (type === 'hist' && (colorBy || symbolBy)) {
      work.notes.push('直方图暂不支持颜色/符号分组（同图多色需选择 Line / Bar / Scatter）');
    }

    /* ------------------------------------ 2) 单趟扫描：行 → 分面(页+split)归属 */
    var n = view.count;
    var rowIdx = view.rowIdx;                      // Int32Array | null（视图行序列）
    var facetOf = new Int32Array(n);
    var pages = [];
    var pageMap = new Map();                       // 页键 → 页下标
    var facetMap = new Map();                      // 页下标 + 分面键 → flat 下标
    var flat = [];                                 // [{page, facet}]
    var splitOf = null, splitLabels = [];          // overlay：行 → splitBy 组合（组）下标
    var splitMap = new Map();
    if (overlayOn) splitOf = new Int32Array(n);
    var i, f;

    for (i = 0; i < n; i++) {
      var pk = pageCols.length ? multiRawKey(view, i, pageCols) : '';
      var pi = pageMap.get(pk);
      if (pi === undefined) {
        pi = pages.length;
        pageMap.set(pk, pi);
        pages.push({
          key: pk,
          label: pageCols.length ? multiDisplayLabel(view, i, pageCols) : '全部',
          facets: []
        });
      }
      var page = pages[pi];
      var sk;
      if (overlayOn) {
        /* 叠加同图：每个 Page 只产出一个 facet，splitBy 退化为该 facet 内的分组 */
        var sv = multiRawKey(view, i, splitCols);
        var si = splitMap.get(sv);
        if (si === undefined) {
          si = splitLabels.length;
          splitMap.set(sv, si);
          splitLabels.push(multiDisplayLabel(view, i, splitCols));
        }
        splitOf[i] = si;
        sk = '';
      } else {
        sk = splitCols.length ? multiRawKey(view, i, splitCols) : '';
      }
      var fi = facetMap.get(pi + '\u0001' + sk);
      if (fi === undefined) {
        fi = flat.length;
        facetMap.set(pi + '\u0001' + sk, fi);
        var facet = {
          key: sk,
          label: (overlayOn || !splitCols.length) ? '' : multiDisplayLabel(view, i, splitCols),
          title: '', cats: [], raw: null, merge: null, fit: null, hist: null,
          groups: null, mergeNote: '', sampleNote: ''
        };
        page.facets.push(facet);
        flat.push({ page: page, facet: facet });
      }
      facetOf[i] = fi;
    }

    /* ---------------------------------------------------- 3) 分面成员分桶 */
    var nf = flat.length;
    if (nf > MAX_FACETS) {
      work.notes.push('分面数 ' + nf + ' 过多，仅绘制前 ' + MAX_FACETS + ' 张图');
      var keepSet = [];
      for (f = 0; f < MAX_FACETS; f++) keepSet.push(flat[f].facet);
      pages.forEach(function (pg) {
        pg.facets = pg.facets.filter(function (fc) { return keepSet.indexOf(fc) >= 0; });
      });
      pages = pages.filter(function (pg) { return pg.facets.length > 0; });
      flat = flat.slice(0, MAX_FACETS);
      nf = MAX_FACETS;
    }
    var fCount = new Int32Array(nf);
    for (i = 0; i < n; i++) { if (facetOf[i] < nf) fCount[facetOf[i]]++; }
    var offs = new Int32Array(nf + 1);
    for (f = 0; f < nf; f++) offs[f + 1] = offs[f] + fCount[f];
    var members = new Int32Array(offs[nf]);
    var cursor = new Int32Array(nf);
    for (i = 0; i < n; i++) {
      var ff = facetOf[i];
      if (ff >= nf) continue;
      members[offs[ff] + cursor[ff]++] = i;
    }

    /* ---------------------------------------------------- 4) 逐分面构建 */
    var colorCol = colorBy ? toCol(df, colorBy) : null;
    var symCol = symbolBy ? toCol(df, symbolBy) : null;
    var ctx = {
      view: view, df: df, chartType: type,
      xCols: xCols, valueCols: valueCols, sorters: sorterCols,
      merge: work.merge,
      fit: plot.fit || 'none',
      fitOrder: clampInt(plot.fitOrder === undefined || plot.fitOrder === null ? 2 : plot.fitOrder, 2, 8),
      histBins: (plot.histBins === null || plot.histBins === undefined || plot.histBins === '')
        ? null : clampInt(plot.histBins, 5, 80),
      notes: work.notes,
      /* 迭代 4：overlay 分组 / 颜色符号分组配置（Hist 不参与分组） */
      overlayOn: overlayOn, splitOf: splitOf, splitLabels: splitLabels,
      colorCol: (type === 'hist' ? null : colorCol),
      symbolCol: (type === 'hist' ? null : symCol)
    };
    var titleBase = valueCols.map(function (v) { return v.name; }).join(' / ');
    var mergeTexts = [];
    for (f = 0; f < nf; f++) {
      var entry = flat[f], facet2 = entry.facet, pageLabel = entry.page.label;
      var res = buildFacetData(members.subarray(offs[f], offs[f + 1]), ctx);
      facet2.cats = res.cats;
      facet2.raw = res.raw;
      facet2.merge = res.merge;
      facet2.fit = res.fit;
      facet2.hist = res.hist;
      facet2.groups = res.groups || null;
      facet2.mergeNote = res.mergeNote || '';
      facet2.sampleNote = res.sampleNote || '';
      facet2.title = titleBase +
        ((pageLabel && pageLabel !== '全部') ? ' · ' + pageLabel : '') +
        (facet2.label ? ' · ' + facet2.label : '');
      if (res.merge && res.merge.applied) {
        var mt = mergeText(res.merge);
        if (mergeTexts.indexOf(mt) < 0) mergeTexts.push(mt);
      }
      if (res.hist && !work.histInfo) {
        work.histInfo = { bins: res.hist.bins, min: res.hist.min, max: res.hist.max };
      }
    }
    work.pages = pages;
    work.totalCharts = nf;
    work.mergeSummary = mergeTexts.slice(0, 3).join('；');
  }

  /* ------------------------------------------------- 分面构建（按图型分派） */
  function buildFacetData(members, ctx) {
    if (ctx.chartType === 'hist') return buildHistFacet(members, ctx);
    if (ctx.chartType === 'scatter') return buildScatterFacet(members, ctx);
    return buildCatFacet(members, ctx);
  }

  /* ====================================================== 类别索引 / 排序 */
  /**
   * 生成类别索引：类别键 + 每行所属类别
   * @returns {{cats:Array, catOf:Int32Array, k:number}}
   */
  function indexCategories(members, ctx) {
    var view = ctx.view, df = ctx.df, xCols = ctx.xCols;
    var n = members.length, i;
    var catOf = new Int32Array(n);
    var cats = [];
    var single = xCols.length === 1;
    var col0 = xCols[0];
    var col0IsStr = single && df.cols[col0.ci].type === T.STRING;
    var vals0 = single ? df.cols[col0.ci].values : null;
    var dict0 = single ? df.cols[col0.ci].dict : null;
    var rowIdx = view.rowIdx;
    var catMap = new Map();
    /* 迭代 28：多列 X 里的分组参数列（第二层合并标签的数据来源）
       gPos >= 0 时每个类别额外记 groupLabel（组名 / 未分组 / 保留原值）与 subLabel（第一层标签）。 */
    var gPos = groupColPos(xCols);
    var subIdx = (gPos >= 0) ? otherIdx(xCols, gPos) : null;
    /* N 级分组：除最后一列外每一列都是一个分组层（[Tool_Group, Chamber_Group, Lot] → 2 级） */
    var lvPos = groupLevelPositions(xCols);
    var leafPos = lvPos.length ? (xCols.length - 1) : -1;

    for (i = 0; i < n; i++) {
      var pos = members[i];
      var key, idx, label;
      if (single) {
        var raw = vals0[rowIdx ? rowIdx[pos] : pos];
        key = raw;                                     // 字典下标 / 数值（NaN 也可作 Map 键）
        idx = catMap.get(key);
        if (idx === undefined) {
          if (col0IsStr) label = raw < 0 ? '(缺失)' : dict0[raw];
          else label = (raw !== raw) ? '(缺失)' : T.formatValue(raw, col0.type, col0.decimals, col0.timeStyle);
          idx = cats.length;
          catMap.set(key, idx);
          cats.push({ key: label, label: label, count: 0, num: col0IsStr ? NaN : raw, isStrKey: col0IsStr });
        }
      } else {
        key = multiRawKey(view, pos, xCols);
        idx = catMap.get(key);
        if (idx === undefined) {
          label = multiDisplayLabel(view, pos, xCols);
          idx = cats.length;
          catMap.set(key, idx);
          var cat = { key: label, label: label, count: 0, num: NaN, isStrKey: true };
          if (lvPos.length) {
            /* ① 每一级各记一个值（groupLabels[0] = 最外层）；② 叶子标签 = 最后一列；
               groupLabel 保留 = groupLabels[0]（向后兼容：单层调用方照旧读它） */
            var glv = new Array(lvPos.length);
            for (var li = 0; li < lvPos.length; li++) glv[li] = levelTextAt(view, pos, xCols[lvPos[li]]);
            cat.groupLabels = glv;
            cat.groupLabel = glv[0];
            cat.subLabel = levelTextAt(view, pos, xCols[leafPos]);
          }
          cats.push(cat);
        }
      }
      catOf[i] = idx;
    }
    return { cats: cats, catOf: catOf, k: cats.length, groupPos: gPos };
  }

  /**
   * 类别排序（契约 3.C1 第 2 条）
   *   无 Sorter → 类别键升序（单列数值/时间按数值，否则字典序）
   *   有 Sorter → 按该类别上 sorter 列的聚合值（数值/时间 = 均值，字符 = 字典序最小值）多级排序
   * @returns {{order:Array<number>, kept:number, truncated:boolean}}
   */
  function orderCategories(cats, catOf, members, ctx, k) {
    var view = ctx.view, rowIdx = view.rowIdx;
    var i, s;
    var order = new Array(k);
    for (i = 0; i < k; i++) order[i] = i;

    if (ctx.sorters.length) {
      var accs = [];
      for (s = 0; s < ctx.sorters.length; s++) {
        var col = ctx.df.cols[ctx.sorters[s].ci];
        if (col.type === T.STRING) accs.push({ numeric: false, mins: new Array(k), dir: ctx.sorters[s].dir });
        else accs.push({ numeric: true, sums: new Float64Array(k), cnts: new Int32Array(k), dir: ctx.sorters[s].dir });
      }
      var n = members.length;
      for (i = 0; i < n; i++) {
        var ci = catOf[i];
        var r = rowIdx ? rowIdx[members[i]] : members[i];
        for (s = 0; s < accs.length; s++) {
          var c = ctx.df.cols[ctx.sorters[s].ci];
          var raw = c.values[r];
          if (accs[s].numeric) {
            if (raw === raw) { accs[s].sums[ci] += raw; accs[s].cnts[ci]++; }
          } else if (raw >= 0) {
            var str = c.dict[raw];
            if (accs[s].mins[ci] === undefined || str < accs[s].mins[ci]) accs[s].mins[ci] = str;
          }
        }
      }
      order.sort(function (a, b) {
        for (var q = 0; q < accs.length; q++) {
          var acc = accs[q], av, bv, an, bn;
          if (acc.numeric) {
            an = acc.cnts[a] > 0; bn = acc.cnts[b] > 0;
            av = an ? acc.sums[a] / acc.cnts[a] : 0;
            bv = bn ? acc.sums[b] / acc.cnts[b] : 0;
          } else {
            an = acc.mins[a] !== undefined; bn = acc.mins[b] !== undefined;
            av = acc.mins[a]; bv = acc.mins[b];
          }
          if (an !== bn) return an ? -1 : 1;            // 无效值恒排最后
          if (!an) continue;
          var res = av < bv ? -1 : (av > bv ? 1 : 0);
          if (res !== 0) return res * acc.dir;
        }
        return 0;                                        // 全相等 → 保持稳定（首现顺序）
      });
      return { order: order, kept: k, truncated: false };
    }

    /* N 级分组：**逐级分层排序** —— 先级 0 的组序（有 groupMap 用面板 order，否则首现序），
       再级 1，…，最后叶子标签文本序。保证「同一级同值」的类别连续成块
       （合并标签 / 分组带都靠「连续同类」成块，故组序号是首要键）。 */
    var nLev = (cats.length && cats[0].groupLabels) ? cats[0].groupLabels.length : 0;
    if (nLev > 0) {
      var lvRank = [], lvBeyond = [], lvFirst = [], L, q2, rk, fst;
      for (L = 0; L < nLev; L++) {
        var lcol = ctx.xCols[L] || {};
        var prefL = lcol.order || [];
        rk = Object.create(null);
        for (q2 = 0; q2 < prefL.length; q2++) if (rk[prefL[q2]] === undefined) rk[prefL[q2]] = q2;
        fst = Object.create(null);
        for (q2 = 0; q2 < k; q2++) {
          var vL = cats[q2] && cats[q2].groupLabels ? cats[q2].groupLabels[L] : undefined;
          if (fst[vL] === undefined) fst[vL] = q2;
        }
        lvRank.push(rk); lvBeyond.push(prefL.length + k); lvFirst.push(fst);
      }
      order.sort(function (a, b) {
        for (var L2 = 0; L2 < nLev; L2++) {
          var va = cats[a].groupLabels[L2], vb = cats[b].groupLabels[L2];
          var ra = lvRank[L2][va], rb = lvRank[L2][vb];
          if (ra === undefined) ra = lvBeyond[L2] + lvFirst[L2][va];
          if (rb === undefined) rb = lvBeyond[L2] + lvFirst[L2][vb];
          if (ra !== rb) return ra - rb;
        }
        return cmpText(cats[a].subLabel, cats[b].subLabel);
      });
      return { order: order, kept: k, truncated: false, groupOrdered: (ctx.xCols[0] || {}).name };
    }

    /* 分组派生列的用户定义顺序（迭代 25 · 按值分组）
       col.order = 组名按 UI 里排的顺序；**仅在没有 Sorter 时生效** —— 显式 Sorter
       是用户更明确的意图。不在 order 里的类别排在已知类别之后，并保持首现顺序
       （sort 稳定 + 用 INF + 下标 做二级键，绝不把它们挤成随机序）。 */
    var pref = (ctx.xCols.length === 1 && ctx.xCols[0] && ctx.xCols[0].order) ? ctx.xCols[0].order : null;
    if (pref && pref.length) {
      var rank = Object.create(null);
      for (i = 0; i < pref.length; i++) if (rank[pref[i]] === undefined) rank[pref[i]] = i;
      var beyond = pref.length + k;
      order.sort(function (a, b) {
        var ra = rank[cats[a].label], rb = rank[cats[b].label];
        if (ra === undefined) ra = beyond + a;
        if (rb === undefined) rb = beyond + b;
        return ra - rb;
      });
      return { order: order, kept: k, truncated: false };
    }

    /* 默认：类别键升序 */
    var numericKey = (ctx.xCols.length === 1 && ctx.xCols[0].type !== T.STRING);
    order.sort(function (a, b) {
      if (numericKey) {
        var av = cats[a].num, bv = cats[b].num;
        var an = av === av, bn = bv === bv;
        if (an !== bn) return an ? -1 : 1;               // 无法数值化的类别排最后
        if (an && av !== bv) return av < bv ? -1 : 1;
        return 0;
      }
      var la = cats[a].label, lb = cats[b].label;
      if (la === lb) return 0;
      return la < lb ? -1 : 1;
    });
    return { order: order, kept: k, truncated: false };
  }

  /** 类别数硬上限保护（> CAT_HARD_LIMIT → 只保留前 CAT_KEEP 类，并记 notes） */
  function applyHardLimit(order, k, ctx) {
    if (k <= CAT_HARD_LIMIT) return { order: order, kept: order.length, truncated: false };
    ctx.notes.push('类别数 ' + k + ' 超过上限 ' + CAT_HARD_LIMIT + '，仅绘制前 ' + CAT_KEEP + ' 个类别');
    var o = order.slice(0, CAT_KEEP);
    return { order: o, kept: o.length, truncated: true };
  }

  /* ============================================ 行级 series 分组（迭代 4） */
  /**
   * 行 → 分组标签（首次出现即建索引；label 供 seriesKey 的组标签使用）
   * @returns {{label:string, idx:number}}
   */
  function rowGroupLabel(view, pos, col, dict) {
    var r = view.rowIdx ? view.rowIdx[pos] : pos;
    var c = view.df.cols[col.ci];
    var raw = c.values[r];
    var token = rawToken(c.type, raw);
    var hit = dict.map.get(token);
    if (hit !== undefined) return { label: dict.vals[hit], idx: hit };
    var label;
    if (c.type === T.STRING) label = (raw < 0) ? '(缺失)' : c.dict[raw];
    else label = (raw !== raw) ? '(缺失)' : T.formatValue(raw, c.type, col.decimals, col.timeStyle);
    var idx = dict.vals.length;
    dict.map.set(token, idx);
    dict.vals.push(label);
    return { label: label, idx: idx };
  }

  /**
   * 组标签分段（契约 §2 的 seriesKey 拼接规则）：
   *   仅颜色分组 → [颜色值]          仅符号分组 → ['', 符号值]
   *   两者都要   → [颜色值, 符号值]  叠加同图   → 前缀 [splitBy 组标签]
   */
  function groupLabelParts(ovLabel, colorLabel, symbolLabel, hasColor, hasSymbol) {
    var parts = [];
    if (ovLabel) parts.push(ovLabel);
    if (hasColor) parts.push(colorLabel);
    else if (hasSymbol) parts.push('');               // 保留颜色位 → 'Yield@/A'
    if (hasSymbol) parts.push(symbolLabel);
    return parts;
  }

  /**
   * 计算分面内每个成员行的 series 分组（overlay 组 × colorBy 取值 × symbolBy 取值）
   * 未开启 overlay 且无颜色/符号分组时返回 grouped:false（零额外开销，行为同迭代 3）
   * @returns {{rowGroup:Int32Array, groups:Array<object>, grouped:boolean}}
   */
  function buildGroups(members, ctx) {
    var n = members.length, i;
    var rowGroup = new Int32Array(n);
    var useOv = !!ctx.overlayOn && !!ctx.splitOf;
    var colorCol = ctx.colorCol || null, symCol = ctx.symbolCol || null;
    if (!useOv && !colorCol && !symCol) return { rowGroup: rowGroup, groups: [], grouped: false };

    var out = [], gMap = new Map();
    var cDict = { map: new Map(), vals: [] }, sDict = { map: new Map(), vals: [] };
    var capped = false;
    for (i = 0; i < n; i++) {
      var vi = members[i];
      var ovLabel = useOv ? (ctx.splitLabels[ctx.splitOf[vi]] || '') : '';
      var cRes = colorCol ? rowGroupLabel(ctx.view, vi, colorCol, cDict) : null;
      var sRes = symCol ? rowGroupLabel(ctx.view, vi, symCol, sDict) : null;
      var comb = ovLabel + '\u0002' + (cRes ? cRes.idx : -1) + '\u0002' + (sRes ? sRes.idx : -1);
      var gi = gMap.get(comb);
      if (gi === undefined) {
        if (out.length >= MAX_GROUPS) {                 // 安全阀：多余分组并入最后一组（不丢数据）
          capped = true;
          gi = out.length - 1;
        } else {
          gi = out.length;
          gMap.set(comb, gi);
          var colorLabel = cRes ? cRes.label : '';
          var symbolLabel = sRes ? sRes.label : '';
          out.push({
            key: comb, label: ovLabel || colorLabel || symbolLabel || '',
            overlayLabel: ovLabel, colorLabel: colorLabel, symbolLabel: symbolLabel,
            colorIdx: cRes ? cRes.idx : -1, symbolIdx: sRes ? sRes.idx : -1,
            labels: groupLabelParts(ovLabel, colorLabel, symbolLabel, !!colorCol, !!symCol)
          });
        }
      }
      rowGroup[i] = gi;
    }
    if (capped) ctx.notes.push('series 分组数超过上限 ' + MAX_GROUPS + '，多余分组已并入最后一组（请减少颜色/符号分组列的取值数）');
    return { rowGroup: rowGroup, groups: out, grouped: true };
  }

  /* ============================================ 类别型分面（Line / Bar / Box） */
  function buildCatFacet(members, ctx) {
    var idx = indexCategories(members, ctx);
    var cats = idx.cats, catOf = idx.catOf, k = idx.k;
    if (!k) {
      return {
        cats: [], raw: null, fit: null, hist: null, groups: null,
        merge: { applied: false, groupSize: 1, before: 0, after: 0, limit: null }, mergeNote: ''
      };
    }
    var ord = orderCategories(cats, catOf, members, ctx, k);
    var hard = applyHardLimit(ord.order, k, ctx);
    var order = hard.order, kept = hard.kept;

    /* --- 合并（防拥挤） ---
       迭代 29：带分组标签时**只在组内合并，绝不跨组** —— 否则合并后组标签无法保留
       （旧实现 `if (!merged && ...)` 直接丢弃 groupLabel，导致 Merge=Auto 时分组行永不出现）。
       名额按各段长度比例分配（每段至少 1 格），总数仍不超过 limit。 */
    var limit = effectiveLimit(ctx.chartType, ctx.merge);
    var groupSize = 1, applied = false, after = kept, t;
    var chunkStart = [], chunkEnd = [];
    var hasGL = kept > 0 && cats[order[0]] && cats[order[0]].groupLabel !== undefined;
    if (hasGL) {
      for (t = 1; t < kept; t++) {
        if (!cats[order[t]] || cats[order[t]].groupLabel === undefined) { hasGL = false; break; }
      }
    }
    if (limit !== null && kept > limit && hasGL) {
      /* ① 按**最深层分组 tuple** 切连续段（N 级：合并块绝不跨越任何一级的边界） */
      var runs = [], curLabel = catGroupKey(cats[order[0]]), curStart = 0, q;
      for (q = 1; q < kept; q++) {
        var ql = catGroupKey(cats[order[q]]);
        if (ql !== curLabel) { runs.push({ s: curStart, e: q, label: curLabel }); curLabel = ql; curStart = q; }
      }
      runs.push({ s: curStart, e: kept, label: curLabel });
      /* ② 名额按段长比例分配，总数收敛到 limit */
      var slots = [], sumSlots = 0;
      for (q = 0; q < runs.length; q++) {
        var qlen = runs[q].e - runs[q].s;
        var qs = Math.max(1, Math.floor(limit * qlen / kept));
        slots.push(qs); sumSlots += qs;
      }
      while (sumSlots > limit) {
        var bigI = -1, bigVal = 1;
        for (q = 0; q < slots.length; q++) {
          if (slots[q] > bigVal && (runs[q].e - runs[q].s) > slots[q]) { bigVal = slots[q]; bigI = q; }
        }
        if (bigI < 0) break;
        slots[bigI]--; sumSlots--;
      }
      /* ③ 段内等分 */
      for (q = 0; q < runs.length; q++) {
        var qL = runs[q].e - runs[q].s, qN = Math.min(slots[q], qL), qCs = Math.ceil(qL / qN), qp;
        for (qp = runs[q].s; qp < runs[q].e; qp += qCs) {
          chunkStart.push(qp); chunkEnd.push(Math.min(qp + qCs, runs[q].e));
        }
      }
      after = chunkStart.length;
      applied = true;
      groupSize = Math.max(1, Math.round(kept / Math.max(1, after)));   // 名义值，仅用于摘要文案
    } else if (limit !== null && kept > limit) {
      groupSize = Math.ceil(kept / limit);
      after = Math.ceil(kept / groupSize);
      applied = true;
      for (t = 0; t < kept; t += groupSize) { chunkStart.push(t); chunkEnd.push(Math.min(t + groupSize, kept)); }
      after = chunkStart.length;
    } else {
      for (t = 0; t < kept; t++) { chunkStart.push(t); chunkEnd.push(t + 1); }
    }
    var groupOfCat = new Int32Array(k);
    for (t = 0; t < k; t++) groupOfCat[t] = -1;
    for (t = 0; t < chunkStart.length; t++) {
      for (var tp = chunkStart[t]; tp < chunkEnd[t]; tp++) groupOfCat[order[tp]] = t;
    }

    /* --- 行级 series 分组（迭代 4）--- */
    var grp = buildGroups(members, ctx);
    var nsG = grp.grouped ? Math.max(1, grp.groups.length) : 1;

    /* --- 组内统计（组内全部原始数据重算；分组时再按 series 分组各算一份） --- */
    var perColGlobal = [], perColGroup = [];
    for (var v = 0; v < ctx.valueCols.length; v++) {
      var vc = ctx.valueCols[v];
      var gAll = groupStats(members, catOf, groupOfCat, after, ctx, vc, null, 1);
      perColGlobal.push(gAll);
      perColGroup.push(nsG > 1 ? groupStats(members, catOf, groupOfCat, after, ctx, vc, grp.rowGroup, nsG) : gAll);
    }

    /* --- 输出类别（= 合并后的组）---
       迭代 15 ③（用户口径）：合并组标签只显示「该组代表值」= 组内**首个**类别名
       （如 L0064），不再拼 `L0064~L0096` 范围 —— 标签变短后同一张图能显示更多标签。
       完整范围不丢：仍保留 range / from / to，并合成 fullLabel 供 tooltip 使用
       （如 `L0064（L0064~L0096，27 类）`）；合并摘要文案（mergeText）不变。 */
    var out = new Array(after);
    for (var g = 0; g < after; g++) {
      var cS = chunkStart[g], cE = chunkEnd[g];
      var firstCat = cats[order[cS]];
      var lastPos = cE - 1;
      var lastCat = cats[order[lastPos]];
      var merged = (cE - cS) > 1;
      var label = firstCat.label;                                   // 代表值（组内首个类别）
      var range = merged ? (firstCat.label + '~' + lastCat.label) : '';
      var groupCats = cE - cS;                                      // 该组实际类别数（末组可能不足）
      var stats = {};
      for (var v2 = 0; v2 < ctx.valueCols.length; v2++) stats[ctx.valueCols[v2].name] = perColGlobal[v2][g];
      var cat = { key: label, label: label, count: perColGlobal.length ? perColGlobal[0][g].n : 0, stats: stats };
      /* 迭代 28/29：第二层合并标签的数据 —— 合并已限定在组内（绝不跨组），故合并后同样保留 */
      if (firstCat.groupLabel !== undefined) {
        cat.groupLabel = firstCat.groupLabel;
        cat.subLabel = (firstCat.subLabel === undefined) ? label : firstCat.subLabel;
        /* N 级：合并块在组内切分 → 该块全部类别的完整 tuple 相同，直接继承 */
        if (firstCat.groupLabels) cat.groupLabels = firstCat.groupLabels.slice();
      }
      if (merged) {
        cat.group = groupSize;
        cat.from = firstCat.key;
        cat.to = lastCat.key;
        cat.range = range;                                          // 完整范围（数据不丢）
        cat.groupCats = groupCats;
        cat.fullLabel = label + '（' + range + '，' + groupCats + ' 类）';   // tooltip 头行
      }
      out[g] = cat;
    }

    /* --- 每个 series 分组各自的类别统计（契约 §3.1：只含该组该类别的统计量）--- */
    var groups = null;
    if (nsG > 1) {
      groups = grp.groups.map(function (gg, gi) {
        var gcats = new Array(after);
        for (var g2 = 0; g2 < after; g2++) {
          var c0 = out[g2];
          var st = {};
          for (var v3 = 0; v3 < ctx.valueCols.length; v3++) {
            st[ctx.valueCols[v3].name] = perColGroup[v3][gi * after + g2];
          }
          gcats[g2] = {
            key: c0.key, label: c0.label,
            count: perColGroup.length ? perColGroup[0][gi * after + g2].n : 0,
            stats: st
          };
          if (c0.group) {
            gcats[g2].group = c0.group; gcats[g2].from = c0.from; gcats[g2].to = c0.to;
            /* 迭代 15 ③：范围 / tooltip 文案随组一起带给每个 series 分组 */
            gcats[g2].range = c0.range; gcats[g2].groupCats = c0.groupCats; gcats[g2].fullLabel = c0.fullLabel;
          }
        }
        return {
          key: gg.key, label: gg.label, labels: gg.labels,
          overlayLabel: gg.overlayLabel, colorLabel: gg.colorLabel, symbolLabel: gg.symbolLabel,
          colorIdx: gg.colorIdx, symbolIdx: gg.symbolIdx,
          cats: gcats, raw: null
        };
      });
    }

    var merge = { applied: applied, groupSize: groupSize, before: k, after: after, limit: limit };
    return {
      cats: out, raw: null, fit: null, hist: null, groups: groups,
      merge: merge, mergeNote: applied ? mergeText(merge) : ''
    };
  }

  /**
   * 组内统计（组内全部原始数据；绝不"先算类均值再平均"）
   * 三步：① 计数 ② 前缀和 + 填充 ③ 逐组排序求分位数 / 总体标准差
   * @param {Int32Array|null} rowGroup 行 → series 分组下标（null = 不分组）
   * @param {number} nsG series 分组数（1 = 不分组，输出与迭代 3 完全一致 + std）
   * @returns {Array<object>} 扁平数组，下标 = seriesGroup * ng + catGroup，
   *          每项 {n,mean,min,max,median,q1,q3,std}
   */
  function groupStats(members, catOf, groupOfCat, ng, ctx, vc, rowGroup, nsG) {
    var view = ctx.view;
    var n = members.length, i, g;
    nsG = nsG || 1;
    var total = ng * nsG;
    var stat = new Array(total);
    if (!total) return stat;

    /* ① 计数 */
    var cnt = new Int32Array(total);
    for (i = 0; i < n; i++) {
      var gi0 = groupOfCat[catOf[i]];
      if (gi0 < 0) continue;
      var x = view.numericAt(members[i], vc.ci);
      if (x !== x || !isFinite(x)) continue;          /* NaN / ±Infinity 不参与统计 */
      cnt[(rowGroup ? rowGroup[i] : 0) * ng + gi0]++;
    }
    /* ② 前缀和 + 填充 */
    var off = new Int32Array(total + 1);
    for (g = 1; g <= total; g++) off[g] = off[g - 1] + cnt[g - 1];
    var buf = new Float64Array(off[total]);
    var cur = new Int32Array(total);
    for (i = 0; i < n; i++) {
      var gi2 = groupOfCat[catOf[i]];
      if (gi2 < 0) continue;
      var x2 = view.numericAt(members[i], vc.ci);
      if (x2 !== x2 || !isFinite(x2)) continue;
      var b = (rowGroup ? rowGroup[i] : 0) * ng + gi2;
      buf[off[b] + cur[b]++] = x2;
    }
    /* ③ 逐组统计（std = 总体标准差，分母 N，与 df.stats.stddev 一致） */
    for (g = 0; g < total; g++) {
      var lo = off[g], hi = off[g + 1], m = hi - lo;
      if (!m) { stat[g] = { mean: null, min: null, max: null, median: null, q1: null, q3: null, std: null, n: 0 }; continue; }
      if (m === 1) {
        var one = buf[lo];
        stat[g] = { mean: one, min: one, max: one, median: one, q1: one, q3: one, std: 0, n: 1 };
        continue;
      }
      var part = buf.subarray(lo, hi);           // 段间不重叠，可原地排序
      var sum = 0;
      for (i = 0; i < m; i++) sum += part[i];
      var mean = sum / m;
      part.sort();                               // Float64Array.sort = 数值升序
      var ss = 0;
      for (i = 0; i < m; i++) { var dv = part[i] - mean; ss += dv * dv; }
      stat[g] = {
        mean: mean, min: part[0], max: part[m - 1],
        median: quantileSorted(part, m, 0.5),
        q1: quantileSorted(part, m, 0.25),
        q3: quantileSorted(part, m, 0.75),
        std: Math.sqrt(ss / m),
        n: m
      };
    }
    return stat;
  }

  /* ============================================================ 直方图分面 */
  function buildHistFacet(members, ctx) {
    var view = ctx.view, vc = ctx.valueCols[0];
    var n = members.length, i, j;
    var raw = new Float64Array(n), m = 0, mn = Infinity, mx = -Infinity;
    for (i = 0; i < n; i++) {
      var v = view.numericAt(members[i], vc.ci);
      if (v !== v || !isFinite(v)) continue;
      raw[m++] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!m) {
      return {
        cats: [], raw: null, fit: null, hist: null, groups: null,
        merge: { applied: false, groupSize: 1, before: 0, after: 0, limit: null }, mergeNote: ''
      };
    }
    var vals = raw.subarray(0, m);
    var bins = ctx.histBins;
    var auto = false;
    if (!bins) { bins = Math.ceil(Math.log2(m) + 1); auto = true; }   // Sturges
    bins = clampInt(bins, 5, 80);
    var width = (mx - mn) / bins;
    if (!(width > 0)) { width = 1; mx = mn + width * bins; }

    var counts = new Int32Array(bins), sums = new Float64Array(bins);
    var binOf = new Int32Array(n);                  // 行 → 箱下标（供箱内统计）
    var binSeq = new Int32Array(bins);              // 恒等映射（每箱自成一"组"）
    for (j = 0; j < bins; j++) binSeq[j] = j;
    for (i = 0; i < n; i++) {
      var val = raw[i];
      binOf[i] = -1;
      if (!(val === val) || i >= m) continue;
      var bi = Math.floor((val - mn) / width);
      if (bi < 0) bi = 0;
      if (bi >= bins) bi = bins - 1;
      binOf[i] = bi;
      counts[bi]++;
      sums[bi] += val;
    }
    /* 每箱 mean/median/q1/q3/std/min/max（按箱内原始数据重算，供横轴统计行） */
    var binStats = groupStats(members, binOf, binSeq, bins, ctx, vc, null, 1);

    var dec = vc.decimals;
    if (dec === null || dec === undefined) {
      /* 未指定小数位时按箱宽自动取精度，保证刻度标签紧凑（如 87.21 而非 87.212857…） */
      dec = (!(width > 0)) ? 2 : Math.max(0, Math.min(6, Math.ceil(-Math.log(width) / Math.LN10) + 1));
    }
    var binCats = new Array(bins);
    for (i = 0; i < bins; i++) {
      var a = mn + width * i, b = mn + width * (i + 1);
      var full = '[' + T.formatValue(a, T.NUMBER, dec, null) + ', ' +
        T.formatValue(b, T.NUMBER, dec, null) + (i === bins - 1 ? ']' : ')');
      /* 刻度标签用紧凑形式（箱左边界），完整区间放 fullLabel 供 tooltip 使用，
         避免区间文本过长触发轴标签截断（如 "[86.42, 87.21)" → "…212857, …"） */
      var label = T.formatValue(a, T.NUMBER, dec, null);
      var bs = binStats[i] || {};
      var st = {};
      st[vc.name] = {
        n: counts[i], mean: counts[i] ? sums[i] / counts[i] : null,
        min: bs.n ? bs.min : null, max: bs.n ? bs.max : null,
        median: bs.n ? bs.median : null, q1: bs.n ? bs.q1 : null, q3: bs.n ? bs.q3 : null,
        std: bs.n ? bs.std : null
      };
      binCats[i] = { key: full, label: label, fullLabel: full, count: counts[i], stats: st, binLo: a, binHi: b, _sum: sums[i] };
    }

    /* 合并（Hist 自动不限；手动/指定上限时相邻箱合并，均值由 Σ和/Σ计数精确重算） */
    var limit = effectiveLimit('hist', ctx.merge);
    var applied = false, groupSize = 1, out = binCats;
    if (limit !== null && binCats.length > limit) {
      groupSize = Math.ceil(binCats.length / limit);
      var gAfter = Math.ceil(binCats.length / groupSize);
      out = new Array(gAfter);
      for (i = 0; i < gAfter; i++) {
        var lo = i * groupSize, hi = Math.min(lo + groupSize, binCats.length) - 1;
        var c0 = binCats[lo], c1 = binCats[hi];
        var sc = 0, ss = 0;
        for (j = lo; j <= hi; j++) { sc += binCats[j].count; ss += binCats[j]._sum; }
        var lbl = T.formatValue(c0.binLo, T.NUMBER, dec, null) + '~' + T.formatValue(c1.binHi, T.NUMBER, dec, null);
        var fullLbl = '[' + T.formatValue(c0.binLo, T.NUMBER, dec, null) + ', ' + T.formatValue(c1.binHi, T.NUMBER, dec, null) + ')';
        var st2 = {};
        st2[vc.name] = {
          n: sc, mean: sc ? ss / sc : null,
          min: (c0.stats[vc.name] && c0.stats[vc.name].n) ? c0.stats[vc.name].min : null,
          max: (c1.stats[vc.name] && c1.stats[vc.name].n) ? c1.stats[vc.name].max : null,
          median: null, q1: null, q3: null, std: null
        };
        out[i] = {
          key: fullLbl, label: lbl,
          fullLabel: (sc === 0 ? lbl : fullLbl + ' 共 ' + sc + ' 点'),
          count: sc, stats: st2, binLo: c0.binLo, binHi: c1.binHi
        };
      }
      applied = true;
    }
    if (auto) ctx.notes.push('直方图柱数自动 = ' + bins + '（Sturges：ceil(log2(n)+1)，n = ' + m + '）');
    var hist = { bins: bins, min: mn, max: mx, width: width };
    var merge = { applied: applied, groupSize: groupSize, before: binCats.length, after: out.length, limit: limit };
    return {
      cats: out, raw: { xs: vals, series: null }, hist: hist, fit: null, groups: null,
      merge: merge, mergeNote: applied ? mergeText(merge) : ''
    };
  }

  /* ============================================================== 散点图分面 */
  function buildScatterFacet(members, ctx) {
    var view = ctx.view;
    var n = members.length, i, j;
    var xCol = ctx.xCols[0];
    var useRealX = xCol.type !== T.STRING;
    var cats = null, catOf = null, posOfCat = null;

    if (!useRealX) {
      var idx = indexCategories(members, ctx);
      var ord = orderCategories(idx.cats, idx.catOf, members, ctx, idx.k);
      cats = new Array(idx.k);
      posOfCat = new Int32Array(idx.k);
      for (i = 0; i < ord.order.length; i++) {
        var old = ord.order[i];
        posOfCat[old] = i;
        var st = {};
        for (j = 0; j < ctx.valueCols.length; j++) {
          st[ctx.valueCols[j].name] = { mean: null, min: null, max: null, median: null, q1: null, q3: null, std: null, n: 0 };
        }
        var src = idx.cats[old];
        cats[i] = { key: src.label, label: src.label, count: 0, stats: st };
        /* 任务 G ②：scatter 也要享受「横轴自动分组合并」——
           通用路径 indexCategories 已在类别上写好 groupLabels / groupLabel / subLabel，
           这里必须原样带过来，否则 groupMergeOf() 判 nL=0 / subLabel===undefined → 合并永不启用。
           只在真有分组层时才挂（无分组时对象形状与改前逐字相同 → 零变化红线）。 */
        if (src.groupLabels) {
          cats[i].groupLabels = src.groupLabels.slice();
          cats[i].groupLabel = src.groupLabel;
          cats[i].subLabel = src.subLabel;
        }
      }
      catOf = idx.catOf;
    }

    /* 行级 series 分组（迭代 4）：分组时每条 (组 × Value 列) 一条 series */
    var grp = buildGroups(members, ctx);
    var nsG = grp.grouped ? Math.max(1, grp.groups.length) : 1;

    var series = [];
    var notes = [];
    var xsTmp = new Float64Array(n), ysTmp = new Float64Array(n);
    for (var gi = 0; gi < nsG; gi++) {
      for (var v = 0; v < ctx.valueCols.length; v++) {
        var vc = ctx.valueCols[v];
        var m = 0;
        for (i = 0; i < n; i++) {
          if (nsG > 1 && grp.rowGroup[i] !== gi) continue;
          var y = view.numericAt(members[i], vc.ci);
          var x = useRealX ? view.numericAt(members[i], xCol.ci) : posOfCat[catOf[i]];
          if (x !== x || y !== y || !isFinite(x) || !isFinite(y)) continue;
          xsTmp[m] = x; ysTmp[m] = y; m++;
        }
        var xsAll = xsTmp.slice(0, m), ysAll = ysTmp.slice(0, m);
        var xs = xsAll, ys = ysAll, sampled = false;
        if (m > SCATTER_MAX_POINTS) {
          var stride = Math.ceil(m / SCATTER_MAX_POINTS);
          var k2 = Math.ceil(m / stride);
          xs = new Float64Array(k2); ys = new Float64Array(k2);
          for (j = 0; j < k2; j++) { xs[j] = xsAll[j * stride]; ys[j] = ysAll[j * stride]; }
          sampled = true;
        }
        var gg = nsG > 1 ? grp.groups[gi] : null;
        series.push({
          colName: vc.name,
          key: seriesKey(vc.name, gg ? gg.labels : []),
          groupLabel: gg ? gg.label : '',
          labels: gg ? gg.labels.slice() : [],
          overlayLabel: gg ? gg.overlayLabel : '',
          colorLabel: gg ? gg.colorLabel : '',
          symbolLabel: gg ? gg.symbolLabel : '',
          colorIdx: gg ? gg.colorIdx : -1,
          symbolIdx: gg ? gg.symbolIdx : -1,
          groupIdx: gi,
          xs: xs, ys: ys, xsAll: xsAll, ysAll: ysAll, sampled: sampled, rawCount: m
        });
      }
    }

    /* 拟合：把全部点（xsAll/ysAll）交给 YMS.Fitting，Aggregate 不实现拟合算法。
       fit === 'none' → facet.fit = null；否则每条 series 一条记录（键 = seriesKey）：
         {ok:true, method, formula, r2, coefficients, predict, n, note} 或 {ok:false, reason}
       （YMS.Fitting 未加载 / 数据不足 / 拟合退化 都记 ok:false，不抛异常） */
    var fit = null;
    if (ctx.fit && ctx.fit !== 'none') {
      fit = {};
      var hasFitting = !!(YMS.Fitting && typeof YMS.Fitting.fit === 'function');
      if (!hasFitting) {
        notes.push('拟合模块（YMS.Fitting）未加载，已跳过 ' + ctx.fit + ' 拟合');
      }
      for (j = 0; j < series.length; j++) {
        var s = series[j];
        if (!s.rawCount) { fit[s.key] = { ok: false, reason: '无有效数据点' }; continue; }
        if (!hasFitting) { fit[s.key] = { ok: false, reason: '拟合模块未加载' }; continue; }
        try {
          var r = YMS.Fitting.fit(s.xsAll, s.ysAll, ctx.fit, ctx.fitOrder);   // 用全量点，非抽稀点
          if (r && r.ok) {
            fit[s.key] = r;
          } else {
            fit[s.key] = { ok: false, reason: (r && r.reason) ? r.reason : '拟合失败' };
            notes.push('拟合（' + s.key + '）未完成：' + fit[s.key].reason);
          }
        } catch (e) {
          fit[s.key] = { ok: false, reason: '拟合异常：' + (e && e.message ? e.message : String(e)) };
          notes.push('拟合（' + s.key + '）异常：' + (e && e.message ? e.message : String(e)));
        }
      }
    }

    /* 类别轴时：统计每类点数（供提示/悬浮）+ 每类统计量（统计行/分组共用） */
    if (cats) {
      for (i = 0; i < n; i++) {
        var pc = posOfCat[catOf[i]];
        if (pc >= 0 && pc < cats.length) cats[pc].count++;
      }
      for (var v2 = 0; v2 < ctx.valueCols.length; v2++) {
        var flat = groupStats(members, catOf, posOfCat, cats.length, ctx, ctx.valueCols[v2], null, 1);
        for (i = 0; i < cats.length; i++) cats[i].stats[ctx.valueCols[v2].name] = flat[i];
      }
    }

    /* 每个 series 分组各自的点集（契约 §3.1：groups[i].raw = 该组点集） */
    var groups = null;
    if (nsG > 1) {
      var gFlat = [];
      if (cats) {
        for (var v3 = 0; v3 < ctx.valueCols.length; v3++) {
          gFlat.push(groupStats(members, catOf, posOfCat, cats.length, ctx, ctx.valueCols[v3], grp.rowGroup, nsG));
        }
      }
      groups = grp.groups.map(function (gg, gidx) {
        var gcats = null;
        if (cats) {
          gcats = new Array(cats.length);
          for (var g2 = 0; g2 < cats.length; g2++) {
            var st2 = {};
            for (var v4 = 0; v4 < ctx.valueCols.length; v4++) {
              st2[ctx.valueCols[v4].name] = gFlat[v4][gidx * cats.length + g2];
            }
            gcats[g2] = { key: cats[g2].key, label: cats[g2].label, count: st2[ctx.valueCols[0].name].n, stats: st2 };
          }
        }
        var gser = series.filter(function (s2) { return s2.groupIdx === gidx; });
        return {
          key: gg.key, label: gg.label, labels: gg.labels,
          overlayLabel: gg.overlayLabel, colorLabel: gg.colorLabel, symbolLabel: gg.symbolLabel,
          colorIdx: gg.colorIdx, symbolIdx: gg.symbolIdx,
          cats: gcats || [], raw: { xs: null, series: gser }
        };
      });
    }

    var first = series[0];
    var sub = (first && first.sampled)
      ? ('已抽稀 ' + first.xs.length + '/' + first.rawCount + '（拟合仍使用全部点）')
      : '';
    for (i = 0; i < notes.length; i++) ctx.notes.push(notes[i]);
    return {
      /* cats 始终保持数组（契约形状）：数值 X 的散点没有类别轴 → 空数组 */
      cats: cats || [], raw: { xs: null, series: series },
      merge: { applied: false, groupSize: 1, before: cats ? cats.length : 0, after: cats ? cats.length : 0, limit: null },
      fit: fit, hist: null, groups: groups, sampleNote: sub, mergeNote: ''
    };
  }

  /* =========================================================== chartOf */
  /**
   * 按扁平序号（0 基，跨页）取单张图的完整数据（ChartBuilder / Fullscreen / Report 使用）
   * @returns {object|null} ChartData
   */
  function chartOf(work, index) {
    if (!work || !work.pages) return null;
    var flat = 0, found = null, pageLabel = '', pageKey = '';
    for (var p = 0; p < work.pages.length; p++) {
      var pg = work.pages[p];
      for (var f = 0; f < pg.facets.length; f++) {
        if (flat === index) { found = pg.facets[f]; pageLabel = pg.label; pageKey = pg.key; break; }
        flat++;
      }
      if (found) break;
    }
    if (!found) return null;
    var sub = [];
    /* 迭代 7：图内副标题不再显示「合并：N → M 组…」提示（用户要求删除图内上方提示）。
       合并信息仍保留在 work.mergeSummary / facet.mergeNote / 页签信息栏等下游用途。 */
    if (found.fit) {
      Object.keys(found.fit).forEach(function (name) {
        var r = found.fit[name];
        if (!r || !r.ok) {
          sub.push('拟合 ' + name + ' 未完成：' + ((r && r.reason) ? r.reason : '拟合失败'));
          return;
        }
        var r2 = (typeof r.r2 === 'number') ? r.r2.toFixed(6) : '—';
        sub.push('拟合 ' + name + '：' + r.formula + '（R² = ' + r2 + '）');
      });
    }
    if (found.sampleNote) sub.push(found.sampleNote);
    return {
      index: index,
      type: work.chartType,
      title: found.title,
      subtext: sub.join('\n'),
      pageKey: pageKey, pageLabel: pageLabel,
      facetKey: found.key, facetLabel: found.label,
      cats: found.cats, raw: found.raw, merge: found.merge, fit: found.fit, hist: found.hist,
      groups: found.groups || null,
      xAxisName: work.xAxisName, xCols: work.xCols, valueCols: work.valueCols,
      style: work.style, notes: work.notes,
      /* 迭代 4：渲染层配置透传给 ChartBuilder */
      display: work.display || 'facet',
      axisSide: work.axisSide || {},
      group: work.group || { colorBy: '', symbolBy: '' },
      stats: work.stats || { show: false, items: [] },
      /* 任务 F：图例 / 图元设置随 ChartData 一起透传（ChartBuilder.legendOf / markOf 读它） */
      legend: work.legend || null,
      mark: work.mark || null
    };
  }

  /** 扁平图序列表（PlotView.getChartMeta / Report 用） */
  function metaList(work) {
    var out = [];
    if (!work || !work.pages) return out;
    var flat = 0;
    for (var p = 0; p < work.pages.length; p++) {
      var pg = work.pages[p];
      for (var f = 0; f < pg.facets.length; f++) {
        out.push({
          index: flat++, title: pg.facets[f].title, subtext: '',
          pageLabel: pg.label, facetLabel: pg.facets[f].label, type: work.chartType
        });
      }
    }
    return out;
  }

  YMS.Aggregate = {
    X_KEY_SEP: X_KEY_SEP,
    build: build,
    chartOf: chartOf,
    metaList: metaList,
    mergeText: mergeText,
    /** 横轴统计量的显示顺序（契约 §1；设置面板与渲染层共用） */
    STAT_ORDER: STAT_ORDER,
    /** 契约 §2：seriesKey(valueColName, groupLabels[]) */
    seriesKey: seriesKey,
    /** 契约 §3.2：seriesList(plot) → [{key,label,valueCol,groupLabel,side}] */
    seriesList: seriesList,
    /** 轴位解析（axisSide → 'left'|'right'） */
    sideOf: sideOf,
    /** 各类图型的自动合并上限（null = 不限），供设置面板文案使用 */
    autoMergeLimit: function (type) {
      var v = AUTO_MERGE_LIMIT[type];
      return (v === undefined || v === null) ? null : v;
    },
    _normalizeStatItems: normalizeStatItems,
    _effectiveLimit: effectiveLimit,
    _quantileSorted: quantileSorted,
    _MAX_GROUPS: MAX_GROUPS
  };
})(typeof window !== 'undefined' ? window : this);
