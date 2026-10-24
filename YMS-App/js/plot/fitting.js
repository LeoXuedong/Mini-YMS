/* ==========================================================================
   YMS · js/plot/fitting.js
   ---------------------------------------------------------------------------
   职责：曲线拟合（最小二乘）。公开 API：
     YMS.Fitting.fit(xs, ys, method, order)
        -> { ok:true, method, order, formula, r2, coefficients, predict(x), n, note }
        -> { ok:false, reason }                       // 退化输入一律走这里，不抛异常
     YMS.Fitting.METHODS        // [{value,label}] 供绘图设置面板（YMS.PlotSettings）下拉引用

   拟合方式：
     'linear'     y = a + bx
     'quadratic'  y = c0 + c1x + c2x²
     'cubic'      y = c0 + c1x + c2x² + c3x³
     'poly'       多项式 order 阶（2..8）
     'exp'        y = a·e^(bx)      （要求 y > 0）
     'log'        y = a + b·ln x    （要求 x > 0）
     'power'      y = a·x^b         （要求 x > 0 且 y > 0）
     'none'       不拟合 -> {ok:false, reason:'未选择拟合方式'}

   实现要点（严格遵循需求书 / DEV-SPEC 3.D1）：
     · 多项式族：**正规方程 + 高斯消元（列主元）**。为保数值稳定（x 可能是 epochMs，
       量级 1e12），内部先把 x 中心化归一化到 t = (x - x0) / s ∈ [-1, 1] 建立正规方程，
       解出 t 基系数后再用二项式展开还原为原始 x 基系数；对外 coefficients / predict
       全部是原始尺度，formula 也按原始 x 书写（与需求书示例一致）。
     · exp/log/power：先对 (x, ln y) / (ln x, y) / (ln x, ln y) 做一次线性正规方程拟合，
       再指数还原。取值域外的点被剔除并在 note 中说明剔除了多少点。
     · R² 在**原始尺度**计算：r2 = 1 - SSres / SStot（SStot 用 ys 均值）；当最大残差
       < 1e-9 × scale（scale = max|y|）时视作完全拟合，r2 = 1；结果保留 6 位小数。
     · 过滤：非有限值（NaN/±Infinity）逐个剔除；xs / ys 按较短长度配对。
     · 退化保护：空数组、全 NaN、点数不足、x 无变化（矩阵奇异）、阶数 > 有效点数-1
       均返回 {ok:false, reason:'…'}，不抛异常、不泄漏 NaN。
     · coefficients 顺序：多项式族为升幂 [c0, c1, c2, …]；exp/log/power 为 [a, b]。
     · 离线约束：file:// 双击可运行，无 fetch/ES module/CDN，ES2017 以内语法。
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};

  /* ------------------------------------------------------------------ 常量 */
  var METHODS = [
    { value: 'none', label: '无' },
    { value: 'linear', label: '线性' },
    { value: 'quadratic', label: '二次' },
    { value: 'cubic', label: '三次' },
    { value: 'poly', label: '多项式 N 阶' },
    { value: 'exp', label: '指数' },
    { value: 'log', label: '对数' },
    { value: 'power', label: '幂' }
  ];

  var MIN_ORDER = 2;      // poly 的最小阶数
  var MAX_ORDER = 8;      // poly 的最大阶数
  var EPS_REL = 1e-9;     // 完全拟合判定：最大残差 < EPS_REL × scale

  /* 二项式系数表（k <= 8），用于 t 基 -> x 基系数展开 */
  var BINOM = [
    [1],
    [1, 1],
    [1, 2, 1],
    [1, 3, 3, 1],
    [1, 4, 6, 4, 1],
    [1, 5, 10, 10, 5, 1],
    [1, 6, 15, 20, 15, 6, 1],
    [1, 7, 21, 35, 35, 21, 7, 1],
    [1, 8, 28, 56, 70, 56, 28, 8, 1]
  ];

  var SUPER = ['', '', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸'];

  /* -------------------------------------------------------------- 小工具 */

  /** 失败结果（统一出口，保证调用方只需判 ok） */
  function fail(reason) { return { ok: false, reason: reason }; }

  /** 固定 4 位小数（极小值归一为 0，避免出现 '-0.0000'） */
  function fmt4(v) {
    if (typeof v !== 'number' || !isFinite(v)) v = 0;
    if (Math.abs(v) < 5e-5) v = 0;
    return v.toFixed(4);
  }

  /** 归一化系数：绝对值 < 5e-5 的噪声项按 0 处理（仅用于公式文本，不改动 coefficients） */
  function nz(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 0;
    return (Math.abs(v) < 5e-5) ? 0 : v;
  }

  /**
   * 高斯消元求解 A·x = b（列主元 = 选当前列绝对值最大的行做枢轴）。
   * @param {Array<Array<number>>} A n×n 系数矩阵（不修改入参）
   * @param {Array<number>} b 右端项（不修改入参）
   * @param {number} n 阶数
   * @returns {Array<number>|null} 解向量；矩阵奇异 / 出现非有限值时返回 null
   */
  function gaussSolve(A, b, n) {
    var i, j, k, maxAbs = 0;
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        var av = Math.abs(A[i][j]);
        if (av > maxAbs) maxAbs = av;
      }
    }
    if (!(maxAbs > 0)) return null;

    /* 增广矩阵（深拷贝一维，避免污染入参） */
    var M = [];
    for (i = 0; i < n; i++) {
      M.push(A[i].slice());
      M[i].push(b[i]);
    }

    /* 前向消元（列主元） */
    for (k = 0; k < n; k++) {
      var piv = k, pv = Math.abs(M[k][k]);
      for (i = k + 1; i < n; i++) {
        var cv = Math.abs(M[i][k]);
        if (cv > pv) { pv = cv; piv = i; }
      }
      if (!(pv > 1e-12 * maxAbs)) return null;         // 奇异：x 无变化 / 点数不足
      if (piv !== k) { var tmp = M[k]; M[k] = M[piv]; M[piv] = tmp; }
      var diag = M[k][k];
      for (i = k + 1; i < n; i++) {
        var f = M[i][k] / diag;
        if (f === 0) continue;
        for (j = k; j <= n; j++) M[i][j] -= f * M[k][j];
      }
    }

    /* 回代 */
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    for (i = 0; i < n; i++) if (!isFinite(x[i])) return null;
    return x;
  }

  /**
   * 多项式最小二乘：正规方程 + 高斯消元（列主元）。
   * 内部把 x 归一化到 t = (x - x0) / s（s = 半跨度，t ∈ [-1,1]）再解，
   * 最后展开回原始 x 基，兼顾数值稳定与「正规方程」的实现要求。
   * @param {Array<number>} xs 有效 x（长度 = ys 长度，均已过滤）
   * @param {Array<number>} ys 有效 y
   * @param {number} deg 阶数（>= 1）
   * @returns {{coefs:Array<number>}|null} coefs 升幂（x 基）；奇异返回 null
   */
  function fitPolyNormal(xs, ys, deg) {
    var n = xs.length, i, j, k;
    var lo = Infinity, hi = -Infinity;
    for (i = 0; i < n; i++) { if (xs[i] < lo) lo = xs[i]; if (xs[i] > hi) hi = xs[i]; }
    var span = hi - lo;
    if (!(span > 0)) return null;                      // x 全相等 -> 退化
    var x0 = (lo + hi) / 2, s = span / 2;

    var t = new Array(n);
    for (i = 0; i < n; i++) t[i] = (xs[i] - x0) / s;

    /* 正规方程：A[j][k] = Σ t^(j+k)，b[j] = Σ t^j·y */
    var d = deg + 1;
    var A = [], b = new Array(d);
    for (j = 0; j < d; j++) { A.push(new Array(d)); b[j] = 0; }
    var pw = new Array(n * d);                         // pw[i*d + p] = t[i]^p
    for (i = 0; i < n; i++) {
      var pv = 1;
      for (k = 0; k < d; k++) { pw[i * d + k] = pv; pv *= t[i]; }
    }
    for (j = 0; j < d; j++) {
      for (k = 0; k < d; k++) {
        var sum = 0;
        for (i = 0; i < n; i++) sum += pw[i * d + j] * pw[i * d + k];
        A[j][k] = sum;
      }
      var sy = 0;
      for (i = 0; i < n; i++) sy += pw[i * d + j] * ys[i];
      b[j] = sy;
    }

    var c = gaussSolve(A, b, d);                       // t 基系数（升幂）
    if (!c) return null;

    /* t = u + v·x（u = -x0/s, v = 1/s）-> 展开为 x 基升幂系数 a[j] */
    var v = 1 / s, u = -x0 / s;
    var a = new Array(d);
    for (j = 0; j < d; j++) a[j] = 0;
    for (k = 0; k < d; k++) {
      var ck = c[k];
      if (ck === 0) continue;
      for (j = 0; j <= k; j++) {
        a[j] += ck * BINOM[k][j] * Math.pow(v, j) * Math.pow(u, k - j);
      }
    }
    for (j = 0; j < d; j++) if (!isFinite(a[j])) return null;
    return { coefs: a };
  }

  /** 升幂多项式 -> predict(x)（Horner，自最高次开始） */
  function polyPredict(coefs) {
    return function (x) {
      var y = 0;
      for (var j = coefs.length - 1; j >= 0; j--) y = y * x + coefs[j];
      return y;
    };
  }

  /** 可读多项式公式（降幂书写，系数 4 位小数） */
  function polyFormula(a) {
    var parts = [], i;
    for (i = a.length - 1; i >= 0; i--) {
      var c = nz(a[i]), mag = fmt4(Math.abs(c));
      var term = (i === 0) ? mag : (i === 1 ? mag + 'x' : mag + 'x' + SUPER[i]);
      if (!parts.length) parts.push((c < 0 ? '-' : '') + term);
      else parts.push((c < 0 ? ' - ' : ' + ') + term);
    }
    return 'y = ' + parts.join('');
  }

  /** 线性公式：'y = a + bx' 形式（与需求书一致） */
  function linearFormula(c) {
    var a0 = nz(c[0]), a1 = nz(c[1]);
    return 'y = ' + fmt4(a0) + (a1 < 0 ? ' - ' : ' + ') + fmt4(Math.abs(a1)) + 'x';
  }

  /**
   * R²（原始尺度）：1 - SSres / SStot，SStot 用 ys 均值。
   * 最大残差 < 1e-9 × max|y| 视作完全拟合 -> 1；保留 6 位小数；上限 1。
   * @returns {number} r2
   */
  function computeR2(predict, xs, ys) {
    var n = xs.length, i, sum = 0, scale = 0;
    for (i = 0; i < n; i++) {
      sum += ys[i];
      var ay = Math.abs(ys[i]);
      if (ay > scale) scale = ay;
    }
    if (!(scale > 0)) scale = 1;
    var mean = sum / n;
    var ssRes = 0, ssTot = 0, maxRes = 0;
    for (i = 0; i < n; i++) {
      var p = predict(xs[i]);
      if (!isFinite(p)) return 0;
      var r = ys[i] - p;
      if (Math.abs(r) > maxRes) maxRes = Math.abs(r);
      ssRes += r * r;
      var dv = ys[i] - mean;
      ssTot += dv * dv;
    }
    var r2;
    if (maxRes <= EPS_REL * scale) r2 = 1;                       // 完全拟合
    else if (!(ssTot > 0)) r2 = (ssRes <= 0) ? 1 : 0;            // y 恒为常数
    else r2 = 1 - ssRes / ssTot;
    if (!isFinite(r2)) r2 = 0;
    r2 = Math.round(r2 * 1e6) / 1e6;
    if (r2 > 1) r2 = 1;
    return r2;
  }

  /* -------------------------------------------------------------- 主入口 */

  /**
   * 曲线拟合。
   * @param {Array<number>|Float64Array} xs X 序列（允许 epochMs 时间值）
   * @param {Array<number>|Float64Array} ys Y 序列
   * @param {string} method 'none'|'linear'|'quadratic'|'cubic'|'poly'|'exp'|'log'|'power'
   * @param {number} [order] 'poly' 的阶数（2..8）
   * @returns {{ok:boolean, reason?:string, method?:string, order?:number, formula?:string,
   *            r2?:number, coefficients?:Array<number>, predict?:function, n?:number, note?:string}}
   */
  function fit(xs, ys, method, order) {
    var m = String(method === undefined || method === null ? 'none' : method);

    /* 1) 方式与阶数解析 */
    var deg = 0;
    if (m === 'none') return fail('未选择拟合方式');
    if (m === 'linear') deg = 1;
    else if (m === 'quadratic') deg = 2;
    else if (m === 'cubic') deg = 3;
    else if (m === 'poly') {
      var o = Math.round(Number(order));
      if (!isFinite(o)) return fail('多项式阶数无效');
      if (o > MAX_ORDER) return fail('阶数过高');                 // 超出 2~8 上限，同 DEV-SPEC 文案
      if (o < MIN_ORDER) return fail('多项式阶数需在 ' + MIN_ORDER + '~' + MAX_ORDER + ' 之间');
      deg = o;
    } else if (m !== 'exp' && m !== 'log' && m !== 'power') {
      return fail('不支持的拟合方式：' + m);
    }

    /* 2) 过滤：非有限值 + 取值域 (exp: y>0 / log: x>0 / power: x>0 且 y>0) */
    if (!xs || !ys || typeof xs.length !== 'number' || typeof ys.length !== 'number') {
      return fail('无有效数据点');
    }
    var n0 = Math.min(xs.length, ys.length);
    if (n0 <= 0) return fail('无有效数据点');

    var px = [], py = [], dropBad = 0, dropDomain = 0, i;
    for (i = 0; i < n0; i++) {
      var x = Number(xs[i]), y = Number(ys[i]);
      if (!isFinite(x) || !isFinite(y)) { dropBad++; continue; }
      if ((m === 'log' || m === 'power') && !(x > 0)) { dropDomain++; continue; }
      if ((m === 'exp' || m === 'power') && !(y > 0)) { dropDomain++; continue; }
      px.push(x); py.push(y);
    }
    var n = px.length;
    if (n <= 0) return fail('无有效数据点');

    if (deg >= 1) {
      if (n < deg + 1) return fail('阶数过高');                        // DEV-SPEC 指定文案
    } else if (n < 2) {
      return fail('有效数据点不足（至少需要 2 个）');
    }

    /* 3) 求解 */
    var coefs, predict, formula, noteParts = [];

    if (deg >= 1) {
      var poly = fitPolyNormal(px, py, deg);
      if (!poly) return fail('数据退化（x 无变化）');                    // DEV-SPEC 指定文案
      coefs = poly.coefs;
      predict = polyPredict(coefs);
      formula = (deg === 1) ? linearFormula(coefs) : polyFormula(coefs);
      if (deg > 1) noteParts.push('正规方程 + 高斯消元（列主元），' + deg + ' 阶');
    } else if (m === 'exp') {
      var ly = new Array(n);
      for (i = 0; i < n; i++) ly[i] = Math.log(py[i]);                  // y>0 已保证
      var le = fitPolyNormal(px, ly, 1);
      if (!le) return fail('数据退化（x 无变化）');
      var ea = Math.exp(le.coefs[0]), eb = le.coefs[1];
      if (!isFinite(ea) || !isFinite(eb)) return fail('拟合失败（数值溢出）');
      coefs = [ea, eb];
      predict = function (x) { return ea * Math.exp(eb * x); };
      formula = 'y = ' + fmt4(nz(ea)) + 'e^(' + fmt4(nz(eb)) + 'x)';
      noteParts.push('指数拟合基于 ln y 线性化');
    } else if (m === 'log') {
      var lx = new Array(n);
      for (i = 0; i < n; i++) lx[i] = Math.log(px[i]);                  // x>0 已保证
      var ll = fitPolyNormal(lx, py, 1);
      if (!ll) return fail('数据退化（x 无变化）');
      var la = ll.coefs[0], lb = ll.coefs[1];
      if (!isFinite(la) || !isFinite(lb)) return fail('拟合失败（数值溢出）');
      coefs = [la, lb];
      predict = function (x) { return (x > 0) ? (la + lb * Math.log(x)) : NaN; };
      var lbn = nz(lb);
      formula = 'y = ' + fmt4(nz(la)) + (lbn < 0 ? ' - ' : ' + ') + fmt4(Math.abs(lbn)) + '·ln x';
      noteParts.push('对数拟合基于 ln x 线性化（x > 0）');
    } else {                                                            // power
      var pxs = new Array(n), pys = new Array(n);
      for (i = 0; i < n; i++) { pxs[i] = Math.log(px[i]); pys[i] = Math.log(py[i]); }
      var lp = fitPolyNormal(pxs, pys, 1);
      if (!lp) return fail('数据退化（x 无变化）');
      var pa = Math.exp(lp.coefs[0]), pb = lp.coefs[1];
      if (!isFinite(pa) || !isFinite(pb)) return fail('拟合失败（数值溢出）');
      coefs = [pa, pb];
      predict = function (x) { return (x > 0) ? (pa * Math.pow(x, pb)) : NaN; };
      formula = 'y = ' + fmt4(pa) + 'x^' + fmt4(pb);
      noteParts.push('幂拟合基于 ln x / ln y 线性化（x > 0 且 y > 0）');
    }

    /* 4) R²（原始尺度） */
    var r2 = computeR2(predict, px, py);

    /* 5) note：说明剔除的点数 */
    if (dropBad > 0) noteParts.push('剔除 ' + dropBad + ' 个非有限点');
    if (dropDomain > 0) {
      if (m === 'exp') noteParts.push('剔除 ' + dropDomain + ' 个非正 y 点（指数拟合要求 y > 0）');
      else if (m === 'log') noteParts.push('剔除 ' + dropDomain + ' 个非正 x 点（对数拟合要求 x > 0）');
      else noteParts.push('剔除 ' + dropDomain + ' 个非正 x 或 y 点（幂拟合要求 x > 0 且 y > 0）');
    }
    noteParts.push('有效点 ' + n + ' 个');

    return {
      ok: true,
      method: m,
      order: deg || null,
      formula: formula,
      r2: r2,
      coefficients: coefs,
      predict: predict,
      n: n,
      note: noteParts.join('；')
    };
  }

  YMS.Fitting = {
    fit: fit,
    METHODS: METHODS,
    MIN_ORDER: MIN_ORDER,
    MAX_ORDER: MAX_ORDER
  };
})(typeof window !== 'undefined' ? window : this);
