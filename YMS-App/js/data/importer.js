/* ==========================================================================
   YMS · data/importer.js
   职责：数据导入编排层 —— 文件选择、按扩展名分流、进度显示、写入 Store、状态提示
   依赖：YMS.util（el / toast / confirm / progress / setStatus / nowStamp…）
         YMS.CsvParser（.csv/.txt）· SheetJS 全局 XLSX（.xls/.xlsx，vendor 本地）
         YMS.YmsTemplate（.yms，运行期取用：脚本顺序在 importer 之后）
         YMS.Store（setData / addNote / setMode）
   要点：
     1) file:// 下不发起任何网络请求：只用 <input type=file> + FileReader；
     2) 文件 > 20 MB 时用 YMS.util.progress 显示「百分比 + 已解析行数 + 行/秒 + 阶段」，结束即关闭；
     3) 成功后统一：Store.setData → Store.addNote（文件名/行列数/耗时/警告）→ 状态栏 + toast；
        .yms 例外：切到绘图视图（'plot'）；
     4) 所有失败路径 toast('导入失败：…','error') + console.error，不抛未捕获异常。
     5) M-3 空导入语义：解析结果 0 行 × 0 列 → ok:false + 中文提示，**不碰 Store**（当前表原样保留）；
        0 行但有列定义（只有表头）→ 照常导入但提示降级为 warn「仅列定义，0 行数据」。
        判定统一走 emptyKindOf()，CSV / Excel / .yms 三条路径共用。
     6) M-4 重复列名：解析层（csv-parser / aoaToTable / dfFromSpec）已按 YMS.colNames.unique
        改名，这里只负责把结果放进**主状态栏 + toast + 处理说明**（不能只落处理说明）。
   对外：
     YMS.Importer.openDialog()                          // 触发隐藏 input[type=file]
     YMS.Importer.importFile(file) -> Promise<Result>   // Result {ok, kind:'table'|'yms', df, meta, elapsedMs}
     YMS.Importer.importFiles(fileList) -> Promise<Result>
     YMS.Importer.importText(fileName, text) -> Result   （同步，走 CsvParser.parseText）
     YMS.Importer.importSample() -> Result               （同步，内置示例数据）
     YMS.Importer.importArrayBuffer(fileName, buffer) -> Result  （同步，xlsx 路径）
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;
  var U = YMS.util;

  var BIG_FILE_BYTES = 20 * 1024 * 1024;        /* > 20 MB 显示进度条 */
  var BIG_ROWS = 500000;                        /* 预计 > 50 万行同样显示进度 */
  var SAMPLE_ROWS = 2000;                       /* 类型推断采样行数 */
  var SUPPORTED = { csv: 1, txt: 1, tsv: 1, xls: 1, xlsx: 1, yms: 1 };

  var _input = null;                            /* 复用的隐藏文件输入 */

  /* ------------------------------------------------------------------ 工具 */
  function nowMs() {
    if (global.performance && typeof global.performance.now === 'function') return global.performance.now();
    return Date.now();
  }
  function fmtInt(n) { return U && U.fmtInt ? U.fmtInt(n) : String(n); }
  function fmtBytes(n) { return U && U.fmtBytes ? U.fmtBytes(n) : String(n); }
  function fmtDur(ms) { return U && U.fmtDuration ? U.fmtDuration(ms) : Math.round(ms) + ' ms'; }
  function esc(s) { return U && U.escapeHtml ? U.escapeHtml(s) : String(s); }
  function toast(html, kind) { if (U && U.toast) U.toast(html, kind); }
  function setStatus(msg, kind) { if (U && U.setStatus) U.setStatus(msg, kind); }
  function closeProgress() { if (U && U.progress) U.progress.close(); }

  /** 文件扩展名（小写，不含点） */
  function extOf(name) {
    var s = String(name || '');
    var i = s.lastIndexOf('.');
    return i < 0 ? '' : s.slice(i + 1).toLowerCase();
  }

  /** 估算字符串 UTF-8 字节数（Blob 优先，退化按字符宽度估算） */
  function byteLen(str) {
    if (!str) return 0;
    try {
      if (typeof global.Blob === 'function') {
        var b = new global.Blob([str]);
        if (b && typeof b.size === 'number' && b.size) return b.size;
      }
    } catch (e) { /* 走估算 */ }
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      n += c < 0x80 ? 1 : (c < 0x800 ? 2 : 3);
    }
    return n;
  }

  /** 失败结果 */
  function fail(msg, started, kind) {
    toast('导入失败：' + esc(msg), 'error');
    setStatus('导入失败：' + msg, 'error');
    return {
      ok: false, kind: kind || null, df: null, meta: null,
      elapsedMs: nowMs() - (started || nowMs()), error: msg
    };
  }

  /* ---------------------------------------------- M-3：空导入语义判定 */
  /**
   * 空导入提示（情形 A 的唯一文案来源，断言按关键词匹配）
   * 说明：0 字节 / 纯空行 / 空工作表 → 解析结果 0 行 × 0 列 → 取消导入，绝不写 Store。
   */
  var MSG_EMPTY_IMPORT = '这份文件没有可导入的数据（0 行 × 0 列），已取消导入，当前数据未受影响';

  /**
   * 空导入判定（单一入口，CSV / Excel / .yms 三条路径共用）
   * @param {object|null} df
   * @returns {'empty'|'headerOnly'|'ok'}
   *   empty      = 0 行 × 0 列（0 字节 / 纯空行 / 空工作表）→ 取消导入，当前表原样保留
   *   headerOnly = 0 行但 ≥1 列定义（只有表头）→ 允许导入（用户先建结构），提示降级为 warn
   *   ok         = ≥1 行数据 → 行为与改动前完全一致
   */
  function emptyKindOf(df) {
    if (!df) return 'empty';
    var nc = df.cols ? df.cols.length : 0;
    if (df.rowCount === 0 && nc === 0) return 'empty';
    if (df.rowCount === 0) return 'headerOnly';
    return 'ok';
  }

  /** 情形 A 的统一返回：ok:false + 中文提示，且**不碰 Store**（不 setData / 不 addNote / 不改 mode） */
  function noDataResult(msg, started, kind) {
    msg = msg || MSG_EMPTY_IMPORT;
    toast(msg, 'error', 6000);
    setStatus(msg, 'error');
    return {
      ok: false, kind: kind || 'table', df: null, meta: null,
      elapsedMs: nowMs() - (started || nowMs()), error: msg, reason: 'empty-data'
    };
  }

  /**
   * 情形 A 守卫：命中 0 行 × 0 列就返回失败结果，调用方直接 return 即可
   * @returns {object|null} 追加失败结果；非空表返回 null
   */
  function guardEmpty(df, started, kind, msg) {
    if (emptyKindOf(df) !== 'empty') return null;
    return noDataResult(msg, started, kind);
  }

  /** 阶段中文名（进度条显示） */
  function phaseCn(p) {
    if (p === 'sampling') return '采样类型推断';
    if (p === 'parsing') return '解析数据';
    if (p === 'done') return '完成';
    return '读取文件';
  }

  /** 分隔符显示名 */
  function delimCn(d) {
    if (d === '\t') return '制表符 (Tab)';
    if (d === ',') return '逗号';
    if (d === ';') return '分号';
    if (d === '|') return '竖线';
    return String(d);
  }

  /* ---------------------------------------------- 写入 Store + 状态提示 */
  /**
   * 表格类数据统一收尾：Store.setData + addNote + 状态栏 + toast
   * @param {object} res   CsvParser / xlsx 转换结果 {df, warnings, delimiter, elapsedMs}
   * @param {string} name  文件名
   * @param {number} size  文件大小（字节，可为 0）
   * @param {number} started 起始时刻（nowMs）
   * @param {string} source 来源说明（写入处理说明）
   * @param {number} rowsPerSec 可选
   * @param {{asNewTable?:boolean, quiet?:boolean}} [opts]
   *        asNewTable=true → 每个文件追加成一张新表（多文件导入用，迭代 14）
   *        quiet=true    → 不逐个文件 toast（多文件导入由汇总 toast 收口）
   * @returns {object} meta
   */
  function applyTable(res, name, size, started, source, rowsPerSec, opts) {
    opts = opts || {};
    var df = res.df;
    var elapsed = (res.elapsedMs && res.elapsedMs > 0) ? res.elapsedMs : (nowMs() - started);
    var warnings = res.warnings || [];
    var headerOnly = (emptyKindOf(df) === 'headerOnly');   /* M-3 情形 B：只有表头、0 行数据 */
    /* M-4：重复列名已自动改名 → 必须进主状态栏与 toast（不能只落「处理说明」） */
    var dupNotice = (res.dupHeader && res.dupHeader.count) ? YMS.colNames.notice(res.dupHeader) : '';

    /* 迭代 14：多文件导入 → 每个文件一张表；单文件路径仍覆盖当前表（行为不变） */
    var tbl;
    if (opts.asNewTable && YMS.Store.addTable) {
      tbl = YMS.Store.addTable(df, {
        name: String(name || '').replace(/\.[^.]+$/, ''),
        fileName: name, fileSize: size || 0
      });
    } else {
      YMS.Store.setData(df, { fileName: name, fileSize: size || 0 });
      tbl = { id: YMS.Store.state.activeTableId, name: YMS.Store.state.tableName };
    }
    YMS.Store.addNote('导入 ' + name + '：' + df.rowCount + ' 行 × ' + df.cols.length + ' 列，耗时 ' +
      fmtDur(elapsed) + (source ? '（' + source + '）' : '') +
      (headerOnly ? '；仅列定义，0 行数据' : ''));
    for (var i = 0; i < warnings.length; i++) YMS.Store.addNote('导入提示：' + warnings[i]);
    YMS.Store.setMode('data');

    var statusMsg = headerOnly
      ? '已导入 ' + name + '：仅列定义，0 行数据'
      : '已导入 ' + name + '：' + fmtInt(df.rowCount) + ' 行 × ' + df.cols.length + ' 列';
    if (dupNotice) statusMsg += ' · ' + dupNotice;      /* M-4：主状态栏可见 */
    setStatus(statusMsg, (dupNotice || headerOnly) ? 'warn' : 'ok');
    if (U && U.setStatusTime) U.setStatusTime(fmtDur(elapsed));

    var msg;
    if (headerOnly) {
      /* 情形 B：允许覆盖（用户确实要给一份新结构），但必须说清「这份表是空的」 */
      if (opts.quiet) {
        if (warnings.length) console.warn('[YMS.Importer] ' + name + ' 导入提示：', warnings);
      } else {
        toast('已导入 <b>' + esc(name) + '</b>：只有表头（仅列定义，0 行数据）' +
          (dupNotice ? '<br>' + esc(dupNotice) : ''), 'warn', 6000);
      }
    } else {
      msg = '已导入 <b>' + esc(name) + '</b>：' + fmtInt(df.rowCount) + ' 行 × ' + df.cols.length + ' 列';
      if (rowsPerSec && rowsPerSec > 0) msg += ' · ' + fmtInt(rowsPerSec) + ' 行/秒';
      if (opts.quiet) {
        if (warnings.length) console.warn('[YMS.Importer] ' + name + ' 导入提示：', warnings);
      } else if (warnings.length) {
        if (dupNotice) msg += '<br>' + esc(dupNotice);   /* M-4：改名明细直接进 toast */
        msg += '<br>提示 ' + warnings.length + ' 条，详见下方「处理说明」';
        toast(msg, 'warn', 5000);
        console.warn('[YMS.Importer] ' + name + ' 导入提示：', warnings);
      } else {
        toast(msg, 'ok');
      }
    }

    return {
      fileName: name, fileSize: size || 0, tableName: YMS.Store.state.tableName,
      tableId: tbl ? tbl.id : '',
      rowCount: df.rowCount, colCount: df.cols.length, elapsedMs: elapsed,
      rowsPerSec: rowsPerSec || 0, delimiter: res.delimiter || '', warnings: warnings,
      dupHeader: res.dupHeader || null,                /* M-4：重复列名改名明细 */
      emptyKind: headerOnly ? 'headerOnly' : 'ok'      /* M-3：情形 B 标记（A 走 noDataResult，不进这里） */
    };
  }

  /* ------------------------------------------------------- CSV/TXT 路径 */
  /**
   * 流式导入 CSV/TXT 文件
   * @param {File} file @param {number} started @returns {Promise<Result>}
   */
  function importCsvFile(file, started, iopts) {
    var big = (file.size || 0) > BIG_FILE_BYTES;
    var prog = (U && U.progress) ? U.progress : null;
    if (big && prog) prog.open('正在导入数据', '读取文件…');

    var opts = {
      delimiter: 'auto',
      sampleRows: SAMPLE_ROWS,
      onProgress: function (pct, info) {
        if (!big || !prog) return;
        prog.update(pct, '已解析 ' + fmtInt(info.rows) + ' 行 · ' +
          fmtInt(Math.round(info.rowsPerSec || 0)) + ' 行/秒 · ' + phaseCn(info.phase));
        prog.note(fmtBytes(info.bytes) + ' / ' + fmtBytes(info.totalBytes) + ' · 阶段：' +
          phaseCn(info.phase) + ' · 已用 ' + fmtDur(info.elapsedMs));
      }
    };

    return YMS.CsvParser.parseFile(file, opts).then(function (res) {
      if (big && prog) prog.close();
      if (!res || !res.df) {
        return fail((res && res.error) || '解析失败', started, 'table');
      }
      /* M-3 情形 A：0 行 × 0 列（0 字节 / 纯空行）→ 取消导入，当前表原样保留 */
      var empty = guardEmpty(res.df, started, 'table');
      if (empty) return empty;
      var meta = applyTable(res, file.name, file.size, started,
        'CSV 文本，' + delimCn(res.delimiter) + '分隔，类型推断采样 ' + SAMPLE_ROWS + ' 行', res.rowsPerSec, iopts);
      return { ok: true, kind: 'table', df: res.df, meta: meta, elapsedMs: res.elapsedMs };
    }, function (e) {
      if (big && prog) prog.close();
      console.error('[YMS.Importer] CSV 导入失败', e);
      return fail(e && e.message ? e.message : String(e), started, 'table');
    });
  }

  /* ---------------------------------------------------------- Excel 路径 */
  /**
   * 读取文件为 ArrayBuffer（FileReader）
   * @param {File} file @returns {Promise<ArrayBuffer>}
   */
  function readArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr;
      try { fr = new FileReader(); } catch (e) { reject(new Error('当前环境不支持 FileReader')); return; }
      if (typeof fr.readAsArrayBuffer !== 'function') { reject(new Error('当前环境不支持二进制读取')); return; }
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('Excel 文件读取失败')); };
      try { fr.readAsArrayBuffer(file); } catch (e) { reject(e); }
    });
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      var fr;
      try { fr = new FileReader(); } catch (e) { reject(new Error('当前环境不支持 FileReader')); return; }
      fr.onload = function () { resolve(fr.result === null || fr.result === undefined ? '' : String(fr.result)); };
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      try { fr.readAsText(file); } catch (e) { reject(e); }
    });
  }

  /** 判断是否为 Date（跨 realm 安全：不用 instanceof，改用内部槽标记） */
  function isDate(v) {
    return !!v && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Date]';
  }

  /** 单元格 JS 值 → 采样用字符串（用于类型推断） */
  function cellToSample(v) {
    if (v === null || v === undefined) return '';
    if (isDate(v)) return '';                         /* Date 列由独立规则判为 time */
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return String(v);
    return String(v);
  }

  /** 判断一列采样值里是否含 Date（含则整列按 time 处理） */
  function hasDate(samples) {
    for (var i = 0; i < samples.length; i++) if (isDate(samples[i])) return true;
    return false;
  }

  /** Date 序列的显示样式：全部为 00:00:00 → 'date'，否则 'datetime' */
  function dateStyleOf(samples) {
    var anyTime = false;
    for (var i = 0; i < samples.length; i++) {
      var d = samples[i];
      if (!isDate(d)) continue;
      if (d.getHours() || d.getMinutes() || d.getSeconds() || d.getMilliseconds()) { anyTime = true; break; }
    }
    return anyTime ? 'datetime' : 'date';
  }

  /**
   * SheetJS 工作表（AOA）→ {df, header, defs, warnings}
   * @param {Array<Array>} aoa 首行为表头（header:1）
   * @param {number} sampleRows 采样行数
   */
  function aoaToTable(aoa, sampleRows) {
    sampleRows = sampleRows || SAMPLE_ROWS;
    var warnings = [], i, r, c;
    if (!aoa || !aoa.length) {
      return { df: new YMS.DataFrame([]), header: [], defs: [], warnings: ['工作表为空'] };
    }
    var rawHeader = aoa[0] || [];
    var nc = rawHeader.length;
    if (!nc) return { df: new YMS.DataFrame([]), header: [], defs: [], warnings: ['工作表为空'] };

    var header = [];
    for (i = 0; i < nc; i++) {
      var nm = rawHeader[i] === null || rawHeader[i] === undefined ? '' : String(rawHeader[i]).trim();
      if (nm === '') { nm = 'Col' + (i + 1); }
      header.push(nm);
    }
    /* M-4：Excel 表头同样走 YMS.colNames.unique 去重（与 CSV / .yms 同一条规则） */
    var uniqHeader = YMS.colNames.unique(header);
    header = uniqHeader.names;
    if (uniqHeader.count) warnings.push(YMS.colNames.notice(uniqHeader));

    /* 数据行：整行全空则跳过 */
    var rows = [];
    for (r = 1; r < aoa.length; r++) {
      var row = aoa[r] || [];
      var empty = true;
      for (c = 0; c < nc; c++) { var v0 = row[c]; if (v0 !== null && v0 !== undefined && v0 !== '') { empty = false; break; } }
      if (!empty) rows.push(row);
    }

    /* 采样 → 列定义 */
    var sampled = Math.min(sampleRows, rows.length);
    var cols = [];
    for (i = 0; i < nc; i++) cols.push([]);
    for (r = 0; r < sampled; r++) {
      for (i = 0; i < nc; i++) cols[i].push(rows[r][i] === undefined ? null : rows[r][i]);
    }
    var defs = [], stats = [];
    for (i = 0; i < nc; i++) {
      var dateCol = hasDate(cols[i]);
      var info = T.inferType(cols[i].map(cellToSample));
      var type = dateCol ? T.TIME : info.type;
      var timeStyle = dateCol ? dateStyleOf(cols[i]) : (type === T.TIME ? info.timeStyle : null);
      defs.push({ name: header[i], type: type, timeStyle: timeStyle, decimals: info.decimals });
      stats.push({
        name: header[i], type: type, numRatio: info.numRatio, timeRatio: info.timeRatio,
        missingRatio: info.missingRatio, decimals: info.decimals, timeStyle: timeStyle
      });
      if (dateCol) stats[i].timeRatio = 1;
    }

    /* 全量写入（DFBuilder 流式） */
    var b = new YMS.DFBuilder(defs.map(function (d) { return { name: d.name, type: d.type, timeStyle: d.timeStyle }; }));
    var fails = new Int32Array(nc), shortRows = 0, rawTexts = new Array(nc);
    for (r = 0; r < rows.length; r++) {
      var rw = rows[r];
      if (rw.length < nc) shortRows++;
      for (i = 0; i < nc; i++) {
        var v = i < rw.length ? rw[i] : null;
        if (v === null || v === undefined || v === '') { b.setMissing(i); continue; }
        if (defs[i].type === T.TIME) {
          var ms = isDate(v) ? v.getTime() : (typeof v === 'number' ? T.numberToTime(v) : T.parseTime(v));
          if (ms !== ms) b.setMissing(i); else b.set(i, ms);
        } else if (defs[i].type === T.NUMBER) {
          /* M-1：与 CSV 同一条入口 parseLoose（Excel 里的 '95%' / '1,234' 文本同样容错） */
          var pl = T.parseLoose(v);
          if (pl.value === null || YMS.num.isMissing(pl.value)) {
            b.setMissing(i);
            if (!pl.isMissing) fails[i]++;             /* 明确缺失（N/A / -）不算解析失败 */
          } else {
            b.set(i, pl.value);
            if (pl.from === 'percent' || pl.from === 'thousands') {
              if (!rawTexts[i]) rawTexts[i] = [];
              rawTexts[i][r] = String(v).trim();
            }
          }
        } else {
          b.set(i, isDate(v) ? T.formatTime(v.getTime(), 'datetime') : String(v));
        }
      }
      b.endRow();
    }
    var df = b.finish();
    for (i = 0; i < nc; i++) {                       /* M-1：原值挂到数值列（表格显示原文） */
      if (rawTexts[i] && df.cols[i] && df.cols[i].type === T.NUMBER) df.cols[i].rawText = rawTexts[i];
    }

    for (i = 0; i < nc; i++) {
      if (defs[i].type === T.NUMBER && df.rowCount && fails[i] / df.rowCount > 0.1) {
        warnings.push('列「' + defs[i].name + '」数值解析失败 ' + fmtInt(fails[i]) + ' / ' + fmtInt(df.rowCount) +
          ' 行（>10%），失败值已记为缺失值；如需保留原文请改用 CSV 导入');
      }
    }
    if (shortRows) warnings.push('有 ' + fmtInt(shortRows) + ' 行少于表头列数，缺少的单元格已记为缺失值');
    return {
      df: df, header: header, defs: defs, warnings: warnings, sampleStats: stats,
      dupHeader: uniqHeader.count ? uniqHeader : null       /* M-4：重复列名改名报告 */
    };
  }

  /**
   * ArrayBuffer（xlsx/xls 内容）→ 表格结果
   * @param {string} fileName @param {ArrayBuffer|Uint8Array} buffer @param {number} started
   * @returns {Result}
   */
  function importArrayBuffer(fileName, buffer, started, opts) {
    started = started || nowMs();
    var X = global.XLSX;
    if (!X || typeof X.read !== 'function') {
      return fail('Excel 解析库未加载（vendor/xlsx.full.min.js）', started, 'table');
    }
    try {
      var wb = X.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
      if (!wb || !wb.SheetNames || !wb.SheetNames.length) return fail('Excel 文件没有任何工作表', started, 'table');
      var sheetName = wb.SheetNames[0];
      var ws = wb.Sheets[sheetName];
      var aoa = X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      var table = aoaToTable(aoa, SAMPLE_ROWS);
      /* M-3 情形 A：空工作表 / 没有表头 → 取消导入，当前表原样保留（与 CSV 同一文案口径） */
      if (emptyKindOf(table.df) === 'empty') {
        return noDataResult('工作表「' + sheetName + '」没有可导入的数据（0 行 × 0 列），已取消导入，当前数据未受影响',
          started, 'table');
      }
      var meta = applyTable(
        { df: table.df, warnings: table.warnings, delimiter: '', elapsedMs: 0, dupHeader: table.dupHeader },
        fileName, (buffer && buffer.byteLength) || 0, started,
        'Excel 工作表「' + sheetName + '」，首行为表头', 0, opts);
      meta.sheetName = sheetName;
      meta.sampleStats = table.sampleStats;
      return { ok: true, kind: 'table', df: table.df, meta: meta, elapsedMs: meta.elapsedMs };
    } catch (e) {
      console.error('[YMS.Importer] Excel 解析失败', e);
      return fail(e && e.message ? e.message : String(e), started, 'table');
    }
  }

  /**
   * 流式导入 Excel 文件（先读为 ArrayBuffer）
   * @param {File} file @param {number} started @returns {Promise<Result>}
   */
  function importExcelFile(file, started, opts) {
    var prog = (U && U.progress) ? U.progress : null;
    var big = (file.size || 0) > BIG_FILE_BYTES;
    if (big && prog) prog.open('正在导入 Excel', '读取工作簿…');
    return readArrayBuffer(file).then(function (buf) {
      if (big && prog) { prog.update(60, '解析工作表…'); }
      var res = importArrayBuffer(file.name, buf, started, opts);
      if (big && prog) prog.close();
      if (!res.ok) return res;
      if (U && U.setStatusTime) U.setStatusTime(fmtDur(res.elapsedMs));
      return res;
    }, function (e) {
      if (big && prog) prog.close();
      console.error('[YMS.Importer] Excel 读取失败', e);
      return fail(e && e.message ? e.message : String(e), started, 'table');
    });
  }

  /* ----------------------------------------------------------- .yms 路径 */
  /**
   * 导入 .yms 模板（成功后切到绘图视图）
   * @param {string} fileName @param {string} text @param {number} started @returns {Result}
   */
  function importTemplateText(fileName, text, started) {
    started = started || nowMs();
    var Tmpl = YMS.YmsTemplate;
    if (!Tmpl || typeof Tmpl.load !== 'function') return fail('.yms 模板模块未加载', started, 'yms');
    /* M-3 情形 A：0 字节 / 纯空白 .yms → 取消导入（validate 也会拒，但这里给统一口径中文提示 + 明确「当前数据未受影响」） */
    if (!text || String(text).trim() === '') {
      return noDataResult('这份 .yms 模板没有可导入的数据（0 行 × 0 列），已取消导入，当前数据未受影响', started, 'yms');
    }
    var res = Tmpl.load(text);
    if (!res || !res.ok) {
      return fail((res && res.error) || '模板内容无效', started, 'yms');
    }
    var df = res.df;
    var headerOnly = (emptyKindOf(df) === 'headerOnly');   /* M-3 情形 B：模板只有列定义、0 行数据 */
    var elapsed = nowMs() - started;
    var meta = res.meta || {};
    meta.elapsedMs = elapsed;
    meta.fileName = meta.fileName || fileName;
    meta.fileSize = byteLen(text);
    meta.emptyKind = headerOnly ? 'headerOnly' : 'ok';

    setStatus('已恢复模板 ' + (fileName || '') + '：' + fmtInt(df.rowCount) + ' 行 × ' + df.cols.length + ' 列' +
      (headerOnly ? '（仅列定义，0 行数据）' : ''), headerOnly ? 'warn' : 'ok');
    if (U && U.setStatusTime) U.setStatusTime(fmtDur(elapsed));
    return { ok: true, kind: 'yms', df: df, meta: meta, elapsedMs: elapsed };
  }

  /**
   * 导入 .yms 文件（FileReader 读文本）
   * @param {File} file @param {number} started @returns {Promise<Result>}
   */
  function importTemplateFile(file, started) {
    return readText(file).then(function (text) {
      return importTemplateText(file.name, text, started);
    }, function (e) {
      console.error('[YMS.Importer] 模板读取失败', e);
      return fail(e && e.message ? e.message : String(e), started, 'yms');
    });
  }

  /* ----------------------------------------------------------- 公开 API */
  /**
   * 按扩展名分流导入单个文件
   * @param {File} file
   * @param {{asNewTable?:boolean, quiet?:boolean}} [opts] 迭代 14：多文件导入时追加为新表
   * @returns {Promise<{ok:boolean, kind:string|null, df:object|null, meta:object|null, elapsedMs:number, error?:string}>}
   */
  function importFile(file, opts) {
    var started = nowMs();
    if (!file || !file.name) return Promise.resolve(fail('没有选择文件', started, null));
    var ext = extOf(file.name);
    try {
      if (ext === 'csv' || ext === 'txt' || ext === 'tsv' || ext === '') return importCsvFile(file, started, opts);
      if (ext === 'xls' || ext === 'xlsx') return importExcelFile(file, started, opts);
      if (ext === 'yms') return importTemplateFile(file, started);
      return Promise.resolve(fail('不支持的文件类型 .' + ext + '（支持 .csv / .txt / .xls / .xlsx / .yms）', started, null));
    } catch (e) {
      console.error('[YMS.Importer] 导入异常', e);
      closeProgress();
      return Promise.resolve(fail(e && e.message ? e.message : String(e), started, null));
    }
  }

  /**
   * 文件列表导入（迭代 14：**逐个导入全部受支持文件，每个文件一张表**）
   *   · 全部成功 → 激活第一张新表
   *   · 部分失败（含不受支持类型 / .yms 模板）→ 成功的照样入表，并用 warn toast 汇总失败文件名
   *   · 只选了 1 个文件 → 走单文件路径（覆盖当前表，行为与迭代 13 完全一致）
   *   · 多文件里的 .yms 模板（含整套数据与格式）不参与合并，记入失败汇总并提示单独导入
   * @param {FileList|Array<File>} fileList
   * @returns {Promise<Result>}
   */
  function importFiles(fileList) {
    var files = [], i;
    if (!fileList) return Promise.resolve(fail('没有选择文件', nowMs(), null));
    if (typeof fileList.length === 'number') {
      for (i = 0; i < fileList.length; i++) files.push(fileList[i]);
    } else if (fileList.name) {
      files.push(fileList);
    }
    if (!files.length) return Promise.resolve(fail('没有选择文件', nowMs(), null));

    var supported = [], badList = [];
    for (i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || !f.name) continue;
      if (SUPPORTED[extOf(f.name)]) supported.push(f);
      else badList.push({ name: f.name, error: '不支持的文件类型 .' + extOf(f.name) });
    }
    if (!supported.length) {
      return Promise.resolve(fail('所选文件类型均不受支持（支持 .csv / .txt / .xls / .xlsx / .yms）', nowMs(), null));
    }
    /* 单个文件：完全沿用原路径（含 .yms 模板恢复语义） */
    if (files.length === 1) return importFile(supported[0], { asNewTable: false });

    var started = nowMs();
    var okList = [];
    var chain = Promise.resolve();
    supported.forEach(function (f2) {
      chain = chain.then(function () {
        if (extOf(f2.name) === 'yms') {
          badList.push({ name: f2.name, error: '.yms 模板含整套数据与格式，请单独导入' });
          return null;
        }
        return importFile(f2, { asNewTable: true, quiet: true }).then(function (r) {
          if (r && r.ok) okList.push({ name: f2.name, result: r });
          else badList.push({ name: f2.name, error: (r && r.error) || '导入失败' });
        }, function (e) {
          badList.push({ name: f2.name, error: (e && e.message) ? e.message : String(e) });
        });
      });
    });

    return chain.then(function () {
      var elapsed = nowMs() - started;
      var names = okList.map(function (o) { return o.name; });
      /* 全部成功 → 激活第一张（多表导入后视图停在第一张，避免停在最后一张） */
      if (okList.length && !badList.length && okList[0].result && okList[0].result.meta) {
        var firstId = okList[0].result.meta.tableId;
        if (firstId && YMS.Store.setActiveTable) YMS.Store.setActiveTable(firstId);
      }
      if (!okList.length) {
        return fail('所选文件均导入失败：' + badList.map(function (b) { return b.name; }).join('、'), started, 'table');
      }
      var totalRows = 0;
      okList.forEach(function (o) { totalRows += (o.result.meta && o.result.meta.rowCount) || 0; });
      if (badList.length) {
        toast('已导入 ' + okList.length + ' 张表（' + fmtInt(totalRows) + ' 行），' + badList.length +
          ' 个文件失败：<b>' + esc(badList.map(function (b) { return b.name; }).join('、')) + '</b>', 'warn', 6000);
        console.warn('[YMS.Importer] 多文件导入失败清单：', badList);
      } else {
        toast('已导入 <b>' + okList.length + '</b> 张表（' + fmtInt(totalRows) + ' 行）· 见左侧表格列表', 'ok', 4200);
      }
      setStatus('已导入 ' + okList.length + ' 张表：' + names.join('、') +
        (badList.length ? '（' + badList.length + ' 个失败）' : ''), badList.length ? 'warn' : 'ok');
      if (U && U.setStatusTime) U.setStatusTime(fmtDur(elapsed));

      var last = okList[okList.length - 1].result;
      return {
        ok: true, kind: 'table', df: last.df, meta: last.meta, elapsedMs: elapsed,
        tables: okList.map(function (o) { return o.result.meta; }),
        failed: badList, count: okList.length
      };
    });
  }

  /**
   * 文本导入（同步）：测试 / 示例数据 / 粘贴内容
   * @param {string} fileName @param {string} text
   * @returns {Result}
   */
  function importText(fileName, text) {
    var started = nowMs();
    try {
      var res = YMS.CsvParser.parseText(text, { delimiter: 'auto', sampleRows: SAMPLE_ROWS });
      if (!res || !res.df) return fail((res && res.error) || '解析失败', started, 'table');
      /* M-3 情形 A：0 行 × 0 列（0 字节 / 纯空行）→ 取消导入，当前表原样保留 */
      var empty = guardEmpty(res.df, started, 'table');
      if (empty) return empty;
      var meta = applyTable(res, fileName || '未命名.csv', byteLen(text), started,
        '文本导入，' + delimCn(res.delimiter) + '分隔', res.rowsPerSec);
      return { ok: true, kind: 'table', df: res.df, meta: meta, elapsedMs: res.elapsedMs };
    } catch (e) {
      console.error('[YMS.Importer] 文本导入失败', e);
      return fail(e && e.message ? e.message : String(e), started, 'table');
    }
  }

  /**
   * 载入内置示例数据（YMS.sampleData.text，文件名 sample_yield_data.csv）
   * @returns {Result}
   */
  function importSample() {
    var sd = YMS.sampleData;
    if (!sd || !sd.text) {
      return fail('内置示例数据不可用（js/data/sample-data.embedded.js 未加载）', nowMs(), 'table');
    }
    return importText(sd.name || 'sample_yield_data.csv', sd.text);
  }

  /** 创建 / 复用隐藏的文件选择框 */
  function ensureInput() {
    if (_input && _input.parentNode) return _input;
    var input = U.el('input', {
      type: 'file',
      accept: '.csv,.txt,.tsv,.xls,.xlsx,.yms',
      multiple: true,
      style: { display: 'none' }
    });
    input.addEventListener('change', function () {
      var files = this.files;
      try {
        importFiles(files).then(function (res) {
          if (res && !res.ok) console.warn('[YMS.Importer] 导入未完成：', res.error);
        }, function (e) { console.error('[YMS.Importer] 导入流程异常', e); });
      } catch (e) {
        console.error('[YMS.Importer] 导入流程异常', e);
      }
      this.value = '';                      /* 允许再次选择同一文件 */
    });
    document.body.appendChild(input);
    _input = input;
    return input;
  }

  /**
   * 打开「Data Import」文件选择框
   * @returns {void}
   */
  function openDialog() {
    try {
      var input = ensureInput();
      input.value = '';
      input.click();
    } catch (e) {
      console.error('[YMS.Importer] 无法打开文件选择框', e);
      toast('无法打开文件选择框：' + esc(e && e.message ? e.message : e), 'error');
    }
  }

  YMS.Importer = {
    openDialog: openDialog,
    importFile: importFile,
    importFiles: importFiles,
    importText: importText,
    importSample: importSample,
    importArrayBuffer: function (fileName, buffer) { return importArrayBuffer(fileName, buffer, nowMs()); },
    /* 便于其它模块/自测复用 */
    SUPPORTED_EXT: SUPPORTED,
    extOf: extOf,
    aoaToTable: aoaToTable
  };
})(typeof window !== 'undefined' ? window : this);
