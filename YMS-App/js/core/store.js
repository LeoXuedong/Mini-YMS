/* ==========================================================================
   YMS · core/store.js
   统一状态管理对象 Store —— 单一数据来源（Single Source of Truth）
     · 所有视图（表格 / 绘图 / 设置区 / 报告）都只从 Store 读取并渲染
     · 任何写入必须经 Store 方法 → 触发事件 → 相关视图刷新
     · .yms 模板仅序列化 Store 关键字段（columns、rows、fileName、mode、data 设置、plot 配置、activePage）
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types, U = YMS.util;

  var DEFAULT_STYLE = {
    xAxisFontSize: 11, xAxisFontWeight: 'normal', xAxisColor: '#4a5866',
    yAxisFontSize: 11, yAxisFontWeight: 'normal', yAxisColor: '#4a5866',
    titleSize: 13, legendSize: 11,
    yMin: null, yMax: null, yLog: false, yDecimals: null,
    showValueLabels: false, showGrid: false, showYAxisTitle: true, showLegend: true,
    /* 迭代 12（需求 ①）：Box 中位数连线**默认关闭**（设置区「5 · 图表元素属性 → Box 中位数连线」
       默认不勾）；显式勾选后才追加 name='中位数连线' 的 line 系列（见 chart-builder.medianPlans）。 */
    boxMedianLine: false, xTitleCentered: true, rotateMode: 'auto',
    /* 迭代 15（需求 ①）：X 轴标签旋转角度默认 **90°**（竖排）—— 旧默认 0（水平）在类别多时
       必然横向挤压，用户本轮明确要求「X 轴旋转和统计量旋转都默认 90 度」。
       取值仍为 0 | 30 | 45 | 60 | 90 | 'auto'；旧 .yms 缺该字段时由 DEFAULT_STYLE 补 90。
       渲染层（axis.js / chart-builder.js）消费该字段；设置区控件 id = #ps-x-rotate。 */
    xRotate: 90
  };

  /* ==========================================================================
     任务 F（2026-10-23）：图例样式 plot.legend + 图元样式 plot.mark
     --------------------------------------------------------------------------
     口径（用户确认）：C = 图例样式 + 各图型图元样式一次做齐；a = 颜色只作用于
     图例显示层（文字/背景/边框），**系列颜色仍走现有配色面板**，本对象里不许出现
     任何系列颜色字段（下面 mark 全是几何 / 线型 / 形状）。
     红线：所有默认值必须逐项等于改动前**写死**的值 —— 见 chart-builder 的
     LEGEND_ITEM_W / LEGEND_ITEM_H / LEGEND_ITEM_GAP / LEGEND_TEXT_COLOR / BOX_RATIO…
     默认值即「不改设置时零视觉变化」的唯一保证，改动前务必与 chart-builder 对账。
     ========================================================================== */
  var DEFAULT_LEGEND = {
    position: 'top',            // top | bottom | left | right（默认 = 现状：卡片顶部居中）
    orient: 'auto',             // auto | horizontal | vertical（auto：上下横排、左右竖排）
    textColor: '#4a5866',       // 现状写死的图例文字色
    bgColor: null,              // null = 透明（现状无底色）
    borderColor: null,          // null = 无边框（现状无边框）
    borderWidth: 0,
    padding: 0,
    itemWidth: 14,              // 现状写死
    itemHeight: 9,              // 现状写死
    itemGap: 12,                // 现状写死
    scrollMode: 'auto'          // auto = 保持现状「条目 > 6 才滚动」
  };
  var DEFAULT_MARK = {
    /* box：箱宽 = 带宽 × boxRatio，夹在 [BOX_MIN_W, BOX_MAX_W]（默认 0.72 = 现状 BOX_RATIO） */
    boxRatio: 0.72,
    boxLineWidth: 1.2,          // 现状 itemStyle.borderWidth
    /* bar / hist：柱宽占带宽比例。0.88 = 现状 barCategoryGap:'12%' 的等价比例；
       保持默认时渲染层**原样**输出 barMaxWidth:42 + barCategoryGap:'12%'（零变化） */
    barRatio: 0.88,
    barRadius: 0,
    /* line：0.5~6。默认 1.8 = 现状（chart-builder 里 line/bar 系列的 lineStyle.width）。
       ※ 任务书写「1.6」，实测现状主 line 系列是 1.8（1.6 是中位数连线的值）——
         红线是「默认 == 现状 + 零视觉变化」，故取 1.8。 */
    lineWidth: 1.8,
    lineType: 'solid',
    showSymbol: true,           // 现状：line 系列 showSymbol = 类别数 ≤ 120（true 时沿用该自适应）
    symbolSize: 5,
    symbolShape: 'circle',
    /* scatter */
    scatterSize: 6,             // 现状 symbolSize: 6
    scatterOpacity: 0.72,       // 现状 itemStyle.opacity: 0.72
    scatterShape: 'circle'
  };
  var SYMBOL_SHAPES = ['circle', 'rect', 'roundRect', 'triangle', 'diamond', 'pin', 'arrow'];

  function defaultLegend() {
    var o = {};
    Object.keys(DEFAULT_LEGEND).forEach(function (k) { o[k] = DEFAULT_LEGEND[k]; });
    return o;
  }
  function defaultMark() {
    var o = {};
    Object.keys(DEFAULT_MARK).forEach(function (k) { o[k] = DEFAULT_MARK[k]; });
    return o;
  }

  function defaultDataSettings() {
    return {
      decimals: {},                            // 列名 -> 小数位（null=自动）
      fontFamily: '',                          // 数据显示区字体（空=主题默认）
      fontSize: 12,
      sorters: [],                             // [{col, dir:'asc'|'desc'}] 行级多级排序（从上到下）
      preprocess: {
        missing: 'none',                       // 'none' | 'drop' | 'mean' | 'median' | 'zero'
        filters: []                            // [{col, op, value, value2, enabled}]
      },
      page: 1,
      pageSize: 5000
    };
  }
  /* 迭代 8（需求 2）：横轴统计行默认 = 开启 + **只显示 Mean**。
     旧版默认是 { show:false, items:[mean,median,std,rng,nupct] }；本次改为「默认勾选显示统计行、
     默认只勾 Mean」，与设置区「7 · 横轴统计行」的默认控件状态一一对应。
     迭代 12（需求 ③）：新增 rotate = **统计量旋转角**（0 | 30 | 45 | 60 | 90）。
     迭代 15（需求 ①）：默认值 0 → **90**（统计量数值默认竖排），与 style.xRotate 默认 90 保持一致；
     它与 style.xRotate（X 轴类别名旋转）**完全独立**；旧 .yms 缺该字段 → 归一到 90。 */
  function defaultStats() {
    return { show: true, items: ['mean'], rotate: 90 };
  }
  /* 迭代 12：统计量旋转角的合法取值（与 YMS.Axis.STAT_ROTATE_ALLOWED 同源语义） */
  var STAT_ROTATE_ALLOWED = [0, 30, 45, 60, 90];
  /* 迭代 15：缺省 / 非法值一律回到新默认 90（旧 .yms 无该字段也走这里） */
  var STAT_ROTATE_DEFAULT = 90;
  /** 统计量旋转角归一化：只接受 0/30/45/60/90，其它（缺省 / 非法 / 旧配置）一律 90（默认竖排） */
  function normStatRotate(v) {
    var n = Number(v);
    for (var i = 0; i < STAT_ROTATE_ALLOWED.length; i++) {
      if (n === STAT_ROTATE_ALLOWED[i]) return n;
    }
    return STAT_ROTATE_DEFAULT;
  }
  /* 迭代 7 · C / 迭代 8（需求 5）：绘图区下方的数据表格 + 横轴坐标表格方框。
     frame = 「表格方框（含左侧行名）」开关，**默认关闭**（关闭时与迭代 6/7 现状完全一致）。 */
  function defaultTable() {
    return { show: false, frame: false };
  }
  /** 旧 .yms / 旧配置兼容：stats 缺字段时归一到新默认（items 非数组才回落默认，显式空数组保留） */
  function normStats(s) {
    var d = defaultStats();
    if (!s || typeof s !== 'object') return d;
    return {
      show: (s.show === undefined || s.show === null) ? d.show : !!s.show,
      /* 用 Array.isArray（跨 realm 安全，优于 instanceof Array）判断 items 是否为数组 */
      items: Array.isArray(s.items) ? s.items.slice() : d.items.slice(),
      /* 迭代 12 / 15：统计量旋转角（缺字段 / 非法值 → 90（新默认），显式 0 保留 0） */
      rotate: normStatRotate(s.rotate)
    };
  }
  /** 旧 .yms / 旧配置兼容：table 缺字段时归一到新默认（旧文件只有 show，frame 补 false） */
  function normTable(t) {
    var d = defaultTable();
    if (!t || typeof t !== 'object') return d;
    return {
      show: (t.show === undefined || t.show === null) ? d.show : !!t.show,
      frame: (t.frame === undefined || t.frame === null) ? d.frame : !!t.frame
    };
  }

  /* ------------------------------------------------- 迭代 11：分组配色 */
  /** 合法颜色（只接受 6 位 hex；3 位缩写 / rgba / 空串一律丢弃 → 回到调色板默认） */
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;
  function isColorHex(v) { return typeof v === 'string' && HEX_RE.test(v); }
  /**
   * 分组配色键（渲染层 chart-builder 与设置区 plot-settings 同源，避免两处规则漂移）：
   *   · 有颜色分组列 → 键 = 该列的取值（同值同色，跨 Value 列 / 分面一致）
   *   · 无颜色分组列 → 键 = 系列键（Value 列名；多 Y 轴 / Split by 叠加时为 seriesKey，如 'Yield@A'）
   * @param {string} colorBy     颜色分组列名（'' = 不分组）
   * @param {string} colorLabel  该组在颜色分组列上的取值标签（无分组时传 ''）
   * @param {string} seriesKey   系列键
   * @returns {string}
   */
  function groupColorKey(colorBy, colorLabel, seriesKey) {
    if (colorBy && colorLabel !== undefined && colorLabel !== null && String(colorLabel) !== '') {
      return String(colorLabel);
    }
    return (seriesKey === undefined || seriesKey === null) ? '' : String(seriesKey);
  }
  /** group 归一：colorBy / symbolBy 补 ''，colors 缺字段 → {}，非法色值丢弃（旧 .yms 不报错）
   *  迭代 26：preset（图例色阶预设 id，未知 id → ''）、autoN（上次自动配色时的图例数）也要归一 ——
   *  S-2 的 schema 白名单对 group 走的就是这个函数，字段漏在这里就等于载入时被过滤掉。 */
  function normGroup(g) {
    if (!g || typeof g !== 'object') return { colorBy: '', symbolBy: '', colors: {}, preset: '', autoN: 0 };
    var out = {
      colorBy: (typeof g.colorBy === 'string') ? g.colorBy : '',
      symbolBy: (typeof g.symbolBy === 'string') ? g.symbolBy : '',
      colors: {},
      preset: '',
      autoN: 0
    };
    var src = (g.colors && typeof g.colors === 'object') ? g.colors : null;
    if (src) {
      Object.keys(src).forEach(function (k) {
        if (!k) return;
        if (isColorHex(src[k])) out.colors[k] = src[k];
      });
    }
    /* 预设 id：只接受 Palettes 里真实存在的 id（色板文件先于本函数调用已加载；未加载则静默为 ''） */
    if (typeof g.preset === 'string' && g.preset
        && YMS.Palettes && typeof YMS.Palettes.get === 'function' && YMS.Palettes.get(g.preset)) {
      out.preset = g.preset;
    }
    if (typeof g.autoN === 'number' && isFinite(g.autoN) && g.autoN >= 0 && g.autoN <= 200) {
      out.autoN = Math.round(g.autoN);
    }
    return out;
  }

  function defaultPlot() {
    return {
      type: 'scatter',
      x: [],                                   // X Label（可多个，键值用 '-' 连接，轴名为参数名连接）
      values: [],                              // Value（Y 轴，可多个）
      sorters: [],                             // [{col, dir}] X 类别排序依据（按类别聚合值排序，默认升序）
      pageBy: [], splitBy: [],
      display: 'facet',                        // 'facet' 分面 | 'overlay' 分组叠加同图（仅 line/scatter）
      axisSide: {},                            // { '<seriesKey>': 'left'|'right' } 多 Y 轴轴位（缺省 left）
      /* 颜色/符号分组列（'' = 不分组）+ 迭代 11 分组配色：
         colors = { '<分组键>': '#rrggbb' } —— 键规则见 YMS.groupColorKey（颜色分组列取值 / 系列键），
         缺省 {} = 全部沿用调色板（与迭代 10 之前逐像素一致）
         迭代 26：preset = 图例色阶预设 id（'' = 未选过）；autoN = 上次自动配色时的图例数 */
      group: { colorBy: '', symbolBy: '', colors: {}, preset: '', autoN: 0 },
      stats: defaultStats(),                   // X 轴统计行（默认开启、只显示 Mean）
      table: defaultTable(),                   // 绘图区数据表格 + 横轴坐标表格方框
      layout: { mode: 'best', rows: 1, cols: 1 },
      style: YMS.util.deepClone(DEFAULT_STYLE),
      /* 任务 F：图例样式 / 图元样式（两对象独立于 style，见 DEFAULT_LEGEND / DEFAULT_MARK 注释） */
      legend: defaultLegend(),
      mark: defaultMark(),
      merge: { mode: 'auto', limit: null },    // auto: Box≤40 / Bar·Line≤60 / Scatter 不限
      fit: 'none', fitOrder: 2,
      histBins: null,                          // null = 自动（Sturges）
      activePage: 0,
      rendered: false                          // 是否已 Submit 渲染过（避免空图）
    };
  }

  /* ==========================================================================
     S-2：.yms 设置 schema（白名单 + 逐字段类型校验）
     --------------------------------------------------------------------------
     背景（评审 S-2）：deserialize 原先只用 Object.assign 把模板里的 dataSettings /
     plot 并进默认值 —— 不认识的键会长期驻留 state 并随下次保存继续扩散；而
     plot.x 若是对象 / 数字，后续 aggregate 的 x.length / x.map 会直接抛错。

     做法（单一入口 = applyRules）：
       1) 字段规则表 DATA_RULES / PLOT_RULES / STYLE_RULES 逐字段声明类型与取值域；
       2) 只有「规则表里声明过 + 校验通过」的值才写进新 state —— 未知键一律丢弃，
          非法值回落默认值，两类都计入报告 {ignored, fixed}；
       3) YmsTemplate.load 把报告转成可见 note / toast（含「无法识别…已忽略」）。
     红线：任何输入都不许抛异常；字段缺省 = 取默认值（不计入报告）。
     ========================================================================== */
  var MAX_STR_LEN = 500;                      /* 单个字符串字段上限（列名 / 字体名远小于此） */
  var MAX_NOTE_ITEMS = 200;                   /* 处理说明条数上限 */
  var MAX_NOTE_LEN = 500;                     /* 单条处理说明长度上限 */
  var MAX_FILTERS = 100;                      /* 条件筛选条数上限 */
  /* 条件筛选运算符：主定义在 js/table/data-settings.js 的 OPS（运行期取用），这里只是兜底同源副本 */
  var FILTER_OPS_FALLBACK = ['=', '≠', '>', '≥', '<', '≤', '区间', '包含', '不包含', '缺失', '非缺失'];

  function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }
  function isPlainObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  /** 原型污染三件套：来自模板的键名一律不得写进 state */
  function isDangerKey(k) { return k === '__proto__' || k === 'constructor' || k === 'prototype'; }
  /** 默认值深拷贝（对象 / 数组一律新副本，绝不与默认结构共享引用） */
  function cloneDefault(v) {
    if (v === null || typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }
  function filterOps() {
    return (YMS.DataSettings && YMS.DataSettings.OPS && YMS.DataSettings.OPS.length)
      ? YMS.DataSettings.OPS : FILTER_OPS_FALLBACK;
  }

  /**
   * 单字段归一化（S-2 唯一执行器的单元）
   * @param {object} rule  规则 {k,t,lo,hi,list,max,nullable,col,sub,defs,fn}
   * @param {*} v          模板里的原始值
   * @param {object|null} df 当前激活表（col:true 的规则据此判列名是否存在）
   * @param {object} rep   报告累加器 {ignored:[], fixed:[]}
   * @param {string} path  报告里的字段路径（如 'plot.style.xRotate'）
   * @returns {{ok:boolean, v:*}}
   */
  function normRule(rule, v, df, rep, path) {
    var t = rule.t, out, i, bad, dropped;
    if (v === null) return { ok: !!rule.nullable, v: null };
    if (v === undefined) return { ok: false, v: undefined };

    if (t === 'str') {
      if (typeof v !== 'string' || v.length > MAX_STR_LEN) return { ok: false };
      return { ok: true, v: v };
    }
    if (t === 'bool') {
      return (typeof v === 'boolean') ? { ok: true, v: v } : { ok: false };
    }
    if (t === 'num') {
      if (!isFiniteNumber(v)) return { ok: false };
      if (rule.lo !== undefined && v < rule.lo) return { ok: false };
      if (rule.hi !== undefined && v > rule.hi) return { ok: false };
      return { ok: true, v: v };
    }
    if (t === 'int') {
      if (!isFiniteNumber(v) || v !== Math.round(v)) return { ok: false };
      if (rule.lo !== undefined && v < rule.lo) return { ok: false };
      if (rule.hi !== undefined && v > rule.hi) return { ok: false };
      return { ok: true, v: v };
    }
    if (t === 'enum') {
      for (i = 0; i < rule.list.length; i++) if (v === rule.list[i]) return { ok: true, v: v };
      return { ok: false };
    }
    if (t === 'hex') {
      return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? { ok: true, v: v } : { ok: false };
    }
    if (t === 'strList') {
      /* 单个列名（如 x:"Lot"）视为单元素数组 —— 评审验收把这种写法当合法值 */
      var list = (typeof v === 'string' && v) ? [v] : v;
      if (!Array.isArray(list) || list.length > (rule.max || 60)) return { ok: false };
      out = []; dropped = [];
      for (i = 0; i < list.length; i++) {
        if (typeof list[i] !== 'string' || !list[i] || list[i].length > MAX_STR_LEN) return { ok: false };
        if (rule.col && df && df.colIndex(list[i]) < 0) { dropped.push(list[i]); continue; }
        if (out.indexOf(list[i]) < 0) out.push(list[i]);
      }
      if (dropped.length) {
        rep.fixed.push(path + '（列不在当前表中：' + dropped.slice(0, 3).join('、') +
          (dropped.length > 3 ? ' 等' : '') + '）');
      }
      return { ok: true, v: out };
    }
    if (t === 'sorterList') {
      if (!Array.isArray(v) || v.length > 20) return { ok: false };
      out = []; dropped = [];
      for (i = 0; i < v.length; i++) {
        if (!isPlainObj(v[i])) return { ok: false };
        var cn = v[i].col;
        if (typeof cn !== 'string' || !cn || cn.length > MAX_STR_LEN) return { ok: false };
        var dir = (v[i].dir === 'desc') ? 'desc' : 'asc';   /* dir 非法 → 升序（旧文件兼容，不报错） */
        if (rule.col && df && df.colIndex(cn) < 0) { dropped.push(cn); continue; }
        out.push({ col: cn, dir: dir });
      }
      if (dropped.length) {
        rep.fixed.push(path + '（列不在当前表中：' + dropped.slice(0, 3).join('、') +
          (dropped.length > 3 ? ' 等' : '') + '）');
      }
      return { ok: true, v: out };
    }
    if (t === 'filterList') {
      if (!Array.isArray(v) || v.length > MAX_FILTERS) return { ok: false };
      var ops = filterOps();
      out = [];
      for (i = 0; i < v.length; i++) {
        var f = v[i];
        if (!isPlainObj(f) || typeof f.col !== 'string' || f.col.length > MAX_STR_LEN) return { ok: false };
        var keep = function (x) {
          return (typeof x === 'string' || typeof x === 'boolean' || isFiniteNumber(x)) ? x : '';
        };
        out.push({
          col: f.col,
          op: (typeof f.op === 'string' && ops.indexOf(f.op) >= 0) ? f.op : '=',
          value: keep(f.value),
          value2: keep(f.value2),
          enabled: (f.enabled === undefined || f.enabled === null) ? true : !!f.enabled
        });
      }
      return { ok: true, v: out };
    }
    if (t === 'mapEnum') {
      if (!isPlainObj(v)) return { ok: false };
      var keys = Object.keys(v);
      if (keys.length > (rule.max || 500)) return { ok: false };
      out = {}; bad = [];
      keys.forEach(function (k) {
        if (isDangerKey(k)) { rep.ignored.push(path + '.' + k); return; }
        if (rule.list.indexOf(v[k]) >= 0) out[k] = v[k];
        else bad.push(k);
      });
      if (bad.length) {
        rep.fixed.push(path + '（取值不合法：' + bad.slice(0, 3).join('、') +
          (bad.length > 3 ? ' 等' : '') + '）');
      }
      return { ok: true, v: out };
    }
    if (t === 'decMap') {
      if (!isPlainObj(v)) return { ok: false };
      out = {};
      Object.keys(v).forEach(function (k) {
        if (isDangerKey(k)) { rep.ignored.push(path + '.' + k); return; }
        if (df && df.colIndex(k) < 0) { rep.fixed.push(path + '.' + k + '（列不在当前表中）'); return; }
        var d = v[k];
        if (d === null) { out[k] = null; return; }
        if (isFiniteNumber(d) && d === Math.round(d) && d >= 0 && d <= 8) { out[k] = d; return; }
        rep.fixed.push(path + '.' + k + '（应为 0~8 的整数或 null）');
      });
      return { ok: true, v: out };
    }
    if (t === 'strMap') {
      /* 字符串→字符串映射（分组映射的 value→组名）：键值都可含中文，危险键丢弃 */
      if (!isPlainObj(v)) return { ok: false };
      var mkeys = Object.keys(v);
      if (mkeys.length > (rule.max || 2000)) return { ok: false };
      out = {}; bad = 0;
      for (i = 0; i < mkeys.length; i++) {
        var mk = mkeys[i], mv = v[mk];
        if (isDangerKey(mk) || !mk || mk.length > MAX_STR_LEN) { bad++; continue; }
        if (typeof mv !== 'string' || !mv || mv.length > MAX_STR_LEN) { bad++; continue; }
        out[mk] = mv;
      }
      if (bad) rep.fixed.push(path + '（' + bad + ' 条映射不合法，已丢弃）');
      return { ok: true, v: out };
    }
    if (t === 'obj') {
      if (!isPlainObj(v)) return { ok: false };
      return { ok: true, v: applyRules(v, rule.sub, rule.defs, rep, df, path + '.') };
    }
    if (t === 'norm') {
      if (!isPlainObj(v)) return { ok: false };
      return { ok: true, v: rule.fn(v) };
    }
    return { ok: true, v: v };
  }

  /**
   * 按规则表归一化一个设置对象（S-2 唯一入口）
   * @param {*} raw        模板里的原始值（任意类型）
   * @param {Array} rules  字段规则表
   * @param {object} defs  默认值对象（defaultPlot() / defaultDataSettings() …）
   * @param {object} rep   报告累加器 {ignored:[], fixed:[]}
   * @param {object|null} df 当前激活表（用于列名校验）
   * @param {string} prefix 报告里的键名前缀（'plot.' / 'dataSettings.' …）
   * @returns {object} 归一化结果（只含规则表里的键）
   */
  function applyRules(raw, rules, defs, rep, df, prefix) {
    var out = {}, byKey = {}, i, r, res;
    for (i = 0; i < rules.length; i++) {
      r = rules[i];
      byKey[r.k] = r;
      out[r.k] = cloneDefault(defs ? defs[r.k] : undefined);
    }
    if (!isPlainObj(raw)) {
      if (raw !== undefined && raw !== null) {
        rep.fixed.push((prefix ? prefix.replace(/\.$/, '') : '设置') + '（整体不是对象，已全部回落默认）');
      }
      return out;
    }
    Object.keys(raw).forEach(function (k) {
      if (isDangerKey(k) || !byKey[k]) rep.ignored.push(prefix + k);
    });
    for (i = 0; i < rules.length; i++) {
      r = rules[i];
      if (!Object.prototype.hasOwnProperty.call(raw, r.k)) continue;
      res = normRule(r, raw[r.k], df, rep, prefix + r.k);
      if (res.ok) out[r.k] = res.v;
      else rep.fixed.push(prefix + r.k);
    }
    return out;
  }

  /* style（图表元素属性）的逐字段约束：类型默认按 DEFAULT_STYLE 的值类型推导，
     只有需要「枚举 / 区间 / 可空 / hex」的字段在此显式声明。
     以后往 DEFAULT_STYLE 加新令牌，白名单自动跟上（不会静默漏掉）。 */
  var STYLE_OVERRIDES = {
    xAxisFontSize: { t: 'int', lo: 6, hi: 48 },
    yAxisFontSize: { t: 'int', lo: 6, hi: 48 },
    titleSize: { t: 'int', lo: 6, hi: 48 },
    legendSize: { t: 'int', lo: 6, hi: 48 },
    xAxisColor: { t: 'hex' },
    yAxisColor: { t: 'hex' },
    xAxisFontWeight: { t: 'enum', list: ['normal', 'bold'] },
    yAxisFontWeight: { t: 'enum', list: ['normal', 'bold'] },
    yMin: { t: 'num', nullable: true },
    yMax: { t: 'num', nullable: true },
    yDecimals: { t: 'int', lo: 0, hi: 8, nullable: true },
    /* 旋转角与设置区下拉同源：0 | 30 | 45 | 60 | 90 | 'auto'（0 是合法值，别用 ||） */
    xRotate: { t: 'enum', list: [0, 30, 45, 60, 90, 'auto'] },
    rotateMode: { t: 'enum', list: ['auto', '0', '30', '45', '60', '90'] }
  };
  var _styleRules = null;
  function styleRules() {
    if (_styleRules) return _styleRules;
    var rules = [];
    Object.keys(DEFAULT_STYLE).forEach(function (k) {
      var ov = STYLE_OVERRIDES[k] || {};
      var dv = DEFAULT_STYLE[k], t = ov.t;
      if (!t) {
        if (typeof dv === 'boolean') t = 'bool';
        else if (typeof dv === 'number') t = 'num';
        else if (dv === null) t = 'num';
        else t = 'str';
      }
      rules.push({ k: k, t: t, lo: ov.lo, hi: ov.hi, list: ov.list, nullable: ov.nullable });
    });
    _styleRules = rules;
    return rules;
  }

  var DATA_RULES = [
    { k: 'decimals', t: 'decMap' },
    { k: 'fontFamily', t: 'str' },
    { k: 'fontSize', t: 'int', lo: 6, hi: 48 },
    { k: 'sorters', t: 'sorterList', col: true },
    {
      k: 'preprocess', t: 'obj', defs: { missing: 'none', filters: [] },
      sub: [
        { k: 'missing', t: 'enum', list: ['none', 'drop', 'mean', 'median', 'zero'] },
        { k: 'filters', t: 'filterList' }
      ]
    },
    { k: 'page', t: 'int', lo: 1, hi: 1000000 },
    { k: 'pageSize', t: 'int', lo: 10, hi: 50000 }
  ];

  /* --------------------------------------------------------------------------
     列元数据白名单（按值分组 · Group Mapping）
     --------------------------------------------------------------------------
     分组派生列把自己的「配方」挂在列上（Column.order / Column.groupMap），随
     columns[] 一起进出 .yms。这里是与 DATA_RULES / PLOT_RULES 同级的**列级**
     白名单 + 类型规则表：未知字段丢弃、类型非法回落默认，非法项计入报告。
        order     = 类目顺序（组名按用户排列；未分配值在末位）
        groupMap  = { sourceCol, targetCol, groups[], map{}, unassigned, otherLabel }
     ========================================================================== */
  var COL_META_RULES = [
    { k: 'order', t: 'strList', max: 500 },
    {
      k: 'groupMap', t: 'obj',
      defs: {
        sourceCol: '', targetCol: '', groups: [], map: {},
        unassigned: 'other', otherLabel: '未分组'
      },
      sub: [
        { k: 'sourceCol', t: 'str' },
        { k: 'targetCol', t: 'str' },
        { k: 'groups', t: 'strList', max: 200 },
        { k: 'map', t: 'strMap', max: 2000 },
        { k: 'unassigned', t: 'enum', list: ['other', 'raw'] },
        { k: 'otherLabel', t: 'str' }
      ]
    }
  ];
  var COL_META_DEFAULTS = { order: null, groupMap: null };

  /**
   * 给一列挂上（校验过的）分组元数据 —— .yms 载入 / 克隆表的唯一入口
   * @param {Column} col 目标列
   * @param {object} raw .yms 里的列定义 {name, type, order?, groupMap?}
   * @param {object} rep 报告累加器
   * @param {string} path 报告前缀
   */
  function applyColMeta(col, raw, rep, path) {
    if (!col || !isPlainObj(raw)) return;
    if (raw.order === undefined && raw.groupMap === undefined) return;
    var meta = applyRules({ order: raw.order, groupMap: raw.groupMap },
      COL_META_RULES, COL_META_DEFAULTS, rep, null, (path || 'columns') + '.');
    if (Array.isArray(meta.order) && meta.order.length) col.order = meta.order.slice();
    var gm = meta.groupMap;
    if (isPlainObj(gm) && gm.sourceCol && gm.groups && gm.groups.length) col.groupMap = gm;
  }

  var _plotRules = null;
  /** plot 规则表（延迟构建：拟合方式列表来自 js/plot/fitting.js，脚本顺序在 store.js 之后） */
  /* 任务 F：plot.legend / plot.mark 的**类型规则表**（= .yms 白名单，applyRules 唯一入口）。
     与 DEFAULT_LEGEND / DEFAULT_MARK 逐字段一一对应；少一条 → 保存后再载入会被静默丢弃
     （历史坑，见 s2-yms-schema.js 与本轮 legend-mark-style.js 的往返断言）。 */
  var LEGEND_RULES = [
    { k: 'position', t: 'enum', list: ['top', 'bottom', 'left', 'right'] },
    { k: 'orient', t: 'enum', list: ['auto', 'horizontal', 'vertical'] },
    { k: 'textColor', t: 'hex' },
    { k: 'bgColor', t: 'hex', nullable: true },
    { k: 'borderColor', t: 'hex', nullable: true },
    { k: 'borderWidth', t: 'int', lo: 0, hi: 4 },
    { k: 'padding', t: 'int', lo: 0, hi: 24 },
    { k: 'itemWidth', t: 'int', lo: 6, hi: 40 },
    { k: 'itemHeight', t: 'int', lo: 4, hi: 24 },
    { k: 'itemGap', t: 'int', lo: 0, hi: 40 },
    { k: 'scrollMode', t: 'enum', list: ['auto', 'on', 'off'] }
  ];
  var MARK_RULES = [
    { k: 'boxRatio', t: 'num', lo: 0.10, hi: 1.00 },
    { k: 'boxLineWidth', t: 'num', lo: 0.5, hi: 4 },
    { k: 'barRatio', t: 'num', lo: 0.10, hi: 1.00 },
    { k: 'barRadius', t: 'int', lo: 0, hi: 12 },
    { k: 'lineWidth', t: 'num', lo: 0.5, hi: 6 },
    { k: 'lineType', t: 'enum', list: ['solid', 'dashed', 'dotted'] },
    { k: 'showSymbol', t: 'bool' },
    { k: 'symbolSize', t: 'int', lo: 2, hi: 20 },
    { k: 'symbolShape', t: 'enum', list: SYMBOL_SHAPES },
    { k: 'scatterSize', t: 'int', lo: 2, hi: 24 },
    { k: 'scatterOpacity', t: 'num', lo: 0.10, hi: 1.00 },
    { k: 'scatterShape', t: 'enum', list: SYMBOL_SHAPES }
  ];

  function plotRules() {
    if (_plotRules) return _plotRules;
    var fits = ['none', 'linear', 'quadratic', 'cubic', 'poly', 'exp', 'log', 'power'];
    if (YMS.Fitting && YMS.Fitting.METHODS && YMS.Fitting.METHODS.length) {
      fits = YMS.Fitting.METHODS.map(function (m) { return m.value; });
    }
    _plotRules = [
      { k: 'type', t: 'enum', list: ['line', 'box', 'bar', 'hist', 'scatter'] },
      { k: 'x', t: 'strList', max: 60, col: true },
      { k: 'values', t: 'strList', max: 60, col: true },
      { k: 'sorters', t: 'sorterList', col: true },
      { k: 'pageBy', t: 'strList', max: 20, col: true },
      { k: 'splitBy', t: 'strList', max: 20, col: true },
      { k: 'display', t: 'enum', list: ['facet', 'overlay'] },
      /* axisSide 的键是 seriesKey（如 'Yield@A'），不是纯列名 → 只校验取值，不校验存在性 */
      { k: 'axisSide', t: 'mapEnum', list: ['left', 'right'], max: 200 },
      { k: 'group', t: 'norm', fn: normGroup },
      { k: 'stats', t: 'norm', fn: normStats },
      { k: 'table', t: 'norm', fn: normTable },
      {
        k: 'layout', t: 'obj', defs: { mode: 'best', rows: 1, cols: 1 },
        sub: [
          { k: 'mode', t: 'enum', list: ['best', 'rc'] },
          { k: 'rows', t: 'int', lo: 1, hi: 12 },
          { k: 'cols', t: 'int', lo: 1, hi: 12 }
        ]
      },
      { k: 'style', t: 'obj', defs: DEFAULT_STYLE, sub: styleRules() },
      /* 任务 F：图例 / 图元（白名单 + 逐字段类型校验；缺一条就会被静默丢弃） */
      { k: 'legend', t: 'obj', defs: DEFAULT_LEGEND, sub: LEGEND_RULES },
      { k: 'mark', t: 'obj', defs: DEFAULT_MARK, sub: MARK_RULES },
      {
        k: 'merge', t: 'obj', defs: { mode: 'auto', limit: null },
        sub: [
          { k: 'mode', t: 'enum', list: ['auto', 'manual', 'none'] },
          { k: 'limit', t: 'num', lo: 1, hi: 1000, nullable: true }
        ]
      },
      { k: 'fit', t: 'enum', list: fits },
      { k: 'fitOrder', t: 'int', lo: 2, hi: 8 },
      { k: 'histBins', t: 'num', lo: 1, hi: 1000, nullable: true },
      { k: 'activePage', t: 'int', lo: 0, hi: 1000 },
      { k: 'rendered', t: 'bool' }
    ];
    return _plotRules;
  }

  /**
   * 处理说明（notes）归一化：必须是字符串数组，逐条限长、限条数
   * @param {*} raw @param {object} rep
   * @returns {string[]}
   */
  function normNotes(raw, rep) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) { rep.fixed.push('notes（应为字符串数组）'); return []; }
    var out = [], i;
    for (i = 0; i < raw.length && out.length < MAX_NOTE_ITEMS; i++) {
      if (typeof raw[i] !== 'string') { rep.fixed.push('notes[' + i + ']（不是字符串）'); continue; }
      var s = raw[i];
      if (s.length > MAX_NOTE_LEN) {
        s = s.slice(0, MAX_NOTE_LEN) + '…';
        rep.fixed.push('notes[' + i + ']（过长已截断）');
      }
      out.push(s);
    }
    if (raw.length > MAX_NOTE_ITEMS) {
      rep.fixed.push('notes（超过 ' + MAX_NOTE_ITEMS + ' 条，已截断）');
    }
    return out;
  }

  /** 键名清单：最多列 5 个，余下用「等」 */
  function nameList(list) {
    var shown = list.slice(0, 5);
    return shown.join('、') + (list.length > 5 ? ' 等' : '');
  }

  /**
   * 报告 → 人话（每条一句，含「无法识别」「已忽略」关键词与键名）
   * @param {object} rep {ignored:[], fixed:[]}
   * @returns {string[]}
   */
  function reportText(rep) {
    var out = [];
    if (!rep) return out;
    if (rep.ignored && rep.ignored.length) {
      out.push('模板含 ' + rep.ignored.length + ' 个无法识别的设置项，已忽略：' + nameList(rep.ignored));
    }
    if (rep.fixed && rep.fixed.length) {
      out.push('模板有 ' + rep.fixed.length + ' 个设置项类型或取值不合法，已回落默认：' + nameList(rep.fixed));
    }
    return out;
  }

  /* ==========================================================================
     迭代 14：多表模型（state.tables + state.activeTableId）
     --------------------------------------------------------------------------
     不变式（回归红线）：state.df **恒等于**当前激活表的 df。
       · 旧代码（绘图 / 报告 / 数据设置 / 导出 / 列操作）继续只读 state.df，一行不改；
       · 任何改变激活表或表 df 的操作都必须同步镜像字段（df / tableName / fileName / fileSize / importedAt）。
     表对象：{ id, name, df, fileName, fileSize, importedAt, note, derived, origin }
       origin（迭代 20）：{ kind, params, parentId } —— 派生表的来源操作 + 参数快照 + 父表 id；
       用于列表树形缩进与右键「修改转换设置…」回填；非派生表 / 旧数据为 null。
     ========================================================================== */
  var _tableSeq = 0;
  /** 生成表 id（会话内唯一；序列化后按原 id 恢复） */
  function nextTableId() { _tableSeq++; return 'tb' + _tableSeq + '-' + Date.now().toString(36); }

  /** 表名基名：meta.name 优先，其次文件名去扩展名，最后「数据表」 */
  function baseTableName(meta) {
    var n = meta && meta.name ? String(meta.name) : '';
    if (!n && meta && meta.fileName) n = String(meta.fileName).replace(/\.[^.]+$/, '');
    n = n ? n.trim() : '';
    return n || '数据表';
  }

  /**
   * 表名去重：与已有表重名时追加 ' (2)'、' (3)' …（exceptId 指定「不算冲突」的表，用于重命名自身）
   * @param {string} name @param {Array} tables @param {string|null} exceptId
   * @returns {string}
   */
  function uniqueTableName(name, tables, exceptId) {
    var base = String(name === undefined || name === null ? '' : name).trim();
    if (!base) base = '数据表';
    var used = {}, i;
    for (i = 0; i < (tables || []).length; i++) {
      if (exceptId && tables[i].id === exceptId) continue;
      used[tables[i].name] = 1;
    }
    if (!used[base]) return base;
    var n = 2;
    while (used[base + ' (' + n + ')']) n++;
    return base + ' (' + n + ')';
  }

  /**
   * 迭代 20：派生来源（origin）归一化
   *   { kind:'unpivot', params:{…可回填的参数快照…}, parentId:'tb1-xxx' }
   *   · 只存参数快照，不存 df（df 由 parentId 指向的父表提供）
   *   · 非法 / 缺 kind → null（右键不显示「修改转换设置…」）
   */
  function normOrigin(o) {
    if (!o || typeof o !== 'object') return null;
    var kind = String(o.kind || '');
    if (!kind) return null;
    var params = (o.params && typeof o.params === 'object') ? deepClonePlain(o.params) : {};
    return { kind: kind, params: params, parentId: String(o.parentId || '') };
  }
  /** 参数快照深拷贝（只含 JSON 可表达的值；异常 → {}） */
  function deepClonePlain(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return {}; }
  }

  /** 构造表对象（不改 Store 状态） */
  function makeTable(df, meta, name) {
    meta = meta || {};
    return {
      id: nextTableId(),
      name: name,
      df: df || null,
      fileName: meta.fileName || '',
      fileSize: meta.fileSize || 0,
      importedAt: meta.importedAt || new Date().toISOString(),
      note: meta.note || '',
      derived: !!meta.derived,
      /* 迭代 20：派生表记录来源（kind / params / parentId），供树形缩进与「修改转换设置…」回填 */
      origin: normOrigin(meta.origin)
    };
  }

  /** df 的列定义（序列化用；不含 dataSettings 的小数位覆盖） */
  function dfColumns(df) {
    if (!df) return [];
    return df.cols.map(function (c) {
      var spec = { name: c.name, type: c.type, timeStyle: c.timeStyle, dict: c.type === T.STRING ? c.dict : undefined };
      if (c.order && c.order.length) spec.order = c.order.slice();      /* 分组派生列：类目顺序 */
      if (c.groupMap) spec.groupMap = YMS.util.deepClone(c.groupMap);    /* 分组派生列：映射配方 */
      return spec;
    });
  }
  /** df 的行数据（序列化用；单元格取 JS 值，字符列取字典文本） */
  function dfRows(df) {
    var rows = [], r, ci;
    if (!df) return rows;
    for (r = 0; r < df.rowCount; r++) {
      var row = new Array(df.cols.length);
      for (ci = 0; ci < df.cols.length; ci++) row[ci] = df.cell(ci, r);
      rows.push(row);
    }
    return rows;
  }
  /** 列定义 + 行数据 → DataFrame（schema 非法时返回 null，不抛异常）
   *  M-4：列名在此唯一化（CSV / Excel / .yms 共用同一条去重规则），
   *       改名明细挂在返回的 df.dupHeader 上（null = 无重复列名） */
  function dfFromSpec(columns, rows, rep) {
    if (!columns || !columns.length) return null;
    var raw = columns.map(function (c) { return c && c.name !== undefined ? String(c.name) : ''; });
    var uniq = YMS.colNames.unique(raw);
    var defs = columns.map(function (c, i) {
      return { name: uniq.names[i], type: c.type, timeStyle: c.timeStyle };
    });
    var df;
    try { df = YMS.DataFrame.fromRows(defs, rows || []); }
    catch (e) { return null; }
    if (df) df.dupHeader = uniq.count ? uniq : null;
    /* 分组派生列的 order / groupMap 走 COL_META_RULES 白名单校验后挂回列上
       （未登记的字段 / 非法类型在此丢弃，不会污染 state） */
    if (df) {
      var rep2 = rep || { ignored: [], fixed: [] };
      for (var k = 0; k < df.cols.length && k < columns.length; k++) {
        applyColMeta(df.cols[k], columns[k], rep2, 'columns[' + k + ']');
      }
    }
    return df;
  }
  /** 深拷贝 df（复制表用；不共享对象，避免后续列操作互相影响） */
  function cloneDf(df) {
    if (!df) return null;
    return dfFromSpec(dfColumns(df), dfRows(df)) || df;
  }

  var Store = {
    state: {
      df: null,
      fileName: '',
      tableName: '',
      fileSize: 0,
      importedAt: '',
      /* 迭代 14：多表集合与当前激活表 id（'' = 无表） */
      tables: [],
      activeTableId: '',
      mode: 'data',
      dataSettings: defaultDataSettings(),
      plot: defaultPlot(),
      ui: { theme: 'light', panOnly: false, lastRenderMs: null, processingNotes: [] }
    },

    /* ------------------------------------------------------------- 事件 */
    on: function (topic, fn) { return YMS.bus.on(topic, fn); },
    off: function (topic, fn) { YMS.bus.off(topic, fn); },
    emit: function (topic, payload) { YMS.bus.emit(topic, payload); },

    /* ------------------------------------------------------------- 数据 */
    /**
     * 写入当前数据（兼容旧调用：无表时建表，有表时覆盖当前表）
     * 迭代 14：state.df 恒为激活表 df —— 这里同步维护 state.tables 与镜像字段。
     */
    setData: function (df, meta) {
      meta = meta || {};
      var s = this.state;
      var at = this.activeTable();
      if (!at) {
        /* 无表：建一张表（命名与去重规则同 addTable） */
        var nm0 = uniqueTableName(baseTableName(meta), s.tables, null);
        at = makeTable(df, {
          fileName: meta.fileName, fileSize: meta.fileSize,
          importedAt: new Date().toISOString(), derived: meta.derived
        }, nm0);
        s.tables.push(at);
      } else {
        /* 有表：覆盖当前表（保留 id；名称只在调用方显式给出时更新） */
        at.df = df;
        at.fileName = meta.fileName !== undefined ? meta.fileName : at.fileName;
        at.fileSize = meta.fileSize || 0;
        at.importedAt = new Date().toISOString();
        if (meta.tableName) at.name = uniqueTableName(meta.tableName, s.tables, at.id);
      }
      s.activeTableId = at.id;
      s.df = at.df;
      s.tableName = at.name;
      s.fileName = at.fileName;
      s.fileSize = at.fileSize;
      s.importedAt = at.importedAt;
      s.dataSettings = defaultDataSettings();
      s.plot.activePage = 0;
      s.plot.rendered = false;
      s.ui.processingNotes = meta.notes || [];
      if (meta.keepSettings) {
        // 模板恢复场景：由调用方随后写入设置
      }
      this.invalidate('data');
      this.emit('tables');
    },
    hasData: function () { return !!this.state.df && this.state.df.rowCount > 0; },
    clearData: function () {
      var s = this.state;
      s.df = null; s.fileName = ''; s.tableName = '';
      s.tables = []; s.activeTableId = '';
      s.fileSize = 0; s.importedAt = '';
      s.dataSettings = defaultDataSettings();
      s.plot = defaultPlot();
      this.invalidate('data');
      this.emit('tables');
    },
    /** 列结构性变更（改名/删列/去重/新增列/格式转换）后调用 */
    replaceDataFrame: function (df) {
      if (df) {
        df.refreshMissing();
        this.state.df = df;
        var at = this.activeTable();          // 同步激活表，保持「state.df === 激活表 df」不变式
        if (at) at.df = df;
      }
      this.invalidate('data');
    },

    /* ------------------------------------------------- 迭代 14：多表管理 */
    /** 全部表（浅拷贝数组；表对象本身仍是 Store 内的引用） */
    tables: function () { return this.state.tables.slice(); },
    /** 当前激活表对象（无表 → null） */
    activeTable: function () {
      var id = this.state.activeTableId, list = this.state.tables, i;
      if (!id) return null;
      for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    },
    /** 当前激活表在列表中的下标（无 → -1） */
    activeTableIndex: function () {
      var id = this.state.activeTableId, list = this.state.tables, i;
      for (i = 0; i < list.length; i++) if (list[i].id === id) return i;
      return -1;
    },
    /** 按 id 找表（内部） */
    _findTable: function (id) {
      var list = this.state.tables, i;
      for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    },
    /**
     * 把某张表设为激活：同步镜像字段（不变式），并重置分页 / 视图缓存
     * 注意：不重置 dataSettings 与绘图配置（切表只换数据，设置保持用户当前选择；
     *       指向不存在列的筛选 / 排序 / 系列会在渲染层被按列名过滤掉）
     */
    setActiveTable: function (id) {
      var t = this._findTable(id);
      if (!t) return false;
      var s = this.state;
      s.activeTableId = t.id;
      s.df = t.df;
      s.tableName = t.name;
      s.fileName = t.fileName || '';
      s.fileSize = t.fileSize || 0;
      s.importedAt = t.importedAt || '';
      s.plot.activePage = 0;
      this._view = null;
      this.notifyDataValuesChanged();          // 重算缺失 + invalidate('data') → 表格区 / 绘图区重渲染
      this.emit('tables');
      return true;
    },
    /**
     * 追加一张表并自动激活
     * 注意：直接持有传入的 df（不复制）；需要独立的副本请用 duplicateTable
     * @param {DataFrame} df
     * @param {{name?:string, fileName?:string, fileSize?:number, importedAt?:string, note?:string, derived?:boolean}} [meta]
     * @returns {{id:string, name:string}}
     */
    addTable: function (df, meta) {
      meta = meta || {};
      var s = this.state;
      var nm = uniqueTableName(baseTableName(meta), s.tables, null);
      var t = makeTable(df, meta, nm);
      s.tables.push(t);
      s.activeTableId = t.id;
      s.df = t.df;
      s.tableName = t.name;
      s.fileName = t.fileName || '';
      s.fileSize = t.fileSize || 0;
      s.importedAt = t.importedAt || '';
      s.plot.activePage = 0;
      /* 导入型新表（非派生）沿用「导入即重置数据设置」的既有语义；派生表沿用当前设置 */
      if (!meta.derived) s.dataSettings = defaultDataSettings();
      this._view = null;
      this.invalidate('data');
      this.emit('tables');
      return { id: t.id, name: t.name };
    },
    /**
     * 迭代 20：原地覆盖某张表的数据（id 不变、表数不变）
     * 用于「修改转换设置…」—— 用新参数重算后直接覆盖刚生成的那张派生表。
     * 不变式：若被覆盖的是当前表，state.df 必须同步为新 df（保持 state.df === 激活表 df），
     *         并用 invalidate('data') 触发数据显示区 / 绘图区立即刷新。
     * @param {string} id 表 id（保持不变）
     * @param {DataFrame} df 新数据
     * @param {{name?:string, note?:string, origin?:object}} [meta]
     * @returns {{id:string, name:string, rows:number, cols:number}|null}
     */
    replaceTable: function (id, df, meta) {
      meta = meta || {};
      var t = this._findTable(id);
      if (!t || !df) return null;
      var s = this.state;
      if (df.refreshMissing) df.refreshMissing();
      t.df = df;
      if (meta.name !== undefined && String(meta.name).trim() !== '') {
        t.name = uniqueTableName(meta.name, s.tables, id);       // 自身不算冲突
      }
      if (meta.note !== undefined) t.note = meta.note;
      if (meta.origin !== undefined) t.origin = normOrigin(meta.origin);
      if (s.activeTableId === id) {
        s.df = t.df;                       // ← 不变式：state.df 恒等于激活表 df
        s.tableName = t.name;
        s.plot.activePage = 0;
        this._view = null;
        this.notifyDataValuesChanged();    // refreshMissing + invalidate('data') → 表格/数据网格/绘图重渲染
      } else {
        this.invalidate('tables');
      }
      this.emit('tables');
      return {
        id: t.id, name: t.name,
        rows: t.df && t.df.rowCount ? t.df.rowCount : 0,
        cols: t.df && t.df.cols ? t.df.cols.length : 0
      };
    },
    /** 重命名（重名自动加 ' (2)'；返回最终名称，找不到表返回 null） */
    renameTable: function (id, name) {
      var t = this._findTable(id);
      if (!t) return null;
      var nm = uniqueTableName(name, this.state.tables, id);
      t.name = nm;
      if (this.state.activeTableId === id) this.state.tableName = nm;
      this.invalidate('tables');
      return nm;
    },
    /** 复制表（名称加 _copy，重名再加 ' (2)'；副本自动激活） */
    duplicateTable: function (id) {
      var t = this._findTable(id);
      if (!t) return null;
      var nm = uniqueTableName(t.name + '_copy', this.state.tables, null);
      var copy = makeTable(cloneDf(t.df), {
        fileName: t.fileName, fileSize: t.fileSize,
        importedAt: new Date().toISOString(), note: t.note, derived: t.derived,
        origin: t.origin                            /* 迭代 20：副本同样可从来源回填设置 */
      }, nm);
      this.state.tables.push(copy);
      return this.setActiveTable(copy.id) ? { id: copy.id, name: copy.name } : null;
    },
    /** 删除表（删的是激活表 → 激活相邻表，优先后一张；全删光 → 等价 clearData） */
    removeTable: function (id) {
      var list = this.state.tables, idx = -1, i;
      for (i = 0; i < list.length; i++) if (list[i].id === id) { idx = i; break; }
      if (idx < 0) return false;
      var wasActive = this.state.activeTableId === id;
      list.splice(idx, 1);
      if (!list.length) {
        var s = this.state;
        s.activeTableId = '';
        s.df = null; s.tableName = ''; s.fileName = ''; s.fileSize = 0; s.importedAt = '';
        s.dataSettings = defaultDataSettings();
        s.plot = defaultPlot();
        this._view = null;
        this.invalidate('data');
        this.emit('tables');
        return true;
      }
      if (wasActive) {
        var nb = list[Math.min(idx, list.length - 1)];   // 优先后一张，越界取前一张
        this.state.activeTableId = '';
        this.setActiveTable(nb.id);
      } else {
        this.invalidate('tables');
      }
      this.emit('tables');
      return true;
    },
    notifyDataValuesChanged: function () {
      var df = this.state.df;
      if (df) df.refreshMissing();
      this.invalidate('data');
    },
    colNames: function () { return this.state.df ? this.state.df.colNames() : []; },
    colType: function (name) { var c = this.state.df && this.state.df.col(name); return c ? c.type : null; },
    colTypeAt: function (ci) { var df = this.state.df; return df && df.cols[ci] ? df.cols[ci].type : null; },
    addNote: function (text) { this.state.ui.processingNotes.push(text); },

    /* ---- S-2：.yms schema 归一化报告（deserialize 每次覆盖；null = 尚未载入模板） ---- */
    lastSanitize: null,
    /** 报告 → 人话数组（YmsTemplate.load 用它出 note / toast；空数组 = 模板完全合法） */
    sanitizeMessages: function () { return reportText(this.lastSanitize); },
    /** schema 规则表（自测用：验证白名单确实覆盖默认结构的每个键，防以后加字段漏登记） */
    schema: {
      plotRules: plotRules,
      dataRules: function () { return DATA_RULES; },
      styleRules: styleRules,
      reportText: reportText
    },

    /* ------------------------------------------------------------- 设置 */
    applyDataSettings: function (patch) {
      var ds = this.state.dataSettings;
      Object.keys(patch || {}).forEach(function (k) {
        if (k === 'preprocess') Object.assign(ds.preprocess, patch.preprocess);
        else ds[k] = patch[k];
      });
      this.invalidate('datasettings');
      return ds;
    },
    applyPlot: function (patch) {
      var p = this.state.plot;
      Object.keys(patch || {}).forEach(function (k) {
        if (k === 'style') Object.assign(p.style, patch.style);
        else if (k === 'layout') Object.assign(p.layout, patch.layout);
        else if (k === 'merge') Object.assign(p.merge, patch.merge);
        else if (k === 'group' || k === 'stats' || k === 'table') {
          if (!p[k]) p[k] = {};
          Object.assign(p[k], patch[k]);
        }
        else if (k === 'axisSide') p.axisSide = Object.assign({}, patch.axisSide);   // 整体替换（键随系列变化）
        else p[k] = patch[k];
      });
      this.invalidate('plot');
      return p;
    },
    setMode: function (mode) {
      if (this.state.mode === mode) return;
      this.state.mode = mode;
      this.emit('mode', mode);
    },

    /* ------------------------------------------------- 视图管线（缓存） */
    _view: null,
    invalidate: function (topic) {
      this._view = null;
      this.emit('change', { topic: topic || 'all' });
      this.emit(topic || 'all');
    },

    /**
     * 视图：预处理（筛选 → 缺失处理 → 多级排序）后的行序列
     * @returns {View}
     */
    getView: function () {
      if (this._view) return this._view;
      var df = this.state.df;
      if (!df) { this._view = null; return null; }
      var ds = this.state.dataSettings;
      var rowIdx = null, i;

      /* 1) 条件筛选（未填值的条件视为「未填写」，不参与过滤 —— 见 isFilterActive） */
      var filters = (ds.preprocess.filters || []).filter(isFilterActive);
      if (filters.length) {
        var keep = [];
        for (i = 0; i < df.rowCount; i++) if (matchesFilters(df, i, filters)) keep.push(i);
        rowIdx = Int32Array.from(keep);
      }

      /* 2) 缺失值处理 */
      var mode = ds.preprocess.missing || 'none';
      var fills = {};
      if (mode === 'drop') {
        var src = rowIdx || null, out = [];
        for (i = 0; i < (src ? src.length : df.rowCount); i++) {
          var r = src ? src[i] : i;
          if (!rowHasMissing(df, r)) out.push(r);
        }
        rowIdx = Int32Array.from(out);
      } else if (mode === 'mean' || mode === 'median' || mode === 'zero') {
        for (i = 0; i < df.cols.length; i++) {
          var c = df.cols[i];
          if (!c.missing) continue;
          if (c.type === T.STRING) continue;   // 字符列无数学含义：请在右键菜单用"填充缺失值-固定值"
          var st = df.stats(i), v = 0;
          if (mode === 'mean') v = st.mean;
          else if (mode === 'median') v = st.median;
          if (YMS.num.isMissing(v)) v = 0;      /* 均值/中位数缺失或非有限 → 0 */
          fills[c.name] = v;
        }
      }

      /* 3) 多级行排序 */
      var sorters = (ds.sorters || []).filter(function (s) { return s && s.col && df.colIndex(s.col) >= 0; });
      if (sorters.length) {
        var idx = rowIdx || fullIndex(df.rowCount);
        if (!rowIdx) idx = fullIndex(df.rowCount);
        sortIndexArray(df, idx, sorters);
        rowIdx = idx;
      }

      this._view = new View(df, rowIdx, fills, ds);
      return this._view;
    },

    /** 序列化（.yms 用） */
    serialize: function () {
      var df = this.state.df, s = this.state;
      var cols = [], rows = [];
      if (df) {
        cols = df.cols.map(function (c) {
          var spec = {
            name: c.name, type: c.type, timeStyle: c.timeStyle,
            decimals: (s.dataSettings.decimals[c.name] !== undefined ? s.dataSettings.decimals[c.name] : null),
            dict: c.type === T.STRING ? c.dict : undefined
          };
          if (c.order && c.order.length) spec.order = c.order.slice();
          if (c.groupMap) spec.groupMap = YMS.util.deepClone(c.groupMap);
          return spec;
        });
        for (var r = 0; r < df.rowCount; r++) {
          var row = new Array(df.cols.length);
          for (var ci = 0; ci < df.cols.length; ci++) row[ci] = df.cell(ci, r);
          rows.push(row);
        }
      }
      /* 迭代 14：多表（每表自带列定义 + 行数据；activeTableId 记录当前表）
         旧读端仍读顶层 columns / rows（= 激活表），因此旧版 YMS 打开新文件也能看到数据 */
      var tables = s.tables.map(function (t) {
        return {
          id: t.id, name: t.name, derived: !!t.derived,
          fileName: t.fileName || '', fileSize: t.fileSize || 0,
          importedAt: t.importedAt || '', note: t.note || '',
          origin: t.origin || null,                 /* 迭代 20：派生来源随模板保存 */
          columns: dfColumns(t.df), rows: dfRows(t.df)
        };
      });
      return {
        format: 'YMS-TEMPLATE', version: YMS.version, appName: 'YMS 良率管理系统',
        createdAt: new Date().toISOString(),
        fileName: s.fileName, tableName: s.tableName,
        mode: s.mode,
        columns: cols, rows: rows,
        tables: tables, activeTableId: s.activeTableId,
        dataSettings: s.dataSettings,
        plot: s.plot,
        notes: s.ui.processingNotes,
        stats: df ? df.cols.map(function (c, i) { return df.stats(i); }) : []
      };
    },

    /** 反序列化恢复（迭代 14：有 tables 则恢复多表；无 tables 的旧文件包装成单表） */
    deserialize: function (obj) {
      if (!obj || obj.format !== 'YMS-TEMPLATE') throw new Error('不是有效的 .yms 模板文件');
      var list = [], i;
      /* 报告累加器要早于建表：列级元数据（order / groupMap）在 dfFromSpec 里校验 */
      var rep = { ignored: [], fixed: [] };
      /* 1) 多表：tables 数组（迭代 14 及以后保存的文件） */
      var srcTables = (obj.tables && obj.tables.length) ? obj.tables : null;
      if (srcTables) {
        for (i = 0; i < srcTables.length; i++) {
          var tb = srcTables[i] || {};
          var tdf = dfFromSpec(tb.columns, tb.rows, rep);
          if (!tdf) continue;                       // 无列定义的表条目跳过（不报错）
          list.push({
            id: tb.id || nextTableId(),
            name: uniqueTableName(tb.name || ('表 ' + (list.length + 1)), list, null),
            df: tdf,
            fileName: tb.fileName || '',
            fileSize: tb.fileSize || 0,
            importedAt: tb.importedAt || obj.createdAt || '',
            note: tb.note || '',
            derived: !!tb.derived,
            origin: normOrigin(tb.origin)          /* 迭代 20：恢复派生来源（旧文件无此字段 → null） */
          });
        }
      }
      /* 2) 旧文件（无 tables 字段）：把单表 df 包装成一张表 */
      if (!list.length) {
        var df0 = dfFromSpec(obj.columns, obj.rows, rep);
        if (!df0) throw new Error('模板缺少列定义（columns 为空）');
        list.push({
          id: nextTableId(),
          name: uniqueTableName(obj.tableName ||
            (obj.fileName ? String(obj.fileName).replace(/\.[^.]+$/, '') : '数据表'), list, null),
          df: df0, fileName: obj.fileName || '', fileSize: 0,
          importedAt: obj.createdAt || new Date().toISOString(),
          note: '', derived: false
        });
      }
      this.state.tables = list;
      /* 3) 激活表：优先 activeTableId，缺失 / 非法 → 第一张 */
      var act = null;
      for (i = 0; i < list.length; i++) if (list[i].id === obj.activeTableId) { act = list[i]; break; }
      if (!act) act = list[0];
      this.state.activeTableId = act.id;
      this.state.df = act.df;
      this.state.tableName = act.name;
      this.state.fileName = act.fileName || obj.fileName || '';
      this.state.fileSize = act.fileSize || 0;
      this.state.importedAt = act.importedAt || new Date().toISOString();
      var df = act.df;
      /* S-2：设置区 / 绘图配置走 schema 白名单 + 逐字段校验（applyRules 是唯一入口）
         —— 未知键丢弃、类型或取值非法回落默认，报告存 lastSanitize 交给
         YmsTemplate.load 变成可见提示；这里绝不抛异常。
         （rep 在建表前已声明：列级元数据 order / groupMap 也往同一个报告里写） */
      this.state.dataSettings = applyRules(obj.dataSettings, DATA_RULES, defaultDataSettings(), rep, df, 'dataSettings.');
      this.state.plot = applyRules(obj.plot, plotRules(), defaultPlot(), rep, df, 'plot.');
      this.state.ui.processingNotes = normNotes(obj.notes, rep);
      this.lastSanitize = rep;
      this.state.mode = obj.mode === 'plot' ? 'plot' : 'data';
      this.invalidate('data');
      this.emit('tables');
      this.emit('mode', this.state.mode);
      return df;
    },
    isFilterActive: isFilterActive,
    DEFAULT_STYLE: DEFAULT_STYLE
  };

  /* ==========================================================================
     View：视图对象（行序列 + 缺失填充 + 格式设置），不复制数据
     ========================================================================== */
  function View(df, rowIdx, fills, ds) {
    this.df = df;
    this.rowIdx = rowIdx;             // Int32Array | null(=恒等/自然序)
    this.count = rowIdx ? rowIdx.length : df.rowCount;
    this.fills = fills || {};         // 列名 -> 数值（均值/中位数/0）
    this.decimals = (ds && ds.decimals) || {};
    this.fontFamily = (ds && ds.fontFamily) || '';
    this.fontSize = (ds && ds.fontSize) || 12;
    this._fillIdx = {};
    var self = this;
    Object.keys(this.fills).forEach(function (n) { self._fillIdx[n] = df.colIndex(n); });
  }

  /** 视图位置 pos → 原始行号 */
  View.prototype.rowAt = function (pos) { return this.rowIdx ? this.rowIdx[pos] : pos; };
  /** 视图位置 pos、列 ci → JS 值（应用缺失填充） */
  View.prototype.valueAt = function (pos, ci) {
    var df = this.df, r = this.rowAt(pos), c = df.cols[ci];
    if (!c) return null;
    var raw = c.values[r];
    if (c.type === T.STRING) return raw < 0 ? null : c.dict[raw];
    if (YMS.num.isMissing(raw)) {
      var fill = this.fills[c.name];
      if (fill === undefined) return null;
      return fill;
    }
    return raw;
  };
  View.prototype.typeAt = function (ci) { return this.df.cols[ci].type; };
  View.prototype.rawAt = function (pos, ci) { return this.df.values === undefined ? this.df.cols[ci].values[this.rowAt(pos)] : null; };
  /** 视图内某列缺失计数（用于显示） */
  View.prototype.missingCount = function (ci) { return this.missingCounts()[ci]; };
  View.prototype.missingCounts = function () {
    if (this._miss) return this._miss;
    var df = this.df, out = new Int32Array(df.cols.length), i, pos;
    for (i = 0; i < df.cols.length; i++) {
      var c = df.cols[i], m = 0, filled = this.fills[c.name] !== undefined;
      if (c.missing === 0) { out[i] = 0; continue; }
      if (filled) { out[i] = 0; continue; }
      for (pos = 0; pos < this.count; pos++) {
        var raw = c.values[this.rowAt(pos)];
        if (c.type === T.STRING ? raw < 0 : YMS.num.isMissing(raw)) m++;
      }
      out[i] = m;
    }
    this._miss = out;
    return out;
  };
  /** 显示值（已按列小数位/时间样式格式化） */
  View.prototype.displayAt = function (pos, ci) {
    var c = this.df.cols[ci];
    var v = this.valueAt(pos, ci);
    if (v === null) return '';
    return T.formatValue(v, c.type, this.decimals[c.name], c.timeStyle);
  };
  /**
   * 表格显示文本（M-1 原值/计算值分离）：
   * 原文被改写过的单元格（'95%' → 0.95、'1,234' → 1234）返回用户原始文本，
   * 其余与 displayAt 完全一致。计算 / 统计 / 绘图 / 导出仍走 displayAt / valueAt 的数值。
   */
  View.prototype.textAt = function (pos, ci) {
    var c = this.df.cols[ci];
    var r = this.rowAt(pos);
    if (c && c.rawText) {
      var t = c.rawText[r];
      if (t !== undefined && t !== null) return String(t);
    }
    return this.displayAt(pos, ci);
  };
  /** 供绘图/统计的数值序列（time 列取 epoch ms；字符列返回 null） */
  View.prototype.numericAt = function (pos, ci) {
    var v = this.valueAt(pos, ci);
    if (v === null) return NaN;
    if (typeof v === 'number') return v;
    return NaN;
  };

  /* ==========================================================================
     内部工具：筛选 / 缺失判断 / 排序
     ========================================================================== */
  /**
   * 条件是否生效：没有填值的条件不参与过滤（否则 parseNumber('')=NaN、
   * 任何比较对 NaN 恒假，用户点一次「+」表格就整表消失）。
   * 「缺失 / 非缺失」类操作符本就不需要填值，仍然生效。
   */
  function isFilterActive(f) {
    if (!f || !f.col || f.enabled === false) return false;
    var op = f.op || '=';
    if (op === '缺失' || op === 'isMissing' || op === '非缺失' || op === 'notMissing') return true;
    var v1 = (f.value === undefined || f.value === null) ? '' : String(f.value);
    if (v1.trim() === '') return false;
    if (op === '区间') {
      var v2 = (f.value2 === undefined || f.value2 === null) ? '' : String(f.value2);
      if (v2.trim() === '') return false;
    }
    return true;
  }

  function matchesFilters(df, r, filters) {
    for (var i = 0; i < filters.length; i++) {
      var f = filters[i], ci = df.colIndex(f.col);
      if (ci < 0) continue;
      if (!isFilterActive(f)) continue;                 /* 防御：未填值的条件一律跳过 */
      if (!matchOne(df, r, ci, f)) return false;
    }
    return true;
  }
  function matchOne(df, r, ci, f) {
    var c = df.cols[ci], raw = c.values[r];
    var isMissing = (c.type === T.STRING) ? raw < 0 : YMS.num.isMissing(raw);
    var op = f.op || '=';
    if (op === '缺失' || op === 'isMissing') return isMissing;
    if (op === '非缺失' || op === 'notMissing') return !isMissing;
    if (isMissing) return false;
    if (c.type === T.STRING) {
      var sv = c.dict[raw], fv = String(f.value === undefined ? '' : f.value);
      if (op === '=' || op === '==') return sv === fv;
      if (op === '≠' || op === '!=') return sv !== fv;
      if (op === '包含' || op === 'contains') return sv.indexOf(fv) >= 0;
      if (op === '不包含') return sv.indexOf(fv) < 0;
      return true;
    }
    var v = raw, a = T.parseNumber(f.value), b = T.parseNumber(f.value2);
    switch (op) {
      case '=': case '==': return v === a;
      case '≠': case '!=': return v !== a;
      case '>': return v > a;
      case '≥': case '>=': return v >= a;
      case '<': return v < a;
      case '≤': case '<=': return v <= a;
      case '区间': return v >= Math.min(a, b) && v <= Math.max(a, b);
      default: return true;
    }
  }
  function rowHasMissing(df, r) {
    for (var i = 0; i < df.cols.length; i++) {
      var c = df.cols[i], raw = c.values[r];
      if (c.type === T.STRING ? raw < 0 : YMS.num.isMissing(raw)) return true;
    }
    return false;
  }
  function fullIndex(n) {
    var a = new Int32Array(n);
    for (var i = 0; i < n; i++) a[i] = i;
    return a;
  }

  /** 多级排序（缺失值恒排在最后；相同键按原始行号保持稳定） */
  function sortIndexArray(df, idx, sorters) {
    var keys = sorters.map(function (s) {
      var ci = df.colIndex(s.col);
      return { ci: ci, dir: s.dir === 'desc' ? -1 : 1, isStr: df.cols[ci].type === T.STRING, dict: df.cols[ci].dict, arr: df.cols[ci].values };
    });
    function cmp(i, j) {
      for (var k = 0; k < keys.length; k++) {
        var K = keys[k], a = K.arr[i], b = K.arr[j];
        var am = K.isStr ? (a < 0) : YMS.num.isMissing(a), bm = K.isStr ? (b < 0) : YMS.num.isMissing(b);
        if (am || bm) {
          if (am && bm) continue;
          return am ? 1 : -1;                     // 缺失恒在最后
        }
        var res = 0;
        if (K.isStr) {
          var sa = K.dict[a], sb = K.dict[b];
          res = sa < sb ? -1 : (sa > sb ? 1 : 0);
        } else {
          res = a < b ? -1 : (a > b ? 1 : 0);
        }
        if (res !== 0) return res * K.dir;
      }
      return i - j;
    }
    quickSortTyped(idx, cmp);
    return idx;
  }

  /** 迭代式快排（typed array 原地排序，避免装箱开销） */
  function quickSortTyped(arr, cmp) {
    var stack = [[0, arr.length - 1]];
    while (stack.length) {
      var seg = stack.pop(), lo = seg[0], hi = seg[1];
      while (lo < hi) {
        if (hi - lo < 12) {
          // 小段插入排序
          for (var i = lo + 1; i <= hi; i++) {
            var v = arr[i], j = i - 1;
            while (j >= lo && cmp(arr[j], v) > 0) { arr[j + 1] = arr[j]; j--; }
            arr[j + 1] = v;
          }
          break;
        }
        var mid = (lo + hi) >> 1;
        // 三数取中
        if (cmp(arr[mid], arr[lo]) < 0) { var t = arr[mid]; arr[mid] = arr[lo]; arr[lo] = t; }
        if (cmp(arr[hi], arr[lo]) < 0) { var t2 = arr[hi]; arr[hi] = arr[lo]; arr[lo] = t2; }
        if (cmp(arr[hi], arr[mid]) < 0) { var t3 = arr[hi]; arr[hi] = arr[mid]; arr[mid] = t3; }
        var pivot = arr[mid], i2 = lo, j2 = hi;
        while (i2 <= j2) {
          while (cmp(arr[i2], pivot) < 0) i2++;
          while (cmp(arr[j2], pivot) > 0) j2--;
          if (i2 <= j2) { var tmp = arr[i2]; arr[i2] = arr[j2]; arr[j2] = tmp; i2++; j2--; }
        }
        if (j2 - lo < hi - i2) { stack.push([i2, hi]); hi = j2; }
        else { stack.push([lo, j2]); lo = i2; }
      }
    }
  }

  YMS.View = View;
  YMS.Store = Store;
  YMS.defaultDataSettings = defaultDataSettings;
  YMS.defaultPlot = defaultPlot;
  /* 任务 F：图例 / 图元默认值与规则表（渲染层、设置区、自测共用同一口径） */
  YMS.DEFAULT_LEGEND = DEFAULT_LEGEND;
  YMS.DEFAULT_MARK = DEFAULT_MARK;
  YMS.defaultLegend = defaultLegend;
  YMS.defaultMark = defaultMark;
  YMS.legendRules = function () { return LEGEND_RULES; };
  YMS.markRules = function () { return MARK_RULES; };
  YMS.SYMBOL_SHAPES = SYMBOL_SHAPES;
  /* 迭代 8：默认值 / 旧配置归一（设置区与自测复用） */
  YMS.defaultStats = defaultStats;
  YMS.defaultTable = defaultTable;
  YMS.normStats = normStats;
  YMS.normTable = normTable;
  /* 迭代 12：统计量旋转角（合法值 0/30/45/60/90；设置区、渲染层、自测共用同一归一规则） */
  YMS.STAT_ROTATE_ALLOWED = STAT_ROTATE_ALLOWED;
  YMS.normStatRotate = normStatRotate;
  /* 迭代 11：分组配色 —— 键规则 + group 归一（渲染层 / 设置区 / 自测共用） */
  YMS.groupColorKey = groupColorKey;
  YMS.normGroup = normGroup;
  YMS.isColorHex = isColorHex;
})(typeof window !== 'undefined' ? window : this);
