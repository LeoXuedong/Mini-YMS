/* ==========================================================================
   YMS · test/cases/group-axis-labels.js
   断言对象：迭代 28 横轴分组标签合并（第二层分组行）
   命中代码：js/plot/aggregate.js（groupLabel / subLabel / 组 order 排序）
             js/plot/axis.js（groupAxisModel → 组带宽 / 旋转判定）
             js/plot/chart-builder.js（__groupAxis 元数据 + 分组行 graphic）
   目标语义（用户红线方框：图表下方汇总表 Tool_Group-Lot 行 4 个框 = T004/T001/T002/T003）：
     1) 4 组 12 个 bar：cells 个数 = **组数 4**（不是 bar 数 12），标签顺序 = 面板 order（非字母序）
     2) 每个 cell 的跨度 = 组内 bar 数 × 带宽（误差 ≤ 1px），相邻 cell 边界严格衔接
     3) 组内 bar 数不等（1/2/3/6）时，跨度仍 = count × bandW
     4) 第一层标签只写批号（组名前缀被拆走），每组标签在 graphic 里只画 1 次
     5) 放得下 → 0°；12 个长组名放不下 → 全部 90°，相邻墨迹不重叠
     6) 只有一个组 / 单列 X → 完全不产生分组带（不留白退化）
     7) 数据表格（plot.table.show）开启 → 表格里有分组行（跨列合并，一组一格；第四轮起由断言守护）
        ——第五轮起分组行整块位于统计行下方，格数/跨度/count 断言一条未改
   读数方式：只读应用公开状态（__YMS__ / YMS.PlotView.charts / ECharts 实例），
             option.__groupAxis 通过只读包装 YMS.ChartBuilder.buildOption 取得（不改行为）。
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

const PANEL_ORDER = ['T004', 'T001', 'T002', 'T003'];
const TOOL_GROUP = { 'TOOL-A': 'T002', 'TOOL-B': 'T004', 'TOOL-C': 'T001', 'TOOL-D': 'T003' };
const TOOLS = ['TOOL-A', 'TOOL-B', 'TOOL-C', 'TOOL-D'];

const LONG_GROUPS = [
  'PHOTO-LITHO-EUV-STEP-01', 'PHOTO-LITHO-EUV-STEP-02',
  'ETCH-DIELECTRIC-CHAMBER-A', 'ETCH-DIELECTRIC-CHAMBER-B',
  'CVD-HKMG-DEPOSITION-01', 'CVD-HKMG-DEPOSITION-02',
  'CMP-COPPER-POLISH-LINE-1', 'CMP-COPPER-POLISH-LINE-2',
  'IMP-DOPANT-HIGH-DOSE-01', 'IMP-DOPANT-HIGH-DOSE-02',
  'METRO-OVERLAY-INSPECT-01', 'METRO-OVERLAY-INSPECT-02'
];

/* --------------------------------------------------------------- 夹具 */

/** lotsPerTool: [每个 TOOL-A..D 的批次数] → CSV 文本（Yield 各不相同） */
function makeCsv(lotsPerTool) {
  const rows = ['Tool,Lot,Yield'];
  let k = 0;
  TOOLS.forEach(function (tool, ti) {
    const n = lotsPerTool[ti];
    for (let j = 1; j <= n; j++) {
      k++;
      rows.push(tool + ',L' + ('000' + j).slice(-4) + ',' + (88 + (k % 9) * 0.7 + ti * 0.3).toFixed(2));
    }
  });
  return rows.join('\n');
}

/** 12 个长组名 × 2 批次 */
function makeLongCsv() {
  const rows = ['Tool,Lot,Yield'];
  let k = 0;
  LONG_GROUPS.forEach(function (g, gi) {
    for (let j = 1; j <= 2; j++) {
      k++;
      rows.push('TL' + ('0' + (gi + 1)).slice(-2) + ',L' + ('000' + j).slice(-4) + ',' +
        (86 + (k % 11) * 0.9).toFixed(2));
    }
  });
  return rows.join('\n');
}

/* --------------------------------------------------------------- 页面内动作 */

/** 只读包装 buildOption：把本次渲染的 option 抓下来（不改返回值、不改行为） */
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

/** 应用分组映射（面板顺序 = groups 数组顺序） */
async function applyMap(page, groups, map) {
  return page.evaluate(function (a) {
    return window.__YMS__.groupMap.apply({
      sourceCol: 'Tool', targetCol: 'Tool_Group', groups: a[0], map: a[1],
      unassigned: 'other', otherLabel: '未分组'
    });
  }, [groups, map]);
}

/** 出图（真实提交路径）并等待渲染 */
async function plot(page, xCols) {
  await page.evaluate(function (x) {
    window.__capOpts = [];
    window.__YMS__.setMode('plot');
    window.__YMS__.applyPlot({
      type: 'bar', x: x, values: ['Yield'], sorters: [], splitBy: [], pageBy: [], display: 'facet'
    });
    window.__YMS__.submitPlot({});
  }, xCols);
  await page.waitForTimeout(600);
}

/** 读一次渲染的全部几何量（分组元数据 + ECharts 真实 grid 矩形 + graphic 分组文字） */
async function readGeom(page, groupLabels) {
  return page.evaluate(function (want) {
    const caps = window.__capOpts || [];
    const opt = caps.length ? caps[caps.length - 1] : null;
    const insts = window.YMS.PlotView.charts || [];
    const inst = insts.length ? insts[insts.length - 1].chart : null;
    const out = { ok: !!opt && !!inst };
    if (!out.ok) return out;
    const ga = opt.__groupAxis || null;
    out.ga = ga ? {
      on: !!ga.on, source: ga.source || null, runs: ga.runs, n: ga.n, bandW: ga.bandW, h: ga.h, gap: ga.gap,
      rotCount: ga.rotCount, labels: ga.labels,
      cells: (ga.cells || []).map(function (c) {
        return {
          label: c.label, i0: c.i0, i1: c.i1, count: c.count, span: c.span,
          spanIdeal: Math.round(c.count * ga.bandW * 1000) / 1000,
          left: c.left, right: c.right, cx: c.cx, rotate: c.rotate, textPx: c.textPx
        };
      })
    } : null;
    out.fit = opt.__axisFit ? { bottom: opt.__axisFit.bottom, groupBand: opt.__axisFit.groupBand, rotH: opt.__axisFit.rotH } : null;
    /* 第四轮：数据表格元数据（分组行合并格 = __table.groupCells；第五轮起分组行位于表格下部） */
    var tb = opt.__table || null;
    out.tb = tb ? {
      on: !!tb.on, groupOn: !!tb.groupOn,
      groupCells: (tb.groupCells || []).map(function (c) {
        return { label: c.label, i0: c.i0, i1: c.i1, count: c.count, span: c.span, left: c.left, right: c.right };
      }),
      colCount: tb.colCount, band: tb.band, nAll: tb.nAll, rowH: tb.rowH,
      rowCount: (tb.rows || []).length
    } : null;
    /* 第一层类别标签（ECharts 自身状态） */
    const g = inst.getOption();
    out.xLabels = (g.xAxis && g.xAxis[0] ? (g.xAxis[0].data || []).slice() : []);
    /* 真实 grid 矩形 → 绘图区下边界到容器底的留白 */
    const rect = inst.getModel().getComponent('grid').coordinateSystem.getRect();
    out.geom = {
      containerW: inst.getWidth(), containerH: inst.getHeight(),
      gridBottomEdge: Math.round((rect.y + rect.height) * 100) / 100,
      gridH: Math.round(rect.height * 100) / 100,
      bottomWhitespace: Math.round((inst.getHeight() - (rect.y + rect.height)) * 100) / 100
    };
    /* graphic 里的分组标签：文字 / 实际旋转角 / 墨迹横向范围 */
    const els = opt.graphic || [];
    out.groupTexts = [];
    els.forEach(function (e) {
      if (!e || e.type !== 'text' || !e.style || !e.style.text) return;
      const t = String(e.style.text);
      if (want.indexOf(t) < 0) return;
      const rotDeg = e.rotation ? Math.round(e.rotation * 180 / Math.PI) : 0;
      out.groupTexts.push({
        text: t, rotationDeg: rotDeg, left: e.left, bottom: e.bottom,
        inkW: rotDeg > 0 ? 13 : null        /* 90° 时横向墨迹宽 = 行盒高（11px 字 → 13px） */
      });
    });
    return out;
  }, groupLabels || []);
}

/** 安全取 cell：旧版本无分组行时返回空壳（断言照样判红，不抛异常） */
function at(arr, i) {
  return (arr && arr[i]) || { label: '', count: null, span: null, rotate: null, textPx: null, cx: null, left: null, right: null, i0: null, i1: null };
}
/** 组内 bar 数 → 期望的 count 序列 */
function countsOf(cells) { return cells.map(function (c) { return c.count; }); }

/** readGeom 的归一包装：缺字段一律补成「空 / null」，让旧版本（无分组行）也跑完所有断言而不是中途抛错 */
async function geom(page, labels) {
  const r = await readGeom(page, labels);
  if (!r.ga) r.ga = { on: false, cells: [], labels: [], n: 0, bandW: 0, h: 0, gap: 0, rotCount: 0, runs: 0 };
  if (!Array.isArray(r.ga.cells)) r.ga.cells = [];
  if (!r.tb) r.tb = { on: false, groupOn: false, groupCells: [], colCount: null, band: null, nAll: null, rowH: null };
  if (!Array.isArray(r.tb.groupCells)) r.tb.groupCells = [];
  if (!r.fit) r.fit = { bottom: null, groupBand: null, rotH: null };
  if (!r.geom) r.geom = { containerW: null, containerH: null, gridBottomEdge: null, gridH: null, bottomWhitespace: null };
  if (!Array.isArray(r.xLabels)) r.xLabels = [];
  if (!Array.isArray(r.groupTexts)) r.groupTexts = [];
  return r;
}

module.exports = {
  id: 'group-axis-labels',
  title: '迭代 28 横轴分组标签合并（第二层分组行：cells=组数 / 跨度 / 旋转 / 顺序）',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ==================================================================
       1. 4 短组名：cells = 组数 4（不是 12 个 bar）
       ================================================================== */
    const imp1 = await app.importText(page, 'ga4.csv', makeCsv([3, 3, 3, 3]));
    t.eq('1.1 导入 12 行 × 3 列', imp1.rows + 'x' + imp1.cols, '12x3');
    const r1 = await applyMap(page, PANEL_ORDER, TOOL_GROUP);
    t.eq('1.2 派生列 Tool_Group 建立成功', r1.ok, true);
    t.eq('1.3 派生列 order = 面板顺序（T004 在前，末尾「未分组」占位）',
      r1.order.join('|'), 'T004|T001|T002|T003|未分组');

    await installOptionTap(page);
    await plot(page, ['Tool_Group', 'Lot']);
    const a = await geom(page, PANEL_ORDER);
    t.eq('1.4 图已渲染且抓到 option / ECharts 实例', a.ok, true);

    const ga = a.ga || { on: false, cells: [] };
    t.eq('1.5 __groupAxis 已启用', ga.on, true);
    t.eq('1.6 cells 个数 = 组数 4', ga.cells.length, 4);
    t.ne('1.7 cells 个数 ≠ bar 数 12', ga.cells.length, 12);
    t.eq('1.8 cells 标签逐个 = Group Name（面板 order）', ga.cells.map(function (c) { return c.label; }).join('|'), 'T004|T001|T002|T003');
    t.ne('1.9 顺序 ≠ 字母（码点）序', ga.cells.map(function (c) { return c.label; }).join('|'),
      PANEL_ORDER.slice().sort().join('|'));
    t.eq('1.10 12 个 bar 全部落在 4 个 cell 里', ga.cells.reduce(function (s, c) { return s + c.count; }, 0), 12);
    t.eq('1.11 每格 bar 数 = 3/3/3/3', countsOf(ga.cells).join(','), '3,3,3,3');
    t.eq('1.12 类别总数 n = 12', ga.n, 12);

    /* 跨度 = count × 带宽（误差 ≤ 1px） */
    const maxSpanErr = ga.cells.length ? Math.max.apply(null, ga.cells.map(function (c) { return Math.abs(c.span - c.spanIdeal); })) : Infinity;
    t.ok('1.13 每格跨度 = 组内 bar 数 × bandW（最大误差 ≤ 1px）', maxSpanErr <= 1,
      { maxSpanErr: Math.round(maxSpanErr * 1000) / 1000, bandW: ga.bandW });
    const totalSpan = ga.cells.length ? (at(ga.cells, ga.cells.length - 1).right - at(ga.cells, 0).left) : NaN;
    t.ok('1.14 带宽 × 类别数 = 4 格总跨度（±1px）',
      ga.cells.length > 0 && Math.abs(totalSpan - ga.bandW * ga.n) <= 1,
      { totalSpan: Math.round(totalSpan * 100) / 100, bandWxN: Math.round(ga.bandW * ga.n * 100) / 100 });

    /* 相邻 cell 边界严格衔接 */
    for (let i = 0; i + 1 < ga.cells.length; i++) {
      t.near('1.15.' + (i + 1) + ' cell[' + ga.cells[i].label + '].right = cell[' + ga.cells[i + 1].label + '].left',
        ga.cells[i].right, ga.cells[i + 1].left, 1);
    }
    t.eq('1.16 cell.index0/index1 连续覆盖 0..11',
      ga.cells.map(function (c) { return c.i0 + '-' + c.i1; }).join(','), '0-2,3-5,6-8,9-11');

    /* 旋转：短组名全部横排 0° */
    ga.cells.forEach(function (c, i) {
      t.eq('1.17.' + (i + 1) + ' 短组名「' + c.label + '」横排 0°（文字 ' + Math.round(c.textPx) + 'px ≤ 跨度 ' + Math.round(c.span) + 'px）',
        c.rotate, 0);
    });
    t.eq('1.18 rotCount = 0（无竖排）', ga.rotCount, 0);

    /* graphic 里每组只画 1 次 */
    PANEL_ORDER.forEach(function (g) {
      const hits = a.groupTexts.filter(function (x) { return x.text === g; });
      t.eq('1.19.' + g + ' 分组标签只绘制 1 次', hits.length, 1);
    });
    t.eq('1.20 分组行文字元素总数 = 组数 4', a.groupTexts.length, 4);
    t.ok('1.21 分组行文字实际旋转角全为 0°',
      a.groupTexts.every(function (x) { return x.rotationDeg === 0; }),
      a.groupTexts.map(function (x) { return x.text + ':' + x.rotationDeg; }));

    /* 第一层标签：只写批号，组名前缀被拆走 */
    t.eq('1.22 第一层标签个数 = 12', a.xLabels.length, 12);
    t.eq('1.23 第一层标签只剩批号（L0001…）', a.xLabels.slice(0, 3).join('|'), 'L0001|L0002|L0003');
    t.ok('1.24 第一层标签不含组名前缀（无 T00x）',
      a.xLabels.every(function (v) { return String(v).indexOf('T00') < 0; }), a.xLabels);
    t.ok('1.25 第一层标签不含「组名-批号」连接符',
      a.xLabels.every(function (v) { return String(v).indexOf('-') < 0; }), a.xLabels);
    t.eq('1.26 subLabels（第二层数据源）= 逐 bar 批号',
      (ga.labels || []).slice(0, 3).join('|'), 'L0001|L0002|L0003');

    /* 分组带被计入底部留白预算 */
    t.eq('1.27 分组带高度 h + gap = 15px（13 行盒 + 2 间隔）', ga.h + ga.gap, 15);
    t.eq('1.28 __axisFit.groupBand = h + gap（预算与绘制同源）', a.fit.groupBand, ga.h + ga.gap);
    t.ok('1.29 底部留白 > 0 且容得下分组带', a.geom.bottomWhitespace > 0 && a.geom.bottomWhitespace >= a.fit.groupBand,
      a.geom);

    /* 相邻墨迹不重叠（横排：墨迹宽 = 实测文字宽，居中于 cx） */
    let minGap = Infinity;
    for (let i = 0; i + 1 < ga.cells.length; i++) {
      const p = ga.cells[i], q = ga.cells[i + 1];
      const gap = (q.cx - q.textPx / 2) - (p.cx + p.textPx / 2);
      if (gap < minGap) minGap = gap;
    }
    t.ok('1.30 相邻组标签墨迹不重叠（最小间隙 > 0）', ga.cells.length >= 2 && minGap > 0,
      { minGapPx: minGap === Infinity ? null : Math.round(minGap * 100) / 100, cells: ga.cells.length });

    /* ==================================================================
       2. 组内 bar 数不等（1 / 2 / 3 / 6）
       ================================================================== */
    const imp2 = await app.importText(page, 'ga_uneven.csv', makeCsv([1, 2, 3, 6]));
    t.eq('2.1 重新导入 12 行', imp2.rows, 12);
    await applyMap(page, PANEL_ORDER, TOOL_GROUP);
    await plot(page, ['Tool_Group', 'Lot']);
    const b = await geom(page, PANEL_ORDER);
    const gb = b.ga || { on: false, cells: [] };
    t.eq('2.2 __groupAxis 已启用', gb.on, true);
    t.eq('2.3 cells 仍是 4（= 组数）', gb.cells.length, 4);
    t.eq('2.4 每格 bar 数 = 2/3/1/6（T004/T001/T002/T003）', countsOf(gb.cells).join(','), '2,3,1,6');
    t.eq('2.5 bar 总数 = 12', gb.cells.reduce(function (s, c) { return s + c.count; }, 0), 12);
    gb.cells.forEach(function (c, i) {
      t.near('2.6.' + (i + 1) + ' 「' + c.label + '」跨度 = ' + c.count + ' × bandW', c.span, c.count * gb.bandW, 1);
    });
    t.ok('2.7 单 bar 组（T002）跨度 = 1 × bandW',
      gb.cells.length === 4 && Math.abs(at(gb.cells, 2).span - gb.bandW) <= 1,
      { span: at(gb.cells, 2).span, bandW: gb.bandW, cells: gb.cells.length });
    t.eq('2.8 顺序仍 = 面板 order', gb.cells.map(function (c) { return c.label; }).join('|'), 'T004|T001|T002|T003');
    t.ok('2.9 最短组仍横排（1 bar 也放得下 T002）',
      gb.cells.length === 4 && at(gb.cells, 2).rotate === 0 && at(gb.cells, 2).textPx <= at(gb.cells, 2).span,
      { textPx: at(gb.cells, 2).textPx, span: at(gb.cells, 2).span, cells: gb.cells.length });
    t.eq('2.10 第一层标签仍是批号', b.xLabels[0], 'L0001');

    /* ==================================================================
       3. 12 个长组名 → 放不下才 90°，且不重叠
       ================================================================== */
    const imp3 = await app.importText(page, 'ga12long.csv', makeLongCsv());
    t.eq('3.1 导入 24 行（12 组 × 2 批）', imp3.rows, 24);
    const map3 = {};
    LONG_GROUPS.forEach(function (g, i) { map3['TL' + ('0' + (i + 1)).slice(-2)] = g; });
    const r3 = await applyMap(page, LONG_GROUPS, map3);
    t.eq('3.2 12 组按面板顺序写进列 order', r3.order.slice(0, 12).join('|'), LONG_GROUPS.join('|'));
    t.eq('3.3 order 末尾追加「未分组」占位（既有行为）', r3.order[12], '未分组');
    t.eq('3.4 24 行全部有组名（other=0）', r3.mapped, 24);
    await plot(page, ['Tool_Group', 'Lot']);
    const c3 = await geom(page, LONG_GROUPS);
    const gc = c3.ga || { on: false, cells: [] };
    t.eq('3.5 __groupAxis 已启用', gc.on, true);
    t.eq('3.6 cells 个数 = 组数 12', gc.cells.length, 12);
    t.ne('3.7 cells 个数 ≠ bar 数 24', gc.cells.length, 24);
    t.eq('3.8 每组 2 个 bar', countsOf(gc.cells).join(','), '2,2,2,2,2,2,2,2,2,2,2,2');
    t.eq('3.9 cells 标签顺序 = 面板 order（非字母序）',
      gc.cells.map(function (x) { return x.label; }).join('|'), LONG_GROUPS.join('|'));
    t.ne('3.10 顺序 ≠ 字母序', gc.cells.map(function (x) { return x.label; }).join('|'),
      LONG_GROUPS.slice().sort().join('|'));
    t.eq('3.11 12 格全部转 90°（rotCount）', gc.rotCount, 12);
    const maxSpanErr3 = gc.cells.length ? Math.max.apply(null, gc.cells.map(function (x) { return Math.abs(x.span - x.count * gc.bandW); })) : Infinity;
    t.ok('3.12 每格跨度 = 2 × bandW（最大误差 ≤ 1px）', maxSpanErr3 <= 1,
      { maxSpanErr: Math.round(maxSpanErr3 * 1000) / 1000, bandW: gc.bandW });
    t.ok('3.13 竖排是「真的放不下」：文字宽 > 跨度',
      gc.cells.every(function (x) { return x.textPx > x.span; }),
      gc.cells.map(function (x) { return Math.round(x.textPx) + '>' + Math.round(x.span); }));
    t.eq('3.14 graphic 里 12 个组标签全部实际以 90° 绘制',
      c3.groupTexts.filter(function (x) { return x.rotationDeg === 90; }).length, 12);
    t.eq('3.15 每个长组名只绘制 1 次',
      c3.groupTexts.length, 12);
    t.ok('3.16 每格标签文字与 cell 一一对应（无重名/漏画）',
      gc.cells.every(function (x) { return c3.groupTexts.filter(function (y) { return y.text === x.label; }).length === 1; }),
      c3.groupTexts.map(function (x) { return x.text; }));

    /* 90° 时横向墨迹宽 = 行盒高 13px，居中于 cx → 相邻间隙必须 > 0 */
    let minGap3 = Infinity;
    for (let i = 0; i + 1 < gc.cells.length; i++) {
      const p = gc.cells[i], q = gc.cells[i + 1];
      const gap = (q.cx - 6.5) - (p.cx + 6.5);
      if (gap < minGap3) minGap3 = gap;
    }
    t.ok('3.17 相邻竖排标签墨迹不重叠（最小间隙 > 0）', gc.cells.length >= 2 && minGap3 > 0,
      { minGapPx: minGap3 === Infinity ? null : Math.round(minGap3 * 100) / 100, cells: gc.cells.length });
    t.ok('3.18 每格宽度容得下 13px 的竖排墨迹', gc.cells.every(function (x) { return x.span >= 13; }),
      gc.cells.map(function (x) { return x.span; }));
    t.ok('3.19 分组带高度 ≥ 最长组名的文字宽（竖排所需）',
      c3.fit.groupBand >= (gc.cells.length ? Math.max.apply(null, gc.cells.map(function (x) { return x.textPx; })) : Infinity),
      { groupBand: c3.fit.groupBand, maxTextPx: Math.round(Math.max.apply(null, gc.cells.map(function (x) { return x.textPx; }))) });
    t.eq('3.20 分组带被计入底部留白预算', c3.fit.groupBand, gc.h + gc.gap);
    t.ok('3.21 底部留白容得下分组带', c3.geom.bottomWhitespace >= c3.fit.groupBand, c3.geom);
    t.eq('3.22 第一层标签只剩批号', c3.xLabels[0], 'L0001');

    /* ==================================================================
       4. 只有一个组 → 1 个 cell 跨全部 bar（不给每个 bar 各画一个组名）
       ================================================================== */
    const imp4 = await app.importText(page, 'ga1grp.csv', makeCsv([3, 3, 3, 3]));
    t.eq('4.1 重新导入 12 行', imp4.rows, 12);
    await applyMap(page, ['ALL'], { 'TOOL-A': 'ALL', 'TOOL-B': 'ALL', 'TOOL-C': 'ALL', 'TOOL-D': 'ALL' });
    await plot(page, ['Tool_Group', 'Lot']);
    const d4 = await geom(page, ['ALL']);
    t.eq('4.2 单组时 __groupAxis 启用（1 个组 = 1 个 cell）', d4.ga ? d4.ga.on : false, true);
    t.eq('4.3 单组时 cells = 1', d4.ga ? d4.ga.cells.length : 0, 1);
    t.eq('4.4 单组 cell 标签 = 组名 ALL', at(d4.ga && d4.ga.cells, 0).label, 'ALL');
    /* 单组时 12 行折叠成 3 个类别（组内同一批号合并），cell 应跨全部类别 */
    t.eq('4.5 单组 cell 跨全部类别（= n）', at(d4.ga && d4.ga.cells, 0).count, d4.ga ? d4.ga.n : -1);
    t.near('4.6 单组跨度 = n × bandW（整条横轴）', at(d4.ga && d4.ga.cells, 0).span,
      d4.ga ? d4.ga.n * d4.ga.bandW : 0, 1);
    t.eq('4.7 单组标签只绘制 1 次（不是每个 bar 一次）', d4.groupTexts.length, 1);
    t.eq('4.8 单组时第一层标签仍是批号', d4.xLabels[0], 'L0001');

    /* ==================================================================
       5. 对照：单列 X（无分组参数列）→ 与迭代 27 行为逐值一致
       ================================================================== */
    const imp5 = await app.importText(page, 'ga_plain.csv', makeCsv([3, 3, 3, 3]));
    t.eq('5.1 重新导入 12 行', imp5.rows, 12);
    await plot(page, ['Tool']);
    const e5 = await geom(page, []);
    t.eq('5.2 单列 X 时 __groupAxis 关闭', e5.ga ? e5.ga.on : false, false);
    t.eq('5.3 单列 X 时分组带 = 0', e5.fit.groupBand, 0);
    t.eq('5.4 单列 X 的类别标签 = Tool 原值', e5.xLabels.join('|'), 'TOOL-A|TOOL-B|TOOL-C|TOOL-D');
    t.ok('5.5 单列 X 底部留白仍在 110px 量级（无分组带回归）',
      Math.abs(e5.geom.bottomWhitespace - 110) <= 2, e5.geom.bottomWhitespace);

    /* ==================================================================
       6. 数据表格开启（plot.table.show=true）→ 表格里有分组行：跨列合并（第五轮起位于文件下部）
          （第四轮修复：上一轮把「表格接管横轴时分组行消失」写成已知限制并断言钉死，本轮翻过来）
       ================================================================== */
    const imp6 = await app.importText(page, 'ga_tbl.csv', makeCsv([3, 3, 3, 3]));
    t.eq('6.1 重新导入 12 行', imp6.rows, 12);
    await applyMap(page, PANEL_ORDER, TOOL_GROUP);
    await page.evaluate(function () {
      window.__capOpts = [];
      window.__YMS__.setMode('plot');
      window.__YMS__.applyPlot({
        type: 'bar', x: ['Tool_Group', 'Lot'], values: ['Yield'], sorters: [], splitBy: [], pageBy: [],
        display: 'facet', table: { show: true, frame: false }
      });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(600);
    const f6 = await geom(page, PANEL_ORDER);
    t.eq('6.2 数据表格通道已停用（table.show 被忽略，走轴层统计行通道）', f6.ok && f6.tb ? f6.tb.on : false, false);
    /* 目标语义（用户红线）：分组带必须存在且合并 —— 表格通道停用后由轴层接管 */
    t.eq('6.3 请求表格时 __groupAxis 仍开启（轴层接管）', f6.ga ? f6.ga.on : false, true);
    t.eq('6.3b 分组几何来源标记 = axis（轴层统计行通道）', f6.ga ? f6.ga.source : '', 'axis');
    /* 轴层分组带：一组一个合并格（位于类别标签块之下） */
    t.eq('6.4 轴层分组带已生成（groupAxis.on）', f6.ga ? f6.ga.on : false, true);
    t.eq('6.5 表格分组行 groupCells 个数 = 组数 4（不是 12 列逐列重复）', f6.ga.cells.length, 4);
    t.ne('6.5b 表格分组行 groupCells 个数 ≠ 列数 12', f6.ga.cells.length, f6.ga.n);
    t.eq('6.6 每个合并格 count = 该组 bar 数（3/3/3/3）', countsOf(f6.ga.cells).join('|'), '3|3|3|3');
    t.eq('6.6b 每个合并格 count × 带宽 span = 该组宽度（误差 ≤1px）',
      f6.ga.cells.map(function (c) {
        return Math.abs(c.span - c.count * (f6.ga ? f6.ga.bandW : 0)) <= 1 ? 1 : 0;
      }).join(''), '1111');
    t.eq('6.7 表格分组行标签 = 组名（面板 order，非字母序）',
      f6.ga.cells.map(function (c) { return c.label; }).join('|'), 'T004|T001|T002|T003');
    t.eq('6.8 合并格覆盖全部 12 列且首尾衔接（i0/i1 连续）',
      f6.ga.cells.map(function (c) { return c.i0 + '-' + c.i1; }).join(','), '0-2,3-5,6-8,9-11');
    t.eq('6.9 相邻合并格边界严格衔接（右沿 = 下一格左沿，误差 ≤1px）',
      f6.ga.cells.slice(1).map(function (c, i) {
        return Math.abs(c.left - f6.ga.cells[i].right) <= 1 ? 1 : 0;
      }).join(''), '111');
    /* __groupAxis 与表格分组行同源（cells 数一致、标签一致） */
    t.eq('6.10 __groupAxis.cells 数 = 表格分组行 groupCells 数',
      (f6.ga && f6.ga.cells ? f6.ga.cells.length : -1), f6.ga.cells.length);
    t.eq('6.11 __groupAxis 每个 cell 的 count 也 = 该组 bar 数',
      countsOf((f6.ga && f6.ga.cells) || []).join('|'), '3|3|3|3');
    /* 第一层标签在表格路径同样剥掉组名前缀 */
    t.eq('6.12 表格路径第一层标签只剩批号（组名前缀被剥掉）', f6.xLabels[0], 'L0001');
    t.ok('6.13 表格路径第一层标签不含组名前缀', String(f6.xLabels[0] || '').indexOf('T004') < 0,
      f6.xLabels.slice(0, 4));
    /* 组名在 graphic 里各画 1 次（表格分组行），不是每列一次 */
    t.eq('6.14 组名在表格分组行各画 1 次（4 个文本）', f6.groupTexts.length, 4);
    /* 表格通道停用后，这两条改验轴层分组带的覆盖与高度（原为表格 nAll / rowH） */
    t.eq('6.15 合并格覆盖全部 12 列（首格 i0=0，末格 i1=11）',
      (f6.ga.cells[0] ? f6.ga.cells[0].i0 : null) + '-' +
      (f6.ga.cells.length ? f6.ga.cells[f6.ga.cells.length - 1].i1 : null), '0-11');
    t.ok('6.16 轴层分组带占实际高度（h > 0，不是浮在轴线上）', f6.ga.h > 0, f6.ga.h);
    /* 关闭表格 → 回到统计行通道，行为不变（第 7 段验证） */
    await page.evaluate(function () {
      window.__YMS__.applyPlot({ table: { show: false, frame: false } });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(400);

    /* ==================================================================
       7. 恢复默认后再次确认分组行回来（开关往返不残留）
       ================================================================== */
    await plot(page, ['Tool_Group', 'Lot']);
    const g7 = await geom(page, PANEL_ORDER);
    t.eq('7.1 关闭数据表格后分组行恢复', g7.ga ? g7.ga.on : false, true);
    t.eq('7.2 恢复后 cells 仍 = 4', g7.ga ? g7.ga.cells.length : 0, 4);
    t.eq('7.3 恢复后顺序仍是面板 order',
      g7.ga ? g7.ga.cells.map(function (c) { return c.label; }).join('|') : '', 'T004|T001|T002|T003');

    t.noErrors('7.4 全程零未捕获异常 / 控制台错误', ctx.errors);

    /* ==================================================================
       8. 普通列（**没有** groupMap）+ 数据表格：X 轴第一列连续重复也合并
          —— 用户实际配置：X Label = Tool_Group(普通列) + Lot，plot.table.show = true
          迭代 29 起 groupColPos 在无显式映射时把第一列当分组维度
       ================================================================== */
    const plainCsv = (function () {
      const rows = ['Fab,Product,Tool_Group,Lot,Yield'];
      const tools = ['Tool1', 'Tool1', 'Tool2', 'Tool2', 'Tool4', 'Tool3'];
      const lots = ['L0001', 'L0059', 'L0295', 'L1181', 'L2161', 'L3387'];
      for (let i = 0; i < tools.length; i++) {
        for (let r = 0; r < 3; r++) {
          rows.push('Fab1,Prod1,' + tools[i] + ',' + lots[i] + ',' + (88 + i * 0.9 + r * 0.3).toFixed(1));
        }
      }
      return rows.join('\n');
    })();
    const impU = await app.importText(page, 'plain_group.csv', plainCsv);
    t.eq('8.1 导入普通列数据 18 行 × 5 列（Tool_Group 为普通列）', impU.rows + 'x' + impU.cols, '18x5');
    const hasMap = await page.evaluate(function () {
      const df = (window.YMS.Store && YMS.Store.state) ? YMS.Store.state.df : null;
      const cs = (df && df.columns) ? df.columns : [];
      const c = cs.filter(function (x) { return x.name === 'Tool_Group'; })[0];
      return !!(c && c.groupMap && c.groupMap.groups && c.groupMap.groups.length);
    });
    t.eq('8.2 该列确实没有 groupMap（不依赖分组映射也能合并）', hasMap, false);

    await page.evaluate(function () {
      window.__YMS__.setMode('plot');
      window.__capOpts = [];
      window.__YMS__.applyPlot({
        type: 'box', x: ['Tool_Group', 'Lot'], values: ['Yield'],
        sorters: [], splitBy: [], pageBy: [], display: 'facet',
        table: { show: true, frame: false }
      });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(900);
    const u8 = await geom(page, ['Tool1', 'Tool2', 'Tool4', 'Tool3']);
    t.eq('8.3 普通列路径分组行启用（__groupAxis.on）', u8.ga.on, true);
    t.eq('8.4 走的是轴层统计行通道（表格通道已停用）', u8.ga.source, 'axis');
    t.eq('8.5 表格分组行合并格数 = 组数 4（不是列数 6）', u8.ga.cells.length, 4);
    t.eq('8.6 合并格标签 = 该组在第一列的原始值（各 1 次）',
      u8.ga.cells.map(function (c) { return c.label; }).join('|'), 'Tool1|Tool2|Tool4|Tool3');
    t.eq('8.7 每格 count = 该组连续重复的列数',
      countsOf(u8.ga.cells).join('|'), '2|2|1|1');
    t.eq('8.8 每格跨度 = count × 带宽（误差 ≤1px）',
      u8.ga.cells.map(function (c) {
        return Math.abs(c.span - c.count * u8.ga.bandW) <= 1 ? 1 : 0;
      }).join(''), '1111');
    t.eq('8.9 合并格覆盖全部列且首尾衔接',
      u8.ga.cells.map(function (c) { return c.i0 + '-' + c.i1; }).join(','), '0-1,2-3,4-4,5-5');
    t.eq('8.10 第一层标签剥掉组名前缀（只剩批号）', u8.xLabels[0], 'L0001');
    t.ok('8.11 第一层标签不含 Tool1 前缀',
      String(u8.xLabels[0] || '').indexOf('Tool1') < 0, u8.xLabels.slice(0, 3));

    /* 单列 X：一 bar 一组，必须不产生分组行（不退化） */
    await page.evaluate(function () {
      window.__capOpts = [];
      window.__YMS__.applyPlot({
        type: 'box', x: ['Tool_Group'], values: ['Yield'],
        sorters: [], splitBy: [], pageBy: [], display: 'facet',
        table: { show: true, frame: false }
      });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(700);
    const u8b = await geom(page, []);
    t.eq('8.12 单列 X 不产生分组行（无合并、不退化）', u8b.ga.on, false);
    t.eq('8.13 单列 X 表格分组行不出现分组格', u8b.tb.groupCells.length, 0);

    t.noErrors('8.14 第 8 段零未捕获异常 / 控制台错误', ctx.errors);

    /* ==================================================================
       9. Merge Crowded（合并防拥挤）生效时仍保留分组行
          用户实际配置：80 类目 / box 上限 40 → 触发自动合并（每 2 类并一格）
          迭代 29 起合并**只在组内进行**，绝不跨组，故合并后组标签仍保留
       ================================================================== */
    const crowdCsv = (function () {
      const rows = ['Fab,Product,Tool_Group,Lot,Yield'];
      const tools = ['Tool1', 'Tool2', 'Tool4', 'Tool3'];
      for (let ti = 0; ti < tools.length; ti++) {
        for (let li = 0; li < 20; li++) {
          const lot = 'L' + String(ti * 20 + li + 1).padStart(4, '0');
          for (let r = 0; r < 3; r++) {
            rows.push('Fab1,Prod1,' + tools[ti] + ',' + lot + ',' + (88 + ti * 0.9 + li * 0.05 + r * 0.3).toFixed(1));
          }
        }
      }
      return rows.join('\n');
    })();
    const impC = await app.importText(page, 'crowd80.csv', crowdCsv);
    t.eq('9.1 导入 80 个类目的数据（4 组 × 20 批）', impC.rows > 0, true);

    await page.evaluate(function () {
      window.__YMS__.setMode('plot');
      window.__capOpts = [];
      window.__YMS__.applyPlot({
        type: 'box', x: ['Tool_Group', 'Lot'], values: ['Yield'],
        sorters: [], splitBy: [], pageBy: [], display: 'facet',
        merge: { mode: 'auto', limit: null },
        table: { show: true, frame: false }
      });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(1100);
    const u9 = await geom(page, ['Tool1', 'Tool2', 'Tool4', 'Tool3']);
    t.eq('9.2 80 类目触发合并（列数被压到 ≤40）', u9.xLabels.length <= 40, true);
    t.ok('9.3 确实发生了合并（列数 < 原始类别数 80）', u9.xLabels.length < 80, u9.xLabels.length);
    t.eq('9.4 合并生效时分组行仍启用（__groupAxis.on）', u9.ga.on, true);
    t.eq('9.5 走的是轴层统计行通道（表格通道已停用）', u9.ga.source, 'axis');
    t.eq('9.6 合并后合并格数仍 = 组数 4（不跨组）', u9.ga.cells.length, 4);
    t.eq('9.7 合并后标签仍是各组第一列值', 
      u9.ga.cells.map(function (c) { return c.label; }).join('|'), 'Tool1|Tool2|Tool4|Tool3');
    t.eq('9.8 四个合并格的 count 之和 = 全部列数（覆盖无缝隙）',
      u9.ga.cells.reduce(function (s, c) { return s + c.count; }, 0), u9.xLabels.length);
    t.eq('9.9 每格跨度 = count × 带宽（误差 ≤1px）',
      u9.ga.cells.map(function (c) {
        return Math.abs(c.span - c.count * u9.ga.bandW) <= 1 ? 1 : 0;
      }).join(''), '1111');
    t.ok('9.10 合并后第一层标签仍剥掉组名前缀',
      u9.xLabels.length > 0 && String(u9.xLabels[0]).indexOf('Tool1') < 0, u9.xLabels.slice(0, 3));

    t.noErrors('9.11 第 9 段零未捕获异常 / 控制台错误', ctx.errors);
  }
};
