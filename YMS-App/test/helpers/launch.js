/* ==========================================================================
   YMS · test/helpers/launch.js
   职责：解析 Playwright / Chromium 位置 → 启动浏览器 → 用 file:// 打开 index.html
   依赖解析顺序（任何一环命即用）：
     Playwright  ① require('playwright') ② hermes-agent 内置绝对路径 ③ 环境变量 PLAYWRIGHT_PATH
     Chromium    ① 环境变量 PLAYWRIGHT_CHROMIUM ② hermes tools/chromium-1208
                 ③ ms-playwright/chromium-1228|1247 ④ 交给 Playwright 默认解析
   都不行 → 抛中文错误，说明怎么装
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/* 路径一律由环境推导，不写死任何用户名/盘符（公开仓库不留个人路径）。
   可用环境变量覆盖：HERMES_HOME / LOCALAPPDATA / PLAYWRIGHT_PATH / PLAYWRIGHT_CHROMIUM
   注：Windows 下 os.homedir() 返回反斜杠，require() 与 fs.existsSync() 都能直接处理，无需转换 */
const os = require('os');
const HOME = String(os.homedir() || '');
const LOCAL = String(process.env.LOCALAPPDATA || (HOME + '/AppData/Local'));
const HERMES = String(process.env.HERMES_HOME || (LOCAL + '/hermes'));

const PW_CANDIDATES = [
  'playwright',
  HERMES + '/hermes-agent/node_modules/playwright',
  HERMES + '/hermes-agent/node_modules/playwright-core'
];

const CHROME_CANDIDATES = [
  HERMES + '/tools/chromium-1208/chrome-win64/chrome.exe',
  HERMES + '/tools/chromium-1228/chrome-win64/chrome.exe',
  LOCAL + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  LOCAL + '/ms-playwright/chromium-1247/chrome-win64/chrome.exe'
];

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

/** 解析 Playwright 模块（返回 { chromium, from }） */
function resolvePlaywright() {
  const tried = [];
  const list = PW_CANDIDATES.slice();
  if (process.env.PLAYWRIGHT_PATH) list.push(process.env.PLAYWRIGHT_PATH);

  for (const cand of list) {
    tried.push(cand);
    try {
      const mod = require(cand);
      if (mod && mod.chromium) return { pw: mod, from: cand };
    } catch (e) { /* 继续试下一个 */ }
  }
  throw new Error(
    '找不到 Playwright。已尝试：\n  ' + tried.join('\n  ') + '\n' +
    '解决办法（任选其一）：\n' +
    '  1) 在 D:\\AI Agent\\Hermes\\YMS 下执行  npm i -D playwright\n' +
    '  2) 设置环境变量 PLAYWRIGHT_PATH=<playwright 包所在目录>\n' +
    '  3) 使用 hermes 自带的一份：$HERMES_HOME/hermes-agent/node_modules/playwright'
  );
}

/** 解析 Chromium 可执行文件（返回绝对路径，或 null = 交给 Playwright 默认） */
function resolveChromium() {
  const env = process.env.PLAYWRIGHT_CHROMIUM;
  if (env) {
    if (exists(env)) return env;
    console.warn('[warn] PLAYWRIGHT_CHROMIUM 指向的文件不存在，回退到内置候选：' + env);
  }
  for (const p of CHROME_CANDIDATES) if (exists(p)) return p;
  return null;
}

/** 启动浏览器；返回 { browser, chromium, pwFrom, exe } */
async function launch(opts) {
  const o = opts || {};
  const { pw, from } = resolvePlaywright();
  const exe = resolveChromium();
  const args = ['--enable-precise-memory-info'];
  const launchOpts = { headless: o.headless !== false, args: args };
  if (exe) launchOpts.executablePath = exe;
  const browser = await pw.chromium.launch(launchOpts);
  return { browser: browser, chromium: pw.chromium, pwFrom: from, exe: exe };
}

/** 用 file:// 打开 index.html；返回 { page, errors } */
async function openApp(browser, indexPath, opts) {
  const o = opts || {};
  const href = pathToFileURL(path.resolve(indexPath)).href;
  const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  const errors = [];
  page.on('pageerror', function (e) { errors.push('pageerror: ' + (e && e.message)); });
  page.on('console', function (m) {
    if (m.type() === 'error') errors.push('console: ' + String(m.text()).slice(0, 300));
  });

  await page.goto(href, { timeout: 30000 });
  await page.waitForFunction(function () {
    return !!(window.__YMS__ && window.__YMS__.ready() && window.__YMS__.ready());
  }, null, { timeout: 30000 });
  /* 语言归一到中文：断言文案里含中文（未填值 / 非有限值），英文模式下会被翻译层替换 */
  await page.evaluate(function () {
    try { if (window.__i18n && window.__i18n.lang && window.__i18n.lang() !== 'zh') window.__i18n.set('zh'); } catch (e) {}
  });
  return { page: page, errors: errors };
}

module.exports = {
  resolvePlaywright: resolvePlaywright,
  resolveChromium: resolveChromium,
  launch: launch,
  openApp: openApp,
  openAppRaw: openApp
};
