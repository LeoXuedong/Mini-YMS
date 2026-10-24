/* ==========================================================================
   YMS · test/cases/m4-duplicate-columns.js
   断言对象：M-4 重复列名静默共存（修复于 2026-10-21）
   命中代码：js/core/dataframe.js → YMS.colNames.unique / notice / taken +
             DataFrame.renameColumn.lastRenameError
             js/data/csv-parser.js 表头解析 · js/data/importer.js aoaToTable / applyTable
             js/core/store.js dfFromSpec（.yms 建表）· js/table/column-ops.js 撞名反馈
   目标语义：
     1) 导入阶段按出现顺序改名：A,A,B → A,A_2,B；A,A,A → A,A_2,A_3；
        A,A_2,A → A,A_2,A_3（避让已占用的 A_2，不撞成两个 A_2）
     2) 列操作打对列：对 A_2 改格式 / 加计算列 / 绘图只作用于 index 1，index 0 不动
     3) 改名进主状态栏（不只处理说明）；renameColumn 撞名有明确错误 + 可见提示
     4) 无重复列名的导入行为完全不变
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const app = require('../helpers/app');

const CSV_DUP = 'A,A,B\n1,10,100\n2,20,200\n';
const CSV_PLAIN = 'Lot,Wafer,Yield\nL1,1,0.9\nL2,2,0.8\n';

/* --------------------------------------------------------------- 页面内动作 */

/** 导入 CSV 文本 → 列名 / 列序 / 值 / 状态栏 / toast / 处理说明 / dupHeader */
function importDup(page, name, text) {
  return page.evaluate(function (a) {
    const toastBefore = document.querySelectorAll('#toast-root .toast').length;
    const r = window.__YMS__.importText(a[0], a[1]);
    const st = window.__YMS__.getState();
    const df = window.YMS.Store.state.df;
    const toasts = Array.prototype.slice.call(document.querySelectorAll('#toast-root .toast'))
      .slice(toastBefore).map(function (n) { return String(n.textContent).trim(); });
    const rows = [];
    for (let i = 0; i < df.rowCount; i++) {
      const row = [];
      for (let ci = 0; ci < df.cols.length; ci++) row.push(df.cell(ci, i));
      rows.push(row);
    }
    return {
      ok: !!(r && r.ok), error: r && r.error ? String(r.error) : null,
      columns: st.columns.map(function (c) { return c.name; }),
      types: st.columns.map(function (c) { return c.type; }),
      rowCount: st.rowCount, colCount: st.colCount, rows: rows,
      meta: r && r.meta ? { dupHeader: r.meta.dupHeader || null, warnings: r.meta.warnings || [] } : null,
      status: document.getElementById('status-msg').textContent,
      statusCls: document.getElementById('status-msg').className,
      toasts: toasts,
      notes: st.processingNotes.slice()
    };
  }, [name, text]);
}

/** 列名 → colIndex 快照（同一页内用，避免重复导入） */
function colIndexes(page, names) {
  return page.evaluate(function (list) {
    const df = window.YMS.Store.state.df;
    const out = {};
    list.forEach(function (n) { out[n] = df.colIndex(n); });
    return out;
  }, names);
}

/** 页面内用 SheetJS 造一份带重复表头的 xlsx，再走真实 importFile 路径 */
function importExcelDup(page) {
  return page.evaluate(async function () {
    const X = window.XLSX;
    const aoa = [['A', 'A', 'B'], [1, 10, 100], [2, 20, 200]];
    const ws = X.utils.aoa_to_sheet(aoa);
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, 'S1');
    const buf = X.write(wb, { type: 'array', bookType: 'xlsx' });
    const file = new File([buf], 'dup.xlsx',
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const r = await window.__YMS__.importFile(file);
    const st = window.__YMS__.getState();
    const df = window.YMS.Store.state.df;
    return {
      ok: !!(r && r.ok), error: r && r.error ? String(r.error) : null,
      columns: st.columns.map(function (c) { return c.name; }),
      rows: [df.cell(0, 0), df.cell(0, 1), df.cell(1, 0), df.cell(1, 1)],
      status: document.getElementById('status-msg').textContent
    };
  });
}

/** 手工造一份列名重复的 .yms 模板 → 走真实 YmsTemplate.load */
function loadYmsDup(page) {
  return page.evaluate(function () {
    const tpl = {
      format: 'YMS-TEMPLATE', version: '1.0.0', tableName: '重复列名表',
      columns: [{ name: 'A', type: 'number' }, { name: 'A', type: 'number' }, { name: 'B', type: 'number' }],
      rows: [[1, 10, 100], [2, 20, 200]]
    };
    const r = window.YMS.YmsTemplate.load(tpl);
    const st = window.__YMS__.getState();
    return {
      ok: !!(r && r.ok), error: r && r.error ? String(r.error) : null,
      columns: st.columns.map(function (c) { return c.name; }),
      status: document.getElementById('status-msg').textContent,
      notes: st.processingNotes.slice()
    };
  });
}

/* ------------------------------------------------------------------ 断言主体 */

module.exports = {
  id: 'm4-duplicate-columns',
  title: 'M-4 重复列名自动去重 + 列操作打对列',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ============ 1. A,A,B → A / A_2 / B（列名、列序、值互不串列） ============ */
    const r1 = await importDup(page, 'dup.csv', CSV_DUP);
    t.eq('1.1 导入 A,A,B → ok === true', r1.ok, true);
    t.eq('1.2 列数 = 3', r1.colCount, 3);
    t.eq('1.3 行数 = 2', r1.rowCount, 2);
    t.eq('1.4 列名 = A / A_2 / B', r1.columns.join('|'), 'A|A_2|B');
    t.eq('1.5 第 1 列名逐字仍为 A', r1.columns[0], 'A');
    t.eq('1.6 第 2 列名 = A_2（第 2 个 A 被改名）', r1.columns[1], 'A_2');
    t.eq('1.7 第 3 列名逐字仍为 B', r1.columns[2], 'B');
    t.eq('1.8 列名互不相同（去重后无重名）', new Set(r1.columns).size, 3);

    const ci1 = await colIndexes(page, ['A', 'A_2', 'B', 'A_3']);
    t.eq("1.9 colIndex('A') === 0", ci1['A'], 0);
    t.eq("1.10 colIndex('A_2') === 1", ci1['A_2'], 1);
    t.eq("1.11 colIndex('B') === 2", ci1['B'], 2);
    t.eq("1.12 colIndex('A_3') === -1（没有凭空多出列名）", ci1['A_3'], -1);

    /* 值互不串列：A=[1,2] A_2=[10,20] B=[100,200] */
    t.eq('2.1 A 第 1 行值 = 1', r1.rows[0][0], 1);
    t.eq('2.2 A 第 2 行值 = 2', r1.rows[1][0], 2);
    t.eq('2.3 A_2 第 1 行值 = 10（是原第 2 列的数据）', r1.rows[0][1], 10);
    t.eq('2.4 A_2 第 2 行值 = 20', r1.rows[1][1], 20);
    t.eq('2.5 B 第 1 行值 = 100', r1.rows[0][2], 100);
    t.eq('2.6 B 第 2 行值 = 200', r1.rows[1][2], 200);
    t.eq('2.7 只有改名、没改数据（三列各自 2 个值都在）', r1.rows.length * r1.rows[0].length, 6);

    /* ============ 3. 主状态可见的改名说明（不是只进处理说明） ============ */
    t.ok('3.1 状态栏含「重复列名」', r1.status.indexOf('重复列名') >= 0, r1.status);
    t.ok('3.2 状态栏含「已自动改名」', r1.status.indexOf('已自动改名') >= 0, r1.status);
    t.ok('3.3 状态栏含「A → A_2」映射', r1.status.indexOf('A → A_2') >= 0, r1.status);
    t.ok('3.4 状态栏含「（第 2 列）」定位', r1.status.indexOf('（第 2 列）') >= 0, r1.status);
    t.ok('3.5 状态栏是 warn 样式（不是普通 ok）', /is-warn/.test(r1.statusCls), r1.statusCls);
    t.ok('3.6 toast 里也带改名说明（用户不点处理说明也能看到）',
      r1.toasts.some(function (x) { return x.indexOf('重复列名') >= 0 && x.indexOf('A → A_2') >= 0; }),
      r1.toasts);
    t.ok('3.7 处理说明里同时留档（含「已自动改名」明细）',
      r1.notes.some(function (n) { return n.indexOf('重复列名') >= 0 && n.indexOf('已自动改名') >= 0; }), r1.notes);
    t.eq('3.8 meta.dupHeader.count = 1', r1.meta && r1.meta.dupHeader ? r1.meta.dupHeader.count : -1, 1);
    t.eq('3.9 meta.dupHeader.renamed[0].to = A_2',
      r1.meta && r1.meta.dupHeader ? r1.meta.dupHeader.renamed[0].to : null, 'A_2');
    t.eq('3.10 meta.dupHeader.renamed[0].index = 1（0 基列序）',
      r1.meta && r1.meta.dupHeader ? r1.meta.dupHeader.renamed[0].index : -1, 1);

    /* ============ 4. 【关键】列操作打对列：只动 index 1，不动 index 0 ============ */
    const ops = await page.evaluate(function () {
      const Y = window.__YMS__;
      const before = {
        a: [Y.rawCell(0, 'A'), Y.rawCell(1, 'A')],
        a2: [Y.rawCell(0, 'A_2'), Y.rawCell(1, 'A_2')],
        textA: Y.getCell(0, 'A'), textA2: Y.getCell(0, 'A_2'), textB: Y.getCell(0, 'B')
      };
      /* ① 计算列：A_2 * 2 → 值必须是 20 / 40（若错落到 index 0 会变成 2 / 4） */
      const calc = Y.computeColumn('calc', 'A_2 * 2');
      const df = window.YMS.Store.state.df;
      const calcIdx = df.colIndex('calc');
      const calcVals = [df.cell(calcIdx, 0), df.cell(calcIdx, 1)];
      const afterCalc = { a: [Y.rawCell(0, 'A'), Y.rawCell(1, 'A')] };

      /* ② 列格式：A_2 保留 3 位小数 → 显示 10.000；A 仍显示 1 */
      Y.applyDataSettings({ decimals: { A_2: 3 } });
      const fmt = { a: Y.getCell(0, 'A'), a2: Y.getCell(0, 'A_2'), b: Y.getCell(0, 'B') };

      /* ③ 改类型：A_2 → 字符列（index 1 变 string，index 0 必须仍是 number） */
      const conv = Y.convertType('A_2', 'string');
      const df2 = window.YMS.Store.state.df;
      const types = df2.cols.map(function (c) { return c.type; });
      const afterConv = { a: [Y.rawCell(0, 'A'), Y.rawCell(1, 'A')], a2: [df2.cell(1, 0), df2.cell(1, 1)] };

      /* ④ 绘图：x 用 A_2 → 类别是 10 / 20；x 用 A → 类别是 1 / 2 */
      /* 空 facets / null 一律降级成占位值，保证断言「红」而不是抛异常中断后续断言 */
      function facetOf(w) {
        if (!w || !w.pages || !w.pages[0] || !w.pages[0].facets) return { n: -1, cats: [] };
        const f = w.pages[0].facets[0];
        if (!f) return { n: -1, cats: [] };
        return { n: f.catCount, cats: (f.firstCats || []).map(function (c) { return c.key; }) };
      }
      Y.setPlotType('bar');
      Y.applyPlot({ x: ['A_2'], values: ['A'] });
      Y.submitPlot();
      const w1 = Y.aggregateWork();
      const f1 = facetOf(w1);
      Y.applyPlot({ x: ['A'], values: ['A_2'] });
      Y.submitPlot();
      const w2 = Y.aggregateWork();
      const f2 = facetOf(w2);

      return {
        before: before, calc: calc, calcIdx: calcIdx, calcVals: calcVals, afterCalc: afterCalc,
        fmt: fmt, conv: conv, types: types, afterConv: afterConv,
        plot1: { x: w1 && w1.xAxisName, n: f1.n, cats: f1.cats },
        plot2: { x: w2 && w2.xAxisName, n: f2.n, cats: f2.cats },
        a2IndexNow: df2.colIndex('A_2'), aIndexNow: df2.colIndex('A')
      };
    });
    t.ok('4.1 前置：计算列 A_2 * 2 执行成功', ops.calc && ops.calc.ok === true, ops.calc);
    t.eq('4.2 【关键】计算列值 = 20 / 40（读的是 index 1，不是 index 0）', ops.calcVals.join(','), '20,40');
    t.eq('4.3 计算列落在末尾（index 3），不覆盖已有列', ops.calcIdx, 3);
    t.eq('4.4 【关键】加计算列后 A 仍是 1 / 2（index 0 未被改动）', ops.afterCalc.a.join(','), '1,2');
    t.eq('4.5 【关键】列格式只作用于 A_2：显示 10.000', ops.fmt.a2, '10.000');
    t.eq('4.6 【关键】A 的显示仍是 1（格式没串到 index 0）', ops.fmt.a, '1');
    t.eq('4.7 B 的显示仍是 100（别的列也没动）', ops.fmt.b, '100');
    t.ok('4.8 改类型 A_2 → 字符列成功', ops.conv && ops.conv.ok === true, ops.conv);
    t.eq('4.9 改类型后 index 1 是 string', ops.types[1], 'string');
    t.eq('4.10 【关键】index 0 仍是 number（没被一起改掉）', ops.types[0], 'number');
    t.eq('4.11 index 2 仍是 number', ops.types[2], 'number');
    t.eq('4.12 A 的值仍为 1 / 2', ops.afterConv.a.join(','), '1,2');
    t.eq('4.13 A_2 的值仍是 10 / 20（转字符后显示原文）', ops.afterConv.a2.join(','), '10,20');
    t.eq('4.14 A 的列序仍是 0', ops.aIndexNow, 0);
    t.eq('4.15 A_2 的列序仍是 1', ops.a2IndexNow, 1);
    t.eq("4.16 【关键】绘图 x = A_2 → 轴名 A_2", ops.plot1.x, 'A_2');
    t.eq('4.17 绘图 x = A_2 → 类别数 2', ops.plot1.n, 2);
    t.eq('4.18 绘图 x = A_2 → 类别是 10 / 20（index 1 的数据）', ops.plot1.cats.join(','), '10,20');
    t.eq('4.19 绘图 x = A → 轴名 A', ops.plot2.x, 'A');
    t.eq('4.20 绘图 x = A → 类别是 1 / 2（index 0 的数据）', ops.plot2.cats.join(','), '1,2');

    /* ============ 5. A,A,A → A / A_2 / A_3 ============ */
    const r5 = await importDup(page, 'aaa.csv', 'A,A,A\n1,2,3\n');
    t.eq('5.1 A,A,A → 列名 A / A_2 / A_3', r5.columns.join('|'), 'A|A_2|A_3');
    t.eq('5.2 A,A,A 的改名数 = 2', r5.meta && r5.meta.dupHeader ? r5.meta.dupHeader.count : -1, 2);
    t.ok('5.3 状态栏含「2 个重复列名」', r5.status.indexOf('2 个重复列名') >= 0, r5.status);
    t.eq('5.4 三列数据分别是 1 / 2 / 3（按列序，不串列）', r5.rows[0].join(','), '1,2,3');
    t.eq('5.5 列名唯一', new Set(r5.columns).size, 3);

    /* ============ 6. A,A_2,A → A / A_2 / A_3（避让已占用的 A_2） ============ */
    const r6 = await importDup(page, 'a2a.csv', 'A,A_2,A\n1,2,3\n');
    t.eq('6.1 A,A_2,A → 列名 A / A_2 / A_3', r6.columns.join('|'), 'A|A_2|A_3');
    t.eq('6.2 【关键】A_2 只出现一次（没有撞成两个 A_2）',
      r6.columns.filter(function (n) { return n === 'A_2'; }).length, 1);
    t.eq('6.3 三个名字互不相同', new Set(r6.columns).size, 3);
    t.eq('6.4 第 3 个 A 被改名为 A_3（避让）',
      r6.meta && r6.meta.dupHeader ? r6.meta.dupHeader.renamed[0].to : null, 'A_3');
    t.eq('6.5 改名位置是第 3 列（0 基 index 2）',
      r6.meta && r6.meta.dupHeader ? r6.meta.dupHeader.renamed[0].index : -1, 2);
    t.eq('6.6 三列数据分别是 1 / 2 / 3', r6.rows[0].join(','), '1,2,3');
    t.ok('6.7 状态栏说明含「A → A_3（第 3 列）」',
      r6.status.indexOf('A → A_3（第 3 列）') >= 0, r6.status);

    /* 确定性：同一输入再导一次，结果逐字相同 */
    const r6b = await importDup(page, 'a2a.csv', 'A,A_2,A\n1,2,3\n');
    t.eq('6.8 确定性：同一输入两次导入列名一致', r6b.columns.join('|'), r6.columns.join('|'));

    /* ============ 7. renameColumn 撞名：明确错误 + 可见提示 ============ */
    const rn = await page.evaluate(function () {
      const Y = window.__YMS__;
      const fail = Y.renameColumn('A_2', 'A');
      const toasts = Array.prototype.slice.call(document.querySelectorAll('#toast-root .toast'))
        .map(function (n) { return { cls: n.className, text: String(n.textContent).trim() }; });
      const colsAfterFail = Y.getState().columns.map(function (c) { return c.name; });
      const okRes = Y.renameColumn('A_2', 'A9');
      const colsAfterOk = Y.getState().columns.map(function (c) { return c.name; });
      return { fail: fail, toasts: toasts, colsAfterFail: colsAfterFail, okRes: okRes, colsAfterOk: colsAfterOk };
    });
    t.eq('7.1 重命名到已存在列名 → ok === false', rn.fail && rn.fail.ok, false);
    t.ok('7.2 返回明确错误（不是静默 false）', !!rn.fail && !!rn.fail.error, rn.fail);
    t.ok('7.3 错误文案含「已存在」', !!rn.fail && String(rn.fail.error).indexOf('已存在') >= 0, rn.fail);
    t.ok('7.4 错误文案含「请换一个」', !!rn.fail && String(rn.fail.error).indexOf('请换一个') >= 0, rn.fail);
    t.ok('7.5 错误文案点名冲突列「A」', !!rn.fail && String(rn.fail.error).indexOf('列名「A」') >= 0, rn.fail);
    t.ok('7.6 UI 上有可见提示（error toast）',
      rn.toasts.some(function (x) { return /is-error/.test(x.cls) && x.text.indexOf('已存在') >= 0; }), rn.toasts);
    t.eq('7.7 失败的改名没改坏列名', rn.colsAfterFail.join('|'), 'A|A_2|A_3');
    t.eq('7.8 改成未占用的名字成功', rn.okRes && rn.okRes.ok, true);
    t.eq('7.9 改名后列名 = A / A9 / A_3', rn.colsAfterOk.join('|'), 'A|A9|A_3');

    /* ============ 8. 无重复列名：行为完全不变 ============ */
    const r8 = await importDup(page, 'plain.csv', CSV_PLAIN);
    t.eq('8.1 正常导入列名逐字相同', r8.columns.join('|'), 'Lot|Wafer|Yield');
    t.eq('8.2 行数 = 2', r8.rowCount, 2);
    t.eq('8.3 无重复列名时 dupHeader === null', r8.meta ? r8.meta.dupHeader : 'no-meta', null);
    t.eq('8.4 无重复列名时不产生警告', r8.meta ? r8.meta.warnings.length : -1, 0);
    t.ok('8.5 状态栏不含「重复列名」', r8.status.indexOf('重复列名') < 0, r8.status);
    t.ok('8.6 状态栏不含「已自动改名」', r8.status.indexOf('已自动改名') < 0, r8.status);
    t.ok('8.7 处理说明不含「重复列名」',
      !r8.notes.some(function (n) { return n.indexOf('重复列名') >= 0; }), r8.notes);
    t.ok('8.8 toast 不含「重复列名」',
      !r8.toasts.some(function (x) { return x.indexOf('重复列名') >= 0; }), r8.toasts);
    t.ok('8.9 状态栏是普通 ok 样式', /is-ok/.test(r8.statusCls), r8.statusCls);

    /* ============ 9. Excel 路径共用同一条去重规则 ============ */
    const rx = await importExcelDup(page);
    t.eq('9.1 Excel 导入 ok === true', rx.ok, true);
    t.eq('9.2 Excel 表头 A,A,B → A / A_2 / B', rx.columns.join('|'), 'A|A_2|B');
    t.eq('9.3 Excel 数据不串列（1 / 10）', rx.rows.join(','), '1,2,10,20');
    t.ok('9.4 Excel 状态栏也告知改名', rx.status.indexOf('重复列名') >= 0, rx.status);

    /* ============ 10. .yms 模板路径共用同一条去重规则 ============ */
    const ry = await loadYmsDup(page);
    t.eq('10.1 .yms 载入 ok === true', ry.ok, true);
    t.eq('10.2 .yms 列名 A,A,B → A / A_2 / B', ry.columns.join('|'), 'A|A_2|B');
    t.ok('10.3 .yms 状态栏也告知改名', ry.status.indexOf('重复列名') >= 0, ry.status);
    t.ok('10.4 .yms 处理说明留档',
      ry.notes.some(function (n) { return n.indexOf('已自动改名') >= 0; }), ry.notes);

    /* ============ 11. todo 清理与页面健康 ============ */
    const todoSrc = fs.readFileSync(path.join(__dirname, 'todo-pending.js'), 'utf8');
    t.ok('11.1 todo-pending.js 已移除 M-4 段（已转正为本用例）', todoSrc.indexOf("id: 'M-4'") < 0, '仍存在');
    /* S-2 已于第五轮修复转正（cases/s2-yms-schema.js）—— 这里改为断言 todo 里确实不再挂着它 */
    t.ok('11.2 todo-pending.js 已移除 S-2 段（已转正为 cases/s2-yms-schema.js）', todoSrc.indexOf("id: 'S-2'") < 0, '仍存在');
    const runSrc = fs.readFileSync(path.join(__dirname, '..', 'run.js'), 'utf8');
    t.ok('11.4 转正用例已登记进 run.js 且文件真实存在',
      runSrc.indexOf('s2-yms-schema.js') >= 0 &&
      fs.existsSync(path.join(__dirname, 's2-yms-schema.js')), '未登记或文件缺失');
    t.noErrors('11.3 全程零未捕获异常 / 零 console.error', ctx.errors);
  }
};
