/* ==========================================================================
   YMS · test/cases/value-numeric-only.js
   断言对象：绘图设置区 **Value 下拉默认只列数值型列**（迭代 29）
   命中代码：js/plot/plot-settings.js（numericColOptions + mkDropSelect 的 options 参数）
   目标语义：
     1) Value 下拉的选项**全部**是 type='number' 的列
     2) 字符串列（Lot / Tool / Note）与时间列（StartTime）不出现在 Value 下拉里
     3) 数值列（Yield / Vth / Idsat / Bin1）全部出现，数量 = 数值列总数
     4) **对照组**：X Label 下拉仍然列出全部列（本次改动不外溢到其它参数字段）
     5) 当前已选的 Value 仍以 chip 显示（不会因为过滤而丢选择）
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

const CSV = [
  'Lot,Tool,StartTime,Note,Yield,Vth,Idsat,Bin1',
  'L0001,T01,2026-09-30 07:43:50,ok,92.25,0.5108,1.321,90.47',
  'L0002,T01,2026-09-30 08:43:50,ok,91.80,0.5102,1.318,90.11',
  'L0003,T02,2026-09-30 09:43:50,ng,93.10,0.5111,1.325,91.02',
  'L0004,T02,2026-09-30 10:43:50,ok,90.44,0.5095,1.312,89.88',
  'L0005,T03,2026-09-30 11:43:50,ok,94.02,0.5120,1.330,91.55',
  'L0006,T03,2026-09-30 12:43:50,ok,92.77,0.5105,1.320,90.66'
].join('\n');

/** 打开某个参数下拉并读出它的全部选项值 */
async function openAndReadOptions(page, id) {
  await page.evaluate(function (sel) {
    const root = document.getElementById(sel);
    const trig = root ? root.querySelector('.drop-trigger') : null;
    if (trig) trig.click();
  }, id);
  await page.waitForTimeout(160);
  const opts = await page.evaluate(function () {
    const panel = document.querySelector('body > .drop-panel, body > div.drop-opts');
    const box = panel || document.querySelector('.drop-opts');
    if (!box) return null;
    return Array.prototype.slice.call(box.querySelectorAll('.drop-opt'))
      .map(function (n) { return n.getAttribute('data-value'); });
  });
  /* 收起（同一触发器再点一次） */
  await page.evaluate(function (sel) {
    const root = document.getElementById(sel);
    const trig = root ? root.querySelector('.drop-trigger') : null;
    if (trig) trig.click();
  }, id);
  await page.waitForTimeout(120);
  return opts;
}

module.exports = {
  id: 'value-numeric-only',
  title: '绘图设置 · Value 下拉默认只列数值型列',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    const imp = await app.importText(page, 'value_num.csv', CSV);
    t.eq('1.1 导入 6 行 × 8 列', imp.rows + 'x' + imp.cols, '6x8');

    const types = await page.evaluate(function () {
      return window.YMS.Store.colNames().map(function (n) {
        return { n: n, t: window.YMS.Store.colType(n) };
      });
    });
    const byType = {};
    types.forEach(function (x) { (byType[x.t] = byType[x.t] || []).push(x.n); });
    t.eq('1.2 Yield 被推断为数值列',
      (types.filter(function (x) { return x.n === 'Yield'; })[0] || {}).t, 'number');
    t.eq('1.3 Lot 被推断为字符串列',
      (types.filter(function (x) { return x.n === 'Lot'; })[0] || {}).t, 'string');
    t.ok('1.4 存在时间列（StartTime）', (byType.time || []).indexOf('StartTime') >= 0, byType.time);
    t.ok('1.5 数值列至少 4 个', (byType.number || []).length >= 4, byType.number);

    await page.evaluate(function () {
      window.__YMS__.setMode('plot');
      window.__YMS__.applyPlot({
        type: 'box', x: ['Lot'], values: ['Yield'], sorters: [], splitBy: [], pageBy: [], display: 'facet'
      });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(900);

    const exists = await page.evaluate(function () { return !!document.getElementById('ps-value-list'); });
    t.eq('2.1 设置区存在 Value 下拉（#ps-value-list）', exists, true);

    const vOpts = await openAndReadOptions(page, 'ps-value-list');
    t.ok('2.2 能读出 Value 下拉的选项', Array.isArray(vOpts) && vOpts.length > 0, vOpts);
    const numCols = byType.number || [];
    t.eq('2.3 Value 选项数量 = 数值列数量', (vOpts || []).length, numCols.length);
    t.eq('2.4 Value 选项集合与数值列完全一致',
      (vOpts || []).slice().sort().join(','), numCols.slice().sort().join(','));

    const vTypes = await page.evaluate(function (vals) {
      return vals.map(function (v) { return window.YMS.Store.colType(v); });
    }, vOpts || []);
    t.eq('2.5 Value 选项全部是 number 类型（无一个非数值）',
      vTypes.filter(function (x) { return x !== 'number'; }).join(','), '');

    t.eq('2.6 字符串列 Lot 不在 Value 里', (vOpts || []).indexOf('Lot'), -1);
    t.eq('2.7 字符串列 Tool 不在 Value 里', (vOpts || []).indexOf('Tool'), -1);
    t.eq('2.8 文本列 Note 不在 Value 里', (vOpts || []).indexOf('Note'), -1);
    t.eq('2.9 时间列 StartTime 不在 Value 里', (vOpts || []).indexOf('StartTime'), -1);

    /* 对照组：X Label 仍列全部列（改动不外溢） */
    const xOpts = await openAndReadOptions(page, 'ps-x-list');
    t.ok('3.1 X Label 下拉仍能读出选项', Array.isArray(xOpts) && xOpts.length > 0, xOpts);
    t.eq('3.2 X Label 选项数量 = 全部列数（未被过滤）', (xOpts || []).length, types.length);
    t.ok('3.3 X Label 里仍有字符串列 Lot', (xOpts || []).indexOf('Lot') >= 0, xOpts);
    t.ok('3.4 X Label 里仍有时间列 StartTime', (xOpts || []).indexOf('StartTime') >= 0, xOpts);

    /* 已选 Value 仍以 chip 显示（过滤不丢选择） */
    const chip = await page.evaluate(function () {
      const tag = document.querySelector('#ps-value-list .drop-tag');
      return tag ? tag.getAttribute('data-value') : null;
    });
    t.eq('4.1 已选 Yield 仍以 chip 显示', chip, 'Yield');

    /* ==================================================================
       5. 「Value 显示全部列」开关：默认关（只数值列）→ 勾上放开全列 → 取消再收回
       ================================================================== */
    const chkExists = await page.evaluate(function () { return !!document.getElementById('ps-value-all'); });
    t.eq('5.1 存在「Value 显示全部列」开关（#ps-value-all）', chkExists, true);
    const chkDefault = await page.evaluate(function () {
      const n = document.getElementById('ps-value-all');
      return n ? !!n.checked : null;
    });
    t.eq('5.2 开关默认关闭（默认仍只列数值列）', chkDefault, false);

    await page.click('#ps-value-all');
    await page.waitForTimeout(300);
    const vOptsAll = await openAndReadOptions(page, 'ps-value-list');
    t.eq('5.3 勾选后 Value 选项数量 = 全部列数', (vOptsAll || []).length, types.length);
    t.ok('5.4 勾选后 Value 里出现字符串列 Lot', (vOptsAll || []).indexOf('Lot') >= 0, vOptsAll);
    t.ok('5.5 勾选后 Value 里出现时间列 StartTime', (vOptsAll || []).indexOf('StartTime') >= 0, vOptsAll);

    await page.click('#ps-value-all');
    await page.waitForTimeout(300);
    const vOptsBack = await openAndReadOptions(page, 'ps-value-list');
    t.eq('5.6 取消勾选后 Value 恢复到数值列数量', (vOptsBack || []).length, numCols.length);
    t.eq('5.7 取消勾选后 Lot 再次不可选', (vOptsBack || []).indexOf('Lot'), -1);
    const chkAfter = await page.evaluate(function () {
      const n = document.getElementById('ps-value-all');
      return n ? !!n.checked : null;
    });
    t.eq('5.8 开关状态可往返（回到未勾选）', chkAfter, false);

    t.noErrors('5.9 全程零未捕获异常 / 控制台错误', ctx.errors);
  }
};
