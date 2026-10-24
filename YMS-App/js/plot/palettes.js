/* ==========================================================================
   YMS · js/plot/palettes.js —— 迭代 26：图例色阶自动配色（离散定性色板）
   --------------------------------------------------------------------------
   用户需求原文：
     「现在的逻辑是可以手动对每个图例修改色阶，保留这种方法，额外再增加一个
       自动为不同图例添加色阶的功能，你可以准备好很多分不同色阶的预设，
       如果图例有 10 个颜色，可以一键为所有的图例修改色阶。」
     追加口径：「色阶预设主要考虑对比度明显的色阶，尽量不要选连续过度的色阶。」

   为什么只有「离散定性」色板，没有 viridis / plasma / Jet / rainbow / turbo：
     · 图例是**离散类目**（Tool A / Tool B …），相邻两项若只差一点「绿→黄」过渡，
       读者分不清谁是谁；连续渐变色阶的相邻采样在 ΔE2000 上本来就 < 5。
     · Jet 中段会出现两个几乎相同的青/蓝，10 个类目时必然相邻难辨。
     · 定性色板的设计目标恰恰是「两两可辨」，与图例的语义一致。

   本文件是**纯数据 + 纯函数**（不碰 DOM / Store / ECharts），便于单元测试：
     YMS.Palettes.PRESETS                     预设表（10 套）
     YMS.Palettes.get(id)                     取预设（未知 id → null）
     YMS.Palettes.capacity(id)               该预设的「无需循环」类目上限
     YMS.Palettes.pickColors(id, n)          → ['#RRGGBB', ...]（长度恒为 n）
     YMS.Palettes.suggest(n)                 → 超容量时推荐的预设 id（'' = 无需换）
     YMS.Palettes.deltaE2000(hexA, hexB)      CIEDE2000 色差（sRGB → Lab D65）
     YMS.Palettes.minDeltaE(colors)          → { de, a, b, i, j }（两两最小色差）
   取色规则（超出容量时）：**循环 + 明度分层** —— 第 r 轮（r = 1,2,3…）把基色
   往白（奇数轮，×(1-L)·15%·k）或往黑（偶数轮，L×(1−15%·k)）推，k = ⌈r/2⌉。
   禁止的做法是「只做色相循环」：那会让第 11 色与第 1 色完全同色（相邻近似色）。
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};

  /* ------------------------------------------------------------ 预设表 */
  /* 全部颜色为 6 位 hex（#RRGGBB）—— Store.normGroup 只接受 6 位 hex，
     3 位缩写 / rgb() / 颜色名会在归一化时被丢弃（图例又回到默认调色板）。 */
  var PRESETS = [
    {
      id: 'tableau10', name: 'Tableau 10', source: 'Tableau', def: true,
      desc: '业界默认，对比强（本功能的默认预设）',
      colors: ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
               '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC']
    },
    {
      id: 'category10', name: 'D3 Category 10', source: 'D3',
      desc: '与 Tableau 10 近似但取色不同（d3.scaleOrdinal 默认）',
      colors: ['#1F77B4', '#FF7F0E', '#2CA02C', '#D62728', '#9467BD',
               '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF']
    },
    {
      id: 'set1', name: 'Set 1', source: 'ColorBrewer',
      desc: '最鲜艳，对比最强（含纯黄，浅底上略淡）',
      colors: ['#E41A1C', '#377EB8', '#4DAF4A', '#984EA3', '#FF7F00',
               '#FFFF33', '#A65628', '#F781BF', '#999999']
    },
    {
      id: 'dark2', name: 'Dark 2', source: 'ColorBrewer',
      desc: '深色系，投影 / 打印友好',
      colors: ['#1B9E77', '#D95F02', '#7570B3', '#E7298A', '#66A61E',
               '#E6AB02', '#A6761D', '#666666']
    },
    {
      id: 'paired', name: 'Paired', source: 'ColorBrewer',
      desc: '成对高对比：深/浅交替，适合对照实验（A/B 两两成对）',
      colors: ['#A6CEE3', '#1F78B4', '#B2DF8A', '#33A02C', '#FB9A99', '#E31A1C',
               '#FDBF6F', '#FF7F00', '#CAB2D6', '#6A3D9A', '#FFFF99', '#B15928']
    },
    {
      id: 'tol-bright', name: 'Tol Bright', source: 'Paul Tol',
      desc: '色盲友好（红绿色盲下仍可分辨）',
      colors: ['#4477AA', '#EE6677', '#228833', '#CCBB44', '#66CCEE', '#AA3377', '#BBBBBB']
    },
    {
      id: 'tol-muted', name: 'Tol Muted', source: 'Paul Tol',
      desc: '柔和但可辨，色盲友好（比 Bright 低饱和）',
      colors: ['#332288', '#88CCEE', '#44AA99', '#117733', '#999933',
               '#DDCC77', '#CC6677', '#882255', '#AA4499']
    },
    {
      id: 'kelly22', name: 'Kelly 22', source: 'Kelly',
      desc: '最大化两两可区分，类目多时首选（原表 22 色；黑/白排在末两位）',
      colors: ['#F3C300', '#875692', '#F38400', '#A1CAF1', '#BE0032', '#C2B280', '#848482',
               '#008856', '#E68FAC', '#0067A5', '#F99379', '#604E97', '#F6A600', '#B3446C',
               '#DCD300', '#882D17', '#8DB600', '#654522', '#E25822', '#2B3D26',
               '#222222', '#F2F3F4']
    },
    {
      id: 'glasbey', name: 'Glasbey', source: 'Glasbey',
      desc: '专为大量类目设计，逐色最大化两两色差',
      /* colorcet.glasbey（= glasbey_bw_minc_20）前 30 色，逐字节取自
         https://github.com/holoviz/colorcet 的 colorcet/__init__.py */
      colors: ['#d70000', '#8c3cff', '#028800', '#00acc7', '#98ff00', '#ff7fd1', '#6c004f',
               '#ffa530', '#583b00', '#005759', '#0000dd', '#00fdcf', '#a1756a', '#bcb7ff',
               '#95b578', '#c004b9', '#645474', '#790000', '#0774d8', '#fef590', '#004b00',
               '#8f7a00', '#ff7266', '#eeb9b9', '#5e7e66', '#9be4ff', '#ec0077', '#a67bb9',
               '#5a00a4', '#04c600']
    },
    {
      id: 'grayscale', name: '离散灰阶', source: '自定义',
      desc: '打印 / 黑白场景：只靠明度阶梯区分（CIELAB L* 5→90 十级等间距）',
      colors: ['#111111', '#252525', '#393939', '#4e4e4e', '#656565',
               '#7d7d7d', '#959595', '#aeaeae', '#c8c8c8', '#e2e2e2']
    }
  ];

  var DEFAULT_ID = 'tableau10';
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;

  function isHex(v) { return typeof v === 'string' && HEX_RE.test(v); }

  function get(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }
  function capacity(id) {
    var p = get(id);
    return p ? p.colors.length : 0;
  }
  function ids() {
    return PRESETS.map(function (p) { return p.id; });
  }
  /** 预设下拉选项（设置区与自测共用，名称 = UI 文案） */
  function options() {
    return PRESETS.map(function (p) {
      return { value: p.id, label: p.name, max: p.colors.length, desc: p.desc, source: p.source };
    });
  }

  /* --------------------------------------------------- 明度分层（超出容量时） */
  function hexToRgb(hex) {
    return {
      r: parseInt(hex.substr(1, 2), 16),
      g: parseInt(hex.substr(3, 2), 16),
      b: parseInt(hex.substr(5, 2), 16)
    };
  }
  function rgbToHex(r, g, b) {
    function h(v) {
      var n = Math.round(v);
      n = n < 0 ? 0 : (n > 255 ? 255 : n);
      var s = n.toString(16);
      return s.length < 2 ? '0' + s : s;
    }
    return '#' + h(r) + h(g) + h(b);
  }
  /**
   * 明度分层：t > 0 → 往白推（t 比例），t < 0 → 往黑压（|t| 比例）
   * 用「朝端点插值」而不是直接加减 8 位值：亮色不会被截到 #ffffff（那会与白色图例撞色）
   */
  function shiftLight(hex, t) {
    var c = hexToRgb(hex);
    var k = Math.abs(t);
    var rr, gg, bb;
    if (t > 0) {
      rr = c.r + (255 - c.r) * k;
      gg = c.g + (255 - c.g) * k;
      bb = c.b + (255 - c.b) * k;
    } else {
      rr = c.r * (1 - k);
      gg = c.g * (1 - k);
      bb = c.b * (1 - k);
    }
    return rgbToHex(rr, gg, bb);
  }
  /** 第 r 轮（r ≥ 1）的偏移比例：r1 = +15%，r2 = −15%，r3 = +30%，r4 = −30% … */
  function roundShift(r) {
    var k = Math.ceil(r / 2) * 0.15;
    if (k > 0.75) k = 0.75;                       // 上限：再压就全黑了
    return (r % 2 === 1) ? k : -k;
  }

  /**
   * 取色：pickColors(presetId, n) -> ['#RRGGBB', ...]（长度恒为 n，两两不同）
   * · n ≤ 容量 → 直接取前 n 个（顺序稳定、可复现）
   * · n > 容量 → 循环 + 明度分层（第 2 轮 +15%，第 3 轮 −15%，第 4 轮 +30%…）
   * @param {string} presetId @param {number} n
   * @returns {string[]}
   */
  function pickColors(presetId, n) {
    var p = get(presetId) || get(DEFAULT_ID);
    var total = Math.floor(n);
    if (!isFinite(total) || total <= 0) return [];
    var base = p.colors;
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < total; i++) {
      var b = base[i % base.length];
      var round = Math.floor(i / base.length);
      var hex = (round === 0) ? b : shiftLight(b, roundShift(round));
      /* 同一 hex 重复出现（极端 n / 极端色）→ 继续往同方向微推，最多 12 次 */
      var guard = 0;
      while (seen[hex.toLowerCase()] && guard < 12) {
        guard++;
        hex = shiftLight(b, roundShift(round) + (roundShift(round) >= 0 ? 1 : -1) * 0.03 * guard);
      }
      seen[hex.toLowerCase()] = 1;
      out.push(hex);
    }
    return out;
  }

  /** 超容量时的推荐预设：N ≤ 10 → tableau10；N ≤ 22 → kelly22；否则 glasbey */
  function suggest(n) {
    var total = Math.floor(n) || 0;
    if (total <= 0) return '';
    if (total <= capacity(DEFAULT_ID)) return '';
    if (total <= 22 && capacity('kelly22') >= total) return 'kelly22';
    if (capacity('glasbey') >= total) return 'glasbey';
    return 'glasbey';                             // 超过 30 类目：glasbey 循环 + 明度分层
  }

  /* ------------------------------------------------- sRGB → Lab（D65）→ CIEDE2000 */
  function srgbToLab(hex) {
    var c = hexToRgb(hex);
    function lin(v) {
      var x = v / 255;
      return (x <= 0.04045) ? (x / 12.92) : Math.pow((x + 0.055) / 1.055, 2.4);
    }
    var r = lin(c.r), g = lin(c.g), b = lin(c.b);
    var X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    var Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    var Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    var Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
    function f(t) { return (t > 0.008856) ? Math.pow(t, 1 / 3) : (7.787 * t + 16 / 116); }
    var fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  function pow7(x) { return Math.pow(x, 7); }

  /**
   * CIEDE2000 色差（kL = kC = kH = 1）
   * 实现按 Sharma / Wu / Dalal (2005) 的公式逐项书写，中性色（C=0）的色相分支已处理。
   * @param {string} hexA @param {string} hexB @returns {number}
   */
  function deltaE2000(hexA, hexB) {
    if (!isHex(hexA) || !isHex(hexB)) return NaN;
    var p1 = srgbToLab(hexA), p2 = srgbToLab(hexB);
    var L1 = p1.L, a1 = p1.a, b1 = p1.b;
    var L2 = p2.L, a2 = p2.a, b2 = p2.b;
    var C1 = Math.sqrt(a1 * a1 + b1 * b1);
    var C2 = Math.sqrt(a2 * a2 + b2 * b2);
    var Cbar = (C1 + C2) / 2;
    var G = 0.5 * (1 - Math.sqrt(pow7(Cbar) / (pow7(Cbar) + pow7(25))));
    var ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
    var Cp1 = Math.sqrt(ap1 * ap1 + b1 * b1);
    var Cp2 = Math.sqrt(ap2 * ap2 + b2 * b2);
    function hue(a, b, C) {
      if (C === 0) return 0;
      var h = Math.atan2(b, a) * R2D;
      return (h < 0) ? h + 360 : h;
    }
    var h1 = hue(ap1, b1, Cp1), h2 = hue(ap2, b2, Cp2);
    var dL = L2 - L1;
    var dC = Cp2 - Cp1;
    var dhp;
    if (Cp1 * Cp2 === 0) dhp = 0;
    else if (Math.abs(h2 - h1) <= 180) dhp = h2 - h1;
    else if (h2 - h1 > 180) dhp = h2 - h1 - 360;
    else dhp = h2 - h1 + 360;
    var dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dhp / 2 * D2R);
    var Lbar = (L1 + L2) / 2;
    var Cpbar = (Cp1 + Cp2) / 2;
    var hbar;
    if (Cp1 * Cp2 === 0) hbar = h1 + h2;
    else if (Math.abs(h1 - h2) <= 180) hbar = (h1 + h2) / 2;
    else if (h1 + h2 < 360) hbar = (h1 + h2 + 360) / 2;
    else hbar = (h1 + h2 - 360) / 2;
    var T = 1
      - 0.17 * Math.cos((hbar - 30) * D2R)
      + 0.24 * Math.cos((2 * hbar) * D2R)
      + 0.32 * Math.cos((3 * hbar + 6) * D2R)
      - 0.20 * Math.cos((4 * hbar - 63) * D2R);
    var dTheta = 30 * Math.exp(-Math.pow((hbar - 275) / 25, 2));
    var RC = 2 * Math.sqrt(pow7(Cpbar) / (pow7(Cpbar) + pow7(25)));
    var SL = 1 + (0.015 * Math.pow(Lbar - 50, 2)) / Math.sqrt(20 + Math.pow(Lbar - 50, 2));
    var SC = 1 + 0.045 * Cpbar;
    var SH = 1 + 0.015 * Cpbar * T;
    var RT = -Math.sin(2 * dTheta * D2R) * RC;
    var t1 = dL / SL, t2 = dC / SC, t3 = dH / SH;
    return Math.sqrt(t1 * t1 + t2 * t2 + t3 * t3 + RT * t2 * t3);
  }

  /**
   * 两两最小色差（含是哪一对）—— 验收指标与设置区「参考数」行的数据来源
   * @param {string[]} colors
   * @returns {{de:number, a:string, b:string, i:number, j:number}}
   */
  function minDeltaE(colors) {
    var list = (colors || []).filter(isHex);
    var best = { de: Infinity, a: '', b: '', i: -1, j: -1 };
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var de = deltaE2000(list[i], list[j]);
        if (de < best.de) best = { de: de, a: list[i], b: list[j], i: i, j: j };
      }
    }
    if (!isFinite(best.de)) best.de = null;      // 少于 2 色 → 无「两两色差」可言
    return best;
  }

  YMS.Palettes = {
    PRESETS: PRESETS,
    DEFAULT_ID: DEFAULT_ID,
    isHex: isHex,
    get: get,
    ids: ids,
    options: options,
    capacity: capacity,
    pickColors: pickColors,
    suggest: suggest,
    shiftLight: shiftLight,
    srgbToLab: srgbToLab,
    deltaE2000: deltaE2000,
    minDeltaE: minDeltaE
  };
})(typeof window !== 'undefined' ? window : this);
