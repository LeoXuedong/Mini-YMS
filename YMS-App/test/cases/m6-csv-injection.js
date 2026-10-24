/* ==========================================================================
   YMS · test/cases/m6-csv-injection.js
   断言对象：M-6 / S-1 CSV 公式注入防护（修复于 2026-10-21）
   命中代码：js/data/exporter.js → needsTextGuard / csvField
   判据（导出文本逐字段）：
     · 以 = @ 制表符 回车 开头              → 前置 '（文本化，Excel 不再求值）
     · 以 + - 开头但符号后是纯数字（-2 / -0.5 / +3 / -1e-3） → 不转义（合法数值）
     · 以 + - 开头且像公式（-2+3 / -cmd|…）  → 前置 '
     · 含 , " 换行的字段                      → 仍按 RFC4180 用双引号包裹、内部 " 写成 ""
   同时验证「往返」：用 RFC4180 解析器把导出文本读回来，行数 / 字段值必须与源一致
   —— 只查字面量会漏掉「多行字段被拆成两行」这类破坏。
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

/* raw = 原始字段值；guard = 期望导出时带前导 ' */
const ROWS = [
  { id: 'eq', raw: '=1+1', guard: true },
  { id: 'at', raw: '@SUM(A1)', guard: true },
  { id: 'dde', raw: "=cmd|' /C calc'!A0", guard: true },
  { id: 'neg_int', raw: '-2', guard: false },
  { id: 'neg_dec', raw: '-0.5', guard: false },
  { id: 'pos_int', raw: '+3', guard: false },
  { id: 'neg_expr', raw: '-2+3', guard: true },
  { id: 'comma', raw: 'a,b', guard: false },
  { id: 'quote', raw: 'say "hi"', guard: false },
  { id: 'newline', raw: 'x\ny', guard: false }
];

/** RFC4180 字段引用（仅在该加引号时加） */
function csvQuote(s) {
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 期望导出后的字段文本（加 ' 之后再做 RFC4180 转义） */
function expectField(row) {
  const v = row.guard ? "'" + row.raw : row.raw;
  return v;
}

module.exports = {
  id: 'm6-csv-injection',
  title: 'M-6 CSV 公式注入防护（= @ DDE 文本化；-2 / +3 等合法数值放行；RFC4180 不回归）',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ---- 1) 构造含全部危险形态的一列表格并导入 ---- */
    const src = ['Val'].concat(ROWS.map(function (r) { return csvQuote(r.raw); })).join('\n') + '\n';
    const imp = await app.importText(page, 'inject.csv', src);
    if (!t.ok('导入 1 列 ' + ROWS.length + ' 行', imp.ok && imp.rows === ROWS.length && imp.cols === 1, imp)) return;
    t.eq('导入后 Val 为字符列（文本原样保留，不被数值化）', (imp.columns[0] || {}).type, 'string');

    /* 导入侧不能已经改写原值（否则导出断言会「假红」） */
    const raws = await page.evaluate(function (names) {
      return names.map(function (n) { return window.__YMS__.rawCell(n, 'Val'); });
    }, ROWS.map(function (_, i) { return i; }));
    let importIntact = true;
    const importDiff = [];
    ROWS.forEach(function (r, i) {
      if (raws[i] !== r.raw) { importIntact = false; importDiff.push({ row: r.id, expected: r.raw, actual: raws[i] }); }
    });
    t.ok('导入后每个字段原值逐字保留', importIntact, importDiff);

    /* ---- 2) 导出 CSV 文本 ---- */
    const text = await app.exportCsv(page, {});
    t.ok('导出 CSV 非空', typeof text === 'string' && text.length > 0, { len: text && text.length });

    /* ---- 3) 逐字段判「是否加前导 '」 ---- */
    const rows = app.parseCsv(text);
    t.eq('导出行数 = 表头 1 + 数据 ' + ROWS.length + '（多行字段未被拆行）', rows.length, ROWS.length + 1);
    t.eq('表头为 # / Val', (rows[0] || []).join('|'), '#|Val');

    ROWS.forEach(function (r, i) {
      const line = rows[i + 1] || [];
      const got = line[1];
      if (r.guard) {
        t.eq('[' + r.id + '] ' + JSON.stringify(r.raw) + ' → 以 \' 开头', got, "'" + r.raw);
      } else {
        t.eq('[' + r.id + '] ' + JSON.stringify(r.raw) + ' → 不加 \'（合法值放行）', got, r.raw);
        t.ok('[' + r.id + '] 首字符不是 \'', !(typeof got === 'string' && got.charAt(0) === "'"), { actual: got });
      }
    });

    /* ---- 4) RFC4180 结构断言（在原始文本上查，避免解析器把问题掩盖） ---- */
    t.ok('含逗号字段带双引号包裹：\\"a,b\\"', text.indexOf('"a,b"') >= 0, { actual: text });
    t.ok('内部双引号写成两个：\\"say \\"\\"hi\\"\\"\\"', text.indexOf('"say ""hi"""') >= 0, { actual: text });
    t.ok('含换行字段整体被引号包裹："x\\ny"', text.indexOf('"x\ny"') >= 0, { actual: text });
    t.ok('行分隔符为 CRLF（RFC4180）', text.indexOf('\r\n') > 0, { actual: text.slice(0, 40) });

    /* ---- 5) 数值列不写前导 ' 的补充对照（-2 在数值列里也是合法值） ---- */
    const imp2 = await app.importText(page, 'nums.csv', 'V\n-2\n-0.5\n+3\n');
    t.ok('补充：纯数值列（-2 / -0.5 / +3）导入为数值列', imp2.ok && (imp2.columns[0] || {}).type === 'number', imp2.columns);
    const text2 = await app.exportCsv(page, {});
    const rows2 = app.parseCsv(text2);
    const nums = rows2.slice(1).map(function (l) { return l[1]; }).join(',');
    t.eq('补充：数值列导出 -2 / -0.5 / 3（无前导单引号）', nums, '-2,-0.5,3');

    t.noErrors('全程无未捕获异常 / console error', ctx.errors);
  }
};
