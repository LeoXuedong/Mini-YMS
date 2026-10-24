/* ==========================================================================
   YMS · test/helpers/app.js
   职责：把「常用动作」封成函数 —— 全部走应用自己的公开入口（window.__YMS__ /
         YMS.Exporter / 真实 DOM 点击），不读内部私有变量、不注入业务逻辑。
   约定：所有函数第一个参数是 page（Playwright Page 对象）
   ========================================================================== */
'use strict';

/* ---------------------------------------------------------------- 数据导入 */

/** 导入 CSV 文本 → { ok, error, rows, cols, columns } */
async function importText(page, name, text) {
  return page.evaluate(async function (a) {
    try {
      const r = await window.__YMS__.importText(a[0], a[1]);
      const st = window.__YMS__.getState();
      return {
        ok: !!(r && r.ok), error: r && r.error ? String(r.error) : null,
        rows: st.rowCount, cols: st.colCount, columns: st.columns
      };
    } catch (e) {
      return { ok: false, error: 'THROW ' + (e && e.message), rows: -1, cols: -1, columns: [] };
    }
  }, [name, text]);
}

/** 当前状态快照（行数 / 列数 / 视图行数 / 处理说明 …） */
async function getState(page) {
  return page.evaluate(function () { return window.__YMS__.getState(); });
}

/* ------------------------------------------------------------------ 计算列 */

/** 表达式新建列 → { ok, error, missing, nonFinite, note } */
async function computeColumn(page, name, expr) {
  return page.evaluate(function (a) {
    const r = window.__YMS__.computeColumn(a[0], a[1]);
    return r ? {
      ok: !!r.ok, error: r.error ? String(r.error) : null,
      missing: r.missing, nonFinite: r.nonFinite, note: r.note || ''
    } : { ok: false, error: 'null 返回' };
  }, [name, expr]);
}

/** 列统计（有效/缺失/min/max/mean/stddev；非有限值转成字符串以免 JSON 丢信息） */
async function columnStats(page, col) {
  return page.evaluate(function (c) {
    const st = window.__YMS__.columnStats(c);
    if (!st) return null;
    const S = function (v) { return (typeof v === 'number' && !isFinite(v)) ? String(v) : v; };
    return {
      name: st.name, type: st.type, total: st.total, valid: st.valid, missing: st.missing,
      unique: st.unique, min: S(st.min), max: S(st.max), mean: S(st.mean),
      stddev: S(st.stddev), median: S(st.median), note: st.note ? String(st.note) : null
    };
  }, col);
}

/* -------------------------------------------------------------------- 导出 */

/** 导出 CSV 文本（不含 BOM，与 Exporter.exportCSV 落盘内容一致） */
async function exportCsv(page, opts) {
  return page.evaluate(function (o) { return window.__YMS__.exportCSVString(o || {}); }, opts || {});
}

/**
 * 导出 XLSX 并在页面内用 SheetJS 读回，取某一列的单元格
 * @returns {{ok:boolean, header:string[], colIdx:number, cells:(null|{t,v,w})[]}}
 */
async function xlsxColumn(page, colName) {
  return page.evaluate(function (name) {
    const ab = window.YMS.Exporter.toArrayBuffer({});
    if (!ab) return { ok: false, error: 'toArrayBuffer 返回 null', header: [], colIdx: -1, cells: [] };
    const X = window.XLSX;
    const wb = X.read(ab, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws['!ref']) return { ok: false, error: '工作表为空', header: [], colIdx: -1, cells: [] };
    const rng = X.utils.decode_range(ws['!ref']);
    const addr = function (r, c) { return X.utils.encode_cell({ r: r, c: c }); };
    const header = [];
    for (let c = rng.s.c; c <= rng.e.c; c++) {
      const cell = ws[addr(rng.s.r, c)];
      header.push(cell && cell.v !== undefined ? String(cell.v) : '');
    }
    const ci = header.indexOf(name);
    if (ci < 0) return { ok: false, error: '表头里找不到列 ' + name, header: header, colIdx: -1, cells: [] };
    const cells = [];
    for (let r = rng.s.r + 1; r <= rng.e.r; r++) {
      const cell = ws[addr(r, ci)];
      if (!cell) { cells.push(null); continue; }
      cells.push({
        t: cell.t,
        v: (typeof cell.v === 'number' && !isFinite(cell.v)) ? String(cell.v)
          : (cell.v === undefined ? null : (cell.v instanceof Date ? cell.v.toISOString() : cell.v)),
        w: cell.w === undefined ? null : String(cell.w)
      });
    }
    return { ok: true, header: header, colIdx: ci, cells: cells, sheet: wb.SheetNames[0] };
  }, colName);
}

/* ---------------------------------------------------------------- 条件筛选 */

/** 数据处理说明（Store.state.ui.processingNotes）最新若干条 */
async function notes(page, n) {
  const st = await getState(page);
  const arr = st.processingNotes || [];
  return typeof n === 'number' ? arr.slice(-n) : arr;
}

/** 确保数据设置区展开（默认收起；收起时面板内容不可见） */
async function ensurePanelOpen(page) {
  return page.evaluate(function () {
    const y = window.__YMS__;
    if (y.dataSettingsPanel().collapsed) y.toggleDataSettings();
    return y.dataSettingsPanel();
  });
}

/**
 * 点「+」新增一条筛选条件：会弹出内联选择行（.inline-picker）
 * → 选列 / 运算符 / 值 → 点「确定」提交（与用户操作完全同路径）
 * @param {object} [patch] {col, op, value, value2}
 * @returns {{ok:boolean, rows:number, index:number, error?:string}}
 */
async function addFilterRow(page, patch) {
  const p = patch || {};
  const opened = await page.evaluate(function () {
    const btn = document.querySelector('#data-settings-body [data-act="add-filter"]');
    if (!btn) return { ok: false, error: '找不到新增筛选按钮 [data-act="add-filter"]' };
    btn.click();
    return { ok: true };
  });
  if (!opened.ok) return { ok: false, rows: 0, index: -1, error: opened.error };
  try {
    await page.waitForSelector('#data-settings-body .inline-picker', { timeout: 4000 });
  } catch (e) {
    return { ok: false, rows: 0, index: -1, error: '内联选择行未出现（.inline-picker）' };
  }
  const res = await page.evaluate(function (pp) {
    const pick = document.querySelector('#data-settings-body .inline-picker');
    if (!pick) return { ok: false, error: '内联选择行未出现' };
    const fire = function (el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); };
    if (pp.col !== undefined) { const c = pick.querySelector('.pick-col'); c.value = pp.col; fire(c, 'change'); }
    if (pp.op !== undefined) { const o = pick.querySelector('.pick-op'); o.value = pp.op; fire(o, 'change'); }
    if (pp.value !== undefined) { const v = pick.querySelector('.pick-val'); v.disabled = false; v.value = pp.value; fire(v, 'input'); }
    if (pp.value2 !== undefined) { const v2 = pick.querySelector('.pick-val2'); v2.disabled = false; v2.value = pp.value2; fire(v2, 'input'); }
    const ok = pick.querySelector('.pick-ok');
    if (!ok) return { ok: false, error: '内联选择行没有确定键' };
    ok.click();
    return { ok: true };
  }, p);
  await page.waitForTimeout(150);
  const rows = await page.evaluate(function () {
    return document.querySelectorAll('#data-settings-body .filter-row').length;
  });
  return { ok: res.ok, rows: rows, index: rows - 1, error: res.error || null };
}

/** 设置某条筛选行的列 / 运算符 / 值（走真实 input/change 事件，与用户操作同路径） */
async function setFilterRow(page, idx, patch) {
  return page.evaluate(function (a) {
    const i = a.idx, p = a.patch;
    const row = document.querySelectorAll('#data-settings-body .filter-row')[i];
    if (!row) return { ok: false, error: '没有第 ' + i + ' 条筛选行' };
    const fire = function (el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); };
    const done = {};
    if (p.col !== undefined) {
      const sel = row.querySelector('.flt-col');
      sel.value = p.col; fire(sel, 'change'); done.col = sel.value;
    }
    if (p.op !== undefined) {
      const sel = row.querySelector('.flt-op');
      sel.value = p.op; fire(sel, 'change'); done.op = sel.value;
    }
    if (p.value !== undefined) {
      const inp = row.querySelector('.flt-val');
      inp.value = p.value; fire(inp, 'input'); fire(inp, 'change'); done.value = inp.value;
    }
    if (p.value2 !== undefined) {
      const inp2 = row.querySelector('.flt-val2');
      inp2.value = p.value2; fire(inp2, 'input'); done.value2 = inp2.value;
    }
    return { ok: true, applied: done };
  }, { idx: idx, patch: patch || {} });
}

/** 读某条筛选行的可见状态（提示文案 / 是否可见 / data-pending / 值） */
async function readFilterRow(page, idx) {
  return page.evaluate(function (i) {
    const row = document.querySelectorAll('#data-settings-body .filter-row')[i];
    if (!row) return null;
    const hint = row.querySelector('.flt-hint');
    const val = row.querySelector('.flt-val');
    const op = row.querySelector('.flt-op');
    const col = row.querySelector('.flt-col');
    return {
      col: col ? col.value : null, op: op ? op.value : null, value: val ? val.value : null,
      valueDisabled: val ? !!val.disabled : null,
      pending: row.getAttribute('data-pending'),
      hintText: hint ? String(hint.textContent).trim() : null,
      hintHidden: hint ? hint.hasAttribute('hidden') : null,
      hintVisible: !!(hint && hint.offsetParent !== null),
      hintTitle: hint ? hint.getAttribute('title') : null
    };
  }, idx);
}

/** 点面板里的 SUBMIT（应用设置 → 写处理说明 + toast） */
async function submitSettings(page) {
  await page.evaluate(function () {
    const btn = document.querySelector('#data-settings-body [data-act="submit"]');
    if (!btn) throw new Error('找不到提交按钮 [data-act="submit"]');
    btn.click();
  });
  await page.waitForTimeout(150);
}

/** 编程入口设置筛选（用于「同一状态快速对照」，语义等价）：返回视图行数 */
async function setFilters(page, filters) {
  return page.evaluate(function (f) {
    window.__YMS__.applyDataSettings({ preprocess: { missing: 'none', filters: f } });
    return window.__YMS__.getState().viewCount;
  }, filters);
}

/** 清空全部筛选条件 */
async function clearFilters(page) {
  return setFilters(page, []);
}

/* ------------------------------------------------------------ CSV 解析（Node） */

/** RFC4180 解析（支持引号包裹、内部 "" 转义、CRLF / LF / 字段内换行） */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (inQ) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { if (text.charAt(i + 1) === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

module.exports = {
  importText: importText,
  getState: getState,
  computeColumn: computeColumn,
  columnStats: columnStats,
  exportCsv: exportCsv,
  xlsxColumn: xlsxColumn,
  notes: notes,
  ensurePanelOpen: ensurePanelOpen,
  addFilterRow: addFilterRow,
  setFilterRow: setFilterRow,
  readFilterRow: readFilterRow,
  submitSettings: submitSettings,
  setFilters: setFilters,
  clearFilters: clearFilters,
  parseCsv: parseCsv
};
