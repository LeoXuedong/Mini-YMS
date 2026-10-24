/* ==========================================================================
   YMS · data/exporter.js
   职责：把当前视图数据导出为 CSV / Excel（xlsx），并提供「Data Outport」确认对话框
   依赖：YMS.util（modal / toast / downloadText / downloadBlob / fmtInt / nowStamp / el）
         YMS.Store（getView / state）· SheetJS 全局 XLSX（vendor 本地，仅 Excel 用）
   要点：
     1) 导出内容以 YMS.Store.getView() 为准 —— 与「数据显示区」完全一致：
        已应用缺失值预处理、条件筛选、行级多级排序与列小数位格式化；
     2) 首列为 '#' 行号（视图行号，1 基；分页导出时连续编号）；
     3) CSV 按 RFC4180 转义（含 , " CR LF 的字段用双引号包裹，内部 " 写成 ""），
        行分隔符 CRLF；下载时补 UTF-8 BOM 以便 Excel 正确识别中文表头；
     4) Excel 用 SheetJS 写 XLSX：数值写 number、时间列写 Date（Excel 日期单元格）、缺失写空；
     5) 无数据时 toast 提示并返回（不抛异常）。
   对外：
     YMS.Exporter.toCSV({range:'view'|'page', page, pageSize}) -> string （'' = 无可导出数据）
     YMS.Exporter.toArrayBuffer() -> ArrayBuffer|null
     YMS.Exporter.exportCSV(fileName?, range?) / exportXLSX(fileName?, range?)
     YMS.Exporter.saveData()                     // 菜单 Save Data：默认 CSV
     YMS.Exporter.openOutportDialog()            // 菜单 Data Outport：确认对话框
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;
  var U = YMS.util;

  var EOL = '\r\n';                           /* RFC4180 行结束符 */
  var BOM = '\uFEFF';

  function toast(html, kind, ms) { if (U && U.toast) U.toast(html, kind, ms); }
  function fmtInt(n) { return (U && U.fmtInt) ? U.fmtInt(n) : String(n); }
  function setStatus(m, k) { if (U && U.setStatus) U.setStatus(m, k); }
  function esc(s) { return (U && U.escapeHtml) ? U.escapeHtml(s) : String(s); }

  /* --------------------------------------------------------------- 辅助 */
  /** 表名（用于文件名 / 工作表名） */
  function tableName() {
    var n = YMS.Store && YMS.Store.state ? (YMS.Store.state.tableName || '') : '';
    if (!n) n = 'YMS-数据';
    return String(n);
  }
  /** 默认文件名 <tableName>-<stamp>.<ext> */
  function defaultFileName(ext) {
    var stamp = (U && U.nowStamp) ? U.nowStamp() : String(Date.now());
    return tableName() + '-' + stamp + '.' + ext;
  }
  /** Excel 工作表名合法化（去非法字符、限 31 字符） */
  function sheetNameOf(name) {
    var s = String(name || 'YMS').replace(/[:\\\/\?\*\[\]]/g, '_');
    if (s.length > 31) s = s.slice(0, 31);
    return s || 'YMS';
  }
  /** 当前页参数（来自 dataSettings） */
  function pageParams() {
    var ds = (YMS.Store && YMS.Store.state && YMS.Store.state.dataSettings) || {};
    return { page: ds.page || 1, pageSize: ds.pageSize || 5000 };
  }

  /* ------------------------------------------------------- CSV 公式注入防护 */
  /* Excel / WPS / Numbers 打开 CSV 时，以 = + - @ 制表符 回车 开头的字段会被
     当成公式求值（CSV injection：=1+1、@SUM(A1)、=cmd|' /C calc'!A0 可执行命令）。
     这类字段做文本化：前置单引号，导入后即按文本显示。
     例外（重要）：符号后面是纯数字的仍是合法数值 —— -2 / +3 / -1e-3 / -0.5 不转义，
     否则 '-2 会污染下游导入与再计算；只有「看起来像公式」的带符号字段
     （-2+3、-cmd|…）才文本化。*/
  var FORMULA_LEAD_RE = /^[=@\t\r]/;
  var SIGNED_NUMBER_RE = /^[+-]\s*(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  function needsTextGuard(s) {
    if (s === '') return false;
    if (FORMULA_LEAD_RE.test(s)) return true;
    var c = s.charAt(0);
    if (c === '-' || c === '+') return !SIGNED_NUMBER_RE.test(s);
    return false;
  }

  /**
   * RFC4180 字段转义（含公式注入文本化）
   * @param {*} v @returns {string}
   */
  function csvField(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (s === '') return '';
    if (needsTextGuard(s)) s = "'" + s;                /* 文本化：Excel 不再求值 */
    if (s.indexOf('"') >= 0) s = s.replace(/"/g, '""');
    if (s.indexOf('"') >= 0 || s.indexOf(',') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
      return '"' + s + '"';
    }
    return s;
  }

  /**
   * 计算导出区间 [start, end)（视图位置）
   * @param {object} view @param {object} opts @returns {{start:number,end:number}}
   */
  function rangeOf(view, opts) {
    if (!view) return { start: 0, end: 0 };
    if (opts.range === 'page') {
      var dp = pageParams();
      var ps = Math.max(1, parseInt(opts.pageSize, 10) || dp.pageSize);
      var pg = Math.max(1, parseInt(opts.page, 10) || dp.page);
      var start = Math.min((pg - 1) * ps, view.count);
      return { start: start, end: Math.min(start + ps, view.count) };
    }
    return { start: 0, end: view.count };
  }

  /* -------------------------------------------------------------- CSV 导出 */
  /**
   * 生成 CSV 文本（不含 BOM）
   * @param {{range?:string, page?:number, pageSize?:number, eol?:string}} [opts]
   * @returns {string} '' 表示当前视图没有可导出的数据
   */
  function toCSV(opts) {
    opts = opts || {};
    try {
      var view = YMS.Store.getView();
      if (!view || !view.count) return '';
      var df = view.df, nc = df.cols.length, ci;
      var rg = rangeOf(view, opts);
      var eol = opts.eol || EOL;

      var head = ['#'];
      for (ci = 0; ci < nc; ci++) head.push(csvField(df.cols[ci].name));
      var lines = [head.join(',')];

      for (var pos = rg.start; pos < rg.end; pos++) {
        var row = [String(pos + 1)];                       /* 首列 # 行号（视图行号） */
        for (ci = 0; ci < nc; ci++) row.push(csvField(view.displayAt(pos, ci)));
        lines.push(row.join(','));
      }
      return lines.join(eol);
    } catch (e) {
      console.error('[YMS.Exporter.toCSV] 生成失败', e);
      toast('导出失败：' + esc(e && e.message ? e.message : e), 'error');
      return '';
    }
  }

  /**
   * 触发 CSV 下载（含 UTF-8 BOM）
   * @param {string} [fileName] @param {string} [range] 'view'|'page'
   * @returns {boolean} 是否成功发起下载
   */
  function exportCSV(fileName, range) {
    var view = YMS.Store.getView();
    if (!view || !view.count) {
      toast('没有可导出的数据行，请先导入数据或调整筛选条件', 'error');
      return false;
    }
    var rg = range === 'page' ? 'page' : 'view';
    var csv = toCSV({ range: rg });
    if (!csv) { toast('没有可导出的数据行，请先导入数据或调整筛选条件', 'error'); return false; }

    var name = fileName || defaultFileName('csv');
    var rows = rg === 'page' ? rangeOf(view, { range: 'page' }).end - rangeOf(view, { range: 'page' }).start : view.count;
    try {
      U.downloadText(name, BOM + csv, 'text/csv');
    } catch (e) {
      console.error('[YMS.Exporter.exportCSV] 下载失败', e);
      toast('导出失败：' + esc(e && e.message ? e.message : e), 'error');
      return false;
    }
    setStatus('已导出 CSV：' + name + '（' + fmtInt(rows) + ' 行 × ' + (view.df.cols.length + 1) + ' 列）', 'ok');
    toast('已导出 CSV：<b>' + esc(name) + '</b>（' + fmtInt(rows) + ' 行）', 'ok');
    return true;
  }

  /* ------------------------------------------------------------ Excel 导出 */
  /**
   * 生成 XLSX ArrayBuffer（视图全部）
   * @returns {ArrayBuffer|null} null 表示失败（已 toast）
   */
  function toArrayBuffer(opts) {
    opts = opts || {};
    var X = global.XLSX;
    if (!X || !X.utils || typeof X.utils.aoa_to_sheet !== 'function' || typeof X.write !== 'function') {
      toast('Excel 导出失败：SheetJS 未加载（vendor/xlsx.full.min.js）', 'error');
      return null;
    }
    try {
      var view = YMS.Store.getView();
      if (!view || !view.count) { toast('没有可导出的数据行，请先导入数据或调整筛选条件', 'error'); return null; }
      var df = view.df, nc = df.cols.length, ci;
      var rg = rangeOf(view, opts);

      var aoa = [['#']];
      for (ci = 0; ci < nc; ci++) aoa[0].push(df.cols[ci].name);

      for (var pos = rg.start; pos < rg.end; pos++) {
        var row = [pos + 1];
        for (ci = 0; ci < nc; ci++) {
          var type = df.cols[ci].type;
          var v = view.valueAt(pos, ci);                    /* 已应用缺失填充 */
          if (v === null || v === undefined) { row.push(null); continue; }
          if (type === T.TIME) row.push(new Date(v));        /* 时间列 → Excel 日期单元格 */
          else if (type === T.NUMBER) row.push(v);
          else row.push(String(v));
        }
        aoa.push(row);
      }

      var ws = X.utils.aoa_to_sheet(aoa);
      var wb = X.utils.book_new();
      var sn = sheetNameOf(tableName());
      if (typeof X.utils.book_append_sheet === 'function') X.utils.book_append_sheet(wb, ws, sn);
      else { wb.SheetNames = wb.SheetNames || []; wb.SheetNames.push(sn); wb.Sheets = wb.Sheets || {}; wb.Sheets[sn] = ws; }
      var out = X.write(wb, { bookType: 'xlsx', type: 'array', cellDates: true });
      return out;
    } catch (e) {
      console.error('[YMS.Exporter.toArrayBuffer] 生成失败', e);
      toast('Excel 导出失败：' + esc(e && e.message ? e.message : e), 'error');
      return null;
    }
  }

  /**
   * 触发 Excel 下载
   * @param {string} [fileName] @param {string} [range] 'view'|'page'
   * @returns {boolean}
   */
  function exportXLSX(fileName, range) {
    var view = YMS.Store.getView();
    if (!view || !view.count) { toast('没有可导出的数据行，请先导入数据或调整筛选条件', 'error'); return false; }
    var ab = toArrayBuffer({ range: range === 'page' ? 'page' : 'view' });
    if (!ab) return false;
    var name = fileName || defaultFileName('xlsx');
    try {
      U.downloadBlob(name, new Blob([ab], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) {
      console.error('[YMS.Exporter.exportXLSX] 下载失败', e);
      toast('导出失败：' + esc(e && e.message ? e.message : e), 'error');
      return false;
    }
    var rg = range === 'page' ? rangeOf(view, { range: 'page' }) : { start: 0, end: view.count };
    setStatus('已导出 Excel：' + name + '（' + fmtInt(rg.end - rg.start) + ' 行 × ' + (view.df.cols.length + 1) + ' 列）', 'ok');
    toast('已导出 Excel：<b>' + esc(name) + '</b>（' + fmtInt(rg.end - rg.start) + ' 行）', 'ok');
    return true;
  }

  /* --------------------------------------------------------- 菜单动作入口 */
  /**
   * 菜单 Save Data：默认导出 CSV（<tableName>-<stamp>.csv）
   * @returns {boolean}
   */
  function saveData() {
    return exportCSV();
  }

  /**
   * 菜单 Data Outport：确认对话框（格式 CSV/Excel + 范围 视图全部/当前页）
   * @returns {void}
   */
  function openOutportDialog() {
    if (!YMS.Store.hasData()) {
      toast('没有可导出的数据，请先通过 Data → Data Import 导入数据', 'error');
      return;
    }
    var view = YMS.Store.getView();
    var count = view ? view.count : 0;
    var dp = pageParams();
    var totalPages = Math.max(1, Math.ceil(count / dp.pageSize));
    var curPage = Math.min(dp.page, totalPages);

    var fmtSel = U.el('select', { class: 'w-100' });
    fmtSel.appendChild(U.el('option', { value: 'csv', text: 'CSV（.csv，默认）' }));
    fmtSel.appendChild(U.el('option', { value: 'xlsx', text: 'Excel（.xlsx）' }));

    var rangeSel = U.el('select', { class: 'w-100' });
    rangeSel.appendChild(U.el('option', {
      value: 'view',
      text: '视图全部（' + fmtInt(count) + ' 行 · 含筛选 / 排序 / 格式）'
    }));
    rangeSel.appendChild(U.el('option', {
      value: 'page',
      text: '当前页（第 ' + curPage + ' / ' + totalPages + ' 页 · ' + fmtInt(dp.pageSize) + ' 行/页）'
    }));

    var body = U.el('div', {}, [
      U.el('div', { class: 'field' }, [
        U.el('label', { text: '导出格式' }),
        U.el('div', { class: 'field-ctl' }, [fmtSel])
      ]),
      U.el('div', { class: 'field' }, [
        U.el('label', { text: '导出范围' }),
        U.el('div', { class: 'field-ctl' }, [rangeSel])
      ]),
      U.el('div', {
        html: '<div style="margin-top:6px;color:#6b7887">当前表格：<b>' + esc(tableName()) + '</b>，' +
          '数据文件：' + esc(YMS.Store.state.fileName || '—') + '<br>' +
          '导出内容与「数据显示区」一致（含缺失值预处理、条件筛选、行级排序与列小数位），首列为 # 行号。</div>'
      })
    ]);

    U.modal({
      title: '导出数据 · Data Outport',
      body: body,
      footer: [
        { text: '取消' },
        {
          text: '导出', cls: 'btn-primary',
          onClick: function (close) {
            var fmt = fmtSel.value, rg = rangeSel.value;
            close();
            if (fmt === 'xlsx') exportXLSX(null, rg);
            else exportCSV(null, rg);
          }
        }
      ]
    });
  }

  YMS.Exporter = {
    toCSV: toCSV,
    toArrayBuffer: toArrayBuffer,
    exportCSV: exportCSV,
    exportXLSX: exportXLSX,
    saveData: saveData,
    openOutportDialog: openOutportDialog,
    /* 便于其它模块/自测复用 */
    csvField: csvField,
    defaultFileName: defaultFileName
  };
})(typeof window !== 'undefined' ? window : this);
