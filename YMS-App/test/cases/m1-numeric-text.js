/* ==========================================================================
   YMS · test/cases/m1-numeric-text.js
   断言对象：M-1 数值文本容错（修复于 2026-10-21）
   命中代码：js/core/types.js      → YMS.num.parseLoose（95% / 1,234 / N/A / - / NaN）
                                    → inferType 的分子分母口径（明确缺失不进分母）
             js/data/csv-parser.js → _writeRow 走 parseLoose + 原文另存（rawText）
             js/data/importer.js   → Excel 同一条入口
             js/core/store.js      → View.textAt（原值/计算值分离：表格显示 95%）
             js/core/dataframe.js  → Column.rawText（随 subset 搬迁）
             js/table/data-grid.js → 单元格用 textAt
   反例保护：真文本列（abc / 中文）仍判 string；日期列仍判 time；1e308 仍是数值；
             4 数字 + 6 文本仍判 string —— 证明容错没有把真文本也当数字。
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

/** 导入并等一帧，让数据区重绘完成 */
async function importCsv(page, name, text) {
  const r = await app.importText(page, name, text);
  await page.waitForTimeout(60);
  return r;
}

/** 读渲染出来的表格文本（跳过行号列 #，数组下标 = 数据列序） */
async function gridRows(page) {
  return page.evaluate(function () {
    const rows = document.querySelectorAll('#grid-panel table.data-grid tbody tr');
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const tds = rows[i].querySelectorAll('td');
      const r = [];
      for (let j = 0; j < tds.length; j++) {
        if (tds[j].className.indexOf('rowno') >= 0) continue;   /* 行号列不属于数据列 */
        r.push(String(tds[j].textContent).trim());
      }
      out.push(r);
    }
    return out;
  });
}

/** 一次导入后的常用读数：列类型 / 缺失 / 原始存储值 / 统计 */
async function readCol(page, col, rows) {
  const st = await app.getState(page);
  const c = st.columns.filter(function (x) { return x.name === col; })[0] || null;
  const vals = [];
  for (let i = 0; i < rows; i++) vals.push(await page.evaluate(function (a) {
    return window.__YMS__.rawCell(a[0], a[1]);
  }, [i, col]));
  const stats = await app.columnStats(page, col);
  return { col: c, vals: vals, stats: stats };
}

module.exports = {
  id: 'm1-numeric-text',
  title: 'M-1 数值文本容错（95%→0.95 / N/A / - / NaN / 1,234，显示保留原文）',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ================= 0. parseLoose 单一入口：逐写法实测 ================= */
    const unit = await page.evaluate(function () {
      const P = (window.YMS && window.YMS.num && window.YMS.num.parseLoose);
      const has = typeof P === 'function';
      const pick = function (s) {
        if (!has) return { value: null, isMissing: null, from: null };
        const r = P(s);
        return { value: r.value, isMissing: r.isMissing, from: r.from };
      };
      return {
        has: has,
        pct: pick('95%'), negPct: pick('-12.5%'), spacePct: pick('95 %'), zeroPct: pick('0%'),
        thou: pick('1,234'), thouDec: pick('1,234,567.89'), badThou: pick('1,2'),
        na: pick('N/A'), naLower: pick('n/a'), dotNa: pick('n.a.'), dash: pick('-'),
        emDash: pick('—'), neg: pick('-2'), nan: pick('NaN'), inf: pick('Infinity'),
        empty: pick(''), blank: pick('   '), text: pick('abc'), num: pick('12.5')
      };
    });
    t.ok('唯一入口 YMS.num.parseLoose 已就绪', unit.has === true, unit);
    t.eq('parseLoose("95%").value = 0.95', unit.pct.value, 0.95);
    t.eq('parseLoose("95%").from = percent', unit.pct.from, 'percent');
    t.eq('parseLoose("95%").isMissing = false', unit.pct.isMissing, false);
    t.eq('parseLoose("-12.5%").value = -0.125', unit.negPct.value, -0.125);
    t.eq('parseLoose("95 %") 容忍 % 前空白 → 0.95', unit.spacePct.value, 0.95);
    t.ok('parseLoose("0%") 值为 0 且不算缺失（0 是合法取值）',
      unit.zeroPct.value === 0 && unit.zeroPct.isMissing === false, unit.zeroPct);
    t.eq('parseLoose("1,234").value = 1234', unit.thou.value, 1234);
    t.eq('parseLoose("1,234").from = thousands', unit.thou.from, 'thousands');
    t.eq('parseLoose("1,234,567.89").value = 1234567.89', unit.thouDec.value, 1234567.89);
    t.ok('parseLoose("1,2") 不符合严格千分位 → 不动（from=text）',
      unit.badThou.from === 'text' && unit.badThou.value === null, unit.badThou);
    t.ok('parseLoose("N/A") 判缺失', unit.na.isMissing === true && unit.na.value === null, unit.na);
    t.ok('parseLoose("n/a") 判缺失', unit.naLower.isMissing === true, unit.naLower);
    t.ok('parseLoose("n.a.") 判缺失', unit.dotNa.isMissing === true, unit.dotNa);
    t.ok('parseLoose("-") 单独减号判缺失', unit.dash.isMissing === true, unit.dash);
    t.ok('parseLoose("—") 长破折号判缺失', unit.emDash.isMissing === true, unit.emDash);
    t.ok('parseLoose("-2") 是数值 -2（不与 "-" 混）',
      unit.neg.value === -2 && unit.neg.isMissing === false, unit.neg);
    t.ok('parseLoose("NaN") 判缺失', unit.nan.isMissing === true, unit.nan);
    t.ok('parseLoose("Infinity") 判缺失', unit.inf.isMissing === true, unit.inf);
    t.ok('parseLoose("") 判缺失', unit.empty.isMissing === true, unit.empty);
    t.ok('parseLoose("   ") 纯空白判缺失', unit.blank.isMissing === true, unit.blank);
    t.ok('parseLoose("abc") 是真文本：value=null 但不计缺失',
      unit.text.value === null && unit.text.isMissing === false && unit.text.from === 'text', unit.text);
    t.eq('parseLoose("12.5") 普通数字 → 12.5 / plain',
      unit.num.value + '|' + unit.num.from, '12.5|plain');

    /* ================= 1. 写法①百分数：整列判 number ================= */
    const i1 = await importCsv(page, 'm1-percent.csv', 'Lot,Yield\nA,95%\nB,90%\nC,85%\n');
    t.ok('百分数列导入 3 行 × 2 列', i1.ok && i1.rows === 3 && i1.cols === 2, i1);
    t.eq('百分数列 type = number（不再降级为 char）', i1.columns[1] && i1.columns[1].type, 'number');
    t.eq('百分数列 missing = 0', i1.columns[1] && i1.columns[1].missing, 0);
    const r1 = await readCol(page, 'Yield', 3);
    t.ok('计算值 = 0.95 / 0.9 / 0.85',
      r1.vals.length === 3 && Math.abs(r1.vals[0] - 0.95) < 1e-12 &&
      Math.abs(r1.vals[1] - 0.9) < 1e-12 && Math.abs(r1.vals[2] - 0.85) < 1e-12, r1.vals);
    const g1 = await gridRows(page);
    t.eq('单元格显示保留原文 95% / 90% / 85%',
      g1.map(function (r) { return r[1]; }).join('|'), '95%|90%|85%');
    t.eq('getCell（显示格式化口径）读出 0.95', await page.evaluate(function () {
      return window.__YMS__.getCell(0, 'Yield');
    }), '0.95');
    t.eq('统计 mean = 0.9（按 0.95/0.9/0.85 算）', r1.stats && Math.round(r1.stats.mean * 1e9) / 1e9, 0.9);
    t.eq('统计 min = 0.85', r1.stats && r1.stats.min, 0.85);
    t.eq('统计 max = 0.95', r1.stats && r1.stats.max, 0.95);
    const c1 = await app.exportCsv(page);
    t.ok('CSV 导出按计算值写 0.95（不是 95%）',
      c1.indexOf(',0.95') >= 0 && c1.indexOf('95%') < 0, c1.split('\r\n').slice(0, 2).join(' / '));
    const x1 = await app.xlsxColumn(page, 'Yield');
    t.ok('XLSX 该列是数值单元格 t="n" 且值 = 0.95',
      x1.ok && x1.cells[0] && x1.cells[0].t === 'n' && Math.abs(x1.cells[0].v - 0.95) < 1e-12,
      x1.cells && x1.cells[0]);

    /* ================= 2. 写法② N/A：判缺失、不拖垮整列 ================= */
    const i2 = await importCsv(page, 'm1-na.csv', 'Lot,V\nA,10\nB,N/A\n');
    t.eq('含 N/A 的列 type = number', i2.columns[1] && i2.columns[1].type, 'number');
    t.eq('含 N/A 的列 missing = 1', i2.columns[1] && i2.columns[1].missing, 1);
    const r2 = await readCol(page, 'V', 2);
    t.isNull('N/A 行的原始存储值为 null（不是 0、不是字符）', r2.vals[1]);
    t.eq('N/A 行表格显示为空', (await gridRows(page))[1][1], '');
    t.eq('统计 valid / missing = 1 / 1', r2.stats && (r2.stats.valid + '/' + r2.stats.missing), '1/1');

    /* ================= 3. 写法③ 单独减号 ================= */
    const i3 = await importCsv(page, 'm1-dash.csv', 'Lot,V\nA,10\nB,-\n');
    t.eq('含 "-" 的列 type = number', i3.columns[1] && i3.columns[1].type, 'number');
    t.eq('含 "-" 的列 missing = 1（"-" 是缺失，不是文本）', i3.columns[1] && i3.columns[1].missing, 1);

    /* ================= 4. 写法④ NaN ================= */
    const i4 = await importCsv(page, 'm1-nan.csv', 'Lot,V\nA,10\nB,NaN\n');
    t.eq('含 "NaN" 的列 type = number', i4.columns[1] && i4.columns[1].type, 'number');
    t.eq('含 "NaN" 的列 missing = 1', i4.columns[1] && i4.columns[1].missing, 1);

    /* ================= 5. 写法⑤ 千分位 ================= */
    const i5 = await importCsv(page, 'm1-thou.csv', 'Lot,V\nA,"1,234"\nB,"2,000"\n');
    t.eq('千分位列 type = number', i5.columns[1] && i5.columns[1].type, 'number');
    const r5 = await readCol(page, 'V', 2);
    t.eq('千分位计算值 = 1234 / 2000', r5.vals.join(','), '1234,2000');
    const g5 = await gridRows(page);
    t.eq('千分位单元格显示保留原文 1,234 / 2,000',
      g5.map(function (r) { return r[1]; }).join('|'), '1,234|2,000');

    /* ================= 6. 混合列：容错 + 缺失共存 ================= */
    const i6 = await importCsv(page, 'm1-mix.csv',
      'Lot,V\nA,95%\nB,N/A\nC,-\nD,NaN\nE,"1,234"\n');
    t.eq('混合列（95% / N/A / - / NaN / 1,234）type = number', i6.columns[1] && i6.columns[1].type, 'number');
    t.eq('混合列 missing = 3（N/A / - / NaN）', i6.columns[1] && i6.columns[1].missing, 3);
    const r6 = await readCol(page, 'V', 5);
    t.eq('混合列 valid = 2', r6.stats && r6.stats.valid, 2);
    t.eq('混合列 min = 0.95 / max = 1234', r6.stats && (r6.stats.min + '/' + r6.stats.max), '0.95/1234');
    const g6 = await gridRows(page);
    t.eq('混合列显示：95% / 空 / 空 / 空 / 1,234',
      g6.map(function (r) { return r[1]; }).join('|'), '95%||||1,234');

    /* ================= 7. 反例保护：真文本 / 中文 / 日期 / 1e308 不变 ================= */
    const i7 = await importCsv(page, 'm1-text.csv', 'Name,Note\nA,abc\nB,def\nC,ghi\n');
    t.eq('纯文本列 abc 仍判 string（不得误判 number）', i7.columns[1] && i7.columns[1].type, 'string');
    const i8 = await importCsv(page, 'm1-cn.csv', '名称,备注\n甲,好\n乙,坏\n');
    t.eq('中文文本列仍判 string', i8.columns[1] && i8.columns[1].type, 'string');
    const i9 = await importCsv(page, 'm1-date.csv', '名称,日期\nA,2026-09-01\nB,2026-09-02\n');
    t.eq('日期列仍判 time', i9.columns[1] && i9.columns[1].type, 'time');
    const i10 = await importCsv(page, 'm1-big.csv', '名称,值\nA,1e308\nB,1e308\n');
    t.eq('1e308 列仍判 number', i10.columns[1] && i10.columns[1].type, 'number');
    const r10 = await readCol(page, '值', 2);
    t.ok('1e308 值不失真、缺失 = 0',
      r10.vals[0] === 1e308 && !!r10.stats && r10.stats.missing === 0, { v: r10.vals[0], missing: r10.stats && r10.stats.missing });
    const i11 = await importCsv(page, 'm1-cncol.csv', '批次,良率\nA1,95%\nA2,88.5%\n');
    t.eq('中文列名 + 百分数 → number（列名不影响判定）', i11.columns[1] && i11.columns[1].type, 'number');
    t.eq('中文列名的百分数单元格显示原文',
      (await gridRows(page)).map(function (r) { return r[1]; }).join('|'), '95%|88.5%');

    /* ================= 8. 类型推断临界（分母口径） ================= */
    let csv9 = 'Lot,V\n';
    for (let i = 0; i < 9; i++) csv9 += 'L' + i + ',' + (80 + i) + '\n';
    csv9 += 'Lx,N/A\n';
    const i12 = await importCsv(page, 'm1-ratio9.csv', csv9);
    t.eq('10 行：9 数字 + 1 个 N/A → 判 number（9/9 = 100%）', i12.columns[1] && i12.columns[1].type, 'number');
    t.eq('10 行：9 数字 + 1 个 N/A → missing = 1', i12.columns[1] && i12.columns[1].missing, 1);
    let csv4 = 'Lot,V\n';
    for (let i = 0; i < 4; i++) csv4 += 'L' + i + ',' + (10 + i) + '\n';
    for (let i = 0; i < 6; i++) csv4 += 'T' + i + ',abc\n';
    const i13 = await importCsv(page, 'm1-ratio4.csv', csv4);
    t.eq('10 行：4 数字 + 6 文本 → 仍判 string（4/10 = 40%）', i13.columns[1] && i13.columns[1].type, 'string');

    /* ================= 9. 原值 / 计算值分离在整条链路上的表现 ================= */
    await importCsv(page, 'm1-flow.csv', 'Lot,Yield\nA,95%\nB,90%\n');
    const comp = await app.computeColumn(page, 'y_x2', 'Yield * 2');
    t.ok('计算列 Yield * 2 创建成功（表达式取到的是 0.95 而不是 95）', comp.ok, comp);
    const y2 = await page.evaluate(function () { return window.__YMS__.rawCell(0, 'y_x2'); });
    t.eq('计算列首行 = 1.9（0.95 × 2）', y2, 1.9);
    const viewRows = await page.evaluate(function () {
      window.__YMS__.applyDataSettings({ preprocess: { missing: 'none', filters: [{ col: 'Yield', op: '>', value: 0.9 }] } });
      return window.__YMS__.getState().viewCount;
    });
    await page.waitForTimeout(60);
    t.eq('条件筛选按计算值比较（Yield > 0.9 → 1 行）', viewRows, 1);
    t.eq('筛选后单元格仍显示原文 95%（rawText 随行搬迁）', (await gridRows(page))[0][1], '95%');

    /* 绘图取值：图形读的是同一列 Float64Array，必须是 0.95 而不是 95 */
    await importCsv(page, 'm1-plot.csv', 'Lot,Yield\nA,95%\nB,90%\n');
    const agg = await page.evaluate(function () {
      window.__YMS__.applyPlot({ type: 'bar', x: ['Lot'], values: ['Yield'], pageBy: [], splitBy: [], sorters: [] });
      const meta = window.__YMS__.submitPlot();
      const w = window.__YMS__.aggregateWork();
      const out = { charts: (meta || []).length, chartType: w && w.chartType, pages: 0, cats: 0, key: null, mean: null };
      if (w && w.pages && w.pages.length) {
        out.pages = w.pages.length;
        const p0 = w.pages[0];
        const f = p0 && p0.facets && p0.facets[0];
        const cats = f && f.firstCats;
        if (cats && cats.length) {
          out.cats = cats.length;
          out.key = cats[0].key;
          out.mean = cats[0].stats && cats[0].stats['Yield'] && cats[0].stats['Yield'].mean;
        }
      }
      return out;
    });
    t.ok('百分数列能正常出图（图卡 ≥ 1）', agg.charts >= 1, agg);
    t.eq('类别 A 的绘图均值 = 0.95（不是 95）', agg.mean, 0.95);

    t.noErrors('全程无未捕获异常 / console error', ctx.errors);
  }
};
