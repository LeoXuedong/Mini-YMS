/* ==========================================================================
   YMS · plot/plot-settings.js
   ---------------------------------------------------------------------------
   职责：右列「绘图设置区」面板（#plot-settings-body）
     · 草稿机制：面板内的所有改动先写入内部草稿 draft，点 Submit 才
       Store.applyPlot(draft) 生效并重新渲染（PlotView.render()）
     · 例外（改完立即生效，无需 Submit）：快捷方式 / Plot 菜单切换图型（setType）、
       迭代 8 的「X 轴旋转」下拉（#ps-x-rotate —— 用户反馈"旋转未实现"，实为只落草稿
       未 Submit；现改为写草稿后立即 applyDraft() + PlotView.render()）
     · 分组（迭代 10 起 1–7，**已移除「1 · 图型」组**：图型由顶部快捷栏 Table/Scatter/Line/Hist/Bar/Box
       与 Plot 菜单切换，设置区不再重复）：数据映射 / 排版 / 防拥挤合并 / Scatter 拟合 / 直方图柱数 /
             图表元素属性 / 多数据同图·多 Y 轴轴位 / 横轴统计行 / Submit + 重置
     · 迭代 4 新增：显示方式（分面 / 叠加同图）、每条数据的 Y 轴轴位（左轴 / 右轴）、
       颜色分组列、符号分组列、横轴统计行（统计量勾选）；这些字段同样只落草稿，
       Submit 时随整份配置一次写入 Store.plot（axisSide 整体替换，group/stats 合并）
     · 迭代 5 / 6：X Label / Value / Page by / Split by 为**下拉式多选控件**（U().dropSelect）——
      平时只显示当前选择（标签 + 序号角标 / 占位文字）+ 下拉箭头，点一下才在触发器下方弹出
      选项面板；点选项立即选中 / 再点即取消，面板不关闭（可连选），无「确定」按钮、无遮罩弹窗，
      点面板外或 Esc 关闭；选中顺序 = 点击先后，面板底部「清空」一键取消全部
     · 迭代 10：数据映射（X Label / Value / Sorter / Page by / Split by）**初次打开全为空**，
       不再自动填 Lot/Idsat/...；配置为空时绘图区显示明确空态提示，Submit 不报错、不画空图
     · 迭代 11：组 6 新增「分组配色」区块（#ps-group-colors）—— 按颜色分组（颜色分组列 / 多 Value 系列）时
       每个分组可单独选颜色：色块 = 原生 input[type=color]，▦ = 12 色预设色阶（PALETTE_ALT），「恢复默认」= 清空；
       字段 plot.group.colors（{分组键: #rrggbb}），键规则 = YMS.groupColorKey；**改动立即生效**（无需 Submit），
       未自定义时渲染与迭代 10 逐像素一致（回归红线）
     · 迭代 12：① 「5 · 图表元素属性 → Box 中位数连线」默认关闭（store.js DEFAULT_STYLE 同源）；
       ② 「7 · 横轴统计行 → 统计量」由 10 个平铺勾选框改为**下拉复选框**（复用 U().dropSelect：
          触发器只显示已选项 / 未选「未选择」、点开弹面板、勾选即改草稿且面板不关、点外部或 Esc 关闭、
          底部「清空」；顺序恒按 STAT_ORDER —— 每次变更后把 dropSelect 的选中顺序重置为 STAT_ORDER），
          容器仍为 #ps-stats-items，生效路径仍是草稿 + Submit；
       ③ 「7 · 横轴统计行 → 统计量旋转」（#ps-stats-rotate，0/30/45/60/90，默认 0）写 plot.stats.rotate，
          只旋转统计**数值**，与「X 轴旋转」（style.xRotate，只旋转类别名）**完全独立**，同样草稿 + Submit
     · 列名变化（重命名/删除）后草稿中失效的名字自动剔除

   数据来源：只读 YMS.Store；渲染动作交给 YMS.PlotView。
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};

  var TYPES = [
    { value: 'line', label: '折线图 Line' },
    { value: 'box', label: '箱线图 Box' },
    { value: 'bar', label: '柱状图 Bar' },
    { value: 'hist', label: '直方图 Hist' },
    { value: 'scatter', label: '散点图 Scatter' }
  ];
  var MERGE_MODES = [
    { value: 'auto', label: '自动', title: '自动上限：Box ≤ 40 组 / Bar·Line ≤ 60 组；Scatter·Hist 不限' },
    { value: 'manual:20', label: '≤ 20 组', title: '手动：相邻类别合并到最多 20 组' },
    { value: 'manual:40', label: '≤ 40 组', title: '手动：相邻类别合并到最多 40 组' },
    { value: 'manual:60', label: '≤ 60 组', title: '手动：相邻类别合并到最多 60 组' },
    { value: 'manual:80', label: '≤ 80 组', title: '手动：相邻类别合并到最多 80 组' },
    { value: 'manual:120', label: '≤ 120 组', title: '手动：相邻类别合并到最多 120 组' },
    { value: 'none', label: '不限制', title: '不合并：显示全部类别' }
  ];
  var FIT_FALLBACK = [
    { value: 'none', label: '无' },
    { value: 'linear', label: '线性 y = a + bx' },
    { value: 'quadratic', label: '二次 y = a + bx + cx²' },
    { value: 'cubic', label: '三次 多项式' },
    { value: 'poly', label: '多项式（自定义阶数）' },
    { value: 'exp', label: '指数 y = a·e^(bx)' },
    { value: 'log', label: '对数 y = a + b·ln x' },
    { value: 'power', label: '幂 y = a·x^b' }
  ];
  var WEIGHTS = [{ value: 'normal', label: '常规' }, { value: 'bold', label: '加粗' }];

  /* X 轴标签旋转角度（迭代 7）：取值约定 0 | 30 | 45 | 60 | 90 | 'auto'。
     迭代 15（需求 ①）：**默认 90°（竖排）** —— 设置区下拉打开即显示 90°；旧 .yms 缺字段同样归一到 90。
     控件 id = #ps-x-rotate；渲染层读 Store.plot.style.xRotate（'auto' = 按类别拥挤度自选角度）。 */
  var X_ROTATE_OPTIONS = [
    { value: '0', label: '不旋转', title: '标签水平显示（旧默认；迭代 15 起默认改 90°）' },
    { value: '30', label: '30°', title: '标签固定旋转 30°' },
    { value: '45', label: '45°', title: '标签固定旋转 45°' },
    { value: '60', label: '60°', title: '标签固定旋转 60°' },
    { value: '90', label: '90°', title: '默认：标签固定旋转 90°（竖排，不占横向空间）' },
    { value: 'auto', label: '自动（按拥挤度）', title: '按类别数量与标签长度自动选择旋转角' }
  ];
  var X_ROTATE_TITLE = '选中即刻生效（无需 Submit）；默认 90° 竖排，自动=按类别拥挤度选择角度';

  /* 迭代 12（需求 ③）：「统计量旋转」下拉 —— 只作用于横轴统计行的**数值**，
     与上面的「X 轴旋转」（只作用于类别名）**完全独立**，两者任意组合都成立。
     迭代 15（需求 ①）：默认 90°（与 X 轴旋转默认一致）；草稿 + Submit 生效（与统计量勾选同路径）。 */
  var STAT_ROTATE_OPTIONS = [
    { value: '0', label: '不旋转', title: '统计数值水平显示（旧默认；迭代 15 起默认改 90°）' },
    { value: '30', label: '30°', title: '统计数值旋转 30°（行高按投影自适应）' },
    { value: '45', label: '45°', title: '统计数值旋转 45°（行高按投影自适应）' },
    { value: '60', label: '60°', title: '统计数值旋转 60°（行高按投影自适应）' },
    { value: '90', label: '90°', title: '默认：统计数值竖排 90°，列再密也能全部显示（投影宽度只有字高）' }
  ];
  /** 统计量旋转角归一化（与 store.js / axis.js 同一规则；迭代 15 起缺省/非法 → 90） */
  function normStatRotate(v) {
    if (typeof YMS.normStatRotate === 'function') return YMS.normStatRotate(v);
    var n = Number(v);
    return (n === 0 || n === 30 || n === 45 || n === 60 || n === 90) ? n : 90;
  }

  /** 旋转角度归一化：接受 0/30/45/60/90/'auto'。
      迭代 15：缺省 / null / 空串 / 非法值 → **90（新默认）**；显式 0（下拉 "不旋转"）仍保留 0。 */
  function normXRotate(v) {
    if (v === 'auto') return 'auto';
    if (v === null || v === undefined || v === '') return 90;
    var n = Number(v);
    if (n === 0 || n === 30 || n === 45 || n === 60 || n === 90) return n;
    return 90;   // 非枚举值（如手填 20 / NaN）→ 新默认 90
  }

  /* 横轴统计行（迭代 4）：允许的统计量、显示名、悬停提示与显示顺序（STAT_ORDER）。
       顺序优先取渲染层常量 YMS.Aggregate.STAT_ORDER（若已实现），否则用本地副本。
     迭代 8：默认统计量改为**只勾 Mean**（与 store.js 的 defaultStats() 一致）。 */
  var DEFAULT_STAT_ITEMS = ['mean'];
  var STAT_LABELS = {
    mean: 'Mean', median: 'Median', std: 'Std', rng: 'RNG', nupct: 'Nu%',
    n: 'N', min: 'Min', max: 'Max', q1: 'Q1', q3: 'Q3'
  };
  var STAT_TITLES = {
    mean: '均值 Mean', median: '中位数 Median', std: '标准差 Std',
    rng: '极差 RNG（Max - Min）', nupct: 'Nu% = Std / Mean × 100（相对标准差）',
    n: '样本数 N', min: '最小值 Min', max: '最大值 Max',
    q1: '下四分位数 Q1', q3: '上四分位数 Q3'
  };
  var STAT_ORDER_FALLBACK = ['mean', 'median', 'std', 'rng', 'nupct', 'n', 'min', 'max', 'q1', 'q3'];

  var body = null;
  var draft = null;
  /* 迭代 29：Value 下拉默认只列数值型列；勾选「显示全部列」后放开为全列清单 */
  var valueShowAllCols = false;
  var inited = false;
  var applying = false;

  function U() { return YMS.util; }
  function Store() { return YMS.Store; }
  function PV() { return YMS.PlotView; }

  /* --------------------------------------------------------------- 草稿 */
  function defaultDraft() {
    var st = Store().state.plot || {};
    return {
      type: st.type || 'line',
      x: (st.x || []).slice(),
      values: (st.values || []).slice(),
      sorters: (st.sorters || []).map(function (s) { return { col: s.col, dir: s.dir === 'desc' ? 'desc' : 'asc' }; }),
      pageBy: (st.pageBy || []).slice(),
      splitBy: (st.splitBy || []).slice(),
      layout: Object.assign({ mode: 'best', rows: 1, cols: 1 }, st.layout || {}),
      merge: Object.assign({ mode: 'auto', limit: null }, st.merge || {}),
      fit: st.fit || 'none',
      fitOrder: st.fitOrder || 2,
      histBins: (st.histBins === undefined ? null : st.histBins),
      display: (st.display === 'overlay' ? 'overlay' : 'facet'),
      axisSide: Object.assign({}, st.axisSide || {}),
      /* 迭代 11：colors = 分组配色（{分组键: #rrggbb}）—— 深拷贝，草稿与 Store 互不影响 */
      group: (function () {
        var g = st.group || {};
        var src = (g.colors && typeof g.colors === 'object') ? g.colors : {};
        var colors = {};
        Object.keys(src).forEach(function (k) { colors[k] = src[k]; });
        return { colorBy: g.colorBy || '', symbolBy: g.symbolBy || '', colors: colors,
                 /* 迭代 26：图例色阶自动配色 —— 预设 id + 上次自动配色时的图例数 */
                 preset: (typeof g.preset === 'string') ? g.preset : '',
                 autoN: (typeof g.autoN === 'number' && isFinite(g.autoN)) ? g.autoN : 0 };
      })(),
      stats: {
        show: !!(st.stats && st.stats.show),
        items: ((st.stats && st.stats.items && st.stats.items.length)
          ? st.stats.items.slice() : DEFAULT_STAT_ITEMS.slice()),
        /* 迭代 12 / 15：统计量旋转角（缺省 → 90（新默认）；与 X 轴旋转完全独立） */
        rotate: normStatRotate(st.stats ? st.stats.rotate : undefined)
      },
      /* 迭代 7 · C / 迭代 8：数据表格开关 + 横轴坐标表格方框（含左侧行名）开关 */
      table: {
        show: !!(st.table && st.table.show),
        frame: !!(st.table && st.table.frame)
      },
      style: Object.assign({}, (YMS.Store.DEFAULT_STYLE || {}), st.style || {}),
      /* 任务 F：图例样式 / 图元样式（两对象独立于 style；深拷贝草稿，改动不影响 Store 直到 Submit） */
      legend: Object.assign({}, (YMS.Store.defaultLegend ? YMS.Store.defaultLegend() : {}),
        (st.legend && typeof st.legend === 'object') ? st.legend : {}),
      mark: Object.assign({}, (YMS.Store.defaultMark ? YMS.Store.defaultMark() : {}),
        (st.mark && typeof st.mark === 'object') ? st.mark : {})
    };
  }
  function syncFromStore() { draft = defaultDraft(); sanitize(); }
  /** 剔除失效列名（重命名/删除后） */
  function sanitize() {
    var names = Store().colNames();
    function keep(a) { return (a || []).filter(function (n) { return names.indexOf(n) >= 0; }); }
    draft.x = keep(draft.x);
    draft.values = keep(draft.values);
    draft.pageBy = keep(draft.pageBy);
    draft.splitBy = keep(draft.splitBy);
    draft.sorters = (draft.sorters || []).filter(function (s) { return s && names.indexOf(s.col) >= 0; });
    if (!draft.layout) draft.layout = { mode: 'best', rows: 1, cols: 1 };
    if (!draft.merge) draft.merge = { mode: 'auto', limit: null };
    if (draft.merge.mode === 'manual' && !draft.merge.limit) draft.merge.limit = 40;
    /* 迭代 4：显示方式 / 轴位 / 颜色符号分组 / 统计行（列名失效即剔除） */
    if (draft.display !== 'overlay') draft.display = 'facet';
    var sides = {}, src = draft.axisSide || {};
    Object.keys(src).forEach(function (k) {
      var base = String(k).split('@')[0];                 // '列名' 或 '列名@分组标签'
      if (names.indexOf(base) < 0) return;
      sides[k] = (src[k] === 'right') ? 'right' : 'left';
    });
    draft.axisSide = sides;
    if (!draft.group) draft.group = { colorBy: '', symbolBy: '', colors: {} };
    if (names.indexOf(draft.group.colorBy) < 0) draft.group.colorBy = '';
    if (names.indexOf(draft.group.symbolBy) < 0) draft.group.symbolBy = '';
    /* 迭代 11：分组配色兜底 —— 缺字段 → {}；非法色值（手写 / 旧配置）丢弃，绝不抛异常 */
    var gcSrc = (draft.group.colors && typeof draft.group.colors === 'object') ? draft.group.colors : {};
    var gcClean = {};
    var hexOk = (typeof YMS.isColorHex === 'function') ? YMS.isColorHex : function (v) {
      return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
    };
    Object.keys(gcSrc).forEach(function (k) { if (k && hexOk(gcSrc[k])) gcClean[k] = gcSrc[k]; });
    draft.group.colors = gcClean;
    /* 迭代 26：配色预设 / autoN 兜底 —— 未知预设 id 归一到默认（不改用户颜色，只改下拉） */
    draft.group.preset = presetKnown(draft.group.preset) ? draft.group.preset : PALETTE_DEFAULT_PRESET;
    var an = draft.group.autoN;
    draft.group.autoN = (typeof an === 'number' && isFinite(an) && an >= 0 && an <= 200) ? Math.round(an) : 0;
    if (!draft.stats) draft.stats = { show: false, items: [], rotate: 90 };
    if (!(draft.stats.items instanceof Array)) draft.stats.items = [];
    draft.stats.items = draft.stats.items.filter(function (k) { return !!STAT_LABELS[k]; });
    draft.stats.show = !!draft.stats.show;
    /* 迭代 12 / 15：统计量旋转角兜底（缺字段 / 非法值 → 90（新默认）；显式 0 保留） */
    draft.stats.rotate = normStatRotate(draft.stats.rotate);
    /* 迭代 8：数据表格 / 坐标表格方框兜底（旧配置缺字段 → 均关闭） */
    if (!draft.table || typeof draft.table !== 'object') draft.table = { show: false, frame: false };
    draft.table.show = !!draft.table.show;
    draft.table.frame = !!draft.table.frame;
    /* 迭代 7：样式兜底（旧 .yms / 手工 patch 可能缺字段）+ X 轴旋转角归一化（非法值一律落回 0） */
    if (!draft.style || typeof draft.style !== 'object') draft.style = Object.assign({}, (Store().DEFAULT_STYLE || {}));
    draft.style.xRotate = normXRotate(draft.style.xRotate);
    /* 任务 F：图例 / 图元兜底（旧 .yms 缺字段 → 默认值；非法值丢弃回落默认） */
    draft.legend = Object.assign({}, (YMS.Store.defaultLegend ? YMS.Store.defaultLegend() : {}),
      (draft.legend && typeof draft.legend === 'object') ? draft.legend : {});
    draft.mark = Object.assign({}, (YMS.Store.defaultMark ? YMS.Store.defaultMark() : {}),
      (draft.mark && typeof draft.mark === 'object') ? draft.mark : {});
  }

  /* 迭代 10（需求 B）：取消「自动填默认」—— autoFill() 整段删除。
     初次打开绘图视图时数据映射（X Label / Value / Sorter / Page by / Split by）**全部为空**，
     由用户在面板里自己选；配置为空时不做任何绘制，改由 PlotView 显示空态提示。 */

  /* --------------------------------------------------------- 小控件工厂 */
  /** 纯列名选项（窄控件用，如 Sorter 行 / 原地选择行） */
  function plainColOptions() {
    return Store().colNames().map(function (n) { return { value: n, label: n }; });
  }
  /**
   * 参数字段用选项：行内只显示列名（下拉面板一行一项），
   * 类型信息放 title 悬停提示（设置区不放说明性文字）。
   */
  function paramColOptions() {
    return Store().colNames().map(function (n) {
      var t = Store().colType(n);
      return { value: n, label: n, title: n + '（' + (YMS.types.TYPE_LABEL[t] || t) + '）' };
    });
  }
  /** 只含**数值型**列的选项：Value（统计目标）用 —— 字符串/时间列参与统计没有意义，
      默认不列出，避免用户在一堆维度列里找不到数值列 */
  function numericColOptions() {
    if (valueShowAllCols) return paramColOptions();
    return Store().colNames().filter(function (n) {
      return Store().colType(n) === 'number';
    }).map(function (n) {
      var t = Store().colType(n);
      return { value: n, label: n, title: n + '（' + (YMS.types.TYPE_LABEL[t] || t) + '）' };
    });
  }
  /** 参数字段（X Label / Value / Page by / Split by）：下拉式多选 —— 平时只显示当前选择，点一下才弹出选项 */
  function mkDropSelect(id, values, placeholder, onChange, options) {
    return U().dropSelect({
      id: id, options: options || paramColOptions(), values: values, placeholder: placeholder,
      maxHeight: 200, onChange: onChange
    }).node;
  }
  function mkSelect(options, value, onChange, cls) {
    var sel = U().el('select', { class: cls || '' });
    (options || []).forEach(function (o) {
      sel.appendChild(U().el('option', { value: o.value, text: o.label, title: o.title || o.label }));
    });
    sel.value = value;
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }
  function mkNumber(value, min, max, step, onChange, width) {
    var inp = U().el('input', {
      type: 'number', class: 'num-inp', min: min, max: max, step: step || 1,
      value: (value === null || value === undefined) ? '' : value,
      placeholder: '自动', title: '空 = 自动'
    });
    inp.style.width = (width || 52) + 'px';
    inp.addEventListener('change', function () {
      var raw = inp.value.trim();
      if (raw === '') { onChange(null); return; }
      var n = Number(raw);
      onChange(isFinite(n) ? n : null);
    });
    return inp;
  }
  function mkColor(value, onChange) {
    var inp = U().el('input', { type: 'color', value: value || '#4a5866' });
    inp.addEventListener('change', function () { onChange(inp.value); });
    return inp;
  }
  function mkCheck(text, checked, onChange) {
    var id = U().uid('chk');
    var inp = U().el('input', { type: 'checkbox', id: id });
    inp.checked = !!checked;
    inp.addEventListener('change', function () { onChange(inp.checked); });
    var lab = U().el('label', { class: 'chk-line', for: id }, [inp, U().el('span', { text: text })]);
    return lab;
  }
  /** 勾选框（可指定固定 DOM id，便于自动化/外部定位）：label > input#id + 文本 */
  function mkCheckId(id, text, checked, onChange, title) {
    var inp = U().el('input', { type: 'checkbox', id: id, title: title || '' });
    inp.checked = !!checked;
    inp.addEventListener('change', function () { onChange(inp.checked); });
    return U().el('label', { class: 'chk-line', for: id, title: title || '' }, [inp, U().el('span', { text: text })]);
  }
  function miniBtn(text, title, onClick) {
    var b = U().el('button', { class: 'mini-btn', title: title, text: text });
    b.addEventListener('click', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); onClick(); });
    return b;
  }
  /** 极短字段标签（字号 / Min / Max / 阶数 …）—— 非说明文字 */
  function mkMini(text) { return U().el('span', { class: 'lbl-mini', text: text }); }
  function field(labelText, ctl) {
    return U().el('div', { class: 'field' }, [
      U().el('label', { text: labelText }),
      U().el('div', { class: 'field-ctl' }, Array.isArray(ctl) ? ctl : [ctl])
    ]);
  }
  function group(title, children) {
    var g = U().el('div', { class: 'setting-group' }, [U().el('div', { class: 'group-title', text: title })]);
    (children || []).forEach(function (c) { if (c) g.appendChild(c); });
    return g;
  }
  /** 原地选择行：在 hostRow 内插入一行 [列 select][升/降 select][确定][取消]（不弹窗） */
  function openSorterPicker(hostRow) {
    var existing = hostRow.querySelector ? hostRow.querySelector('.inline-picker') : null;
    if (existing) {
      var s0 = existing.querySelector ? existing.querySelector('select') : null;
      if (s0 && s0.focus) s0.focus();
      return;
    }
    var names = Store().colNames();
    if (!names.length) return;
    var colSel = mkSelect(plainColOptions(), names[0], function () {}, 'pick-col w-100');
    var dirSel = mkSelect([{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }], 'asc', function () {}, 'pick-dir');
    var picker = U().el('div', { class: 'inline-picker' });
    var okBtn = U().el('button', { class: 'btn btn-sm pick-ok', text: '确定', title: '添加（Enter）' });
    var cancelBtn = U().el('button', { class: 'btn btn-sm pick-cancel', text: '取消', title: '取消（Esc）' });
    picker.appendChild(colSel); picker.appendChild(dirSel); picker.appendChild(okBtn); picker.appendChild(cancelBtn);
    function close() { if (picker.parentNode) picker.parentNode.removeChild(picker); }
    function commit() {
      var col = colSel.value || names[0];
      draft.sorters.push({ col: col, dir: dirSel.value === 'desc' ? 'desc' : 'asc' });
      close();
      renderPanel();
    }
    okBtn.addEventListener('click', function (e) { if (e.preventDefault) e.preventDefault(); commit(); });
    cancelBtn.addEventListener('click', function (e) { if (e.preventDefault) e.preventDefault(); close(); });
    picker.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    hostRow.appendChild(picker);
    if (colSel.focus) colSel.focus();
  }

  /* ---------------------------------------------------------- 面板构建 */
  /* 迭代 10（需求 A）：**删除「1 · 图型」整组** —— 图型由顶部快捷栏
     Table/Scatter/Line/Hist/Bar/Box 与 Plot 菜单切换（PlotSettings.setType），
     设置区不再重复一个图型下拉。其余分组依次前移为 1–7（只改标题文字，控件 id 一律不变）。 */

  function buildColumnGroup() {
    var kids = [];
    /* 参数下拉控件必须带上草稿当前值：否则每次 renderPanel（含 Submit 后）控件都会显示为空，
       用户以为"Submit 后参数丢了"（草稿与 Store 其实是好的）。 */
    kids.push(field('X Label', mkDropSelect('ps-x-list', draft.x.slice(), '未选择',
      function (vals) { draft.x = vals; })));

    kids.push(field('Value', mkDropSelect('ps-value-list', draft.values.slice(), '未选择',
      function (vals) { draft.values = vals; }, numericColOptions())));
    /* 迭代 29：Value 默认只列数值型列；此开关放开为全列（想看字符串/时间列时用） */
    kids.push(U().el('div', { class: 'chk-grid' }, [
      mkCheckId('ps-value-all', 'Value 显示全部列', valueShowAllCols, function (v) {
        valueShowAllCols = v;
        renderPanel();
      }, '默认只列数值型列；勾选后列出全部列（含字符串 / 时间列）')
    ]));

    /* Sorter 多级：整行可点 → 在按钮下方原地选择 [列][升/降] */
    var sorterWrap = U().el('div', { class: 'sorter-list' });
    draft.sorters.forEach(function (s, i) { sorterWrap.appendChild(sorterRow(s, i)); });
    var addBtn = miniBtn('+', '新增排序依据', function () { openSorterPicker(addRow); });
    var addRow = U().el('div', { class: 'plus-row plus-multi plus-add' }, [addBtn]);
    addRow.addEventListener('click', function (e) {
      if (e && e.target === addBtn) return;      // 按钮自己已处理，避免重复展开
      if (e && e.preventDefault) e.preventDefault();
      openSorterPicker(addRow);
    });
    kids.push(field('Sorter', [sorterWrap, addRow]));

    kids.push(field('Page by', mkDropSelect('ps-pageby-list', draft.pageBy.slice(), '不分页',
      function (vals) { draft.pageBy = vals; })));

    kids.push(field('Split by', mkDropSelect('ps-splitby-list', draft.splitBy.slice(), '不分面',
      function (vals) { draft.splitBy = vals; })));
    return group('1 · 数据映射', kids);
  }

  function sorterRow(s, i) {
    var row = U().el('div', { class: 'sorter-row' });
    row.appendChild(U().el('span', { class: 'rank', text: String(i + 1) }));
    var sel = mkSelect(plainColOptions(), s.col, function (v) { s.col = v; }, 'w-100');
    sel.style.flex = '1 1 auto';
    row.appendChild(sel);
    var dir = mkSelect([{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }],
      s.dir === 'desc' ? 'desc' : 'asc', function (v) { s.dir = v; });
    dir.style.width = '58px';
    row.appendChild(dir);
    row.appendChild(miniBtn('↑', '上移（提高优先级）', function () {
      if (i <= 0) return;
      var t = draft.sorters[i - 1]; draft.sorters[i - 1] = draft.sorters[i]; draft.sorters[i] = t;
      renderPanel();
    }));
    row.appendChild(miniBtn('↓', '下移（降低优先级）', function () {
      if (i >= draft.sorters.length - 1) return;
      var t = draft.sorters[i + 1]; draft.sorters[i + 1] = draft.sorters[i]; draft.sorters[i] = t;
      renderPanel();
    }));
    row.appendChild(miniBtn('✕', '删除该排序依据', function () { draft.sorters.splice(i, 1); renderPanel(); }));
    return row;
  }

  function buildLayoutGroup() {
    var rowsInp = mkNumber(draft.layout.rows, 1, 12, 1, function (v) { draft.layout.rows = v || 1; }, 52);
    var colsInp = mkNumber(draft.layout.cols, 1, 12, 1, function (v) { draft.layout.cols = v || 1; }, 52);
    function syncEnabled() {
      var on = draft.layout.mode === 'rc';
      rowsInp.disabled = !on;
      colsInp.disabled = !on;
    }
    var layoutType = mkSelect([
      { value: 'best', label: '最佳排版（自动列数）' },
      { value: 'rc', label: 'Row × Column' }
    ], draft.layout.mode === 'rc' ? 'rc' : 'best', function (v) {
      draft.layout.mode = v;
      syncEnabled();
    });
    syncEnabled();
    return group('2 · 排版', [
      field('排版', layoutType),
      field('行列', [mkMini('行'), rowsInp, mkMini('×'), colsInp])
    ]);
  }

  function buildMergeGroup() {
    var cur = draft.merge.mode === 'manual'
      ? ('manual:' + (draft.merge.limit || 40))
      : (draft.merge.mode === 'none' ? 'none' : 'auto');
    /* 任务 I ③（用户口径「删掉」）：非直方图图型下「分组带自动启用……」那条说明**不再渲染**
       —— 分组带是默认行为，常驻一行说明只占高度。
       但 data-note="merge-hist-na" 必须保留：直方图的 X 轴是**数值分箱**，没有分类维度可合并，
       这里必须**可见地说明**，不许静默不生效（用户看不到任何反馈会当成 bug）。 */
    var isHist = draft.type === 'hist';
    var items = [field('合并', mkSelect(MERGE_MODES, cur, function (v) {
      if (v === 'auto') { draft.merge.mode = 'auto'; draft.merge.limit = null; }
      else if (v === 'none') { draft.merge.mode = 'none'; draft.merge.limit = null; }
      else {
        var parts = v.split(':');
        draft.merge.mode = 'manual';
        draft.merge.limit = Number(parts[1]);
      }
    }))];
    if (isHist) {
      var noteText = '直方图的 X 轴是数值分箱（不是分类维度），分组带不适用：柱宽与分箱数用「柱数」控制。切到 box / line / bar / scatter 时分组带自动启用。';
      var note = U().el('div', {
        class: 'ps-note is-muted',
        text: noteText,
        title: noteText
      });
      note.setAttribute('data-note', 'merge-hist-na');
      items.push(note);
    }
    return group('3 · 防拥挤合并', items);
  }

  function buildFitGroup() {
    var methods = (YMS.Fitting && YMS.Fitting.METHODS && YMS.Fitting.METHODS.length)
      ? YMS.Fitting.METHODS : FIT_FALLBACK;
    var orderInp = mkNumber(draft.fitOrder, 2, 8, 1, function (v) {
      draft.fitOrder = Math.max(2, Math.min(8, v || 2));
    }, 52);
    function syncOrder() { orderInp.disabled = (draft.fit !== 'poly'); }
    syncOrder();
    var methodSel = mkSelect(methods, draft.fit, function (v) {
      draft.fit = v;
      syncOrder();
    });
    var binsInp = mkNumber(draft.histBins, 5, 80, 1, function (v) { draft.histBins = v; }, 52);
    binsInp.disabled = draft.type !== 'hist';
    return group('4 · 拟合 / 直方图', [
      field('拟合', [methodSel, mkMini('阶数'), orderInp]),
      field('柱数', binsInp)
    ]);
  }

  function buildStyleGroup() {
    var s = draft.style;
    var kids = [];
    kids.push(field('X 轴', [
      mkMini('字号'),
      mkNumber(s.xAxisFontSize, 8, 20, 1, function (v) { s.xAxisFontSize = v === null ? 11 : v; }, 50),
      mkSelect(WEIGHTS, s.xAxisFontWeight || 'normal', function (v) { s.xAxisFontWeight = v; }),
      mkColor(s.xAxisColor, function (v) { s.xAxisColor = v; })
    ]));
    /* 迭代 7 / 15：X 轴标签旋转角度（默认 90° 竖排；'auto' = 按拥挤度）
       迭代 8（需求 4）：**选中即刻生效** —— 写草稿后立即 applyDraft() + PlotView.render()，
       不必等 Submit（用户反馈"旋转未实现"，根因是旧实现只写草稿、用户没点 Submit；
       做法与 PlotSettings.setType 一致：不重建面板，只落库 + 重绘） */
    var rotSel = mkSelect(X_ROTATE_OPTIONS,
      (s.xRotate === 'auto' ? 'auto' : String(normXRotate(s.xRotate))),
      function (v) { s.xRotate = normXRotate(v); applyRotateNow(normXRotate(v)); });
    rotSel.id = 'ps-x-rotate';
    rotSel.title = X_ROTATE_TITLE;
    kids.push(field('X 轴旋转', rotSel));
    kids.push(field('Y 轴', [
      mkMini('字号'),
      mkNumber(s.yAxisFontSize, 8, 20, 1, function (v) { s.yAxisFontSize = v === null ? 11 : v; }, 50),
      mkSelect(WEIGHTS, s.yAxisFontWeight || 'normal', function (v) { s.yAxisFontWeight = v; }),
      mkColor(s.yAxisColor, function (v) { s.yAxisColor = v; })
    ]));
    kids.push(field('标题 / 图例', [
      mkMini('标题'),
      mkNumber(s.titleSize, 10, 24, 1, function (v) { s.titleSize = v === null ? 13 : v; }, 50),
      mkMini('图例'),
      mkNumber(s.legendSize, 8, 16, 1, function (v) { s.legendSize = v === null ? 11 : v; }, 50)
    ]));
    kids.push(field('Y 轴范围', [
      mkMini('Min'),
      mkNumber(s.yMin, null, null, 'any', function (v) { s.yMin = v; }, 58),
      mkMini('Max'),
      mkNumber(s.yMax, null, null, 'any', function (v) { s.yMax = v; }, 58)
    ]));
    kids.push(field('Y 轴小数位', mkNumber(s.yDecimals, 0, 8, 1, function (v) { s.yDecimals = v; }, 50)));
    kids.push(U().el('div', { class: 'chk-grid' }, [
      mkCheck('Y 轴对数', s.yLog, function (v) { s.yLog = v; }),
      mkCheck('显示数据值', s.showValueLabels, function (v) { s.showValueLabels = v; }),
      mkCheck('网格线', s.showGrid, function (v) { s.showGrid = v; }),
      mkCheck('Y 轴标题', s.showYAxisTitle, function (v) { s.showYAxisTitle = v; }),
      mkCheck('显示图例', s.showLegend, function (v) { s.showLegend = v; }),
      mkCheck('Box 中位数连线', s.boxMedianLine, function (v) { s.boxMedianLine = v; }),
      mkCheck('X 轴标题居中', s.xTitleCentered, function (v) { s.xTitleCentered = v; })
    ]));
    return group('5 · 图表元素属性', kids);
  }

  /* ------------------------------------------------- 迭代 4：分组 7 / 8 构建 */
  /** 统计量显示顺序（STAT_ORDER）：优先渲染层常量，兼容字符串或 {key,label} 两种形态 */
  function statOrder() {
    var A = YMS.Aggregate, raw = (A && A.STAT_ORDER) || null, out = [];
    if (raw && raw.length) {
      for (var i = 0; i < raw.length; i++) {
        var k = (typeof raw[i] === 'string') ? raw[i] : (raw[i] && raw[i].key);
        if (k && STAT_LABELS[k] && out.indexOf(k) < 0) out.push(k);
      }
    }
    return out.length ? out : STAT_ORDER_FALLBACK.slice();
  }
  /** 叠加同图仅对折线 / 散点生效（其它图型固定分面） */
  function supportsOverlay() { return draft.type === 'line' || draft.type === 'scatter'; }
  /** 统计行仅对分类轴图型生效（散点 X 轴为数值轴，不适用） */
  function supportsStats() { return draft.type !== 'scatter'; }

  /**
   * 迭代 8（需求 4）：X 轴旋转角「选中即刻生效」。
   * 把当前草稿整体落 Store（沿用 Submit 的同一路径），随后立刻重绘；不重建面板 DOM
   * （控件自身已显示新值，重建反而会打断用户连续操作）。任何异常都被吞掉并提示，不冒泡。
   * @param {number|string} v 归一化后的旋转角（0/30/45/60/90/'auto'）
   */
  function applyRotateNow(v) {
    try {
      if (!Store().hasData()) return;
      applyDraft();
      if (PV() && typeof PV().render === 'function') PV().render();
      U().setStatus('X 轴旋转已应用：' + (v === 'auto' ? '自动（按拥挤度）' : (v + '°')));
    } catch (e) {
      if (global.console && console.error) console.error('[YMS.PlotSettings] X 轴旋转立即生效失败', e);
      U().toast('X 轴旋转应用失败', 'warn');
    }
  }

  /**
   * 当前"这张图里有哪几条数据"：优先 YMS.Aggregate.seriesList(plot)（渲染层 SA-A 提供），
   * 未实现时回退为 Value 列名（key = label = 列名），保证设置区不因渲染层未就绪而空白。
   * @returns {Array<{key:string,label:string}>}
   */
  function seriesRows() {
    /* 用「草稿 + 已提交配置」拼出当前正在编辑的 plot：轴位列表必须随草稿走，
       否则用户刚把某列加进 Value（还没 Submit）时，列表里不会出现这一行。 */
    var committed = Store().state.plot || {};
    var plot = Object.assign({}, committed, {
      x: draft.x.slice(),
      values: draft.values.slice(),
      splitBy: draft.splitBy.slice(),
      display: draft.display,
      axisSide: Object.assign({}, draft.axisSide),
      group: {
        colorBy: (draft.group && draft.group.colorBy) || '',
        symbolBy: (draft.group && draft.group.symbolBy) || ''
      }
    });
    var list = null;
    if (YMS.Aggregate && typeof YMS.Aggregate.seriesList === 'function') {
      try { list = YMS.Aggregate.seriesList(plot); } catch (e) { list = null; }
    }
    if (!list || !list.length) {
      var cols = (draft.values && draft.values.length) ? draft.values : (plot.values || []);
      list = cols.map(function (n) { return { key: n, label: n }; });
    }
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {}, key = s.key || s.valueCol;
      if (!key || String(key) === '') continue;
      out.push({ key: String(key), label: s.label || String(key) });
    }
    return out;
  }

  /** 轴位行：[数据名][左轴 / 右轴]；键写回 draft.axisSide（缺省 left） */
  function axisSideRow(item, index) {
    var row = U().el('div', { class: 'axis-side-row' });
    row.appendChild(U().el('span', {
      class: 'axis-name', text: item.label,
      title: '数据系列：' + item.key
    }));
    var cur = (draft.axisSide[item.key] === 'right') ? 'right' : 'left';
    var sel = mkSelect([{ value: 'left', label: '左轴' }, { value: 'right', label: '右轴' }], cur,
      function (v) { draft.axisSide[item.key] = (v === 'right') ? 'right' : 'left'; },
      'axis-side-sel');
    sel.id = 'ps-axis-side-' + index;
    sel.setAttribute('data-series-key', item.key);
    sel.title = '数据系列：' + item.key + '（缺省左轴；左右轴各自独立自动范围）';
    row.appendChild(sel);
    return row;
  }

  /* ================================ 迭代 11：分组配色（每组可单独选颜色） ================================
     用户需求原文：「分组时，不同分组新增不同色阶颜色选择」——按颜色分组（颜色分组列 / 多 Value 系列）时，
     每个分组都能单独选颜色，而不再只能吃固定调色板。

     数据：plot.group.colors = { '<分组键>': '#rrggbb' }（键规则 = YMS.groupColorKey，与渲染层同源）
     交互（任务 I ②：竖排 12 行 → 一行「下拉选组 + 色块」）：
           ① 下拉 #ps-gc-select 选「当前要改哪一组」——选项 = 全部分组（不再截断到前 16 组），
              切换只换编辑对象、**一个颜色都不动**；
           ② 色块按钮 #ps-gc-swatch 显示所选组的当前颜色，点一下展开 12 色预设条（.gc-presets，
              末尾附原生 input[type=color] 系统取色器）——Chromium 内建，零依赖；
           ③ 「恢复默认」清空全部自定义 → 回到调色板映射
     生效：纯显示项，**改动立即生效**（写草稿 → applyDraft() → PlotView.render()，与「X 轴旋转」同一路径），
           同时随 .yms 持久化（Store.serialize 直接带 plot.group.colors）。 */
  var GC_MAX = 40;           // 分组枚举上限（与渲染层分组上限 40 一致）
  var gcOpenKey = null;      // 当前展开 12 色预设条的分组键（同一时刻只展开一组）
  var gcSelectedKey = null;  // 当前编辑的分组键（下拉 #ps-gc-select 的选中项）——切下拉只换它，不改颜色
  /* 渲染层未就绪时的兜底副本（与 chart-builder 的 PALETTE / PALETTE_ALT 同值，仅顺序取用） */
  var PALETTE_FALLBACK = ['#0b6e99', '#0f9d8f', '#b8860b', '#7b5ea7', '#c0392b', '#4a6fa5', '#8a6d3b', '#2f7d5c'];
  var PALETTE_ALT_FALLBACK = PALETTE_FALLBACK.concat(['#3a8dbe', '#6b8f71', '#a3563b', '#5b6bab']);

  function presetPalette() {
    var a = (YMS.ChartBuilder && YMS.ChartBuilder.PALETTE_ALT);
    return (a && a.length) ? a : PALETTE_ALT_FALLBACK;
  }
  function basePalette() {
    var a = (YMS.ChartBuilder && YMS.ChartBuilder.PALETTE);
    return (a && a.length) ? a : PALETTE_FALLBACK;
  }
  function isHex(v) {
    if (typeof YMS.isColorHex === 'function') return YMS.isColorHex(v);
    return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  }

  /* ================================ 迭代 26：图例色阶自动配色 ================================
     用户需求原文：「现在的逻辑是可以手动对每个图例修改色阶，保留这种方法，额外再增加一个
     自动为不同图例添加色阶的功能，你可以准备好很多分不同色阶的预设，如果图例有 10 个颜色，
     可以一键为所有的图例修改色阶。」追加口径：只要对比明显的离散色阶，不要连续过渡色阶。

     分工：
       · 色板数据 + 取色 / 色差算法 → js/plot/palettes.js（纯函数，YMS.Palettes）
       · 本区块只做：预设选择（存 plot.group.preset）+ 一键把 pickColors(preset, N) 写进
         plot.group.colors + 覆盖前确认 + 超容量提示。
     不变量：
       ① 手动逐个改色的既有路径（色块 / ▦ / 恢复默认）零改动 —— 自动只是「批量写同一个 map」；
       ② 自动写完后用户再手改某一项 → 该项与「预设按序号应得的颜色」不同，即被视为手改，
          下次自动配色会先问「将覆盖已手动调整的 N 个图例颜色」；
       ③ 同一预设 + 同一图例顺序 → 结果逐色一致（pickColors 是纯函数）。 */
  var PALETTE_DEFAULT_PRESET = 'tableau10';

  function Pal() { return YMS.Palettes || null; }
  /** 预设表（Palettes 未就绪时返回空数组，绝不抛异常） */
  function paletteList() {
    var P = Pal();
    return (P && P.PRESETS) ? P.PRESETS : [];
  }
  function presetKnown(id) {
    var P = Pal();
    return !!(P && typeof P.get === 'function' && P.get(id));
  }
  /** 草稿里的当前预设（非法 / 缺省 → tableau10） */
  function currentPresetId() {
    var id = (draft && draft.group) ? draft.group.preset : '';
    return presetKnown(id) ? id : PALETTE_DEFAULT_PRESET;
  }

  /**
   * 当前配色预览（纯计算，不改任何状态）：下拉改动 / 图例数变化 / 自测都读它
   * @param {string} [presetId] 缺省 = 草稿里的预设
   * @returns {{preset,name,n,capacity,over,suggest,colors,minDE,minPair,rows}}
   */
  function palettePreview(presetId) {
    var P = Pal();
    var id = presetKnown(presetId) ? presetId : currentPresetId();
    var rows = groupColorRows();
    var n = rows.length;
    var colors = (P && n) ? P.pickColors(id, n) : [];
    var min = (P && colors.length > 1) ? P.minDeltaE(colors) : { de: null, a: '', b: '' };
    var cap = (P && typeof P.capacity === 'function') ? P.capacity(id) : 0;
    var p = (P && typeof P.get === 'function') ? P.get(id) : null;
    return {
      preset: id,
      name: p ? p.name : id,
      n: n,
      capacity: cap,
      over: n > cap,
      suggest: (n > cap && P && typeof P.suggest === 'function') ? P.suggest(n) : '',
      colors: colors,
      minDE: min.de,
      minPair: (min.de === null) ? '' : (min.a + ' / ' + min.b),
      rows: rows
    };
  }

  /**
   * 「已手动调整」的图例键：当前色值存在、且与「本预设按该序号应得的颜色」不同即是手改
   * （自动配色写进去的颜色与预设一致 → 不计入手改，所以连点两次不会重复弹确认）
   * @param {string} [presetId] @returns {string[]}
   */
  function manualColorKeys(presetId) {
    var pv = palettePreview(presetId);
    var colors = (draft.group && draft.group.colors) ? draft.group.colors : {};
    var out = [];
    for (var i = 0; i < pv.rows.length; i++) {
      var k = pv.rows[i].key;
      var cur = colors[k];
      if (!isHex(cur)) continue;
      var want = pv.colors[i];
      if (!want || String(cur).toLowerCase() !== String(want).toLowerCase()) out.push(k);
    }
    return out;
  }

  /**
   * 一键自动配色（唯一写入路径；UI 按钮 / 自测共用）
   * @param {string} presetId 预设 id（非法 → 草稿预设 / 默认）
   * @param {boolean} force   true = 跳过「覆盖手改」确认（自测与确认后的第二次调用用）
   * @returns {{ok:boolean, needConfirm?:boolean, manual?:number, n?:number, preset?:string,
   *            applied?:number, over?:boolean, recommend?:string, minDE?:number, error?:string}}
   */
  function applyAutoColors(presetId, force) {
    var P = Pal();
    if (!P) return { ok: false, error: '色板模块未加载（缺乏 Palettes）' };
    var pv = palettePreview(presetId);
    if (!pv.n) {
      return { ok: false, error: (draft.type === 'hist')
        ? '直方图为单系列固定色，不支持分组配色'
        : '未分组：没有可自动配色的图例' };
    }
    var manual = manualColorKeys(pv.preset);
    if (manual.length && !force) {
      return { ok: false, needConfirm: true, manual: manual.length, n: pv.n, preset: pv.preset };
    }
    var next = {};
    for (var i = 0; i < pv.rows.length; i++) next[pv.rows[i].key] = pv.colors[i];
    draft.group.colors = next;
    draft.group.preset = pv.preset;
    draft.group.autoN = pv.n;
    applyColorsNow();
    return {
      ok: true, n: pv.n, preset: pv.preset, applied: pv.rows.length,
      over: pv.over, recommend: pv.suggest, minDE: pv.minDE, manual: manual.length,
      colors: pv.colors.slice()
    };
  }

  /** 切换预设（只记草稿 + 落库，不改颜色；颜色等用户点「一键自动配色」） */
  function setPalettePreset(id) {
    if (!presetKnown(id)) return false;
    if (!draft.group) draft.group = { colorBy: '', symbolBy: '', colors: {}, preset: '', autoN: 0 };
    draft.group.preset = id;
    applyColorsNow();
    var name = (Pal().get(id) || {}).name || id;
    U().setStatus('配色预设已切换：' + name + '（点「一键自动配色」应用到图例）');
    return true;
  }

  /** 色条预览（色条 = 当前图例数下本预设会分配的颜色，按顺序） */
  function paletteStrip(host, pv) {
    U().clear(host);
    host.title = pv.n
      ? ('本预设给当前 ' + pv.n + ' 个图例分配的颜色（顺序 = 分组列表顺序）：' + pv.colors.join(' '))
      : '当前没有可配色的图例';
    pv.colors.forEach(function (hex, i) {
      var sw = U().el('i', { class: 'gc-strip-sw', 'data-i': String(i) });
      sw.style.background = hex;
      sw.title = '第 ' + (i + 1) + ' 个图例：' + hex + (pv.rows[i] ? ('（' + pv.rows[i].label + '）') : '');
      host.appendChild(sw);
    });
  }

  /** 「参考数」行（迭代 26 引入）已在任务 I ① 中按用户口径**整行删除** ——
      含 ✓（容量内）/ ⚠ 超出上限 / ΔE2000 数值 / 建议改用 Kelly 22 全部分支都不再渲染。
      保留的是**功能层**：预设下拉（超容量时仍列出 Kelly 22）、一键自动配色、色条预览、
      以及超容量提示条 #ps-palette-warn（它不属「参考数」行，仍提示「循环 + 明度分层」并建议换预设）。
      守卫断言见 test/cases/palette-auto.js 1.9 / 5.5 与 test/cases/settings-ui-slim.js。 */

  /** 迭代 26：配色行（预设下拉 + 一键自动配色 + 色条预览） */
  function buildPaletteAutoBlock() {
    var pv = palettePreview();
    var box = U().el('div', { class: 'gc-auto', id: 'ps-palette-auto' });

    var row = U().el('div', { class: 'gc-auto-row' });
    row.appendChild(U().el('span', { class: 'gc-auto-lab', text: '配色' }));

    var list = paletteList();
    var opts = list.map(function (p) {
      return { value: p.id, label: p.name + '（' + p.colors.length + '）' };
    });
    if (!opts.length) opts = [{ value: PALETTE_DEFAULT_PRESET, label: 'Tableau 10（10）' }];
    var sel = mkSelect(opts, pv.preset, function (v) { setPalettePreset(v); refreshGroupColors(); });
    sel.id = 'ps-palette-preset';
    sel.className = 'gc-auto-sel';
    var curP = (Pal() && Pal().get(pv.preset)) || null;
    sel.title = curP
      ? ('图例色阶预设：' + curP.name + '（来源 ' + curP.source + '，上限 ' + curP.colors.length + ' 类目）\n' + curP.desc)
      : '图例色阶预设';
    row.appendChild(sel);
    box.appendChild(row);

    /* 第 2 行：一键按钮 + 色条预览（300px 设置区里按钮不再与下拉抢宽度） */
    var row2 = U().el('div', { class: 'gc-auto-row' });
    var btn = U().el('button', {
      class: 'mini-btn gc-auto-btn', type: 'button', id: 'ps-palette-apply',
      text: '🎨 一键自动配色',
      title: '把本预设的颜色按分组列表顺序一次性分配给当前全部图例（会覆盖手动改过的颜色，点前会确认）'
    });
    btn.disabled = !pv.n;
    btn.addEventListener('click', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      onAutoClick();
    });
    row2.appendChild(btn);

    var strip = U().el('div', { class: 'gc-strip', id: 'ps-palette-strip' });
    paletteStrip(strip, pv);
    row2.appendChild(strip);
    box.appendChild(row2);

    /* 任务 I ①：原「参考数：N 个图例 / 本预设上限 M ✓ · 两两最小 ΔE2000 x.x」整行不再渲染
       （含超容量 ⚠ / 建议改用 Kelly 22 各分支）。超容量提示条 #ps-palette-warn 保留。 */
    if (pv.over) {
      box.appendChild(U().el('div', {
        class: 'gc-auto-warn', id: 'ps-palette-warn',
        text: '「' + pv.name + '」只有 ' + pv.capacity + ' 色，' + pv.n + ' 个图例将进入「循环 + 明度分层」'
          + '（颜色会变暗/变亮，两两可辨度下降）—— 建议换成'
          + (pv.suggest ? ('「' + ((Pal().get(pv.suggest) || {}).name || pv.suggest) + '」') : '更大的预设') + '。'
      }));
    }
    return box;
  }

  /** 一键按钮：有手改 → 先确认（「将覆盖已手动调整的 N 个图例颜色，继续？」） */
  function onAutoClick() {
    var pv = palettePreview();
    if (!pv.n) { U().toast('未分组：没有可自动配色的图例', 'warn'); return; }
    var manual = manualColorKeys(pv.preset).length;
    var run = function () {
      var r = applyAutoColors(pv.preset, true);
      if (!r.ok) { U().toast(r.error || '自动配色失败', 'warn'); return; }
      U().toast('已应用「' + pv.name + '」：' + r.applied + ' 个图例', r.over ? 'warn' : 'ok');
      if (r.over) {
        U().toast('「' + pv.name + '」上限 ' + pv.capacity + ' 色，已按「循环 + 明度分层」补齐；建议改用'
          + (r.recommend ? ('「' + ((Pal().get(r.recommend) || {}).name || r.recommend) + '」') : '更大预设'), 'warn');
      }
      U().setStatus('图例自动配色已应用：' + pv.name + '（' + r.applied + ' 个图例）');
    };
    if (!manual) { run(); return; }
    U().confirm({
      title: '一键自动配色',
      message: '将覆盖已手动调整的 ' + manual + ' 个图例颜色，继续？',
      okText: '覆盖并应用', cancelText: '取消'
    }).then(function (ok) { if (ok) run(); });
  }

  /** 颜色分组列取值列表（按出现顺序去重，上限 40）—— 标签格式与渲染层 rowGroupLabel 一致 */
  function colorByValues(col) {
    var out = [], seen = Object.create(null);
    var v = Store().getView();
    var df = Store().state.df;
    if (!v || !df) return out;
    var ci = df.colIndex(col);
    if (ci < 0) return out;
    var c = df.cols[ci];
    var ds = Store().state.dataSettings || {};
    var dec = (ds.decimals && ds.decimals[c.name] !== undefined) ? ds.decimals[c.name] : null;
    for (var i = 0; i < v.count && out.length < GC_MAX; i++) {
      var val = v.valueAt(i, ci);
      if (val === null || val === undefined) continue;      // 缺失值不列出（渲染层仍按默认色调色）
      var label;
      if (c.type === YMS.types.STRING) label = String(val);
      else label = YMS.types.formatValue(val, c.type, dec, c.timeStyle || 'datetime');
      if (seen[label]) continue;
      seen[label] = 1;
      out.push(label);
    }
    return out;
  }

  /** 当前实际存在的分组（键 = 分组配色键）：有颜色分组列 → 该列取值；否则 → 系列键 */
  function groupColorRows() {
    /* 直方图：单系列固定色（迭代 4 起就不支持颜色分组）→ 不列分组，避免给出无效的取色行 */
    if (draft.type === 'hist') return [];
    var by = (draft.group && draft.group.colorBy) || '';
    if (by) {
      return colorByValues(by).map(function (lab) { return { key: lab, label: lab }; });
    }
    var rows = seriesRows();
    var out = [];
    for (var i = 0; i < rows.length && out.length < GC_MAX; i++) {
      out.push({ key: rows[i].key, label: rows[i].key });
    }
    return out;
  }

  /** 未自定义时该分组的「当前生效色」（仅用于色块显示；渲染层仍由调色板兜底） */
  function defaultColorFor(index) {
    if (draft.group && draft.group.colorBy) {
      var alt = presetPalette();
      return alt[index % alt.length];
    }
    /* 未分组的 Box：渲染层对所有箱体系列统一用固定色 PALETTE[0]（迭代 3 起的既有行为，
       不随序号变化）—— 色块如实显示该色，避免预览色与图上颜色不一致 */
    if (draft.type === 'box') return basePalette()[0];
    var pal = basePalette();
    return pal[index % pal.length];
  }

  /** 所选分组的「当前生效色」（自定义色优先，否则默认调色板色）+ 是否自定义 */
  function gcShown(item, index, colors) {
    var cur = colors ? colors[item.key] : null;
    return { hex: isHex(cur) ? cur : defaultColorFor(index), custom: isHex(cur) };
  }

  /** 一行：[下拉选组 #ps-gc-select][色块 #ps-gc-swatch]
      任务 I ②（用户口径「分组配色部分改成下拉框」）：原来 12 行竖排（色块 + 组名 + ▦）压成一行。
      · 下拉选项 = 当前**全部**分组（不再截断到前 16 组，天然没有「仅显示前 N 组」的高度问题）；
      · 切换下拉只换「当前编辑哪一组」（gcSelectedKey），**一个颜色都不动**；
      · 点色块 → 展开 12 色预设条（presetStrip），选完立即生效并随 .yms 保存。 */
  function groupColorPicker(rows, colors) {
    var idx = gcIndexOf(rows, gcSelectedKey);
    if (idx < 0) { idx = 0; gcSelectedKey = rows.length ? rows[0].key : null; }
    var item = rows[idx];
    var shown = gcShown(item, idx, colors);

    var row = U().el('div', { class: 'gc-pick', id: 'ps-gc-pick' });
    var opts = rows.map(function (r, i) {
      var c = gcShown(r, i, colors);
      return {
        value: r.key, label: r.label,
        title: r.key + '（当前色 ' + c.hex + (c.custom ? ' · 自定义' : ' · 默认') + '）'
      };
    });
    var sel = mkSelect(opts, item.key, function (v) {
      if (!v || v === gcSelectedKey) return;
      gcSelectedKey = v;          // 只切「当前编辑哪一组」，颜色一律不动
      refreshGroupColors();
    }, 'gc-sel');
    sel.id = 'ps-gc-select';
    sel.title = '选择要改色的分组（共 ' + rows.length + ' 组；切换不会改动任何颜色）';
    sel.style.boxShadow = 'inset 3px 0 0 0 ' + shown.hex;   // 左侧细色条 = 当前组的颜色（纯绘制，不改几何）
    row.appendChild(sel);

    var sw = U().el('button', {
      class: 'gc-swatch' + (shown.custom ? ' is-custom' : ''), type: 'button', id: 'ps-gc-swatch',
      title: item.key + '：' + (shown.custom ? ('自定义色 ' + shown.hex) : ('默认色 ' + shown.hex))
        + '（点一下展开 12 色预设 / 系统取色器）'
    });
    sw.setAttribute('data-gc-key', item.key);
    sw.style.background = shown.hex;
    sw.addEventListener('click', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      gcOpenKey = (gcOpenKey === item.key) ? null : item.key;
      refreshGroupColors();
    });
    row.appendChild(sw);
    return row;
  }

  /** 展开的 12 色预设条 + 系统取色器（点一下即用该色；末尾「自定义…」开原生 input[type=color]） */
  function presetStrip(item, shown) {
    var box = U().el('div', { class: 'gc-presets', 'data-gc-for': item.key });
    presetPalette().forEach(function (hex) {
      var b = U().el('button', {
        class: 'gc-preset', type: 'button', 'data-gc-preset': hex,
        title: hex + '（点一下即用该色）'
      });
      b.style.background = hex;
      b.addEventListener('click', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        setGroupColor(item.key, hex);
      });
      box.appendChild(b);
    });
    /* 系统取色器：原来「点色块直接开系统取色器」，现在折进展开条里（能力不丢） */
    var lab = U().el('label', {
      class: 'gc-pickcolor', title: '系统取色器：给「' + item.key + '」取任意颜色（选完立即生效，随 .yms 保存）'
    });
    lab.appendChild(U().el('span', { class: 'gc-pickcolor-txt', text: '自定义…' }));
    var inp = U().el('input', {
      type: 'color', class: 'gc-color', id: 'ps-gc-color', value: shown || '#4a5866', 'data-gc-key': item.key
    });
    inp.addEventListener('change', function () { setGroupColor(item.key, inp.value); });
    lab.appendChild(inp);
    box.appendChild(lab);
    return box;
  }

  /** 下拉里的目标分组序号（找不到 = -1 → 调用方回落到第 0 组） */
  function gcIndexOf(rows, key) {
    if (!key) return -1;
    for (var i = 0; i < rows.length; i++) { if (rows[i].key === key) return i; }
    return -1;
  }

  /** 填充「分组配色」区块（#ps-group-colors）：可在不重建整个面板的情况下原地重填 */
  function fillGroupColors(host) {
    U().clear(host);
    var rows = groupColorRows();
    var colors = (draft.group && draft.group.colors) ? draft.group.colors : {};
    var customKeys = Object.keys(colors).filter(function (k) { return isHex(colors[k]); });
    host.title = '按分组自定义颜色：下拉选组 → 点色块展开 12 色预设（或系统取色器）；改动立即生效（无需 Submit），并随 .yms 保存';

    var head = U().el('div', { class: 'gc-head' });
    head.appendChild(U().el('span', {
      class: 'gc-count',
      text: rows.length ? (rows.length + ' 组' + (customKeys.length ? ' · 已自定义 ' + customKeys.length : '')) : ''
    }));
    var reset = U().el('button', {
      class: 'gc-reset', type: 'button', id: 'ps-group-colors-reset', text: '恢复默认',
      title: customKeys.length ? '清空全部自定义颜色，回到默认调色板映射' : '当前全部为默认色（无可恢复项）'
    });
    reset.disabled = !customKeys.length;
    reset.addEventListener('click', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      resetGroupColors();
    });
    head.appendChild(reset);
    host.appendChild(head);

    if (!rows.length) {
      host.appendChild(U().el('div', {
        class: 'gc-empty',
        text: (draft.type === 'hist') ? '直方图为单系列固定色，不支持分组配色' : '未分组：按系列取默认色板'
      }));
      return;
    }
    /* 迭代 26：配色行（预设下拉 / 一键自动配色 / 色条预览）——只在有图例时出现（参考数行已删） */
    host.appendChild(buildPaletteAutoBlock());
    /* 任务 I ②：竖排 12 行 → 一行「下拉选组 + 色块」；点色块才就地展开 12 色预设条 */
    host.appendChild(groupColorPicker(rows, colors));
    var idx = gcIndexOf(rows, gcSelectedKey);
    if (idx >= 0 && gcOpenKey === gcSelectedKey) {
      host.appendChild(presetStrip(rows[idx], gcShown(rows[idx], idx, colors).hex));
    }
  }

  /** 原地重填区块（只在配色变化 / 展开预设时用，不重建整面板 → 不打断连续取色、不跳滚动） */
  function refreshGroupColors() {
    var host = (body && body.querySelector) ? body.querySelector('#ps-group-colors') : null;
    if (!host) { renderPanel(); return; }
    fillGroupColors(host);
  }

  /** 写草稿 + 立即生效（纯显示项：落 Store 后重绘，仍随 .yms 持久化） */
  function applyColorsNow() {
    try {
      if (!Store().hasData()) { refreshGroupColors(); return; }
      applyDraft();
      if (PV() && typeof PV().render === 'function') PV().render();
      refreshGroupColors();
    } catch (e) {
      if (global.console && global.console.error) console.error('[YMS.PlotSettings] 分组配色立即生效失败', e);
      U().toast('分组配色应用失败', 'warn');
    }
  }
  /** 给某个分组设自定义色（非法值忽略，不抛异常） */
  function setGroupColor(key, hex) {
    if (!key || !isHex(hex)) return;
    if (!draft || !draft.group) return;
    if (!draft.group.colors) draft.group.colors = {};
    draft.group.colors[key] = hex;
    applyColorsNow();
    U().setStatus('分组配色已应用：' + key + ' → ' + hex);
  }
  /** 恢复默认：清空全部自定义色（回到调色板映射） */
  function resetGroupColors() {
    if (!draft || !draft.group) return;
    draft.group.colors = {};
    gcOpenKey = null;
    applyColorsNow();
    U().setStatus('分组配色已恢复默认色板');
  }

  /** 6 组内的「分组配色」区块（#ps-group-colors） */
  function buildGroupColorsBlock() {
    var host = U().el('div', { class: 'gc-block', id: 'ps-group-colors' });
    fillGroupColors(host);
    return host;
  }

  /** 7 · 多数据同图 / 多 Y 轴：显示方式 + 每条数据的轴位 + 颜色/符号分组列 */
  function buildOverlayGroup() {
    var displaySel = mkSelect([
      { value: 'facet', label: '分面显示' },
      { value: 'overlay', label: '叠加同图' }
    ], draft.display === 'overlay' ? 'overlay' : 'facet', function (v) {
      draft.display = (v === 'overlay') ? 'overlay' : 'facet';
      renderPanel();          // 叠加会改变数据条目（列名@组标签），列表随之刷新
    });
    displaySel.id = 'ps-display';
    var okOverlay = supportsOverlay();
    displaySel.disabled = !okOverlay;
    displaySel.title = okOverlay
      ? '分面显示：每个分组一张卡片；叠加同图：各分组画在同一张图内对比'
      : '叠加同图仅折线图 / 散点图可用，其它图型固定分面显示';

    var list = U().el('div', { class: 'axis-side-list', id: 'ps-axis-side', title: '每条数据的 Y 轴轴位（缺省左轴；左右轴各自独立自动范围）' });
    var rows = seriesRows();
    if (rows.length) rows.forEach(function (it, i) { list.appendChild(axisSideRow(it, i)); });
    else list.appendChild(U().el('div', { class: 'axis-side-empty', text: '未选择' }));

    var colorSel = mkSelect([{ value: '', label: '（不分组）' }].concat(plainColOptions()),
      draft.group.colorBy || '', function (v) {
        draft.group.colorBy = v || '';
        refreshGroupColors();     // 迭代 11：颜色分组列变了 → 分组配色列表随之刷新
      });
    colorSel.id = 'ps-color-by';
    colorSel.title = '颜色分组列：同值同色、不同值不同色（（不分组）= 按系列序号取默认色）';

    var symbolSel = mkSelect([{ value: '', label: '（不分组）' }].concat(plainColOptions()),
      draft.group.symbolBy || '', function (v) { draft.group.symbolBy = v || ''; });
    symbolSel.id = 'ps-symbol-by';
    symbolSel.title = '符号分组列：按取值映射散点 / 折线符号（（不分组）= 折线用圆点）';

    return group('6 · 多数据同图 / 多 Y 轴', [
      field('显示方式', displaySel),
      field('Y 轴轴位', list),
      field('颜色分组', colorSel),
      field('符号分组', symbolSel),
      /* 迭代 11：分组配色 —— 每个分组单独选颜色（色块 / 12 色预设 / 恢复默认，改动立即生效） */
      field('分组配色', buildGroupColorsBlock())
    ]);
  }

  /** 7 · 横轴统计行：显示开关 + 统计量下拉复选框（顺序恒为 STAT_ORDER）+ 统计量旋转 */
  function buildStatsGroup() {
    var order = statOrder(), checked = {};
    (draft.stats.items || []).forEach(function (k) { checked[k] = true; });

    var catOk = supportsStats();
    var statsTitle = catOk
      ? '在 X 轴刻度下方按列追加统计文本（数值取首个 Value 列）'
      : '散点图的 X 轴为数值轴，不显示统计行';
    var showLab = mkCheckId('ps-stats-show', '显示统计行', !!draft.stats.show,
      function (v) { draft.stats.show = !!v; }, statsTitle);
    showLab.querySelector('input').disabled = !catOk;
    if (!catOk) showLab.className = 'chk-line is-off';

    /* 迭代 12（需求 ②）：统计量改用**下拉复选框**（复用 U().dropSelect）——
       平时只显示已选项（触发器文本 = 已选项按 STAT_ORDER 拼接 / 未选显示「未选择」），
       点开才在触发器下方弹出选项面板；勾选即写草稿、面板保持打开；点外部或 Esc 关闭；底部「清空」。
       生效路径不变：草稿 → Submit。顺序恒按 STAT_ORDER（dropSelect 内部顺序是点击先后，
       故每次变更后把它的选中顺序重置为 STAT_ORDER → 触发器文本与 plot.stats.items 完全一致）。 */
    var itemsBox = U().el('div', { class: 'stats-items-drop', id: 'ps-stats-items' });
    var statOpts = order.map(function (k) {
      return { value: k, label: STAT_LABELS[k], title: STAT_TITLES[k] || STAT_LABELS[k] };
    });
    var initial = order.filter(function (k) { return !!checked[k]; });
    var statsDrop = U().dropSelect({
      id: 'ps-stats-select',
      options: statOpts,
      values: initial,
      placeholder: '未选择',
      maxHeight: 232,
      onChange: function (vals) {
        var seen = Object.create(null);
        (vals || []).forEach(function (k) { seen[k] = 1; });
        draft.stats.items = order.filter(function (k) { return !!seen[k]; });   // 恒定按 STAT_ORDER
        statsDrop.set(draft.stats.items);                                        // 触发器文本同序
      }
    });
    itemsBox.appendChild(statsDrop.node);
    if (!catOk) {
      itemsBox.className += ' is-off';
      statsDrop.trigger.disabled = true;
      statsDrop.trigger.title = '散点图的 X 轴为数值轴，不显示统计行';
    } else {
      itemsBox.title = statsTitle + '；勾选多少项即显示多少行（点面板外或 Esc 收起）';
    }

    /* 迭代 12（需求 ③）：统计量旋转（独立于「X 轴旋转」；草稿 + Submit 生效） */
    var rotSel = mkSelect(STAT_ROTATE_OPTIONS, String(normStatRotate(draft.stats.rotate)),
      function (v) { draft.stats.rotate = normStatRotate(v); });
    rotSel.id = 'ps-stats-rotate';
    rotSel.title = catOk
      ? '统计量（数值行）自身的旋转角，与「5 · 图表元素属性 → X 轴旋转」（类别名）互不影响；选中后点 Submit 生效'
      : '散点图的 X 轴为数值轴，无统计行';
    rotSel.disabled = !catOk;

    /* 迭代 8（需求 5）：横轴坐标表格方框（含左侧行名）—— 默认关闭；
       开启后给横轴的数据表格 / 统计表格画完整外框 + 行·列分隔线，并把左侧行名列框进去。
       控件 id = #ps-table-frame；字段落到 plot.table.frame（见 store.js defaultTable 与文件头注释）。 */
    var frameTitle = catOk
      ? '给横轴的数据/统计表格加外框与行·列分隔线，并把左侧行名列框进去（默认关闭）'
      : '散点图的 X 轴为数值轴，无横轴表格，不适用';
    var frameLab = mkCheckId('ps-table-frame', '表格方框（含左侧行名）', !!draft.table.frame,
      function (v) { draft.table.frame = !!v; }, frameTitle);
    frameLab.className = 'chk-line table-frame-line' + (catOk ? '' : ' is-off');
    if (!catOk) frameLab.querySelector('input').disabled = true;

    return group('7 · 横轴统计行', [
      field('统计行', showLab),
      field('统计量', itemsBox),
      field('统计量旋转', rotSel),
      field('表格方框', frameLab)
    ]);
  }

  /* ==========================================================================
     任务 F（2026-10-23）：第 8 区「图例与图元」
     --------------------------------------------------------------------------
     · 图例组（位置/排列/文字色/底色/边框/内距/符号尺寸/间距/滚动）**所有图型都显示**；
     · 图元组**只显示当前图型相关的那一组**（其余 display:none —— 隐藏，不是置灰）；
     · 颜色只作用于图例显示层：plot.mark 里没有任何系列颜色字段，系列配色仍走第 6 区；
     · 控件 id 统一前缀 ps-legend-* / ps-mark-*（自测按 id 断言，共 11 + 12 = 23 个）；
     · 每个控件带 title 悬停说明；草稿 + Submit 生效（与其余各区一致）。
     ========================================================================== */
  function withTitle(node, text) {
    if (node && text) node.title = text;
    return node;
  }
  /** 下拉（带 id + title） */
  function mkSelectId(id, options, value, onChange, title) {
    var sel = mkSelect(options, value, onChange);
    sel.id = id;
    return withTitle(sel, title);
  }
  /** 数字控件（带 id + title）：输入清空 → onChange(null) */
  function mkNumT(id, value, min, max, step, onChange, title, width) {
    var inp = withTitle(mkNumber(value, min, max, step, onChange, width), title);
    inp.id = id;
    return inp;
  }
  /** 色值控件 + 「透明」勾选（null = 透明 / 不设置） */
  function mkNullableColor(id, value, onChange, title, fallback) {
    var wrap = U().el('span', { class: 'inline-picker', style: 'gap:6px' });
    var colorInp = withTitle(mkColor(value || fallback, function (v) { onChange(v); }), title);
    colorInp.id = id;
    var chkId = id + '-transparent';
    var chk = U().el('input', { type: 'checkbox', id: chkId });
    chk.title = '勾选 = 透明（不设置该颜色）';
    chk.checked = (value === null || value === undefined);
    chk.addEventListener('change', function () { onChange(chk.checked ? null : (colorInp.value || fallback)); });
    var lab = U().el('label', { class: 'chk-line', for: chkId, title: '勾选 = 透明' }, [chk, U().el('span', { text: '透明' })]);
    wrap.appendChild(colorInp);
    wrap.appendChild(lab);
    return wrap;
  }
  /** 形状下拉（7 种，与 YMS.SYMBOL_SHAPES 同源） */
  function symbolShapeSelect(id, value, onChange, title) {
    var list = YMS.SYMBOL_SHAPES || ['circle', 'rect', 'roundRect', 'triangle', 'diamond', 'pin', 'arrow'];
    var label = { circle: '圆形', rect: '方形', roundRect: '圆角方形', triangle: '三角形',
      diamond: '菱形', pin: '水滴', arrow: '箭头' };
    return mkSelectId(id, list.map(function (s) { return { value: s, label: label[s] || s }; }),
      value || 'circle', onChange, title);
  }
  function buildLegendGroup() {
    var lg = draft.legend;
    var kids = [];
    kids.push(field('位置', [
      mkSelectId('ps-legend-position', [
        { value: 'top', label: '上（默认）' },
        { value: 'bottom', label: '下' },
        { value: 'left', label: '左' },
        { value: 'right', label: '右' }
      ], lg.position, function (v) { lg.position = v; renderPanel(); },
        '图例摆放位置；切到左/右/下时绘图区自动让位（图例与绘图区不重叠）')
    ]));
    kids.push(field('排列', [
      mkSelectId('ps-legend-orient', [
        { value: 'auto', label: '自动（上/下横排、左/右竖排）' },
        { value: 'horizontal', label: '横排' },
        { value: 'vertical', label: '竖排' }
      ], lg.orient, function (v) { lg.orient = v; }, '图例条目排列方向；自动 = 按位置推导')
    ]));
    kids.push(field('文字色', [
      withTitle(mkColor(lg.textColor || '#4a5866', function (v) { lg.textColor = v; }),
        '图例文字颜色（只影响图例显示层，不影响系列颜色）')
    ]));
    kids.push(field('背景色', mkNullableColor('ps-legend-bg-color', lg.bgColor,
      function (v) { lg.bgColor = v; }, '图例底色；透明 = 不画底色', '#ffffff')));
    kids.push(field('边框色', mkNullableColor('ps-legend-border-color', lg.borderColor,
      function (v) { lg.borderColor = v; }, '图例边框颜色（边框宽 > 0 时可见）', '#b6c0c9')));
    kids.push(field('边框宽', [
      mkNumT('ps-legend-border-width', lg.borderWidth, 0, 4, 1,
        function (v) { lg.borderWidth = (v === null ? 0 : v); }, '图例边框粗细（0 = 无边框，默认）', 52)
    ]));
    kids.push(field('内边距', [
      mkNumT('ps-legend-padding', lg.padding, 0, 24, 1,
        function (v) { lg.padding = (v === null ? 0 : v); }, '图例内边距（0 = 沿用 ECharts 默认 5px）', 52)
    ]));
    kids.push(field('图例符号', [
      mkMini('宽'),
      mkNumT('ps-legend-item-width', lg.itemWidth, 6, 40, 1,
        function (v) { lg.itemWidth = (v === null ? 14 : v); }, '图例符号宽度（默认 14）', 46),
      mkMini('高'),
      mkNumT('ps-legend-item-height', lg.itemHeight, 4, 24, 1,
        function (v) { lg.itemHeight = (v === null ? 9 : v); }, '图例符号高度（默认 9）', 46)
    ]));
    kids.push(field('条目间距', [
      mkNumT('ps-legend-item-gap', lg.itemGap, 0, 40, 1,
        function (v) { lg.itemGap = (v === null ? 12 : v); }, '图例条目间距（默认 12）', 52)
    ]));
    kids.push(field('滚动', [
      mkSelectId('ps-legend-scroll', [
        { value: 'auto', label: '自动（条目 > 6 才滚动）' },
        { value: 'on', label: '总是滚动' },
        { value: 'off', label: '从不滚动' }
      ], lg.scrollMode, function (v) { lg.scrollMode = v; renderPanel(); },
        '图例条目过多时是否分页滚动；自动 = 保持原有「> 6 条才滚动」')
    ]));
    /* 图元组：只显示当前图型相关的那一组（其余 display:none 隐藏，不置灰） */
    kids.push(U().el('div', { class: 'group-sub', text: '图元（只显示当前图型）' }));
    kids.push(buildMarkGroup());
    return group('8 · 图例与图元', kids);
  }
  /** 一个图型的图元控件组（外包一层 data-mark-type，非当前图型 → display:none 隐藏） */
  function markTypeWrap(typeName, title, children) {
    var on = (draft.type === typeName) ||
      (typeName === 'bar' && (draft.type === 'bar' || draft.type === 'hist'));
    var el = U().el('div', { class: 'ps-mark-group', 'data-mark-type': typeName }, [
      U().el('div', { class: 'group-sub', text: title })
    ]);
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    el.style.display = on ? '' : 'none';
    return el;
  }
  function buildMarkGroup() {
    var mk = draft.mark;
    var boxGrp = markTypeWrap('box', 'Box 图元', [
      field('箱宽比', [
        mkNumT('ps-mark-box-ratio', mk.boxRatio, 0.10, 1.00, 0.05,
          function (v) { mk.boxRatio = (v === null ? 0.72 : v); },
          '箱宽 = 带宽 × 该比例（默认 0.72；范围 0.10~1.00）', 62)
      ]),
      field('箱线宽', [
        mkNumT('ps-mark-box-line-width', mk.boxLineWidth, 0.5, 4, 0.1,
          function (v) { mk.boxLineWidth = (v === null ? 1.2 : v); },
          '箱体边框线宽（默认 1.2；范围 0.5~4）', 62)
      ])
    ]);
    var barGrp = markTypeWrap('bar', 'Bar / Hist 图元', [
      field('柱宽比', [
        mkNumT('ps-mark-bar-ratio', mk.barRatio, 0.10, 1.00, 0.05,
          function (v) { mk.barRatio = (v === null ? 0.88 : v); },
          '柱宽占带宽比例（默认 0.88 = 原 12% 间隙；范围 0.10~1.00）', 62)
      ]),
      field('圆角', [
        mkNumT('ps-mark-bar-radius', mk.barRadius, 0, 12, 1,
          function (v) { mk.barRadius = (v === null ? 0 : v); }, '柱体圆角半径（0 = 直角，默认）', 62)
      ])
    ]);
    var lineGrp = markTypeWrap('line', 'Line 图元', [
      field('线宽', [
        mkNumT('ps-mark-line-width', mk.lineWidth, 0.5, 6, 0.1,
          function (v) { mk.lineWidth = (v === null ? 1.8 : v); },
          '折线线宽（默认 1.8；范围 0.5~6）', 62)
      ]),
      field('线型', [
        mkSelectId('ps-mark-line-type', [
          { value: 'solid', label: '实线' },
          { value: 'dashed', label: '虚线' },
          { value: 'dotted', label: '点线' }
        ], mk.lineType, function (v) { mk.lineType = v; }, '折线线型（默认实线）')
      ]),
      field('数据点', [
        mkCheckId('ps-mark-show-symbol', '显示数据点', mk.showSymbol !== false,
          function (v) { mk.showSymbol = v; }, '关闭后不画数据点（类别 > 120 时原本就不画）')
      ]),
      field('点大小', [
        mkNumT('ps-mark-symbol-size', mk.symbolSize, 2, 20, 1,
          function (v) { mk.symbolSize = (v === null ? 5 : v); },
          '数据点直径（默认 5；范围 2~20）', 62)
      ]),
      field('点形状', [
        symbolShapeSelect('ps-mark-symbol-shape', mk.symbolShape, function (v) { mk.symbolShape = v; },
          '数据点形状（默认圆形；分组符号优先于默认圆形）')
      ])
    ]);
    var scGrp = markTypeWrap('scatter', 'Scatter 图元', [
      field('点大小', [
        mkNumT('ps-mark-scatter-size', mk.scatterSize, 2, 24, 1,
          function (v) { mk.scatterSize = (v === null ? 6 : v); },
          '散点直径（默认 6；范围 2~24）', 62)
      ]),
      field('不透明度', [
        mkNumT('ps-mark-scatter-opacity', mk.scatterOpacity, 0.10, 1.00, 0.05,
          function (v) { mk.scatterOpacity = (v === null ? 0.72 : v); },
          '散点不透明度（默认 0.72；范围 0.10~1.00）', 62)
      ]),
      field('点形状', [
        symbolShapeSelect('ps-mark-scatter-shape', mk.scatterShape, function (v) { mk.scatterShape = v; },
          '散点形状（默认圆形）')
      ])
    ]);
    return U().el('div', { class: 'ps-mark-groups' }, [boxGrp, barGrp, lineGrp, scGrp]);
  }

  function buildActions() {
    var g = U().el('div', { class: 'setting-group ps-actions' });
    var submit = U().el('button', { class: 'btn btn-submit', text: 'Submit', title: '应用绘图配置并渲染' });
    submit.addEventListener('click', function () { submitDraft(); });
    var reset = U().el('button', { class: 'btn btn-block', text: '重置', title: '放弃草稿，恢复当前已应用配置' });
    reset.addEventListener('click', function () { syncFromStore(); renderPanel(); });
    g.appendChild(U().el('div', { class: 'ps-btn-row' }, [submit, reset]));
    return g;
  }

  function typeLabel(v) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].value === v) return TYPES[i].label;
    return v || '';
  }

  /** 收集 body 及其可滚动祖先的 scrollTop（重建 DOM 会把它清零 → 面板跳回首行） */
  function scrollKeepers(node) {
    var out = [], p = node, doc = global.document;
    while (p && p.nodeType === 1 && p !== doc.body && p !== doc.documentElement) {
      var cs = global.getComputedStyle ? global.getComputedStyle(p) : null;
      if (cs && /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) {
        out.push({ el: p, top: p.scrollTop });
      }
      p = p.parentNode;
    }
    return out;
  }
  function restoreScroll(keepers) {
    for (var i = 0; i < keepers.length; i++) {
      var k = keepers[i];
      var max = k.el.scrollHeight - k.el.clientHeight;
      k.el.scrollTop = max > 0 ? Math.min(k.top, max) : 0;   // 内容变短时贴底而非跳顶
    }
  }

  /** 重建面板 DOM（草稿 → 界面）。**保留滚动位置**：Submit 后不回到首行 */
  function renderPanel() {
    if (!body) return;
    if (U().closeDropSelect) U().closeDropSelect();   // 展开中的下拉面板挂在 body 上，重建前先收起
    var keepers = scrollKeepers(body);
    U().clear(body);
    if (!Store().hasData()) {
      body.innerHTML = '<div class="empty-hint">尚未载入数据 —— 请用 Data 菜单 → Data Import 导入 CSV / Excel（示例数据在 sample/ 目录）</div>';
      restoreScroll(keepers);
      return;
    }
    if (!draft) syncFromStore();
    body.appendChild(buildColumnGroup());
    body.appendChild(buildLayoutGroup());
    body.appendChild(buildMergeGroup());
    body.appendChild(buildFitGroup());
    body.appendChild(buildStyleGroup());
    body.appendChild(buildOverlayGroup());
    body.appendChild(buildStatsGroup());
    body.appendChild(buildLegendGroup());          // 任务 F：第 8 区「图例与图元」
    body.appendChild(buildActions());
    restoreScroll(keepers);
  }

  /* ------------------------------------------------------------- 生效 */
  /** 把草稿的完整配置写入 Store（Submit 与自动初始化共用） */
  function applyDraft() {
    sanitize();
    applying = true;
    try {
      Store().applyPlot({
        type: draft.type,
        x: draft.x.slice(),
        values: draft.values.slice(),
        sorters: draft.sorters.map(function (s) { return { col: s.col, dir: s.dir }; }),
        pageBy: draft.pageBy.slice(),
        splitBy: draft.splitBy.slice(),
        layout: Object.assign({}, draft.layout),
        merge: Object.assign({}, draft.merge),
        fit: draft.fit,
        fitOrder: draft.fitOrder,
        histBins: draft.histBins,
        display: (draft.display === 'overlay') ? 'overlay' : 'facet',
        axisSide: Object.assign({}, draft.axisSide),                 // 整体替换（键随系列变化）
        group: {
          colorBy: draft.group.colorBy || '',
          symbolBy: draft.group.symbolBy || '',
          colors: Object.assign({}, draft.group.colors || {}),    // 迭代 11：分组配色（整体替换）
          preset: draft.group.preset || '',                       // 迭代 26：色阶预设 id
          autoN: draft.group.autoN || 0                           // 迭代 26：上次自动配色时的图例数
        },
        stats: { show: !!draft.stats.show, items: (draft.stats.items || []).slice(), rotate: normStatRotate(draft.stats.rotate) },
        table: { show: !!draft.table.show, frame: !!draft.table.frame },
        style: Object.assign({}, draft.style),
        /* 任务 F：图例 / 图元（整体替换；两对象里没有任何系列颜色字段） */
        legend: Object.assign({}, draft.legend || {}),
        mark: Object.assign({}, draft.mark || {}),
        rendered: (draft.x.length > 0 && draft.values.length > 0)
      });
    } finally {
      applying = false;
    }
  }
  function submitDraft() {
    if (!Store().hasData()) { U().toast('尚未载入数据', 'warn'); return; }
    var missing = [];
    if (!draft.x.length) missing.push('X Label');
    if (!draft.values.length) missing.push('Value');
    if (missing.length) {
      /* 迭代 10：空配置 Submit **不报错**（只给一句提示），也不画空图 —— 绘图区显示空态提示 */
      U().toast('请先选择：' + missing.join(' / '), 'warn');
      if (PV() && typeof PV().render === 'function') PV().render();
      return;
    }
    applyDraft();
    renderPanel();
    if (PV() && typeof PV().render === 'function') PV().render();
    U().setStatus('绘图配置已应用：' + typeLabel(draft.type));
  }

  /**
   * 进入绘图视图时同步面板（迭代 10：**不再自动填充** X / Value）。
   *   · 配置为空 → 面板全空，绘图区显示空态提示（由 PlotView 处理，不画空图）
   *   · 已有配置（.yms 恢复 / 之前 Submit 过）→ 一字节不动，只按 Store 重建面板
   * @returns {boolean} 是否完成了面板同步（不再表示「发生了填充」）
   */
  function maybeAutoInit() {
    try {
      if (Store().state.mode !== 'plot' || !Store().hasData()) return false;
      syncFromStore();
      renderPanel();
      /* 配置为空：让绘图区显示明确空态提示（有配置时由 PlotView 自己的 mode 事件按需渲染） */
      var empty = !(draft.x && draft.x.length) || !(draft.values && draft.values.length);
      if (empty && PV() && typeof PV().render === 'function') PV().render();
      return true;
    } catch (e) {
      if (global.console && console.error) console.error('[YMS.PlotSettings] 进入绘图视图同步失败', e);
      return false;
    }
  }

  /**
   * 确保绘图配置可用（app.js 首次进入绘图视图时调用）。
   * 迭代 10 起**不再自动填充**：配置为空就保持空（面板全空 + 绘图区空态提示），
   * 已有配置（.yms 恢复 / 手工 Submit）则原样使用 —— 只把面板与 Store 同步。
   * @returns {boolean} 是否发生了填充（恒 false，保留布尔返回以兼容既有调用方/自测）
   */
  function ensureDefaults() {
    try {
      if (!Store().hasData()) return false;
      syncFromStore();
      renderPanel();
      if (Store().state.mode === 'plot' && PV() && typeof PV().render === 'function') PV().render();
      return false;
    } catch (e) {
      if (global.console && console.error) console.error('[YMS.PlotSettings] ensureDefaults 失败', e);
      return false;
    }
  }

  /* --------------------------------------------------------------- 生命周期 */
  function init() {
    if (inited) return true;
    if (!global.document || typeof global.document.querySelector !== 'function') return false;
    body = global.document.querySelector('#plot-settings-body');
    if (!body) return false;
    inited = true;

    Store().on('data', function () { syncFromStore(); renderPanel(); });
    Store().on('datasettings', function () { syncFromStore(); });
    Store().on('mode', function (mode) { if (mode === 'plot') maybeAutoInit(); });
    Store().on('plot', function () {
      if (applying) return;
      syncFromStore();
      renderPanel();
    });

    syncFromStore();
    renderPanel();
    if (Store().state.mode === 'plot') maybeAutoInit();
    return true;
  }

  /** 重建面板（对外 API） */
  function render() {
    syncFromStore();
    renderPanel();
  }

  /** 切换图型（快捷方式 / Plot 菜单）：切到绘图视图 + 立即生效 */
  function setType(type) {
    if (!type) return false;
    if (!Store().hasData()) {
      U().toast('尚未载入数据，无法绘图', 'warn');
      return false;
    }
    syncFromStore();
    draft.type = type;
    /* 迭代 10：切换图型**不再自动填充** X / Value（数据映射保持用户当前选择或全空）；
       空配置时只显示空态提示，不画空图 */
    /* 先把图型落库：否则切视图触发的自动初始化（syncFromStore）会把草稿里的 type 冲回旧值 */
    Store().applyPlot({ type: type });
    Store().setMode('plot');            // 先切视图（保证容器可见、尺寸正确）
    draft.type = type;                  // 再兜底一次，避免自动初始化同步覆盖草稿
    applyDraft();
    renderPanel();
    if (PV() && typeof PV().render === 'function') PV().render();
    return true;
  }

  YMS.PlotSettings = {
    init: init,
    render: render,
    syncFromStore: syncFromStore,
    submit: submitDraft,
    setType: setType,
    ensureDefaults: ensureDefaults,
    /* 迭代 11：分组配色（自测可复用；UI 走 #ps-group-colors 内的色块 / 预设 / 恢复默认） */
    setGroupColor: setGroupColor,
    resetGroupColors: resetGroupColors,
    groupColorRows: groupColorRows,
    /* 迭代 26：图例色阶自动配色（预设下拉 + 一键应用 + 预览；自测与文档引用同一入口） */
    applyAutoColors: applyAutoColors,
    palettePreview: palettePreview,
    manualColorKeys: manualColorKeys,
    setPalettePreset: setPalettePreset,
    TYPES: TYPES,
    MERGE_MODES: MERGE_MODES,
    /* 迭代 12：统计量旋转下拉的选项（文档 / 自测引用） */
    STAT_ROTATE_OPTIONS: STAT_ROTATE_OPTIONS
  };
})(typeof window !== 'undefined' ? window : this);
