/* ==========================================================================
   YMS · test/cases/settings-ui-slim.js
   断言对象：任务 I · 设置区三处 UI 调整（删 2 处说明行 + 分组配色改下拉框）
   命中代码：js/plot/plot-settings.js
             · buildPaletteAutoBlock（参考数行删除，预设下拉 / 一键 / 色条预览保留）
             · groupColorPicker / presetStrip / fillGroupColors（竖排 12 行 → 一行「下拉选组 + 色块」）
             · buildMergeGroup（非 hist 不再渲染 data-note="merge-on"；merge-hist-na 保留）
             css/components.css（.gc-pick / .gc-sel / .gc-pickcolor；.gc-row/.gc-pal/.gc-list 移除）
   用户口径（截图红框批注 = 最终口径）：
     I1  「6 · 多数据同图 / 多 Y 轴」里「参考数：12 个图例 / 本预设上限 22 ✓ · 两两最小 ΔE2000 10.4」
         整行不渲染（含超容量警示 / ΔE / 建议 Kelly 各分支）；预设下拉、一键自动配色、色条预览
         全部保留 —— 所以本用例同时守「删掉了什么」与「功能没跟着删」。
     I2  分组配色那 12 行竖排列表 → 下拉框：一行放「下拉选组 + 色块按钮」；切下拉只切当前编辑哪组、
         不改颜色；点色块展开原 12 色预设并可设色，选完立即生效并随 .yms 保存；
         保留 N 组 · 已自定义 M、恢复默认、hist / 未分组两种空态文案。
     I3  「3 · 防拥挤合并」下 data-note="merge-on" 那条说明删掉，data-note="merge-hist-na"
         （直方图不适用说明）必须保留；删掉后不许留空白塌陷（用组内子元素数与组高差量化）。
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

/* --------------------------------------------------------------- 夹具 */

/** n 个类目的 CSV（每个类目 4 行） */
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
/** '#0b6e99' → 'rgb(11, 110, 153)'（compare computed style） */
function hexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(String(hex || ''));
  if (!m) return null;
  return 'rgb(' + parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) + ')';
}

/** 建成按 Tool 分组的柱状图（颜色分组列 = Tool → n 个图例） */
async function makeBar(page, n, preset) {
  await page.evaluate(function (a) {
    window.__YMS__.setMode('plot');
    window.__YMS__.applyPlot({
      type: 'bar', x: ['Tool'], values: ['Yield'], sorters: [],
      group: { colorBy: 'Tool', symbolBy: '', colors: {}, preset: a[0], autoN: 0 },
      rendered: true
    });
    window.__YMS__.submitPlot({});
  }, [preset || 'tableau10']);
  await page.waitForTimeout(200);
  return page.evaluate(function () {
    const pv = window.YMS.PlotSettings.palettePreview();
    return { n: pv.n, rows: pv.rows.map(function (r) { return r.key; }) };
  });
}

module.exports = {
  id: 'settings-ui-slim',
  title: '任务 I · 设置区瘦身（删 2 处说明行 + 分组配色改下拉框）',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ==================================================================
       1. I1 · 「参考数」行整行不再渲染（含超容量 / ΔE / 建议 Kelly 各分支）
       ================================================================== */
    const imp = await app.importText(page, 'slim12.csv', csvN(12));
    t.eq('1.1 导入 12 类目夹具（48 行 × 3 列）', imp.rows + 'x' + imp.cols, '48x3');
    const bar = await makeBar(page, 12, 'tableau10');
    t.eq('1.2 分组列表识别出 12 个图例', bar.n, 12);

    const i1 = await page.evaluate(function () {
      const cnt = function (words) {
        const body = document.getElementById('plot-settings-body');
        if (!body) return -1;
        const all = body.querySelectorAll('*');
        let hits = 0;
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.children && el.children.length) continue;
          const txt = String(el.textContent || '');
          if (!txt) continue;
          if (!words.some(function (w) { return txt.indexOf(w) >= 0; })) continue;
          const cs = window.getComputedStyle(el);
          if (el.offsetParent === null || cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (el.getBoundingClientRect().height <= 0) continue;
          hits++;
        }
        return hits;
      };
      const sel = document.getElementById('ps-palette-preset');
      const btn = document.getElementById('ps-palette-apply');
      const strip = document.getElementById('ps-palette-strip');
      const auto = document.getElementById('ps-palette-auto');
      return {
        refHits: cnt(['参考数', 'ΔE2000']),
        metaExists: !!document.getElementById('ps-palette-meta'),
        autoExists: !!auto,
        autoRows: auto ? auto.children.length : -1,
        autoMetaKids: auto ? auto.querySelectorAll('.gc-auto-meta').length : -1,
        presetOpts: sel ? sel.options.length : -1,
        presetValue: sel ? sel.value : null,
        applyText: btn ? String(btn.textContent).trim() : '',
        applyDisabled: btn ? btn.disabled : null,
        stripCount: strip ? strip.querySelectorAll('.gc-strip-sw').length : -1,
        stripFirst: (strip && strip.firstChild) ? strip.firstChild.style.background : null
      };
    });
    t.eq('1.3 面板里含「参考数」/「ΔE2000」的可见元素 = 0 个（整行已删）', i1.refHits, 0);
    t.eq('1.4 旧元素 #ps-palette-meta 已不存在', i1.metaExists, false);
    t.eq('1.5 配色行 #ps-palette-auto 仍在', i1.autoExists, true);
    t.eq('1.6 配色行里 `.gc-auto-meta`（参考数）子行 = 0 个', i1.autoMetaKids, 0);
    t.eq('1.6b 配色行共 3 个子行 = 配色 / 按钮+色条 / 超容量提示（12 组用 tableau10 超容量的那一条），' +
      '参考数行若还在会是第 4 行', i1.autoRows, 3);
    t.ok('1.7 预设下拉仍在且选项 ≥ 10（' + i1.presetOpts + ' 项）', i1.presetOpts >= 10, i1.presetOpts);
    t.eq('1.8 预设下拉默认 tableau10', i1.presetValue, 'tableau10');
    t.contains('1.9 一键自动配色按钮仍在且文案未变', i1.applyText, '一键自动配色');
    t.eq('1.10 一键自动配色可用（有图例时不禁用）', i1.applyDisabled, false);
    t.eq('1.11 色条预览段数 = 图例数（12）', i1.stripCount, 12);
    const t10 = await page.evaluate(function () { return window.YMS.Palettes.get('tableau10').colors[0]; });
    t.eq('1.12 色条首段 = tableau10 第 1 色', i1.stripFirst, hexToRgb(t10));

    /* 超容量分支：12 个图例 + set1（上限 9）→ 旧的「⚠ 超出上限 3 个 → 建议改用 Kelly 22」也不许出现 */
    const over = await page.evaluate(function () {
      window.YMS.PlotSettings.setPalettePreset('set1');
      window.YMS.PlotSettings.render();
      const cnt = function (words) {
        const body = document.getElementById('plot-settings-body');
        const all = body.querySelectorAll('*');
        let hits = 0;
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.children && el.children.length) continue;
          const txt = String(el.textContent || '');
          if (!txt) continue;
          if (!words.some(function (w) { return txt.indexOf(w) >= 0; })) continue;
          if (el.offsetParent === null) continue;
          hits++;
        }
        return hits;
      };
      const warn = document.getElementById('ps-palette-warn');
      const sel = document.getElementById('ps-palette-preset');
      const pv = window.YMS.PlotSettings.palettePreview('set1');
      return {
        refHits: cnt(['参考数', 'ΔE2000', '超出上限']),
        metaExists: !!document.getElementById('ps-palette-meta'),
        warn: warn ? String(warn.textContent) : '',
        over: pv.over, cap: pv.capacity, n: pv.n, suggest: pv.suggest,
        kellyOpt: sel ? Array.prototype.slice.call(sel.options).some(function (o) { return o.value === 'kelly22'; }) : false,
        kellyLabel: sel ? (Array.prototype.slice.call(sel.options).filter(function (o) { return o.value === 'kelly22'; })[0] || {}).textContent : ''
      };
    });
    t.eq('1.13 超容量时「参考数 / ΔE2000 / 超出上限」可见元素仍 = 0 个', over.refHits, 0);
    t.eq('1.14 超容量时 #ps-palette-meta 仍不存在', over.metaExists, false);
    t.eq('1.15 超容量提示条仍提示「循环 + 明度分层」（信息没跟着删）', over.warn.indexOf('循环 + 明度分层') >= 0, true);
    t.eq('1.16 超容量仍建议换预设（Kelly 22）', over.warn.indexOf('Kelly 22') >= 0, true);
    t.eq('1.17 超容量时预设下拉仍列出 Kelly 22（功能层）', over.kellyOpt, true);
    t.contains('1.18 Kelly 22 选项文本带容量', over.kellyLabel, 'Kelly 22（22）');
    t.eq('1.19 预览仍算出「12 个图例 / set1 上限 9 / 超容量」', over.over + '/' + over.cap + '/' + over.n, 'true/9/12');
    t.eq('1.20 预览仍算出建议预设 kelly22', over.suggest, 'kelly22');

    /* 还原 tableau10，后面的分组配色断言在干净状态下做 */
    await page.evaluate(function () {
      window.YMS.PlotSettings.setPalettePreset('tableau10');
      window.YMS.PlotSettings.render();
    });
    await page.waitForTimeout(150);

    /* ==================================================================
       2. I2 · 分组配色 = 一行「下拉选组 + 色块按钮」
       ================================================================== */
    const structure = await page.evaluate(function () {
      const host = document.getElementById('ps-group-colors');
      const sel = document.getElementById('ps-gc-select');
      const sw = document.getElementById('ps-gc-swatch');
      const rows = window.YMS.PlotSettings.groupColorRows();
      return {
        host: !!host,
        sel: !!sel,
        sw: !!sw,
        opts: sel ? sel.options.length : -1,
        optValues: sel ? Array.prototype.slice.call(sel.options).map(function (o) { return o.value; }) : [],
        optLabels: sel ? Array.prototype.slice.call(sel.options).map(function (o) { return String(o.textContent).trim(); }) : [],
        value: sel ? sel.value : null,
        rowKeys: rows.map(function (r) { return r.key; }),
        oldRows: document.querySelectorAll('#ps-group-colors .gc-row').length,
        oldList: document.querySelectorAll('#ps-group-colors .gc-list').length,
        oldPal: document.querySelectorAll('#ps-group-colors .gc-pal').length,
        oldMore: document.querySelectorAll('#ps-group-colors .gc-more').length,
        presetsOpen: document.querySelectorAll('#ps-group-colors .gc-presets').length,
        swBg: sw ? window.getComputedStyle(sw).backgroundColor : null,
        swKey: sw ? sw.getAttribute('data-gc-key') : null,
        count: (function () {
          const c = host ? host.querySelector('.gc-count') : null;
          return c ? String(c.textContent).trim() : '';
        })(),
        resetBtn: !!document.getElementById('ps-group-colors-reset'),
        pickW: (function () {
          const p = document.getElementById('ps-gc-pick');
          return p ? Math.round(p.getBoundingClientRect().width) : -1;
        })(),
        pickH: (function () {
          const p = document.getElementById('ps-gc-pick');
          return p ? Math.round(p.getBoundingClientRect().height) : -1;
        })(),
        hostW: host ? Math.round(host.getBoundingClientRect().width) : -1,
        hostH: host ? Math.round(host.getBoundingClientRect().height) : -1
      };
    });
    t.eq('2.1 分组配色区块 #ps-group-colors 仍在', structure.host, true);
    t.eq('2.2 下拉 #ps-gc-select 存在', structure.sel, true);
    t.eq('2.3 色块按钮 #ps-gc-swatch 存在', structure.sw, true);
    t.eq('2.4 下拉选项数 = 分组数（12）', structure.opts, 12);
    t.eq('2.5 下拉选项值 = 全部组键且顺序一致', structure.optValues.join(','), structure.rowKeys.join(','));
    t.eq('2.6 下拉选项文本带组名（T01…T12）', structure.optLabels.join(','), keys(12).join(','));
    t.eq('2.7 下拉默认选中第一组', structure.value, structure.rowKeys[0]);
    t.eq('2.8 色块显示所选组的颜色（键 = 首组）', structure.swKey, structure.rowKeys[0]);
    const altPal = await page.evaluate(function () { return window.YMS.ChartBuilder.PALETTE_ALT; });
    t.eq('2.9 色块初值 = 该组默认调色板第 1 色', structure.swBg, hexToRgb(altPal[0]));
    /* 反向守卫：旧的竖排结构一个元素都不许留 */
    t.eq('2.10 旧竖排行 .gc-row = 0（列表已压成一行）', structure.oldRows, 0);
    t.eq('2.11 旧 .gc-list = 0', structure.oldList, 0);
    t.eq('2.12 旧 .gc-pal（▦ 按钮）= 0', structure.oldPal, 0);
    t.eq('2.13 旧「仅显示前 N 组」提示 .gc-more = 0', structure.oldMore, 0);
    t.eq('2.14 预设条默认收起', structure.presetsOpen, 0);
    t.eq('2.15 「N 组 · 已自定义 M」计数仍在（初始无自定义）', structure.count, '12 组');
    t.eq('2.16 「恢复默认」按钮仍在', structure.resetBtn, true);
    t.ok('2.17 一行放得下（行宽 ' + structure.pickW + ' ≤ 区块宽 ' + structure.hostW + '）',
      structure.pickW > 0 && structure.pickW <= structure.hostW + 1, { pick: structure.pickW, host: structure.hostW });

    /* 切换下拉：只切「编辑哪一组」，颜色一个都不动 */
    const sw1 = await page.evaluate(function () {
      const sel = document.getElementById('ps-gc-select');
      const before = JSON.parse(JSON.stringify(window.__YMS__.getState().plot.group.colors || {}));
      sel.value = 'T03';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { before: before };
    });
    await page.waitForTimeout(160);
    const sw2 = await page.evaluate(function () {
      const sel = document.getElementById('ps-gc-select');
      const sw = document.getElementById('ps-gc-swatch');
      return {
        value: sel.value,
        colors: JSON.parse(JSON.stringify(window.__YMS__.getState().plot.group.colors || {})),
        swKey: sw.getAttribute('data-gc-key'),
        swBg: window.getComputedStyle(sw).backgroundColor,
        alt: window.YMS.ChartBuilder.PALETTE_ALT
      };
    });
    t.eq('2.18 切换后下拉选中第 3 组', sw2.value, 'T03');
    t.eq('2.19 切换下拉不改任何颜色（colors 前后逐键一致）',
      JSON.stringify(sw2.colors), JSON.stringify(sw1.before));
    t.eq('2.20 色块跟着切到第 3 组', sw2.swKey, 'T03');
    t.eq('2.21 色块显示第 3 组的默认色', sw2.swBg, hexToRgb(sw2.alt[2]));

    /* 点色块 → 展开 12 色预设 + 系统取色器 */
    const open = await page.evaluate(function () {
      document.getElementById('ps-gc-swatch').click();
      const strip = document.querySelector('#ps-group-colors .gc-presets');
      const btns = strip ? strip.querySelectorAll('.gc-preset') : [];
      return {
        strip: !!strip,
        forKey: strip ? strip.getAttribute('data-gc-for') : null,
        count: btns.length,
        first: btns[0] ? btns[0].getAttribute('data-gc-preset') : null,
        picker: !!document.getElementById('ps-gc-color'),
        pickerTag: (function () {
          const i = document.getElementById('ps-gc-color');
          return i ? (i.tagName + ':' + i.type) : null;
        })()
      };
    });
    t.eq('2.22 点色块展开预设条 .gc-presets', open.strip, true);
    t.eq('2.23 预设条挂当前组（data-gc-for = T03）', open.forKey, 'T03');
    t.eq('2.24 预设条仍是原 12 色', open.count, 12);
    t.eq('2.25 预设条里有系统取色器 input[type=color]', open.pickerTag, 'INPUT:color');

    /* 点预设第 5 色 → 立即生效（草稿 / 图 / 色块 / 状态栏）
       注意：图表实例是**延迟创建**的（applyPlot 后下一帧才 register），先等实例就绪再取基线色。 */
    await page.waitForFunction(function () {
      const c = (window.YMS.PlotView.charts || [])[0];
      return !!(c && c.chart && c.chart.getOption && (c.chart.getOption().series || []).length);
    }, null, { timeout: 8000 });
    const seriesBefore = await page.evaluate(function () {
      const opt = window.YMS.PlotView.charts[0].chart.getOption();
      const named = (opt.series || []).filter(function (s) { return String(s.name || '').indexOf('T03') >= 0; });
      return {
        all: (opt.series || []).map(function (s) { return (s.itemStyle || {}).color || null; }),
        t03: named.length ? ((named[0].itemStyle || {}).color || null) : null
      };
    });
    const presetHex = await page.evaluate(function (all) {
      const strip = document.querySelector('#ps-group-colors .gc-presets');
      const btns = Array.prototype.slice.call(strip.querySelectorAll('.gc-preset'));
      /* 挑一个「基线里还没被任何系列占用」的预设色，这样「新色出现 + 旧色退场」两个方向都能判 */
      const pickBtn = btns.filter(function (b) {
        return all.indexOf(b.getAttribute('data-gc-preset')) < 0;
      })[0] || btns[4];
      const hex = pickBtn.getAttribute('data-gc-preset');
      pickBtn.click();
      return hex;
    }, seriesBefore.all);
    await page.waitForTimeout(150);
    const pick = await page.evaluate(function (hex) {
      const opt = window.YMS.PlotView.charts[0].chart.getOption();
      const series = opt.series || [];
      const sw = document.getElementById('ps-gc-swatch');
      const status = document.querySelector('#status-bar, .status-bar, #statusbar');
      const named = series.filter(function (s) { return String(s.name || '').indexOf('T03') >= 0; });
      return {
        hex: hex,
        namedColors: named.map(function (s) { return (s.itemStyle || {}).color || null; }),
        seriesColors: series.map(function (s) { return (s.itemStyle || {}).color || null; }),
        stored: (window.__YMS__.getState().plot.group.colors || {})['T03'],
        swBg: window.getComputedStyle(sw).backgroundColor,
        isCustom: sw.className.indexOf('is-custom') >= 0,
        count: (function () {
          const c = document.querySelector('#ps-group-colors .gc-count');
          return c ? String(c.textContent).trim() : '';
        })(),
        statusText: status ? String(status.textContent) : '',
        resetDisabled: document.getElementById('ps-group-colors-reset').disabled
      };
    }, presetHex);
    t.eq('2.26 点预设 → 写进草稿 colors[T03]', pick.stored, pick.hex);
    t.ok('2.27 图上该系列颜色真的变了（T03 系列 itemStyle.color = 新色 ' + pick.hex + '）',
      pick.namedColors.length > 0 && pick.namedColors.every(function (c) { return c === pick.hex; }),
      { named: pick.namedColors, hex: pick.hex });
    t.ok('2.27b 该系列旧色退场（T03 原来是 ' + seriesBefore.t03 + '，现在是 ' + pick.namedColors[0] + '）',
      pick.namedColors[0] !== seriesBefore.t03, { before: seriesBefore.t03, after: pick.namedColors[0] });
    t.eq('2.28 色块背景色跟着变', pick.swBg, hexToRgb(pick.hex));
    t.eq('2.29 色块标记为自定义（is-custom）', pick.isCustom, true);
    t.contains('2.30 计数变成「12 组 · 已自定义 1」', pick.count, '已自定义 1');
    t.contains('2.31 状态栏给出「分组配色已应用」提示', pick.statusText, '分组配色已应用');
    t.eq('2.32 有自定义色后「恢复默认」变为可用', pick.resetDisabled, false);

    /* 换到别组再切回来：自定义色不丢 */
    const keep = await page.evaluate(function () {
      const sel = document.getElementById('ps-gc-select');
      sel.value = 'T07';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const mid = JSON.parse(JSON.stringify(window.__YMS__.getState().plot.group.colors || {}));
      const sel2 = document.getElementById('ps-gc-select');
      sel2.value = 'T03';
      sel2.dispatchEvent(new Event('change', { bubbles: true }));
      return { mid: mid, back: (window.__YMS__.getState().plot.group.colors || {})['T03'] };
    });
    t.eq('2.33 切到别组再切回来，自定义色仍在', keep.back, pick.hex);
    t.eq('2.34 来回切换没有多写/漏写颜色（仍只有 1 项）', Object.keys(keep.mid).length, 1);

    /* 随 .yms 保存（白名单没过滤 plot.group.colors） */
    const rt = await page.evaluate(function () {
      const hex = (window.__YMS__.getState().plot.group.colors || {})['T03'];
      const snap = JSON.parse(JSON.stringify(window.__YMS__.saveYms()));
      window.__YMS__.applyPlot({ group: { colorBy: 'Tool', symbolBy: '', colors: {}, preset: 'tableau10', autoN: 0 } });
      const cleared = (window.__YMS__.getState().plot.group.colors || {})['T03'] || null;
      window.__YMS__.loadYms(snap);
      const back = (window.__YMS__.getState().plot.group.colors || {})['T03'] || null;
      return { hex: hex, cleared: cleared, back: back };
    });
    t.ok('2.35 改色前已写入（' + rt.hex + '）', /^#[0-9a-fA-F]{6}$/.test(String(rt.hex)), rt.hex);
    t.eq('2.36 清空后确实丢了（对照组）', rt.cleared, null);
    t.eq('2.37 .yms 往返后自定义色还原（随存档保存）', rt.back, rt.hex);

    /* 恢复默认：清空自定义 + 色块回到默认色 */
    const reset = await page.evaluate(function () {
      document.getElementById('ps-group-colors-reset').click();
      const sw = document.getElementById('ps-gc-swatch');
      return {
        colors: Object.keys(window.__YMS__.getState().plot.group.colors || {}).length,
        swBg: window.getComputedStyle(sw).backgroundColor,
        alt: window.YMS.ChartBuilder.PALETTE_ALT,
        disabled: document.getElementById('ps-group-colors-reset').disabled,
        count: (function () {
          const c = document.querySelector('#ps-group-colors .gc-count');
          return c ? String(c.textContent).trim() : '';
        })()
      };
    });
    t.eq('2.38 「恢复默认」清空全部自定义色', reset.colors, 0);
    t.eq('2.39 恢复默认后色块回到该组默认色', reset.swBg, hexToRgb(reset.alt[2]));
    t.eq('2.40 恢复默认后按钮自身禁用（无可恢复项）', reset.disabled, true);
    t.eq('2.41 恢复默认后计数回到「12 组」（无已自定义）', reset.count, '12 组');

    /* 空态 ①：直方图 */
    const histEmpty = await page.evaluate(function () {
      window.YMS.PlotSettings.setType('hist');
      const el = document.querySelector('#ps-group-colors .gc-empty');
      return {
        text: el ? String(el.textContent).trim() : '',
        visible: el ? (el.offsetParent !== null) : false,
        sel: !!document.getElementById('ps-gc-select')
      };
    });
    t.eq('2.42 空态：直方图给出「单系列固定色」文案', histEmpty.text, '直方图为单系列固定色，不支持分组配色');
    t.eq('2.43 空态文案可见', histEmpty.visible, true);
    t.eq('2.44 空态下不渲染下拉（无分组可编辑）', histEmpty.sel, false);

    /* 空态 ②：未分组（无系列可列） */
    const ungrouped = await page.evaluate(function () {
      window.__YMS__.applyPlot({
        type: 'bar', x: [], values: [], sorters: [],
        group: { colorBy: '', symbolBy: '', colors: {}, preset: 'tableau10', autoN: 0 }, rendered: true
      });
      window.__YMS__.submitPlot({});
      window.YMS.PlotSettings.render();
      const el = document.querySelector('#ps-group-colors .gc-empty');
      return {
        text: el ? String(el.textContent).trim() : '',
        rows: window.YMS.PlotSettings.groupColorRows().length,
        sel: !!document.getElementById('ps-gc-select')
      };
    });
    t.eq('2.45 未分组时分组列表为空（对照）', ungrouped.rows, 0);
    t.eq('2.46 空态：未分组给出「按系列取默认色板」文案', ungrouped.text, '未分组：按系列取默认色板');
    t.eq('2.47 未分组空态下不渲染下拉', ungrouped.sel, false);

    /* 分组数 > 16 时不再截断（下拉天然容纳全部） */
    const many = await (async function () {
      await app.importText(page, 'slim20.csv', csvN(20));
      await makeBar(page, 20, 'tableau10');
      return page.evaluate(function () {
        const sel = document.getElementById('ps-gc-select');
        const host = document.getElementById('ps-group-colors');
        return {
          opts: sel ? sel.options.length : -1,
          rows: window.YMS.PlotSettings.groupColorRows().length,
          more: document.querySelectorAll('#ps-group-colors .gc-more').length,
          hasTruncText: String(host ? host.textContent : '').indexOf('仅显示前') >= 0,
          hostH: host ? Math.round(host.getBoundingClientRect().height) : -1,
          pickH: (function () {
            const p = document.getElementById('ps-gc-pick');
            return p ? Math.round(p.getBoundingClientRect().height) : -1;
          })()
        };
      });
    })();
    t.eq('2.48 20 组时下拉选项数 = 20（不再截断到前 16 组）', many.opts, 20);
    t.eq('2.49 20 组时无「仅显示前 N 组」提示', many.more, 0);
    t.eq('2.50 面板文案里没有「仅显示前」', many.hasTruncText, false);
    t.eq('2.51 20 组时「下拉 + 色块」这一行的高度与 12 组时完全相同（不随组数增长）',
      many.pickH, structure.pickH);
    t.ok('2.52 20 组时区块总高 ' + many.hostH + 'px 远小于「20 行竖排列表」所需（≈' + (20 * 21) +
      'px），差值只来自超容量提示的文字折行', many.hostH > 0 && many.hostH < 20 * 21 / 2, many.hostH);

    /* ==================================================================
       3. I3 · 「3 · 防拥挤合并」下的 merge-on 说明行已删（hist 说明保留）
       ================================================================== */
    await app.importText(page, 'slim12b.csv', csvN(12));
    await makeBar(page, 12, 'tableau10');
    const boxNote = await page.evaluate(function () {
      window.YMS.PlotSettings.setType('box');
      const body = document.getElementById('plot-settings-body');
      const onEl = body.querySelector('[data-note="merge-on"]');
      const naEl = body.querySelector('[data-note="merge-hist-na"]');
      const grp = (function () {
        const notes = body.querySelectorAll('.ps-note');
        for (let i = 0; i < notes.length; i++) {
          const g = notes[i].closest('.setting-group');
          if (g && String(g.querySelector('.group-title').textContent).indexOf('防拥挤合并') >= 0) return g;
        }
        const titles = body.querySelectorAll('.setting-group');
        for (let i = 0; i < titles.length; i++) {
          const ti = titles[i].querySelector('.group-title');
          if (ti && String(ti.textContent).indexOf('防拥挤合并') >= 0) return titles[i];
        }
        return null;
      })();
      return {
        onCount: body.querySelectorAll('[data-note="merge-on"]').length,
        onExists: !!onEl,
        naExists: !!naEl,
        bodyHasOnText: String(body.textContent).indexOf('分组带自动启用：X 轴含多个参数列时') >= 0,
        groupChildren: grp ? grp.children.length : -1,
        groupH: grp ? Math.round(grp.getBoundingClientRect().height) : -1,
        fieldH: (function () {
          const f = grp ? grp.querySelector('.field') : null;
          return f ? Math.round(f.getBoundingClientRect().height) : -1;
        })(),
        titleH: (function () {
          const ti = grp ? grp.querySelector('.group-title') : null;
          return ti ? Math.round(ti.getBoundingClientRect().height) : -1;
        })(),
        fieldBottomGap: (function () {
          const f = grp ? grp.querySelector('.field') : null;
          if (!f) return -1;
          const gr = grp.getBoundingClientRect(), fr = f.getBoundingClientRect();
          return Math.round(gr.bottom - fr.bottom);
        })(),
        /* 对照：一个「标题 + 2 个字段」的普通组，最后一个字段到组底的间距（= 组自身的 padding） */
        refPad: (function () {
          const gs = body.querySelectorAll('.setting-group');
          for (let i = 0; i < gs.length; i++) {
            const ti = gs[i].querySelector('.group-title');
            if (!ti || String(ti.textContent).indexOf('2 · 排版') < 0) continue;
            const kids = gs[i].children;
            const last = kids[kids.length - 1];
            return Math.round(gs[i].getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
          }
          return -2;
        })()
      };
    });
    t.eq('3.1 box：[data-note="merge-on"] 元素数 = 0', boxNote.onCount, 0);
    t.eq('3.2 box：面板里已无「分组带自动启用：X 轴含多个参数列时…」文案', boxNote.bodyHasOnText, false);
    t.eq('3.3 box：该组只剩「标题 + 合并字段」两个子元素（说明行没留空壳）', boxNote.groupChildren, 2);
    t.eq('3.4 box：组底内边距 == 单字段组「2 · 排版」的组底内边距（没留空白行）',
      boxNote.fieldBottomGap, boxNote.refPad);

    const histNote = await page.evaluate(function () {
      window.YMS.PlotSettings.setType('hist');
      const body = document.getElementById('plot-settings-body');
      const naEl = body.querySelector('[data-note="merge-hist-na"]');
      const onEl = body.querySelector('[data-note="merge-on"]');
      const grp = naEl ? naEl.closest('.setting-group') : null;
      return {
        naExists: !!naEl,
        naVisible: naEl ? (naEl.offsetParent !== null && naEl.getBoundingClientRect().height > 0) : false,
        naText: naEl ? String(naEl.textContent).trim() : '',
        onCount: body.querySelectorAll('[data-note="merge-on"]').length,
        onExists: !!onEl,
        title: grp ? String(grp.querySelector('.group-title').textContent).trim() : '',
        groupH: grp ? Math.round(grp.getBoundingClientRect().height) : -1
      };
    });
    t.eq('3.6 hist：[data-note="merge-hist-na"] 仍存在（不许连它一起删）', histNote.naExists, true);
    t.eq('3.7 hist：该说明行仍可见', histNote.naVisible, true);
    t.contains('3.8 hist：文案仍是「直方图的 X 轴是数值分箱…分组带不适用」', histNote.naText, '直方图的 X 轴是数值分箱');
    t.contains('3.9 hist：仍给出替代入口（柱数）', histNote.naText, '柱数');
    t.eq('3.10 hist：说明行确实挂在「3 · 防拥挤合并」组里', histNote.title, '3 · 防拥挤合并');
    t.eq('3.11 hist：merge-on 在任何图型下都不出现', histNote.onCount, 0);
    t.ok('3.12 高度差：hist 组（含说明行 ' + histNote.groupH + 'px）> box 组（' + boxNote.groupH +
      'px），差 ' + (histNote.groupH - boxNote.groupH) + 'px 正是被删掉的那一行',
      histNote.groupH > boxNote.groupH, { hist: histNote.groupH, box: boxNote.groupH });

    /* ==================================================================
       4. 登记证明 + 页面健康
       ================================================================== */
    const fsx = ctx.require('fs');
    const pathx = ctx.require('path');
    const runSrc = fsx.readFileSync(pathx.join(__dirname, '..', 'run.js'), 'utf8');
    t.contains('4.1 本用例已登记进 run.js 的 CASE_FILES（否则运行器静默不跑、看着全绿其实没测）',
      runSrc, "'settings-ui-slim.js'");
    t.eq('4.2 用例文件真实存在：test/cases/settings-ui-slim.js',
      fsx.existsSync(pathx.join(__dirname, 'settings-ui-slim.js')), true);
    t.noErrors('4.3 零未捕获异常 / 控制台错误', ctx.errors);
  }
};
