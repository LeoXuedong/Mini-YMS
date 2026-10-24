/* ==========================================================================
   YMS · table/column-ops.js
   列级操作 —— YMS.ColumnOps（右键菜单 + 参数属性 / 格式转换 / 数据计算 / 填充缺失 /
   去重 / 重命名 / 删除列）
     · 所有结构性改动都写回 Store：Store.replaceDataFrame(df)（改名/删列/去重/加列/改格式）
       或 Store.notifyDataValuesChanged()（原地填充缺失）
     · 重命名/删除列必须同步：dataSettings.decimals 键、dataSettings.sorters、
       dataSettings.preprocess.filters[].col、plot.x / values / pageBy / splitBy、plot.sorters[].col
     · 填充缺失是「写数据」：完成时 df.stats(ci).missing === 0
     · 删除类操作（删列 / 去重）一律 YMS.util.confirm 二次确认
   公开 API（DEV-SPEC 3.B2）：contextMenu / showProperties / changeFormat / computeColumn /
             fillMissing / dedupeBy / renameColumn / deleteColumn
   编程入口（app.js 的 window.__YMS__ 验收接口调用，无对话框 / 无二次确认）：
             computeColumnProgrammatic / fillMissingProgrammatic / convertTypeProgrammatic /
             renameColumnProgrammatic / deleteColumnProgrammatic / dedupeByProgrammatic
   内部纯逻辑（供 Node 自测，均为 _ 前缀）：_buildExpr / _computeSeries / _autoColumnName /
             _openCallBefore / _uniqueColName / _fillMissing / _convertColumn / _dedupe /
             _syncRename / _dropFromSettings / _statsRows / _fillText
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util, T = YMS.types, Store = YMS.Store;
  var el = U.el;                                   // 建元素别名（对话框 / 面板用）

  /* 合法 JS 标识符：列名可作表达式变量；否则只能 col('名称') 访问 */
  var IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  /* 保留字：不能作为 new Function 的参数名 */
  var RESERVED = {
    arguments: 1, await: 1, break: 1, case: 1, catch: 1, class: 1, const: 1, continue: 1,
    debugger: 1, default: 1, delete: 1, do: 1, else: 1, enum: 1, eval: 1, export: 1, extends: 1,
    false: 1, finally: 1, for: 1, function: 1, if: 1, implements: 1, import: 1, in: 1,
    instanceof: 1, interface: 1, let: 1, new: 1, null: 1, package: 1, private: 1, protected: 1,
    public: 1, return: 1, static: 1, super: 1, switch: 1, this: 1, throw: 1, true: 1, try: 1,
    typeof: 1, var: 1, void: 1, while: 1, with: 1, yield: 1
  };
  var FILL_METHODS = [
    { value: 'mean', label: '均值' },
    { value: 'median', label: '中位数' },
    { value: 'zero', label: '0' },
    { value: 'prev', label: '前一行' },
    { value: 'fixed', label: '固定值' }
  ];
  var FORMATS = [
    { value: 'char', label: '字符 char', cn: '字符' },
    { value: 'int', label: '整数 int（四舍五入，小数位=0）', cn: '整数' },
    { value: 'float', label: '数值 float', cn: '数值' },
    { value: 'time', label: '时间 time（Excel 序列号 / 时间戳 / 日期字符串）', cn: '时间' }
  ];
  var TIME_STYLES = [
    { value: 'auto', label: '自动' }, { value: 'date', label: '日期' },
    { value: 'time', label: '时间' }, { value: 'datetime', label: '日期时间' }
  ];

  /* ==========================================================================
     小工具
     ========================================================================== */
  function esc(s) { return U.escapeHtml(s); }
  /** 4 位小数（toast 文案，如 均值 91.9827） */
  function fmt4(v) {
    if (v === null || v === undefined || v !== v) return '—';
    if (!isFinite(v)) return String(v);
    return String(Math.round(v * 10000) / 10000);
  }
  /** 统计值文本（时间列按时间样式显示） */
  function fmtStat(v, type, timeStyle) {
    if (v === null || v === undefined || (typeof v === 'number' && v !== v)) return '—';
    if (type === T.TIME) return T.formatTime(v, timeStyle || 'datetime');
    if (typeof v === 'number') return U.fmtNumber(v, null);
    return String(v);
  }
  function typeLabel(type) { return T.TYPE_LABEL[type] || type; }
  /** 数值显示（缺失/无值 → —） */
  function statNum(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number' && v !== v) return '—';
    return U.fmtNumber(v, null);
  }
  /** 数值化原始存储值（字符列按 parseNumber；缺失 → NaN） */
  function numRawAt(c, ri) {
    var raw = c.values[ri];
    if (c.type === T.STRING) return raw < 0 ? NaN : T.parseNumber(c.dict[raw]);
    return raw;
  }

  /* ==========================================================================
     纯逻辑 1：表达式解析与计算列
     ========================================================================== */
  /* --------------------------------------------------------------------------
     迭代 24：语句块模式（if / for / while / let / const / var / switch / try）
       · 判定（先给字符串与注释「打码」，只看代码本体）：
           含 return 关键字 / 首词是语句关键字 / 顶层出现 ';'  → 语句模式
           其余情况仍走原来的单表达式模式（默认路径零改动）
       · 语句模式编译：new Function(params…, body)，body 即用户源码，
         必须自己写 return 交回结果（没写 → 报错「语句块需要以 return 返回一个值」）
       · 仅语句模式注入：__i（0 基行号）/ __n（总行数）/ __tick()（迭代计数）
       · 两种模式都可用：iif / choose / coalesce / between
         （if 是保留字不能作函数名，所以条件函数叫 iif）
       · 安全：编译前静态扫描（window / document / localStorage / fetch / eval …）
       · 防死循环：while/for 保守改写插入 __tick()（单行 20 万次迭代上限）
         + 时间预算（预览 1.5s / 确定 8s）；超限抛错交给 UI 显示，绝不卡住页面
     -------------------------------------------------------------------------- */
  /* 首词命中即按语句块处理 */
  var STMT_HEAD = {
    if: 1, for: 1, while: 1, let: 1, const: 1, var: 1,
    switch: 1, try: 1
  };
  /* 不允许在表达式 / 语句块里出现的宿主全局（静态扫描，不执行） */
  var FORBIDDEN = [
    'window', 'document', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest',
    'eval', 'Function', 'require', 'import', 'globalThis', 'top', 'parent', 'self',
    'postMessage', 'Worker', 'WebSocket'
  ];
  var TICK_LIMIT = 200000;          // 单行迭代上限
  var BUDGET_PREVIEW = 1500;        // 预览时间预算（ms）
  var BUDGET_COMMIT = 8000;         // 确定（整列计算）时间预算（ms）

  /** 缺失值判定（null / undefined / NaN / ±Infinity）—— 统一走 YMS.num.isMissing */
  function isMissing(v) {
    return YMS.num.isMissing(v);
  }

  /** 表达式级辅助函数（两种模式都注入；与列名 / 内置函数重名时列名与内置函数优先） */
  var EXPR_HELPERS = {
    /** 条件取值：cond 成立取 a，否则取 b（缺失条件按不成立处理） */
    iif: function (cond, a, b) { return cond ? a : b; },
    /** 按序号取值：choose(0, a, b) → a；越界得 NaN */
    choose: function (idx) {
      var k = Math.round(idx);
      if (!(k >= 0)) return NaN;                     // 负数 / 非数值（含 NaN）
      var v = arguments[k + 1];
      return v === undefined ? NaN : v;
    },
    /** 首个非缺失值；全缺失得 NaN */
    coalesce: function () {
      for (var i = 0; i < arguments.length; i++) {
        if (!isMissing(arguments[i])) return arguments[i];
      }
      return NaN;
    },
    /** 闭区间判断：lo ≤ x ≤ hi → 1，否则 0；x 缺失 → 缺失 */
    between: function (x, lo, hi) {
      if (isMissing(x)) return NaN;
      return (x >= lo && x <= hi) ? 1 : 0;
    }
  };

  /**
   * 源码「打码」：把字符串 / 模板串 / 注释替换成等长空格（保留换行与引号）
   * 用途：① 关键字与危险全局只看代码本体，列名里的 window 之类不会误判
   *       ② 括号配对、for 头分段在打码串上做，字符串里的括号不会干扰
   */
  function maskSource(src) {
    var out = '', i = 0, n = src.length, c, q, c2;
    while (i < n) {
      c = src.charAt(i);
      if (c === '/' && src.charAt(i + 1) === '/') {                 // 行注释
        while (i < n && src.charAt(i) !== '\n') { out += ' '; i++; }
        continue;
      }
      if (c === '/' && src.charAt(i + 1) === '*') {                 // 块注释
        out += '  '; i += 2;
        while (i < n && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) {
          out += (src.charAt(i) === '\n' ? '\n' : ' '); i++;
        }
        if (i < n) { out += '  '; i += 2; }
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {                    // 字符串 / 模板串
        q = c; out += c; i++;
        while (i < n) {
          c2 = src.charAt(i);
          if (c2 === '\\') { out += '  '; i += 2; continue; }
          if (c2 === q) { out += q; i++; break; }
          out += (c2 === '\n' ? '\n' : ' '); i++;
        }
        continue;
      }
      out += c; i++;
    }
    return out;
  }

  /** 危险全局名单 → 单条正则：前面不能是标识符字符或 '.'（只匹配真正的全局引用，如 window.alert） */
  var FORBIDDEN_RE = new RegExp('(^|[^A-Za-z0-9_$.])(' + FORBIDDEN.join('|') + ')\\b');
  /** 静态安全检查：返回命中的全局名，未命中返回 null */
  function forbiddenIn(masked) {
    var m = FORBIDDEN_RE.exec(masked);
    return m ? m[2] : null;
  }

  /** 顶层（括号外）是否出现语句结束符 ';' */
  function hasTopSemicolon(masked) {
    var d = 0, i, c;
    for (i = 0; i < masked.length; i++) {
      c = masked.charAt(i);
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') { if (d > 0) d--; }
      else if (c === ';' && d === 0) return true;
    }
    return false;
  }

  /** 是否走语句块模式 */
  function isStatementSrc(masked) {
    if (/\breturn\b/.test(masked)) return true;
    var m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(masked);
    if (m && STMT_HEAD[m[1]] === 1) return true;
    return hasTopSemicolon(masked);
  }

  /** 守卫错误（__ymsg 让 UI 直接显示人话，不再套「表达式执行失败：」前缀） */
  function guardErr(msg) {
    var e = new Error(msg);
    e.__ymsg = msg;
    return e;
  }

  /** while 条件插入 __tick()：while (c) → while (__tick() && (c)) */
  function guardWhile(inner) {
    return inner.trim() ? ('__tick() && (' + inner + ')') : '__tick()';
  }

  /** for 头按顶层 ';' 分三段（init; cond; inc）；不是三段（for-of / for-in）→ 不改写 */
  function splitForHeader(inner, maskedInner) {
    var parts = [], d = 0, start = 0, i, c;
    for (i = 0; i < maskedInner.length; i++) {
      c = maskedInner.charAt(i);
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') { if (d > 0) d--; }
      else if (c === ';' && d === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
    }
    parts.push(inner.slice(start));
    return parts;
  }

  /** for (init; cond; inc) → for (init; __tick() && (cond); inc) */
  function guardFor(inner, maskedInner) {
    var p = splitForHeader(inner, maskedInner);
    if (p.length !== 3) return null;
    var cond = p[1].trim();
    return p[0] + '; ' + (cond ? ('__tick() && (' + cond + ')') : '__tick()') + '; ' + p[2];
  }

  /**
   * 保守改写 while / for 的条件，插入 __tick()（只在打码串上找括号，字符串不参与）
   * 括号不配对 / for 头不是三段 → 放弃改写（该处原样保留），返回值 ok 仍为 true
   * @returns {{ok:boolean, src:string, count:number}}
   */
  function rewriteLoops(src, masked) {
    var out = [], last = 0, count = 0, re = /\b(while|for)\s*\(/g, m, open, close, inner, rep;
    while ((m = re.exec(masked)) !== null) {
      open = m.index + m[0].length - 1;                 // '(' 的下标
      close = matchParen(masked, open);
      if (close < 0) return { ok: false, src: src, count: 0 };
      inner = src.slice(open + 1, close);
      rep = m[1] === 'while' ? guardWhile(inner) : guardFor(inner, masked.slice(open + 1, close));
      if (rep === null) { re.lastIndex = close + 1; continue; }   // 不改写这一处
      out.push(src.slice(last, open + 1));
      out.push(rep);
      last = close;
      re.lastIndex = close + 1;
      count++;
    }
    if (!count) return { ok: true, src: src, count: 0 };
    out.push(src.slice(last));
    return { ok: true, src: out.join(''), count: count };
  }

  /**
   * 构建表达式函数（参数 = 合法标识符列名 + YMS.types.EXPR_FUNCS + 辅助函数 + Math + col）
   * 非法标识符列名用 col('名称') 访问；缺失值参与运算得 NaN。
   * 含语句（return / if / for / while / let / const / var / switch / try / 顶层 ';'）
   * 时改走「语句块模式」：body 直接是用户源码，必须自己 return。
   * @param {string} expr
   * @param {string[]} colNames
   * @param {{budget:number}} [opts] 时间预算（ms，默认确定模式 8s）
   * @returns {{ok:boolean, error?:string, mode?:string, fn?:Function, params?:string[],
   *            paramIndex?:Object, colParamIndex?:Object}}
   */
  function buildExpr(expr, colNames, opts) {
    var src = String(expr === undefined || expr === null ? '' : expr).trim();
    if (!src) return { ok: false, error: '表达式不能为空' };
    colNames = colNames || [];
    opts = opts || {};

    var masked = maskSource(src);
    var bad = forbiddenIn(masked);
    if (bad) return { ok: false, error: '不允许访问 ' + bad };

    var params = [], paramIndex = {}, colParamIndex = {};
    var i, j;
    function addParam(nm) {
      if (paramIndex[nm] !== undefined) return;
      paramIndex[nm] = params.length;
      params.push(nm);
    }
    for (i = 0; i < colNames.length; i++) {
      var n = colNames[i];
      if (typeof n !== 'string' || !n) continue;
      if (!IDENT_RE.test(n) || RESERVED[n]) continue;          // 非法标识符 → 用 col()
      if (n === 'col' || n === 'Math') continue;
      if (T.EXPR_FUNCS[n] !== undefined) continue;             // 与内置函数同名 → 函数优先
      if (EXPR_HELPERS[n] !== undefined) continue;             // 与辅助函数同名 → 函数优先
      if (params.indexOf(n) >= 0) continue;
      colParamIndex[n] = params.length;
      addParam(n);
    }
    var helperNames = [];
    var keys = Object.keys(T.EXPR_FUNCS);
    for (j = 0; j < keys.length; j++) {
      if (params.indexOf(keys[j]) < 0) { helperNames.push(keys[j]); addParam(keys[j]); }
    }
    var hkeys = Object.keys(EXPR_HELPERS);
    for (j = 0; j < hkeys.length; j++) addParam(hkeys[j]);
    addParam('Math');
    addParam('col');

    var stmt = isStatementSrc(masked);
    if (stmt && !/\breturn\b/.test(masked)) {
      return { ok: false, mode: 'stmt', error: '语句块需要以 return 返回一个值' };
    }

    var body = src, loops = 0;
    if (stmt) {
      addParam('__i');
      addParam('__n');
      addParam('__tick');
      var rw = rewriteLoops(src, masked);
      if (rw.ok) { body = rw.src; loops = rw.count; }
    }

    var fn;
    try {
      /* 表达式模式：只构造一条返回值；语句模式：整段源码作函数体 */
      fn = new Function(params.join(','), stmt ? body : 'return (' + src + ');');
    } catch (err) {
      return { ok: false, mode: stmt ? 'stmt' : 'expr', error: '语法错误：' + err.message };
    }
    return {
      ok: true, fn: fn, params: params, paramIndex: paramIndex, colParamIndex: colParamIndex,
      helperNames: helperNames, expr: src, mode: stmt ? 'stmt' : 'expr',
      body: stmt ? body : null, loops: loops,
      budget: opts.budget || BUDGET_COMMIT, tickLimit: TICK_LIMIT
    };
  }

  /**
   * 构造逐行求值器（复用同一个 args 数组，避免每行分配）
   * 迭代 24：语句模式额外设置 __i / __n，并按行重置迭代计数、检查时间预算
   */
  function makeEvaluator(df, built) {
    var cols = df.cols, nc = cols.length, nparams = built.params.length;
    var args = new Array(nparams);
    var curRow = 0;
    var nRows = df.rowCount;
    var pidx = built.paramIndex || {};
    var idxI = pidx.__i, idxN = pidx.__n, idxTick = pidx.__tick;
    var ticks = 0;
    var limit = built.tickLimit || TICK_LIMIT;
    var budget = built.budget || BUDGET_COMMIT;
    var deadline = Date.now() + budget;
    var colFn = function (name) {
      var ci = df.colIndex(name);
      if (ci < 0) return NaN;
      return numRawAt(df.cols[ci], curRow);
    };
    /* 循环体每次迭代调用一次：超过单行上限 / 超出时间预算 → 抛错中止 */
    function tickFn() {
      ticks++;
      if (ticks > limit) throw guardErr('循环次数超限（可能存在死循环）');
      if ((ticks & 4095) === 0 && Date.now() > deadline) throw guardErr('表达式执行超时（可能存在死循环）');
      return true;
    }
    var i, k;
    for (i = 0; i < nparams; i++) {
      var pn = built.params[i];
      if (built.colParamIndex[pn] !== undefined) continue;
      if (pn === 'col') args[i] = colFn;
      else if (pn === 'Math') args[i] = Math;
      else if (pn === '__tick') args[i] = tickFn;
      else if (EXPR_HELPERS[pn] !== undefined) args[i] = EXPR_HELPERS[pn];
      else args[i] = T.EXPR_FUNCS[pn];
    }
    return function (ri) {
      if ((ri & 63) === 0 && Date.now() > deadline) throw guardErr('表达式执行超时（可能存在死循环）');
      ticks = 0;                                            // 迭代计数按行重置
      curRow = ri;
      for (k = 0; k < nc; k++) {
        var idx = built.colParamIndex[cols[k].name];
        if (idx === undefined) continue;
        args[idx] = numRawAt(cols[k], ri);
      }
      if (idxI !== undefined) args[idxI] = ri;
      if (idxN !== undefined) args[idxN] = nRows;
      return built.fn.apply(null, args);
    };
  }

  /** 执行期错误文案：守卫错误直接给人话，其余保留「表达式执行失败：」前缀 */
  function execError(err) {
    if (err && err.__ymsg) return err.__ymsg;
    return '表达式执行失败：' + (err && err.message ? err.message : err);
  }

  /**
   * 计算新列序列
   * @param {DataFrame} df
   * @param {string} expr
   * @param {string} missingFill 'keep' | '0' | '1'
   * @returns {{ok:boolean, error?:string, values?:Float64Array, missing?:number, filled?:number}}
   */
  function computeSeries(df, expr, missingFill) {
    if (!df || !df.rowCount) return { ok: false, error: '尚未载入数据' };
    var built = buildExpr(expr, df.colNames(), { budget: BUDGET_COMMIT });
    if (!built.ok) return built;
    var n = df.rowCount;
    var evalAt = makeEvaluator(df, built);
    var out = new Float64Array(n), missing = 0, nonFinite = 0, i;
    try {
      for (i = 0; i < n; i++) {
        var r = evalAt(i);
        var num = (typeof r === 'number') ? r : NaN;
        if (num === num && !isFinite(num)) nonFinite++;      /* ±Infinity 单独计数（NaN 不算） */
        /* 非有限值（NaN / ±Infinity）一律按缺失处理：绝不写成 ∞ 更不截断成 0 */
        if (isMissing(num)) {
          missing++;
          if (missingFill === '0') num = 0;
          else if (missingFill === '1') num = 1;
          else num = NaN;
        }
        out[i] = num;
      }
    } catch (err) {
      return { ok: false, error: execError(err), mode: built.mode };
    }
    return { ok: true, values: out, missing: missing, nonFinite: nonFinite,
             filled: missingFill === '0' || missingFill === '1', mode: built.mode };
  }

  /** 预览：前 n 行计算结果（对话框实时预览用；时间预算 1.5s） */
  function previewSeries(df, expr, n) {
    if (!df || !df.rowCount) return { ok: false, error: '尚未载入数据' };
    var built = buildExpr(expr, df.colNames(), { budget: BUDGET_PREVIEW });
    if (!built.ok) return built;
    var evalAt = makeEvaluator(df, built);
    var m = Math.min(n || 3, df.rowCount), out = [];
    try {
      for (var i = 0; i < m; i++) {
        var v = evalAt(i);
        out.push((typeof v === 'number' && !isMissing(v)) ? U.fmtNumber(v, null) : '缺失');
      }
    } catch (err) {
      return { ok: false, error: execError(err), mode: built.mode };
    }
    return { ok: true, values: out, mode: built.mode };
  }

  /* ==========================================================================
     纯逻辑 2：填充缺失（写数据）
     ========================================================================== */
  /** 字典查值（线性表 + Map 索引，避免高基数字符列的 O(n·d)） */
  function internDict(dict, map, s) {
    var k = map.get(s);
    if (k === undefined) { k = dict.length; map.set(s, k); dict.push(s); }
    return k;
  }
  /** 解析固定值（按列类型） */
  function parseFixedValue(type, raw) {
    var s = raw === undefined || raw === null ? '' : String(raw).trim();
    if (type === T.STRING) return s === '' ? { error: '固定值不能为空' } : { value: s };
    if (s === '') return { error: '固定值不能为空' };
    if (type === T.TIME) {
      var ms = T.parseTime(s);
      if (isNaN(ms)) ms = T.numberToTime(T.parseNumber(s));
      return isNaN(ms) ? { error: '无法解析为时间：' + s } : { value: ms };
    }
    var v = T.parseNumber(s);
    return isNaN(v) ? { error: '无法解析为数值：' + s } : { value: v };
  }

  /**
   * 填充缺失值（原地写回 df，完成后该列 missing === 0）
   * @param {DataFrame} df
   * @param {number} ci
   * @param {string} method 'mean'|'median'|'zero'|'prev'|'fixed'
   * @param {*} fixedValue 固定值（method==='fixed' 时使用）
   * @returns {{ok:boolean, error?:string, filled?:number, before?:number, after?:number, value?:*, text?:string}}
   */
  function fillMissingOnDf(df, ci, method, fixedValue) {
    if (!df || !df.cols[ci]) return { ok: false, error: '参数不存在' };
    var c = df.cols[ci], n = df.rowCount, i;
    var isStr = c.type === T.STRING;
    var before = c.missing || 0;
    var fillValue = null, det = null;

    if (method === 'mean' || method === 'median') {
      if (isStr) return { ok: false, error: '字符列不支持该填充方式（请用「固定值」或「前一行」）' };
      var st = df.stats(ci);
      det = method === 'mean' ? st.mean : st.median;
      if (det === null || det === undefined || det !== det) return { ok: false, error: '该参数没有可用的统计值' };
      fillValue = det;
    } else if (method === 'zero') {
      if (isStr) return { ok: false, error: '字符列不支持该填充方式（请用「固定值」或「前一行」）' };
      fillValue = 0;
    } else if (method === 'fixed') {
      var pv = parseFixedValue(c.type, fixedValue);
      if (pv.error) return { ok: false, error: pv.error };
      fillValue = pv.value;
    } else if (method !== 'prev') {
      return { ok: false, error: '未知的填充方式：' + method };
    }

    if (before === 0) {
      return { ok: true, filled: 0, before: 0, after: 0, value: null, empty: true, text: '该参数没有缺失值' };
    }

    var filled = 0;
    if (isStr) {
      var dict = c.dict || (c.dict = []), arr = c.values;
      var map = new Map();
      for (i = 0; i < dict.length; i++) map.set(dict[i], i);
      var lastIdx = -1;
      for (i = 0; i < n; i++) {
        var r = arr[i];
        if (r >= 0) { lastIdx = r; continue; }
        if (method === 'fixed') { arr[i] = internDict(dict, map, fillValue); filled++; }
        else if (method === 'prev' && lastIdx >= 0) { arr[i] = lastIdx; filled++; }
      }
    } else {
      var a = c.values, last = NaN;
      for (i = 0; i < n; i++) {
        var v = a[i];
        if (v === v) { last = v; continue; }
        if (method === 'prev') { if (last === last) { a[i] = last; filled++; } }
        else { a[i] = fillValue; filled++; }
      }
    }
    c._stats = null;                    // 统计缓存失效
    df._recount(c);                     // 重算缺失计数
    return {
      ok: true, filled: filled, before: before, after: c.missing, value: fillValue,
      text: fillText(filled, method, fillValue, c.type, c.timeStyle)
    };
  }

  /** 填充结果文案：已填充 160 个缺失值（均值 91.9827） */
  function fillText(filled, method, value, type, timeStyle) {
    var label = { mean: '均值', median: '中位数', zero: '0', prev: '前一行', fixed: '固定值' }[method] || method;
    var v;
    if (method === 'prev') v = '';
    else if (type === T.STRING) v = '「' + value + '」';
    else if (type === T.TIME) v = T.formatTime(value, timeStyle || 'datetime');
    else v = fmt4(value);
    return '已填充 ' + U.fmtInt(filled) + ' 个缺失值（' + label + (v ? ' ' + v : '') + '）';
  }

  /* ==========================================================================
     纯逻辑 3：修改数据格式（类型转换）
     ========================================================================== */
  /**
   * 转换列类型（返回新列定义，不修改 df）
   * @param {DataFrame} df
   * @param {number} ci
   * @param {string} target 'char'|'int'|'float'|'time'
   * @param {string} timeStyle 目标时间样式（'auto' 时按数据自动识别）
   * @returns {{ok:boolean, error?:string, col?:Object, decimals?:number|null, addedMissing?:number}}
   */
  function convertColumn(df, ci, target, timeStyle) {
    if (!df || !df.cols[ci]) return { ok: false, error: '参数不存在' };
    var c = df.cols[ci], from = c.type, n = df.rowCount, i;
    var toType = target === 'time' ? T.TIME : (target === 'char' ? T.STRING : T.NUMBER);
    var detect = null, newMiss = 0;

    if (toType === T.STRING) {
      var idxArr = new Int32Array(n), map = new Map(), dict = [];
      for (i = 0; i < n; i++) {
        var rs = T.convertValue(df.cell(ci, i), from, T.STRING);
        if (rs.missing) { idxArr[i] = -1; newMiss++; }
        else idxArr[i] = internDict(dict, map, String(rs.value));
      }
      return {
        ok: true, addedMissing: Math.max(0, newMiss - (c.missing || 0)),
        decimals: null,
        col: { name: c.name, type: T.STRING, values: idxArr, dict: dict, timeStyle: null }
      };
    }

    var out = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var src = df.cell(ci, i);
      var r = T.convertValue(src, from, toType);
      if (r.missing) { out[i] = NaN; newMiss++; }
      else {
        out[i] = r.value;
        if (toType === T.TIME && !detect && r.timeStyle) detect = r.timeStyle;
      }
    }
    if (target === 'int') {
      for (i = 0; i < n; i++) if (out[i] === out[i]) out[i] = Math.round(out[i]);
    }
    var style = null;
    if (toType === T.TIME) style = (timeStyle && timeStyle !== 'auto') ? timeStyle : (detect || c.timeStyle || 'datetime');
    return {
      ok: true, addedMissing: Math.max(0, newMiss - (c.missing || 0)),
      decimals: target === 'int' ? 0 : null,
      col: { name: c.name, type: toType, values: out, dict: null, timeStyle: style }
    };
  }

  /* ==========================================================================
     纯逻辑 4：去重
     ========================================================================== */
  /**
   * 按列去重（保留首行）
   * @returns {{ok:boolean, error?:string, df?:DataFrame, before?:number, after?:number, changed?:boolean}}
   */
  function dedupeDf(df, colName) {
    if (!df) return { ok: false, error: '尚未载入数据' };
    var ci = df.colIndex(colName);
    if (ci < 0) return { ok: false, error: '参数不存在：' + colName };
    var before = df.rowCount;
    var out = df.dedupeBy(ci);
    return { ok: true, df: out, before: before, after: out.rowCount, changed: out !== df };
  }

  /* ==========================================================================
     纯逻辑 5：设置同步（重命名 / 删除列）
     ========================================================================== */
  /** 重命名后同步 Store 中所有引用旧列名的地方（经 Store 方法写回） */
  function syncRename(oldName, newName) {
    var ds = Store.state.dataSettings, p = Store.state.plot;
    var oldDec = ds.decimals || {}, dec = {};
    Object.keys(oldDec).forEach(function (k) { dec[k === oldName ? newName : k] = oldDec[k]; });
    var sorters = (ds.sorters || []).map(function (s) {
      return { col: s.col === oldName ? newName : s.col, dir: s.dir === 'desc' ? 'desc' : 'asc' };
    });
    var filters = (((ds.preprocess || {}).filters) || []).map(function (f) {
      var o = {};
      Object.keys(f).forEach(function (k) { o[k] = f[k]; });
      if (o.col === oldName) o.col = newName;
      return o;
    });
    Store.applyDataSettings({
      decimals: dec, sorters: sorters,
      preprocess: { missing: (ds.preprocess || {}).missing || 'none', filters: filters }
    });
    var patch = { sorters: (p.sorters || []).map(function (s) {
      return { col: s.col === oldName ? newName : s.col, dir: s.dir === 'desc' ? 'desc' : 'asc' };
    }) };
    ['x', 'values', 'pageBy', 'splitBy'].forEach(function (k) {
      patch[k] = (p[k] || []).map(function (n) { return n === oldName ? newName : n; });
    });
    Store.applyPlot(patch);
  }

  /** 删除列后从 Store 设置中剔除该列所有引用 */
  function dropFromSettings(colName) {
    var ds = Store.state.dataSettings, p = Store.state.plot;
    var dec = {};
    Object.keys(ds.decimals || {}).forEach(function (k) { if (k !== colName) dec[k] = ds.decimals[k]; });
    Store.applyDataSettings({
      decimals: dec,
      sorters: (ds.sorters || []).filter(function (s) { return s.col !== colName; }),
      preprocess: {
        missing: (ds.preprocess || {}).missing || 'none',
        filters: (((ds.preprocess || {}).filters) || []).filter(function (f) { return f.col !== colName; })
      }
    });
    var patch = { sorters: (p.sorters || []).filter(function (s) { return s.col !== colName; }) };
    ['x', 'values', 'pageBy', 'splitBy'].forEach(function (k) {
      patch[k] = (p[k] || []).filter(function (n) { return n !== colName; });
    });
    Store.applyPlot(patch);
  }

  /* ==========================================================================
     参数属性表
     ========================================================================== */
  /**
   * 统计行（用于属性对话框与报告）
   * @param {Object} st df.stats(ci) 的结果
   * @param {Object} meta {decimals, timeStyle}
   * @returns {Array<[string,string]>}
   */
  function statsRows(st, meta) {
    meta = meta || {};
    if (!st) return [['参数', '—']];
    var ts = meta.timeStyle;
    return [
      ['参数名', String(st.name)],
      ['数据类型', (T.TYPE_CN[st.type] || st.type) + '（' + typeLabel(st.type) + '）'],
      ['总行数', U.fmtInt(st.total)],
      ['有效值', U.fmtInt(st.valid)],
      ['缺失值', U.fmtInt(st.missing)],
      ['唯一值', st.unique === null || st.unique === undefined ? '—（数据量过大）' : U.fmtInt(st.unique)],
      ['最小值 Min', fmtStat(st.min, st.type, ts)],
      ['最大值 Max', fmtStat(st.max, st.type, ts)],
      ['均值 Mean', st.type === T.STRING ? '—' : statNum(st.mean)],
      ['中位数 Median', st.type === T.STRING ? '—' : statNum(st.median)],
      ['标准差 StdDev（总体）', st.type === T.STRING ? '—' : statNum(st.stddev)],
      ['小数位', meta.decimals === undefined || meta.decimals === null ? '自动' : String(meta.decimals)],
      ['时间样式', ts || '—']
    ];
  }

  /* ==========================================================================
     原地交互：菜单项构建 + 直接执行（不弹窗；校验 / 处理说明 / toast 与原有实现一致）
     ========================================================================== */
  /** 小数位写回 Store（int 转换用） */
  function setDecimals(colName, value) {
    var src = Store.state.dataSettings.decimals || {}, dec = {};
    Object.keys(src).forEach(function (k) { dec[k] = src[k]; });
    dec[colName] = value;
    Store.applyDataSettings({ decimals: dec });
  }
  /* ==========================================================================
     纯逻辑 1b：表达式 → 默认新列名（迭代 19）
       · 有最外层函数调用 → 函数名(第一个参数里的第一个列名)
           round(Yield * 100, 2) → round(Yield)；abs(Idsat - 0.5) → abs(Idsat)
       · 只有列名 → <列名>_计算（col('Measure Time')*2 → Measure Time_计算）
       · 都没有   → 计算列
       · 与现有列重名 → 追加 ' (2)' / ' (3)' …
     ========================================================================== */
  /** 找 src[open]（'(' 的位置）的配对 ')'；无配对返回 -1 */
  function matchParen(src, open) {
    var d = 0, i, c;
    for (i = open; i < src.length; i++) {
      c = src.charAt(i);
      if (c === '(') d++;
      else if (c === ')') { d--; if (d === 0) return i; }
    }
    return -1;
  }

  /** 最外层（最靠左）函数调用：{name, argText}；col()/Math 取值与普通括号都跳过 */
  function outerCall(src) {
    var i, j, nm, isFn, close;
    for (i = 0; i < src.length; i++) {
      if (src.charAt(i) !== '(') continue;
      j = i;
      while (j > 0 && /[A-Za-z0-9_$.]/.test(src.charAt(j - 1))) j--;
      nm = src.slice(j, i);
      isFn = (T.EXPR_FUNCS[nm] !== undefined) || /^Math\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(nm);
      close = matchParen(src, i);
      if (isFn) return { name: nm, argText: src.slice(i + 1, close < 0 ? src.length : close) };
      if (close > i) i = close;                       /* col('…') / (a + b)：跳过整段继续找 */
    }
    return null;
  }

  /** 表达式里第一个被引用的列名（按出现位置；col('…') 与标识符都算） */
  function firstColumnIn(text, df) {
    var src = String(text === undefined || text === null ? '' : text);
    var best = null, bestAt = -1, m, nm, at;
    if (!df) return null;
    var reCol = /\bcol\s*\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
    while ((m = reCol.exec(src)) !== null) {
      nm = m[1].replace(/\\(.)/g, '$1');
      if (df.colIndex(nm) < 0) continue;
      if (bestAt < 0 || m.index < bestAt) { best = nm; bestAt = m.index; }
    }
    var reCol2 = /\bcol\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
    while ((m = reCol2.exec(src)) !== null) {
      nm = m[1].replace(/\\(.)/g, '$1');
      if (df.colIndex(nm) < 0) continue;
      if (bestAt < 0 || m.index < bestAt) { best = nm; bestAt = m.index; }
    }
    var reId = /(^|[^A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*)/g;
    while ((m = reId.exec(src)) !== null) {
      nm = m[2];
      at = m.index + m[1].length;
      if (T.EXPR_FUNCS[nm] !== undefined || nm === 'Math' || nm === 'col') continue;
      if (src.charAt(at + nm.length) === '(') continue;            /* 函数名不算列 */
      if (df.colIndex(nm) < 0) continue;
      if (bestAt < 0 || at < bestAt) { best = nm; bestAt = at; }
    }
    return best;
  }

  /** 名称片段清理：去引号 / 反引号，换行与连续空白压成一个空格 */
  function cleanNamePart(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/["'`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 与现有列重名 → 追加 ' (2)' / ' (3)' …（与既有重名规则一致） */
  function uniqueColName(base, df) {
    var L = autoNameL10n();
    var root = base || L.none, name = root, i = 1;
    while (df && df.colIndex(name) >= 0) { i++; name = root + ' (' + i + ')'; }
    return name;
  }

  /**
   * 由表达式推导默认新列名
   * @param {string} expr 表达式文本
   * @param {DataFrame} df 当前数据（识别列名 + 重名避让）
   * @returns {string} 例：round(Yield * 100, 2) → round(Yield)
   */
  /* 迭代 22：自动列名跟随界面语言（英文模式下不生成中文列名） */
  function autoNameL10n() {
    var en = !!(global.YMS && YMS.I18n && YMS.I18n.lang && YMS.I18n.lang() === 'en');
    return { none: en ? 'Calculated' : '计算列', suffix: en ? '_calc' : '_计算' };
  }

  function autoColumnName(expr, df) {
    var src = String(expr === undefined || expr === null ? '' : expr).trim();
    var L = autoNameL10n();
    var base = L.none, call = null, col = null;
    if (src) {
      call = outerCall(src);
      if (call) {
        col = firstColumnIn(call.argText, df) || firstColumnIn(src, df);
        base = col ? (cleanNamePart(call.name) + '(' + cleanNamePart(col) + ')') : L.none;
      } else {
        col = firstColumnIn(src, df);
        base = col ? (cleanNamePart(col) + L.suffix) : L.none;
      }
    }
    if (!base) base = L.none;
    return uniqueColName(base, df);
  }

  /**
   * 光标前是否存在「未闭合且参数为空」的函数调用（round(| 或 round( 结尾）
   * @returns {{name:string, at:number}|null} at = '(' 的下标
   */
  function openCallBefore(src, caret) {
    var prefix = String(src === undefined || src === null ? '' : src).slice(0, caret);
    var depth = 0, i, ch, j, nm, isFn;
    for (i = prefix.length - 1; i >= 0; i--) {
      ch = prefix.charAt(i);
      if (ch === ')') { depth++; continue; }
      if (ch !== '(') continue;
      if (depth > 0) { depth--; continue; }
      j = i;
      while (j > 0 && /[A-Za-z0-9_$.]/.test(prefix.charAt(j - 1))) j--;
      nm = prefix.slice(j, i);
      isFn = (T.EXPR_FUNCS[nm] !== undefined) || /^Math\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(nm);
      if (!isFn) return null;
      if (prefix.slice(i + 1).trim()) return null;    /* 括号里已有内容 → 普通插入 */
      return { name: nm, at: i };
    }
    return null;
  }
  /** 菜单定位：有鼠标事件用其坐标；否则锚定该参数的表头 / 参数行；再兜底默认位置 */
  function menuPos(evt, colName) {
    if (evt && evt.clientX !== undefined && evt.clientY !== undefined) return { x: evt.clientX, y: evt.clientY };
    var anchor = null;
    try {
      var sel = String(colName === undefined || colName === null ? '' : colName).replace(/"/g, '\\"');
      anchor = U.$('#raw-header-list .raw-item[data-col="' + sel + '"]') || U.$('#grid-wrap th[data-col="' + sel + '"]');
    } catch (e) { anchor = null; }
    if (anchor && anchor.getBoundingClientRect) {
      var r = anchor.getBoundingClientRect();
      if (r && (r.left || r.top)) return { x: Math.round(r.left + 12), y: Math.round(r.top + 12) };
    }
    return { x: 420, y: 180 };
  }

  /** 修改数据格式的菜单项：char / int / float / time（time → 自动 / 日期 / 时间 / 日期时间） */
  function formatMenuItems(colName) {
    return FORMATS.map(function (f) {
      if (f.value === 'time') {
        return {
          label: '时间 time', submenu: TIME_STYLES.map(function (s) {
            return { label: s.label, onClick: function () { applyFormat(colName, 'time', s.value); } };
          })
        };
      }
      return { label: f.cn + ' ' + f.value, onClick: function () { applyFormat(colName, f.value, null); } };
    });
  }

  /** 填充缺失值的菜单项：均值 / 中位数 / 0 / 前一行 / 固定…（固定值 → 原地输入行） */
  function fillMenuItems(colName) {
    var df = Store.state.df, ci = df ? df.colIndex(colName) : -1;
    var c = (df && ci >= 0) ? df.cols[ci] : null;
    var isStr = !!(c && c.type === T.STRING);
    var st = (c && !isStr) ? df.stats(ci) : null;
    return FILL_METHODS.map(function (f) {
      var blocked = isStr && (f.value === 'mean' || f.value === 'median' || f.value === 'zero');
      if (f.value === 'fixed') {
        return {
          label: '固定值…',
          input: {
            placeholder: isStr ? '文本' : (c && c.type === T.TIME ? 'yyyy-MM-dd HH:mm:ss' : '数值'),
            okText: '确定',
            onConfirm: function (v) { applyFill(colName, 'fixed', v); }
          }
        };
      }
      var extra = '';
      if (!blocked && st) {
        if (f.value === 'mean' && st.mean !== null) extra = '（' + fmt4(st.mean) + '）';
        if (f.value === 'median' && st.median !== null) extra = '（' + fmt4(st.median) + '）';
      }
      return { label: f.label + extra, disabled: blocked, onClick: function () { applyFill(colName, f.value, null); } };
    });
  }

  /** 执行类型转换（菜单 / 公开 API 共用；无弹窗） */
  function applyFormat(colName, target, timeStyle) {
    try {
      var df = Store.state.df;
      if (!df) { U.toast('尚未载入数据', 'warn'); return null; }
      var ci = df.colIndex(colName);
      if (ci < 0) { U.toast('参数不存在：' + colName, 'warn'); return null; }
      var res = convertColumn(df, ci, target, timeStyle);
      if (!res.ok) { U.toast('格式转换失败：' + res.error, 'error'); return null; }
      df.cols[ci] = new YMS.Column(res.col.name, res.col.type, res.col.values, res.col.dict, res.col.timeStyle);
      df.refreshMissing();
      if (target === 'int') setDecimals(colName, 0);
      Store.replaceDataFrame(df);
      var label = (FORMATS.filter(function (f) { return f.value === target; })[0] || {}).cn || target;
      var extra = res.addedMissing > 0 ? '，新增 ' + U.fmtInt(res.addedMissing) + ' 个缺失值' : '';
      Store.addNote('列操作：' + colName + ' → ' + label +
        (target === 'time' ? '（' + (res.col.timeStyle || 'datetime') + '）' : '') + extra);
      U.toast('「' + esc(colName) + '」已转换为 ' + label + extra, 'ok');
      return res;
    } catch (err) {
      if (global.console) global.console.error('[YMS.ColumnOps] 格式转换失败', err);
      U.toast('修改数据格式失败：' + err.message, 'error');
      return null;
    }
  }

  /** 执行填充缺失（菜单 / 公开 API 共用；写数据后 notifyDataValuesChanged） */
  function applyFill(colName, method, fixedValue) {
    try {
      var df = Store.state.df;
      if (!df) { U.toast('尚未载入数据', 'warn'); return null; }
      var ci = df.colIndex(colName);
      if (ci < 0) { U.toast('参数不存在：' + colName, 'warn'); return null; }
      var res = fillMissingOnDf(df, ci, method, fixedValue);
      if (!res.ok) { U.toast('填充失败：' + res.error, 'error'); return null; }
      Store.notifyDataValuesChanged();
      Store.addNote('填充缺失值：' + colName + ' ← ' + res.text);
      U.toast(res.text, 'ok');
      return res;
    } catch (err) {
      if (global.console) global.console.error('[YMS.ColumnOps] 填充缺失失败', err);
      U.toast('填充缺失值失败：' + err.message, 'error');
      return null;
    }
  }

  /** 执行表达式新建列（opts.silent = true 时由调用方自己 toast，如表达式对话框） */
  function applyCompute(expr, name, fill, opts) {
    try {
      opts = opts || {};
      var df = Store.state.df;
      if (!df) { U.toast('尚未载入数据', 'warn'); return null; }
      var nm = String(name === undefined || name === null ? '' : name).trim();
      if (!nm) { U.toast('新列名不能为空', 'error'); return null; }
      if (df.colIndex(nm) >= 0) { U.toast(YMS.colNames.taken(nm), 'error'); return null; }
      var f = (fill === '0' || fill === '1') ? fill : 'keep';
      var res = computeSeries(df, expr, f);
      if (!res.ok) { U.toast('数据计算失败：' + res.error, 'error'); return null; }
      df.addColumn({ name: nm, type: T.NUMBER, values: res.values });
      Store.replaceDataFrame(df);
      var extra = res.filled ? '（' + (f === '0' ? '0' : '1') + ' 填充 ' + U.fmtInt(res.missing) + ' 个缺失值）'
        : (res.missing ? '（' + U.fmtInt(res.missing) + ' 个缺失值保留为 NaN）' : '');
      if (res.nonFinite) extra += '（' + U.fmtInt(res.nonFinite) + ' 行结果非有限值，已按缺失处理）';
      Store.addNote('数据计算：新建列 ' + nm + ' = ' + expr + extra);
      if (!opts.silent) U.toast('已新建参数「' + esc(nm) + '」' + extra, 'ok');
      return { name: nm, missing: res.missing, filled: res.filled === true };
    } catch (err) {
      if (global.console) global.console.error('[YMS.ColumnOps] 数据计算失败', err);
      U.toast('数据计算失败：' + err.message, 'error');
      return null;
    }
  }

  /** 执行重命名（同步 decimals / sorters / filters / plot 引用） */
  function applyRename(colName, newName) {
    try {
      var df = Store.state.df;
      if (!df) { U.toast('尚未载入数据', 'warn'); return null; }
      if (df.colIndex(colName) < 0) { U.toast('参数不存在：' + colName, 'warn'); return null; }
      var nm = String(newName === undefined || newName === null ? '' : newName).trim();
      if (!nm) { U.toast('新名称不能为空', 'error'); return null; }
      if (nm === colName) return null;
      if (df.colIndex(nm) >= 0) { U.toast(YMS.colNames.taken(nm), 'error'); return null; }
      if (!df.renameColumn(colName, nm)) { U.toast(df.lastRenameError || '重命名失败', 'error'); return null; }
      syncRename(colName, nm);
      Store.replaceDataFrame(df);
      Store.addNote('重命名：' + colName + ' → ' + nm);
      U.toast('已重命名「' + esc(colName) + '」→「' + esc(nm) + '」', 'ok');
      return nm;
    } catch (err) {
      if (global.console) global.console.error('[YMS.ColumnOps] 重命名失败', err);
      U.toast('重命名失败：' + err.message, 'error');
      return null;
    }
  }

  /* ==========================================================================
     表达式对话框（迭代 16 建立 / 迭代 19 重构）
     —— 居中弹层：表达式 / 新列名（按表达式自动命名）/ 缺失值处理 / 可用列 chips /
        实时预览 + 显式「预览」按钮 / 语法提示 / 内嵌函数库（横向 TAB）
     迭代 19：删除独立「函数与语法说明」面板与入口按钮，说明改为本页下方内嵌
     ========================================================================== */
  var FILL_OPTIONS = [
    { value: 'keep', label: '保留缺失', note: '缺失参与运算 → 结果仍缺失' },
    { value: '0', label: '补齐为 0', note: '结果缺失时填 0' },
    { value: '1', label: '补齐为 1', note: '结果缺失时填 1' }
  ];

  var _exprDlg = null;          // 当前打开的对话框（同一时刻最多一个）

  /** 关闭表达式对话框（未打开时返回 false） */
  function closeComputeDialog() {
    var d = _exprDlg;
    if (!d) return false;
    _exprDlg = null;
    if (d.clearTimer) d.clearTimer();
    if (typeof document !== 'undefined') document.removeEventListener('keydown', d.onKey, true);
    if (d.mask && d.mask.parentNode) d.mask.parentNode.removeChild(d.mask);
    return true;
  }
  function isComputeDialogOpen() { return !!_exprDlg; }

  /** 列名在表达式里的写法：合法标识符直接写，否则 col('名称') */
  function exprRef(name) {
    var n = String(name === undefined || name === null ? '' : name);
    if (IDENT_RE.test(n) && !RESERVED[n] && n !== 'col' && n !== 'Math' && T.EXPR_FUNCS[n] === undefined) return n;
    return "col('" + n.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "')";
  }

  /** 在光标处替换/插入文本（返回新光标位置；列名 chip / 函数 / 示例共用） */
  function spliceAtCaret(ta, text, caretOffset) {
    var v = String(ta.value || '');
    var s = ta.selectionStart, e = ta.selectionEnd;
    if (s === undefined || s === null) s = v.length;
    if (e === undefined || e === null) e = s;
    ta.value = v.slice(0, s) + text + v.slice(e);
    var pos = s + (caretOffset === undefined ? text.length : caretOffset);
    try { ta.focus(); ta.setSelectionRange(pos, pos); } catch (err) { /* 无选区能力时忽略 */ }
    return { start: s, end: e, caret: pos };
  }

  /**
   * 打开「数据计算（表达式新建列）」对话框
   * @param {string} [colName] 发起计算的列（仅用于提示文案，缺失值处理按整表布尔运算）
   * @param {string} [presetExpr] 预填表达式（示例面板「填入表达式」用）
   * @param {string} [presetFill] 预选缺失处理 'keep' | '0' | '1'
   * @param {{focusLib:boolean}} [opts] focusLib = 函数库滚到可见并聚焦第一张卡片（右键 ⓘ 入口）
   */
  function openComputeDialog(colName, presetExpr, presetFill, opts) {
    opts = opts || {};
    U.closeContextMenu();                                  // 打开弹层前先关右键菜单（不留残影）
    var df = Store.state.df;
    if (!df || !df.rowCount) { U.toast('尚未载入数据', 'warn'); return null; }
    if (typeof document === 'undefined' || !document.createElement) return null;
    var root = U.$('#modal-root');
    if (!root) return null;                                // 无浮层容器（Node 自测）

    closeComputeDialog();                                  // 只保留一个
    var fill = (presetFill === '0' || presetFill === '1') ? presetFill : 'keep';
    var timer = null, flashTimer = null;
    var manualName = false;                                // 用户手改过新列名 → 停止自动覆盖
    var libHandle = null;                                  // 内嵌函数库句柄

    /* ---------------- 控件 ---------------- */
    var mask = el('div', { class: 'expr-mask' });
    var box = el('div', { class: 'expr-dialog' });
    var ta = el('textarea', {
      id: 'expr-input', class: 'expr-input', rows: '3', spellcheck: 'false',
      placeholder: "例：round(Yield * 100, 2)"
    });
    var nameEl = el('input', {
      id: 'expr-name', class: 'expr-name', type: 'text',
      title: '默认按「函数名(列名)」自动命名；手动输入后不再被覆盖'
    });
    nameEl.value = autoColumnName('', df);
    var nameErr = el('div', { id: 'expr-name-err', class: 'expr-name-err' });
    var prev = el('div', { id: 'expr-preview', class: 'expr-preview' });

    /* 缺失值处理（单选） */
    var fillWrap = el('div', { class: 'expr-fills' });
    var fillInputs = {};
    FILL_OPTIONS.forEach(function (o) {
      var rid = 'expr-fill-' + o.value;
      var rb = el('input', { type: 'radio', name: 'expr-fill', id: rid, value: o.value });
      var lab = el('label', { class: 'expr-fill', 'for': rid, title: o.note }, [
        rb, el('span', { class: 'expr-fill-t', text: o.label })
      ]);
      rb.addEventListener('change', function () {
        if (!rb.checked) return;
        fill = o.value;
        schedulePreview(0);                                // 缺失处理影响预览里的「缺失」显示
      });
      fillInputs[o.value] = rb;
      fillWrap.appendChild(lab);
    });
    fillInputs[fill].checked = true;

    /* 可用列 chips（点一下把列名插入到光标处；非标识符用 col('…')） */
    var colsWrap = el('div', { id: 'expr-cols', class: 'expr-cols' });
    df.colNames().forEach(function (n) {
      var ref = exprRef(n);
      var chip = el('button', {
        type: 'button',
        class: 'expr-col' + (ref === n ? '' : ' expr-col-quoted'),
        'data-col': n,
        title: ref === n ? ('插入列 ' + n) : ('含空格 / 特殊字符 → 插入 ' + ref),
        text: n
      });
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        insertColumnRef(n);                            // 有未闭合函数调用 → 作用到该函数上并补 ')'
      });
      colsWrap.appendChild(chip);
    });

    /* 语法提示（迭代 19：独立「函数与语法说明」按钮已移除，说明内嵌到下方函数库） */
    var hint = el('div', {
      class: 'expr-hint',
      html: "列名直接写（如 <code>Yield</code>）；含空格或特殊字符用 <code>col('名称')</code>；" +
        "支持 <code>+ - * / % **</code>、比较 <code>&gt; &lt; &gt;= &lt;=</code> 与三元 <code>a ? b : c</code>；" +
        "下方函数库可点选函数与示例"
    });
    /* 迭代 24：语句块模式提示（单独一行，整句进词库，英文模式下不残留） */
    var flowHint = el('div', {
      class: 'expr-hint expr-hint-flow',
      text: '支持语句块（if / for / while / let / return）；语句块需以 return 返回结果，可用 __i（行号）、__n（总行数）'
    });

    var previewBtn = el('button', {
      id: 'expr-preview-btn', class: 'btn expr-preview-btn', type: 'button', text: '预览',
      title: '计算前 5 行并校验表达式（Ctrl+Enter 直接确定）'
    });
    var okBtn = el('button', { id: 'expr-ok', class: 'btn btn-primary', type: 'button', text: '确定', disabled: true });
    var cancelBtn = el('button', { id: 'expr-cancel', class: 'btn', type: 'button', text: '取消' });

    var closeBtn = el('button', { class: 'expr-x', type: 'button', title: '关闭 (Esc)', text: '✕' });
    var head = el('div', { class: 'expr-head' }, [
      el('span', { class: 'expr-title', text: '数据计算（表达式新建列）' + (colName ? ' · ' + colName : '') }),
      closeBtn
    ]);
    var body = el('div', { class: 'expr-body' });
    var foot = el('div', { class: 'expr-foot' }, [previewBtn, cancelBtn, okBtn]);
    box.appendChild(head); box.appendChild(body); box.appendChild(foot);
    mask.appendChild(box);

    function field(labelText, node) {
      var f = el('div', { class: 'expr-field' });
      f.appendChild(el('span', { class: 'expr-label', text: labelText }));
      var ctl = el('div', { class: 'expr-ctl' }, [node]);
      f.appendChild(ctl);
      return f;
    }
    body.appendChild(field('表达式', ta));
    var nameField = field('新列名', nameEl);
    nameField.appendChild(nameErr);
    body.appendChild(nameField);
    body.appendChild(field('缺失值处理', fillWrap));
    body.appendChild(field('可用列', colsWrap));
    body.appendChild(field('实时预览', prev));
    body.appendChild(hint);
    body.appendChild(flowHint);
    /* 内嵌函数库（迭代 19）：位于语法提示下方、占对话框下半部，可滚动 */
    var libWrap = el('div', { id: 'expr-lib', class: 'expr-lib' });
    body.appendChild(libWrap);

    /* 横向 TAB + 卡片：点函数 → 插入 func()；点示例 → 回填表达式 */
    libHandle = (YMS.ExprHelp && YMS.ExprHelp.renderLibrary)
      ? YMS.ExprHelp.renderLibrary(libWrap, {
        onInsertFn: function (item) { insertFnToken(item); },
        onInsertExample: function (text) { setExpr(text); }
      })
      : null;

    /* ---------------- 新列名自动命名 ---------------- */
    /** 依据当前表达式写默认新列名（用户手改过就不再覆盖） */
    function applyAutoName() {
      if (manualName) return;
      nameEl.value = autoColumnName(ta.value, df);
    }

    /* ---------------- 插入：函数 / 列 ---------------- */
    /** 点函数卡片：有选中文本 → 包裹成 f(选中)；否则插入 f() 且光标落在括号内 */
    function insertFnToken(item) {
      var tok = String((item && (item.insert || item.usage)) || '');
      if (!tok) return;
      var isCall = /\(\)$/.test(tok);
      var head = isCall ? tok.slice(0, -2) : tok;
      var v = String(ta.value || '');
      var s = ta.selectionStart, e = ta.selectionEnd;
      if (s === undefined || s === null) s = v.length;
      if (e === undefined || e === null) e = s;
      var sel = v.slice(s, e);
      var text, caret;
      if (isCall && sel) { text = head + '(' + sel + ')'; caret = text.length; }
      else if (isCall) { text = head + '()'; caret = head.length + 1; }
      else { text = tok; caret = tok.length; }
      spliceAtCaret(ta, text, caret);
      applyAutoName();
      onInput();
    }

    /**
     * 点可用列 chip：若光标前是「未闭合且参数为空」的函数调用（round( ）→
     * 把列名放进括号并补一个 ')'（形成 round(Yield)）；否则按原行为插入列名 / col('…')
     */
    function insertColumnRef(name) {
      var ref = exprRef(name);
      var v = String(ta.value || '');
      var s = ta.selectionStart, e = ta.selectionEnd;
      if (s === undefined || s === null) s = v.length;
      if (e === undefined || e === null) e = s;
      var open = (s === e) ? openCallBefore(v, s) : null;
      if (open) {
        var needClose = v.charAt(s) !== ')';           /* 括号内右侧没有 ')' → 补一个 */
        spliceAtCaret(ta, ref + (needClose ? ')' : ''), ref.length);
      } else {
        spliceAtCaret(ta, ref, ref.length);
      }
      applyAutoName();
      onInput();
    }

    /* ---------------- 校验 / 预览 / 提交 ---------------- */
    function validate() {
      var src = String(ta.value || '').trim();
      var err = '';
      if (!src) err = '请输入表达式';
      else {
        var built = buildExpr(src, df.colNames());
        if (!built.ok) err = built.error;
      }
      var nm = String(nameEl.value || '').trim();
      var nmErr = !nm ? '新列名不能为空' : (df.colIndex(nm) >= 0 ? YMS.colNames.taken(nm) : '');
      return { ok: !err && !nmErr, expr: src, name: nm, err: err, nameErr: nmErr };
    }

    function renderPreview() {
      U.clear(prev);
      var src = String(ta.value || '').trim();
      if (!src) {
        prev.appendChild(el('div', { class: 'expr-prev-empty', text: '输入表达式后显示前 5 行计算结果' }));
        return { ok: false, empty: true, error: '', values: [] };
      }
      var r = previewSeries(df, src, 5);
      if (!r.ok) {
        prev.appendChild(el('div', { class: 'expr-err', text: r.error }));   // 错误只显示在预览区，不阻断编辑
        /* 迭代 24：运行期错误（语句块没 return / 死循环 / 非法访问）同样不该提交 → 禁用确定 */
        okBtn.disabled = true;
        return { ok: false, empty: false, error: r.error, values: [] };
      }
      var wrapP = el('div', { class: 'expr-prev-rows' });
      r.values.forEach(function (v, i) {
        var txt = String(v);
        if (txt === '缺失' && fill !== 'keep') txt = fill;                   // 缺失处理后的预览值
        wrapP.appendChild(el('div', { class: 'expr-prev-row' }, [
          el('span', { class: 'expr-prev-i', text: '#' + (i + 1) }),
          el('span', { class: 'expr-prev-v' + (txt === '缺失' ? ' is-missing' : ''), text: txt })
        ]));
      });
      prev.appendChild(wrapP);
      /* 预览成功 → 确定按钮的可用性回到「表达式编译 + 列名校验」的结论 */
      okBtn.disabled = !validate().ok;
      return { ok: true, empty: false, error: '', values: r.values };
    }

    /** 「预览」按钮：显式确认入口（空表达式 / 语法错误都给 toast 提醒） */
    function previewNow() {
      var src = String(ta.value || '').trim();
      if (!src) { U.toast('请先输入表达式', 'warn'); return null; }
      var r = renderPreview();
      if (!r.ok) {
        U.toast('表达式有误：' + String(r.error || '').slice(0, 80), 'warn');
        return r;
      }
      U.toast('预览：前 ' + r.values.length + ' 行计算完成', 'info');
      prev.classList.add('is-flash');                                        // 300ms 高亮
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function () {
        flashTimer = null;
        if (prev && prev.classList) prev.classList.remove('is-flash');
      }, 300);
      return r;
    }

    function schedulePreview(delay) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (_exprDlg && _exprDlg.box === box) renderPreview();
      }, delay === undefined ? 200 : delay);                                 // 输入 200ms 防抖
    }

    function onInput() {
      var v = validate();
      nameErr.textContent = v.nameErr;
      okBtn.disabled = !v.ok;                                                // 空 / 语法错误 / 列名冲突 → 禁用确定
      schedulePreview();
    }

    function setExpr(text) {
      ta.value = String(text === undefined || text === null ? '' : text);
      try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e2) { /* 忽略 */ }
      applyAutoName();
      onInput();
    }

    function commit() {
      if (!String(nameEl.value || '').trim()) applyAutoName();               // 清空后未失焦 → 补回自动名
      var v = validate();
      if (!v.ok) { onInput(); U.toast(v.err || v.nameErr, 'error'); return; }
      var r = applyCompute(v.expr, v.name, fill, { silent: true });
      if (!r) { onInput(); return; }                                         // 失败：保留对话框继续编辑
      close();
      /* 报告**结果列**的缺失数：补齐为 0 / 1 后缺失已归零，不能报补齐前的 NaN 数 */
      var cur = Store.state.df;
      var ci2 = cur ? cur.colIndex(v.name) : -1;
      var miss = ci2 >= 0 ? (cur.cols[ci2].missing || 0) : (r.filled ? 0 : r.missing);
      U.toast('新增列 ' + esc(v.name) + '（' + U.fmtInt(cur ? cur.rowCount : 0) + ' 行，缺失 ' + U.fmtInt(miss) + '）', 'ok');
    }

    function close() {
      U.closeContextMenu();                                                  // 收对话框时兜底：菜单不应残留
      closeComputeDialog();
    }
    function onKey(e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      e.preventDefault(); e.stopPropagation();
      close();
    }

    okBtn.addEventListener('click', commit);
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    previewBtn.addEventListener('click', function (e) { e.preventDefault(); previewNow(); });
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    ta.addEventListener('input', function () { applyAutoName(); onInput(); });
    nameEl.addEventListener('input', function () {
      manualName = String(nameEl.value || '').trim() !== '';                // 手改过 → 停止自动覆盖
      onInput();
    });
    nameEl.addEventListener('blur', function () {
      if (!String(nameEl.value || '').trim()) { manualName = false; applyAutoName(); onInput(); }
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    });

    _exprDlg = {
      mask: mask, box: box, ta: ta, nameEl: nameEl, close: close,
      onKey: onKey,
      clearTimer: function () {
        if (timer) { clearTimeout(timer); timer = null; }
        if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      }
    };
    document.addEventListener('keydown', onKey, true);
    root.appendChild(mask);

    if (presetExpr !== undefined && presetExpr !== null && presetExpr !== '') setExpr(presetExpr);
    else { applyAutoName(); onInput(); }
    if (opts.focusLib) {
      /* 右键菜单 ⓘ：函数库滚到可见 + 聚焦第一张函数卡片 */
      try { if (libWrap.scrollIntoView) libWrap.scrollIntoView({ block: 'nearest' }); } catch (e3) { /* 忽略 */ }
      if (libHandle) libHandle.focusFirstCard();
      else { try { ta.focus(); } catch (e5) { /* 忽略 */ } }
    } else {
      try { ta.focus(); } catch (e4) { /* 忽略 */ }
    }
    return _exprDlg;
  }

  /* ==========================================================================
     右键菜单
     ========================================================================== */
  var ColumnOps = {
    FILL_METHODS: FILL_METHODS,
    FORMATS: FORMATS,
    TIME_STYLES: TIME_STYLES,

    /**
     * 显示列右键菜单（原始表格区 / 数据表头共用）
     * 选择类操作一律在菜单内原地展开（子菜单 / 输入行），不再弹出对话框。
     * @param {MouseEvent} evt 右键事件（可取 clientX/clientY）
     * @param {string} colName 列名
     */
    contextMenu: function (evt, colName) {
      try {
        var df = Store.state.df;
        if (!df) { U.toast('尚未载入数据', 'warn'); return; }
        var ci = df.colIndex(colName);
        if (ci < 0) { U.toast('参数不存在：' + colName, 'warn'); return; }
        var c = df.cols[ci];
        var miss = c.missing || 0;
        var uniq = c.type === T.STRING && c.dict ? c.dict.length : null;
        var p = menuPos(evt, colName);

        U.contextMenu(p.x, p.y, [
          { label: '参数属性', sub: typeLabel(c.type), title: '查看类型 / 有效值 / 缺失 / 唯一值 / 统计量', onClick: function () { ColumnOps.showProperties(colName); } },
          { label: '修改数据格式', submenu: formatMenuItems(colName) },
          {
            label: '数据计算（表达式新建列）', sub: '新建列',
            infoTitle: '函数与语法说明',
            info: function () { ColumnOps.showExprHelp(colName); },
            onClick: function () { ColumnOps.openComputeDialog(colName); }
          },
          {
            /* 迭代 25：按值分组 —— 把本列的离散值映射成用户定义的组名，产出派生列 */
            label: c.groupMap ? '修改分组映射…' : '分组映射…',
            sub: c.groupMap ? (c.groupMap.sourceCol + ' → ' + c.name) : '新建列',
            title: '把本列的不同取值归并成组（如 T01~T04 → 清洗），组顺序即横轴顺序',
            onClick: function () { YMS.GroupUI.openFor(colName); }
          },
          {
            label: '填充缺失值', disabled: !miss,
            sub: miss ? '缺 ' + U.fmtInt(miss) : '无缺失',
            submenu: fillMenuItems(colName)
          },
          {
            label: '按此列去重', sub: uniq === null ? '保留首行' : U.fmtInt(uniq) + ' 个取值',
            title: '保留每个取值的首行（会删除数据，需二次确认）',
            onClick: function () { ColumnOps.dedupeBy(colName); }
          },
          '-',
          {
            label: '重命名', sub: colName,
            input: {
              placeholder: '新列名', value: colName, okText: '确定',
              onConfirm: function (v) { applyRename(colName, v); }
            }
          },
          {
            label: '删除列', disabled: df.cols.length <= 1,
            sub: df.cols.length <= 1 ? '至少保留一列' : '不可恢复',
            onClick: function () { ColumnOps.deleteColumn(colName); }
          }
        ]);
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] contextMenu 失败', err);
        U.toast('无法打开列菜单：' + err.message, 'error');
      }
    },

    /** 参数属性：类型 / 有效值 / 缺失 / 唯一值 / Min / Max / Mean / Median / StdDev */
    showProperties: function (colName) {
      try {
        U.closeContextMenu();                            // 弹层前先关菜单
        var df = Store.state.df;
        if (!df) { U.toast('尚未载入数据', 'warn'); return; }
        var ci = df.colIndex(colName);
        if (ci < 0) { U.toast('参数不存在：' + colName, 'warn'); return; }
        var c = df.cols[ci];
        var st = df.stats(ci);
        var ds = Store.state.dataSettings;
        var rows = statsRows(st, { decimals: ds.decimals ? ds.decimals[colName] : null, timeStyle: c.timeStyle });
        var html = ['<table class="prop-table"><tbody>'];
        rows.forEach(function (r) {
          html.push('<tr><th>' + esc(r[0]) + '</th><td class="num">' + esc(r[1]) + '</td></tr>');
        });
        html.push('</tbody></table>');
        html.push('<div class="hint-inline mt6">标准差为总体标准差（分母 N）；唯一值在有效值 &gt; 200 万时跳过统计。</div>');
        U.modal({ title: '参数属性 · ' + colName, bodyHTML: html.join(''), width: 'wide', footer: [{ text: '关闭', cls: 'btn-primary' }] });
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] showProperties 失败', err);
        U.toast('属性统计失败：' + err.message, 'error');
      }
    },

    /* ------------------------------------------------------------------ 修改格式 */
    /**
     * 修改数据格式：菜单内原地选择 char / int / float / time（time → 自动 / 日期 / 时间 / 日期时间）
     * @param {string} colName 列名
     * @param {MouseEvent} [evt] 可选：菜单定位（缺省时锚定该参数的表头 / 参数行）
     */
    changeFormat: function (colName, evt) {
      try {
        var df = Store.state.df;
        if (!df) { U.toast('尚未载入数据', 'warn'); return; }
        if (df.colIndex(colName) < 0) { U.toast('参数不存在：' + colName, 'warn'); return; }
        var p = menuPos(evt, colName);
        U.contextMenu(p.x, p.y, formatMenuItems(colName));
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] changeFormat 失败', err);
        U.toast('修改数据格式失败：' + err.message, 'error');
      }
    },

    /* ------------------------------------------------------------------ 数据计算 */
    /**
     * 数据计算：打开居中对话框（表达式 / 新列名 / 缺失值处理 / 可用列 / 实时预览）
     * @param {string|MouseEvent} [a] 列名（提示用）或事件
     * @param {MouseEvent} [b] 事件（兼容旧签名）
     */
    computeColumn: function (a, b) {
      try {
        var colName = (typeof a === 'string') ? a : (typeof b === 'string' ? b : null);
        return openComputeDialog(colName);
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] computeColumn 失败', err);
        U.toast('数据计算失败：' + err.message, 'error');
        return null;
      }
    },

    /** 打开表达式对话框（右键菜单「数据计算」项的主动作） */
    openComputeDialog: openComputeDialog,
    /** 关闭表达式对话框（未被打开时静默返回） */
    closeComputeDialog: closeComputeDialog,
    /** 表达式对话框是否打开（自测 / 互斥判断用） */
    isComputeDialogOpen: isComputeDialogOpen,

    /**
     * 右键菜单 ⓘ（迭代 19）：直接打开「数据计算」对话框并把内嵌函数库滚到可见、
     * 聚焦第一张函数卡片（不再有独立说明面板）
     * @param {string} [colName] 发起计算的列（仅用于标题提示）
     */
    showExprHelp: function (colName) {
      try {
        U.closeContextMenu();
        return openComputeDialog(typeof colName === 'string' ? colName : null, null, null, { focusLib: true });
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] showExprHelp 失败', err);
        U.toast('函数说明打开失败：' + err.message, 'error');
        return null;
      }
    },

    /* ------------------------------------------------------------------ 填充缺失 */
    /**
     * 填充缺失值：菜单内原地选择 均值 / 中位数 / 0 / 前一行 / 固定值（固定值 → 原地输入行）
     * 写回数据，完成后该列 missing === 0。
     * @param {string} colName
     * @param {MouseEvent} [evt] 可选：菜单定位
     */
    fillMissing: function (colName, evt) {
      try {
        var df = Store.state.df;
        if (!df) { U.toast('尚未载入数据', 'warn'); return null; }
        var ci = df.colIndex(colName);
        if (ci < 0) { U.toast('参数不存在：' + colName, 'warn'); return null; }
        if (!(df.cols[ci].missing || 0)) { U.toast('「' + esc(colName) + '」没有缺失值', 'warn'); return null; }
        var p = menuPos(evt, colName);
        U.contextMenu(p.x, p.y, fillMenuItems(colName));
        return null;
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] fillMissing 失败', err);
        U.toast('填充缺失值失败：' + err.message, 'error');
        return null;
      }
    },

    /* ------------------------------------------------------------------ 去重 */
    /** 按本列去重（保留首行，二次确认） */
    dedupeBy: function (colName) {
      U.closeContextMenu();                              // 确认框前先关菜单
      var df = Store.state.df;
      if (!df) { U.toast('尚未载入数据', 'warn'); return; }
      var res = dedupeDf(df, colName);
      if (!res.ok) { U.toast(res.error, 'error'); return; }
      if (!res.changed) { U.toast('「' + esc(colName) + '」没有重复取值，未做修改', 'warn'); return; }
      U.confirm({
        title: '按列去重',
        message: '将按「' + esc(colName) + '」保留每个取值的首行：<br>行数 <b>' + U.fmtInt(res.before) +
          '</b> → <b>' + U.fmtInt(res.after) + '</b>。<br><br>该操作会删除数据且不可恢复，是否继续？',
        okText: '去重'
      }).then(function (yes) {
        if (!yes) return;
        try {
          Store.replaceDataFrame(res.df);
          var txt = '已按「' + esc(colName) + '」去重：' + U.fmtInt(res.before) + ' 行 → ' + U.fmtInt(res.after) + ' 行';
          Store.addNote('去重：按 ' + colName + ' 保留首行，' + U.fmtInt(res.before) + ' → ' + U.fmtInt(res.after) + ' 行');
          U.toast(txt, 'ok');
          U.setStatus(txt, 'ok');
        } catch (err) {
          if (global.console) global.console.error('[YMS.ColumnOps] dedupeBy 失败', err);
          U.toast('去重失败：' + err.message, 'error');
        }
      })['catch'](function (err) {
        /* 无 DOM 容器（如 Node 自测）时 confirm 对话框无法创建：静默降级，绝不抛未捕获异常 */
        if (global.console) global.console.error('[YMS.ColumnOps] 去重确认框不可用', err);
      });
    },

    /* ------------------------------------------------------------------ 重命名 */
    /**
     * 重命名：菜单内原地一行 [新列名][确定][取消]
     * 同步 decimals / sorters / filters / plot 引用。
     * @param {string} colName
     * @param {MouseEvent} [evt] 可选：菜单定位
     */
    renameColumn: function (colName, evt) {
      try {
        var df = Store.state.df;
        if (!df) { U.toast('尚未载入数据', 'warn'); return; }
        if (df.colIndex(colName) < 0) { U.toast('参数不存在：' + colName, 'warn'); return; }
        var p = menuPos(evt, colName);
        U.contextMenu(p.x, p.y, [{
          label: '重命名 · ' + colName,
          input: {
            placeholder: '新列名', value: colName, okText: '确定', open: true,
            onConfirm: function (v) { applyRename(colName, v); }
          }
        }]);
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] renameColumn 失败', err);
        U.toast('重命名失败：' + err.message, 'error');
      }
    },

    /* ------------------------------------------------------------------ 删除列 */
    /** 删除列（二次确认） */
    deleteColumn: function (colName) {
      U.closeContextMenu();                              // 确认框前先关菜单
      var df = Store.state.df;
      if (!df) { U.toast('尚未载入数据', 'warn'); return; }
      var ci = df.colIndex(colName);
      if (ci < 0) { U.toast('参数不存在：' + colName, 'warn'); return; }
      if (df.cols.length <= 1) { U.toast('至少需要保留一列', 'warn'); return; }
      var c = df.cols[ci];
      U.confirm({
        title: '删除参数',
        message: '确定删除参数「' + esc(colName) + '」？<br>' + esc(T.TYPE_CN[c.type] || c.type) + '列 · ' +
          U.fmtInt(df.rowCount) + ' 行' + (c.missing ? ' · 缺失 ' + U.fmtInt(c.missing) : '') +
          '<br><br>该列数据将被永久删除（不可恢复），相关的排序 / 筛选 / 绘图引用会一并移除。',
        okText: '删除'
      }).then(function (yes) {
        if (!yes) return;
        try {
          df.removeColumn(colName);
          dropFromSettings(colName);
          Store.replaceDataFrame(df);
          Store.addNote('删除列：' + colName);
          U.toast('已删除参数「' + esc(colName) + '」', 'ok');
        } catch (err) {
          if (global.console) global.console.error('[YMS.ColumnOps] deleteColumn 失败', err);
          U.toast('删除失败：' + err.message, 'error');
        }
      })['catch'](function (err) {
        /* 无 DOM 容器（如 Node 自测）时 confirm 对话框无法创建：静默降级，绝不抛未捕获异常 */
        if (global.console) global.console.error('[YMS.ColumnOps] 删除确认框不可用', err);
      });
    },

    /* ======================================================================
       编程入口（无对话框 / 无二次确认）—— 供 app.js 的 window.__YMS__ 验收接口调用，
       行为与对应的交互入口完全一致，只是跳过 UI 与确认步骤。
       ====================================================================== */

    /** 表达式新建列：computeColumnProgrammatic(name, expr, fill) */
    computeColumnProgrammatic: function (name, expr, fill) {
      try {
        var df = Store.state.df;
        if (!df) return { ok: false, error: '尚未载入数据' };
        var nm = String(name === undefined || name === null ? '' : name).trim();
        if (!nm) return { ok: false, error: '新列名不能为空' };
        if (df.colIndex(nm) >= 0) return { ok: false, error: YMS.colNames.taken(nm) };
        var f = (fill === '0' || fill === 0) ? '0' : ((fill === '1' || fill === 1) ? '1' : 'keep');
        var res = computeSeries(df, expr, f);
        if (!res.ok) return res;
        df.addColumn({ name: nm, type: T.NUMBER, values: res.values });
        Store.replaceDataFrame(df);
        var nfNote = res.nonFinite ? '（' + U.fmtInt(res.nonFinite) + ' 行结果非有限值，已按缺失处理）' : '';
        Store.addNote('数据计算：新建列 ' + nm + ' = ' + String(expr) + nfNote);
        return { ok: true, name: nm, index: df.colIndex(nm), expr: String(expr), missing: res.missing,
                 nonFinite: res.nonFinite || 0, note: nfNote, filled: res.filled === true };
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] computeColumnProgrammatic 失败', err);
        return { ok: false, error: err.message };
      }
    },

    /** 填充缺失：fillMissingProgrammatic(col, method, value) */
    fillMissingProgrammatic: function (col, method, value) {
      try {
        var df = Store.state.df;
        if (!df) return { ok: false, error: '尚未载入数据' };
        var ci = df.colIndex(col);
        if (ci < 0) return { ok: false, error: '参数不存在：' + col };
        var res = fillMissingOnDf(df, ci, method, value);
        if (!res.ok) return res;
        Store.notifyDataValuesChanged();
        Store.addNote('填充缺失值：' + col + ' ← ' + res.text);
        return { ok: true, col: col, method: method, filled: res.filled, missing: res.after, value: res.value, text: res.text };
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] fillMissingProgrammatic 失败', err);
        return { ok: false, error: err.message };
      }
    },

    /** 修改数据格式：convertTypeProgrammatic(col, type, timeStyle)（type: char/int/float/time） */
    convertTypeProgrammatic: function (col, type, timeStyle) {
      try {
        var df = Store.state.df;
        if (!df) return { ok: false, error: '尚未载入数据' };
        var ci = df.colIndex(col);
        if (ci < 0) return { ok: false, error: '参数不存在：' + col };
        var target = String(type || '');
        if (target === 'string') target = 'char';
        else if (target === 'number') target = 'float';
        if (['char', 'int', 'float', 'time'].indexOf(target) < 0) return { ok: false, error: '不支持的目标格式：' + type };
        var res = convertColumn(df, ci, target, timeStyle);
        if (!res.ok) return res;
        df.cols[ci] = new YMS.Column(res.col.name, res.col.type, res.col.values, res.col.dict, res.col.timeStyle);
        df.refreshMissing();
        if (target === 'int') {
          var dec = {};
          Object.keys(Store.state.dataSettings.decimals || {}).forEach(function (k) { dec[k] = Store.state.dataSettings.decimals[k]; });
          dec[col] = 0;
          Store.applyDataSettings({ decimals: dec });
        }
        Store.replaceDataFrame(df);
        Store.addNote('列操作：' + col + ' → ' + target + (target === 'time' ? '（' + (res.col.timeStyle || 'datetime') + '）' : ''));
        return {
          ok: true, col: col, target: target, type: res.col.type, timeStyle: res.col.timeStyle,
          decimals: res.decimals, addedMissing: res.addedMissing
        };
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] convertTypeProgrammatic 失败', err);
        return { ok: false, error: err.message };
      }
    },

    /** 重命名（含设置同步）：renameColumnProgrammatic(oldName, newName) */
    renameColumnProgrammatic: function (oldName, newName) {
      try {
        var df = Store.state.df;
        if (!df) return { ok: false, error: '尚未载入数据' };
        if (df.colIndex(oldName) < 0) return { ok: false, error: '参数不存在：' + oldName };
        var nm = String(newName === undefined || newName === null ? '' : newName).trim();
        if (!nm) return { ok: false, error: '新名称不能为空' };
        if (nm === oldName) return { ok: true, from: oldName, to: nm, changed: false };
        if (df.colIndex(nm) >= 0) {
          /* M-4：撞名不再静默失败 —— 返回明确错误 + 可见提示 */
          var msg = YMS.colNames.taken(nm);
          U.toast(msg, 'error');
          return { ok: false, error: msg };
        }
        if (!df.renameColumn(oldName, nm)) return { ok: false, error: df.lastRenameError || '重命名失败' };
        syncRename(oldName, nm);
        Store.replaceDataFrame(df);
        Store.addNote('重命名：' + oldName + ' → ' + nm);
        return { ok: true, from: oldName, to: nm, changed: true };
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] renameColumnProgrammatic 失败', err);
        return { ok: false, error: err.message };
      }
    },

    /** 删除列（无二次确认）：deleteColumnProgrammatic(colName) */
    deleteColumnProgrammatic: function (colName) {
      try {
        var df = Store.state.df;
        if (!df) return { ok: false, error: '尚未载入数据' };
        if (df.colIndex(colName) < 0) return { ok: false, error: '参数不存在：' + colName };
        if (df.cols.length <= 1) return { ok: false, error: '至少需要保留一列' };
        df.removeColumn(colName);
        dropFromSettings(colName);
        Store.replaceDataFrame(df);
        Store.addNote('删除列：' + colName);
        return { ok: true, col: colName, colCount: df.cols.length };
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] deleteColumnProgrammatic 失败', err);
        return { ok: false, error: err.message };
      }
    },

    /** 去重（无二次确认）：dedupeByProgrammatic(colName) */
    dedupeByProgrammatic: function (colName) {
      try {
        var df = Store.state.df;
        if (!df) return { ok: false, error: '尚未载入数据' };
        var res = dedupeDf(df, colName);
        if (!res.ok) return res;
        if (!res.changed) return { ok: true, col: colName, before: res.before, after: res.after, changed: false };
        Store.replaceDataFrame(res.df);
        Store.addNote('去重：按 ' + colName + ' 保留首行，' + U.fmtInt(res.before) + ' → ' + U.fmtInt(res.after) + ' 行');
        return { ok: true, col: colName, before: res.before, after: res.after, changed: true };
      } catch (err) {
        if (global.console) global.console.error('[YMS.ColumnOps] dedupeByProgrammatic 失败', err);
        return { ok: false, error: err.message };
      }
    },

    /* ---- 内部纯逻辑导出（Node 自测用，不属公开契约） ---- */
    _buildExpr: buildExpr,
    _previewSeries: previewSeries,
    _computeSeries: computeSeries,
    _autoColumnName: autoColumnName,
    _openCallBefore: openCallBefore,
    _uniqueColName: uniqueColName,
    _fillMissing: fillMissingOnDf,
    _fillText: fillText,
    _convertColumn: convertColumn,
    _dedupe: dedupeDf,
    _syncRename: syncRename,
    _dropFromSettings: dropFromSettings,
    _statsRows: statsRows,
    _exprHelpers: EXPR_HELPERS,
    _rewriteLoops: rewriteLoops,
    _maskSource: maskSource,
    _stmtMode: isStatementSrc,
    _isIdentifier: function (s) { return IDENT_RE.test(String(s)); }
  };

  YMS.ColumnOps = ColumnOps;
})(typeof window !== 'undefined' ? window : this);
