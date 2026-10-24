/* ==========================================================================
   YMS · js/plot/fullscreen.js
   ---------------------------------------------------------------------------
   职责：单图放大视图（覆盖层）。公开 API：
     YMS.Fullscreen.init()              // 创建 #fullscreen-root（挂 body）+ 绑定窗口/键盘/Store 事件
     YMS.Fullscreen.open(index)         // index = YMS.PlotView.getChartMeta() 的扁平序号（跨页）
     YMS.Fullscreen.close()             // 关闭并 dispose 图表实例
     YMS.Fullscreen.next() / prev()     // 上一张 / 下一张（按扁平序号，越界不动作）
     YMS.Fullscreen.current()           // 当前序号；未打开返回 -1

   依赖（按契约调用，缺失时降级为 toast 提示，绝不抛异常）：
     YMS.util.*                 toasts / DOM 助手
     YMS.PlotView.getChartMeta() -> [{index,title,subtext,pageLabel,facetLabel,type}]
     YMS.Aggregate.build() / chartOf(work, index)
     YMS.ChartBuilder.buildOption(chart, work, index) / TOOLBOX
     YMS.Store.state.ui.panOnly（抓手状态写入此处）

   行为：
     · 覆盖层 DOM 结构：.fs-mask + .fs-panel( .fs-head / .fs-body / .fs-foot )；样式见 css/plot.css。
     · 关闭：✕ / Esc / 点击遮罩。键盘 ← → Esc 仅在打开时监听，且 preventDefault。
     · 缩放：在 buildOption 结果**之上**追加 dataZoom（inside 滚轮缩放 + 拖拽平移、slider 滑杆）
       与 toolbox（restore 还原 / saveAsImage 保存），并放大标题、坐标轴、图例字号（不替换原有样式）。
     · 「抓手」按钮：切换纯平移模式（zoomOnMouseWheel:false / moveOnMouseWheel:true /
       moveOnMouseMove:true / zoomOnMouseMove:false），按钮高亮并把状态写入 Store.state.ui.panOnly。
     · 点击数据点：底部读数区显示「系列名 · X = … · Y = …」（散点 / Box 等均兼容）。
     · 离线约束：file:// 双击可运行（无 fetch/ES module/CDN），ES2017 以内语法。
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util;

  /* ---------------------------------------------------------------- 内部状态 */
  var rootEl = null;          // #fullscreen-root
  var maskEl = null;          // .fs-mask
  var panelEl = null;         // .fs-panel
  var titleEl = null, subEl = null, indexEl = null, bodyEl = null, readoutEl = null, hintEl = null;
  var prevBtn = null, nextBtn = null, panBtn = null;
  var navEl = null;           // 迭代 21：.fs-nav（用于把实测宽度写给标题的居中上限）
  var headEl = null;          // 迭代 21：.fs-head
  var metas = [];             // 打开时的扁平图表元数据快照
  var idx = -1;               // 当前序号
  var inst = null;            // ECharts 实例
  var zoomWin = null;         // 迭代 9：当前 X 轴 dataZoom 窗口（{start,end} 百分比；null = 全量）
  var zoomWinY = null;        // 迭代 9：当前 Y 轴 dataZoom 窗口（重渲染时不丢缩放）
  var zoomTimer = 0;          // 缩放同步去抖计时器
  var hostEl = null;          // 图表宿主 div
  var lastOpt = null;         // 最近一次的 option（用于读数区判断 X 轴类型）
  var keyBound = false;       // 键盘监听是否已绑定
  var inited = false;         // init() 是否已执行

  var HINT = '滚轮缩放 · 拖拽平移 · ← → 切换小图 · Esc 关闭 · 点击数据点查看读数';

  /* -------------------------------------------------------------- 小工具 */

  function isOpen() { return !!(rootEl && idx >= 0); }

  function toast(msg, kind) {
    if (U && U.toast) U.toast(msg, kind || 'warn');
  }

  /** 读取 Store 中的抓手状态（未就绪时按 false） */
  function isPanOnly() {
    var st = YMS.Store && YMS.Store.state ? YMS.Store.state : null;
    return !!(st && st.ui && st.ui.panOnly);
  }

  /** 写入 Store 抓手状态（单一数据来源），失败静默 */
  function setPanOnly(v) {
    try {
      if (YMS.Store && YMS.Store.state && YMS.Store.state.ui) YMS.Store.state.ui.panOnly = !!v;
      if (YMS.Store && YMS.Store.emit) YMS.Store.emit('ui', { panOnly: !!v });
    } catch (e) { /* 状态写入失败不影响视图 */ }
  }

  function panelRoot() {
    if (rootEl) return rootEl;
    rootEl = (global.document && document.getElementById) ? document.getElementById('fullscreen-root') : null;
    return rootEl;
  }

  /* ---------------------------------------------------------------- DOM 构建 */

  /** 创建 / 复用 #fullscreen-root 并构建内部结构（幂等） */
  function ensureRoot() {
    if (!global.document || !document.body) return null;
    if (!panelRoot()) {
      rootEl = U.el('div', { id: 'fullscreen-root' });
      document.body.appendChild(rootEl);
    }
    if (rootEl.getAttribute && rootEl.getAttribute('data-fs-built') === '1') return rootEl;

    /* 用 innerHTML='' 清空（幂等，且不依赖 firstChild 遍历：Node 测试桩下 U.clear 会死循环） */
    rootEl.innerHTML = '';

    maskEl = U.el('div', { class: 'fs-mask' });
    panelEl = U.el('div', { class: 'fs-panel' });

    /* 头部：标题 / 副标题 + 导航 */
    titleEl = U.el('span', { class: 'fs-title', text: '—' });
    subEl = U.el('span', { class: 'fs-sub', text: '' });
    var titles = U.el('div', { class: 'fs-titles' }, [titleEl, subEl]);

    prevBtn = U.el('button', { class: 'fs-btn', type: 'button', title: '上一张（←）', text: '◀ 上一图',
      onclick: function () { YMS.Fullscreen.prev(); } });
    indexEl = U.el('span', { class: 'fs-index', text: '— / —' });
    nextBtn = U.el('button', { class: 'fs-btn', type: 'button', title: '下一张（→）', text: '下一图 ▶',
      onclick: function () { YMS.Fullscreen.next(); } });
    panBtn = U.el('button', { class: 'fs-btn', type: 'button', title: '切换纯平移模式（滚轮平移，不缩放）',
      text: '✋ 抓手', onclick: function () { togglePanOnly(); } });
    var closeBtn = U.el('button', { class: 'fs-btn is-close', type: 'button', title: '关闭（Esc）', text: '✕',
      onclick: function () { YMS.Fullscreen.close(); } });

    var nav = U.el('div', { class: 'fs-nav' }, [prevBtn, indexEl, nextBtn, panBtn, closeBtn]);
    var head = U.el('div', { class: 'fs-head' }, [titles, nav]);
    navEl = nav;
    headEl = head;

    /* 图表区 */
    bodyEl = U.el('div', { class: 'fs-body' });

    /* 底部：提示 + 读数区 */
    hintEl = U.el('span', { class: 'fs-hint', text: HINT });
    readoutEl = U.el('span', { class: 'fs-readout', text: '—' });
    var foot = U.el('div', { class: 'fs-foot' }, [hintEl, readoutEl]);

    panelEl.appendChild(head);
    panelEl.appendChild(bodyEl);
    panelEl.appendChild(foot);
    maskEl.appendChild(panelEl);
    rootEl.appendChild(maskEl);

    /* 关闭交互：点击遮罩空白处 */
    maskEl.addEventListener('click', function (e) { if (e.target === maskEl) YMS.Fullscreen.close(); });
    panelEl.addEventListener('click', function (e) { if (e.target === panelEl) YMS.Fullscreen.close(); });

    if (rootEl.setAttribute) rootEl.setAttribute('data-fs-built', '1');
    syncPanButton();
    return rootEl;
  }

  /* ------------------------------------------------------------------ 图表 */

  /** 初始化图表宿主与实例（含主题回退） */
  function ensureInstance() {
    if (inst) return inst;
    if (!bodyEl) return null;
    if (typeof global.echarts === 'undefined' || !global.echarts || typeof global.echarts.init !== 'function') {
      toast('图表库未就绪，无法放大查看', 'error');
      return null;
    }
    bodyEl.innerHTML = '';
    hostEl = U.el('div', { class: 'echarts-host' });
    bodyEl.appendChild(hostEl);
    var chart = null;
    try { chart = global.echarts.init(hostEl, 'yms-registered'); } catch (e) { chart = null; }
    if (!chart) {
      try { chart = global.echarts.init(hostEl); } catch (e2) { chart = null; }
    }
    if (!chart) { toast('图表初始化失败', 'error'); return null; }
    chart.on('click', onPointClick);
    /* 迭代 9：dataZoom 后横轴统计块的数值行必须跟着缩放后的类别中心重排（否则指向错误类别） */
    chart.on('dataZoom', onDataZoom);
    /* 任务 H：图例开关 / 工具箱还原会让 ECharts 重跑箱线布局（实测关一个图例项后箱体偏 8.54px）
       → 这两个动作之后补一次对位（幂等）。 */
    try {
      var realign = function () { alignBoxes(chart); global.setTimeout(function () { alignBoxes(chart); }, 40); };
      chart.on('legendselectchanged', realign);
      chart.on('restore', realign);
    } catch (eB) { /* 绑定失败不影响显示 */ }
    inst = chart;
    return inst;
  }

  /** 任务 H：对位（幂等；ChartBuilder 未就绪 / 非箱线图时静默返回） */
  function alignBoxes(inst) {
    try {
      var C = YMS.ChartBuilder;
      if (C && typeof C.alignBoxSeries === 'function') return C.alignBoxSeries(inst);
    } catch (e) { /* 纯视觉修正，失败不影响显示 */ }
    return null;
  }

  /**
   * 迭代 9：类别索引 → 当前像素中心 x 的映射（取 ECharts 自身刻度标度，保证与 Box / 刻度严格一致）。
   * 仅在处于缩放态（zoomWin 非空）时返回映射；未缩放时返回 null（由带宽公式推导即可，逐值一致）。
   * 注意 x 轴是 ordinal 标度：其 extent = [lo, hi]（整数序号，缩放后 lo/hi 会变），
   * 映射为 rect.x + ((i + 0.5) − lo) / (hi − lo + 1) × rect.width（除数含 +1，与实测 convertToPixel 完全一致）。
   */
  function axisCenterOf(chart) {
    if (!zoomWin || !chart) return null;
    try {
      var axM = chart.getModel().getComponent('xAxis', 0);
      var rect = chart.getModel().getComponent('grid').coordinateSystem.getRect();
      var sc = (axM && axM.axis) ? axM.axis.scale : null;
      var ext = (sc && typeof sc.getExtent === 'function') ? sc.getExtent() : null;
      if (!rect || !ext || !isFinite(ext[0]) || !isFinite(ext[1])) return null;
      var x0 = ext[0], span = ext[1] - ext[0] + 1;
      if (!(span > 0)) return null;
      return function (i) { return rect.x + ((i + 0.5) - x0) / span * rect.width; };
    } catch (e) { return null; }
  }

  /**
   * 取当前 dataZoom 窗口（百分比）——从 ECharts 的 option 状态反解（getOption() 里
   * dataZoom 的 start/end 会随用户缩放更新）。X / Y 分开取：只有 X 窗口会改变类别中心。
   * @returns {{x:{start:number,end:number}|null, y:{start:number,end:number}|null}}
   */
  function currentWindows() {
    var out = { x: null, y: null };
    var dzs = null;
    try { dzs = (inst && inst.getOption) ? (inst.getOption().dataZoom || []) : []; } catch (e) { dzs = []; }
    for (var i = 0; i < dzs.length; i++) {
      var d = dzs[i];
      if (!d || typeof d.start !== 'number' || typeof d.end !== 'number') continue;
      var isX = (d.xAxisIndex !== undefined || d.xAxisId !== undefined);
      var isY = (d.yAxisIndex !== undefined || d.yAxisId !== undefined);
      if (isX && !out.x) out.x = { start: d.start, end: d.end };
      else if (!isX && isY && !out.y) out.y = { start: d.start, end: d.end };
    }
    return out;
  }
  /**
   * 任务 E ①：xAxis 的**当前**可见类别区间（ordinal scale extent，缩放后 lo/hi 为整数序号）。
   * 供 reflowAxisTable 按窗口过滤 boxplot series.data（clip 对 boxplot 不生效）。
   * @returns {{lo:number,hi:number}|null}
   */
  function axisExtentOf(chart) {
    if (!chart) return null;
    try {
      var axM = chart.getModel().getComponent('xAxis', 0);
      var sc = (axM && axM.axis) ? axM.axis.scale : null;
      var ext = (sc && typeof sc.getExtent === 'function') ? sc.getExtent() : null;
      if (!ext || !isFinite(ext[0]) || !isFinite(ext[1])) return null;
      return { lo: ext[0], hi: ext[1] };
    } catch (e) { return null; }
  }
  /** 全量窗口（0~100）视为「未缩放」→ null */
  function normWin(w) {
    if (!w) return null;
    return (w.start <= 0.01 && w.end >= 99.99) ? null : w;
  }
  function sameWin(a, b) {
    if (a === null && b === null) return true;
    if (!a || !b) return false;
    return Math.abs(a.start - b.start) < 0.01 && Math.abs(a.end - b.end) < 0.01;
  }

  /** 把当前缩放窗口写回 option 的 dataZoom 项（notMerge 重渲染后缩放不丢；X 只写 X 项） */
  function applyZoomWindow(option) {
    if (!option) return;
    if (!zoomWin && !zoomWinY) return;
    eachNode(option.dataZoom, function (dz) {
      if (!dz) return;
      var isX = (dz.xAxisIndex !== undefined || dz.xAxisId !== undefined);
      var isY = (dz.yAxisIndex !== undefined || dz.yAxisId !== undefined);
      var w = isX ? zoomWin : (isY ? zoomWinY : null);
      if (!w) return;
      dz.start = w.start;
      dz.end = w.end;
    });
  }

  /**
   * dataZoom 事件：从实例状态反解 X / Y 窗口 → 变了才去抖重渲染。
   * 重渲染时用 ECharts 自身刻度映射（axisCenterOf）重排数值行 —— 不重渲染则数值行留在
   * 缩放前的位置、指向错误类别（实测偏差 138px）。
   * ※ 不用事件 payload 的 xAxisIndex 判定：全局 dataZoom 动作（dispatchAction 不指定轴）
   *   的 batch 项里没有 xAxisIndex/yAxisIndex，会被误判为「非 X 轴」而丢掉整个事件。
   */
  function onDataZoom() {
    if (!isOpen() || !inst) return;
    var w = currentWindows();
    var nx = normWin(w.x), ny = normWin(w.y);
    var same = sameWin(nx, zoomWin) && sameWin(ny, zoomWinY);
    zoomWin = nx;
    zoomWinY = ny;
    if (same) return;
    if (zoomTimer) global.clearTimeout(zoomTimer);
    zoomTimer = global.setTimeout(function () {
      zoomTimer = 0;
      if (!isOpen()) return;
      try { render(); } catch (err) {
        if (global.console && console.error) console.error('[YMS.Fullscreen] 缩放后重算失败', err);
      }
    }, 120);
  }

  /** 判断某个 option 片段是否数组，便于统一遍历 */
  function eachNode(node, fn) {
    if (!node) return;
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) fn(node[i], i); }
    else fn(node, 0);
  }

  /**
   * 在 buildOption 结果上追加全屏能力（不替换原有样式）：
   * dataZoom（inside + slider）、toolbox（还原 / 保存）、放大标题·坐标轴·图例字号、给 slider 留出底部间距。
   */
  function enhanceOption(opt) {
    var pan = isPanOnly();
    var wheel = pan
      ? { zoomOnMouseWheel: false, moveOnMouseWheel: true, moveOnMouseMove: true, zoomOnMouseMove: false }
      : { zoomOnMouseWheel: true, moveOnMouseWheel: false, moveOnMouseMove: true, zoomOnMouseMove: false };

    /* dataZoom：保留原有配置，追加滚轮缩放/拖拽平移 + slider
       轴索引覆盖 [0,1]（0 = 主轴、1 = 上/右外框轴），保证缩放时四条外框同步。
       迭代 11：**只允许 X 轴缩放**。Y 轴缩放对「预先统计好的聚合图型」（箱线图的五数概括、
       柱/线的均值、直方图频数）没有意义——ECharts 只能改坐标窗口、无法按窗口重算统计量，
       会造成箱体/须线大面积溢出绘图区（实测 Y 缩放到 89.5~94 时箱体仍跨 85~100）。
       需要限定 Y 范围请用设置区的 Y 轴 Min/Max。 */
    var dz = Array.isArray(opt.dataZoom) ? opt.dataZoom.slice() : [];
    dz.push(Object.assign({ type: 'inside', xAxisIndex: [0, 1], filterMode: 'none' }, wheel));
    dz.push({
      type: 'slider', xAxisIndex: [0, 1], filterMode: 'none',
      height: 20, bottom: 4, brushSelect: false, showDetail: false
    });
    opt.dataZoom = dz;

    /* toolbox：还原 + 保存图片（保留 ChartBuilder 的既有配置；浅拷贝以便保留其中的函数） */
    var CB = YMS.ChartBuilder;
    var tb = opt.toolbox ? opt.toolbox : (CB && CB.TOOLBOX ? Object.assign({}, CB.TOOLBOX) : null);
    var base = tb ? Object.assign({}, tb) : { show: true, right: 12, top: 8 };
    var feature = Object.assign({}, base.feature || {});
    if (!feature.restore) feature.restore = { show: true, title: '还原' };
    if (!feature.saveAsImage) feature.saveAsImage = { show: true, title: '保存图片', pixelRatio: 2, backgroundColor: 'auto' };
    base.show = true;
    base.feature = feature;
    opt.toolbox = base;

    /* 标题 / 副标题加大字号 */
    eachNode(opt.title, function (t) {
      if (!t) return;
      t.textStyle = Object.assign({}, t.textStyle, { fontSize: 16 });
      t.subtextStyle = Object.assign({}, t.subtextStyle, { fontSize: 12, lineHeight: 16 });
    });

    /* 坐标轴字号 +2（含轴标题），保证全屏可读 */
    function bumpAxis(a) {
      if (!a) return;
      if (a.axisLabel) a.axisLabel = Object.assign({}, a.axisLabel, { fontSize: (a.axisLabel.fontSize || 11) + 2 });
      var nts = a.nameTextStyle || {};
      a.nameTextStyle = Object.assign({}, nts, { fontSize: (nts.fontSize || 11) + 2 });
    }
    eachNode(opt.xAxis, bumpAxis);
    eachNode(opt.yAxis, bumpAxis);

    /* 图例与数值标签字号 +2 */
    eachNode(opt.legend, function (lg) {
      if (!lg) return;
      lg.textStyle = Object.assign({}, lg.textStyle, { fontSize: (lg.textStyle && lg.textStyle.fontSize ? lg.textStyle.fontSize : 11) + 2 });
    });
    eachNode(opt.series, function (s) {
      if (s && s.label && s.label.show) s.label = Object.assign({}, s.label, { fontSize: (s.label.fontSize || 11) + 2 });
    });

    /* grid 底部留出 slider 空间（仅数值型 bottom 才调整，避免破坏百分比配置）。
       迭代 21：有横轴统计表规格时不在这里盲目 +34 —— 全屏会在 reflowAxisTable 里按
       **全屏容器实际高度**重算（含 30px slider 带），此处 +34 会与之冲突并造成行锚点错位。 */
    function padGrid(g) {
      if (!g) return;
      if (typeof g.bottom === 'number' && !opt.__axisTableSpec) g.bottom = g.bottom + 34;
    }
    if (Array.isArray(opt.grid)) { for (var i = 0; i < opt.grid.length; i++) padGrid(opt.grid[i]); }
    else padGrid(opt.grid);
  }

  /** 按当前序号重建并渲染图表 */
  function render() {
    if (!isOpen()) return;
    var meta = metas[idx] || {};
    titleEl.textContent = meta.title || ('图表 ' + (idx + 1));
    var sub = [];
    if (meta.pageLabel) sub.push('页：' + meta.pageLabel);
    if (meta.facetLabel) sub.push('分面：' + meta.facetLabel);
    if (meta.subtext) sub.push(String(meta.subtext));
    subEl.textContent = sub.join('  |  ');
    subEl.title = subEl.textContent;
    indexEl.textContent = (idx + 1) + ' / ' + metas.length;
    prevBtn.disabled = (idx <= 0);
    nextBtn.disabled = (idx >= metas.length - 1);
    readoutEl.textContent = '—';
    syncPanButton();
    syncHeadWidth();                 // 迭代 21：标题居中需要导航实测宽度（每次换图 / 换页码都同步）

    var A = YMS.Aggregate, CB = YMS.ChartBuilder;
    if (!A || typeof A.build !== 'function' || typeof A.chartOf !== 'function' ||
        !CB || typeof CB.buildOption !== 'function') {
      toast('放大视图依赖的绘图层（Aggregate / ChartBuilder）尚未就绪', 'warn');
      if (bodyEl) bodyEl.innerHTML = '<div class="empty-hint">绘图模块尚未就绪，无法放大查看</div>';
      return;
    }

    var option = null;
    try {
      var work = A.build();
      var chart = A.chartOf(work, idx);
      if (!chart) { toast('该图表数据不可用', 'warn'); return; }
      option = CB.buildOption(chart, work, idx, bodyEl);
    } catch (e) {
      toast('生成图表配置失败：' + (e && e.message ? e.message : e), 'error');
      if (global.console && console.error) console.error('[YMS.Fullscreen] buildOption 失败', e);
      return;
    }
    if (!option || typeof option !== 'object') { toast('该图表没有可显示的配置', 'warn'); return; }

    /* 迭代 9 · C：实例要在 enhanceOption 之前拿到（缩放态下 centerOf 需读 ECharts 自身刻度映射） */
    var chartInst = ensureInstance();
    if (!chartInst) return;

    enhanceOption(option);
    /* 迭代 9 · C / 迭代 21：enhanceOption 已放大坐标轴字号（+2）——
       横轴统计块（行名列 / 数值行 / 方框）的行锚点必须按**全屏容器实际高度 + 最终字号**重算，
       否则它们仍按卡片时的旧值摆放，全屏下与刻度标签 / 数值行错位（实测 34px）。
       缩放态（dataZoom 非全量）时另传 centerOf：数值行按缩放后的类别中心重排。
       迭代 21：同时传容器实测高度（.fs-body 的 h，与 ECharts 画布同高）——
       全屏高 ≠ 卡片高，必须真重算 grid.bottom / 标签字号 / 轴标题锚点。 */
    applyZoomWindow(option);
    if (CB && typeof CB.reflowAxisTable === 'function') {
      var fsH = 0;
      try {
        var fsHost = (hostEl && hostEl.clientHeight) ? hostEl.clientHeight
          : (bodyEl ? bodyEl.clientHeight : 0);
        var fsN = Number(fsHost);
        fsH = (isFinite(fsN) && fsN > 0) ? fsN : 0;
      } catch (eH) { fsH = 0; }
      try {
        CB.reflowAxisTable(option, {
          centerOf: axisCenterOf(chartInst), containerH: fsH, sliderBand: 30,
          /* 任务 E ①：把 xAxis 的可见区间交给重算 → 窗口外的箱体数据置 null，绝不画到 grid 外 */
          extent: axisExtentOf(chartInst)
        });
      } catch (e2) { if (global.console && console.error) console.error('[YMS.Fullscreen] 横轴表格重算失败', e2); }
    }
    lastOpt = option;

    try {
      chartInst.setOption(option, true);
      chartInst.resize();
      /* 任务 H：箱体↔数据列对位 —— setOption 会按「同轴系列总数」重摊箱体（一类只有 2~3 个
         系列有数据时整体偏心），resize 后再摆一次到列心上；40ms 兜底 resize 之后再摆一次，
         防「覆盖层 display 切换导致坐标未定」时算出偏移。 */
      if (CB && typeof CB.alignBoxSeries === 'function') CB.alignBoxSeries(chartInst);
      /* 覆盖层刚由 display:none 变为显示，布局可能尚未稳定：下一帧再 resize 兜底 */
      global.setTimeout(function () {
        if (inst) {
          try { inst.resize(); } catch (e2) { /* 忽略 */ }
          try { if (CB && typeof CB.alignBoxSeries === 'function') CB.alignBoxSeries(inst); } catch (e4) { /* 忽略 */ }
        }
      }, 40);
    } catch (e3) {
      toast('渲染图表失败：' + (e3 && e3.message ? e3.message : e3), 'error');
    }
  }

  /**
   * 迭代 21（需求 ①）：把导航栏实测宽度写到 .fs-head 的 CSS 变量 --fs-nav-w ——
   * 标题绝对居中（left:50% + translateX(-50%)）时用它预留两侧空间，
   * 保证「标题中心 = 头部中心」且标题再长也不会推挤 / 覆盖右侧导航（只在自身盒内省略）。
   */
  function syncHeadWidth() {
    try {
      if (!headEl || !navEl || !headEl.style || !headEl.style.setProperty) return;
      var w = 0;
      if (navEl.getBoundingClientRect) {
        var r = navEl.getBoundingClientRect();
        w = Math.round(r && r.width ? r.width : 0);
      }
      if (!(w > 0)) w = num0(navEl.offsetWidth);
      if (!(w > 0)) w = 240;                      // 量不到（无布局环境）→ CSS 兜底值
      headEl.style.setProperty('--fs-nav-w', w + 'px');
    } catch (e) { /* 样式写入失败不影响居中后备（CSS 变量缺省值 240px） */ }
  }
  function num0(v) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  /** 抓手按钮外观与覆盖层 class 同步（只切换 is-pan，不影响 is-open） */
  function syncPanButton() {
    var pan = isPanOnly();
    if (panBtn) {
      panBtn.className = 'fs-btn' + (pan ? ' is-active' : '');
      panBtn.title = pan
        ? '纯平移模式已开启（滚轮平移，不缩放）—— 点击恢复缩放'
        : '切换纯平移模式（滚轮平移，不缩放）';
    }
    if (rootEl && rootEl.classList && rootEl.classList.toggle) rootEl.classList.toggle('is-pan', pan);
    if (hintEl) {
      hintEl.textContent = HINT;
      hintEl.title = pan ? '当前：纯平移模式（滚轮平移，不缩放）' : '当前：滚轮缩放 + 拖拽平移';
    }
  }

  /** 切换纯平移模式：重设 dataZoom 滚轮行为（无需重建实例） */
  function togglePanOnly() {
    var next = !isPanOnly();
    setPanOnly(next);
    syncPanButton();
    if (!inst || !lastOpt) return;
    var pan = next;
    var wheel = pan
      ? { zoomOnMouseWheel: false, moveOnMouseWheel: true, moveOnMouseMove: true, zoomOnMouseMove: false }
      : { zoomOnMouseWheel: true, moveOnMouseWheel: false, moveOnMouseMove: true, zoomOnMouseMove: false };
    var dz = [];
    (lastOpt.dataZoom || []).forEach(function (d) {
      if (d && d.type === 'inside') dz.push(Object.assign({}, d, wheel));
      else dz.push(d);
    });
    try {
      /* 仅更新 dataZoom（增量 merge），不触碰其它配置 */
      inst.setOption({ dataZoom: dz });
      lastOpt.dataZoom = dz;
    } catch (e) { /* 忽略 */ }
    toast(pan ? '抓手模式：滚轮平移，不缩放' : '已恢复缩放模式', 'ok', 1600);
  }

  /** 数值 / 文本 / 时间格式化（读数区用） */
  function fmtVal(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') {
      if (!isFinite(v)) return '—';
      return (U && U.fmtNumber) ? U.fmtNumber(v, null) : String(v);
    }
    return String(v);
  }

  /** X 轴为时间轴时把 epochMs 显示为日期时间 */
  function fmtX(v) {
    try {
      var isTime = false;
      eachNode(lastOpt && lastOpt.xAxis, function (a) { if (a && a.type === 'time') isTime = true; });
      if (isTime && typeof v === 'number' && YMS.types && YMS.types.formatTime) {
        return YMS.types.formatTime(v, 'datetime');
      }
    } catch (e) { /* 回退到普通格式化 */ }
    return fmtVal(v);
  }

  /**
   * 点击数据点：底部读数区显示「系列名 · X = … · Y = …」
   * 兼容散点 [x,y]、Box [min,q1,中位数,q3,max]、以及一维数值系列。
   */
  function onPointClick(p) {
    if (!p || !readoutEl) return;
    var d = p.data, x, y, tag = '';
    if (Array.isArray(d)) {
      if (d.length >= 5) { y = d[2]; x = p.name; tag = '（中位数）'; }          // Box Plot
      else if (d.length >= 2) { x = d[0]; y = d[1]; }                          // 散点 / 折线
      else { x = p.name; y = d[0]; }
    } else if (d && typeof d === 'object') {
      x = (d.x !== undefined) ? d.x : d.value;
      y = (d.y !== undefined) ? d.y : d.value;
    } else if (d !== undefined && d !== null) {
      x = p.name;
      y = d;
    } else {
      x = p.name;
      y = p.value;
    }
    if (x === undefined || x === null || x === '') x = p.name;
    var name = p.seriesName || '系列';
    readoutEl.textContent = name + ' · X = ' + fmtX(x) + ' · Y = ' + fmtVal(y) + tag;
    /* 同时弹出 tooltip */
    try {
      if (inst && p.seriesIndex !== undefined) {
        inst.dispatchAction({ type: 'showTip', seriesIndex: p.seriesIndex, dataIndex: p.dataIndex });
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------------ 键盘 */

  function onKeyDown(e) {
    if (!isOpen()) return;
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'Left') { e.preventDefault(); e.stopPropagation(); YMS.Fullscreen.prev(); }
    else if (k === 'ArrowRight' || k === 'Right') { e.preventDefault(); e.stopPropagation(); YMS.Fullscreen.next(); }
    else if (k === 'Escape' || k === 'Esc') { e.preventDefault(); e.stopPropagation(); YMS.Fullscreen.close(); }
  }
  function bindKeys() {
    if (keyBound || !global.document || !document.addEventListener) return;
    /* 捕获阶段监听，确保优先于页面其它快捷键 */
    document.addEventListener('keydown', onKeyDown, true);
    keyBound = true;
  }
  function unbindKeys() {
    if (!keyBound || !global.document || !document.removeEventListener) return;
    document.removeEventListener('keydown', onKeyDown, true);
    keyBound = false;
  }

  /** 数据 / 绘图配置变化时关闭覆盖层（序号可能已失效） */
  function onStoreChanged() { if (isOpen()) YMS.Fullscreen.close(); }

  /* ---------------------------------------------------------------- 生命周期 */

  /** 初始化：创建 DOM 容器 + 全局事件（app.js 启动时调用；open() 也会兜底调用） */
  function init() {
    if (!ensureRoot()) return false;
    bindKeys();
    if (!inited) {
      inited = true;
      var resize = function () {
        if (inst) { try { inst.resize(); } catch (e) { /* 忽略 */ } }
        syncHeadWidth();               // 迭代 21：窗口变化后重新同步标题居中的预留宽度
      };
      var onResize = (U && U.debounce) ? U.debounce(resize, 150) : resize;
      if (global.addEventListener) global.addEventListener('resize', onResize);
      if (YMS.Store && YMS.Store.on) {
        YMS.Store.on('data', onStoreChanged);
        YMS.Store.on('plot', onStoreChanged);
        YMS.Store.on('mode', onStoreChanged);
      }
    }
    return true;
  }

  /**
   * 打开放大视图。
   * @param {number} index 扁平序号（YMS.PlotView.getChartMeta() 的 index）
   */
  function open(index) {
    try {
      if (!init()) { toast('当前环境不支持放大视图', 'error'); return; }
      var PV = YMS.PlotView;
      if (!PV || typeof PV.getChartMeta !== 'function') {
        toast('绘图视图尚未就绪，无法放大查看', 'warn');
        return;
      }
      var list = null;
      try { list = PV.getChartMeta(); } catch (e) { list = null; }
      if (!list || !list.length) { toast('当前没有可放大的图表', 'warn'); return; }

      var i = Math.round(Number(index));
      if (!isFinite(i) || i < 0 || i >= list.length) {
        toast('图表序号无效（0 ~ ' + (list.length - 1) + '）', 'warn');
        return;
      }

      metas = list.slice();
      idx = i;
      zoomWin = null;                    // 迭代 9：新打开的图从「未缩放」开始
      if (zoomTimer) { global.clearTimeout(zoomTimer); zoomTimer = 0; }
      syncPanButton();
      if (rootEl && rootEl.classList && rootEl.classList.add) rootEl.classList.add('is-open');
      bindKeys();
      render();
    } catch (err) {
      if (global.console && console.error) console.error('[YMS.Fullscreen] open 失败', err);
      toast('放大视图打开失败：' + (err && err.message ? err.message : err), 'error');
    }
  }

  /** 关闭并释放图表实例 */
  function close() {
    try {
      if (inst) {
        try { inst.off('click', onPointClick); } catch (e) { /* 忽略 */ }
        try { inst.off('dataZoom', onDataZoom); } catch (e3) { /* 忽略 */ }
        try { inst.dispose(); } catch (e2) { /* 忽略 */ }
        inst = null;
      }
      zoomWin = null;
      if (zoomTimer) { global.clearTimeout(zoomTimer); zoomTimer = 0; }
      lastOpt = null;
      hostEl = null;
      if (bodyEl) bodyEl.innerHTML = '';
      if (rootEl && rootEl.classList && rootEl.classList.remove) rootEl.classList.remove('is-open');
      idx = -1;
      metas = [];
      unbindKeys();
    } catch (err) {
      if (global.console && console.error) console.error('[YMS.Fullscreen] close 失败', err);
    }
  }

  /** 切换到指定序号（越界不动作） */
  function go(i) {
    if (!isOpen()) return;
    if (i < 0) { toast('已是第一张图', 'warn', 1500); return; }
    if (i >= metas.length) { toast('已是最后一张图', 'warn', 1500); return; }
    idx = i;
    render();
  }

  YMS.Fullscreen = {
    init: init,
    open: open,
    close: close,
    next: function () { go(idx + 1); return idx; },
    prev: function () { go(idx - 1); return idx; },
    current: function () { return isOpen() ? idx : -1; },
    isOpen: isOpen,
    total: function () { return metas.length; }
  };
})(typeof window !== 'undefined' ? window : this);
