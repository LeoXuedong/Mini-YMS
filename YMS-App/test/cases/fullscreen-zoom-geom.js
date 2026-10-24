/* ==========================================================================
   YMS · test/cases/fullscreen-zoom-geom.js
   断言对象：全屏 + X 轴缩放的**三处几何**（用户截图标注的原话）
     ① 「缩放的时候，box 跑到坐标轴区域外了」
        → boxplot 的 clip:true 不生效，窗口外的箱体被画到 grid 左右外侧
        修法：reflowAxisTable 按 xAxis extent(lo..hi) 过滤 series.data（窗口外置 '-'，索引不变）
     ② 「这里太空了，尽量靠近左边」
        → 行名列右侧 0→grid.x 一大片空白（旧 grid.left=261 里 199px 来自「X 轴全名拼串」的预留）
        修法：graphic 模式 grid.left 紧算 = max(Y 轴区实测留白, 4 + 行名实测宽 + 2×内边距 + 4)
     ③ 「横轴的 label 被表格覆盖了」
        → X 轴标题 nameGap 只含到「旋转标签块」，正好落在参数行带里
        修法：nameGap 再加上整条参数行带 gBand → 标题整块落到最后一行参数行之下
   读数一律取**真实绘制结果**：ECharts 实例的 grid rect / 每个箱体的 graphic 包围盒 /
     zrender 显示列表里轴标题与行名文本的实际矩形（不读中间量自证）。
   覆盖：卡片路径 + 全屏未缩放 + 全屏 dataZoom 25-75。
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const helper = require('../helpers/app');

const CASE_FILE = 'fullscreen-zoom-geom.js';
const ROW_NAMES = ['Mean', 'Std', 'Nu%', 'Lot', 'Layer', 'Chamber_Group', 'Tool_Group'];
const TOOLS = ['Tool1', 'Tool2', 'Tool4', 'Tool3'];
const CHAMBERS = ['CHM1', 'CHM2'];
const LAYERS = ['PA', 'VA', 'M2', 'Pol'];

/** 4 列 X 的底表（Tool_Group → Chamber_Group → Layer → Lot = 3 级分组 + 叶子列） */
function makeCsv4() {
  const rows = ['Fab,Product,Tool_Group,Chamber_Group,Layer,Lot,Yield'];
  let k = 0;
  TOOLS.forEach(function (tl, ti) {
    CHAMBERS.forEach(function (ch, ci) {
      LAYERS.forEach(function (ly, li) {
        for (let j = 1; j <= 2; j++) {
          k++;
          rows.push('Fab1,Prod1,' + tl + ',' + ch + ',' + ly +
            ',L' + ('000' + (ti * 100 + ci * 10 + li * 2 + j)).slice(-4) +
            ',' + (86 + (k % 13) * 0.55 + ti * 0.4).toFixed(2));
        }
      });
    });
  });
  return rows.join('\n');
}

/* ------------------------------------------------------------- 页面内读数 */
/**
 * 读一张图的真实几何（在页面里执行，不得引用外部变量）
 * @param {object} a {sel:string, rowNames:string[]}
 */
function READ(a) {
  const el = document.querySelector(a.sel);
  const inst = el ? window.echarts.getInstanceByDom(el) : null;
  if (!inst) return { ok: false, sel: a.sel, reason: 'no-instance' };
  const gm = inst.getModel().getComponent('grid');
  if (!gm || !gm.coordinateSystem) return { ok: false, sel: a.sel, reason: 'no-coordinate-system' };
  const rect = gm.coordinateSystem.getRect();
  const op = inst.getOption();
  const xa = (op.xAxis && op.xAxis[0]) || {};
  const H = inst.getHeight(), W = inst.getWidth();
  const ga = op.__groupAxis || null;
  const sb = op.__statBlock || null;
  const spec = op.__axisTableSpec || null;
  const nameTxt = String(xa.name || '');

  let extent = null;
  try {
    const ax = inst.getModel().getComponent('xAxis', 0).axis;
    extent = { lo: ax.scale.getExtent()[0], hi: ax.scale.getExtent()[1] };
  } catch (e) { extent = null; }

  /* 真实绘制元素（zrender 显示列表） */
  let disp = [];
  try { disp = inst.getZr().storage.getDisplayList(true, true, true) || []; } catch (e2) { disp = []; }
  function gRect(e) {
    try {
      const r = e.getBoundingRect().clone();
      const m = e.getComputedTransform ? e.getComputedTransform() : e.transform;
      if (m) r.applyTransform(m);
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.x + r.width, b: r.y + r.height };
    } catch (e3) { return null; }
  }
  const title = [], rowNames = [];
  for (let i = 0; i < disp.length; i++) {
    const e = disp[i], st = e && e.style;
    if (!st || typeof st.text !== 'string' || !st.text) continue;
    const g = gRect(e);
    if (!g) continue;
    if (nameTxt && st.text === nameTxt) { title.push({ text: st.text, x: g.x, y: g.y, r: g.r, b: g.b, h: g.h }); continue; }
    if (a.rowNames.indexOf(st.text) >= 0) rowNames.push({ text: st.text, x: g.x, y: g.y, r: g.r, b: g.b, w: g.w, h: g.h });
  }

  /* 每个箱体真实绘制的像素 x 区间 */
  const boxes = [], drawnIdx = [];
  let seriesDataLen = null, emptyCount = null, boxSeries = 0;
  const sers = inst.getModel().getSeries();
  for (let s = 0; s < sers.length; s++) {
    const sm = sers[s];
    if (sm.subType !== 'boxplot') continue;
    boxSeries++;
    const data = sm.getData();
    try { seriesDataLen = (op.series[s] && op.series[s].data) ? op.series[s].data.length : data.count(); } catch (e4) { seriesDataLen = data.count(); }
    for (let d = 0; d < data.count(); d++) {
      const ge = data.getItemGraphicEl(d);
      if (!ge) continue;
      const g = gRect(ge);
      if (!g || !isFinite(g.x) || !isFinite(g.r)) continue;
      boxes.push({ d: d, x: g.x, r: g.r, w: g.w });
      drawnIdx.push(d);
    }
  }
  if (Array.isArray(op.series) && op.series[0] && Array.isArray(op.series[0].data)) {
    emptyCount = op.series[0].data.filter(function (v) { return v === '-' || v === null || v === undefined; }).length;
  }

  /* 参数行带（真实行名文本矩形 + 由 __statBlock/__groupAxis 推出的行带矩形） */
  const paramBands = [];
  if (sb && Array.isArray(sb.paramRows)) {
    for (let p = 0; p < sb.paramRows.length; p++) {
      const pr = sb.paramRows[p];
      let h = null;
      if (pr.level === -1) h = sb.labelH;
      else if (ga && ga.levels && ga.levels[pr.level]) h = ga.levels[pr.level].h;
      if (h === null || h === undefined) continue;
      paramBands.push({
        name: pr.name, level: pr.level,
        yTop: H - (pr.bottom + h), yBot: H - pr.bottom
      });
    }
  }

  return {
    ok: true, sel: a.sel, W: W, H: H,
    grid: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, r: rect.x + rect.width, b: rect.y + rect.height },
    gridLeft: (op.grid && op.grid[0]) ? op.grid[0].left : null,
    yPad: spec ? spec.yPad : null,
    nameGap: xa.nameGap, axisName: nameTxt,
    extent: extent,
    nCats: (xa.data || []).length,
    title: title, rowNames: rowNames, paramBands: paramBands,
    boxes: boxes, drawnIdx: drawnIdx, boxSeries: boxSeries,
    seriesDataLen: seriesDataLen, emptyCount: emptyCount,
    boxFilter: op.__boxFilter || null,
    ga: ga ? { n: ga.n, bandW: ga.bandW, zoom: ga.zoom, h: (ga.levels && ga.levels[0]) ? ga.levels[0].h : null } : null
  };
}

/* --------------------------------------------------------------- 小工具 */

/** 等图表布局完成（coordinateSystem 就绪） */
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

/**
 * 轴标题矩形与参数行矩形是否相交。
 * x 方向：标题居中于绘图区、参数行带横跨 [grid.x, grid.x+grid.w]，两者水平投影必然重叠
 *         （标题实测宽度 << 绘图区宽），故相交与否只由 y 区间决定 —— 这里只判 y，并把 x 读数列出备查。
 */
function intersects(t, p, g) {
  const yOverlap = Math.min(t.b, p.yBot) - Math.max(t.y, p.yTop);
  const xOverlap = g ? (Math.min(t.r, g.r) - Math.max(t.x, g.x)) : 1;
  return (yOverlap > 0) && (xOverlap > 0);
}

/** 一组箱体里越界（像素 x 落出 [grid.x, grid.x+w]）的条数 */
function outOfGrid(boxes, g, tol) {
  const e = (tol === undefined) ? 0.5 : tol;
  let n = 0;
  boxes.forEach(function (b) {
    if (!isFinite(b.x) || !isFinite(b.r)) { n++; return; }
    if (b.x < g.x - e || b.r > g.r + e) n++;
  });
  return n;
}

/** 行名文字右沿最大值 + 与 grid.x 的间距 */
function rowNameStat(rn, g) {
  let maxR = -Infinity, minGap = Infinity, maxW = 0;
  rn.forEach(function (r) {
    if (r.r > maxR) maxR = r.r;
    if (g.x - r.r < minGap) minGap = g.x - r.r;
    if (r.w > maxW) maxW = r.w;
  });
  return { maxR: maxR, minGap: minGap, maxW: maxW, n: rn.length };
}

/** 用「实测行名宽 + Y 轴留白」独立算一遍紧算上限，用来卡 grid.left 不许有多余空白 */
function tightExpect(yPad, maxRowNameW) {
  const FRAME_LEFT = 4, PAD = 3, GAP = 4;
  return Math.round(Math.max(yPad || 0, FRAME_LEFT + Math.ceil(maxRowNameW) + PAD * 2 + GAP));
}

/* ------------------------------------------------------------------ 用例 */
module.exports = {
  id: 'e1-fszoom-geom',
  title: '全屏缩放三处几何：箱体不出界 / 行名列右沿留 4px / 轴标题不压参数行',
  run: async function (ctx) {
    const page = ctx.page, t = ctx.t;
    const HERE = __dirname;

    /* ---------- 第 1 段：用例登记（自证本文件已被 run.js 收编） ---------- */
    const casePath = path.join(HERE, CASE_FILE);
    t.ok('1.1 用例文件存在：test/cases/' + CASE_FILE, fs.existsSync(casePath), { path: casePath });
    let runSrc = '';
    try { runSrc = fs.readFileSync(path.join(HERE, '..', 'run.js'), 'utf8'); } catch (e) { runSrc = ''; }
    t.contains("1.2 run.js 的 CASE_FILES 已登记 '" + CASE_FILE + "'", runSrc, "'" + CASE_FILE + "'");
    t.eq('1.3 本用例 id 与登记名一致（跑到的就是登记的这份）', module.exports.id, 'e1-fszoom-geom');

    /* ---------- 出图（用户配置：box / 4 列 X / merge manual:20 / stats rotate=90） ---------- */
    await page.setViewportSize({ width: 1680, height: 950 });
    const imp = await helper.importText(page, 'fszoom.csv', makeCsv4());
    t.ok('1.4 夹具导入成功（' + imp.rows + ' 行）', imp.ok && imp.rows > 0, imp);
    await page.evaluate(function () {
      window.__YMS__.setMode('plot');
      window.__YMS__.applyPlot({
        type: 'box',
        x: ['Tool_Group', 'Chamber_Group', 'Layer', 'Lot'],
        values: ['Yield'], sorters: [], splitBy: [], pageBy: [], display: 'facet',
        merge: { mode: 'manual:20', limit: null },
        stats: { show: true, items: ['mean', 'std', 'nupct'], rotate: 90 }
      });
      window.__YMS__.submitPlot({});
    });
    const CARD_SEL = '.chart-card .chart-body';
    const FS_SEL = '#fullscreen-root .echarts-host';
    const cardReady = await waitReady(page, CARD_SEL);
    const card = await page.evaluate(READ, { sel: CARD_SEL, rowNames: ROW_NAMES });
    t.ok('1.5 卡片图表已渲染（grid 坐标系就绪）', cardReady && card.ok, { ready: cardReady, card: card.ok, reason: card.reason });
    if (!card.ok) return;
    t.ok('1.6 卡片为统计行 graphic 通道（有参数行带 ⇒ 本次三处几何都适用）',
      Array.isArray(card.paramBands) && card.paramBands.length >= 4,
      { paramBands: card.paramBands });

    /* ---------- 第 2 段：卡片路径（② 行名列 + ③ 轴标题 + ① 箱体） ---------- */
    let rs = rowNameStat(card.rowNames, card.grid);
    t.eq('2.1 卡片：7 个行名全部绘制（Mean/Std/Nu%/Lot/Layer/Chamber_Group/Tool_Group）', rs.n, ROW_NAMES.length);
    t.ok('2.2 卡片：行名文字右沿 max ' + rs.maxR.toFixed(2) + ' < grid.x ' + card.grid.x.toFixed(2),
      rs.maxR < card.grid.x, { maxR: rs.maxR, gridX: card.grid.x });
    t.ok('2.3 卡片：行名右沿到 grid.x 的间距 ' + rs.minGap.toFixed(2) + 'px ≥ 4px',
      rs.minGap >= 4, { gap: rs.minGap });
    const tightCard = tightExpect(card.yPad, rs.maxW);
    t.ok('2.4 卡片：grid.left ' + card.gridLeft + ' 已紧算（独立算出 ' + tightCard + '，误差 ≤1px）',
      Math.abs(card.gridLeft - tightCard) <= 1, { actual: card.gridLeft, expect: tightCard, yPad: card.yPad, nameW: rs.maxW });

    t.eq('2.5 卡片：轴标题文本已绘制', card.title.length, 1);
    const ttlC = card.title[0] || { y: 0, b: 0, x: 0, r: 0 };
    const bandBotC = Math.max.apply(null, card.paramBands.map(function (p) { return p.yBot; }));
    const clashC = card.paramBands.filter(function (p) { return intersects(ttlC, p, card.grid); }).length;
    t.eq('2.6 卡片：轴标题与任何参数行都不相交（标题 y ' + ttlC.y.toFixed(0) + '~' + ttlC.b.toFixed(0) +
      ' vs 参数行最下沿 ' + bandBotC.toFixed(0) + '）', clashC, 0);
    t.eq('2.7 卡片：箱体越界条数 = 0（' + card.boxes.length + ' 个箱体全在 [grid.x, grid.x+w]）',
      outOfGrid(card.boxes, card.grid), 0);

    /* ---------- 第 3 段：全屏未缩放 ---------- */
    await page.evaluate(function () {
      const b = document.querySelectorAll('.chart-card button');
      for (let i = 0; i < b.length; i++) {
        if ((b[i].getAttribute('title') || '').indexOf('放大') >= 0) { b[i].click(); return; }
      }
      if (window.__YMS__.openFullscreen) window.__YMS__.openFullscreen(0);
    });
    const fsReady = await waitReady(page, FS_SEL);
    const fs0 = await page.evaluate(READ, { sel: FS_SEL, rowNames: ROW_NAMES });
    t.ok('3.1 全屏图表已渲染（grid 坐标系就绪）', fsReady && fs0.ok, { ready: fsReady, ok: fs0.ok, reason: fs0.reason });
    if (!fs0.ok) return;
    t.eq('3.2 全屏未缩放：xAxis extent 覆盖全部类别', fs0.extent.lo + '|' + fs0.extent.hi, '0|' + (fs0.nCats - 1));
    rs = rowNameStat(fs0.rowNames, fs0.grid);
    t.eq('3.3 全屏未缩放：7 个行名全部绘制', rs.n, ROW_NAMES.length);
    t.ok('3.4 全屏未缩放：行名右沿 max ' + rs.maxR.toFixed(2) + ' < grid.x ' + fs0.grid.x.toFixed(2) +
      '（间距 ' + rs.minGap.toFixed(2) + 'px ≥ 4px）', rs.maxR < fs0.grid.x && rs.minGap >= 4,
      { maxR: rs.maxR, gridX: fs0.grid.x, gap: rs.minGap });
    const tightFs = tightExpect(fs0.yPad, rs.maxW);
    t.ok('3.5 全屏未缩放：grid.left ' + fs0.gridLeft + ' 紧算（独立算出 ' + tightFs + '，误差 ≤1px）',
      Math.abs(fs0.gridLeft - tightFs) <= 1, { actual: fs0.gridLeft, expect: tightFs, yPad: fs0.yPad });
    t.ok('3.6 全屏未缩放：grid.left 不再含「X 轴全名」预留（旧值 261 → 实测 ' + fs0.gridLeft + '，净省 ' +
      (261 - fs0.gridLeft) + 'px）', fs0.gridLeft < 261, { actual: fs0.gridLeft, old: 261 });
    const ttlF = fs0.title[0] || { y: 0, b: 0, x: 0, r: 0 };
    const clashF = fs0.paramBands.filter(function (p) { return intersects(ttlF, p, fs0.grid); }).length;
    const bandBotF = Math.max.apply(null, fs0.paramBands.map(function (p) { return p.yBot; }));
    t.eq('3.7 全屏未缩放：轴标题与参数行不相交（标题 y ' + ttlF.y.toFixed(0) + '~' + ttlF.b.toFixed(0) +
      ' vs 参数行最下沿 ' + bandBotF.toFixed(0) + '）', clashF, 0);
    t.eq('3.8 全屏未缩放：箱体越界条数 = 0', outOfGrid(fs0.boxes, fs0.grid), 0);
    t.eq('3.9 全屏未缩放：箱体数 = 类别数', fs0.boxes.length, fs0.nCats);

    /* ---------- 第 4 段：全屏 + dataZoom 25-75 ---------- */
    await page.evaluate(function (s) {
      const el = document.querySelector(s);
      const inst = el ? window.echarts.getInstanceByDom(el) : null;
      if (inst) inst.dispatchAction({ type: 'dataZoom', start: 25, end: 75 });
    }, FS_SEL);
    /* 等重算完成：extent 变窄 + __boxFilter 生效 */
    let zoomed = null;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(150);
      const z = await page.evaluate(READ, { sel: FS_SEL, rowNames: ROW_NAMES });
      if (z.ok && z.extent && (z.extent.hi - z.extent.lo) < (z.nCats - 1) && z.boxFilter && z.boxFilter.full === false) {
        zoomed = z; break;
      }
      zoomed = z;
    }
    const z = zoomed;
    t.ok('4.1 缩放后 extent 收窄（lo=' + (z.extent ? z.extent.lo : '?') + ' hi=' + (z.extent ? z.extent.hi : '?') +
      '，可见 ' + (z.extent ? z.extent.hi - z.extent.lo + 1 : '?') + ' / ' + z.nCats + ' 类）',
      !!z.ok && !!z.extent && (z.extent.hi - z.extent.lo + 1) < z.nCats, { extent: z.extent, nCats: z.nCats });
    const win = z.extent.hi - z.extent.lo + 1;

    /* ① 核心：窗口外的箱体必须一条都不画（旧实现 24 条全画、最远到 x = -380） */
    t.ok('4.2 缩放后 series.data 长度不变（索引保留 = ' + z.seriesDataLen + '）', z.seriesDataLen === z.nCats,
      { len: z.seriesDataLen, nCats: z.nCats });
    t.eq('4.3 缩放后窗口外数据被置空标记（空值数 = ' + (z.nCats - win) + '）', z.emptyCount, z.nCats - win);
    t.eq('4.4 __boxFilter 记录越界过滤条数 = 窗口外类别数', z.boxFilter ? z.boxFilter.dropped : null, z.nCats - win);
    t.eq('4.5 __boxFilter 保留条数 = 窗口可见类别数', z.boxFilter ? z.boxFilter.kept : null, win);
    t.eq('4.6 实际绘制的箱体数 = 窗口可见类别数（不再全量绘制）', z.boxes.length, win);
    t.eq('4.7 画出的箱体下标全部落在 [lo, hi] 内',
      z.drawnIdx.filter(function (d) { return d < z.extent.lo || d > z.extent.hi; }).length, 0);
    const viol = outOfGrid(z.boxes, z.grid);
    const bMin = z.boxes.length ? Math.min.apply(null, z.boxes.map(function (b) { return b.x; })) : NaN;
    const bMax = z.boxes.length ? Math.max.apply(null, z.boxes.map(function (b) { return b.r; })) : NaN;
    t.eq('4.8 越界箱体条数 = 0（箱体像素 x ∈ [' + bMin.toFixed(1) + ', ' + bMax.toFixed(1) +
      ']，绘图区 [' + z.grid.x.toFixed(1) + ', ' + z.grid.r.toFixed(1) + ']）', viol, 0);
    t.ok('4.9 箱体左沿 min ' + bMin.toFixed(2) + ' ≥ grid.x ' + z.grid.x.toFixed(2), bMin >= z.grid.x - 0.5,
      { min: bMin, gridX: z.grid.x });
    t.ok('4.10 箱体右沿 max ' + bMax.toFixed(2) + ' ≤ grid.x + grid.w ' + z.grid.r.toFixed(2), bMax <= z.grid.r + 0.5,
      { max: bMax, gridR: z.grid.r });

    /* ②③ 缩放后同样成立（重算路径不许退化） */
    rs = rowNameStat(z.rowNames, z.grid);
    t.eq('4.11 缩放后 7 个行名仍全部绘制', rs.n, ROW_NAMES.length);
    t.ok('4.12 缩放后行名右沿 ' + rs.maxR.toFixed(2) + ' < grid.x ' + z.grid.x.toFixed(2) +
      '（间距 ' + rs.minGap.toFixed(2) + 'px ≥ 4px）', rs.maxR < z.grid.x && rs.minGap >= 4,
      { maxR: rs.maxR, gridX: z.grid.x, gap: rs.minGap });
    t.eq('4.13 缩放后 grid.left 与未缩放一致（紧算幂等，' + z.gridLeft + '）', z.gridLeft, fs0.gridLeft);
    const ttlZ = z.title[0] || { y: 0, b: 0, x: 0, r: 0 };
    const clashZ = z.paramBands.filter(function (p) { return intersects(ttlZ, p, z.grid); }).length;
    const bandBotZ = Math.max.apply(null, z.paramBands.map(function (p) { return p.yBot; }));
    t.eq('4.14 缩放后轴标题与参数行不相交（标题 y ' + ttlZ.y.toFixed(0) + '~' + ttlZ.b.toFixed(0) +
      ' vs 参数行最下沿 ' + bandBotZ.toFixed(0) + '）', clashZ, 0);
    t.ok('4.15 轴标题整块在参数行之下（y 区间不相交：' + ttlZ.y.toFixed(0) + ' ≥ ' + bandBotZ.toFixed(0) + '）',
      ttlZ.y >= bandBotZ, { titleTop: ttlZ.y, paramBottom: bandBotZ });
    t.ok('4.16 轴标题仍在容器内（标题下沿 ' + ttlZ.b.toFixed(0) + ' ≤ 容器高 ' + z.H + '）', ttlZ.b <= z.H,
      { titleBottom: ttlZ.b, H: z.H });

    /* ---------- 收尾 ---------- */
    await page.evaluate(function () { if (window.YMS && window.YMS.Fullscreen) window.YMS.Fullscreen.close(); });
    await page.waitForTimeout(300);
    t.noErrors('5.1 零未捕获异常 / 控制台错误', ctx.errors);
  }
};
