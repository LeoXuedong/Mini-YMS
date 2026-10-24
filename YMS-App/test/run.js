#!/usr/bin/env node
/* ==========================================================================
   YMS · test/run.js —— 自动化测试入口
   用法：
     node test/run.js                      跑全部正式用例（失败退出码 1）
     node test/run.js --app=<index.html>   指向另一份应用副本（如 pre_fix_app）
     node test/run.js --only=h1,m2         只跑指定用例（按 id 前缀匹配）
     node test/run.js --include-todo       额外实测 todo 项（信息性质，不计退出码）
   设计原则：
     · 一条命令跑完，末行必出 `PASS a / b` 或 `FAIL a / b` 汇总行（可被 grep）
     · 每条断言打在真实数值上（列统计 / 导出字节 / 视图行数 / DOM 文案），
       不写「没报错即通过」这类空断言
     · 每个用例独立 page（独立内存状态），互不污染
   ========================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const { launch, openApp } = require('./helpers/launch');

const HERE = __dirname;
const DEFAULT_INDEX = path.resolve(HERE, '..', 'index.html');
const CASE_DIR = path.join(HERE, 'cases');

/* 正式用例（顺序 = 优先级：H-1 最高价值） */
const CASE_FILES = [
  'h1-non-finite.js',
  'm6-csv-injection.js',
  'm2-filter-empty.js',
  'm1-numeric-text.js',
  'm3-empty-import.js',
  'm4-duplicate-columns.js',
  's2-yms-schema.js',
  'group-mapping.js',
  'group-axis-labels.js',
  'group-axis-multilevel.js',
  /* 第六轮：轴层统计行通道（plot.table.show=false + stats.show=true）纵向次序
     = 统计行在最上 → 分组带 → 轴标签（用户实际使用的通道） */
  'stats-block-order.js',
  'value-numeric-only.js',
  'legend-mark-style.js',
  'palette-auto.js',
  /* 任务 E：全屏缩放的三处几何（箱体按 extent 过滤 / grid.left 紧算+行名列右沿 / 轴标题不压参数行） */
  'fullscreen-zoom-geom.js',
  /* 任务 G：全屏缩放后逐列对齐（列数=可见类数 / 无空列 / 对齐 box / 列宽=带宽 / 无重叠 / 数值正确）
     + 横轴分组合并在 box/line/bar/scatter/hist 五图型上的横向一致（hist 给可见说明） */
  'zoom-table-align.js',
  /* 任务 H：box 与横轴数据列的横向对位（每类全部箱体包围盒中心 = 该列 cx）+ tooltip 无数据系列不列出 */
  'box-column-align.js',
  /* 任务 I：设置区瘦身（I1 参考数行删除 / I2 分组配色改下拉框 / I3 merge-on 说明行删除，hist 说明保留） */
  'settings-ui-slim.js'
];
const TODO_FILE = 'todo-pending.js';

/* ------------------------------------------------------------ 参数 / 输出 */

function parseArgs(argv) {
  const out = { app: DEFAULT_INDEX, only: null, includeTodo: false, help: false };
  argv.slice(2).forEach(function (a) {
    if (a === '--include-todo') out.includeTodo = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.indexOf('--app=') === 0) out.app = a.slice(6).replace(/^"|"$/g, '');
    else if (a.indexOf('--only=') === 0) {
      out.only = a.slice(7).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    } else {
      console.error('[warn] 未知参数被忽略：' + a);
    }
  });
  return out;
}

function show(v) {
  if (typeof v === 'number' && !isFinite(v)) return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function makeAsserter(results) {
  function push(ok, label, detail) {
    results.push({ ok: !!ok, label: label, detail: ok ? null : (detail || null) });
    return !!ok;
  }
  return {
    ok: function (label, cond, detail) { return push(cond, label, detail); },
    eq: function (label, actual, expected) {
      return push(actual === expected, label, { actual: actual, expected: expected });
    },
    ne: function (label, actual, unexpected) {
      return push(actual !== unexpected, label, { actual: actual, unexpected: unexpected });
    },
    near: function (label, actual, expected, tol) {
      var ok = (typeof actual === 'number') && Math.abs(actual - expected) <= (tol === undefined ? 1e-9 : tol);
      return push(ok, label, { actual: actual, expected: expected, tol: tol === undefined ? 1e-9 : tol });
    },
    isNull: function (label, v) { return push(v === null, label, { actual: v, expected: null }); },
    finiteOrNull: function (label, v) {
      var ok = (v === null) || (typeof v === 'number' && isFinite(v));
      return push(ok, label, { actual: v, expected: 'null 或有限数（不得 NaN / ±Infinity）' });
    },
    contains: function (label, hay, needle) {
      var ok = typeof hay === 'string' && hay.indexOf(needle) >= 0;
      return push(ok, label, { actual: hay, expectedContains: needle });
    },
    noErrors: function (label, errors) {
      return push(!errors || errors.length === 0, label, { errors: errors });
    }
  };
}

/* ---------------------------------------------------------------- 主流程 */

(async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node test/run.js [--app=<index.html>] [--only=<id,id>] [--include-todo]');
    return;
  }

  const indexPath = path.resolve(args.app);
  if (!fs.existsSync(indexPath)) {
    console.error('找不到应用入口：' + indexPath + '\n（--app 要指向 index.html 文件）');
    process.exit(2);
  }

  let files = CASE_FILES;
  if (args.only && args.only.length) {
    files = files.filter(function (f) {
      return args.only.some(function (k) { return f.indexOf(k) >= 0; });
    });
    if (!files.length) {
      console.error('--only 没有匹配到任何用例：' + args.only.join(',') + '（可用：' + CASE_FILES.join(' / ') + '）');
      process.exit(2);
    }
  }

  /* CI / 精简运行：某些用例依赖不进仓库的大数据集（如 10 万行样本），
     用环境变量 YMS_SKIP_CASES 跳过（逗号分隔，按文件名子串匹配），并在日志里明说跳过了哪些，
     避免「17/17 通过」被误读成「全部覆盖」。 */
  const skipSpec = String(process.env.YMS_SKIP_CASES || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  let skippedFiles = [];
  if (skipSpec.length) {
    const hit = function (f) { return skipSpec.some(function (k) { return f.indexOf(k) >= 0; }); };
    skippedFiles = files.filter(hit);
    files = files.filter(function (f) { return !hit(f); });
    if (!files.length) {
      console.error('YMS_SKIP_CASES 把全部用例都跳过了：' + skipSpec.join(','));
      process.exit(2);
    }
  }

  const t0 = Date.now();
  console.log('YMS 自动化测试 · run.js');
  console.log('应用：' + indexPath);
  console.log('用例：' + files.join(' / '));
  if (skippedFiles.length) {
    console.log('已跳过（YMS_SKIP_CASES）：' + skippedFiles.join(' / ') +
      ' —— 需要本地大样本数据，仓库未随附');
  }

  let env;
  try {
    env = await launch({ headless: true });
  } catch (e) {
    console.error('\n[启动失败] ' + e.message);
    process.exit(2);
  }
  console.log('Playwright：' + env.pwFrom);
  console.log('Chromium：' + (env.exe || '（Playwright 默认解析）'));
  console.log('');

  const cases = files.map(function (f) { return require(path.join(CASE_DIR, f)); });

  const allResults = [];
  const caseSummary = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const results = [];
    const t = makeAsserter(results);
    const cStart = Date.now();
    console.log('── [' + (i + 1) + '/' + cases.length + '] ' + c.title + '  (' + c.id + ')');

    let app = null;
    let crash = null;
    try {
      app = await openApp(env.browser, indexPath);
      await c.run({ page: app.page, app: app, t: t, errors: app.errors, require: require });
    } catch (e) {
      crash = e && e.stack ? e.stack : String(e);
    } finally {
      if (app && app.page) { try { await app.page.close(); } catch (e2) {} }
    }

    results.forEach(function (r) {
      if (r.ok) {
        console.log('   ✓ ' + r.label);
      } else {
        console.log('   ✗ ' + r.label);
        if (r.detail && r.detail.actual !== undefined) console.log('        实际: ' + show(r.detail.actual));
        if (r.detail && r.detail.expected !== undefined) console.log('        期望: ' + show(r.detail.expected));
        if (r.detail && r.detail.expectedContains !== undefined) console.log('        期望包含: ' + show(r.detail.expectedContains));
        if (r.detail && r.detail.errors !== undefined) console.log('        错误: ' + show(r.detail.errors));
        if (!r.detail) console.log('        （无附加信息）');
      }
    });
    if (crash) console.log('   ✗ 用例抛异常\n' + crash.split('\n').slice(0, 8).map(function (l) { return '        ' + l; }).join('\n'));

    const passed = results.filter(function (r) { return r.ok; }).length;
    const failed = results.length - passed + (crash ? 1 : 0);
    console.log('   → ' + (failed ? 'FAIL' : 'PASS') + ' ' + passed + ' / ' + results.length + ' 断言' +
      (crash ? ' + 1 异常' : '') + ' · ' + (Date.now() - cStart) + 'ms');
    console.log('');

    allResults.push.apply(allResults, results);
    caseSummary.push({ id: c.id, title: c.title, passed: passed, total: results.length, failed: failed, crash: !!crash });
  }

  /* ------------------------------------------------------------- todo 清单 */
  let todoItems = [];
  try { todoItems = require(path.join(CASE_DIR, TODO_FILE)).items || []; } catch (e) { todoItems = []; }

  if (todoItems.length) {
    console.log('── todo（未修的已知问题，默认跳过，不计退出码）');
    for (const it of todoItems) {
      if (args.includeTodo && typeof it.probe === 'function') {
        let app2 = null;
        let observed = null;
        try {
          app2 = await openApp(env.browser, indexPath);
          observed = await it.probe({ page: app2.page, app: app2, require: require });
        } catch (e) {
          observed = { error: String(e && e.message) };
        } finally {
          if (app2 && app2.page) { try { await app2.page.close(); } catch (e2) {} }
        }
        console.log('   · ' + it.id + ' ' + it.title);
        console.log('     期望: ' + it.expected);
        console.log('     实测: ' + show(observed));
      } else {
        console.log('   · ' + it.id + ' ' + it.title + ' —— ' + it.expected + '（当前：' + it.current + '）');
      }
    }
    console.log('');
  }

  try { await env.browser.close(); } catch (e) {}

  /* ---------------------------------------------------------------- 汇总 */
  const total = allResults.length;
  const passed = allResults.filter(function (r) { return r.ok; }).length;
  const failed = total - passed;
  const casesOk = caseSummary.filter(function (c) { return c.failed === 0; }).length;

  console.log('────────────────────────────────────────────');
  console.log('用例：' + casesOk + ' / ' + caseSummary.length + ' 通过' +
    ' · 断言：' + passed + ' / ' + total + ' 通过' +
    ' · 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log((failed ? 'FAIL ' : 'PASS ') + passed + ' / ' + total +
    (failed ? '（失败 ' + failed + ' 条）' : ''));

  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  console.error('[run.js 致命错误] ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
