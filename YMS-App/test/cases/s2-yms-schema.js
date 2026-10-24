/* ==========================================================================
   YMS · test/cases/s2-yms-schema.js
   断言对象：S-2 .yms 模板载入无 schema 白名单（修复于 2026-10-21）
   命中代码：js/core/store.js（applyRules / normRule / 规则表 / deserialize）
             js/data/yms-template.js（validate 体量保护 · load 报告转提示）
   目标语义：
     1) plot / dataSettings 只接受规则表里声明过的键 —— 未知键不进 state；
     2) 每个字段逐类型校验（数组 / 字符串 / 布尔 / 数值 + 取值域 + 列名存在性），
        非法值回落默认值，任何一处非法都不许抛异常；
     3) 体量保护：> 32 MB / > 50 张表 / 单表 > 100 万行 / 合计 > 200 万行 → 拒绝载入，
        且当前已载入的表不受影响；
     4) 提示文案含「无法识别」「已忽略」+ 被忽略键名（最多 5 个，余下用「等」）；
     5) 合法模板往返行为完全不变。
   ========================================================================== */
'use strict';

/* 页面内通用装置：造模板 + 载入 + 读状态（只在页面内运行，不碰产品私有变量） */
const HELPERS = function () {
  window.__S2 = {
    mk: function (extraPlot, extraDS) {
      var t = {
        format: 'YMS-TEMPLATE', version: '1.0.0', tableName: 'S2 表',
        columns: [{ name: 'Lot', type: 'string' }, { name: 'Wafer', type: 'number' }, { name: 'Yield', type: 'number' }],
        rows: [['L1', 1, 0.9], ['L2', 2, 0.8]],
        plot: { type: 'bar', x: ['Lot'], values: ['Yield'] },
        dataSettings: {}
      };
      var k;
      var p = extraPlot || {};
      for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) t.plot[k] = p[k];
      var d = extraDS || {};
      for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) t.dataSettings[k] = d[k];
      return t;
    },
    load: function (tpl) {
      var toastBefore = document.querySelectorAll('#toast-root .toast').length;
      var threw = null, r = null, renderThrew = null;
      try { r = window.YMS.YmsTemplate.load(tpl); } catch (e) { threw = String(e && e.message); }
      /* 状态栏文案在切视图 / 渲染之前抓（渲染会改写状态栏，那是既有行为） */
      var statusNow = document.getElementById('status-msg').textContent;
      try { window.YMS.Store.setMode('plot'); window.YMS.PlotView.render(); } catch (e2) { renderThrew = String(e2 && e2.message); }
      var st = window.__YMS__.getState();
      var raw = window.YMS.Store.state;
      var toasts = Array.prototype.slice.call(document.querySelectorAll('#toast-root .toast'))
        .slice(toastBefore).map(function (n) { return String(n.textContent); });
      return {
        threw: threw, renderThrew: renderThrew,
        ok: !!(r && r.ok), err: (r && r.error) ? String(r.error) : null,
        plot: st.plot, ds: st.dataSettings, rowCount: st.rowCount, colCount: st.colCount,
        tableName: st.tableName, notes: st.processingNotes.slice(),
        msgs: (window.YMS.Store.sanitizeMessages ? window.YMS.Store.sanitizeMessages() : []) || [],
        ignored: (window.YMS.Store.lastSanitize || {}).ignored || [],
        fixed: (window.YMS.Store.lastSanitize || {}).fixed || [],
        plotKeys: Object.keys(st.plot).sort(), dsKeys: Object.keys(st.dataSettings).sort(),
        rawDsOwnProto: Object.prototype.hasOwnProperty.call(raw.dataSettings, '__proto__'),
        rawDsProtoOk: Object.getPrototypeOf(raw.dataSettings) === Object.prototype,
        rawPlotProtoOk: Object.getPrototypeOf(raw.plot) === Object.prototype,
        hasEvilKey: Object.prototype.hasOwnProperty.call(st.plot, '恶意键'),
        globalPolluted: ({}).polluted === 'yes',
        toasts: toasts,
        status: statusNow,
        notesLen: st.processingNotes.length
      };
    }
  };
};

/* 当前激活表快照（判「体量拒绝时当前表不受影响」） */
function snapshot(page) {
  return page.evaluate(function () {
    const st = window.__YMS__.getState();
    return {
      rowCount: st.rowCount, colCount: st.colCount, tableName: st.tableName,
      x: st.plot.x, values: st.plot.values, notesLen: st.processingNotes.length,
      importedAt: window.YMS.Store.state.importedAt
    };
  });
}

function pageErrors(errors) {
  return (errors || []).filter(function (e) { return String(e).indexOf('pageerror') === 0; });
}

module.exports = {
  id: 's2-yms-schema',
  title: 'S-2 .yms 模板 schema 白名单 + 类型校验 + 体量保护',

  async run(ctx) {
    const page = ctx.page, t = ctx.t, errors = ctx.errors;

    /* 基线：先导入一份正常数据，后面所有「拒绝载入」都要证明它没被动过 */
    await page.evaluate(function () {
      var nl = String.fromCharCode(10);
      window.__YMS__.importText('base.csv',
        ['Lot,Wafer,Yield', 'L1,1,0.9', 'L2,2,0.8', 'L3,1,0.7'].join(nl) + nl);
    });
    await page.evaluate(HELPERS);

    /* ------------------------------------------------ 0 schema 规则表自洽 */
    const schema = await page.evaluate(function () {
      const S = window.YMS.Store.schema;
      const dp = Object.keys(window.YMS.defaultPlot()).sort();
      /* 修复前的应用没有 schema 导出 → 返回「缺失」标记，让断言照常变红而不是整例崩掉 */
      if (!S) {
        return { plotMissing: ['(无 schema 导出)'], plotExtra: [], dsMissing: [], dsExtra: [],
          styleRules: -1, styleDefaults: Object.keys(window.YMS.defaultPlot().style).length, plotKeys: dp };
      }
      const pr = S.plotRules().map(function (r) { return r.k; }).sort();
      const dds = Object.keys(window.YMS.Store.state.dataSettings).sort();
      const dr = S.dataRules().map(function (r) { return r.k; }).sort();
      return {
        plotMissing: dp.filter(function (k) { return pr.indexOf(k) < 0; }),
        plotExtra: pr.filter(function (k) { return dp.indexOf(k) < 0; }),
        dsMissing: dds.filter(function (k) { return dr.indexOf(k) < 0; }),
        dsExtra: dr.filter(function (k) { return dds.indexOf(k) < 0; }),
        styleRules: S.styleRules().length,
        styleDefaults: Object.keys(window.YMS.defaultPlot().style).length,
        plotKeys: dp
      };
    });
    t.eq('0-1 白名单覆盖 plot 默认结构的每个键（少一个就是漏校验）', schema.plotMissing.join(','), '');
    t.eq('0-2 白名单不含 plot 默认结构之外的多余键', schema.plotExtra.join(','), '');
    t.eq('0-3 白名单覆盖 dataSettings 默认结构的每个键', schema.dsMissing.join(','), '');
    t.eq('0-4 白名单不含 dataSettings 默认结构之外的多余键', schema.dsExtra.join(','), '');
    t.eq('0-5 style 规则数 = DEFAULT_STYLE 令牌数（新令牌自动纳入白名单）', schema.styleRules, schema.styleDefaults);
    t.eq('0-6 plot 默认结构共 21 个键（回归锚点，加字段要同步规则表）', schema.plotKeys.length, 21);
    t.eq('0-6b 新增键 legend / mark 已在默认结构里（迭代 31 图例与图元）',
      schema.plotKeys.filter(function (k) { return k === 'legend' || k === 'mark'; }).join(','),
      'legend,mark');

    /* ------------------------------------------------ 1 畸形 plot.x */
    const xCases = await page.evaluate(function () {
      const H = window.__S2;
      const out = {};
      out.obj = H.load(H.mk({ x: { a: 1 } }));
      out.num = H.load(H.mk({ x: 123 }));
      out.str = H.load(H.mk({ x: 'Lot' }));
      out.arrBad = H.load(H.mk({ x: ['不存在的列'] }));
      out.arrMix = H.load(H.mk({ x: ['Lot', 5, null] }));
      return out;
    });
    t.eq('1-1 plot.x 为对象 {} → 不抛异常', xCases.obj.threw, null);
    t.eq('1-2 plot.x 为对象 {} → 载入成功（其余字段照常）', xCases.obj.ok, true);
    t.eq('1-3 plot.x 为对象 {} → x 回落默认空数组', JSON.stringify(xCases.obj.plot.x), '[]');
    t.eq('1-4 plot.x 为对象 {} → 渲染不抛异常', xCases.obj.renderThrew, null);
    t.ok('1-5 plot.x 为对象 {} → 记入「回落默认」报告', xCases.obj.fixed.indexOf('plot.x') >= 0, { fixed: xCases.obj.fixed });
    t.eq('1-6 plot.x 为数字 123 → 不抛异常', xCases.num.threw, null);
    t.eq('1-7 plot.x 为数字 123 → x 回落默认空数组', JSON.stringify(xCases.num.plot.x), '[]');
    t.eq('1-8 plot.x 为数字 123 → 渲染不抛异常', xCases.num.renderThrew, null);
    t.eq('1-9 plot.x 为字符串 "Lot" → 视为单列名（合法）', JSON.stringify(xCases.str.plot.x), '["Lot"]');
    t.eq('1-10 plot.x 为字符串 "Lot" → 不产生任何回落记录', xCases.str.fixed.length, 0);
    t.eq('1-11 plot.x 含不存在的列 → 该列被剔除', JSON.stringify(xCases.arrBad.plot.x), '[]');
    t.ok('1-12 plot.x 含不存在的列 → 提示里点名该列', String(xCases.arrBad.fixed.join(' ')).indexOf('不存在的列') >= 0, { fixed: xCases.arrBad.fixed });
    t.eq('1-13 plot.x 数组里夹非字符串 → 整体回落默认', JSON.stringify(xCases.arrMix.plot.x), '[]');
    t.eq('1-14 多次畸形载入后数据仍是模板里的 2 行（没被搞坏）', xCases.arrMix.rowCount, 2);

    /* ------------------------------------------------ 2 类型校验（逐字段） */
    const types = await page.evaluate(function () {
      const H = window.__S2;
      const out = {};
      out.one = H.load(H.mk({ values: 'Yield' }));
      out.bad = H.load(H.mk({
        values: 'Yield',
        style: { xRotate: 'abc', showGrid: 'yes', xAxisFontSize: '14', yMin: 'abc', yMax: 5, xAxisColor: 'red' },
        stats: { show: 'yes', items: 'mean', rotate: 33 },
        layout: { mode: 'weird', rows: 99 },
        merge: { mode: 'x', limit: 'abc' },
        fit: 'nope', fitOrder: 20, histBins: 'abc', activePage: -3,
        type: 'pie', display: 'weird', sorters: [{ col: 'Wafer', dir: 'sideways' }]
      }, { fontSize: '9', pageSize: 0, page: 0, decimals: { Yield: 12 }, sorters: [{ col: 'Nope', dir: 'asc' }] }));
      out.zero = H.load(H.mk({ style: { xRotate: 0 } }));
      out.unknown = H.load(H.mk({ style: { 未知样式键: 1 }, group: { 未知组键: 1, colorBy: 'Lot' } }));
      return out;
    });
    t.eq('2-1 values 给单个字符串列名 → 视为单列（合法）', JSON.stringify(types.one.plot.values), '["Yield"]');
    t.eq('2-2 values 合法时不产生回落记录', types.one.fixed.length, 0);
    t.eq('2-3 values 合法时 values 不是字符串', typeof types.one.plot.values, 'object');
    t.eq('2-4 十项非法值同批载入 → 不抛异常', types.bad.threw, null);
    t.eq('2-5 十项非法值同批载入 → 载入成功', types.bad.ok, true);
    t.eq('2-6 xRotate "abc" → 回落默认 90', types.bad.plot.style.xRotate, 90);
    t.eq('2-7 showGrid "yes" → 回落默认 false', types.bad.plot.style.showGrid, false);
    t.eq('2-8 style.fontSize "14" → 回落默认 11（数值字段不接受字符串）', types.bad.plot.style.xAxisFontSize, 11);
    t.eq('2-9 yMin "abc" → 回落默认 null', types.bad.plot.style.yMin, null);
    t.eq('2-10 yMax 5（合法数字）→ 原样保留', types.bad.plot.style.yMax, 5);
    t.eq('2-11 xAxisColor "red"（非 #rrggbb）→ 回落默认', types.bad.plot.style.xAxisColor, '#4a5866');
    t.eq('2-12 stats.show "yes" → 布尔归一', types.bad.plot.stats.show, true);
    t.eq('2-13 stats.items "mean"（非数组）→ 回落默认 ["mean"]', JSON.stringify(types.bad.plot.stats.items), '["mean"]');
    t.eq('2-14 stats.rotate 33（非合法角度）→ 回落 90', types.bad.plot.stats.rotate, 90);
    t.eq('2-15 layout.mode "weird" → best', types.bad.plot.layout.mode, 'best');
    t.eq('2-16 layout.rows 99（超上限）→ 1', types.bad.plot.layout.rows, 1);
    t.eq('2-17 merge.mode "x" → auto', types.bad.plot.merge.mode, 'auto');
    t.eq('2-18 merge.limit "abc" → null', types.bad.plot.merge.limit, null);
    t.eq('2-19 fit "nope" → none', types.bad.plot.fit, 'none');
    t.eq('2-20 fitOrder 20（超上限）→ 2', types.bad.plot.fitOrder, 2);
    t.eq('2-21 histBins "abc" → null', types.bad.plot.histBins, null);
    t.eq('2-22 activePage -3（负数）→ 0', types.bad.plot.activePage, 0);
    t.eq('2-23 type "pie" → scatter（白名单图型）', types.bad.plot.type, 'scatter');
    t.eq('2-24 display "weird" → facet', types.bad.plot.display, 'facet');
    t.eq('2-25 sorters.dir 非法 → 归一到 asc 且列名保留', JSON.stringify(types.bad.plot.sorters), '[{"col":"Wafer","dir":"asc"}]');
    t.eq('2-26 dataSettings.fontSize "9"（字符串）→ 回落 12', types.bad.ds.fontSize, 12);
    t.eq('2-27 dataSettings.pageSize 0（超下限）→ 回落 5000', types.bad.ds.pageSize, 5000);
    t.eq('2-28 dataSettings.page 0（超下限）→ 回落 1', types.bad.ds.page, 1);
    t.eq('2-29 dataSettings.decimals 给 12（超 0~8）→ 该列不保留', JSON.stringify(types.bad.ds.decimals), '{}');
    t.eq('2-30 dataSettings.sorters 指向不存在的列 → 剔除', JSON.stringify(types.bad.ds.sorters), '[]');
    t.eq('2-31 xRotate 0 是合法取值 → 保留 0（不是被 || 兜成 90）', types.zero.plot.style.xRotate, 0);
    t.eq('2-32 style 的未知键被丢弃', Object.prototype.hasOwnProperty.call(types.unknown.plot.style, '未知样式键'), false);
    t.eq('2-33 style 其余合法值照常生效（group.colorBy=Lot）', types.unknown.plot.group.colorBy, 'Lot');
    /* 迭代 26：group 白名单从 3 个字段扩到 5 个（preset / autoN 见下方 6-18 的说明）——
       断言口径不变（未知键一律丢弃），只把白名单字段集合同步到新契约 */
    t.eq('2-34 group 的未知键被丢弃（normGroup 只留 5 个白名单字段）', JSON.stringify(Object.keys(types.unknown.plot.group).sort()), '["autoN","colorBy","colors","preset","symbolBy"]');
    t.eq('2-35 同批非法值逐项记入报告（非空）', types.bad.fixed.length > 5, true);

    /* ------------------------------------------------ 3 未知键 / 原型污染 */
    const evil = await page.evaluate(function () {
      const H = window.__S2;
      const a = H.load(H.mk({ '恶意键': { deep: true } }, { extraKey: 'survived', 未知设置: 1 }));
      const text = '{"format":"YMS-TEMPLATE","tableName":"proto",' +
        '"columns":[{"name":"Lot","type":"string"},{"name":"Yield","type":"number"}],"rows":[["L1",0.9]],' +
        '"dataSettings":{"__proto__":{"polluted":"yes"},"constructor":{"x":1},"extraKey":"survived"},' +
        '"plot":{"__proto__":{"polluted":"yes"},"constructor":{"x":1},"恶意键":1,"x":["Lot"],"values":["Yield"]}}';
      const b = H.load(text);
      return { a: a, b: b };
    });
    t.eq('3-1 plot 的未知键不进 state', evil.a.hasEvilKey, false);
    t.eq('3-2 dataSettings 的未知键不进 state', Object.prototype.hasOwnProperty.call(evil.a.ds, 'extraKey'), false);
    t.eq('3-3 state.plot 的键集合 = 默认结构键集合（多一个都算污染）', evil.a.plotKeys.length, 21);
    t.eq('3-4 state.dataSettings 的键集合 = 默认结构键集合', evil.a.dsKeys.length, 7);
    t.ok('3-5 未知键记入 ignored 报告', evil.a.ignored.indexOf('plot.恶意键') >= 0, { ignored: evil.a.ignored });
    t.ok('3-6 dataSettings 未知键记入 ignored 报告', evil.a.ignored.indexOf('dataSettings.extraKey') >= 0, { ignored: evil.a.ignored });
    t.eq('3-7 JSON 文本里的 __proto__ 不被写成 state 的自有属性', evil.b.rawDsOwnProto, false);
    t.eq('3-8 dataSettings 的原型仍是 Object.prototype', evil.b.rawDsProtoOk, true);
    t.eq('3-9 plot 的原型仍是 Object.prototype', evil.b.rawPlotProtoOk, true);
    t.eq('3-10 全局对象未被污染（({}).polluted 不存在）', evil.b.globalPolluted, false);
    t.eq('3-11 constructor 作为模板键 → 同样丢弃', evil.b.ignored.indexOf('plot.constructor') >= 0, true);
    t.eq('3-12 原型污染模板里的合法字段照常恢复（plot.x）', JSON.stringify(evil.b.plot.x), '["Lot"]');

    /* ------------------------------------------------ 4 提示文案 */
    t.ok('4-1 提示含「无法识别」', evil.a.msgs.join(' ').indexOf('无法识别') >= 0, { msgs: evil.a.msgs });
    t.ok('4-2 提示含「已忽略」', evil.a.msgs.join(' ').indexOf('已忽略') >= 0, { msgs: evil.a.msgs });
    t.ok('4-3 提示列出被忽略的键名', evil.a.msgs.join(' ').indexOf('plot.恶意键') >= 0, { msgs: evil.a.msgs });
    t.ok('4-4 提示进「处理说明」（state.processingNotes）', evil.a.notes.join(' ').indexOf('无法识别') >= 0, { notes: evil.a.notes });
    t.ok('4-5 toast 也提示（用户不打开处理说明也能看见）', evil.a.toasts.join(' ').indexOf('无法识别') >= 0, { toasts: evil.a.toasts });
    t.ok('4-6 回落默认的提示含「已回落默认」', types.bad.msgs.join(' ').indexOf('已回落默认') >= 0, { msgs: types.bad.msgs });
    /* 提示按规格只列前 5 个字段名，xRotate 排在后面 → 明细要保留、提示要点名至少一个字段 */
    t.eq('4-7 回落默认的提示列出 5 个字段名（9 项明细，按规格只展示前 5 个）',
      (function () {
        const m = types.bad.msgs.join(' ');
        const tail = m.slice(m.lastIndexOf('已回落默认：') + 6);
        return tail.split('、').length;
      })(), 5);
    t.ok('4-7c 提示以「等」收尾（还有更多明细没列出）',
      types.bad.msgs.join(' ').indexOf(' 等') >= 0, { msgs: types.bad.msgs });
    t.ok('4-7b 第 6 个之后的字段也留在报告明细里（xRotate）',
      types.bad.fixed.indexOf('plot.style.xRotate') >= 0, { fixed: types.bad.fixed });
    const many = await page.evaluate(function () {
      const H = window.__S2;
      const p = {};
      for (let i = 1; i <= 8; i++) p['未知' + i] = i;
      return H.load(H.mk(p));
    });
    t.ok('4-8 超过 5 个未知键时用「等」收尾', many.msgs.join(' ').indexOf(' 等') >= 0, { msgs: many.msgs });
    t.ok('4-9 计数正确（8 个未知键）', many.msgs.join(' ').indexOf('8 个无法识别') >= 0, { msgs: many.msgs });
    const clean = await page.evaluate(function () { return window.__S2.load(window.__S2.mk()); });
    t.eq('4-10 完全合法的模板 → 无任何提示（不误报）', clean.msgs.length, 0);
    t.eq('4-11 合法模板 load 返回值里 sanitize 为空', clean.fixed.length + clean.ignored.length, 0);

    /* ------------------------------------------------ 5 体量保护 */
    const cur = await snapshot(page);
    const guard = await page.evaluate(function () {
      const col = [{ name: 'A', type: 'number' }];
      const mkTables = function (n, rowsPer) {
        const arr = [];
        for (let i = 0; i < n; i++) arr.push({ id: 'tb' + i, name: 'T' + i, columns: col, rows: rowsPer });
        return arr;
      };
      const H = window.__S2;
      const before = window.__YMS__.getState();
      const cheap = function (tpl) {
        const t0 = performance.now();
        const r = H.load(tpl);
        return { r: r, ms: Math.round(performance.now() - t0) };
      };
      const out = {};
      out.tables = cheap({ format: 'YMS-TEMPLATE', columns: col, rows: [[1]], tables: mkTables(51, [[1]]) });
      out.rows = cheap({ format: 'YMS-TEMPLATE', columns: col, rows: new Array(1000001) });
      out.total = cheap({ format: 'YMS-TEMPLATE', columns: col, rows: [[1]], tables: mkTables(3, new Array(999999)) });
      const big = '{"format":"YMS-TEMPLATE","columns":[{"name":"A","type":"number"}],"rows":[' +
        new Array(33 * 1024 * 1024).join(' ') + ']}';
      out.big = cheap(big);
      out.bigLen = big.length;
      const after = window.__YMS__.getState();
      out.beforeRow = before.rowCount; out.afterRow = after.rowCount;
      out.beforeTable = before.tableName; out.afterTable = after.tableName;
      out.beforeX = before.plot.x.join(','); out.afterX = after.plot.x.join(',');
      out.beforeNotes = before.processingNotes.length; out.afterNotes = after.processingNotes.length;
      return out;
    });
    t.eq('5-1 51 张表 → 拒绝载入', guard.tables.r.ok, false);
    t.ok('5-2 51 张表 → 提示写明上限', String(guard.tables.r.err).indexOf('超过上限 50 张') >= 0, { err: guard.tables.r.err });
    t.ok('5-3 51 张表 → 状态栏写明「已拒绝载入」', String(guard.tables.r.status).indexOf('已拒绝载入') >= 0, { status: guard.tables.r.status });
    t.eq('5-4 单表 1,000,001 行 → 拒绝载入', guard.rows.r.ok, false);
    t.ok('5-5 单表超限 → 提示写明单表上限', String(guard.rows.r.err).indexOf('单表上限 1,000,000') >= 0, { err: guard.rows.r.err });
    t.eq('5-6 合计 2,999,997 行 → 拒绝载入', guard.total.r.ok, false);
    t.ok('5-7 合计超限 → 提示写总行数上限', String(guard.total.r.err).indexOf('总行数上限') >= 0, { err: guard.total.r.err });
    t.eq('5-8 33 MB 文本 → 拒绝载入', guard.big.r.ok, false);
    t.ok('5-9 33 MB 文本 → 提示「模板文件过大」', String(guard.big.r.err).indexOf('模板文件过大') >= 0, { err: guard.big.r.err });
    t.ok('5-10 33 MB 文本在 JSON.parse 之前就被拒（耗时 < 800ms）', guard.big.ms < 800, { ms: guard.big.ms });
    t.eq('5-11 拒绝载入后当前表行数不变', guard.afterRow, cur.rowCount);
    t.eq('5-12 拒绝载入后当前表名不变', guard.afterTable, cur.tableName);
    t.eq('5-13 拒绝载入后当前绘图配置不变（plot.x）', guard.afterX, cur.x.join(','));
    t.eq('5-14 拒绝载入不写处理说明（污染不了说明栏）', guard.afterNotes, guard.beforeNotes);
    t.eq('5-15 四次超限拒绝均不抛异常', guard.tables.r.threw + '' + guard.rows.r.threw + '' + guard.total.r.threw + '' + guard.big.r.threw, 'nullnullnullnull');

    /* ------------------------------------------------ 6 正常往返不变 */
    const rt = await page.evaluate(function () {
      var nl2 = String.fromCharCode(10);
      var csv = ['Lot,Wafer,Yield'];
      for (var i = 1; i <= 500; i++) csv.push('L' + i + ',' + (i % 7) + ',' + (0.5 + (i % 50) / 100));
      window.__YMS__.importText('rt.csv', csv.join(nl2) + nl2);
      window.__YMS__.applyPlot({
        type: 'box', x: ['Lot'], values: ['Yield'], sorters: [{ col: 'Wafer', dir: 'desc' }],
        display: 'facet', activePage: 0, histBins: 12, fit: 'linear', fitOrder: 3,
        layout: { mode: 'rc', rows: 2, cols: 2 },
        merge: { mode: 'manual', limit: 60 },
        style: { xRotate: 45, showGrid: true, yMin: -1, yMax: 2, xAxisColor: '#123456', yDecimals: 2 },
        stats: { show: false, items: ['mean', 'median'], rotate: 45 },
        table: { show: true, frame: true },
        group: { colorBy: 'Lot', symbolBy: '', colors: { L1: '#ff0000' } },
        axisSide: { 'Yield': 'right' }
      });
      window.YMS.Store.applyDataSettings({
        decimals: { Yield: 3 }, fontFamily: 'Arial', fontSize: 14,
        sorters: [{ col: 'Wafer', dir: 'asc' }],
        preprocess: { missing: 'zero', filters: [{ col: 'Yield', op: '>', value: '0.5', value2: '', enabled: true }] },
        page: 2, pageSize: 100
      });
      window.__YMS__.submitPlot();
      const snap = function () {
        const s = window.__YMS__.getState();
        return {
          plot: s.plot, ds: s.dataSettings, rowCount: s.rowCount, colCount: s.colCount,
          tableName: s.tableName, columns: s.columns.map(function (c) { return c.name + ':' + c.type; }).join(',')
        };
      };
      const before = snap();
      const tpl = window.YMS.YmsTemplate.build();
      const text = JSON.stringify(tpl);
      const r = window.YMS.YmsTemplate.load(text);
      const after = snap();
      const diff = [];
      function jj(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
      const cmp = function (p, a, b) {
        if (a === b) return;
        if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
          diff.push(p + ': ' + jj(a) + ' != ' + jj(b)); return;
        }
        const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
        if (ka.join(',') !== kb.join(',')) diff.push(p + ' keys: ' + ka.join(',') + ' != ' + kb.join(','));
        ka.forEach(function (k) { if (kb.indexOf(k) >= 0) cmp(p + '.' + k, a[k], b[k]); });
      };
      cmp('plot', before.plot, after.plot);
      cmp('dataSettings', before.ds, after.ds);
      return {
        ok: !!(r && r.ok), err: r && r.error ? String(r.error) : null,
        bytes: text.length, diff: diff.slice(0, 8), diffCount: diff.length,
        before: before, after: after,
        msgs: (window.YMS.Store.sanitizeMessages ? window.YMS.Store.sanitizeMessages() : [])
      };
    });
    t.eq('6-1 合法 .yms 往返载入成功', rt.ok, true);
    t.eq('6-2 往返后绘图配置逐项相等（深比较 0 处差异）', rt.diffCount, 0);
    t.ok('6-3 往返差异清单为空', rt.diff.length === 0, { diff: rt.diff });
    t.eq('6-4 往返后行数一致', rt.after.rowCount, rt.before.rowCount);
    t.eq('6-5 往返后列数一致', rt.after.colCount, rt.before.colCount);
    t.eq('6-6 往返后列名与类型一致', rt.after.columns, rt.before.columns);
    t.eq('6-7 往返后表名一致', rt.after.tableName, rt.before.tableName);
    t.eq('6-8 往返后小数位格式一致', JSON.stringify(rt.after.ds.decimals), '{"Yield":3}');
    t.eq('6-9 往返后行排序一致', JSON.stringify(rt.after.ds.sorters), '[{"col":"Wafer","dir":"asc"}]');
    t.eq('6-10 往返后字体 / 字号一致', rt.after.ds.fontFamily + '/' + rt.after.ds.fontSize, 'Arial/14');
    t.eq('6-11 往返后预处理与条件筛选一致', JSON.stringify(rt.after.ds.preprocess), JSON.stringify(rt.before.ds.preprocess));
    t.eq('6-12 往返后分页一致', rt.after.ds.page + '/' + rt.after.ds.pageSize, '2/100');
    t.eq('6-13 往返后图型 / X / Value 一致', rt.after.plot.type + '|' + rt.after.plot.x.join(',') + '|' + rt.after.plot.values.join(','), 'box|Lot|Yield');
    t.eq('6-14 往返后 X 类别排序一致', JSON.stringify(rt.after.plot.sorters), '[{"col":"Wafer","dir":"desc"}]');
    t.eq('6-15 往返后 style 逐字段一致（旋转 / 网格 / 范围 / 轴色 / 小数）',
      [rt.after.plot.style.xRotate, rt.after.plot.style.showGrid, rt.after.plot.style.yMin,
        rt.after.plot.style.yMax, rt.after.plot.style.xAxisColor, rt.after.plot.style.yDecimals].join('|'),
      '45|true|-1|2|#123456|2');
    t.eq('6-16 往返后统计行一致', JSON.stringify(rt.after.plot.stats), '{"show":false,"items":["mean","median"],"rotate":45}');
    t.eq('6-17 往返后绘图区表格开关一致', JSON.stringify(rt.after.plot.table), '{"show":true,"frame":true}');
    /* 迭代 26：group 增加 preset（色阶预设 id）/ autoN（上次自动配色时的图例数）——
       白名单同步扩字段，往返值仍逐字段一致（此处模板没给 preset → 归一为 ''） */
    t.eq('6-18 往返后分组配色一致', JSON.stringify(rt.after.plot.group), '{"colorBy":"Lot","symbolBy":"","colors":{"L1":"#ff0000"},"preset":"","autoN":0}');
    t.eq('6-19 往返后轴位一致', JSON.stringify(rt.after.plot.axisSide), '{"Yield":"right"}');
    t.eq('6-20 往返后合并设置一致', JSON.stringify(rt.after.plot.merge), '{"mode":"manual","limit":60}');
    t.eq('6-21 往返后排版设置一致', JSON.stringify(rt.after.plot.layout), '{"mode":"rc","rows":2,"cols":2}');
    t.eq('6-22 往返后拟合设置一致', rt.after.plot.fit + '/' + rt.after.plot.fitOrder, 'linear/3');
    t.eq('6-23 往返后直方图分箱一致', rt.after.plot.histBins, 12);
    t.eq('6-24 合法模板往返不产生任何提示（0 误报）', rt.msgs.length, 0);

    /* ------------------------------------------------ 7 全程无未捕获异常 */
    const pe = pageErrors(errors);
    t.eq('7-1 全程 pageerror = 0（畸形模板不许把界面弄崩）', pe.length, 0);
    t.ok('7-2 页面仍可交互（绘图视图可渲染）', await page.evaluate(function () {
      return !!(window.YMS.PlotView && window.YMS.PlotView.render && document.getElementById('plot-canvas-wrap'));
    }), true);
  }
};
