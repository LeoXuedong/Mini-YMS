/* ==========================================================================
   YMS · test/cases/m3-empty-import.js
   断言对象：M-3 空导入语义（修复于 2026-10-21）
   命中代码：js/data/importer.js → emptyKindOf / noDataResult / guardEmpty / applyTable
   三种情形：
     A 0 行 × 0 列（0 字节 / 纯空行 / 纯空白）→ ok:false + 中文提示，**不碰 Store**（当前表原样保留）
     B 0 行但有列定义（只有表头）→ 仍 ok:true（用户先建结构），提示降级为 warn「仅列定义，0 行数据」
     C ≥1 行数据 → 行为与改动前完全一致
   关键证据：先导入 3 行 → 再导入 0 字节 → 行数 / 列名 / 单元格 / 表名 / 文件名 / importedAt /
             处理说明 / 表格数 全部与导入前逐项相等（Store.setData 一次都没被调用）
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

const CSV3 = 'Lot,Wafer,Yield\nL1,1,0.9\nL2,2,0.8\nL3,3,0.7\n';
const HEADER_ONLY = 'Lot,Wafer,Yield\n';

/* 状态快照：只走公开入口（__YMS__）+ Store.state 的公开字段 */
function snapshot(page) {
  return page.evaluate(function () {
    const y = window.__YMS__;
    const st = y.getState();
    const v = y.getView();
    const S = window.YMS.Store.state;
    return {
      rows: st.rowCount, cols: st.colCount, viewCount: st.viewCount,
      hasData: st.hasData, mode: st.mode,
      columns: st.columns.map(function (c) { return c.name; }),
      types: st.columns.map(function (c) { return c.type; }),
      tableName: st.tableName, fileName: st.fileName,
      notes: st.processingNotes.slice(),
      tables: y.tables(),
      importedAt: S.importedAt, fileSize: S.fileSize,
      sample: v ? v.sample : null
    };
  });
}

/* 导入（返回 ok / error / reason 及导入后的状态） */
function doImport(page, name, text) {
  return page.evaluate(function (a) {
    const r = window.__YMS__.importText(a[0], a[1]);
    const st = window.__YMS__.getState();
    return {
      ok: !!(r && r.ok), error: r && r.error ? String(r.error) : null,
      reason: r && r.reason ? String(r.reason) : null,
      hasDf: !!(r && r.df), meta: r && r.meta ? { rowCount: r.meta.rowCount, colCount: r.meta.colCount, emptyKind: r.meta.emptyKind || null } : null,
      rows: st.rowCount, cols: st.colCount, viewCount: st.viewCount, hasData: st.hasData
    };
  }, [name, text]);
}

/* 读当前 toast / 状态栏（toast 5s 后自毁，导入后立即读） */
function chrome(page) {
  return page.evaluate(function () {
    const ts = Array.prototype.slice.call(document.querySelectorAll('#toast-root .toast'));
    const msg = document.getElementById('status-msg');
    return {
      toasts: ts.map(function (n) { return { cls: n.className, text: String(n.textContent).trim() }; }),
      status: msg ? String(msg.textContent).trim() : '',
      statusCls: msg ? msg.className : ''
    };
  });
}

function lastToast(c) { return c.toasts.length ? c.toasts[c.toasts.length - 1] : { cls: '', text: '' }; }

module.exports = {
  id: 'm3-empty-import',
  title: 'M-3 空导入语义：0 行 × 0 列不报成功、不覆盖当前表；只有表头降级为 warn',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ================= 情形 A-1：空页首次导入 0 字节 ================= */
    const a1 = await doImport(page, 'empty.csv', '');
    const c1 = await chrome(page);
    t.eq('A1 空页导入 0 字节 → ok === false', a1.ok, false);
    t.eq('A1 返回行数 = 0', a1.rows, 0);
    t.eq('A1 返回列数 = 0', a1.cols, 0);
    t.eq('A1 没有 df（不产出数据对象）', a1.hasDf, false);
    t.eq('A1 hasData = false（仍是空态）', a1.hasData, false);
    t.ok('A1 错误文案含「没有可导入的数据」', !!a1.error && a1.error.indexOf('没有可导入的数据') >= 0, a1.error);
    t.ok('A1 错误文案含「0 行 × 0 列」', !!a1.error && a1.error.indexOf('0 行 × 0 列') >= 0, a1.error);
    t.ok('A1 错误文案含「已取消导入」', !!a1.error && a1.error.indexOf('已取消导入') >= 0, a1.error);
    t.ok('A1 错误文案含「当前数据未受影响」', !!a1.error && a1.error.indexOf('当前数据未受影响') >= 0, a1.error);
    t.eq('A1 reason 标记 = empty-data', a1.reason, 'empty-data');
    t.ok('A1 toast 含「没有可导入的数据」', lastToast(c1).text.indexOf('没有可导入的数据') >= 0, c1.toasts);
    t.ok('A1 toast 是 error 样式（不是成功的 is-ok）', /is-error/.test(lastToast(c1).cls), lastToast(c1).cls);
    t.ok('A1 状态栏含「当前数据未受影响」', c1.status.indexOf('当前数据未受影响') >= 0, c1.status);
    t.ok('A1 状态栏是 error 样式', /is-error/.test(c1.statusCls), c1.statusCls);
    const tb1 = await page.evaluate(function () { return window.__YMS__.tables().length; });
    t.eq('A1 没有凭空建出一张空表', tb1, 0);

    /* ================= 前置：导入 3 行正常数据 ================= */
    const base = await doImport(page, 'keep.csv', CSV3);
    t.ok('前置 导入 3 行 × 3 列成功', base.ok && base.rows === 3 && base.cols === 3, base);
    const before = await snapshot(page);
    t.eq('前置 视图行数 = 3', before.viewCount, 3);
    t.eq('前置 列名 = Lot / Wafer / Yield', before.columns.join(','), 'Lot,Wafer,Yield');
    t.eq('前置 表格数 = 1', before.tables.length, 1);

    /* ================= 情形 A-2（关键）：0 字节不覆盖当前表 ================= */
    const a2 = await doImport(page, 'empty.csv', '');
    const after = await snapshot(page);
    t.eq('A2 再导 0 字节 → ok === false', a2.ok, false);
    t.eq('A2 【关键】viewCount 仍为 3', a2.viewCount, 3);
    t.eq('A2 【关键】rowCount 仍为 3', a2.rows, 3);
    t.eq('A2 【关键】colCount 仍为 3', a2.cols, 3);
    t.eq('A2 【关键】hasData === true', a2.hasData, true);
    t.eq('A2 列名与导入前完全一致', after.columns.join(','), before.columns.join(','));
    t.eq('A2 列类型与导入前完全一致', after.types.join(','), before.types.join(','));
    t.eq('A2 前 3 行单元格与导入前完全一致', JSON.stringify(after.sample), JSON.stringify(before.sample));
    t.eq('A2 表名未变', after.tableName, before.tableName);
    t.eq('A2 文件名未变（仍是 keep.csv）', after.fileName, before.fileName);
    t.eq('A2 importedAt 未变（证明 Store.setData 没被调用）', after.importedAt, before.importedAt);
    t.eq('A2 fileSize 未变', after.fileSize, before.fileSize);
    t.eq('A2 处理说明条数未变（没被清空）', after.notes.length, before.notes.length);
    t.eq('A2 表格列表未变（仍 1 张）', after.tables.length, before.tables.length);
    t.eq('A2 当前表 id 仍指向原表', after.tables[0].id, before.tables[0].id);
    t.eq('A2 视图模式未变', after.mode, before.mode);

    /* ================= 情形 A-3：纯空行 '\n\n\n' ================= */
    const a3 = await doImport(page, 'blank.csv', '\n\n\n');
    const after3 = await snapshot(page);
    t.eq("A3 纯空行 '\\n\\n\\n' → ok === false", a3.ok, false);
    t.eq('A3 视图行数仍为 3', a3.viewCount, 3);
    t.eq('A3 列名仍为 Lot / Wafer / Yield', after3.columns.join(','), 'Lot,Wafer,Yield');
    t.eq('A3 单元格与导入前一致', JSON.stringify(after3.sample), JSON.stringify(before.sample));
    t.ok('A3 提示文案含「没有可导入的数据」', !!a3.error && a3.error.indexOf('没有可导入的数据') >= 0, a3.error);

    /* ================= 情形 A-4：纯空白（空格 + 换行） ================= */
    const a4 = await doImport(page, 'spaces.csv', '   \n  \n');
    const after4 = await snapshot(page);
    t.eq('A4 纯空白文件 → ok === false', a4.ok, false);
    t.eq('A4 视图行数仍为 3', a4.viewCount, 3);
    t.eq('A4 importedAt 仍未变', after4.importedAt, before.importedAt);

    /* ================= 情形 B：只有表头（0 行数据，有列定义） ================= */
    const b1 = await doImport(page, 'header.csv', HEADER_ONLY);
    const cb = await chrome(page);
    const afterB = await snapshot(page);
    t.eq('B 只有表头 → ok === true（合法性保留）', b1.ok, true);
    t.eq('B 行数 = 0', b1.rows, 0);
    t.eq('B 列数 = 3（列定义保留）', b1.cols, 3);
    t.eq('B hasData = false（表里确实没有数据）', b1.hasData, false);
    t.eq('B 列名仍为 Lot / Wafer / Yield', afterB.columns.join(','), 'Lot,Wafer,Yield');
    t.ok('B toast 含「仅列定义」或「0 行数据」',
      lastToast(cb).text.indexOf('仅列定义') >= 0 || lastToast(cb).text.indexOf('0 行数据') >= 0, cb.toasts);
    t.ok('B toast 是 warn 样式（不再冒充成功）', /is-warn/.test(lastToast(cb).cls), lastToast(cb).cls);
    t.ok('B 状态栏含「仅列定义，0 行数据」', cb.status.indexOf('仅列定义，0 行数据') >= 0, cb.status);
    t.ok('B 状态栏是 warn 样式', /is-warn/.test(cb.statusCls), cb.statusCls);
    t.ok('B 处理说明记下「仅列定义，0 行数据」',
      afterB.notes.some(function (n) { return n.indexOf('仅列定义，0 行数据') >= 0; }), afterB.notes);
    t.eq('B 允许覆盖当前表（行数变 0，用户确实换了一份新结构）', afterB.rows, 0);

    /* ================= 情形 C：正常数据行为不变 ================= */
    const c1i = await doImport(page, 'normal.csv', CSV3);
    const cc = await chrome(page);
    const afterC = await snapshot(page);
    t.eq('C 正常 3 行 → ok === true', c1i.ok, true);
    t.eq('C 行数 = 3', c1i.rows, 3);
    t.eq('C 列数 = 3', c1i.cols, 3);
    t.eq('C 视图行数 = 3', c1i.viewCount, 3);
    t.eq('C 列名不变', afterC.columns.join(','), 'Lot,Wafer,Yield');
    t.ok('C toast 含「已导入」且是成功样式', /is-ok/.test(lastToast(cc).cls) && lastToast(cc).text.indexOf('已导入') >= 0, cc.toasts);
    t.ok('C 处理说明记录「导入 normal.csv：3 行 × 3 列」',
      afterC.notes.some(function (n) { return n.indexOf('导入 normal.csv：3 行 × 3 列') >= 0; }), afterC.notes);

    /* ================= 情形 A（Excel / .yms 路径）：同样不报成功、不覆盖 ================= */
    const d0 = await doImport(page, 'keep2.csv', CSV3);
    const beforeD = await snapshot(page);
    t.ok('D0 前置 重新导入 3 行成功', d0.ok && d0.rows === 3, d0);

    /* Excel：空工作表（无表头、无数据）→ 0 行 × 0 列 */
    const xlsx = await page.evaluate(function () {
      const X = window.XLSX;
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([[]]), 'S1');
      const buf = X.write(wb, { type: 'array', bookType: 'xlsx' });
      const r = window.YMS.Importer.importArrayBuffer('empty.xlsx', buf);
      const st = window.__YMS__.getState();
      return {
        ok: !!(r && r.ok), error: r && r.error ? String(r.error) : null,
        rows: st.rowCount, cols: st.colCount, viewCount: st.viewCount,
        sheets: wb.SheetNames
      };
    });
    const afterX = await snapshot(page);
    t.eq('D1 Excel 空工作表 → ok === false', xlsx.ok, false);
    t.ok('D1 提示含「没有可导入的数据」', !!xlsx.error && xlsx.error.indexOf('没有可导入的数据') >= 0, xlsx.error);
    t.ok('D1 提示含「当前数据未受影响」', !!xlsx.error && xlsx.error.indexOf('当前数据未受影响') >= 0, xlsx.error);
    t.eq('D1 Excel 空表后当前表行数仍为 3', xlsx.rows, 3);
    t.eq('D1 Excel 空表后 importedAt 未变', afterX.importedAt, beforeD.importedAt);

    /* .yms：0 字节文件 → 0 行 × 0 列 */
    const yms0 = await page.evaluate(async function () {
      const f = new File([''], 'empty.yms', { type: 'application/json' });
      const r = await window.YMS.Importer.importFile(f);
      const st = window.__YMS__.getState();
      return { ok: !!(r && r.ok), error: r && r.error ? String(r.error) : null, rows: st.rowCount, cols: st.colCount };
    });
    const afterY = await snapshot(page);
    t.eq('D2 .yms 0 字节 → ok === false', yms0.ok, false);
    t.ok('D2 提示含「没有可导入的数据」', !!yms0.error && yms0.error.indexOf('没有可导入的数据') >= 0, yms0.error);
    t.eq('D2 .yms 空模板后当前表行数仍为 3', yms0.rows, 3);
    t.eq('D2 .yms 空模板后 importedAt 未变', afterY.importedAt, beforeD.importedAt);

    /* .yms：只有列定义、0 行数据（情形 B） */
    const ymsB = await page.evaluate(async function () {
      const tpl = {
        format: 'YMS-TEMPLATE', version: '1.0.0', tableName: '空结构表',
        columns: [{ name: 'A', type: 'number' }, { name: 'B', type: 'number' }],
        rows: []
      };
      const f = new File([JSON.stringify(tpl)], 'header.yms', { type: 'application/json' });
      const r = await window.YMS.Importer.importFile(f);
      const st = window.__YMS__.getState();
      const msg = document.getElementById('status-msg');
      return {
        ok: !!(r && r.ok), rows: st.rowCount, cols: st.colCount,
        columns: st.columns.map(function (c) { return c.name; }),
        status: msg ? String(msg.textContent).trim() : '',
        statusCls: msg ? msg.className : ''
      };
    });
    t.eq('D3 .yms 只有列定义 → ok === true', ymsB.ok, true);
    t.eq('D3 .yms 行数 = 0', ymsB.rows, 0);
    t.eq('D3 .yms 列数 = 2（列定义保留）', ymsB.cols, 2);
    t.eq('D3 .yms 列名 = A / B', ymsB.columns.join(','), 'A,B');
    t.ok('D3 状态栏含「仅列定义，0 行数据」', ymsB.status.indexOf('仅列定义，0 行数据') >= 0, ymsB.status);
    t.ok('D3 状态栏是 warn 样式', /is-warn/.test(ymsB.statusCls), ymsB.statusCls);

    /* ================= 全程无未捕获异常 ================= */
    t.noErrors('全程无未捕获异常 / console error', ctx.errors);
  }
};
