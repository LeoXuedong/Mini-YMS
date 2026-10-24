/* ==========================================================================
   YMS · test/cases/palette-auto.js
   断言对象：迭代 26 · 图例色阶自动配色（离散高对比预设 + ΔE2000 量化验收）
   命中代码：js/plot/palettes.js（纯数据 + pickColors / deltaE2000 / minDeltaE）
             js/plot/plot-settings.js（配色行 UI + applyAutoColors + 覆盖确认）
             js/core/store.js（normGroup 白名单：preset / autoN）
             css/components.css（.gc-auto 行）
   目标语义：
     1) 10 个图例一键上色 → 全合法 6 位 hex、两两不同、图上颜色 = Store 颜色
     2) 默认预设 tableau10 在 N=10 的 CIEDE2000 两两最小色差 ≥ 5；10 套预设都报实测值
     3) 同一预设 + 同一顺序连点两次 → 结果逐色一致
     4) N = 3 / 8 / 10 / 12 / 22 / 30 全部合法、无重复
     5) 超容量（N=12 选 set1，上限 9）→ 明确提示 + 建议 Kelly 22
     6) 手改不被破坏：手改生效；再点自动 → 覆盖确认（文案含「已手动调整的 1 个」）；确认后覆盖
     7) 手改优先：自动上色后再手改 → 生效
     8) .yms 往返：preset / autoN / 各图例颜色还原（S-2 白名单没过滤掉新字段）
     9) 5 套主题下自动配色都不崩
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

/* --------------------------------------------------------------- 夹具 */

/** n 个类目的 CSV（每个类目 4 行，Yield 各不相同） */
function csvN(n) {
  const rows = ['Tool,Wafer,Yield'];
  for (let i = 0; i < n * 4; i++) {
    const k = i % n + 1;
    rows.push('T' + (k < 10 ? '0' + k : k) + ',W' + (i + 1) + ',' + (88 + (i % 9) * 1.1).toFixed(2));
  }
  return rows.join('\n');
}
function keys(n) {
  const out = [];
  for (let k = 1; k <= n; k++) out.push('T' + (k < 10 ? '0' + k : k));
  return out;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;
function allHex(list) { return (list || []).every(function (c) { return HEX6.test(c); }); }
function uniq(list) { return new Set((list || []).map(function (c) { return String(c).toLowerCase(); })).size === list.length; }

/* --------------------------------------------------- 页面内动作 */

/** 建一张按 Tool 分组的柱状图（颜色分组列 = Tool → 10 个图例） */
async function makeBar(page, n) {
  await page.evaluate(function () {
    window.__YMS__.setMode('plot');
    window.__YMS__.applyPlot({
      type: 'bar', x: ['Tool'], values: ['Yield'], sorters: [],
      group: { colorBy: 'Tool', symbolBy: '', colors: {}, preset: 'tableau10', autoN: 0 },
      rendered: true
    });
    window.__YMS__.submitPlot({});
  });
  await page.waitForTimeout(180);
  return page.evaluate(function () {
    const pv = window.YMS.PlotSettings.palettePreview('tableau10');
    return { n: pv.n, rows: pv.rows.map(function (r) { return r.key; }) };
  });
}

/** 当前有效配色（Store）+ 图上 series 颜色 */
async function readColors(page) {
  return page.evaluate(function () {
    const st = window.__YMS__.getState();
    const g = st.plot.group || {};
    const chart = window.YMS.PlotView.charts[0];
    const opt = (chart && chart.chart && chart.chart.getOption) ? chart.chart.getOption() : null;
    return {
      preset: g.preset || '', autoN: g.autoN || 0,
      map: g.colors || {},
      keys: Object.keys(g.colors || {}),
      values: Object.keys(g.colors || {}).map(function (k) { return g.colors[k]; }),
      seriesColors: opt ? (opt.series || []).map(function (s) {
        return (s.itemStyle && s.itemStyle.color) || (s.lineStyle && s.lineStyle.color) || null;
      }) : []
    };
  });
}

/** 点「一键自动配色」按钮（真实 DOM 点击） */
async function clickAuto(page) {
  await page.click('#ps-palette-apply');
  await page.waitForTimeout(180);
}

/** 覆盖确认框（U.confirm）→ {open, text} */
async function confirmInfo(page) {
  return page.evaluate(function () {
    const mask = document.querySelector('#modal-root .modal-mask');
    const body = mask ? mask.querySelector('.modal-body') : null;
    return { open: !!mask, text: body ? String(body.textContent).trim() : '' };
  });
}
/** 点确认框里的「覆盖并应用」 */
async function confirmOverwrite(page) {
  await page.evaluate(function () {
    const btns = Array.prototype.slice.call(document.querySelectorAll('.modal-foot .btn'));
    const b = btns.filter(function (x) { return String(x.textContent).indexOf('覆盖并应用') >= 0; })[0];
    if (b) b.click();
  });
  await page.waitForTimeout(200);
}
async function cancelOverwrite(page) {
  await page.evaluate(function () {
    const btns = Array.prototype.slice.call(document.querySelectorAll('.modal-foot .btn'));
    const b = btns.filter(function (x) { return String(x.textContent).indexOf('取消') >= 0; })[0];
    if (b) b.click();
  });
  await page.waitForTimeout(150);
}

module.exports = {
  id: 'palette-auto',
  title: '迭代 26 · 图例色阶自动配色（10 套离散预设 + ΔE2000 + 手改/往返/主题）',
  async run(ctx) {
    const page = ctx.page;
    const t = ctx.t;

    /* ==================================================================
       0. 预设表本体（纯数据）
       ================================================================== */
    const presets = await page.evaluate(function () {
      const P = window.YMS.Palettes;
      return {
        exists: !!P,
        ids: P ? P.ids() : [],
        list: P ? P.PRESETS.map(function (p) {
          return { id: p.id, name: p.name, source: p.source, n: p.colors.length, colors: p.colors };
        }) : [],
        defaultId: P ? P.DEFAULT_ID : null
      };
    });
    t.eq('0.1 色板模块已加载（YMS.Palettes）', presets.exists, true);
    t.eq('0.2 预设套数 = 10', presets.list.length, 10);
    t.eq('0.3 id 无重复', uniq(presets.ids), true);
    t.eq('0.4 默认预设 = tableau10', presets.defaultId, 'tableau10');
    const wantIds = ['tableau10', 'category10', 'set1', 'dark2', 'paired', 'tol-bright', 'tol-muted', 'kelly22', 'glasbey', 'grayscale'];
    t.eq('0.5 需求清单里的 10 个 id 全部实现', wantIds.every(function (id) { return presets.ids.indexOf(id) >= 0; }), true);
    let badHex = [];
    let badCap = [];
    const wantCap = { tableau10: 10, category10: 10, set1: 9, dark2: 8, paired: 12, 'tol-bright': 7, 'tol-muted': 9, kelly22: 22, glasbey: 30, grayscale: 10 };
    presets.list.forEach(function (p) {
      if (!allHex(p.colors)) badHex.push(p.id);
      if (p.n !== wantCap[p.id]) badCap.push(p.id + '=' + p.n);
    });
    t.eq('0.6 全部颜色为 6 位 hex（normGroup 只收 6 位）', badHex.join(',') || 'OK', 'OK');
    t.eq('0.7 每套预设容量与需求表一致', badCap.join(',') || 'OK', 'OK');

    /* ==================================================================
       1 + 2 + 3. N=10 一键上色 / ΔE2000 / 顺序稳定
       ================================================================== */
    const imp10 = await app.importText(page, 'pal10.csv', csvN(10));
    t.eq('1.1 导入 10 类目夹具（40 行）', imp10.rows, 40);
    const bar = await makeBar(page, 10);
    t.eq('1.2 分组列表识别出 10 个图例', bar.n, 10);

    /* 配色行 DOM（用户看到的界面元素真的存在） */
    const dom = await page.evaluate(function () {
      const sel = document.getElementById('ps-palette-preset');
      const btn = document.getElementById('ps-palette-apply');
      const strip = document.getElementById('ps-palette-strip');
      const meta = document.getElementById('ps-palette-meta');
      const warn = document.getElementById('ps-palette-warn');
      return {
        row: !!document.getElementById('ps-palette-auto'),
        optCount: sel ? sel.options.length : 0,
        optLabels: sel ? Array.prototype.slice.call(sel.options).map(function (o) { return o.textContent; }) : [],
        selValue: sel ? sel.value : null,
        btnText: btn ? String(btn.textContent).trim() : '',
        btnW: btn ? Math.round(btn.getBoundingClientRect().width) : 0,
        btnDisabled: btn ? btn.disabled : null,
        stripCount: strip ? strip.querySelectorAll('.gc-strip-sw').length : -1,
        stripFirst: (strip && strip.firstChild) ? strip.firstChild.style.background : null,
        meta: meta ? String(meta.textContent) : '',
        warn: warn ? String(warn.textContent) : '',
        metaPresent: !!meta,
        /* 任务 I ① 守卫：面板里含「参考数 / ΔE2000」的**可见**叶子元素计数必须为 0 */
        refHits: (function () {
          const body = document.getElementById('plot-settings-body');
          if (!body) return -1;
          const all = body.querySelectorAll('*');
          let hits = 0;
          for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el.children && el.children.length) continue;
            const txt = String(el.textContent || '');
            if (!txt) continue;
            if (txt.indexOf('参考数') < 0 && txt.indexOf('ΔE2000') < 0) continue;
            const cs = window.getComputedStyle(el);
            if (el.offsetParent === null || cs.display === 'none' || cs.visibility === 'hidden') continue;
            if (el.getBoundingClientRect().height <= 0) continue;
            hits++;
          }
          return hits;
        })(),
        /* 任务 I ② 新结构：一行「下拉选组 + 色块按钮」（旧的 .gc-row 竖排列表已不存在） */
        gcSelOpts: (function () {
          const s2 = document.getElementById('ps-gc-select');
          return s2 ? s2.options.length : -1;
        })(),
        gcSelLabels: (function () {
          const s2 = document.getElementById('ps-gc-select');
          return s2 ? Array.prototype.slice.call(s2.options).map(function (o) { return String(o.textContent).trim(); }) : [];
        })(),
        gcSelValue: (function () {
          const s2 = document.getElementById('ps-gc-select');
          return s2 ? s2.value : null;
        })(),
        gcSwatch: !!document.getElementById('ps-gc-swatch'),
        gcSwatchBg: (function () {
          const w = document.getElementById('ps-gc-swatch');
          return w ? window.getComputedStyle(w).backgroundColor : null;
        })(),
        rowSwatches: document.querySelectorAll('#ps-group-colors .gc-row .gc-swatch').length,
        rowPresetBtns: document.querySelectorAll('#ps-group-colors .gc-row .gc-pal').length,
        gcRowsOld: document.querySelectorAll('#ps-group-colors .gc-row').length,
        gcListOld: document.querySelectorAll('#ps-group-colors .gc-list').length,
        resetBtn: !!document.getElementById('ps-group-colors-reset')
      };
    });
    t.eq('1.3 设置区存在「配色」行', dom.row, true);
    t.eq('1.4 预设下拉有 10 个选项', dom.optCount, 10);
    t.eq('1.5 下拉默认选中 tableau10', dom.selValue, 'tableau10');
    t.contains('1.6 一键按钮文案', dom.btnText, '一键自动配色');
    t.ok('1.7 按钮文字未被压成图标（宽 ≥ 60px）', dom.btnW >= 60, { w: dom.btnW });
    t.eq('1.8 色条预览段数 = 图例数', dom.stripCount, 10);
    /* 任务 I ①：原「参考数：10 个图例 / 本预设上限 10 ✓ · 两两最小 ΔE2000 x.x」整行已删
       —— 断言不删，改为**反向守卫**（元素必须不存在）+ 保留功能层断言。 */
    t.eq('1.9 参考数行已移除：面板里含「参考数」/「ΔE2000」的可见元素 = 0 个', dom.refHits, 0);
    t.eq('1.9a 旧元素 #ps-palette-meta 不再存在', dom.metaPresent, false);
    t.eq('1.10 未超容量 → 无超容量提示', dom.warn, '');
    /* 任务 I ②：竖排 10 行（色块 + ▦）改为一行「下拉选组 + 色块按钮」 */
    t.eq('1.11 分组配色改成下拉：#ps-gc-select 选项数 = 图例数（10）', dom.gcSelOpts, 10);
    t.eq('1.11b 下拉选项文本 = 全部组名（T01…T10）', dom.gcSelLabels.join(','),
      ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10'].join(','));
    t.eq('1.11c 下拉默认选中第一组', dom.gcSelValue, 'T01');
    t.eq('1.12 旧竖排结构已移除：.gc-row = 0 行、.gc-list = 0 个（反向守卫）',
      dom.gcRowsOld + '/' + dom.gcListOld + '/' + dom.rowSwatches + '/' + dom.rowPresetBtns, '0/0/0/0');
    t.eq('1.12b 改为一行里的色块按钮 #ps-gc-swatch', dom.gcSwatch, true);
    t.eq('1.13 手动路径的「恢复默认」仍在', dom.resetBtn, true);

    /* 真实点击 → 一键上色 */
    await clickAuto(page);
    const a1 = await readColors(page);
    t.eq('1.14 一键上色后 10 个图例都有颜色', a1.keys.length, 10);
    t.eq('1.15 全部为合法 6 位 hex', allHex(a1.values), true);
    t.eq('1.16 两两不同（无重复色）', uniq(a1.values), true);
    t.eq('1.17 顺序 = 分组列表顺序（T01 取第 1 色）', a1.map['T01'], '#4E79A7');
    t.eq('1.18 图上系列颜色 = Store 颜色（真的重绘了）', a1.seriesColors.join(','), a1.values.join(','));
    t.eq('1.19 预设与图例数已落库', a1.preset + '/' + a1.autoN, 'tableau10/10');

    /* 2.x 量化对比度：容器内颜色 + 逐预设实测 */
    const de = await page.evaluate(function () {
      const P = window.YMS.Palettes;
      const st = window.__YMS__.getState();
      const vals = Object.keys(st.plot.group.colors).map(function (k) { return st.plot.group.colors[k]; });
      const applied = P.minDeltaE(vals);
      const per = P.PRESETS.map(function (p) {
        const m = P.minDeltaE(P.pickColors(p.id, p.colors.length));
        return { id: p.id, name: p.name, n: p.colors.length, de: m.de, pair: m.a + '/' + m.b };
      });
      /* 参照组：Jet 连续色阶在 10 个类目上的最小 ΔE（证明「连续色阶相邻难辨」，写进文档用） */
      function jet(t) {
        function ch(x) {
          const v = Math.round(255 * Math.min(1, Math.max(0, x)));
          const s = v.toString(16);
          return s.length < 2 ? '0' + s : s;
        }
        const r = 1.5 - Math.abs(4 * t - 3);
        const g = 1.5 - Math.abs(4 * t - 2);
        const b = 1.5 - Math.abs(4 * t - 1);
        return '#' + ch(r) + ch(g) + ch(b);
      }
      const jetCols = [];
      for (let i = 0; i < 10; i++) jetCols.push(jet(i / 9));
      /* 连续色阶的缺陷不是「N=10 就立刻崩」而是**相邻色差随类目数收缩**：
         同一 Jet 在 N=20/30/50 上的两两最小 ΔE 单调下降 → 类目一多必然跌破 5。 */
      const jetSeries = [10, 20, 30, 50].map(function (n) {
        const c = [];
        for (let i = 0; i < n; i++) c.push(jet(i / (n - 1)));
        const mm = P.minDeltaE(c);
        return { n: n, de: mm.de, pair: mm.a + '/' + mm.b };
      });
      const jetMin = P.minDeltaE(jetCols);
      return { applied: applied, per: per, jet: { min: jetMin.de, colors: jetCols, series: jetSeries } };
    });
    t.ok('2.1 tableau10 @ N=10 最小 ΔE2000 ≥ 5', de.applied.de >= 5, { de: de.applied.de, pair: de.applied.a + '/' + de.applied.b });
    de.per.forEach(function (p, i) {
      t.ok('2.' + (2 + i) + ' ' + p.id + ' @ 容量内 N=' + p.n + ' 最小 ΔE2000 = ' + p.de.toFixed(2) + ' ≥ 5',
        p.de >= 5, { id: p.id, de: p.de, pair: p.pair });
    });
    /* 连续色阶的结构性问题：相邻色差随类目数收缩，N=20 起跌破 5；同规模下 glasbey 仍 ≥ 8 */
    const j20 = de.jet.series.filter(function (x) { return x.n === 20; })[0];
    const j30 = de.jet.series.filter(function (x) { return x.n === 30; })[0];
    const j50 = de.jet.series.filter(function (x) { return x.n === 50; })[0];
    t.ok('2.12 Jet 连续色阶相邻色差随 N 单调收缩（10 > 20 > 30 > 50）',
      de.jet.series[0].de > j20.de && j20.de > j30.de && j30.de > j50.de,
      de.jet.series.map(function (x) { return 'N' + x.n + '=' + x.de.toFixed(2); }));
    t.ok('2.13 Jet 在 N=20 已跌破 ΔE 5（' + j20.de.toFixed(2) + '）', j20.de < 5, { de: j20.de, pair: j20.pair });
    t.ok('2.14 Jet 在 N=30 只有 ' + j30.de.toFixed(2) + '，同规模 glasbey = '
      + (de.per.filter(function (p) { return p.id === 'glasbey'; })[0].de.toFixed(2)) + '（约 3 倍）',
      j30.de < de.per.filter(function (p) { return p.id === 'glasbey'; })[0].de,
      { jet30: j30.de, glasbey30: de.per.filter(function (p) { return p.id === 'glasbey'; })[0].de });

    /* 3.x 顺序稳定：连点两次结果一致 */
    const first = a1.values.slice();
    await clickAuto(page);
    const a2 = await readColors(page);
    t.eq('3.1 连点两次颜色逐色一致', a2.values.join(','), first.join(','));
    const pure = await page.evaluate(function () {
      const P = window.YMS.Palettes;
      return {
        a: P.pickColors('tableau10', 10).join(','),
        b: P.pickColors('tableau10', 10).join(','),
        k: P.pickColors('kelly22', 22).join(','),
        k2: P.pickColors('kelly22', 22).join(',')
      };
    });
    t.eq('3.2 pickColors 纯函数幂等（tableau10,10）', pure.a, pure.b);
    t.eq('3.3 pickColors 纯函数幂等（kelly22,22）', pure.k, pure.k2);
    t.eq('3.4 连点两次后仍无重复色', uniq(a2.values), true);

    /* ==================================================================
       4. 跨 N 验证：3 / 8 / 10 / 12 / 22 / 30
       ================================================================== */
    const cross = await page.evaluate(function () {
      const P = window.YMS.Palettes;
      const Ns = [3, 8, 10, 12, 22, 30];
      return Ns.map(function (n) {
        const rec = P.suggest(n);
        const id = rec || P.DEFAULT_ID;              // 超容量 → 按推荐预设；否则默认预设
        const cols = P.pickColors(id, n);
        return { n: n, preset: id, len: cols.length, hex: cols.every(function (c) { return /^#[0-9a-f]{6}$/i.test(c); }),
                 uniq: new Set(cols.map(function (c) { return c.toLowerCase(); })).size === n, colors: cols };
      });
    });
    cross.forEach(function (r, i) {
      const base = 4 + i * 3;
      t.eq('4.' + base + ' N=' + r.n + ' 取色数量正确（建议预设 ' + r.preset + '）', r.len, r.n);
      t.eq('4.' + (base + 1) + ' N=' + r.n + ' 全部合法 6 位 hex', r.hex, true);
      t.eq('4.' + (base + 2) + ' N=' + r.n + ' 两两不同（无循环重复色）', r.uniq, true);
    });

    /* ==================================================================
       5. 超容量：12 个图例 + set1（上限 9）
       ================================================================== */
    await app.importText(page, 'pal12.csv', csvN(12));
    await makeBar(page, 12);
    const set1 = await page.evaluate(function () {
      window.YMS.PlotSettings.setPalettePreset('set1');
      window.YMS.PlotSettings.render();
      const pv = window.YMS.PlotSettings.palettePreview('set1');
      const warn = document.getElementById('ps-palette-warn');
      const meta = document.getElementById('ps-palette-meta');
      const sel = document.getElementById('ps-palette-preset');
      const kellyOpt = sel
        ? Array.prototype.slice.call(sel.options).some(function (o) { return o.value === 'kelly22'; })
        : false;
      /* 功能层：真的能切到 kelly22 并取到 12 色，然后还原（后续断言仍以 set1 为准） */
      window.YMS.PlotSettings.setPalettePreset('kelly22');
      const kellyPv = window.YMS.PlotSettings.palettePreview();
      const kellyColors = window.YMS.Palettes.pickColors('kelly22', 12);
      window.YMS.PlotSettings.setPalettePreset('set1');
      window.YMS.PlotSettings.render();
      const refHits = (function () {
        const body = document.getElementById('plot-settings-body');
        if (!body) return -1;
        const all = body.querySelectorAll('*');
        let hits = 0;
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.children && el.children.length) continue;
          const txt = String(el.textContent || '');
          if (!txt) continue;
          if (txt.indexOf('参考数') < 0 && txt.indexOf('ΔE2000') < 0 && txt.indexOf('超出上限') < 0) continue;
          const cs = window.getComputedStyle(el);
          if (el.offsetParent === null || cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (el.getBoundingClientRect().height <= 0) continue;
          hits++;
        }
        return hits;
      })();
      return {
        n: pv.n, cap: pv.capacity, over: pv.over, suggest: pv.suggest,
        colors: pv.colors, warn: warn ? String(warn.textContent) : '',
        meta: meta ? String(meta.textContent) : '',
        metaWarn: meta ? meta.className.indexOf('is-warn') >= 0 : false,
        metaPresent: !!meta, refHits: refHits, kellyOpt: kellyOpt,
        kellyCap: kellyPv.capacity, kellyColors: kellyColors.length,
        restored: window.YMS.PlotSettings.palettePreview().preset
      };
    });
    t.eq('5.1 N=12 时识别出 12 个图例', set1.n, 12);
    t.eq('5.2 set1 上限 9', set1.cap, 9);
    t.eq('5.3 预览标记为超容量', set1.over, true);
    t.eq('5.4 推荐预设 = kelly22', set1.suggest, 'kelly22');
    /* 任务 I ①：参考数行（含超容量 ⚠ / 建议改用 Kelly 22 / ΔE 三档分支）整行已删。
       断言改为「反向守卫 + 功能层」两条腿：既证明那行不在了，也证明预设在超容量下照样能用。 */
    t.eq('5.5 参考数行已移除：超容量时也不出现「参考数 / ΔE2000 / 超出上限」可见元素', set1.refHits, 0);
    t.eq('5.5a 旧元素 #ps-palette-meta 在超容量时同样不存在', set1.metaPresent, false);
    t.eq('5.6 超容量时预设下拉仍列出 Kelly 22（功能层没跟着删）', set1.kellyOpt, true);
    t.eq('5.7 切到 kelly22 预览容量 22、可取 12 色（功能可用），随后还原 set1',
      set1.kellyCap + '/' + set1.kellyColors + '/' + set1.restored, '22/12/set1');
    t.contains('5.8 提示条说明「循环 + 明度分层」', set1.warn, '循环 + 明度分层');
    t.contains('5.9 提示条给出建议预设', set1.warn, 'Kelly 22');
    t.eq('5.10 超容量预览仍是 12 合法 hex', allHex(set1.colors) && set1.colors.length === 12, true);
    t.eq('5.11 超容量预览无重复色', uniq(set1.colors), true);

    await clickAuto(page);
    const over = await readColors(page);
    t.eq('5.12 超容量仍可一键上色（12 个）', over.keys.length, 12);
    t.eq('5.13 超容量结果无重复色', uniq(over.values), true);
    t.eq('5.14 第 10 个图例进入第 2 轮（与第 1 色不同）', over.values[9] !== over.values[0], true);

    /* ==================================================================
       6. 手动改色不被破坏 + 覆盖确认
       ================================================================== */
    await page.evaluate(function () { window.YMS.PlotSettings.setGroupColor('T03', '#123456'); });
    await page.waitForTimeout(220);
    const manual1 = await page.evaluate(function () {
      const st = window.__YMS__.getState();
      const chart = window.YMS.PlotView.charts[0];
      const opt = (chart && chart.chart && chart.chart.getOption) ? chart.chart.getOption() : { series: [] };
      const idx = Object.keys(st.plot.group.colors).indexOf('T03');
      return {
        stored: st.plot.group.colors['T03'],
        seriesColor: (opt.series[idx] && opt.series[idx].itemStyle || {}).color,
        manualKeys: window.YMS.PlotSettings.manualColorKeys('set1')
      };
    });
    t.eq('6.1 手改单个颜色生效（Store）', manual1.stored, '#123456');
    t.eq('6.2 手改后图上该系列颜色跟着变', manual1.seriesColor, '#123456');
    t.eq('6.3 manualColorKeys 识别出 1 个手改项', manual1.manualKeys.length, 1);

    const need = await page.evaluate(function () {
      return window.YMS.PlotSettings.applyAutoColors('set1', false);
    });
    t.eq('6.4 有手改时自动配色返回 needConfirm', need.needConfirm, true);
    t.eq('6.5 覆盖条数 = 1', need.manual, 1);
    const untouched = await readColors(page);
    t.eq('6.6 未确认时颜色一个都没变（T03 仍手改色）', untouched.map['T03'], '#123456');

    /* 真实点按钮 → 弹确认框（文案必须报出条数） */
    await clickAuto(page);
    const dlg = await confirmInfo(page);
    t.eq('6.7 点按钮弹出覆盖确认框', dlg.open, true);
    t.contains('6.8 确认框文案报出手改条数', dlg.text, '将覆盖已手动调整的 1 个图例颜色，继续？');
    await cancelOverwrite(page);
    const afterCancel = await readColors(page);
    t.eq('6.9 取消后颜色不变（T03 仍是手改色）', afterCancel.map['T03'], '#123456');
    t.eq('6.10 取消后确认框已关闭', (await confirmInfo(page)).open, false);

    await clickAuto(page);
    await confirmOverwrite(page);
    const afterOk = await readColors(page);
    t.eq('6.11 确认后覆盖成功（T03 回到预设色）', afterOk.map['T03'], set1.colors[2]);
    t.eq('6.12 确认后 12 个图例颜色都在', afterOk.keys.length, 12);
    t.eq('6.13 覆盖后没有残留的手改项', (await page.evaluate(function () {
      return window.YMS.PlotSettings.manualColorKeys('set1').length;
    })), 0);

    /* ==================================================================
       7. 手改优先：自动上色后再手改 → 生效且保留
       ================================================================== */
    const pri = await page.evaluate(function () {
      window.YMS.PlotSettings.setGroupColor('T07', '#00AA55');
      /* 再点一次自动配色（不给 force）：应要求确认，且不动颜色 */
      const r = window.YMS.PlotSettings.applyAutoColors('set1', false);
      const st = window.__YMS__.getState();
      return { needConfirm: r.needConfirm, manual: r.manual, kept: st.plot.group.colors['T07'],
               manualKeys: window.YMS.PlotSettings.manualColorKeys('set1') };
    });
    t.eq('7.1 自动上色后再手改生效', pri.kept, '#00AA55');
    t.eq('7.2 手改项被识别（未被自动配色冲掉）', pri.manualKeys.join(','), 'T07');
    t.eq('7.3 再点自动配色仍先要确认', pri.needConfirm, true);
    t.eq('7.4 确认条数 = 1', pri.manual, 1);

    /* ==================================================================
       8. .yms 往返（重点：S-2 白名单没把 preset / autoN 过滤掉）
       ================================================================== */
    const rt = await page.evaluate(function () {
      /* Store.serialize() 返回的 plot 是**活引用**（plot: s.plot），必须先深拷贝快照，
         否则后面的 applyPlot 会把「保存下来的文件内容」一起改掉（本用例第一版就栽在这里）。 */
      const snap = JSON.parse(JSON.stringify(window.__YMS__.saveYms()));
      const before = JSON.parse(JSON.stringify(window.__YMS__.getState().plot.group));
      const plotInFile = (function find(o) {
        if (!o || typeof o !== 'object') return null;
        if (o.plot && o.plot.group) return o.plot.group;
        for (const k in o) { const r = find(o[k]); if (r) return r; }
        return null;
      })(snap);
      /* 先把颜色改成别的，再回灌 → 应还原 */
      window.__YMS__.applyPlot({ group: { colorBy: 'Tool', symbolBy: '', colors: { T01: '#FFFFFF' }, preset: '', autoN: 0 } });
      const dirty = window.__YMS__.getState().plot.group.colors['T01'];
      const loadRes = window.__YMS__.loadYms(snap);
      const after = window.__YMS__.getState().plot.group;
      /* 篡改预设 id → 归一为 ''（白名单丢弃未知 id），颜色不受影响 */
      const tampered = JSON.parse(JSON.stringify(snap));
      (function patch(o) {
        if (!o || typeof o !== 'object') return;
        if (o.plot && o.plot.group) { o.plot.group.preset = 'bogus-preset'; o.plot.group.autoN = 9999; }
        for (const k in o) patch(o[k]);
      })(tampered);
      const res2 = window.__YMS__.loadYms(tampered);
      const after2 = window.__YMS__.getState().plot.group;
      return {
        filePreset: plotInFile ? plotInFile.preset : null,
        fileAutoN: plotInFile ? plotInFile.autoN : null,
        fileCols: plotInFile ? Object.keys(plotInFile.colors || {}).length : 0,
        beforePreset: before.preset, beforeAutoN: before.autoN, beforeCount: Object.keys(before.colors).length,
        beforeT01: before.colors['T01'],
        dirty: dirty,
        loadOk: !!(loadRes && (loadRes.ok === undefined || loadRes.ok)),
        afterPreset: after.preset, afterAutoN: after.autoN,
        afterCount: Object.keys(after.colors).length, afterT01: after.colors['T01'],
        afterColors: after.colors,
        tamperedPreset: after2.preset, tamperedAutoN: after2.autoN,
        tamperedCount: Object.keys(after2.colors).length,
        notes: (loadRes && loadRes.notes) ? loadRes.notes.length : 0
      };
    });
    t.eq('8.1 .yms 文件里带上了 group.preset', rt.filePreset, 'set1');
    t.eq('8.2 .yms 文件里带上了 group.autoN', rt.fileAutoN, 12);
    t.eq('8.3 .yms 文件里 12 条分组色都在', rt.fileCols, 12);
    t.eq('8.4 载入前被改成脏值（验证真的回灌了）', rt.dirty, '#FFFFFF');
    t.eq('8.5 载入成功', rt.loadOk, true);
    t.eq('8.6 载入后预设还原', rt.afterPreset, 'set1');
    t.eq('8.7 载入后 autoN 还原', rt.afterAutoN, 12);
    t.eq('8.8 载入后 12 个图例颜色还原', rt.afterCount, 12);
    t.eq('8.9 载入后 T01 颜色与保存前一致', rt.afterT01, rt.beforeT01);
    t.eq('8.10 载入后 T07 手改色也在', rt.afterColors['T07'], '#00AA55');
    t.eq('8.11 未知预设 id 被白名单丢弃（→ 空串）', rt.tamperedPreset, '');
    t.eq('8.12 非法 autoN（9999）回落 0', rt.tamperedAutoN, 0);
    t.eq('8.13 篡改预设不影响图例颜色', rt.tamperedCount, 12);

    /* ==================================================================
       9. 5 套主题下自动配色都不崩
       ================================================================== */
    const themeIds = ['atlas', 'observatory', 'ledger', 'ion', 'paper'];
    const themeRes = [];
    for (let i = 0; i < themeIds.length; i++) {
      const r = await page.evaluate(function (id) {
        window.__YMS__.theme(id);
        const res = window.YMS.PlotSettings.applyAutoColors('tableau10', true);
        const st = window.__YMS__.getState();
        return {
          theme: st.theme, ok: !!res.ok, applied: res.applied || 0,
          colors: Object.keys(st.plot.group.colors).length,
          uniq: new Set(Object.keys(st.plot.group.colors).map(function (k) { return st.plot.group.colors[k]; })).size,
          preset: st.plot.group.preset
        };
      }, themeIds[i]);
      await page.waitForTimeout(120);
      themeRes.push(r);
    }
    themeRes.forEach(function (r, i) {
      const base = 9 + i * 4;
      t.eq('9.' + base + ' 主题 ' + themeIds[i] + ' 切换成功', r.theme, themeIds[i]);
      t.eq('9.' + (base + 1) + ' 主题 ' + themeIds[i] + ' 下自动配色成功', r.ok, true);
      t.eq('9.' + (base + 2) + ' 主题 ' + themeIds[i] + ' 下 12 个图例都上色', r.colors, 12);
      t.eq('9.' + (base + 3) + ' 主题 ' + themeIds[i] + ' 下颜色仍两两不同', r.uniq, 12);
    });
    t.eq('9.21 配色预设仍是 tableau10', themeRes[4].preset, 'tableau10');

    /* ==================================================================
       10. 手动路径零回归 + 页面健康
       ================================================================== */
    /* 任务 I ② 之后：手动改色入口从「每行 ▦」改为「一行里的色块 #ps-gc-swatch + 展开的 .gc-presets」，
       能力（12 色预设 / 单个改色 / 恢复默认）一条都不许丢 —— 断言照旧，只把定位换成新结构。 */
    const legacy = await page.evaluate(function () {
      /* 恢复默认 → 全部自定义清空（既有行为） */
      window.YMS.PlotSettings.resetGroupColors();
      const st1 = window.__YMS__.getState().plot.group;
      /* 点色块按钮 → 展开 12 色预设；点第 3 个色块 = 改当前所选组的颜色 */
      const sw = document.getElementById('ps-gc-swatch');
      if (sw) sw.click();
      const strip = document.querySelector('#ps-group-colors .gc-presets');
      const btns = strip ? strip.querySelectorAll('.gc-preset') : [];
      const third = btns[2] ? btns[2].getAttribute('data-gc-preset') : null;
      if (btns[2]) btns[2].click();
      const st2 = window.__YMS__.getState().plot.group;
      const sel = document.getElementById('ps-gc-select');
      const key = sel ? sel.value : null;
      const sw2 = document.getElementById('ps-gc-swatch');
      const rgb = function (hex) {
        const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(String(hex || ''));
        return m ? ('rgb(' + parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) + ')') : null;
      };
      return {
        afterReset: Object.keys(st1.colors).length,
        presetCount: btns.length,
        thirdColor: third,
        manualAfterPreset: st2.colors[key] || null,
        key: key, expectRgb: rgb(third),
        swatchBg: sw2 ? window.getComputedStyle(sw2).backgroundColor : null,
        rows: document.querySelectorAll('#ps-group-colors .gc-row').length,
        gcOpts: sel ? sel.options.length : -1
      };
    });
    t.eq('10.1 「恢复默认」清空全部自定义色（既有行为不变）', legacy.afterReset, 0);
    t.eq('10.2 点色块展开的预设条仍有 12 色（原 ▦ 的能力）', legacy.presetCount, 12);
    t.eq('10.3 点预设里的颜色仍能单个改色（写进当前所选组）', legacy.manualAfterPreset, legacy.thirdColor);
    t.eq('10.3b 色块按钮背景色跟着变成该色', legacy.swatchBg, legacy.expectRgb);
    t.eq('10.4 旧竖排行 0 行、下拉选项 = 12（结构已换，功能未丢）',
      legacy.rows + '/' + legacy.gcOpts, '0/12');

    const st = await app.getState(page);
    t.eq('10.5 数据未被改动（48 行 / 3 列）', st.rowCount + '/' + st.colCount, '48/3');
    t.noErrors('10.6 全程零未捕获异常 / 控制台错误', ctx.errors);
  }
};
