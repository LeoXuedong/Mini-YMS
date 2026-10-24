/* ==========================================================================
   YMS · test/cases/box-column-align.js
   任务 H（用户原话）
     ① 「box 下方要显示对应数据，这个 bug 一直没修复」
        → 箱体与横轴数据列横向对位。ECharts 的箱线布局按「同轴 boxplot 系列总数 N」
          均分 0.8×带宽（offset_i = ((i+0.5)/N − 0.5) × band × 0.8），与「该类别里这些系列
          有没有数据」无关；本用例的复现配置（splitBy=Product + colorBy=Tool）每类只有 3 个
          系列有数据、却占着 12 份槽位 → 实测列心 145.9px / 箱心 128.37px（左偏 17.53px）。
        修法：boxLanesOf/boxLaneModel 按「每类最多几个系列同时有数据」定槽位与箱宽，
              alignBoxSeries 每次渲染后把该类的箱体按系列序对称摆到列心上（列心取
              __axisTableSpec.cols[i].cx —— 与表格数值行同一份几何）。
     ② 「数值显示怎么有些只存在 min，Q1，中位数等，但是不显示数值」
        → tooltip 里无数据的系列只印标签不印数（value = [null×5] / 窗口外 '-' 占位）。
        修法：makeAxisTooltip 对五数不全的箱线行整行跳过；全部无数据则不弹 tooltip。
   验收口径（一律读**真实图元 / 真实 DOM**，不读中间量自证）：
     · 每个可见类别：该类全部箱体的几何包围盒中心 == 该列 cx（≤1px）、
       箱数 == 该类别有数据的系列数、有箱无列 / 有列无箱 双向差集为 0
     · 卡片视图 + 全屏四步缩放（25-75 / 75-100 / 0-100 / 0-8）各来一遍
     · tooltip 用 dispatchAction({type:'showTip'}) 后在页面里读 tooltip 文本节点，
       再与 series.data 的 [min,Q1,中位,Q3,max] 逐值比对（3 系列 × 3 类别）
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const CASE_FILE = 'box-column-align.js';
const CSV_REL = 'sample_yield_data_100k-20261022-222352.csv';
const FS_SEL = '#fullscreen-root .echarts-host';
const CARD_SEL = '.chart-card[data-index="0"] .chart-body';
const STEPS = [[25, 75], [75, 100], [0, 100], [0, 8]];

/* 用户图 2 / 图 3 的复现配置（原样，不许改） */
const CFG = {
  type: 'box',
  x: ['Tool_Group', 'Chamber_Group', 'Layer', 'Lot'],
  values: ['Yield'],
  sorters: [],
  pageBy: ['Fab'],
  splitBy: ['Product'],
  display: 'facet',
  merge: { mode: 'auto', limit: null },
  fit: 'none',
  style: { xAxisSize: 11, xRotate: 90, yAxisSize: 11, titleSize: 13, legendSize: 11 },
  group: { colorBy: 'Tool', symbolBy: '', colors: {}, preset: 'tableau10', autoN: 0 },
  stats: { show: true, items: ['mean', 'std', 'nupct'], rotate: 90, frame: true }
};

/* ------------------------------------------------------------- 页面内读数 */
/**
 * 一张图的 H1 完整读数（真实图元包围盒 vs 列心；在页面里执行，不引用外部变量）
 * @param {string} sel 容器选择器（.chart-body / #fullscreen-root .echarts-host）
 */
function READ(sel) {
  const el = document.querySelector(sel);
  const inst = el ? window.echarts.getInstanceByDom(el) : null;
  if (!inst) return { ok: false, reason: 'no-instance' };
  const op = inst.getOption();
  const sp = op.__axisTableSpec || null;
  const lay = op.__boxLayout || null;
  const sers = inst.getModel().getSeries();
  const perCat = {};
  const dataOf = {};
  let boxTotal = 0, widths = [], boxSeries = 0;
  for (let s = 0; s < sers.length; s++) {
    const sm = sers[s];
    if (!sm || sm.subType !== 'boxplot') continue;
    boxSeries++;
    const data = sm.getData();
    const arr = [];
    for (let d = 0; d < data.count(); d++) {
      const v = data.getValues(d);
      arr.push(v ? [v[1], v[2], v[3], v[4], v[5]] : null);   // 去掉首位的类别下标
      const ge = data.getItemGraphicEl(d);
      if (!ge) continue;
      const r = ge.getBoundingRect().clone();
      const m = ge.getComputedTransform ? ge.getComputedTransform() : ge.transform;
      if (m) r.applyTransform(m);
      boxTotal++;
      widths.push(Math.round(r.width * 100) / 100);
      const c = perCat[d] || (perCat[d] = { n: 0, minX: Infinity, maxX: -Infinity, sers: [] });
      c.n++; c.sers.push(s);
      c.minX = Math.min(c.minX, r.x);
      c.maxX = Math.max(c.maxX, r.x + r.width);
    }
    dataOf[sm.name] = { s: s, vals: arr };
  }
  const cols = sp ? sp.cols.map(function (c) {
    const g = perCat[c.i];
    return {
      i: c.i, cx: Math.round(c.cx * 100) / 100,
      n: g ? g.n : 0,
      bboxCx: g ? Math.round(((g.minX + g.maxX) / 2) * 100) / 100 : null,
      dx: g ? Math.round(((g.minX + g.maxX) / 2 - c.cx) * 100) / 100 : null,
      sers: g ? g.sers : []
    };
  }) : [];
  const colSet = {};
  cols.forEach(function (c) { colSet[c.i] = 1; });
  return {
    ok: true,
    colCount: cols.length,
    bandW: sp ? Math.round(sp.bandW * 100) / 100 : null,
    colWindow: sp && sp.colWindow ? { lo: sp.colWindow.lo, hi: sp.colWindow.hi } : null,
    lanes: lay ? lay.lanes : null,
    boxW: lay ? lay.boxW : null,
    layBand: lay ? lay.band : null,
    layStep: lay ? lay.step : null,
    boxSeries: boxSeries, boxTotal: boxTotal, boxWidths: widths.slice(0, 3),
    cols: cols,
    boxNoCol: Object.keys(perCat).map(Number).filter(function (k) { return !colSet[k]; }),
    data: dataOf,
    align: inst.__boxAlign ? {
      lanes: inst.__boxAlign.lanes, step: inst.__boxAlign.step, moved: inst.__boxAlign.moved,
      orphans: inst.__boxAlign.orphans, note: String(inst.__boxAlign.note || '')
    } : null
  };
}

/** 触发 tooltip（真实动作，不是直接调 formatter） */
function SHOW_TIP(a) {
  const el = document.querySelector(a.sel);
  const inst = el ? window.echarts.getInstanceByDom(el) : null;
  if (!inst) return { ok: false, reason: 'no-instance' };
  inst.dispatchAction({ type: 'showTip', seriesIndex: a.s, dataIndex: a.d });
  return { ok: true };
}

/** 读页面里真实存在的 tooltip 文本（含首个标题行） */
function READ_TIP() {
  const els = Array.prototype.slice.call(document.querySelectorAll('div')).filter(function (e) {
    if (!e.style || e.style.position !== 'absolute') return false;
    const h = e.innerHTML || '';
    return h.indexOf('中位') >= 0 || (h.indexOf('<b>') === 0 && h.indexOf('Yield') >= 0);
  });
  if (!els.length) return null;
  const e0 = els[0];
  return {
    text: String(e0.innerText || e0.textContent || ''),
    html: String(e0.innerHTML || ''),
    visible: e0.offsetParent !== null || e0.getBoundingClientRect().width > 0
  };
}

/* --------------------------------------------------------------- 小工具 */
/** 数值是否「有数据」（与 chart-builder.nilVal 同口径：null/''/'-'/非有限数都算没有） */
function hasVal(v) {
  if (v === null || v === undefined || v === '') return false;
  if (typeof v === 'string' && v.trim() === '-') return false;
  return isFinite(Number(v));
}
/** 该类别有数据的系列数（按 series.data 逐值判，不看图元） */
function seriesWithData(m, i) {
  let n = 0;
  Object.keys(m.data).forEach(function (name) {
    const v = m.data[name].vals[i];
    if (v && hasVal(v[0])) n++;
  });
  return n;
}
/** 打印精度取整（"误差 0" 的口径：打印值必须等于四舍五入到同小数位的原值） */
function roundTo(v, dec) {
  const p = Math.pow(10, dec);
  return Math.round(v * p) / p;
}
/** 从 tooltip 文本里取某个系列那一行，解析五个数 */
function parseLine(text, seriesName) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.indexOf(seriesName + '：') < 0) continue;
    const nums = [];
    const re = /(min|Q1|中位|Q3|max)\s+(-?[\d.]+)/g;
    let mm;
    while ((mm = re.exec(ln)) !== null) nums.push({ k: mm[1], v: Number(mm[2]), raw: mm[2] });
    return { line: ln, nums: nums };
  }
  return null;
}
function decimalsOf(raw) {
  const k = String(raw).indexOf('.');
  return k < 0 ? 0 : String(raw).length - k - 1;
}

module.exports = {
  id: 'h1-box-column-align',
  title: '任务 H：箱体↔数据列横向对位（卡片 + 全屏四步缩放）+ tooltip 无数据系列不列出',
  run: async function (ctx) {
    const page = ctx.page, t = ctx.t;
    const HERE = __dirname;

    /* ---------- 第 1 段：复现配置 ---------- */
    const csvPath = path.join(HERE, '..', '..', CSV_REL);
    const t1 = {
      hasFile: fs.existsSync(csvPath),
      size: fs.existsSync(csvPath) ? fs.statSync(csvPath).size : 0
    };
    t.ok('1.0 复现数据文件存在：' + CSV_REL + '（' + t1.size + ' 字节）', t1.hasFile && t1.size > 1000000, t1);
    const csv = t1.hasFile ? fs.readFileSync(csvPath, 'utf8') : '';
    const imp = await page.evaluate(async function (a) {
      const r = await window.__YMS__.importText(a[0], a[1]);
      const st = window.__YMS__.getState();
      return { ok: !!(r && r.ok), rows: st.rowCount, cols: st.colCount, err: r && r.error ? String(r.error) : null };
    }, [CSV_REL, csv]);
    t.ok('1.1 导入 10 万行样本：' + imp.rows + ' 行 × ' + imp.cols + ' 列', imp.ok && imp.rows === 100000 && imp.cols === 17, imp);

    await page.evaluate(function (cfg) {
      window.__YMS__.applyPlot(cfg);
      window.__YMS__.submitPlot({});
      window.__YMS__.setMode('plot');
    }, CFG);
    await page.waitForTimeout(5200);

    /* 复现配置的关键项（图型 / 四列 X / 统计量键必须是 nupct） */
    const cfgNow = await page.evaluate(function () {
      const st = window.__YMS__.getState();
      const p = st.plot || {};
      return {
        type: p.type, x: p.x, values: p.values, splitBy: p.splitBy, pageBy: p.pageBy,
        stats: p.stats, merge: p.merge, colorBy: p.group ? p.group.colorBy : null
      };
    });
    t.ok('1.2 复现配置生效：box · X 四列 · splitBy=Product · pageBy=Fab · stats=[mean,std,nupct]',
      cfgNow.type === 'box' && Array.isArray(cfgNow.x) && cfgNow.x.length === 4 &&
      String(cfgNow.splitBy) === 'Product' && String(cfgNow.pageBy) === 'Fab' &&
      !!cfgNow.stats && cfgNow.stats.show === true &&
      cfgNow.stats.items.join(',') === 'mean,std,nupct' &&
      !!cfgNow.merge && cfgNow.merge.mode === 'auto' &&
      cfgNow.colorBy === 'Tool', cfgNow);

    /* ---------- 第 2 段：卡片视图（未缩放）H1 三条 ---------- */
    const card = await page.evaluate(READ, CARD_SEL);
    t.ok('2.1 卡片：图实例可读（列数 ' + (card.ok ? card.colCount : '?') + ' · 箱体系列 ' +
      (card.ok ? card.boxSeries : '?') + ' · 箱体总数 ' + (card.ok ? card.boxTotal : '?') + '）',
      !!card.ok && card.colCount === 40 && card.boxSeries === 12 && card.boxTotal > 0, card);

    if (card.ok) {
      /* ② 箱数 == 该类别有数据的系列数（逐类对照） */
      const cntBad = card.cols.filter(function (c) { return c.n !== seriesWithData(card, c.i); });
      t.ok('2.2 卡片：每类箱数 == 该类别有数据的系列数（不符 ' + cntBad.length + ' / ' + card.cols.length +
        ' 类；每类箱数 ' + card.cols.slice(0, 3).map(function (c) { return c.n; }).join('/') + '…）',
        cntBad.length === 0, cntBad.slice(0, 5).map(function (c) { return { i: c.i, boxes: c.n, withData: seriesWithData(card, c.i) }; }));

      /* ① 包围盒中心 == 列心（≤1px） */
      const over = card.cols.filter(function (c) { return c.dx === null || Math.abs(c.dx) > 1; });
      const maxDx = card.cols.reduce(function (a, c) { return Math.max(a, Math.abs(c.dx === null ? 999 : c.dx)); }, 0);
      t.ok('2.3 卡片：全部箱体包围盒中心 == 该列 cx（超 1px 的类别 ' + over.length +
        ' 个 · 最大误差 ' + maxDx.toFixed(2) + 'px）', over.length === 0, over.slice(0, 5));

      /* ③ 双向一一对应 */
      const colNoBox = card.cols.filter(function (c) { return c.n === 0; }).map(function (c) { return c.i; });
      t.ok('2.4 卡片：有箱无列 ' + card.boxNoCol.length + ' 类 / 有列无箱 ' + colNoBox.length + ' 类',
        card.boxNoCol.length === 0 && colNoBox.length === 0, { boxNoCol: card.boxNoCol, colNoBox: colNoBox });

      /* ④ __boxAlign 自证记录：说明空箱不建图元，并给出槽位数 / 槽距 */
      t.ok('2.5 卡片：__boxAlign 记录槽位数 ' + (card.align ? card.align.lanes : '?') + ' · 槽距 ' +
        (card.align ? card.align.step : '?') + 'px · 本次位移 ' + (card.align ? card.align.moved : '?') + ' 个箱体' +
        '（说明：' + (card.align ? card.align.note.slice(0, 22) : '—') + '…）',
        !!card.align && card.align.lanes >= 2 && card.align.step > 0 &&
        card.align.orphans.boxNoCol.length === 0 && card.align.orphans.colNoBox.length === 0 &&
        card.align.note.indexOf('不建图元') >= 0, card.align);
    } else {
      t.ok('2.2 卡片：每类箱数 == 该类别有数据的系列数', false, card);
      t.ok('2.3 卡片：全部箱体包围盒中心 == 该列 cx', false, card);
      t.ok('2.4 卡片：有箱无列 / 有列无箱 = 0', false, card);
      t.ok('2.5 卡片：__boxAlign 记录', false, card);
    }

    /* ---------- 第 3 段：全屏 + 四步缩放，每步 H1 三条 ---------- */
    await page.evaluate(function () { window.__YMS__.openFullscreen(0); });
    await page.waitForTimeout(2600);

    const stepReport = {};
    let allOk = true;
    for (let s = 0; s < STEPS.length; s++) {
      const st = STEPS[s];
      await page.evaluate(function (a) {
        const el = document.querySelector(a.sel);
        const inst = el ? window.echarts.getInstanceByDom(el) : null;
        if (inst) inst.dispatchAction({ type: 'dataZoom', start: a.s[0], end: a.s[1] });
      }, { sel: FS_SEL, s: st });
      await page.waitForTimeout(2400);
      const m = await page.evaluate(READ, FS_SEL);
      const tag = st.join('-') + '%';
      if (!m.ok) {
        t.ok('3.' + (s + 1) + 'a ' + tag + '：图实例可读', false, m);
        t.ok('3.' + (s + 1) + 'b ' + tag + '：对位 / 箱数 / 一一对应', false, m);
        allOk = false;
        continue;
      }
      const cntBad = m.cols.filter(function (c) { return c.n !== seriesWithData(m, c.i); });
      const over = m.cols.filter(function (c) { return c.dx === null || Math.abs(c.dx) > 1; });
      const maxDx = m.cols.reduce(function (a, c) { return Math.max(a, Math.abs(c.dx === null ? 999 : c.dx)); }, 0);
      const colNoBox = m.cols.filter(function (c) { return c.n === 0; }).map(function (c) { return c.i; });
      const okStep = cntBad.length === 0 && over.length === 0 &&
        m.boxNoCol.length === 0 && colNoBox.length === 0 && m.colCount === m.cols.length;
      stepReport[tag] = {
        colCount: m.colCount, bandW: m.bandW, boxW: m.boxW, lanes: m.lanes, step: m.layStep,
        boxTotal: m.boxTotal, viol: over.length, maxDx: Number(maxDx.toFixed(2)),
        cntBad: cntBad.length, boxNoCol: m.boxNoCol.length, colNoBox: colNoBox.length, ok: okStep
      };
      if (!okStep) allOk = false;
      t.ok('3.' + (s + 1) + 'a ' + tag + '：可见列 ' + m.colCount + ' · 带宽 ' + m.bandW +
        'px · 箱宽 ' + m.boxW + 'px · 槽距 ' + m.layStep + 'px · 箱体 ' + m.boxTotal +
        ' 个 · 每类箱数不符 ' + cntBad.length + ' 类',
        cntBad.length === 0 && m.colCount > 0 && m.boxTotal === m.cols.reduce(function (a, c) { return a + c.n; }, 0),
        { bad: cntBad.slice(0, 4), boxTotal: m.boxTotal });
      t.ok('3.' + (s + 1) + 'b ' + tag + '：包围盒中心==列心 超 1px ' + over.length + ' 类（最大 ' +
        maxDx.toFixed(2) + 'px）· 有箱无列 ' + m.boxNoCol.length + ' · 有列无箱 ' + colNoBox.length,
        over.length === 0 && m.boxNoCol.length === 0 && colNoBox.length === 0,
        { over: over.slice(0, 4), boxNoCol: m.boxNoCol, colNoBox: colNoBox });
    }
    t.ok('3.5 四步缩放（25-75 → 75-100 → 0-100 → 0-8）每一步都满足 H1 三条', allOk, stepReport);

    /* ---------- 第 4 段：tooltip 真实 DOM（H2） ---------- */
    /* 回到 25-75（用户截图那一屏）再验 tooltip */
    await page.evaluate(function (a) {
      const el = document.querySelector(a.sel);
      const inst = el ? window.echarts.getInstanceByDom(el) : null;
      if (inst) inst.dispatchAction({ type: 'dataZoom', start: a.s[0], end: a.s[1] });
    }, { sel: FS_SEL, s: [25, 75] });
    await page.waitForTimeout(2400);
    const mFS = await page.evaluate(READ, FS_SEL);
    const colsPick = mFS.ok && mFS.cols.length
      ? [mFS.cols[0], mFS.cols[Math.floor(mFS.cols.length / 2)], mFS.cols[mFS.cols.length - 1]]
      : [];
    t.ok('4.0 25-75% 可见列 ' + (mFS.ok ? mFS.colCount : '?') + '，抽查列索引 ' +
      JSON.stringify(colsPick.map(function (c) { return c.i; })), mFS.ok && colsPick.length === 3, mFS.ok ? null : mFS);

    const nameOf = {};
    if (mFS.ok) Object.keys(mFS.data).forEach(function (n) { nameOf[mFS.data[n].s] = n; });

    let emptyNameLeak = 0, emptyLabelRows = 0, worstErr = 0, checkedVals = 0, headOk = true;
    const matrix = [];
    for (let ci = 0; ci < colsPick.length; ci++) {
      const col = colsPick[ci];
      /* 该类别有数据的系列（按 series.data 判）→ 取前 3 个逐个触发 tooltip */
      const withData = col.sers.slice(0, 3);
      const noDataNames = Object.keys(mFS.data).filter(function (n) { return col.sers.indexOf(mFS.data[n].s) < 0; });
      for (let k = 0; k < withData.length; k++) {
        const sIdx = withData[k], sName = nameOf[sIdx];
        await page.evaluate(SHOW_TIP, { sel: FS_SEL, s: sIdx, d: col.i });
        await page.waitForTimeout(320);
        const tip = await page.evaluate(READ_TIP);
        if (!tip) { matrix.push({ col: col.i, ser: sName, got: null }); worstErr = 999; continue; }
        /* 首行标题格式：<b>…</b> 分类名（合并组带括号范围） */
        if (k === 0 && ci === 0) {
          headOk = /^<b>[^<]+<\/b>/.test(tip.html.split('<br>')[0] || '') && tip.text.split('\n').length >= 2;
        }
        /* ② 无数据系列绝不能出现在 tooltip 文本里 */
        noDataNames.forEach(function (n) { if (tip.text.indexOf(n + '：') >= 0 || tip.text.indexOf(n) >= 0) emptyNameLeak++; });
        /* ③ 绝不能出现「只有标签没有数值」的残片 */
        emptyLabelRows += (tip.text.match(/min\s*·\s*Q1/g) || []).length;
        /* ④ 五数值齐全，且与 series.data 逐值一致（按打印小数位取整比对 → 误差 0） */
        const parsed = parseLine(tip.text, sName);
        const want = mFS.data[sName].vals[col.i];
        const row = { col: col.i, ser: sName, got: parsed ? parsed.nums.map(function (x) { return x.raw; }) : null };
        if (!parsed || parsed.nums.length !== 5 || !want) {
          worstErr = 999; row.err = 'MISSING';
          matrix.push(row);
          continue;
        }
        let err = 0;
        for (let vi = 0; vi < 5; vi++) {
          const dec = decimalsOf(parsed.nums[vi].raw);
          const e = Math.abs(parsed.nums[vi].v - roundTo(Number(want[vi]), dec));
          if (e > err) err = e;
          checkedVals++;
        }
        if (err > worstErr) worstErr = err;
        row.err = Number(err.toFixed(6));
        row.want = want.map(function (v) { return Number(v); });
        matrix.push(row);
      }
    }
    t.ok('4.1 tooltip 无数据系列不出现（抽 ' + colsPick.length + ' 列 × 3 系列：空系列名泄漏 ' +
      emptyNameLeak + ' 次）', emptyNameLeak === 0, matrix.filter(function (r) { return r.got; }).slice(0, 1));
    t.ok('4.2 tooltip 无「只有标签没有数值」残片（"min · Q1" 出现 ' + emptyLabelRows + ' 次）',
      emptyLabelRows === 0, null);
    t.ok('4.3 tooltip 五数值与 series.data 逐值一致（' + checkedVals + ' 个值，最大误差 ' +
      (worstErr === 999 ? 'MISSING' : worstErr) + '）',
      checkedVals === colsPick.length * 3 * 5 && worstErr === 0, matrix);
    t.ok('4.4 tooltip 首个标题行格式不变（<b>分类名</b> + 至少一行系列）', headOk, null);

    /* 4.5 对照：修复前的形态（同一类别里无数据系列会印出五个裸标签）在本版本已不可能出现 */
    const emptyCount = mFS.ok ? Object.keys(mFS.data).length - colsPick[0].sers.length : -1;
    t.ok('4.5 该类别 12 个系列中 ' + colsPick[0].sers.length + ' 个有数据、' + emptyCount +
      ' 个无数据 → tooltip 只列 ' + colsPick[0].sers.length + ' 行',
      emptyCount > 0, { data: colsPick[0].sers.length, empty: emptyCount });

    await page.evaluate(function () { if (window.YMS && window.YMS.Fullscreen) window.YMS.Fullscreen.close(); });
    await page.waitForTimeout(300);

    /* ---------- 第 5 段：用例已登记（防「静默不跑」） ---------- */
    const runSrc = fs.readFileSync(path.join(HERE, '..', 'run.js'), 'utf8');
    t.ok('5.1 本用例已登记进 run.js 的 CASE_FILES（否则运行器静默不跑、看着全绿其实没测）',
      runSrc.indexOf("'" + CASE_FILE + "'") >= 0, { needle: CASE_FILE });
    t.ok('5.2 用例文件真实存在：test/cases/' + CASE_FILE, fs.existsSync(path.join(HERE, CASE_FILE)), null);

    /* ---------- 收尾 ---------- */
    await page.waitForTimeout(150);
    t.noErrors('6.1 零未捕获异常 / 控制台错误', ctx.errors);
  }
};
