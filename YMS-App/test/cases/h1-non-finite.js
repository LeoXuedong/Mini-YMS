/* ==========================================================================
   YMS · test/cases/h1-non-finite.js
   断言对象：H-1 非有限值统一按缺失处理（修复于 2026-10-21）
   命中代码：js/core/types.js → YMS.num.isMissing（!isFinite 而不是 v !== v）
             js/table/column-ops.js → computeSeries 的 nonFinite 计数与缺失兜底
             js/core/dataframe.js → stats() 走 isMissing
             js/data/exporte r.js → 缺失写空单元格（不得写出 t:'e' / #DIV/0!）
   反例保护：正常表达式 Val * 2 的 valid / 统计值必须与手算一致，
             证明修复没有把「正常数值」也判成缺失。
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

/* 三条表达式：除以零 / 对数零 / 指数溢出 —— 结果分别是 +∞ / -∞ / +∞ */
const EXPRS = [
  { col: 'c_div', expr: '1/0', label: '1/0' },
  { col: 'c_log', expr: 'log(0)', label: 'log(0)' },
  { col: 'c_exp', expr: 'exp(1000)', label: 'exp(1000)' }
];

module.exports = {
  id: 'h1-non-finite',
  title: 'H-1 非有限值（1/0 / log(0) / exp(1000)）按缺失处理，Excel 不写 #DIV/0!',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ---- 前置：3 行干净数据（Val = 1,2,3） ---- */
    const imp = await app.importText(page, 'h1.csv', 'Name,Val\nA,1\nB,2\nC,3\n');
    if (!t.ok('导入 3 行 × 2 列', imp.ok && imp.rows === 3 && imp.cols === 2, imp)) return;

    /* ---- 逐条表达式断言 ---- */
    for (const c of EXPRS) {
      const r = await app.computeColumn(page, c.col, c.expr);
      t.ok('[' + c.label + '] 计算列创建成功', r.ok, r);
      t.eq('[' + c.label + '] missing 计数 = 3 行', r.missing, 3);
      t.eq('[' + c.label + '] nonFinite 计数 = 3 行', r.nonFinite, 3);
      t.contains('[' + c.label + '] 处理说明报出「非有限值」', r.note, '非有限值');

      const st = await app.columnStats(page, c.col);
      if (t.ok('[' + c.label + '] 列统计可读', !!st, st) && st) {
        t.eq('[' + c.label + '] 统计 valid = 0', st.valid, 0);
        t.eq('[' + c.label + '] 统计 missing = 3', st.missing, 3);
        t.isNull('[' + c.label + '] 统计 min = null', st.min);
        t.isNull('[' + c.label + '] 统计 max = null', st.max);
        t.isNull('[' + c.label + '] 统计 mean = null', st.mean);
        t.isNull('[' + c.label + '] 统计 stddev = null', st.stddev);
        t.finiteOrNull('[' + c.label + '] 统计四个量均非 NaN / ±Infinity', st.max);
      }

      const xs = await app.xlsxColumn(page, c.col);
      if (t.ok('[' + c.label + '] XLSX 读回成功', xs.ok, xs)) {
        const cells = xs.cells || [];
        const errCells = cells.filter(function (x) {
          return x && (x.t === 'e' || (typeof x.w === 'string' && x.w.indexOf('#') >= 0) ||
            (typeof x.v === 'string' && x.v.indexOf('#') >= 0));
        });
        t.eq('[' + c.label + '] XLSX 该列无错误单元格（t:"e" / #DIV/0!）', errCells.length, 0);
        const nonEmpty = cells.filter(function (x) { return x && x.v !== null && x.v !== undefined; });
        t.eq('[' + c.label + '] XLSX 该列 3 行均为空（缺失不写值）', nonEmpty.length, 0);
      }
    }

    /* ---- 反例保护：正常数值不得被判成缺失 ---- */
    const okc = await app.computeColumn(page, 'c_double', 'Val * 2');
    t.ok('反例 Val * 2 创建成功', okc.ok, okc);
    t.eq('反例 missing = 0（正常值不被判缺失）', okc.missing, 0);
    t.eq('反例 nonFinite = 0', okc.nonFinite, 0);

    const stc = await app.columnStats(page, 'c_double');
    if (t.ok('反例 列统计可读', !!stc, stc) && stc) {
      t.eq('反例 valid = 3', stc.valid, 3);
      t.eq('反例 missing = 0', stc.missing, 0);
      t.eq('反例 min = 2', stc.min, 2);
      t.eq('反例 max = 6', stc.max, 6);
      t.eq('反例 mean = 4', stc.mean, 4);
      t.near('反例 stddev = 1.632993（总体标准差）', stc.stddev, Math.sqrt(8 / 3), 1e-9);
    }

    const xd = await app.xlsxColumn(page, 'c_double');
    if (t.ok('反例 XLSX 读回成功', xd.ok, xd)) {
      const cells = xd.cells || [];
      t.eq('反例 XLSX 3 行都是数值单元格', cells.filter(function (x) { return x && x.t === 'n'; }).length, 3);
      t.eq('反例 XLSX 值为 2 / 4 / 6', cells.map(function (x) { return x && x.v; }).join(','), '2,4,6');
    }

    /* ---- 全程不得有未捕获异常 / console error ---- */
    t.noErrors('全程无未捕获异常 / console error', ctx.errors);
  }
};
