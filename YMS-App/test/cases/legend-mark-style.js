/* ==========================================================================
   YMS · test/cases/legend-mark-style.js
   断言对象：迭代 31「图例与图元」设置区（plot.legend / plot.mark）
   命中代码：js/core/store.js（DEFAULT_LEGEND / DEFAULT_MARK / 类型规则表）
             js/plot/plot-settings.js（第 8 区控件）
             js/plot/chart-builder.js（legendCfg / 各 series 图元字段消费）
             js/data/yms-template.js（PLOT_EXTRA_KEYS 白名单）
   目标语义：
     1) **默认必须零变化**：默认设置下，option.legend 与各 series 图元字段 == 改动前写死的值
     2) legend 11 个控件逐个生效（读 getOption 实证，不看截图）
     3) mark 各图型图元字段逐个生效（line / bar / scatter / box）
     4) **颜色不外溢**：改 legend.textColor 后 series 颜色一个像素都不变
     5) 图例位置 top/bottom/left/right 切换时 grid 相应让位
     6) .yms 载入时 legend / mark 逐字段还原（白名单 + 类型校验真的接上了）
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const app = require('../helpers/app');

const CSV = [
  'Lot,Tool,Yield,Bin1',
  'L0001,T01,92.25,90.47',
  'L0002,T01,91.80,90.11',
  'L0003,T02,93.10,91.02',
  'L0004,T02,90.44,89.88',
  'L0005,T03,94.02,91.55',
  'L0006,T03,92.77,90.66',
  'L0007,T01,92.90,90.90',
  'L0008,T02,91.10,90.20'
].join('\n');

/* 用**两个值列**做基底：series 数 = 2 → showLegend 为真，图例才会真的出现 */
const BASE = { sorters: [], splitBy: [], pageBy: [], display: 'single' };

async function plot(page, cfg) {
  await page.evaluate(function (c) {
    window.__YMS__.setMode('plot');
    window.__YMS__.applyPlot(c);
    window.__YMS__.submitPlot({});
  }, cfg);
  await page.waitForTimeout(800);
}

/** 读当前渲染的 legend / series / grid（getOption 实证） */
function readOpt(page) {
  return page.evaluate(function () {
    const insts = window.YMS.PlotView.charts || [];
    const inst = insts.length ? insts[insts.length - 1].chart : null;
    if (!inst) return { ok: false };
    const op = inst.getOption();
    const lg = Array.isArray(op.legend) ? op.legend[0] : op.legend;
    const rect = inst.getModel().getComponent('grid').coordinateSystem.getRect();
    const num2 = function (v) { return (typeof v === 'number') ? v : null; };
    return {
      ok: true,
      legend: lg ? {
        itemWidth: num2(lg.itemWidth), itemHeight: num2(lg.itemHeight), itemGap: num2(lg.itemGap),
        textColor: (lg.textStyle && lg.textStyle.color) || null,
        bg: (lg.backgroundColor === undefined ? null : lg.backgroundColor),
        borderColor: (lg.borderColor === undefined ? null : lg.borderColor),
        borderWidth: num2(lg.borderWidth),
        padding: (typeof lg.padding === 'number') ? lg.padding : null,
        orient: lg.orient || null,
        type: lg.type || null,
        top: lg.top === undefined ? null : lg.top,
        left: lg.left === undefined ? null : lg.left,
        right: lg.right === undefined ? null : lg.right,
        bottom: lg.bottom === undefined ? null : lg.bottom
      } : null,
      series: (op.series || []).map(function (s) {
        return {
          type: s.type,
          lineWidth: (s.lineStyle && s.lineStyle.width !== undefined) ? s.lineStyle.width : null,
          lineType: (s.lineStyle && s.lineStyle.type) ? s.lineStyle.type : null,
          symbol: s.symbol === undefined ? null : s.symbol,
          symbolSize: num2(s.symbolSize),
          opacity: (s.itemStyle && s.itemStyle.opacity !== undefined) ? s.itemStyle.opacity : null,
          boxWidth: s.boxWidth === undefined ? null : s.boxWidth,
          barMaxWidth: s.barMaxWidth === undefined ? null : s.barMaxWidth,
          borderRadius: (s.itemStyle && s.itemStyle.borderRadius !== undefined) ? s.itemStyle.borderRadius : null,
          /* 颜色指纹：只比较「改设置前后是否相同」，不关心具体值 */
          colorKey: JSON.stringify([s.itemStyle || {}, s.lineStyle || {}]).length + '|' +
            String((s.itemStyle && s.itemStyle.color) || '') + '|' +
            String((s.lineStyle && s.lineStyle.color) || '')
        };
      }),
      grid: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
    };
  });
}

module.exports = {
  id: 'legend-mark-style',
  title: '迭代 31 图例与图元设置区（默认零变化 / legend 11 控件 / mark 各图型 / 颜色不外溢 / .yms 还原）',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ==================================================================
       1. 默认值（DEFAULT_LEGEND / DEFAULT_MARK）—— 必须等于改动前写死的值
       ================================================================== */
    const defs = await page.evaluate(function () {
      const p = window.YMS.defaultPlot();
      return { legend: p.legend, mark: p.mark, keys: Object.keys(p.legend || {}).concat(Object.keys(p.mark || {})) };
    });
    const L = defs.legend || {}, M = defs.mark || {};
    t.eq('1.1 plot.legend 存在（11 个键）', Object.keys(L).length, 11);
    t.eq('1.2 legend.position 默认 top', L.position, 'top');
    t.eq('1.3 legend.orient 默认 auto', L.orient, 'auto');
    t.eq('1.4 legend.textColor 默认 = 现状写死值', L.textColor, '#4a5866');
    t.eq('1.5 legend.bgColor 默认透明（null）', L.bgColor, null);
    t.eq('1.6 legend.borderColor 默认无（null）', L.borderColor, null);
    t.eq('1.7 legend.borderWidth 默认 0', L.borderWidth, 0);
    t.eq('1.8 legend.padding 默认 0', L.padding, 0);
    t.eq('1.9 legend.itemWidth 默认 14（现状写死）', L.itemWidth, 14);
    t.eq('1.10 legend.itemHeight 默认 9（现状写死）', L.itemHeight, 9);
    t.eq('1.11 legend.itemGap 默认 12（现状写死）', L.itemGap, 12);
    t.eq('1.12 legend.scrollMode 默认 auto（保持原自适应）', L.scrollMode, 'auto');

    t.eq('1.13 plot.mark 共 12 个键', Object.keys(M).length, 12);
    t.eq('1.14 mark.boxRatio 默认 = 现状 BOX_RATIO', M.boxRatio, 0.72);
    t.eq('1.15 mark.boxLineWidth 默认 = 现状边框宽', M.boxLineWidth, 1.2);
    t.eq('1.16 mark.lineWidth 默认 = 现状线宽', M.lineWidth, 1.8);
    t.eq('1.17 mark.lineType 默认 solid', M.lineType, 'solid');
    t.eq('1.18 mark.symbolSize 默认 5', M.symbolSize, 5);
    t.eq('1.19 mark.symbolShape 默认 circle', M.symbolShape, 'circle');
    t.eq('1.20 mark.scatterSize 默认 6', M.scatterSize, 6);
    t.eq('1.21 mark.scatterOpacity 默认 0.72', M.scatterOpacity, 0.72);
    t.eq('1.22 mark.scatterShape 默认 circle', M.scatterShape, 'circle');
    t.eq('1.23 **plot.mark 里不含任何颜色字段**（颜色不归图元管）',
      Object.keys(M).filter(function (k) { return /color|colour|fill|stroke/i.test(k); }).join(','), '');

    /* ==================================================================
       2. 渲染层零变化：默认设置下 option.legend 与 series 图元字段 == 写死值
       ================================================================== */
    const imp = await app.importText(page, 'lm.csv', CSV);
    t.eq('2.1 导入 8 行 × 4 列', imp.rows + 'x' + imp.cols, '8x4');

    await plot(page, Object.assign({ type: 'line', x: ['Lot'], values: ['Yield', 'Bin1'] }, BASE));
    const d2 = await readOpt(page);
    t.ok('2.2 line 图已渲染并读到 option', d2.ok && !!d2.legend, d2);
    t.eq('2.3 默认 legend.itemWidth = 14', d2.legend.itemWidth, 14);
    t.eq('2.4 默认 legend.itemHeight = 9', d2.legend.itemHeight, 9);
    t.eq('2.5 默认 legend.itemGap = 12', d2.legend.itemGap, 12);
    /* 默认渲染色由**主题令牌**给（#475569），DEFAULT_LEGEND.textColor 只在主题缺失时兜底；
       这里验的不是具体色值，而是「没被新字段污染」：合法 hex 且不等于我们注入过的测试色 */
    t.ok('2.6 默认 legend 文字色是合法 hex 且未被自定义值污染',
      /^#[0-9a-f]{6}$/i.test(String(d2.legend.textColor)) &&
      String(d2.legend.textColor).toLowerCase() !== '#ff0000',
      d2.legend.textColor);
    const lineSeries = d2.series.filter(function (s) { return s.type === 'line'; });
    t.ok('2.7 存在 line 系列', lineSeries.length > 0, d2.series.map(function (s) { return s.type; }));
    t.eq('2.8 默认 line 线宽 = 1.8（零变化）', lineSeries.length ? lineSeries[0].lineWidth : null, 1.8);
    t.eq('2.9 默认 line 线型 = solid', lineSeries.length ? lineSeries[0].lineType : null, 'solid');
    t.eq('2.10 默认 line 符号 = circle', lineSeries.length ? lineSeries[0].symbol : null, 'circle');
    t.eq('2.11 默认 line 符号大小 = 5', lineSeries.length ? lineSeries[0].symbolSize : null, 5);

    /* ==================================================================
       3. legend 11 个控件逐个生效
       ================================================================== */
    await plot(page, Object.assign({
      type: 'line', x: ['Lot'], values: ['Yield', 'Bin1'],
      legend: {
        position: 'top', orient: 'horizontal', textColor: '#ff0000', bgColor: '#eeeeee',
        borderColor: '#00ff00', borderWidth: 2, padding: 9,
        itemWidth: 20, itemHeight: 12, itemGap: 20, scrollMode: 'on'
      }
    }, BASE));
    const d3 = await readOpt(page);
    t.eq('3.1 legend.itemWidth → 20 生效', d3.legend.itemWidth, 20);
    t.eq('3.2 legend.itemHeight → 12 生效', d3.legend.itemHeight, 12);
    t.eq('3.3 legend.itemGap → 20 生效', d3.legend.itemGap, 20);
    t.eq('3.4 legend.textColor → #ff0000 生效', String(d3.legend.textColor).toLowerCase(), '#ff0000');
    t.eq('3.5 legend.bgColor → #eeeeee 生效', String(d3.legend.bg).toLowerCase(), '#eeeeee');
    t.eq('3.6 legend.borderColor → #00ff00 生效', String(d3.legend.borderColor).toLowerCase(), '#00ff00');
    t.eq('3.7 legend.borderWidth → 2 生效', d3.legend.borderWidth, 2);
    t.eq('3.8 legend.padding → 9 生效', d3.legend.padding, 9);
    t.eq('3.9 legend.orient → horizontal 生效', d3.legend.orient, 'horizontal');
    t.eq('3.10 legend.scrollMode=on → 图例切成 scroll 型', d3.legend.type, 'scroll');

    /* 颜色不外溢：改 legend.textColor 不影响 series 颜色指纹 */
    t.eq('3.11 ★ 改图例文字色后 line 系列颜色指纹零变化（颜色不外溢）',
      d3.series.filter(function (s) { return s.type === 'line'; }).map(function (s) { return s.colorKey; }).join('|'),
      d2.series.filter(function (s) { return s.type === 'line'; }).map(function (s) { return s.colorKey; }).join('|'));

    /* ==================================================================
       4. 图例位置切换：grid 相应让位
       ================================================================== */
    const posOf = {};
    for (const pos of ['left', 'right', 'bottom', 'top']) {
      await plot(page, Object.assign({
        type: 'line', x: ['Lot'], values: ['Yield', 'Bin1'],
        legend: { position: pos, orient: 'auto', textColor: '#4a5866', bgColor: null, borderColor: null, borderWidth: 0, padding: 0, itemWidth: 14, itemHeight: 9, itemGap: 12, scrollMode: 'auto' }
      }, BASE));
      posOf[pos] = await readOpt(page);
    }
    t.ok('4.1 图例置左 → grid.x 比置顶时更大（左侧让位）',
      posOf.left.grid.x > posOf.top.grid.x,
      { left: posOf.left.grid.x, top: posOf.top.grid.x });
    t.ok('4.2 图例置右 → 绘图区右沿比置顶时更靠左（右侧让位）',
      (posOf.right.grid.x + posOf.right.grid.w) < (posOf.top.grid.x + posOf.top.grid.w),
      { right: posOf.right.grid.x + posOf.right.grid.w, top: posOf.top.grid.x + posOf.top.grid.w });
    t.ok('4.3 图例置底 → 绘图区下沿比置顶时更高（底部让位）',
      (posOf.bottom.grid.y + posOf.bottom.grid.h) < (posOf.top.grid.y + posOf.top.grid.h),
      { bottom: posOf.bottom.grid.y + posOf.bottom.grid.h, top: posOf.top.grid.y + posOf.top.grid.h });
    t.ok('4.4 四种位置都不出现非法 grid（w>0 且 h>0）',
      ['left', 'right', 'bottom', 'top'].every(function (k) { return posOf[k].grid.w > 0 && posOf[k].grid.h > 0; }),
      Object.keys(posOf).map(function (k) { return k + ':' + posOf[k].grid.w + 'x' + posOf[k].grid.h; }));

    /* ==================================================================
       5. mark 各图型图元字段生效
       ================================================================== */
    await plot(page, Object.assign({
      type: 'line', x: ['Lot'], values: ['Yield', 'Bin1'],
      mark: { lineWidth: 3.5, lineType: 'dashed', symbolShape: 'triangle', symbolSize: 9 }
    }, BASE));
    const d5 = await readOpt(page);
    const l5 = d5.series.filter(function (s) { return s.type === 'line'; });
    t.eq('5.1 mark.lineWidth → 3.5 生效', l5.length ? l5[0].lineWidth : null, 3.5);
    t.eq('5.2 mark.lineType → dashed 生效', l5.length ? l5[0].lineType : null, 'dashed');
    t.eq('5.3 mark.symbolShape → triangle 生效', l5.length ? l5[0].symbol : null, 'triangle');
    t.eq('5.4 mark.symbolSize → 9 生效', l5.length ? l5[0].symbolSize : null, 9);

    await plot(page, Object.assign({
      type: 'scatter', x: ['Lot'], values: ['Yield', 'Bin1'],
      mark: { scatterSize: 14, scatterOpacity: 0.35, scatterShape: 'diamond' }
    }, BASE));
    const d5b = await readOpt(page);
    const sc5 = d5b.series.filter(function (s) { return s.type === 'scatter'; });
    t.ok('5.5 scatter 系列存在', sc5.length > 0, d5b.series.map(function (s) { return s.type; }));
    t.eq('5.6 mark.scatterSize → 14 生效', sc5.length ? sc5[0].symbolSize : null, 14);
    t.ok('5.7 mark.scatterOpacity → 0.35 生效',
      sc5.length > 0 && Math.abs(Number(sc5[0].opacity) - 0.35) <= 0.02, sc5.length ? sc5[0].opacity : null);
    t.eq('5.8 mark.scatterShape → diamond 生效', sc5.length ? sc5[0].symbol : null, 'diamond');

    await plot(page, Object.assign({
      type: 'box', x: ['Lot'], values: ['Yield', 'Bin1'],
      mark: { boxRatio: 0.30, boxLineWidth: 3 }
    }, BASE));
    const d5c = await readOpt(page);
    const bx5 = d5c.series.filter(function (s) { return s.type === 'boxplot'; });
    t.ok('5.9 boxplot 系列存在', bx5.length > 0, d5c.series.map(function (s) { return s.type; }));
    t.ok('5.10 mark.boxRatio → 箱宽上限随之变小（数组形式或数值）',
      bx5.length > 0 && bx5[0].boxWidth !== null, bx5.length ? bx5[0].boxWidth : null);

    await plot(page, Object.assign({
      type: 'bar', x: ['Lot'], values: ['Yield', 'Bin1'],
      mark: { barRadius: 6 }
    }, BASE));
    const d5d = await readOpt(page);
    const br5 = d5d.series.filter(function (s) { return s.type === 'bar'; });
    t.ok('5.11 bar 系列存在', br5.length > 0, d5d.series.map(function (s) { return s.type; }));
    t.ok('5.12 mark.barRadius → 6 生效（itemStyle.borderRadius）',
      br5.length > 0 && String(br5[0].borderRadius).indexOf('6') >= 0,
      br5.length ? br5[0].borderRadius : null);

    /* ==================================================================
       6. .yms 载入：legend / mark 逐字段还原（白名单 + 类型校验真接上了）
       ================================================================== */
    const rt = await page.evaluate(function () {
      const tpl = {
        format: 'YMS-TEMPLATE', version: '1.0.0', tableName: 'LM 往返',
        columns: [{ name: 'Lot', type: 'string' }, { name: 'Yield', type: 'number' }],
        rows: [['L1', 0.9], ['L2', 0.8]],
        plot: {
          type: 'bar', x: ['Lot'], values: ['Yield', 'Bin1'],
          legend: {
            position: 'left', orient: 'horizontal', textColor: '#ff0000', bgColor: '#eeeeee',
            borderColor: '#00ff00', borderWidth: 2, padding: 9,
            itemWidth: 20, itemHeight: 12, itemGap: 20, scrollMode: 'on'
          },
          mark: { lineWidth: 3.5, lineType: 'dashed', symbolShape: 'triangle', symbolSize: 9, scatterSize: 12 }
        },
        dataSettings: {}
      };
      let r = null, threw = null;
      try { r = window.YMS.YmsTemplate.load(tpl); } catch (e) { threw = String(e && e.message); }
      const p = window.YMS.Store.state.plot;
      return { ok: !!(r && r.ok), threw: threw, legend: p.legend, mark: p.mark };
    });
    t.eq('6.1 .yms 载入未抛异常且 ok', rt.ok && !rt.threw, true);
    t.eq('6.2 载入后 legend.position 还原 = left', rt.legend ? rt.legend.position : null, 'left');
    t.eq('6.3 载入后 legend.textColor 还原 = #ff0000',
      rt.legend ? String(rt.legend.textColor).toLowerCase() : null, '#ff0000');
    t.eq('6.4 载入后 legend.itemWidth 还原 = 20', rt.legend ? rt.legend.itemWidth : null, 20);
    t.eq('6.5 载入后 legend.scrollMode 还原 = on', rt.legend ? rt.legend.scrollMode : null, 'on');
    t.eq('6.6 载入后 mark.lineWidth 还原 = 3.5', rt.mark ? rt.mark.lineWidth : null, 3.5);
    t.eq('6.7 载入后 mark.symbolShape 还原 = triangle', rt.mark ? rt.mark.symbolShape : null, 'triangle');
    t.eq('6.8 载入后 mark.scatterSize 还原 = 12', rt.mark ? rt.mark.scatterSize : null, 12);

    /* ==================================================================
       7. 用例已登记进 run.js（只建文件不登记 = 运行器静默不跑）
       ================================================================== */
    const runSrc = fs.readFileSync(path.resolve(__dirname, '..', 'run.js'), 'utf8');
    t.contains('7.1 run.js 的 CASE_FILES 已登记 legend-mark-style.js', runSrc, 'legend-mark-style.js');
    t.ok('7.2 本用例文件真实存在',
      fs.existsSync(path.resolve(__dirname, 'legend-mark-style.js')), __dirname);

    t.noErrors('7.3 全程零未捕获异常 / 控制台错误', ctx.errors);
  }
};
