/* ==========================================================================
   YMS · test/cases/stats-block-order.js
   断言对象：**轴层统计行通道**（plot.table.show = false + plot.stats.show = true，
             统计数值竖排旋转）的纵向次序
   命中代码：js/plot/axis.js（bottomFit：labelGap = 轴标签间距 + 统计行带 + 分组带）
             js/plot/chart-builder.js（axisTableLayout 锚点 / axisBlockGraphic 标记
             / statBlockOf → option.__statBlock）
   用户原话（上一轮只改了数据表格通道，用户实际用的是这条轴层通道）：
     「统计行要在最上，分组带和横轴参数在下」——他的截图里统计数值是**竖排旋转**的，
     那是轴层画法；数据表格通道的数值是水平文本，所以上一轮他看不出变化。

   改前实测基线（探针 probe_stats_swap.js）：分组文字 bottom = Tool 171 / CHM 156（在上），
     统计文字 bottom = Mean 69 / Std 38（在下）→ minStat(38) < maxGroup(171)。

   目标纵向次序（自上而下，graphic bottom 越大越靠上）：
     ① 统计行 Mean / Std / Nu%（顺序仍按 STAT_ORDER，行名列照旧）
     ② 分组带 级 0 → 级 N-1（级 0 最上，跨列合并）
     ③ 轴标签（旋转的类别名，角度与高度预算不变）
   硬约束：
     · grid.bottom 预算 = 统计行高 + 分组带高 + 轴标签块高（总和不裁任何一块；
       总和与次序无关 → 数值逐值不变，其它用例的 bottom 断言不受影响）
     · 全屏通道（reflowAxisTable）同样生效，且不与底部 dataZoom slider 带冲突
     · 数据表格通道（上一轮已改好）**绝不许退化**：其 min(stat) > max(group) 继续绿
     · 无分组（单列 X）时不得产生空带、不得留白退化
   读数方式：只读包装 YMS.ChartBuilder.buildOption 抓 option.__statBlock / graphic 文本 bottom；
             不改应用行为。
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const app = require('../helpers/app');

const TOOLS = ['Tool1', 'Tool2', 'Tool4', 'Tool3'];   // 用户真实面板顺序（非字母序）
const CHAMBERS = ['CHM1', 'CHM2'];
const LAYERS = ['PA', 'VA', 'M2', 'Pol'];

/* --------------------------------------------------------------- 夹具 */

/** 4 列 X 的底表：Tool_Group → Chamber_Group → Layer → Lot（= 3 级分组） */
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

/**
 * 出图（真实提交路径）
 * @param {boolean} tableOn plot.table.show
 * @param {boolean} statRotate stats.rotate（90 = 用户截图里的竖排统计数值）
 */
async function plot(page, x, tableOn, statRotate) {
  await page.evaluate(function (a) {
    window.__capOpts = [];
    window.__YMS__.setMode('plot');
    window.__YMS__.applyPlot({
      type: 'box', x: a[0], values: ['Yield'], sorters: [], splitBy: [], pageBy: [], display: 'facet',
      merge: { mode: 'auto', limit: null },
      stats: { show: true, items: ['mean', 'std', 'nupct'], rotate: a[2] },
      table: { show: !!a[1], frame: true }
    });
    window.__YMS__.submitPlot({});
  }, [x, !!tableOn, statRotate === undefined ? 90 : statRotate]);
  await page.waitForTimeout(1200);
}

/** 读最后一次 buildOption：__statBlock + __axisFit + __groupAxis + graphic 文本（只读） */
async function readStat(page) {
  const r = await page.evaluate(function () {
    const caps = window.__capOpts || [];
    const opt = caps.length ? caps[caps.length - 1] : null;
    if (!opt) return { ok: false };
    const sb = opt.__statBlock || null;
    const ga = opt.__groupAxis || null;
    const fit = opt.__axisFit || null;
    const tb = opt.__table || null;
    const texts = [];
    (opt.graphic || []).forEach(function (e) {
      if (!e || e.type !== 'text' || !e.style || !e.style.text) return;
      texts.push({
        t: String(e.style.text),
        b: Math.round(e.bottom),
        rot: e.rotation ? Math.round(e.rotation * 180 / Math.PI) : 0,
        stat: e.__statRow !== undefined,
        grp: e.__groupBand !== undefined
      });
    });
    return {
      ok: true,
      sbRaw: !!sb,
      sb: sb ? {
        order: sb.order, rows: sb.rows,
        statBottoms: (sb.statBottoms || []).slice(),
        groupBottoms: (sb.groupBottoms || []).slice(),
        groupRowBottoms: (sb.groupRowBottoms || []).slice(),
        groupCells: sb.groupCells, labelH: sb.labelH, labelTop: sb.labelTop,
        rowH: sb.rowH, rowGap: sb.rowGap,
        paramRows: (sb.paramRows || []).slice(),
        paramOrder: (sb.paramOrder || []).slice(),
        statBase: sb.statBase, statTop: sb.statTop, mode: sb.mode
      } : null,
      fit: fit ? {
        bottom: fit.bottom, rotH: fit.rotH, labelGap: fit.labelGap,
        groupBand: fit.groupBand, rows: fit.rows, extra: fit.extra
      } : null,
      ga: ga ? {
        on: !!ga.on, source: ga.source, levelCount: ga.levelCount,
        counts: (ga.levels || []).map(function (l) { return l.count; })
      } : null,
      tbLayout: (tb && tb.layout) ? {
        order: tb.layout.order, nStat: tb.layout.nStat, nSeries: tb.layout.nSeries,
        statBottoms: (tb.layout.statBottoms || []).slice(),
        seriesBottoms: (tb.layout.seriesBottoms || []).slice(),
        groupBottoms: (tb.layout.groupBottoms || []).slice(),
        headerBottom: tb.layout.headerBottom
      } : null,
      tbOn: tb ? !!tb.on : false,
      tbNAll: tb ? tb.nAll : null,
      statRows: opt.__statRows === undefined ? null : opt.__statRows,
      texts: texts
    };
  });
  if (!r.ok) return r;
  /* 缺 __statBlock（改动前的版本）→ 空壳：让断言逐条判红，而不是第一条就抛异常中断 */
  if (!r.sb) {
    r.sb = {
      order: null, rows: null, statBottoms: [], groupBottoms: [], groupRowBottoms: [],
      groupCells: 0, labelH: null, labelTop: null, statBase: null, statTop: null, mode: null,
      paramRows: [], paramOrder: []
    };
  }
  ['statBottoms', 'groupBottoms', 'groupRowBottoms'].forEach(function (k) {
    if (!Array.isArray(r.sb[k])) r.sb[k] = [];
  });
  if (!r.fit) r.fit = { bottom: null, rotH: null, labelGap: null, groupBand: null, rows: null, extra: null };
  if (!r.ga) r.ga = { on: false, source: null, levelCount: 0, counts: [] };
  if (!Array.isArray(r.texts)) r.texts = [];
  return r;
}

function minOf(a) { return (a && a.length) ? Math.min.apply(null, a) : null; }
function maxOf(a) { return (a && a.length) ? Math.max.apply(null, a) : null; }
/** 严格递减（越大越靠上 → 数组首项最大）；长度 < 2 判否（空数组不许假绿） */
function strictlyDesc(a) {
  if (!a || a.length < 2) return false;
  for (let i = 0; i + 1 < a.length; i++) if (!(a[i] > a[i + 1])) return false;
  return true;
}
function uniq(a) {
  const o = [];
  (a || []).forEach(function (v) { if (o.indexOf(v) < 0) o.push(v); });
  return o;
}
function sum(a) { return (a || []).reduce(function (s, v) { return s + v; }, 0); }

module.exports = {
  id: 'stats-block-order',
  title: '轴层统计行通道纵向次序（统计行在最上 / 分组带居中 / 轴标签在下 / 全屏同 / 表格通道零回归）',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;
    await installOptionTap(page);

    const imp = await app.importText(page, 'stats_block.csv', makeCsv4());
    t.eq('1.1 导入 64 行 × 7 列（4 tool × 2 chamber × 4 layer × 2 lot）', imp.rows + 'x' + imp.cols, '64x7');

    /* ==================================================================
       1. 卡片视图 · 4 列 X（3 级分组）· table.show=false · stats.rotate=90
          —— 用户实际使用的那条通道
       ================================================================== */
    await plot(page, ['Tool_Group', 'Chamber_Group', 'Layer', 'Lot'], false, 90);
    const a = await readStat(page);

    t.eq('1.2 option.__statBlock 已暴露（实际绘制的 graphic bottom 汇总）', a.sbRaw, true);
    t.eq('1.3 __statBlock.order = 统计行 → 轴标签 → 参数行（迭代 30）', a.sb.order, 'stat,label,param');
    t.eq('1.4 统计行数 = 3（Mean / Std / Nu%）', a.sb.rows, 3);
    t.eq('1.5 __statBlock.statBottoms 长度 = 3（3 个统计行各一个 bottom）', a.sb.statBottoms.length, 3);
    t.eq('1.6 数据表格未接管横轴（table.show=false → __table.on=false）', a.tbOn, false);

    const minS = minOf(a.sb.statBottoms), maxG = maxOf(a.sb.groupBottoms);
    t.ok('1.7 ★ min(statBottoms)=' + minS + ' > max(groupBottoms)=' + maxG + '：统计行整块在分组带上方',
      minS !== null && maxG !== null && minS > maxG,
      { statBottoms: a.sb.statBottoms, groupBottoms: uniq(a.sb.groupBottoms) });
    t.ok('1.8 统计行 bottom 严格递减（自上而下 Mean → Std → Nu%）',
      strictlyDesc(a.sb.statBottoms), a.sb.statBottoms);
    t.eq('1.9 分组带总格数 = 各级分组格数之和（groupBottoms 逐格）',
      a.sb.groupBottoms.length, sum(a.ga.counts));
    t.eq('1.10 分组带级数 = 3（Tool / Chamber / Layer）', a.ga.levelCount, 3);
    t.ok('1.11 分组带级 0 在最上（去重后 bottom 严格递减）',
      strictlyDesc(uniq(a.sb.groupBottoms)), uniq(a.sb.groupBottoms));
    const pBottoms = a.sb.paramRows.map(function (r) { return r.bottom; });
    t.ok('1.12 参数行（分组带 + 叶子）整体在类别标签块之下（labelTop=' + a.sb.labelTop + ' > max(paramBottom)=' + maxOf(pBottoms) + '）',
      typeof a.sb.labelTop === 'number' && pBottoms.length > 0 && a.sb.labelTop > maxOf(pBottoms),
      { labelTop: a.sb.labelTop, paramRows: a.sb.paramRows });
    t.eq('1.12b 参数行自上而下 = Lot → Layer → Chamber_Group → Tool_Group（X 列逆序）',
      a.sb.paramRows.map(function (r) { return r.name; }).join('|'),
      'Lot|Layer|Chamber_Group|Tool_Group');
    t.eq('1.12c 参数行自下而上 = 设置区 X 列顺序（Tool_Group → Chamber_Group → Layer → Lot）',
      a.sb.paramOrder.join('|'), 'Tool_Group|Chamber_Group|Layer|Lot');
    t.eq('1.13 轴标签块高 labelH = __axisFit.rotH（标签高度预算同源）', a.sb.labelH, a.fit.rotH);
    t.ok('1.14 统计行带底边 = 分组带上沿 + 行间距 → 两者不重叠（统计带底边 > 分组最高 bottom）',
      typeof a.sb.statBase === 'number' && maxG !== null && a.sb.statBase > maxG,
      { statBase: a.sb.statBase, maxGroup: maxG });
    const topClear = (typeof a.sb.statTop === 'number' && typeof a.fit.bottom === 'number')
      ? a.fit.bottom - a.sb.statTop : null;
    t.ok('1.15 统计行带不侵入绘图区（grid.bottom − 统计带顶边 = 轴标签间距 7px 档，实测 ' + topClear + '）',
      topClear !== null && topClear >= 7 && topClear <= 10,
      { statTop: a.sb.statTop, gridBottom: a.fit.bottom, clearance: topClear });

    /* graphic 实测（不只看元数据）：统计数值 vs 分组文字 */
    const statT = a.texts.filter(function (x) { return x.stat; });
    const grpT = a.texts.filter(function (x) { return x.grp; });
    const minStatGraphic = minOf(statT.map(function (x) { return x.b; }));
    const maxGroupGraphic = maxOf(grpT.map(function (x) { return x.b; }));
    t.ok('1.16 ★ graphic 实测 min(统计数值 bottom)=' + minStatGraphic + ' > max(分组文字 bottom)=' + maxGroupGraphic,
      minStatGraphic !== null && maxGroupGraphic !== null && minStatGraphic > maxGroupGraphic,
      { statTextCount: statT.length, grpTextCount: grpT.length });
    t.ok('1.17 统计数值按 stats.rotate=90 竖排绘制（全部 90°）',
      statT.length > 0 && statT.every(function (x) { return x.rot === 90; }),
      { rot: uniq(statT.map(function (x) { return x.rot; })), count: statT.length });
    t.ok('1.18 统计数值覆盖全部统计行（每个统计量至少 1 列被画）',
      statT.length >= 3, statT.length);

    /* 行名列跟着统计行走 */
    const NAME_OF = ['Mean', 'Std', 'Nu%'];
    NAME_OF.forEach(function (nm, i) {
      const bs = a.texts.filter(function (x) { return x.t === nm; }).map(function (x) { return x.b; });
      t.eq('1.19.' + (i + 1) + ' 行名「' + nm + '」只画 1 次', bs.length, 1);
    });
    const nameBottoms = NAME_OF.map(function (nm) {
      const bs = a.texts.filter(function (x) { return x.t === nm; }).map(function (x) { return x.b; });
      return bs.length ? bs[0] : null;
    });
    t.ok('1.20 三个行名都在分组带之上（行名跟着统计行走，仍属统计行带）',
      nameBottoms.every(function (b) { return typeof b === 'number'; }) &&
      maxG !== null && minOf(nameBottoms) > maxG,
      { nameBottoms: nameBottoms, maxGroup: maxG });
    t.ok('1.21 行名 bottom 严格递减（Mean 最上 → Nu% 最下）', strictlyDesc(nameBottoms), nameBottoms);
    /* 行名列与统计数值行**同一条行带**（偏差 < 行带高 → 行名没有错行） */
    const offBand = NAME_OF.map(function (nm, i) {
      const bs = a.texts.filter(function (x) { return x.t === nm; }).map(function (x) { return x.b; });
      const sb = a.sb.statBottoms[i];
      if (!bs.length || typeof sb !== 'number' || !(a.sb.rowH > 0)) return null;
      return Math.abs(bs[0] - sb);
    });
    t.ok('1.22 行名与对应统计数值同一行带（|Δ| ≤ 行带高 ' + a.sb.rowH + '，实测 ' + JSON.stringify(offBand) + '）',
      offBand.every(function (v) { return v !== null && v <= a.sb.rowH; }),
      { offsets: offBand, rowH: a.sb.rowH, statBottoms: a.sb.statBottoms });
    t.noErrors('1.23 第 1 段零未捕获异常 / 控制台错误', ctx.errors);

    /* ==================================================================
       2. 全屏视图（YMS.Fullscreen.open(0) → reflowAxisTable 重算）同样生效
       ================================================================== */
    const cardFitBottom = a.fit.bottom;
    await page.evaluate(function () { window.YMS.Fullscreen.open(0); });
    await page.waitForTimeout(2200);
    const fsr = await readStat(page);
    t.eq('2.1 全屏 __statBlock 已暴露（重算后同步刷新）', fsr.sbRaw, true);
    const minSfs = minOf(fsr.sb.statBottoms), maxGfs = maxOf(fsr.sb.groupBottoms);
    t.ok('2.2 ★ 全屏 min(statBottoms)=' + minSfs + ' > max(groupBottoms)=' + maxGfs,
      minSfs !== null && maxGfs !== null && minSfs > maxGfs,
      { stat: fsr.sb.statBottoms, group: uniq(fsr.sb.groupBottoms) });
    t.eq('2.3 全屏统计行数仍是 3', fsr.sb.statBottoms.length, 3);
    t.eq('2.4 全屏 order 与卡片一致', fsr.sb.order, 'stat,label,param');
    t.ok('2.5 全屏 grid.bottom 真按全屏高重算（≠ 卡片值）',
      typeof fsr.fit.bottom === 'number' && typeof cardFitBottom === 'number' && fsr.fit.bottom !== cardFitBottom,
      { card: cardFitBottom, fs: fsr.fit.bottom });
    t.ok('2.6 全屏底部为 dataZoom slider 留出 30px 带（标签块不压 slider）',
      typeof fsr.fit.extra === 'number' && fsr.fit.extra >= 30 &&
      typeof fsr.sb.labelTop === 'number' && (fsr.sb.labelTop - fsr.sb.labelH) >= 0,
      { extra: fsr.fit.extra, labelBlockBottom: fsr.sb.labelTop - fsr.sb.labelH });
    const fsParamB = fsr.sb.paramRows.map(function (r) { return r.bottom; });
    t.ok('2.7 全屏参数行仍在统计行之下、标签块之下（labelTop=' + fsr.sb.labelTop + ' > max(paramBottom)=' + maxOf(fsParamB) + '）',
      typeof fsr.sb.labelTop === 'number' && fsParamB.length > 0 &&
      fsr.sb.labelTop > maxOf(fsParamB) && maxOf(fsParamB) < minSfs,
      { labelTop: fsr.sb.labelTop, paramRows: fsr.sb.paramRows, stat: fsr.sb.statBottoms });
    t.eq('2.7b 全屏参数行顺序与卡片一致（自上而下 Lot → Layer → Chamber → Tool）',
      fsr.sb.paramRows.map(function (r) { return r.name; }).join('|'),
      'Lot|Layer|Chamber_Group|Tool_Group');
    t.noErrors('2.8 全屏段零未捕获异常 / 控制台错误', ctx.errors);
    await page.evaluate(function () { window.YMS.Fullscreen.close(); });
    await page.waitForTimeout(400);

    /* ==================================================================
       3. 单列 X（无分组）：统计行仍最上，且不产生空带 / 留白退化
       ================================================================== */
    await plot(page, ['Tool_Group'], false, 90);
    const c = await readStat(page);
    t.eq('3.1 单列 X 时无分组带（groupBottoms 为空）', c.sb.groupBottoms.length, 0);
    t.eq('3.2 单列 X 时统计行仍 3 行', c.sb.statBottoms.length, 3);
    t.ok('3.3 单列 X 时统计行整块仍在标签块之上（min(statBottoms) > labelTop）',
      minOf(c.sb.statBottoms) !== null && typeof c.sb.labelTop === 'number' &&
      minOf(c.sb.statBottoms) > c.sb.labelTop,
      { stat: c.sb.statBottoms, labelTop: c.sb.labelTop });
    const gapNoGroup = (typeof c.sb.statBase === 'number' && typeof c.sb.labelTop === 'number')
      ? c.sb.statBase - c.sb.labelTop : null;
    t.ok('3.4 无分组时不留空带（统计带底边 − 标签块顶端 = 行间距 3px ±1）',
      gapNoGroup !== null && Math.abs(gapNoGroup - 3) <= 1,
      { gap: gapNoGroup });
    t.ok('3.5 单列 X 时标签块高仍 > 0（标签未被裁掉）', c.sb.labelH > 0, c.sb.labelH);
    t.noErrors('3.6 第 3 段零未捕获异常 / 控制台错误', ctx.errors);

    /* ==================================================================
       4. 2 列 X（1 级分组）：规则与级数无关
       ================================================================== */
    await plot(page, ['Tool_Group', 'Lot'], false, 90);
    const d = await readStat(page);
    t.eq('4.1 2 列 X 时分组级数 = 1', d.ga.levelCount, 1);
    const minS1 = minOf(d.sb.statBottoms), maxG1 = maxOf(d.sb.groupBottoms);
    t.ok('4.2 ★ 1 级分组 min(statBottoms)=' + minS1 + ' > max(groupBottoms)=' + maxG1,
      minS1 !== null && maxG1 !== null && minS1 > maxG1,
      { stat: d.sb.statBottoms, group: uniq(d.sb.groupBottoms) });
    t.eq('4.3 统计行仍 3 行', d.sb.statBottoms.length, 3);
    t.eq('4.4 分组带格数 = 该级分组格数', d.sb.groupBottoms.length, sum(d.ga.counts));
    t.noErrors('4.5 第 4 段零未捕获异常 / 控制台错误', ctx.errors);

    /* ==================================================================
       5. 数据表格通道已停用（迭代 30 注释摘除，仅保留代码供回溯）——
          即使显式请求 table.show=true，也必须走轴层通道
       ================================================================== */
    await plot(page, ['Tool_Group', 'Chamber_Group', 'Layer', 'Lot'], true, 0);
    const e = await readStat(page);
    t.eq('5.1 显式请求数据表格时通道仍停用（__table.on = false）', e.tbOn, false);
    t.eq('5.2 此时仍产生 __statBlock（轴层接管）', e.sbRaw, true);
    t.eq('5.3 轴层次序仍是 stat,label,param', e.sb.order, 'stat,label,param');
    t.eq('5.4 参数行顺序与 table=false 时完全一致（自上而下 Lot → Layer → Chamber → Tool）',
      e.sb.paramRows.map(function (r) { return r.name; }).join('|'),
      'Lot|Layer|Chamber_Group|Tool_Group');
    const eParamB = e.sb.paramRows.map(function (r) { return r.bottom; });
    t.ok('5.5 ★ 停用表格通道后统计行仍在参数行之上（min(statBottoms)=' + minOf(e.sb.statBottoms) + ' > max(paramBottom)=' + maxOf(eParamB) + '）',
      minOf(e.sb.statBottoms) !== null && eParamB.length > 0 && minOf(e.sb.statBottoms) > maxOf(eParamB),
      { stat: e.sb.statBottoms, paramRows: e.sb.paramRows });
    t.noErrors('5.6 第 5 段零未捕获异常 / 控制台错误', ctx.errors);

    /* ==================================================================
       6. 用例已登记进 run.js（只删段不登记 → 运行器静默不跑，看着全绿其实没测）
       ================================================================== */
    const runSrc = fs.readFileSync(path.resolve(__dirname, '..', 'run.js'), 'utf8');
    t.contains('6.1 run.js 的 CASE_FILES 已登记 stats-block-order.js', runSrc, 'stats-block-order.js');
    t.ok('6.2 本用例文件真实存在',
      fs.existsSync(path.resolve(__dirname, 'stats-block-order.js')), __dirname);

    /* ==================================================================
       7. 缩放同步（迭代 30 · 任务 D ②）
          全屏内 dataZoom 后，横轴参数行（各级合并格）必须按**可视窗口**重排：
          各级 count 之和 == 可见类别数、span == count × 同一单位带宽
       ================================================================== */
    await plot(page, ['Tool_Group', 'Chamber_Group', 'Layer', 'Lot'], false, 0);
    await page.waitForTimeout(500);
    await page.evaluate(function () {
      const btns = document.querySelectorAll('.chart-card button');
      for (let bi = 0; bi < btns.length; bi++) {
        const ti = btns[bi].getAttribute('title') || '';
        if (ti.indexOf('放大') >= 0) { btns[bi].click(); return; }
      }
      if (window.__YMS__.openFullscreen) window.__YMS__.openFullscreen(0);
    });
    await page.waitForTimeout(1600);

    const readZoom = function () {
      const root = document.getElementById('fullscreen-root');
      const host = root ? root.querySelector('.echarts-host') : null;
      const inst = host ? window.echarts.getInstanceByDom(host) : null;
      if (!inst) return { ok: false };
      const op = inst.getOption();
      const ga = op.__groupAxis || null;
      const dz = (op.dataZoom || [])[0] || {};
      const total = ((op.xAxis && op.xAxis[0] && op.xAxis[0].data) || []).length;
      const lv = (ga && ga.levels ? ga.levels : []).map(function (L) {
        const cs = L.cells || [];
        const unit = cs.length ? (cs[0].span / Math.max(1, cs[0].count)) : 0;
        return {
          cells: cs.length,
          sum: cs.reduce(function (a, c) { return a + (c.count || 0); }, 0),
          unit: unit,
          spanAllOk: cs.every(function (c) {
            return Math.abs(c.span - c.count * unit) <= 1;
          })
        };
      });
      return {
        ok: true, total: total,
        start: (dz.start === undefined ? null : dz.start),
        end: (dz.end === undefined ? null : dz.end),
        levels: lv
      };
    };

    const zBefore = await page.evaluate(readZoom);
    t.eq('7.1 全屏未缩放时级 0 count 之和 = 全部类别数',
      zBefore.levels.length ? zBefore.levels[0].sum : -1, zBefore.total);

    await page.evaluate(function () {
      const root = document.getElementById('fullscreen-root');
      const host = root ? root.querySelector('.echarts-host') : null;
      const inst = host ? window.echarts.getInstanceByDom(host) : null;
      if (inst) inst.dispatchAction({ type: 'dataZoom', start: 25, end: 75 });
    });
    await page.waitForTimeout(1400);
    const zAfter = await page.evaluate(readZoom);

    const expectVisible = Math.round(zBefore.total * 0.5);
    t.ok('7.2 缩放后级 0 count 之和显著小于全量（' + (zAfter.levels[0] || {}).sum + ' < ' + zBefore.total + '）',
      zAfter.levels.length > 0 && zAfter.levels[0].sum < zBefore.total,
      { before: zBefore.levels[0], after: zAfter.levels[0] });
    t.ok('7.3 缩放后级 0 count 之和 ≈ 窗口可见类别数（50% → ' + expectVisible + '，容差 ±2）',
      zAfter.levels.length > 0 && Math.abs(zAfter.levels[0].sum - expectVisible) <= 2,
      { sum: zAfter.levels[0] ? zAfter.levels[0].sum : null, expect: expectVisible });
    t.eq('7.4 缩放后各级 count 之和彼此相等（同一可视窗口）',
      zAfter.levels.map(function (l) { return l.sum; }).join('|'),
      zAfter.levels.map(function () { return zAfter.levels[0].sum; }).join('|'));
    t.eq('7.5 缩放后每级每个合并格的 span = count × 同一单位带宽（误差 ≤1px）',
      zAfter.levels.map(function (l) { return l.spanAllOk ? 1 : 0; }).join(''), '1'.repeat(zAfter.levels.length));

    await page.evaluate(function () { window.YMS.Fullscreen.close(); });
    await page.waitForTimeout(400);
    t.noErrors('7.6 第 7 段零未捕获异常 / 控制台错误', ctx.errors);
  }
};
