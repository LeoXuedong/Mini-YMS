/* ==========================================================================
   YMS · data/csv-parser.js
   职责：把 CSV / TXT 文本解析为 YMS.DataFrame（供 Data Import 菜单与内置示例数据使用）
   依赖：YMS.util（nextTick / toast / fmtInt）
         YMS.types（parseNumber / parseTime / inferType）
         YMS.DFBuilder / YMS.DataFrame（js/core/dataframe.js）
   要点：
     1) 支持 BOM、CRLF / LF / CR、双引号包裹字段、"" 转义、字段内逗号与换行；
     2) 分隔符探测：在首个非空行（引号外）统计 , \t ; | 出现次数，取最大者（并列时按该顺序优先）；
     3) parseFile 流式：file.slice() + FileReader 分块读取；跨块的残留半行 / 半字段 / 半个转义引号
        由 Tokenizer 状态机跨块维持；优先 readAsArrayBuffer + TextDecoder(stream:true)
        （避免多字节汉字被块边界截断），环境不支持时退化为 FileReader.readAsText；
        每块结束后 await YMS.util.nextTick() 让出主线程（UI 不卡、进度可更新）；
     4) 两阶段类型推断：先采样前 sampleRows（默认 2000）行 → YMS.types.inferType（阈值 0.9）
        → 再按定好的列类型直接流式写入 DFBuilder（不回读全量数据、不产生中间大数组）；
     5) 数值列解析失败率 > 10%：行数 ≤ 30 万 → 用原始字符串重建为字符列；
        行数 > 30 万 → 保留数值列（失败值记 NaN）并在 warnings 中说明；
     6) 空文件 / 只有表头 / 空表头名（Col1, Col2…）/ 行列不一致（缺列补缺失、多列忽略并计数）。
     7) M-4 表头去重：重复列名按出现顺序改名 A / A_2 / A_3（YMS.colNames.unique 单一入口），
        结果放在 Result.dupHeader（count / renamed[{from,to,index}]），供导入层做可见提示。
   对外：
     YMS.CsvParser.parseFile(file, opts) -> Promise<Result>
     YMS.CsvParser.parseText(text, opts) -> Result          （同步）
   Result: {ok, header, defs, df, rowCount, colCount, delimiter, elapsedMs, rowsPerSec,
             warnings, sampleStats, error}
   opts:   {delimiter:'auto'|','|'\t'|';'|'|', sampleRows:2000, chunkSize:8MB,
            onProgress(pct, {bytes,totalBytes,rows,phase,elapsedMs,rowsPerSec}),
            onSample(header, samples)}   samples 为「首 sampleRows 行原始字符串行数组」，
                                        并附带 .header / .stats / .delimiter 三个属性
   失败处理：不 throw、不 reject —— 返回 ok:false 且带 error 文案，同时 console.error + toast。
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;
  var U = YMS.util;

  var DEFAULT_CHUNK = 8 * 1024 * 1024;    /* 8 MB */
  var DEFAULT_SAMPLE_ROWS = 2000;
  var REBUILD_ROW_LIMIT = 300000;         /* 超过该行数不再保留原始字符串（用于重建字符列） */
  var NUM_FAIL_RATIO = 0.1;               /* 数值列解析失败率阈值 */
  var BUFFER_LIMIT = 4 * 1024 * 1024;     /* 未探测出分隔符时的最大缓冲 */
  var DELIMS = [',', '\t', ';', '|'];
  var Q = 34;                             /* '"'  */
  var LF = 10, CR = 13;
  var BOM_CHAR = 0xFEFF;

  /* ------------------------------------------------------------------ 通用 */
  /** 单调时钟（毫秒）；无 performance 时退化为 Date.now */
  function nowMs() {
    if (global.performance && typeof global.performance.now === 'function') return global.performance.now();
    return Date.now();
  }
  /** 让出主线程 */
  function nextTick() {
    if (U && typeof U.nextTick === 'function') return U.nextTick();
    return new Promise(function (r) { setTimeout(r, 0); });
  }
  function fmtInt(n) { return (U && U.fmtInt) ? U.fmtInt(n) : String(n); }
  function trimStr(s) { return s.trim(); }
  function toastError(msg) { if (U && typeof U.toast === 'function') U.toast(msg, 'error'); }

  /* -------------------------------------------------------- 分隔符探测 */
  /**
   * 统计单个字符在「引号之外」出现的次数（引号内按 "" 转义规则处理）
   * @param {string} line @param {string} ch @returns {number}
   */
  function countOutsideQuotes(line, ch) {
    var n = 0, inQ = false, i, c;
    for (i = 0; i < line.length; i++) {
      c = line.charAt(i);
      if (c === '"') {
        if (inQ && line.charAt(i + 1) === '"') { i++; continue; }
        inQ = !inQ;
      } else if (c === ch && !inQ) {
        n++;
      }
    }
    return n;
  }

  /**
   * 在给定行上探测分隔符
   * @param {string} line @returns {string} 单字符分隔符（无候选命中时返回 ','）
   */
  function detectDelimiter(line) {
    var best = ',', bestN = -1, i, n;
    for (i = 0; i < DELIMS.length; i++) {
      n = countOutsideQuotes(line, DELIMS[i]);
      if (n > bestN) { bestN = n; best = DELIMS[i]; }
    }
    return bestN > 0 ? best : ',';
  }

  /**
   * 从一段（可能不完整的）文本中找首个非空行并探测分隔符
   * @param {string} text @returns {string|null} null = 尚无完整非空行（需继续缓冲）
   */
  function detectDelimiterFromText(text) {
    var i = 0, j, len = text.length, c;
    while (i < len) {
      j = i;
      while (j < len && text.charCodeAt(j) !== LF && text.charCodeAt(j) !== CR) j++;
      if (j >= len) return null;                                   /* 末尾行不完整 */
      if (text.slice(i, j).trim() !== '') return detectDelimiter(text.slice(i, j));
      c = text.charCodeAt(j);
      if (c === CR && text.charCodeAt(j + 1) === LF) j++;
      i = j + 1;
    }
    return null;
  }

  /* ==========================================================================
     Tokenizer：增量 CSV 状态机
     跨块保存：当前字段内容(field)、当前行已完成字段(fields)、是否在引号内(inQ)、
              块末引号待判定(pendingQuote)、块末 CR 导致的 skipLF
     ========================================================================== */
  /**
   * @param {string} delimiter 单字符分隔符
   * @param {function(Array<string>)} onRow 每产出一行调用一次
   */
  function Tokenizer(delimiter, onRow) {
    this.d = delimiter.charCodeAt(0);
    this.onRow = onRow;
    this.inQ = false;           /* 是否处于引号包裹中 */
    this.quoted = false;        /* 当前字段是否出现过引号（出现过则不 trim） */
    this.field = '';            /* 当前字段已累积内容（跨块残留） */
    this.fields = [];           /* 当前行已完成的字段 */
    this.pendingQuote = false;  /* 上一块末字符是引号：下一块首字符为 " → 转义，否则视为收尾 */
    this.skipLF = false;        /* 上一块以 CR 结束行 → 本块开头的 LF 丢弃 */
    this.unclosedQuote = false; /* 文件结束时仍有未闭合引号 */
  }

  /**
   * 喂入一块文本
   * @param {string} text
   * @returns {void}
   */
  Tokenizer.prototype.push = function (text) {
    var len = text.length;
    var i = 0, start = 0, c;
    var q = Q, d = this.d;
    var field = this.field, fields = this.fields, inQ = this.inQ, quoted = this.quoted;

    if (this.skipLF) {
      this.skipLF = false;
      if (len && text.charCodeAt(0) === LF) { i = 1; start = 1; }
    }
    if (this.pendingQuote) {
      this.pendingQuote = false;
      if (len && text.charCodeAt(i) === q) { field += '"'; i += 1; start = i; }  /* "" → 一个 " */
      else { inQ = false; }                                                     /* 引号在此收尾 */
    }

    while (i < len) {
      c = text.charCodeAt(i);
      if (c === q) {
        if (!inQ) {                                                             /* 字段开始 */
          field += text.slice(start, i);
          inQ = true; quoted = true; i += 1; start = i;
        } else if (i + 1 < len) {
          if (text.charCodeAt(i + 1) === q) { field += text.slice(start, i) + '"'; i += 2; start = i; }
          else { field += text.slice(start, i); inQ = false; i += 1; start = i; }  /* 字段结束 */
        } else {
          field += text.slice(start, i);                                        /* 引号在块尾：待下一块判定 */
          i += 1; start = i;
          this.pendingQuote = true;
        }
      } else if (!inQ && (c === d || c === LF || c === CR)) {
        field += text.slice(start, i);
        fields.push(quoted ? field : trimStr(field));
        field = ''; quoted = false;
        i += 1;
        if (c === d) {
          start = i;                                        /* 字段结束，行继续 */
        } else {
          if (c === CR) {
            if (i < len && text.charCodeAt(i) === LF) i += 1;  /* CRLF */
            else if (i >= len) this.skipLF = true;            /* CR 在块尾：LF 属下一块 */
          }
          start = i;
          if (this.onRow) this.onRow(fields);                 /* 行结束 */
          fields = [];
        }
      } else {
        i += 1;
      }
    }

    field += text.slice(start);                                                 /* 残留尾部拼接 */
    this.field = field; this.fields = fields; this.inQ = inQ; this.quoted = quoted;
  };

  /**
   * 文本结束：产出最后一行（文件末尾无换行符的情形）
   * @returns {void}
   */
  Tokenizer.prototype.end = function () {
    if (this.pendingQuote) { this.pendingQuote = false; this.inQ = false; }
    if (this.inQ) { this.unclosedQuote = true; this.inQ = false; }
    var f = this.field, fs = this.fields;
    if (f !== '' || fs.length) {
      fs.push(this.quoted ? f : trimStr(f));
      this.field = ''; this.fields = [];
      if (this.onRow) this.onRow(fs);
    } else {
      this.field = ''; this.fields = [];
    }
  };

  /* ==========================================================================
     Pipeline：分块喂入 + 两阶段类型推断 + 流式写入 DFBuilder
     ========================================================================== */
  /**
   * @param {object} opts 同 parseFile 的 opts
   */
  function Pipeline(opts) {
    opts = opts || {};
    this.delimiter = (opts.delimiter && opts.delimiter !== 'auto') ? String(opts.delimiter) : null;
    this.sampleRows = Math.max(1, opts.sampleRows || DEFAULT_SAMPLE_ROWS);
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    this.onSample = typeof opts.onSample === 'function' ? opts.onSample : null;

    this.header = null;
    this.defs = null;
    this.infer = null;              /* 采样阶段的 inferType 结果 */
    this.sampleStats = [];
    this.builder = null;
    this.rowCount = 0;
    this.pendingRows = [];          /* 采样阶段已解析、尚未写入 builder 的行 */
    this.parseFails = null;         /* Int32Array：每个数值列的解析失败计数 */
    this.rawStrings = null;         /* 每个数值列的原始字符串（≤30 万行时保留） */
    this.rawText = null;            /* M-1：被改写的显示原文（percent / thousands），_infer 时初始化 */
    this.warnings = [];
    this.extraFieldRows = 0;        /* 字段多于表头列数的行数 */
    this.shortRows = 0;             /* 字段少于表头列数的行数 */
    this.badChars = 0;              /* 无法解码的字符数（非 UTF-8 文本的信号） */
    this.dupHeader = null;          /* M-4：表头去重改名报告（null = 无重复列名） */
    this.tokenizer = null;
    this._buffered = '';
    this._started = nowMs();
    this.phase = 'sampling';
    this.error = null;
  }

  /** 统计不可解码字符（仅用于给出编码提醒） */
  Pipeline.prototype._scanBad = function (text) {
    var p = text.indexOf('\uFFFD');
    while (p >= 0) { this.badChars++; p = text.indexOf('\uFFFD', p + 1); }
  };

  /**
   * 喂入一块文本（内部完成分隔符探测 / 首行缓冲 / 状态机转发）
   * @param {string} text
   * @returns {void}
   */
  Pipeline.prototype.feed = function (text) {
    if (text === null || text === undefined) return;
    if (typeof text !== 'string') text = String(text);
    if (!text || this.error) return;
    try {
      if (this.tokenizer) { this._scanBad(text); this.tokenizer.push(text); return; }

      if (this._buffered.length === 0 && text.charCodeAt(0) === BOM_CHAR) text = text.slice(1);   /* 去 BOM */
      var all = this._buffered + text;
      if (this.delimiter === null) {
        var d = detectDelimiterFromText(all);
        if (d === null) {
          if (all.length > BUFFER_LIMIT) this.delimiter = ',';      /* 超长单行：不再等待 */
          else { this._buffered = all; return; }
        } else {
          this.delimiter = d;
        }
      }
      this._buffered = '';
      this._scanBad(all);
      var self = this;
      this.tokenizer = new Tokenizer(this.delimiter || ',', function (fields) { self._onRow(fields); });
      this.tokenizer.push(all);
    } catch (e) {
      this.error = (e instanceof Error) ? e : new Error(String(e));
      console.error('[YMS.CsvParser] 解析异常', e);
    }
  };

  /**
   * 行回调：建立表头 → 采样 → 流式写入
   * @param {Array<string>} fields
   */
  Pipeline.prototype._onRow = function (fields) {
    if (fields.length === 1 && fields[0] === '') return;                    /* 跳过空行 */

    if (this.header === null) {
      /* M-4：表头去重改名走 YMS.colNames.unique 单一入口（Excel / .yms 同一条规则） */
      var raw = [], i, name;
      for (i = 0; i < fields.length; i++) {
        name = trimStr(fields[i]);
        if (!name) name = 'Col' + (i + 1);                                   /* 空表头名自动命名 */
        raw.push(name);
      }
      var uniq = YMS.colNames.unique(raw);
      this.dupHeader = uniq.count ? uniq : null;
      if (uniq.count) this.warnings.push(YMS.colNames.notice(uniq));
      this.header = uniq.names.length ? uniq.names : ['Col1'];
      return;
    }

    if (!this.defs) {
      this.pendingRows.push(fields);
      if (this.pendingRows.length >= this.sampleRows) this._infer();
      return;
    }
    this._writeRow(fields);
  };

  /** 采样行 → inferType（阈值 0.9）→ DFBuilder → 回放采样行 */
  Pipeline.prototype._infer = function () {
    var nc = this.header ? this.header.length : 0, i, r, row;
    var cols = [];
    for (i = 0; i < nc; i++) cols.push([]);
    for (r = 0; r < this.pendingRows.length; r++) {
      row = this.pendingRows[r];
      for (i = 0; i < nc; i++) cols[i].push(i < row.length ? row[i] : null);
    }

    var defs = [], stats = [], infos = [], info;
    for (i = 0; i < nc; i++) {
      info = T.inferType(cols[i]);
      infos.push(info);
      defs.push({
        name: this.header[i], type: info.type,
        timeStyle: info.type === T.TIME ? info.timeStyle : null,
        decimals: info.decimals
      });
      stats.push({
        name: this.header[i], type: info.type,
        numRatio: info.numRatio, timeRatio: info.timeRatio, missingRatio: info.missingRatio,
        decimals: info.decimals, timeStyle: info.timeStyle
      });
    }
    this.infer = infos;
    this.defs = defs;
    this.sampleStats = stats;

    var defsIn = defs.map(function (d) { return { name: d.name, type: d.type, timeStyle: d.timeStyle }; });
    this.builder = new YMS.DFBuilder(defsIn);
    this.parseFails = new Int32Array(nc);
    this.rawStrings = [];
    this.rawText = [];                               /* M-1：被改写的显示原文（按列稀疏数组） */
    for (i = 0; i < nc; i++) { this.rawStrings.push(defs[i].type === T.NUMBER ? [] : null); this.rawText.push(null); }

    var pend = this.pendingRows;                     /* 采样阶段的行：一次性回放到 builder */
    this.pendingRows = [];
    for (r = 0; r < pend.length; r++) this._writeRow(pend[r]);
    this.phase = 'parsing';

    if (this.onSample) {
      var samples = pend.slice();                    /* 原始字符串行数组 */
      samples.header = this.header.slice();
      samples.stats = this.sampleStats;
      samples.delimiter = this.delimiter;
      try { this.onSample(this.header.slice(), samples); } catch (e) { console.error('[YMS.CsvParser] onSample 回调异常', e); }
    }
  };

  /**
   * 按已定列类型写入一行（不再做类型判断，直接解析为目标存储值）
   * @param {Array<string>} fields
   */
  Pipeline.prototype._writeRow = function (fields) {
    var defs = this.defs, b = this.builder, nc = defs.length;
    var nf = fields.length, i, v, d, n, ms;
    for (i = 0; i < nc; i++) {
      v = (i < nf) ? fields[i] : null;
      d = defs[i];
      if (v === null || v === '') { b.setMissing(i); continue; }
      if (d.type === T.NUMBER) {
        /* M-1：数值解析统一走 parseLoose —— '95%' → 0.95、'1,234' → 1234、
           'N/A' / '-' / 'NaN' → 缺失；被改写的原文另存一份供表格显示 */
        var pl = T.parseLoose(v);
        if (pl.value === null || YMS.num.isMissing(pl.value)) {
          b.setMissing(i);
          if (!pl.isMissing) this.parseFails[i]++;      /* 只有真文本算解析失败；明确缺失不算 */
        } else {
          b.set(i, pl.value);
          if (pl.from === 'percent' || pl.from === 'thousands') this._keepRawText(i, v);
        }
        if (this.rawStrings && this.rawStrings[i]) this.rawStrings[i].push(v);
      } else if (d.type === T.TIME) {
        ms = T.parseTime(v);
        if (ms !== ms) b.setMissing(i);
        else b.set(i, ms);
      } else {
        b.set(i, v);
      }
    }
    if (nf > nc) this.extraFieldRows++;              /* 多余字段：忽略 */
    if (nf < nc) this.shortRows++;
    b.endRow();
    this.rowCount++;
    if (this.rawStrings && this.rowCount > REBUILD_ROW_LIMIT) this.rawStrings = null;   /* 释放原始字符串 */
  };

  /** M-1：保存该行的显示原文（'95%' / '1,234' 这类被改写的写法；其余不存） */
  Pipeline.prototype._keepRawText = function (ci, v) {
    var keep = this.rawText;
    if (!keep || this.rowCount > REBUILD_ROW_LIMIT) return;   /* 超 30 万行内存优先：不保留原文 */
    if (!keep[ci]) keep[ci] = [];
    keep[ci][this.rowCount] = String(v).trim();
  };

  /** M-1：把显示原文挂到数值列上（Column.rawText），供表格显示层使用 */
  Pipeline.prototype._attachRawText = function (df) {
    var keep = this.rawText;
    this.rawText = null;
    if (!keep) return;
    for (var i = 0; i < df.cols.length; i++) {
      if (keep[i] && df.cols[i].type === T.NUMBER) df.cols[i].rawText = keep[i];
    }
  };

  /** 数值列失败率 > 10% 的兜底：≤30 万行重建为字符列，否则保留数值列 + warning */
  Pipeline.prototype._applyRebuild = function (df) {
    if (!this.parseFails) return;
    var nc = df.cols.length, i, arr, c, nb, r, name;
    for (i = 0; i < nc; i++) {
      if (df.cols[i].type !== T.NUMBER) continue;
      var fails = this.parseFails[i];
      if (!this.rowCount || fails / this.rowCount <= NUM_FAIL_RATIO) continue;
      name = df.cols[i].name;
      if (this.rawStrings && this.rawStrings[i] && this.rowCount <= REBUILD_ROW_LIMIT) {
        arr = this.rawStrings[i];
        nb = new YMS.DFBuilder([{ name: name, type: T.STRING }]);
        for (r = 0; r < arr.length; r++) { nb.set(0, arr[r]); nb.endRow(); }
        c = nb.finish().cols[0];
        c.name = name; c.timeStyle = null;
        df.cols[i] = c;
        this.defs[i].type = T.STRING;
        this.defs[i].timeStyle = null;
        if (this.sampleStats[i]) this.sampleStats[i].type = T.STRING;
        this.warnings.push('列「' + name + '」数值解析失败 ' + fmtInt(fails) + ' / ' + fmtInt(this.rowCount) +
          ' 行（>10%），已按原始文本重建为字符列');
      } else {
        this.warnings.push('列「' + name + '」数值解析失败 ' + fmtInt(fails) + ' / ' + fmtInt(this.rowCount) +
          ' 行（>10%）；数据行超过 30 万，为控制内存未重建为字符列，失败值已记为缺失值');
      }
    }
    df.refreshMissing();
  };

  /**
   * 结束解析，产出 Result
   * @returns {object} Result
   */
  Pipeline.prototype.finish = function () {
    if (this.error) return this._errorResult();
    try {
      if (this.tokenizer) {
        this.tokenizer.end();
        if (this.tokenizer.unclosedQuote) this.warnings.push('文件末尾存在未闭合的双引号，已按普通文本处理');
        this.tokenizer = null;
      }
      if (this.header === null) {
        this.header = [];
        this.warnings.push('CSV 内容为空：没有可解析的表头与数据行');
        this._infer();
      } else if (!this.defs) {
        this._infer();
        if (this.rowCount === 0) this.warnings.push('文件只有表头，没有数据行');
      }

      var df = this.builder ? this.builder.finish() : new YMS.DataFrame([]);
      this.builder = null;
      this._applyRebuild(df);
      this._attachRawText(df);                       /* M-1：挂上被改写的显示原文 */

      if (this.shortRows) this.warnings.push('有 ' + fmtInt(this.shortRows) + ' 行的字段数少于表头列数，缺少的字段已记为缺失值');
      if (this.extraFieldRows) this.warnings.push('有 ' + fmtInt(this.extraFieldRows) + ' 行的字段数多于表头列数，多余字段已忽略');
      if (this.badChars) this.warnings.push('检测到 ' + fmtInt(this.badChars) + ' 个无法解码的字符，文件可能不是 UTF-8 编码');

      var elapsed = nowMs() - this._started;
      this.phase = 'done';
      var res = {
        ok: true,
        header: this.header.slice(),
        defs: this.defs,
        df: df,
        rowCount: df.rowCount,
        colCount: df.cols.length,
        delimiter: this.delimiter || ',',
        elapsedMs: elapsed,
        rowsPerSec: elapsed > 0 ? df.rowCount / (elapsed / 1000) : 0,
        warnings: this.warnings,
        sampleStats: this.sampleStats,
        dupHeader: this.dupHeader,                    /* M-4：重复列名改名报告 */
        error: null
      };
      this.rawStrings = null;
      if (this.onProgress) {
        try {
          this.onProgress(100, {
            bytes: 0, totalBytes: 0, rows: df.rowCount, phase: 'done', elapsedMs: elapsed,
            rowsPerSec: res.rowsPerSec
          });
        } catch (e) { console.error('[YMS.CsvParser] onProgress 回调异常', e); }
      }
      return res;
    } catch (e) {
      this.error = (e instanceof Error) ? e : new Error(String(e));
      console.error('[YMS.CsvParser] 结束处理异常', e);
      return this._errorResult();
    }
  };

  /** 失败结果（统一结构，便于调用方判定 res.df / res.error） */
  Pipeline.prototype._errorResult = function () {
    return {
      ok: false, header: this.header ? this.header.slice() : [], defs: this.defs || [], df: null,
      rowCount: this.rowCount, colCount: 0, delimiter: this.delimiter || ',',
      elapsedMs: nowMs() - this._started, rowsPerSec: 0,
      warnings: this.warnings, sampleStats: this.sampleStats,
      error: this.error ? (this.error.message || String(this.error)) : '解析失败'
    };
  };

  /* ---------------------------------------------------------- 文件分块读取 */
  /**
   * 选择读取策略：优先 readAsArrayBuffer + TextDecoder（跨块 UTF-8 安全），否则退化为 readAsText
   * @returns {{mode:string, decoder:TextDecoder|null, flush:function|null}}
   */
  function makeReader() {
    var binary = false, dec = null;
    if (typeof global.TextDecoder === 'function' && typeof global.FileReader === 'function') {
      try {
        var probe = new global.FileReader();
        binary = typeof probe.readAsArrayBuffer === 'function';
      } catch (e) { binary = false; }
      if (binary) { try { dec = new global.TextDecoder('utf-8'); } catch (e2) { dec = null; binary = false; } }
    }
    return {
      mode: binary ? 'binary' : 'text',
      decoder: dec,
      flush: dec ? function () { try { return dec.decode(); } catch (e) { return ''; } } : null
    };
  }

  /**
   * 读取一个 Blob 分片 → 文本
   * @param {Blob} slice @param {object} reader @returns {Promise<string>}
   */
  function readSlice(slice, reader) {
    return new Promise(function (resolve, reject) {
      var fr;
      try { fr = new FileReader(); } catch (e) { reject(new Error('当前环境不支持 FileReader')); return; }
      fr.onload = function () {
        try {
          if (reader.mode === 'binary') resolve(reader.decoder.decode(fr.result, { stream: true }));
          else resolve(fr.result === null || fr.result === undefined ? '' : String(fr.result));
        } catch (e) { reject(e); }
      };
      fr.onerror = function () { reject(new Error('文件读取失败（FileReader error）')); };
      try {
        if (reader.mode === 'binary') fr.readAsArrayBuffer(slice);
        else fr.readAsText(slice);
      } catch (e) { reject(e); }
    });
  }

  /* -------------------------------------------------------------- 公开 API */
  /**
   * 同步解析文本（小数据 / 测试 / 示例数据）
   * @param {string} text @param {object} [opts] 同 parseFile.opts
   * @returns {object} Result（失败时 ok:false 且 df:null）
   */
  function parseText(text, opts) {
    var p = new Pipeline(opts);
    p.feed(text);
    var res = p.finish();
    if (!res.ok) toastError('CSV 解析失败：' + res.error);
    return res;
  }

  /**
   * 流式解析文件（分块读取 + 让出主线程）
   * @param {File|Blob} file @param {object} [opts]
   * @returns {Promise<object>} Result（失败时不 reject，返回 ok:false）
   */
  function parseFile(file, opts) {
    opts = opts || {};
    var p = new Pipeline(opts);
    var started = nowMs();

    if (!file || typeof file.slice !== 'function') {
      p.error = new Error('文件对象无效（缺少 slice 方法）');
      var bad = p.finish();
      toastError('CSV 解析失败：' + bad.error);
      return Promise.resolve(bad);
    }

    var total = (typeof file.size === 'number') ? file.size : 0;
    var chunkSize = opts.chunkSize || DEFAULT_CHUNK;
    var reader = makeReader();
    var offset = 0;

    function report() {
      if (!opts.onProgress) return;
      var pct = total ? Math.min(100, Math.round(offset / total * 1000) / 10) : 0;
      var el = nowMs() - started;
      try {
        opts.onProgress(pct, {
          bytes: offset, totalBytes: total, rows: p.rowCount, phase: p.phase,
          elapsedMs: el, rowsPerSec: el > 0 ? p.rowCount / (el / 1000) : 0
        });
      } catch (e) { console.error('[YMS.CsvParser] onProgress 回调异常', e); }
    }

    function step() {
      if (offset >= total || p.error) return Promise.resolve();
      var end = Math.min(offset + chunkSize, total);
      var slice = file.slice(offset, end);
      return readSlice(slice, reader).then(function (text) {
        offset = end;
        p.feed(text);
        report();
        return nextTick().then(step);                   /* 让出主线程 */
      });
    }

    return step().then(function () {
      if (reader.flush) {
        var tail = reader.flush();
        if (tail) p.feed(tail);
      }
      var res = p.finish();
      res.elapsedMs = nowMs() - started;
      res.rowsPerSec = res.elapsedMs > 0 ? res.rowCount / (res.elapsedMs / 1000) : 0;
      if (!res.ok) toastError('CSV 解析失败：' + res.error);
      return res;
    }, function (err) {
      p.error = (err instanceof Error) ? err : new Error(String(err));
      console.error('[YMS.CsvParser.parseFile] 读取失败', err);
      var r = p.finish();
      toastError('CSV 文件读取失败：' + r.error);
      return r;
    });
  }

  YMS.CsvParser = {
    parseFile: parseFile,
    parseText: parseText,
    /* 便于自测/其它模块复用的纯函数 */
    detectDelimiter: detectDelimiter,
    countOutsideQuotes: countOutsideQuotes
  };
})(typeof window !== 'undefined' ? window : this);
