/* ==========================================================================
   YMS · core/types.js
   参数类型体系：number / time / string 的识别、解析、格式化与类型转换
   关键规则（需求书 A 节）：数值列 >90% 可解析为数字 → number；
                            其次 >90% 匹配日期时间模式 → time；否则 string/char
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};

  var NUMBER = 'number', TIME = 'time', STRING = 'string';
  var TYPE_LABEL = { number: 'number', time: 'time', string: 'char' };
  var TYPE_CN = { number: '数值', time: '时间', string: '字符' };

  // 严格数字（允许前后空白、正负号、小数、科学计数法）
  var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  // 日期时间模式
  var RE_DT = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
  var RE_COMPACT = /^(\d{4})(\d{2})(\d{2})$/;                 // 20260901
  var RE_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?Z?$/;
  var RE_TIMEONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;       // 12:30:00

  /** 数值缺失判定（全仓唯一入口 YMS.num.isMissing）：
      缺失 = null / undefined / 非 number 类型 / NaN / ±Infinity
      必须用 !isFinite 而不是 v !== v —— 后者只挡 NaN，Infinity 会一路静默
      传播（统计出 max=∞、图表类别被剔成 null、Excel 写成 #DIV/0!）。 */
  function isMissingNum(v) {
    if (v === null || v === undefined) return true;
    if (typeof v !== 'number') return true;
    return !isFinite(v);
  }

  function parseNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    var s = String(v).trim();
    if (s === '') return NaN;
    if (!NUM_RE.test(s)) return NaN;
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  /* ------------------------------------------------------ 宽松数值解析（M-1）
     机台 / 计量报告里的数值常带单位与缺失记号：95% / N/A / - / 1,234。
     parseLoose 是这类文本的唯一入口（类型推断、导入解析、类型转换都走它）：

       · percent   : '95%' → 0.95，'-12.5%' → -0.125（允许 % 前有空白）
       · thousands : '1,234' / '1,234,567.89' → 1234 / 1234567.89（严格千分位形态）
       · plain     : 普通数字文本（含科学计数法）
       · missing   : 明确缺失记号 / 空串 / 纯空白 / ±Infinity / NaN —— 既不是 0 也不是字符
       · text      : 真文本（abc / 中文 / 日期串），由调用方决定当字符列还是时间列

     注意：'95%' 的显示原文由导入层单独保存在列上的 rawText（原值/计算值分离），
     本函数只负责「计算值」。
     ---------------------------------------------------------------------- */
  var MISSING_TOKENS = {
    'n/a': 1, 'na': 1, 'n.a.': 1, 'n.a': 1, 'null': 1, 'nan': 1,
    'inf': 1, '-inf': 1, '+inf': 1, 'infinity': 1, '-infinity': 1, '+infinity': 1,
    '-': 1, '—': 1, '–': 1                     /* 减号 / 长破折号 / 短破折号 单独出现 = 缺失 */
  };
  var PCT_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*%$/;          /* 95% / -12.5% / 95 % */
  var THOU_RE = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;          /* 1,234 / 1,234,567.89（严格） */

  /**
   * 宽松解析：任意单元格文本 → { value, isMissing, from }
   * @param {*} v
   * @returns {{value:number|null, isMissing:boolean, from:string}}
   *          from ∈ 'percent' | 'thousands' | 'plain' | 'missing' | 'text'
   */
  function parseLoose(v) {
    if (typeof v === 'number') {
      return isFinite(v) ? { value: v, isMissing: false, from: 'plain' }
        : { value: null, isMissing: true, from: 'missing' };      /* NaN / ±Infinity → 缺失 */
    }
    if (v === null || v === undefined) return { value: null, isMissing: true, from: 'missing' };
    var s = String(v).trim();
    if (s === '') return { value: null, isMissing: true, from: 'missing' };
    /* 快路：普通数字（导入的绝大多数单元格）先过，省掉后面的缺失表与百分数/千分位两条正则 */
    if (NUM_RE.test(s)) {
      var n = parseFloat(s);
      return isFinite(n) ? { value: n, isMissing: false, from: 'plain' }
        : { value: null, isMissing: true, from: 'missing' };
    }
    if (s.length <= 12 && MISSING_TOKENS[s.toLowerCase()] === 1) {
      return { value: null, isMissing: true, from: 'missing' };
    }
    var m = PCT_RE.exec(s);
    if (m) {
      var p = parseFloat(m[1]) / 100;
      return isFinite(p) ? { value: p, isMissing: false, from: 'percent' }
        : { value: null, isMissing: true, from: 'missing' };
    }
    if (THOU_RE.test(s)) {
      var t2 = parseFloat(s.replace(/,/g, ''));
      if (isFinite(t2)) return { value: t2, isMissing: false, from: 'thousands' };
    }
    return { value: null, isMissing: false, from: 'text' };        /* 真文本：不是缺失 */
  }

  /** 数值文本的小数位（'1,234.56' → 2；'95' → 0） */
  function digitsOf(txt) {
    var s = String(txt).replace(/,/g, '');
    var dot = s.indexOf('.');
    return dot < 0 ? 0 : Math.max(0, s.length - dot - 1);
  }

  /** 解析日期时间字符串 → epoch ms（本地时区）；失败返回 NaN */
  function parseTime(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    var s = String(v).trim();
    if (s === '') return NaN;
    var m = RE_ISO.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +(m[7] || 0));
    m = RE_DT.exec(s);
    if (m) {
      var d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +(m[7] || 0));
      return d.getTime();
    }
    m = RE_COMPACT.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    m = RE_TIMEONLY.exec(s);
    if (m) return new Date(1970, 0, 1, +m[1], +m[2], +(m[3] || 0)).getTime();
    return NaN;
  }

  /** 判断字符串是否为可识别的日期时间 */
  function isTimeString(s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    return RE_DT.test(t) || RE_COMPACT.test(t) || RE_ISO.test(t) || RE_TIMEONLY.test(t);
  }

  /** Excel 序列号 → epoch ms（1900 日期系统：序列号 ≥61 以 1899-12-30 为基准，含 1900 闰年历史遗留） */
  function excelSerialToMs(n) {
    if (!isFinite(n)) return NaN;
    var base = n < 61 ? 25568 : 25569;   // 25569 = 1899-12-30 到 1970-01-01 的天数
    return Math.round((n - base) * 86400000);
  }
  function msToExcelSerial(ms) {
    return ms / 86400000 + 25569;
  }

  /** 数值 → 时间（自动识别 Excel 序列号 / 秒级时间戳 / 毫秒级时间戳） */
  function numberToTime(n) {
    if (!isFinite(n)) return NaN;
    var a = Math.abs(n);
    if (a >= 20000 && a <= 2958465) return excelSerialToMs(n);       // Excel 序列号（1954-9999）
    if (a >= 1e12 && a <= 3e12) return n;                            // 毫秒时间戳
    if (a >= 1e9 && a < 1e12) return n * 1000;                       // 秒时间戳
    return NaN;
  }

  /** 探测时间显示样式 */
  function detectTimeStyle(sample) {
    if (typeof sample === 'number') return 'datetime';
    var s = String(sample || '').trim();
    if (/^\d{1,2}:\d{2}/.test(s)) return 'time';
    if (/[ T]\d{1,2}:\d{2}/.test(s)) return 'datetime';
    return 'date';
  }

  function formatTime(ms, style) {
    if (ms === null || ms === undefined || isNaN(ms)) return '';
    var d = new Date(ms);
    var date = d.getFullYear() + '-' + YMS.util.pad2(d.getMonth() + 1) + '-' + YMS.util.pad2(d.getDate());
    var time = YMS.util.pad2(d.getHours()) + ':' + YMS.util.pad2(d.getMinutes()) + ':' + YMS.util.pad2(d.getSeconds());
    if (style === 'date') return date;
    if (style === 'time') return time;
    return date + ' ' + time;
  }

  /**
   * 采样推断列类型
   * 分母口径（M-1）：只数「非空且非明确缺失」的样本 —— 'N/A' / '-' / 'NaN' 这类
   * 明确缺失既不计分子也不计分母，10 行里 1 个 N/A + 9 个数字 → 9/9 = 100% → number
   * （该行落缺失）；真文本（abc）仍占分母，会把比例拉低，该判 string 还是 string。
   * @param {Array<string|number>} samples
   * @returns {{type:string, numRatio:number, timeRatio:number, timeStyle:string, decimals:number|null, missingRatio:number}}
   */
  function inferType(samples) {
    var valid = 0, numOk = 0, timeOk = 0, miss = 0, maxDec = 0, firstSample = null, intLike = true;
    for (var i = 0; i < samples.length; i++) {
      var v = samples[i], p = parseLoose(v);
      if (p.isMissing) { miss++; continue; }                 /* 明确缺失 / 空串：不进分母 */
      valid++;
      if (firstSample === null) firstSample = v;
      if (p.value !== null) {
        numOk++;
        if (!Number.isInteger(p.value)) intLike = false;
        /* 小数位按「解析后的数值」量：'95%' → 0.95 → 2 位，不能让整列显示成整数 */
        maxDec = Math.max(maxDec, p.from === 'percent' ? digitsOf(String(p.value)) : digitsOf(String(v)));
      } else if (isTimeString(v)) {
        timeOk++;
      }
    }
    var total = samples.length || 1;
    var numRatio = valid ? numOk / valid : 0;
    var timeRatio = valid ? timeOk / valid : 0;
    var type = STRING, timeStyle = 'datetime', decimals = null;
    if (numRatio > 0.9) {
      type = NUMBER;
      decimals = intLike ? 0 : Math.min(6, maxDec);
      if (decimals === maxDec) { /* 保留原精度 */ }
    } else if (timeRatio > 0.9) {
      type = TIME; timeStyle = detectTimeStyle(firstSample); decimals = null;
    }
    return {
      type: type, numRatio: numRatio, timeRatio: timeRatio, timeStyle: timeStyle,
      decimals: decimals, missingRatio: total ? miss / total : 0
    };
  }

  /**
   * 类型转换源值 → 目标类型值（用于"修改数据格式"）
   * @param {*} v        源值：number | string | null（time 以 epoch ms 的 number 表示）
   * @param {string} from 源类型
   * @param {string} to   目标类型
   * @returns {{value:*, missing:boolean, timeStyle:string|null}}
   */
  function convertValue(v, from, to) {
    var missing = (v === null || v === undefined || (typeof v === 'string' && v.trim() === ''));
    if (missing) return { value: null, missing: true, timeStyle: null };
    if (to === STRING) {
      if (from === TIME) return { value: formatTime(v, 'datetime'), missing: false, timeStyle: null };
      if (from === NUMBER) return { value: YMS.util.fmtNumber(v, null), missing: false, timeStyle: null };
      return { value: String(v), missing: false, timeStyle: null };
    }
    if (to === NUMBER) {
      if (from === NUMBER) return { value: v, missing: false, timeStyle: null };
      if (from === TIME) return { value: v, missing: false, timeStyle: null };          // epoch ms
      var pl = parseLoose(v);                       /* M-1：'95%' → 0.95、'1,234' → 1234 也能转 */
      return pl.value === null ? { value: null, missing: true, timeStyle: null }
        : { value: pl.value, missing: false, timeStyle: null };
    }
    if (to === TIME) {
      if (from === TIME) return { value: v, missing: false, timeStyle: null };
      if (from === NUMBER) {
        var ms = numberToTime(v);
        return isNaN(ms) ? { value: null, missing: true, timeStyle: null } : { value: ms, missing: false, timeStyle: 'datetime' };
      }
      var t = parseTime(v);
      return isNaN(t) ? { value: null, missing: true, timeStyle: null } : { value: t, missing: false, timeStyle: detectTimeStyle(String(v)) };
    }
    return { value: String(v), missing: false, timeStyle: null };
  }

  /** 显示值格式化（网格 / 表格 / 报表统一入口） */
  function formatValue(v, type, decimals, timeStyle) {
    /* 只看数值：字符列的字符串不能进 isMissingNum（那里非 number 一律算缺失） */
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return '';
    if (type === TIME) return formatTime(v, timeStyle || 'datetime');
    if (type === NUMBER) {
      if (decimals === 0 && typeof v === 'number') return String(Math.round(v));
      return YMS.util.fmtNumber(v, decimals);
    }
    return String(v);
  }

  /** 供"数据计算"表达式使用的函数表 */
  var EXPR_FUNCS = {
    abs: Math.abs, round: function (x, n) { var p = Math.pow(10, n || 0); return Math.round(x * p) / p; },
    ceil: Math.ceil, floor: Math.floor, sqrt: Math.sqrt, log: Math.log, log10: function (x) { return Math.log(x) / Math.LN10; },
    exp: Math.exp, pow: Math.pow, min: Math.min, max: Math.max, sign: Math.sign,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan
  };

  /* 数值缺失判定的单一入口（语义见 isMissingNum 注释）
     宽松数值解析的单一入口：parseLoose（M-1：95% / N/A / - / 1,234） */
  YMS.num = { isMissing: isMissingNum, parseLoose: parseLoose };

  YMS.types = {
    NUMBER: NUMBER, TIME: TIME, STRING: STRING,
    TYPE_LABEL: TYPE_LABEL, TYPE_CN: TYPE_CN,
    parseNumber: parseNumber, parseLoose: parseLoose, parseTime: parseTime, isTimeString: isTimeString,
    excelSerialToMs: excelSerialToMs, msToExcelSerial: msToExcelSerial, numberToTime: numberToTime,
    detectTimeStyle: detectTimeStyle, formatTime: formatTime, inferType: inferType,
    convertValue: convertValue, formatValue: formatValue, EXPR_FUNCS: EXPR_FUNCS
  };
})(typeof window !== 'undefined' ? window : this);
