/* ==========================================================================
   YMS · test/cases/zoom-table-align.js
   任务 G ①：全屏 X 轴缩放后，**每个可见 box 正下方必须有自己的那一列数据**
     （用户原话：「每个 box 对应的数据只显示在我画的椭圆框里面，这个数据不对」
       → 参数行 Lot/Layer/Chamber_Group/Tool_Group 与统计行 Mean/Std/Nu%
         必须逐列对准各自的 box，列数 = 可见类数、没有空列、没有错位、没有重叠）

   断言口径（一律读数，不读中间量自证）：
     · 列数与几何来自 option.__axisTableSpec（任务 G 新增的逐列模型 cols：cx/span/left/right
       + label + statLines + 各级分组覆盖格），labels / statLines 已是**可见窗口**口径
     · box 中心来自 ECharts series 的 item graphic 包围盒（真实像素）
     · 文字是否真的画出去 / 画在哪个 x：读 zrender 显示列表的 bbox（真实绘制）
     · 统计值由本文件用夹具原始数据**独立算**（Mean=均值、Std=总体标准差(÷N)、Nu%=Std/|Mean|×100，
       与应用同定义、按应用的小数位 2 位取整），不读图表

   覆盖：卡片未缩放（回归）+ 全屏 5 个缩放窗口（25-75 / 75-100 / 全量 / 0 起点窄窗 / 全量）
   任务 G ②：box / line / bar / scatter / hist 五种图型的横轴分组合并（__groupAxis）横向一致，
             hist 不适用的原因 + 设置区**可见说明文案**
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const helper = require('../helpers/app');

const CASE_FILE = 'zoom-table-align.js';

/* --------------------------------------------------------------- 夹具（4 列 X） */
const TOOLS = ['Tool1', 'Tool2', 'Tool4', 'Tool3'];
const CHAMBERS = ['CHM1', 'CHM2'];
const LAYERS = ['PA', 'VA', 'M2', 'Pol'];

/** 32 个类别 = 4 Tool × 2 Chamber × 4 Layer × 2 Lot；每类 2 行（够算 std），Yield 保留 3 位 */
function makeCsv4() {
  const rows = ['Fab,Product,Tool_Group,Chamber_Group,Layer,Lot,Yield'];
  const raw = [];                                  // 供本文件独立算统计用
  let k = 0;
  TOOLS.forEach(function (tl, ti) {
    CHAMBERS.forEach(function (ch) {
      LAYERS.forEach(function (ly, li) {
        for (let j = 1; j <= 2; j++) {
          k++;
          const lot = 'L' + ('000' + (ti * 100 + li * 2 + j)).slice(-4);
          const y = 86 + (k % 13) * 0.55 + ti * 0.4;
          rows.push('Fab1,Prod1,' + tl + ',' + ch + ',' + ly + ',' + lot + ',' + y.toFixed(2));
          raw.push({ tool: tl, chamber: ch, layer: ly, lot: lot, y: Number(y.toFixed(2)) });
        }
      });
    });
  });
  return { csv: rows.join('\n'), raw: raw };
}

/** 独立算统计量：与应用同定义（总体标准差 ÷N；小数位 2；Nu% 用取整后的 Std/Mean） */
function statsOf(list) {
  const n = list.length;
  if (!n) return null;
  const sum = list.reduce(function (a, b) { return a + b; }, 0);
  const mean = sum / n;
  let ss = 0;
  list.forEach(function (v) { ss += (v - mean) * (v - mean); });
  const std = Math.sqrt(ss / n);
  const r2 = function (v) { return Number(v.toFixed(2)); };
  const meanR = r2(mean), stdR = r2(std);
  const nupct = meanR === 0 ? null : r2(stdR / Math.abs(meanR) * 100);
  return { n: n, mean: meanR, std: stdR, nupct: nupct };
}

/* ------------------------------------------------------------- 页面内读数 */
/**
 * 一张图的完整读数（在页面里执行，不引用外部变量）
 * @param {object} a {sel, bandTol}
 */
function READ(a) {
  const el = document.querySelector(a.sel);
  const inst = el ? window.echarts.getInstanceByDom(el) : null;
  if (!inst) return { ok: false, reason: 'no-instance', sel: a.sel };
  const gm = inst.getModel().getComponent('grid');
  if (!gm || !gm.coordinateSystem) return { ok: false, reason: 'no-coordinate-system', sel: a.sel };
  const rect = gm.coordinateSystem.getRect();
  const H = inst.getHeight();
  const op = inst.getOption();
  const xa = Array.isArray(op.xAxis) ? op.xAxis[0] : op.xAxis;
  const spec = op.__axisTableSpec || null;
  let extent = null;
  try {
    const ax = inst.getModel().getComponent('xAxis', 0).axis;
    const e2 = ax.scale.getExtent();
    extent = { lo: e2[0], hi: e2[1] };
  } catch (e) { extent = null; }

  /* ① 每个 box 的真实像素中心（单值图 → 一个 box 对应一个类别） */
  const boxes = [], boxSeries = [];
  const sers = inst.getModel().getSeries();
  for (let s = 0; s < sers.length; s++) {
    const sm = sers[s];
    if (sm.subType !== 'boxplot') continue;
    boxSeries.push(s);
    const data = sm.getData();
    for (let d = 0; d < data.count(); d++) {
      const ge = data.getItemGraphicEl(d);
      if (!ge) continue;
      const r = ge.getBoundingRect().clone();
      const m = ge.getComputedTransform ? ge.getComputedTransform() : ge.transform;
      if (m) r.applyTransform(m);
      if (!isFinite(r.x) || !isFinite(r.width)) continue;
      boxes.push({ d: d, cx: Math.round((r.x + r.width / 2) * 100) / 100 });
    }
  }

  /* ② 真实绘制的文字（zrender 显示列表 bbox），只取绘图区下方的 */
  let disp = [];
  try { disp = inst.getZr().storage.getDisplayList(true, true, true) || []; } catch (e2) { disp = []; }
  const texts = [];
  const axisTitle = String(xa.name || '');
  for (let i = 0; i < disp.length; i++) {
    const e = disp[i], st = e && e.style;
    if (!st || typeof st.text !== 'string' || !st.text) continue;
    const r = e.getBoundingRect().clone();
    const m = e.getComputedTransform ? e.getComputedTransform() : e.transform;
    if (m) r.applyTransform(m);
    /* 旋转 90° 的统计文字是「底部对齐、向上延伸」—— bbox.y 可能远高于 grid 底，
       只看 r.y 会把整行漏掉（实测「画出行 0」就是栽在这里）。改为「只要向下探到 grid 底就收」。 */
    if (r.y + r.height < rect.y + rect.height - 2) continue;
    if (axisTitle && st.text === axisTitle) continue;        // X 轴标题不算列数据
    texts.push({
      t: st.text,
      cx: Math.round((r.x + r.width / 2) * 100) / 100,
      y: Math.round(r.y * 100) / 100,
      h: Math.round(r.height * 100) / 100
    });
  }

  /* ③ 各分组级真实画出的格数（graphic 元素带 __groupBand 标记） */
  const gi = op.graphic || [];
  const flat = [];
  (function walk(n, depth) {
    if (!n || depth > 4) return;
    if (Array.isArray(n)) { n.forEach(function (x) { walk(x, depth + 1); }); return; }
    if (n.__axisBlock) flat.push(n);
    if (n.elements) walk(n.elements, depth + 1);
  })(gi, 0);
  const groupDrawn = {};
  let paramDrawn = 0;
  flat.forEach(function (e) {
    if (e.__groupBand !== undefined) groupDrawn[e.__groupBand] = (groupDrawn[e.__groupBand] || 0) + 1;
    if (e.__paramRow !== undefined) paramDrawn++;
  });

  const ga = op.__groupAxis || null;
  const sb0 = op.__statBlock || null;
  return {
    ok: true, sel: a.sel, W: inst.getWidth(), H: H,
    statBlock: sb0 ? { statBottoms: (sb0.statBottoms || []).slice(), statRows: sb0.statRows } : null,
    grid: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, b: rect.y + rect.height },
    gridBottomOpt: (op.grid && op.grid[0]) ? op.grid[0].bottom : null,
    extent: extent, nCat: (xa.data || []).length, xIsValue: !(xa.data && xa.data.length),
    spec: spec ? {
      colCount: spec.colCount, colLo: spec.colLo, colHi: spec.colHi, bandW: spec.bandW,
      labelsN: (spec.labels || []).length, statLinesN: (spec.statLines || []).length,
      statRows: spec.statRows, mode: spec.mode, groupBand: spec.groupBand,
      cols: (spec.cols || []).map(function (c) {
        return {
          i: c.i, label: c.label, cx: c.cx, span: c.span, left: c.left, right: c.right,
          statLines: (c.statLines || []).slice(), drawn: !!c.drawn,
          levels: (c.levels || []).map(function (L) {
            return L ? { name: L.name, label: L.label, cx: L.cx, span: L.span, i0: L.i0, i1: L.i1, count: L.count } : null;
          })
        };
      }),
      labels: (spec.labels || []).slice(), statLines: (spec.statLines || []).slice()
    } : null,
    ga: ga ? { on: ga.on, levelCount: ga.levelCount, cellsByLevel: (ga.cellsByLevel || []).slice(), groupBand: ga.band } : null,
    boxes: boxes, boxSeriesN: boxSeries.length,
    texts: texts, groupDrawn: groupDrawn, paramDrawn: paramDrawn,
    errors: []
  };
}

/* --------------------------------------------------------------- 判定工具 */

/** 把「同一水平行」的文本按 y 聚成一簇（行距 ≥ 12px 就切开） */
function clusterRows(texts) {
  const arr = texts.slice().sort(function (a, b) { return a.y - b.y; });
  const rows = [];
  let cur = null;
  arr.forEach(function (t) {
    const c = t.y + t.h;          /* 旋转 90° 的文字按底边对齐 → 用底边聚行 */
    if (!cur || (c - cur.cMax) > 12) {
      cur = { items: [t], cMax: c };
      rows.push(cur);
    } else {
      cur.items.push(t);
      if (c > cur.cMax) cur.cMax = c;
    }
  });
  return rows.map(function (r) { return r.items; });
}

function sortedBy(arr) { return arr.slice().sort(function (a, b) { return a - b; }); }

/**
 * 逐列判定（列数 / 空文本 / 对位 / 列宽 / 重叠）
 * @param {object} m READ 结果
 */
function checkColumns(m) {
  const out = {
    visible: null, colCount: null, colDiff: null,
    emptyLeaf: 0, emptyStat: 0, emptyLevel: 0,
    alignViol: 0, alignMax: 0, widthViol: 0, widthPctOk: 0,
    overlapPairs: 0, spanVsBand: 0, drawnMissing: 0, rowsDrawn: 0, drawnAlignViol: 0
  };
  if (!m.ok || !m.spec) return out;
  const sp = m.spec;
  const vis = (m.extent ? (m.extent.hi - m.extent.lo + 1) : null);
  out.visible = vis;
  out.colCount = sp.colCount;
  out.colDiff = (vis === null) ? null : (sp.colCount - vis);

  /* ② 空文本列：叶子参数行 / 每个统计行 / 每个分组级覆盖格 */
  sp.cols.forEach(function (c) {
    if (!String(c.label || '').trim()) out.emptyLeaf++;
    for (let k = 0; k < (sp.statRows || 0); k++) {
      if (!String((c.statLines || [])[k] || '').trim()) out.emptyStat++;
    }
    (c.levels || []).forEach(function (L) {
      if (L && !String(L.label || '').trim()) out.emptyLevel++;
    });
  });

  /* ③ 对位：每个可见类别 i，|cell.cx − box 中心| ≤ 1px（单值图 → 一个类别一个 box） */
  const boxOf = {};
  m.boxes.forEach(function (b) { boxOf[b.d] = b.cx; });
  sp.cols.forEach(function (c) {
    const bx = boxOf[c.i];
    if (bx === undefined) return;
    const dv = Math.abs(c.cx - bx);
    if (dv > out.alignMax) out.alignMax = dv;
    if (dv > 1) out.alignViol++;
  });

  /* ④ 列宽 = 当前带宽（≤1px 的列占比） */
  const bandW = sp.bandW;
  sp.cols.forEach(function (c) {
    out.spanVsBand = Math.max(out.spanVsBand, Math.abs(c.span - bandW));
    if (Math.abs(c.span - bandW) > 1) out.widthViol++;
  });
  out.widthPctOk = sp.cols.length ? (100 * (sp.cols.length - out.widthViol) / sp.cols.length) : 0;

  /* ⑤ 无重叠：任意两列 [left, right] 区间相交（重叠长度 > 1e-6） */
  const iv = sp.cols.map(function (c) { return { l: Math.min(c.left, c.left + c.span), r: Math.max(c.left, c.left + c.span) }; });
  iv.sort(function (a, b) { return a.l - b.l; });
  for (let i = 0; i < iv.length; i++) {
    for (let j = i + 1; j < iv.length; j++) {
      const ov = Math.min(iv[i].r, iv[j].r) - Math.max(iv[i].l, iv[j].l);
      if (ov > 0.5) out.overlapPairs++;      /* 容差 0.5px：舍入伪相交不算重叠 */
    }
  }

  /* ⑥ 真实绘制：每个统计行都必须自己画出一整行（数量 = 列数，cx 与列一一对应），
        且叶子参数行（Lot 列）同样逐列画出 */
  const rows = clusterRows(m.texts);
  function matchRow(expected) {
    const want = sortedBy(expected);
    for (let r = 0; r < rows.length; r++) {
      const got = sortedBy(rows[r].map(function (t) { return t.t; }));
      if (got.length !== want.length) continue;
      let same = true;
      for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) { same = false; break; }
      if (same) return rows[r];
    }
    return null;
  }
  const colCx = sortedBy(sp.cols.map(function (c) { return c.cx; }));
  function alignRow(row) {
    const got = sortedBy(row.map(function (t) { return t.cx; }));
    if (got.length !== colCx.length) return false;
    for (let i = 0; i < got.length; i++) if (Math.abs(got[i] - colCx[i]) > 1) return false;
    return true;
  }
  /* 「统计行真的逐列画出来了吗」—— 纯几何判定：
     把绘图区下方的文字按**底边**分成行（旋转 90° 的文字底部对齐），
     只要某一行满足「每列恰好一个文字、且 cx 与列心一一对齐（≤1px）」，这一行就算真画出来了。
     要求 ≥ 统计行数 + 1（3 个统计行 + 1 个叶子参数行）。
     不用 __statBlock（缩放重算后的 graphic 不带 __statRow 标记）也不用串匹配（取整可能不同）。 */
  const bks = [];
  m.texts.forEach(function (t) {
    const bb = t.y + t.h;
    let bk = null;
    for (let q = 0; q < bks.length; q++) if (Math.abs(bks[q].b - bb) <= 6) { bk = bks[q]; break; }
    if (!bk) { bk = { b: bb, items: [] }; bks.push(bk); }
    bk.items.push(t);
  });
  let rowsDrawn = 0, drawnAlignViol = 0, rowsPresent = 0;
  bks.forEach(function (bk) {
    if (bk.items.length >= 2) rowsPresent++;              // 该行确实画了多个格子
    if (bk.items.length !== colCx.length) return;        // 不是「一列一个」的行，跳过
    const got = sortedBy(bk.items.map(function (t) { return t.cx; }));
    let ok = true;
    for (let i = 0; i < got.length; i++) if (Math.abs(got[i] - colCx[i]) > 1) { ok = false; break; }
    if (ok) rowsDrawn++; else drawnAlignViol++;
  });
  out.rowsDrawn = rowsDrawn;
  out.rowsPresent = rowsPresent;
  out.drawnAlignViol = drawnAlignViol;
  return out;
}

/** 分组级几何：span == count × bandW、cx == 覆盖列的中心、label 非空 */
function checkGroups(m) {
  const res = { levels: 0, cells: 0, spanViol: 0, cxViol: 0, empty: 0, drawnMismatch: 0, maxSpanErr: 0, maxCxErr: 0 };
  if (!m.ok || !m.spec || !m.spec.cols.length) return res;
  const bandW = m.spec.bandW;
  const byCell = {};                                    // i0|i1 → 该格覆盖的列
  const levelN = (m.spec.cols[0].levels || []).length;
  res.levels = levelN;
  for (let lv = 0; lv < levelN; lv++) {
    const seen = {};
    m.spec.cols.forEach(function (c) {
      const L = c.levels[lv];
      if (!L) return;
      const key = L.name + '|' + L.i0 + '|' + L.i1;
      if (!seen[key]) { seen[key] = { cell: L, cols: [] }; res.cells++; }
      seen[key].cols.push(c.cx);
    });
    Object.keys(seen).forEach(function (key) {
      const e = seen[key], cell = e.cell;
      if (!String(cell.label || '').trim()) res.empty++;
      const spanErr = Math.abs(cell.span - cell.count * bandW);
      if (spanErr > res.maxSpanErr) res.maxSpanErr = spanErr;
      if (spanErr > 1) res.spanViol++;
      const mid = (Math.min.apply(null, e.cols) + Math.max.apply(null, e.cols)) / 2;
      const cxErr = Math.abs(cell.cx - mid);
      if (cxErr > res.maxCxErr) res.maxCxErr = cxErr;
      if (cxErr > 1) res.cxViol++;
    });
    /* 真实画出的格数 = 该级格数（不是「每列一个」，合并格只画一次） */
    const drawnN = m.groupDrawn[lv] || 0;
    if (Object.keys(seen).length !== drawnN) res.drawnMismatch++;
  }
  return res;
}

/* --------------------------------------------------------------- 小工具 */
async function waitReady(page, sel) {
  for (let i = 0; i < 40; i++) {
    const ok = await page.evaluate(function (s) {
      const el = document.querySelector(s);
      const inst = el ? window.echarts.getInstanceByDom(el) : null;
      if (!inst) return false;
      const gm = inst.getModel().getComponent('grid');
      return !!(gm && gm.coordinateSystem);
    }, sel);
    if (ok) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/** 派发 dataZoom 并等几何稳定（连续两次读数一致） */
async function zoomTo(page, sel, start, end) {
  await page.evaluate(function (a) {
    const el = document.querySelector(a.sel);
    const inst = el ? window.echarts.getInstanceByDom(el) : null;
    if (inst) inst.dispatchAction({ type: 'dataZoom', start: a.s[0], end: a.s[1] });
  }, { sel: sel, s: [start, end] });
  let prev = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(150);
    const cur = await page.evaluate(function (s) {
      const el = document.querySelector(s);
      const inst = el ? window.echarts.getInstanceByDom(el) : null;
      if (!inst) return null;
      const op = inst.getOption();
      const sp = op.__axisTableSpec;
      let ext = null;
      try { ext = inst.getModel().getComponent('xAxis', 0).axis.scale.getExtent(); } catch (e) { }
      return { lo: ext ? ext[0] : null, hi: ext ? ext[1] : null, cols: sp ? sp.colCount : null, band: sp ? sp.bandW : null };
    }, sel);
    if (cur && prev && cur.lo === prev.lo && cur.hi === prev.hi && cur.cols === prev.cols && cur.band === prev.band) return cur;
    prev = cur;
  }
  return prev;
}

/* ------------------------------------------------------------------ 用例 */
module.exports = {
  id: 'g1-zoom-table-align',
  title: '任务 G：全屏缩放后逐列对齐（列数=可见类数 / 无空列 / 对齐 box / 列宽=带宽 / 无重叠 / 数值正确）+ 5 图型分组带',
  run: async function (ctx) {
    const page = ctx.page, t = ctx.t;
    const HERE = __dirname;

    /* ---------- 第 1 段：用例登记（自证本文件已被 run.js 收编） ---------- */
    t.ok('1.1 用例文件存在：test/cases/' + CASE_FILE, fs.existsSync(path.join(HERE, CASE_FILE)), { path: CASE_FILE });
    let runSrc = '';
    try { runSrc = fs.readFileSync(path.join(HERE, '..', 'run.js'), 'utf8'); } catch (e) { runSrc = ''; }
    t.contains("1.2 run.js 的 CASE_FILES 已登记 '" + CASE_FILE + "'", runSrc, "'" + CASE_FILE + "'");
    t.eq('1.3 本用例 id 与登记一致', module.exports.id, 'g1-zoom-table-align');

    /* ---------- 第 2 段：夹具 + 出图（单值 → 一个类别一个 box，便于逐列对位） ---------- */
    await page.setViewportSize({ width: 1680, height: 950 });
    const fx = makeCsv4();
    const imp = await helper.importText(page, 'zoomalign.csv', fx.csv);
    t.ok('2.1 夹具导入成功（' + imp.rows + ' 行 = 夹具原始行数 ' + fx.raw.length + '）',
      imp.ok && imp.rows === fx.raw.length, { rows: imp.rows, raw: fx.raw.length });
    /* 独立算 3 个抽查类别的统计量（不读图表） */
    const colKey = function (r) { return r.tool + '|' + r.chamber + '|' + r.layer + '|' + r.lot; };
    const groups = {};
    fx.raw.forEach(function (r) {
      const k = colKey(r);
      (groups[k] = groups[k] || []).push(r.y);
    });
    await page.evaluate(function () {
      window.__YMS__.setMode('plot');
      window.__YMS__.applyPlot({
        type: 'box', x: ['Tool_Group', 'Chamber_Group', 'Layer', 'Lot'], values: ['Yield'],
        sorters: [], splitBy: [], pageBy: [], display: 'facet',
        merge: { mode: 'manual:20', limit: null },
        stats: { show: true, items: ['mean', 'std', 'nupct'], rotate: 90 }
      });
      window.__YMS__.submitPlot({});
    });
    const CARD = '.chart-card .chart-body';
    const FS = '#fullscreen-root .echarts-host';
    t.ok('2.2 卡片图表已渲染', await waitReady(page, CARD), { sel: CARD });

    /* ---------- 第 3 段：卡片未缩放（回归，第 8 条） ---------- */
    let m = await page.evaluate(READ, { sel: CARD });
    t.ok('3.1 卡片读数成功（有 __axisTableSpec 逐列模型）', m.ok && !!m.spec && m.spec.colCount > 0,
      { ok: m.ok, colCount: m.spec ? m.spec.colCount : null });
    let c = checkColumns(m);
    t.eq('3.2 卡片：列数 = 可见类数（' + c.colCount + ' vs ' + c.visible + '）', c.colDiff, 0);
    t.eq('3.3 卡片：空文本列 = 0（叶子参数行 ' + c.emptyLeaf + ' / 统计行 ' + c.emptyStat + ' / 分组覆盖格 ' + c.emptyLevel + '）',
      c.emptyLeaf + c.emptyStat + c.emptyLevel, 0);
    t.eq('3.4 卡片：对位超 1px 的列数 = 0（最大偏差 ' + c.alignMax.toFixed(2) + 'px）', c.alignViol, 0);
    t.near('3.5 卡片：列宽 = 带宽（≤1px 占比 %）', c.widthPctOk, 100, 1e-9);
    t.eq('3.6 卡片：列区间重叠对数 = 0', c.overlapPairs, 0);
    t.ok('3.7 卡片：下方文字行数 ' + c.rowsPresent + ' ≥ ' + ((m.spec.statRows || 0) + 1) +
      '（统计行 ' + m.spec.statRows + ' + 叶子行 1）· 逐列对齐行 ' + c.rowsDrawn + ' · 错位行 ' + c.drawnAlignViol,
      c.rowsPresent >= (m.spec.statRows || 0) + 1 && c.rowsDrawn >= 1 && c.drawnAlignViol === 0,
      { rowsPresent: c.rowsPresent, rowsDrawn: c.rowsDrawn, drawnAlignViol: c.drawnAlignViol, statRows: m.spec.statRows });
    t.contains('3.8 卡片：labels / statLines 已是逐列口径（' + m.spec.labelsN + ' / ' + m.spec.statLinesN + '）',
      m.spec.labelsN + '/' + m.spec.statLinesN, c.colCount + '/' + c.colCount);

    /* ---------- 第 4 段：进全屏 + 5 个缩放窗口（第 7 条，每步都报数） ---------- */
    await page.evaluate(function () {
      const b = document.querySelectorAll('.chart-card button');
      for (let i = 0; i < b.length; i++) {
        if ((b[i].getAttribute('title') || '').indexOf('放大') >= 0) { b[i].click(); return; }
      }
      if (window.__YMS__.openFullscreen) window.__YMS__.openFullscreen(0);
    });
    t.ok('4.1 全屏已打开', await waitReady(page, FS), { sel: FS });

    const STEPS = [[25, 75], [75, 100], [0, 100], [0, 8], [0, 100]];
    const stepReport = [];
    let allStepsOk = true;
    for (let s = 0; s < STEPS.length; s++) {
      const st = await zoomTo(page, FS, STEPS[s][0], STEPS[s][1]);
      m = await page.evaluate(READ, { sel: FS });
      const zc = checkColumns(m);
      const zg = checkGroups(m);
      stepReport.push({
        step: (s + 1), win: STEPS[s].join('-'), extent: m.extent, vis: zc.visible, cols: zc.colCount,
        diff: zc.colDiff, empty: zc.emptyLeaf + zc.emptyStat + zc.emptyLevel,
        alignViol: zc.alignViol, alignMax: zc.alignMax, widthPctOk: zc.widthPctOk,
        overlap: zc.overlapPairs, rowsDrawn: zc.rowsDrawn, drawnAlignViol: zc.drawnAlignViol,
        groups: zg
      });
      t.ok('4.' + (s + 2) + 'a 第' + (s + 1) + '步 ' + STEPS[s].join('-') + '%：可见 ' + zc.visible +
        ' 类 / 列数 ' + zc.colCount + '（差 ' + zc.colDiff + '）· 带宽 ' + (m.spec ? m.spec.bandW : '?') + 'px',
        m.ok && zc.visible !== null && zc.colDiff === 0 && zc.colCount === zc.visible,
        { extent: m.extent, colCount: zc.colCount, bandW: m.spec ? m.spec.bandW : null });
      t.ok('4.' + (s + 2) + 'b 第' + (s + 1) + '步：空文本列 ' + (zc.emptyLeaf + zc.emptyStat + zc.emptyLevel) +
        ' · 对位超 1px 列数 ' + zc.alignViol + '（最大 ' + zc.alignMax.toFixed(2) + 'px）· 列宽合格率 ' +
        zc.widthPctOk.toFixed(0) + '% · 重叠 ' + zc.overlapPairs + ' 对',
        (zc.emptyLeaf + zc.emptyStat + zc.emptyLevel) === 0 && zc.alignViol === 0 &&
        zc.widthPctOk === 100 && zc.overlapPairs === 0,
        { empty: zc.emptyLeaf + zc.emptyStat + zc.emptyLevel, alignViol: zc.alignViol, widthPctOk: zc.widthPctOk, overlap: zc.overlapPairs });
      t.ok('4.' + (s + 2) + 'c 第' + (s + 1) + '步：下方文字行 ' + zc.rowsPresent + '（对齐行 ' + zc.rowsDrawn + ' / 错位行 ' + zc.drawnAlignViol +
        '）· 分组格 span/cx 误差 ≤ ' + zg.maxSpanErr.toFixed(2) + '/' + zg.maxCxErr.toFixed(2) + 'px',
        zc.rowsPresent >= (m.spec ? (m.spec.statRows || 0) : 0) + 1 && zc.rowsDrawn >= 1 && zc.drawnAlignViol === 0 &&
        zg.spanViol === 0 && zg.cxViol === 0 && zg.empty === 0 && zg.drawnMismatch === 0,
        { rowsDrawn: zc.rowsDrawn, drawnAlignViol: zc.drawnAlignViol, spanViol: zg.spanViol, cxViol: zg.cxViol, empty: zg.empty, drawnMismatch: zg.drawnMismatch });
      if (zc.colDiff !== 0 || (zc.emptyLeaf + zc.emptyStat + zc.emptyLevel) !== 0 || zc.alignViol !== 0 ||
        zc.widthPctOk !== 100 || zc.overlapPairs !== 0 || zc.drawnAlignViol !== 0) allStepsOk = false;
    }
    t.ok('4.7 第 1~5 步（' + STEPS.map(function (s2) { return s2.join('-'); }).join(' → ') + '）每一步全部成立',
      allStepsOk, stepReport);

    /* ---------- 第 5 段：数值正确性（第 6 条，抽查 3 个可见类别） ---------- */
    /* 数值抽查必须在「不合并」的图上做：merge 生效时一列可能是多个类别的合并组，
       而 col.label 只写第一个叶子的名字 → 与单类别原始统计比对必然对不上
       （实测误差 0.32 是这个口径差，不是数据错）。 */
    await page.evaluate(function () {
      if (window.YMS && window.YMS.Fullscreen) window.YMS.Fullscreen.close();
      window.__YMS__.applyPlot({
        type: 'box', x: ['Tool_Group', 'Chamber_Group', 'Layer', 'Lot'], values: ['Yield'],
        sorters: [], splitBy: [], pageBy: [], display: 'facet',
        merge: { mode: 'none', limit: null },
        stats: { show: true, items: ['mean', 'std', 'nupct'], rotate: 90 }
      });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(1200);
    await page.evaluate(function () { window.__YMS__.openFullscreen(0); });
    await page.waitForTimeout(1500);
    await zoomTo(page, FS, 0, 40);                     // 缩小到 40%：列=单类别，但仍有多列
    m = await page.evaluate(READ, { sel: FS });
    const picks = [m.spec.cols[0], m.spec.cols[Math.floor(m.spec.cols.length / 2)], m.spec.cols[m.spec.cols.length - 1]];
    let worst = 0, checked = 0;
    const detail = [];
    picks.forEach(function (col) {
      /* 该列对应的类别（叶子标签 = Lot，需 Tool/Chamber/Layer 一起定类） */
      /* 四元组定位：levels[0]=Tool_Group / [1]=Chamber_Group / [2]=Layer，叶子 = Lot。
         只按 Lot 匹配会撞上同名 Lot 的其它 Tool 组（实测最大误差 4.67 就是取错类）。 */
      const lvL = (col.levels || []).map(function (L) { return L ? String(L.label) : ''; });
      const want = [lvL[0], lvL[1], lvL[2], col.label].join('|');
      const st = groups[want] ? statsOf(groups[want]) : null;
      if (!st) return;
      const got = { mean: Number(col.statLines[0]), std: Number(col.statLines[1]), nupct: Number(col.statLines[2]) };
      const d = Math.max(Math.abs(got.mean - st.mean), Math.abs(got.std - st.std), Math.abs(got.nupct - st.nupct));
      if (d > worst) worst = d;
      checked++;
      detail.push({ i: col.i, lot: col.label, got: got, want: { mean: st.mean, std: st.std, nupct: st.nupct }, err: Number(d.toFixed(4)) });
    });
    t.eq('5.1 抽查类别数 = 3（首/中/末各一列）', checked, 3);
    t.ok('5.2 3 个类别的 Mean/Std/Nu% 与原始数据独立算出的一致（最大误差 ' + worst.toFixed(4) + ' ≤ 0.01）',
      checked === 3 && worst <= 0.01, detail);
    t.ok('5.3 抽查列都对准自己的 box（|cell.cx − box.cx| ≤ 1px）',
      picks.every(function (col) {
        const b = m.boxes.filter(function (x) { return x.d === col.i; })[0];
        return b && Math.abs(col.cx - b.cx) <= 1;
      }), picks.map(function (col) { return { i: col.i, cx: col.cx }; }));

    /* ---------- 第 6 段：任务 G ② 五图型横轴分组合并 ---------- */
    await page.evaluate(function () { if (window.YMS && window.YMS.Fullscreen) window.YMS.Fullscreen.close(); });
    await page.waitForTimeout(300);

    const typeReport = {};
    const TYPE_LIST = ['box', 'line', 'bar', 'scatter', 'hist'];
    for (let ti = 0; ti < TYPE_LIST.length; ti++) {
      const tp = TYPE_LIST[ti];
      await page.evaluate(function (ty) {
        window.__YMS__.setMode('plot');
        window.__YMS__.applyPlot({
          type: ty, x: ['Tool_Group', 'Chamber_Group', 'Layer', 'Lot'], values: ['Yield'],
          sorters: [], splitBy: [], pageBy: [], display: 'single',
          merge: { mode: 'manual:20', limit: null },
          stats: { show: true, items: ['mean', 'std', 'nupct'], rotate: 90 }
        });
        window.__YMS__.submitPlot({});
      }, tp);
      await page.waitForTimeout(900);
      const r = await page.evaluate(function (a) {
        const insts = window.YMS.PlotView.charts || [];
        const inst = insts.length ? insts[insts.length - 1].chart : null;
        if (!inst) return { ok: false };
        const op = inst.getOption();
        const g = op.__groupAxis || null;
        const sp = op.__axisTableSpec || null;
        const gd = (op.grid && op.grid[0]) ? op.grid[0] : op.grid;
        const xa = Array.isArray(op.xAxis) ? op.xAxis[0] : op.xAxis;
        return {
          ok: true, xLen: (xa.data || []).length, xIsValue: !(xa.data && xa.data.length),
          gaOn: g ? g.on : null, gaLevels: g ? g.levelCount : null,
          cellsByLevel: g ? (g.cellsByLevel || []).slice() : null, gaBand: g ? g.band : null,
          hasSpec: !!sp, specGroupBand: sp ? sp.groupBand : null,
          gridBottom: gd ? gd.bottom : null, gridLeft: gd ? gd.left : null
        };
      }, { tp: tp });
      typeReport[tp] = r;
    }
    /* 4 种分类轴图型必须一致：on=true / 3 级 / 每层格数 = 夹具推导值
       夹具：Tool_Group 4 个值 → 第 0 层 4 格；Chamber_Group 每 Tool 2 个 → 第 1 层 8 格；
             ,     第 2 层（Layer）与叶子 Lot 每个类别各一格 → 格数 = 类别总数 */
    const CAT_N = Object.keys(groups).length;
    /* 不硬编码中间层格数（随夹具/抽稀变化）：首层 = Tool_Group 的 4 个值，
       之后每层格数严格递增且不超过类别总数 —— 这才证明「逐级在合并」。 */
    const countsOk = function (r2) {
      const cb = r2.cellsByLevel || [];
      if (cb.length !== 3 || cb[0] !== 4) return false;
      if (!(cb[0] < cb[1] && cb[1] < cb[2])) return false;
      if (cb[2] > r2.xLen) return false;
      return cb.every(function (v) { return v > 0; });
    };
    ['box', 'line', 'bar', 'scatter'].forEach(function (tp, k) {
      const r = typeReport[tp] || {};
      t.ok('6.' + (k + 1) + ' ' + tp + '：__groupAxis.on=' + r.gaOn + ' · levels=' + r.gaLevels +
        ' · 每层格数 ' + JSON.stringify(r.cellsByLevel) + ' · groupBand=' + r.specGroupBand + 'px',
        r.ok && r.gaOn === true && r.gaLevels === 3 && countsOk(r) && r.specGroupBand > 0,
        { got: r.cellsByLevel, xLen: r.xLen, catN: CAT_N, groupBand: r.specGroupBand });
    });
    /* scatter：绘图区真的空出了分组带（grid.bottom 含 groupBand） */
    const sc = typeReport.scatter || {};
    t.ok('6.5 scatter：grid.bottom ' + sc.gridBottom + ' ≥ 分组带 ' + sc.specGroupBand + ' + 轴块 40（分组带已计入底部留白）',
      typeof sc.gridBottom === 'number' && sc.gridBottom >= sc.specGroupBand + 40,
      { gridBottom: sc.gridBottom, groupBand: sc.specGroupBand });
    /* 1 列 X（无分组维度）作对照：grid.bottom 明显更小 = 差值就是分组带 */
    const noGroup = await page.evaluate(function () {
      window.__YMS__.applyPlot({
        type: 'scatter', x: ['Lot'], values: ['Yield'], sorters: [], splitBy: [], pageBy: [], display: 'single',
        merge: { mode: 'manual:20', limit: null }, stats: { show: true, items: ['mean', 'std', 'nupct'], rotate: 90 }
      });
      window.__YMS__.submitPlot({});
      return new Promise(function (res) {
        setTimeout(function () {
          const insts = window.YMS.PlotView.charts || [];
          const inst = insts.length ? insts[insts.length - 1].chart : null;
          const op = inst ? inst.getOption() : null;
          const gd = op && op.grid ? (Array.isArray(op.grid) ? op.grid[0] : op.grid) : null;
          const g = op ? op.__groupAxis : null;
          res({ gridBottom: gd ? gd.bottom : null, gaOn: g ? g.on : null });
        }, 700);
      });
    });
    t.ok('6.6 对照：scatter 单列 X（Lot）无分组 → gaOn=' + noGroup.gaOn + '、grid.bottom ' + noGroup.gridBottom +
      ' < 4 列时的 ' + sc.gridBottom + '（差 ' + (sc.gridBottom - noGroup.gridBottom) + ' ≈ 分组带 ' + sc.specGroupBand + '+）',
      noGroup.gaOn === false && noGroup.gridBottom < sc.gridBottom,
      { noGroup: noGroup, withGroup: sc.gridBottom, groupBand: sc.specGroupBand });

    /* hist：X 是数值分箱 → 分组带不适用，但设置区必须有**可见说明** */
    const hist = typeReport.hist || {};
    /* hist 的 X 是**数值分箱后的类别**（xa.data 非空 → xIsValue=false），所以分组带不适用；
       判据是「on=false 且设置区有可见说明」（6.8~6.10 覆盖说明文案） */
    t.ok('6.7 hist：X 轴为分箱类别（类数 ' + hist.xLen + '，无 X 参数列可合并）→ __groupAxis.on=' +
      hist.gaOn + '（不适用，不是静默失效）', hist.ok && hist.gaOn === false, hist);
    const note = await page.evaluate(function () {
      window.YMS.PlotSettings.setType('hist');
      const el = document.querySelector('#plot-settings-body [data-note="merge-hist-na"]');
      const grp = el && el.parentNode ? el.parentNode.querySelector('.group-title') : null;
      return el ? {
        text: String(el.textContent || '').trim(),
        visible: !!(el.offsetParent !== null) && el.getBoundingClientRect().height > 0,
        groupTitle: grp ? String(grp.textContent || '').trim() : null
      } : null;
    });
    t.ok('6.8 设置区「防拥挤合并」下有可见说明行（分组：' + (note ? note.groupTitle : '?') + '）', !!note && note.visible,
      note);
    t.contains('6.9 说明文案明确写出「直方图的 X 轴是数值分箱…分组带不适用」', note ? note.text : '',
      '直方图的 X 轴是数值分箱');
    t.contains('6.10 说明文案给出替代入口（柱数）', note ? note.text : '', '柱数');
    /* 任务 I ③（用户口径「删掉」）：非 hist 图型下「分组带自动启用……」那条说明行**不再渲染**。
       断言不删，改为**反向守卫**：元素必须不存在、文案不许出现在面板里，
       同时该组不能留空壳（子元素只剩「标题 + 合并字段」，组底内边距与普通单字段组一致）。
       注意 6.8~6.10（hist 不适用说明）必须继续绿 —— 用户只点了 merge-on 那一条。 */
    const noteOn = await page.evaluate(function () {
      window.YMS.PlotSettings.setType('box');
      const body = document.getElementById('plot-settings-body');
      const el = body.querySelector('[data-note="merge-on"]');
      const naEl = body.querySelector('[data-note="merge-hist-na"]');
      const grp = (function () {
        const gs = body.querySelectorAll('.setting-group');
        for (let i = 0; i < gs.length; i++) {
          const ti = gs[i].querySelector('.group-title');
          if (ti && String(ti.textContent).indexOf('防拥挤合并') >= 0) return gs[i];
        }
        return null;
      })();
      const padBottom = function (g) {
        if (!g) return -1;
        const kids = g.children;
        const last = kids[kids.length - 1];
        return Math.round(g.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
      };
      let refPad = -2;
      const gs = body.querySelectorAll('.setting-group');
      for (let i = 0; i < gs.length; i++) {
        const ti = gs[i].querySelector('.group-title');
        if (!ti || String(ti.textContent).indexOf('2 · 排版') < 0) continue;
        refPad = padBottom(gs[i]);
      }
      return {
        exists: !!el,
        count: body.querySelectorAll('[data-note="merge-on"]').length,
        hasText: String(body ? body.textContent : '').indexOf('分组带自动启用：X 轴含多个参数列时') >= 0,
        histNoteKept: !!naEl,
        children: grp ? grp.children.length : -1,
        pad: padBottom(grp),
        refPad: refPad
      };
    });
    t.eq('6.11 切回 box 后 merge-on 说明行已移除（元素数 0，文案不在面板里）',
      noteOn.count + '/' + noteOn.exists + '/' + noteOn.hasText, '0/false/false');
    t.eq('6.11a 该组不留空壳：子元素只剩「标题 + 合并字段」两个', noteOn.children, 2);
    t.eq('6.11b 该组组底内边距 == 单字段组「2 · 排版」的组底内边距（无空白塌陷）',
      noteOn.pad, noteOn.refPad);
    t.eq('6.11c box 模式下不渲染 hist 专用说明（该说明只在 hist 下出现，由 6.8~6.10 覆盖）',
      noteOn.histNoteKept, false);

    /* ---------- 收尾 ---------- */
    await page.waitForTimeout(200);
    t.noErrors('7.1 零未捕获异常 / 控制台错误', ctx.errors);
  }
};
