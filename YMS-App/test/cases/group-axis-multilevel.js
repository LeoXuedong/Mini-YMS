/* ==========================================================================
   YMS · test/cases/group-axis-multilevel.js
   断言对象：分组标签合并 **N 级**（除最后一列外每一列都产出一条合并带）
   命中代码：js/plot/aggregate.js（groupLabels[] / 叶子 subLabel / 逐级分层排序 / 组内合并）
             js/plot/axis.js（groupAxisLevels → 每级带宽 + 整级统一角度）
             js/plot/chart-builder.js（N 级分组带 / 数据表格下部 N 行 / __groupAxis.levels）
   目标语义（用户原话：CHM 分组没有合并显示，要求对所有分组情形都要合并）：
     1) X = [Tool_Group, Chamber_Group, Lot] → **2 级**分组 + 叶子 Lot；每级各自成带
     2) 级 0 cells = 4（Tool1..4），级 1 cells = 8（每 tool 内 CHM1/CHM2 成对）
     3) 级 0 的 count 之和 = 级 1 的 count 之和 = 总列数（覆盖无缝隙）
     4) Merge Crowded 生效时仍不跨越任何一级的边界（级 0 / 级 1 的格数不变）
     5) 数据表格下部 N 行分组行（级 0 在上），表格总行数把 N 行都算进去
     6) 底部留白 = 全部级带宽之和（绝不许裁掉任何一级的标签）
     7) 列的级数 = X 列数 − 1（2 列 → 1 级；4 列 → 3 级）；单列 X → 0 级
   读数方式：只读包装 YMS.ChartBuilder.buildOption 抓 option.__groupAxis / __table（不改行为）。
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

const TOOLS = ['Tool1', 'Tool2', 'Tool3', 'Tool4'];
const CHAMBERS = ['CHM1', 'CHM2'];

/* --------------------------------------------------------------- 夹具 */

/** 三级结构：tools × chambers × lotsPer */ 
function makeCsv3(tools, chambers, lotsPer) {
  const rows = ['Fab,Product,Tool_Group,Chamber_Group,Lot,Yield'];
  let k = 0;
  tools.forEach(function (tool, ti) {
    chambers.forEach(function (chm, ci) {
      for (let j = 1; j <= lotsPer; j++) {
        k++;
        rows.push('Fab1,Prod1,' + tool + ',' + chm + ',L' + ('000' + (ti * 100 + ci * 10 + j)).slice(-4) +
          ',' + (88 + (k % 7) * 0.6 + ti * 0.4).toFixed(2));
      }
    });
  });
  return rows.join('\n');
}

/* --------------------------------------------------------------- 页面内动作 */

async function installOptionTap(page) {
  return page.evaluate(function () {
    if (window.__gaTap) return true;
    window.__capOpts = [];
    const orig = window.YMS.ChartBuilder.buildOption;
    window.YMS.ChartBuilder.buildOption = function () {
      const o = orig.apply(this, arguments);
      window.__capOpts.push(o);
      return o;
    };
    window.__gaTap = true;
    return true;
  });
}

async function plot(page, x, table) {
  await page.evaluate(function (a) {
    window.__capOpts = [];
    window.__YMS__.setMode('plot');
    window.__YMS__.applyPlot({
      type: 'box', x: a[0], values: ['Yield'], sorters: [], splitBy: [], pageBy: [], display: 'facet',
      merge: { mode: 'auto', limit: null },
      table: { show: !!a[1], frame: false }
    });
    window.__YMS__.submitPlot({});
  }, [x, !!table]);
  await page.waitForTimeout(900);
}

/** 读一次渲染的分级几何（__groupAxis.levels / __table.groupCellsByLevel / 真实 grid 矩形） */
async function geom(page, want) {
  const r = await page.evaluate(function (labelsWant) {
    const caps = window.__capOpts || [];
    const opt = caps.length ? caps[caps.length - 1] : null;
    const insts = window.YMS.PlotView.charts || [];
    const inst = insts.length ? insts[insts.length - 1].chart : null;
    const out = { ok: !!opt && !!inst };
    if (!out.ok) return out;
    const ga = opt.__groupAxis || null;
    const tb = opt.__table || null;
    const cellOf = function (c) {
      return {
        label: c.label, i0: c.i0, i1: c.i1, count: c.count, span: c.span,
        left: c.left, right: c.right, rotate: c.rotate, textPx: c.textPx
      };
    };
    out.ga = ga ? {
      on: !!ga.on, source: ga.source || null, band: ga.band, h: ga.h, gap: ga.gap,
      levelCount: ga.levelCount, cellsByLevel: (ga.cellsByLevel || []).slice(),
      cells: (ga.cells || []).map(cellOf),
      levels: (ga.levels || []).map(function (L) {
        return {
          index: L.index, h: L.h, gap: L.gap, band: L.band, rotate: L.rotate,
          rotCount: L.rotCount, count: L.count,
          cells: (L.cells || []).map(cellOf)
        };
      })
    } : null;
    out.tb = tb ? {
      on: !!tb.on, groupOn: !!tb.groupOn, groupRowCount: tb.groupRowCount,
      groupCells: (tb.groupCells || []).map(cellOf),
      groupCellsByLevel: (tb.groupCellsByLevel || []).map(function (g) { return (g || []).map(cellOf); }),
      colCount: tb.colCount, band: tb.band, nAll: tb.nAll, rowH: tb.rowH,
      rowCount: (tb.rows || []).length
    } : null;
    out.fit = opt.__axisFit ? { groupBand: opt.__axisFit.groupBand, bottom: opt.__axisFit.bottom } : null;
    const g = inst.getOption();
    out.xLabels = (g.xAxis && g.xAxis[0] ? (g.xAxis[0].data || []).slice() : []);
    const rect = inst.getModel().getComponent('grid').coordinateSystem.getRect();
    out.geom = {
      containerH: inst.getHeight(),
      gridBottomEdge: Math.round((rect.y + rect.height) * 100) / 100,
      bottomWhitespace: Math.round((inst.getHeight() - (rect.y + rect.height)) * 100) / 100
    };
    /* graphic 里的分组标签文字（一级一条带 → 每级每格一个文本） */
    out.groupTexts = [];
    (opt.graphic || []).forEach(function (e) {
      if (!e || e.type !== 'text' || !e.style || !e.style.text) return;
      const t = String(e.style.text);
      if (labelsWant.indexOf(t) < 0) return;
      out.groupTexts.push({ text: t, rotationDeg: e.rotation ? Math.round(e.rotation * 180 / Math.PI) : 0, bottom: e.bottom });
    });
    return out;
  }, want || []);
  if (!r.ga) r.ga = { on: false, levels: [], cells: [], levelCount: 0, cellsByLevel: [], band: 0, h: 0, gap: 0 };
  if (!Array.isArray(r.ga.levels)) r.ga.levels = [];
  if (!Array.isArray(r.ga.cellsByLevel)) r.ga.cellsByLevel = [];
  if (!r.tb) r.tb = { on: false, groupOn: false, groupCellsByLevel: [], groupCells: [], groupRowCount: 0, colCount: null, nAll: null, rowCount: null, band: null, rowH: null };
  if (!Array.isArray(r.tb.groupCellsByLevel)) r.tb.groupCellsByLevel = [];
  if (!r.fit) r.fit = { groupBand: null, bottom: null };
  if (!r.geom) r.geom = { containerH: null, gridBottomEdge: null, bottomWhitespace: null };
  if (!Array.isArray(r.xLabels)) r.xLabels = [];
  if (!Array.isArray(r.groupTexts)) r.groupTexts = [];
  return r;
}

function countsOf(cells) { return (cells || []).map(function (c) { return c.count; }); }
function labelsOf(cells) { return (cells || []).map(function (c) { return c.label; }).join('|'); }
function sumCounts(cells) { return (cells || []).reduce(function (s, c) { return s + c.count; }, 0); }

module.exports = {
  id: 'group-axis-multilevel',
  title: 'N 级分组标签合并（每级各一条带 / 表格下部 N 行 / 合并不跨级 / 留白求和）',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;
    await installOptionTap(page);

    /* ==================================================================
       1. 三级 X = [Tool_Group, Chamber_Group, Lot] → 2 级（表格通道）
       ================================================================== */
    const imp1 = await app.importText(page, 'ml3.csv', makeCsv3(TOOLS, CHAMBERS, 2));
    t.eq('1.1 导入 16 行 × 6 列（4 tool × 2 chamber × 2 lot）', imp1.rows + 'x' + imp1.cols, '16x6');
    await plot(page, ['Tool_Group', 'Chamber_Group', 'Lot'], true);
    const a = await geom(page, TOOLS.concat(CHAMBERS));
    const ga = a.ga, tb = a.tb;
    t.eq('1.2 三级 X 已渲染且抓到 option / ECharts 实例', a.ok, true);
    t.eq('1.3 __groupAxis 启用', ga.on, true);
    t.eq('1.4 分组级数 = 2（X 列数 3 − 叶子 1）', ga.levelCount, 2);
    t.eq('1.5 __groupAxis.levels 数组长度 = 2', ga.levels.length, 2);
    t.eq('1.6 级 0 cells = 4（Tool1..Tool4）', ga.levels.length ? ga.levels[0].cells.length : -1, 4);
    t.eq('1.7 级 0 labels = Tool1|Tool2|Tool3|Tool4',
      ga.levels.length ? labelsOf(ga.levels[0].cells) : '', 'Tool1|Tool2|Tool3|Tool4');
    t.eq('1.8 级 1 cells = 8（4 tool × 2 chamber）', ga.levels.length > 1 ? ga.levels[1].cells.length : -1, 8);
    t.eq('1.9 级 1 labels = 逐 tool 内 CHM1/CHM2 成对',
      ga.levels.length > 1 ? labelsOf(ga.levels[1].cells) : '', 'CHM1|CHM2|CHM1|CHM2|CHM1|CHM2|CHM1|CHM2');
    t.eq('1.10 级 0 每格 count = 该 tool 下全部列数（4/4/4/4）',
      ga.levels.length ? countsOf(ga.levels[0].cells).join(',') : '', '4,4,4,4');
    t.eq('1.11 级 1 每格 count = 该 chamber 在 tool 内的列数（2×8）',
      ga.levels.length > 1 ? countsOf(ga.levels[1].cells).join(',') : '', '2,2,2,2,2,2,2,2');
    t.eq('1.12 级 0 count 之和 = 总列数 16', sumCounts(ga.levels.length ? ga.levels[0].cells : []), 16);
    t.eq('1.13 级 1 count 之和 = 总列数 16', sumCounts(ga.levels.length > 1 ? ga.levels[1].cells : []), 16);
    t.eq('1.14 级 0 的 count 之和 = 级 1 的 count 之和（覆盖同源）',
      sumCounts(ga.levels.length ? ga.levels[0].cells : []), sumCounts(ga.levels.length > 1 ? ga.levels[1].cells : []));
    t.eq('1.15 级 0 覆盖 0..15 连续无缝隙',
      ga.levels.length ? ga.levels[0].cells.map(function (c) { return c.i0 + '-' + c.i1; }).join(',') : '',
      '0-3,4-7,8-11,12-15');
    t.eq('1.16 级 1 覆盖 0..15 连续无缝隙',
      ga.levels.length > 1 ? ga.levels[1].cells.map(function (c) { return c.i0 + '-' + c.i1; }).join(',') : '',
      '0-1,2-3,4-5,6-7,8-9,10-11,12-13,14-15');
    /* 级 1 的每一格必须 Nest 在级 0 的某一格内部（逐级包含，不交叉） */
    const nest = (function () {
      if (ga.levels.length < 2) return 'no';
      const l0 = ga.levels[0].cells, l1 = ga.levels[1].cells;
      let pi = 0;
      for (let i = 0; i < l1.length; i++) {
        while (pi < l0.length && l1[i].i0 > l0[pi].i1) pi++;
        if (pi >= l0.length) return 'oob';
        if (l1[i].i0 < l0[pi].i0 || l1[i].i1 > l0[pi].i1) return 'cross@' + i;
      }
      return 'ok';
    })();
    t.eq('1.17 级 1 每格完整嵌在级 0 的一格内（无跨级切割）', nest, 'ok');
    /* 每级统一角度（不逐格各算） */
    t.ok('1.18 级 0 所有格角度一致', (function () {
      if (!ga.levels.length) return false;
      const r = ga.levels[0].cells.map(function (c) { return c.rotate; });
      return r.every(function (x) { return x === r[0]; });
    })(), ga.levels.length ? ga.levels[0].cells.map(function (c) { return c.rotate; }) : []);
    t.ok('1.19 级 1 所有格角度一致', (function () {
      if (ga.levels.length < 2) return false;
      const r = ga.levels[1].cells.map(function (c) { return c.rotate; });
      return r.every(function (x) { return x === r[0]; });
    })(), ga.levels.length > 1 ? ga.levels[1].cells.map(function (c) { return c.rotate; }) : []);
    /* 底部留白 = 各级带宽之和 */
    const bandSum = ga.levels.reduce(function (s, L) { return s + (L.h + L.gap); }, 0);
    t.eq('1.20 __groupAxis.band = 各级 (h + gap) 之和', ga.band, bandSum);
    t.ok('1.21 底部留白 ≥ 各级带宽之和（两级的标签都容得下）',
      a.geom.bottomWhitespace >= bandSum, { bottom: a.geom.bottomWhitespace, need: bandSum });
    t.eq('1.22 级 0 带宽 = h + gap（级内自洽）', ga.levels.length ? ga.levels[0].band : null,
      ga.levels.length ? ga.levels[0].h + ga.levels[0].gap : null);
    /* 迭代 30：数据表格通道已注释停用 → 以下改验轴层分组带（每级一条带） */
    t.eq('1.23 轴层分组带数 = 2（每级一条带）', ga.cellsByLevel.length, 2);
    t.ok('1.24 每级带高都 > 0（两级都真实占高）',
      ga.levels.length === 2 && ga.levels[0].h > 0 && ga.levels[1].h > 0,
      ga.levels.map(function (l) { return l.h; }));
    t.eq('1.25 两级格数 = 4 / 8', ga.cellsByLevel.join('/'), '4/8');
    t.eq('1.26 各级格数之和 = 12（4 + 8）',
      ga.cellsByLevel.reduce(function (a, b) { return a + b; }, 0), 12);
    t.ok('1.27 分组带总高 > 0 且每级各自占高',
      ga.h > 0 && ga.levels.length === 2 &&
      ga.levels.every(function (l) { return l.h > 0; }),
      { h: ga.h, levelH: ga.levels.map(function (l) { return l.h; }) });
    t.eq('1.28 表格两级分组文字都绘制了（4 + 8 = 12 个标签）', a.groupTexts.length, 12);
    TOOLS.forEach(function (tl) {
      t.eq('1.29.' + tl + ' 级 0 标签在表格里各画 1 次',
        a.groupTexts.filter(function (x) { return x.text === tl; }).length, 1);
    });
    t.eq('1.30 级 1 的 CHM1 标签共绘制 4 次（每 tool 一次）',
      a.groupTexts.filter(function (x) { return x.text === 'CHM1'; }).length, 4);
    /* 叶子标签只剩批号 */
    t.eq('1.31 叶子标签个数 = 16（= 列数）', a.xLabels.length, 16);
    t.ok('1.32 叶子标签不含任何级的值（无 Tool/CHM 前缀）',
      a.xLabels.every(function (v) { return String(v).indexOf('Tool') < 0 && String(v).indexOf('CHM') < 0; }),
      a.xLabels.slice(0, 4));

    /* ==================================================================
       2. Merge Crowded 生效 + 三级：合并不得跨越任何一级的边界
       ================================================================== */
    const imp2 = await app.importText(page, 'ml3_crowd.csv', makeCsv3(TOOLS, CHAMBERS, 20));
    t.eq('2.1 导入 160 个类目的数据（4 tool × 2 chamber × 20 lot）', imp2.rows, 160);
    await plot(page, ['Tool_Group', 'Chamber_Group', 'Lot'], true);
    const b = await geom(page, TOOLS.concat(CHAMBERS));
    const gb = b.ga, tbb = b.tb;
    t.eq('2.2 合并生效：列数被压到 ≤ 40', b.xLabels.length <= 40, true);
    t.ok('2.3 确实发生了合并（列数 < 原始类别数 160）', b.xLabels.length < 160, b.xLabels.length);
    t.eq('2.4 合并后级数仍 = 2', gb.levelCount, 2);
    t.eq('2.5 合并后级 0 cells 仍 = 4（不跨 Tool 合并）', gb.levels.length ? gb.levels[0].cells.length : -1, 4);
    t.eq('2.6 合并后级 1 cells 仍 = 8（不跨 CHM 合并）', gb.levels.length > 1 ? gb.levels[1].cells.length : -1, 8);
    t.eq('2.7 级 0 count 之和 = 合并后列数', sumCounts(gb.levels.length ? gb.levels[0].cells : []), b.xLabels.length);
    t.eq('2.8 级 1 count 之和 = 合并后列数', sumCounts(gb.levels.length > 1 ? gb.levels[1].cells : []), b.xLabels.length);
    t.eq('2.9 合并后级 1 覆盖全部列且首尾衔接（无缝隙）',
      gb.levels.length > 1 ? gb.levels[1].cells.map(function (c) { return c.i0 + '-' + c.i1; }).join(',') : '',
      gb.levels.length > 1 ? gb.levels[1].cells.map(function (c, i, arr) {
        const s = (i === 0) ? 0 : (arr[i - 1].i1 + 1);
        return s + '-' + c.i1;
      }).join(',') : '');
    t.eq('2.10 合并后两级分组带仍都在（4 / 8）', gb.cellsByLevel.join('/'), '4/8');
    t.eq('2.11 合并后分组带数仍 = 2', gb.cellsByLevel.length, 2);
    /* 级 1 每格 span / count 必须一致（= 当前带宽），误差 ≤1px —— 不依赖 band 元数据字段 */
    (function () {
      const l1 = (gb.levels.length > 1) ? gb.levels[1].cells : [];
      const unit = l1.length ? (l1[0].span / l1[0].count) : 0;
      t.eq('2.12 合并后级 1 每格跨度 = count × 单位带宽（误差 ≤1px）',
        l1.map(function (c) {
          return Math.abs(c.span - c.count * unit) <= 1 ? 1 : 0;
        }).join(''), '11111111');
    })();
    t.ok('2.13 合并后叶子标签仍只剩批号', String(b.xLabels[0] || '').indexOf('Tool') < 0, b.xLabels.slice(0, 3));
    t.eq('2.14 表格通道已停用 → 走轴层通道（source = axis）', gb.source, 'axis');

    /* ==================================================================
       3. 统计行通道（plot.table.show = false）+ 三级：同为 2 级
       ================================================================== */
    await plot(page, ['Tool_Group', 'Chamber_Group', 'Lot'], false);
    const c = await geom(page, TOOLS.concat(CHAMBERS));
    const gc = c.ga;
    t.eq('3.1 无数据表格时 __groupAxis 仍启用', gc.on, true);
    t.eq('3.2 走的是统计行 / 图形通道（source = axis）', gc.source, 'axis');
    t.eq('3.3 级数 = 2', gc.levelCount, 2);
    t.eq('3.4 级 0 cells = 4', gc.levels.length ? gc.levels[0].cells.length : -1, 4);
    t.eq('3.5 级 1 cells = 8', gc.levels.length > 1 ? gc.levels[1].cells.length : -1, 8);
    const bandSum3 = gc.levels.reduce(function (s, L) { return s + (L.h + L.gap); }, 0);
    t.eq('3.6 __groupAxis.band = 各级带宽之和', gc.band, bandSum3);
    t.eq('3.7 __axisFit.groupBand = 各级带宽之和（预算同源）', c.fit.groupBand, bandSum3);
    t.ok('3.8 底部留白容得下两条分组带', c.geom.bottomWhitespace >= bandSum3,
      { bottom: c.geom.bottomWhitespace, need: bandSum3 });
    t.eq('3.9 级 0 / 级 1 标签都在 graphic 里绘制（4 + 8 = 12）', c.groupTexts.length, 12);

    /* ==================================================================
       4. 级数 = X 列数 − 1：2 列 → 1 级；4 列 → 3 级
       ================================================================== */
    await plot(page, ['Tool_Group', 'Chamber_Group'], true);
    const d = await geom(page, TOOLS.concat(CHAMBERS));
    t.eq('4.1 X 只有 2 列 → 分组级数 = 1', d.ga.levelCount, 1);
    t.eq('4.2 级 0 cells = 4（Tool1..4），叶子 = CHM1/CHM2',
      d.ga.levels.length ? labelsOf(d.ga.levels[0].cells) : '', 'Tool1|Tool2|Tool3|Tool4');
    t.eq('4.3 叶子标签 = 最后一列（Chamber_Group）', d.xLabels.slice(0, 2).join('|'), 'CHM1|CHM2');
    t.eq('4.4 轴层只画 1 条分组带', d.ga.cellsByLevel.length, 1);
    t.eq('4.5 轴层 levels 长度 = 1', d.ga.levels.length, 1);

    await plot(page, ['Fab', 'Product', 'Tool_Group', 'Chamber_Group'], true);
    const e = await geom(page, TOOLS.concat(CHAMBERS).concat(['Fab1']));
    t.eq('4.6 X 有 4 列 → 分组级数 = 3', e.ga.levelCount, 3);
    t.eq('4.7 三级格数 = 1 / 1 / 4（Fab1 唯一 → Product 唯一 → 4 个 Tool）',
      e.ga.cellsByLevel.join('/'), '1/1/4');
    t.eq('4.8 4 列时轴层画 3 条分组带', e.ga.cellsByLevel.length, 3);
    t.eq('4.9 4 列时轴层 levels 长度 = 3', e.ga.levels.length, 3);

    /* ==================================================================
       5. 单列 X 守卫：不产生任何分组带（回归红线）
       ================================================================== */
    await plot(page, ['Tool_Group'], true);
    const f = await geom(page, []);
    t.eq('5.1 单列 X 时分组级数 = 0', f.ga.levelCount, 0);
    t.eq('5.2 单列 X 时 __groupAxis 关闭', f.ga.on, false);
    t.eq('5.3 单列 X 时表格不出现分组格', f.tb.groupCellsByLevel.length, 0);
    t.eq('5.4 单列 X 时轴层分组带数 = 0', f.ga.cellsByLevel.length, 0);

    t.noErrors('6.1 全程零未捕获异常 / 控制台错误', ctx.errors);
  }
};
