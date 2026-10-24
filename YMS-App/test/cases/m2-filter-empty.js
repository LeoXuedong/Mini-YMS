/* ==========================================================================
   YMS · test/cases/m2-filter-empty.js
   断言对象：M-2 条件筛选「未填值」不参与过滤（修复于 2026-10-21）
   命中代码：js/core/store.js → isFilterActive / matchesFilters
             js/table/data-settings.js → filterPending / setHint / summary
   现象复现路径（全部走真实 UI）：点「+」新增一条条件 → 选列选运算符 → 值留空
     · 修复前：parseNumber('') = NaN、任何比较对 NaN 恒假 → 整表消失（view.count = 0）
     · 修复后：条件不参与过滤（view.count 不变），行内显示「未填值 · 不生效」，
               面板摘要写「筛选 0 条（1 条未填值，不生效）」
   同时验证：填上值立即生效；「缺失 / 非缺失」类操作符在值为空时仍然生效
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

/* 4 行：其中 D 行 Yield 为空 —— 用来验证「缺失 / 非缺失」在空值时仍生效 */
const CSV = 'Lot,Yield\nA,95\nB,80\nC,60\nD,\n';

module.exports = {
  id: 'm2-filter-empty',
  title: 'M-2 筛选条件未填值时不参与过滤（表格不被筛成 0 行）+ 面板提示',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ---- 前置 ---- */
    const imp = await app.importText(page, 'f4.csv', CSV);
    if (!t.ok('导入 4 行 × 2 列（D 行 Yield 为空）', imp.ok && imp.rows === 4 && imp.cols === 2, imp)) return;
    const st0 = await app.getState(page);
    t.eq('导入后视图 = 4 行', st0.viewCount, 4);
    t.eq('Yield 列缺失计数 = 1', (st0.columns[1] || {}).missing, 1);

    /* ---- 打开数据设置区（默认收起），点「+」新增条件并留空值 ---- */
    const panel = await app.ensurePanelOpen(page);
    t.ok('数据设置区已展开', !panel.collapsed && panel.bodyVisible, panel);

    const added = await app.addFilterRow(page, { col: 'Yield', op: '>' });
    t.ok('点「+」→ 内联选择行 → 确定，新增 1 条筛选条件', added.ok && added.rows === 1, added);
    t.eq('新条件位于第 1 行', added.index, 0);

    const row1 = await app.readFilterRow(page, 0);
    if (t.ok('读到筛选行状态', !!row1, row1) && row1) {
      t.eq('行内提示文案 = 未填值 · 不生效', row1.hintText, '未填值 · 不生效');
      t.ok('提示可见（未 hidden）', row1.hintVisible && row1.hintHidden === false, row1);
      t.eq('行标记 data-pending = 1', row1.pending, '1');
      t.eq('提示 title 说明不参与过滤', row1.hintTitle, '该条件未填值，暂不参与过滤');
    }

    /* ---- 核心回归：表格不得消失 ---- */
    const s1 = await app.getState(page);
    t.eq('未提交时视图 = 4 行（该条件此刻仅在草稿里）', s1.viewCount, 4);
    t.eq('原始行数不受影响 = 4', s1.rowCount, 4);

    /* ---- 面板摘要（SUBMIT → 处理说明 + toast） ---- */
    await app.submitSettings(page);
    const notes1 = await app.notes(page, 3);
    const sumNote = notes1.filter(function (n) { return String(n).indexOf('数据设置：') === 0; }).pop() || '';
    t.contains('处理说明含「筛选 0 条」', sumNote, '筛选 0 条');
    t.contains('处理说明含「1 条未填值，不生效」', sumNote, '1 条未填值，不生效');

    const toastText = await page.evaluate(function () {
      const nodes = document.querySelectorAll('#toast-root .toast');
      return Array.prototype.map.call(nodes, function (n) { return String(n.textContent).trim(); }).join(' || ');
    });
    t.contains('toast 摘要同样报「未填值，不生效」', toastText, '未填值，不生效');

    const s1b = await app.getState(page);
    t.eq('SUBMIT 后视图仍为 4 行（修复前此处为 0：整表消失）', s1b.viewCount, 4);

    /* ---- 填上值 90 → 立即收敛（95 > 90 只有 1 行） ---- */
    const set2 = await app.setFilterRow(page, 0, { value: '90' });
    t.ok('填值 90', set2.ok, set2);
    const row2 = await app.readFilterRow(page, 0);
    t.ok('填值后提示消失', row2 && (row2.hintVisible === false || row2.hintHidden === true), row2);
    await app.submitSettings(page);
    const s2 = await app.getState(page);
    t.eq('Yield > 90 → 视图 1 行', s2.viewCount, 1);

    /* ---- 缺失 / 非缺失：值为空时仍生效 ---- */
    const set3 = await app.setFilterRow(page, 0, { op: '缺失' });
    t.ok('切到「缺失」运算符', set3.ok && set3.applied.op === '缺失', set3);
    const row3 = await app.readFilterRow(page, 0);
    t.ok('「缺失」不需要填值 → 不显示未填值提示', row3 && (row3.hintVisible === false || row3.hintHidden === true), row3);
    await app.submitSettings(page);
    const s3 = await app.getState(page);
    t.eq('Yield 缺失 → 视图 1 行', s3.viewCount, 1);

    const set4 = await app.setFilterRow(page, 0, { op: '非缺失' });
    t.ok('切到「非缺失」运算符', set4.ok && set4.applied.op === '非缺失', set4);
    await app.submitSettings(page);
    const s4 = await app.getState(page);
    t.eq('Yield 非缺失 → 视图 3 行', s4.viewCount, 3);

    /* ---- 区间（需要一个值2）：只填一个值同样不生效 ---- */
    const set5 = await app.setFilterRow(page, 0, { op: '区间', value: '70', value2: '' });
    t.ok('切到「区间」并只填值1', set5.ok, set5);
    const row5 = await app.readFilterRow(page, 0);
    t.eq('区间缺值2 → 仍标「未填值 · 不生效」', row5 && row5.hintText, '未填值 · 不生效');
    await app.submitSettings(page);
    const s5 = await app.getState(page);
    t.eq('区间缺值2 → 视图回到 4 行', s5.viewCount, 4);

    const set6 = await app.setFilterRow(page, 0, { value2: '90' });
    t.ok('补上值2 = 90', set6.ok, set6);
    await app.submitSettings(page);
    const s6 = await app.getState(page);
    t.eq('Yield ∈ [70, 90] → 视图 1 行（只有 80 落在区间）', s6.viewCount, 1);

    /* ---- 清空条件 ---- */
    const cleared = await app.setFilters(page, []);
    t.eq('清空全部条件 → 视图 4 行', cleared, 4);

    t.noErrors('全程无未捕获异常 / console error', ctx.errors);
  }
};
