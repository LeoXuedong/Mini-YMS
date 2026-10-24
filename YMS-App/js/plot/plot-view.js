/* ==========================================================================
   YMS · plot/plot-view.js
   ---------------------------------------------------------------------------
   职责：绘图视图（#plot-tabs + #plot-canvas-wrap）
     · render()：Aggregate.build() → 页签 → 按排版生成 .chart-grid / .chart-card
       （卡片头 = 标题 + ⛶），只为当前页（及视口内）卡片 echarts.init + setOption
     · 图表 lazy init（IntersectionObserver），render 前 dispose 旧实例
     · 窗口 resize（debounce 150ms）→ resizeAll()
     · 卡片双击 / ⛶ → YMS.Fullscreen.open(扁平序号)
     · 更新 Store.state.plot.activePage、Store.state.ui.lastRenderMs、#plot-tabs 信息
     · 无数据 / 未配置 → #plot-canvas-wrap 显示 .empty-hint 引导文案

   数据来源：只读 YMS.Store（配置）+ YMS.Aggregate（聚合），
             绘图实例通过 YMS.ChartBuilder.buildOption 生成 option。
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var P;

  var THEME_NAME = 'yms-registered';
  var MIN_CARD_H = 240;
  var MAX_CARD_H = 1400;
  var ROOT_MARGIN = '260px';
  /* 迭代 8（空间利用）：单图页（每页仅 1 张图）卡片宽度上限 —— 防止被拉成超宽扁条；
     多图页一律铺满各自网格单元（去掉迭代 5 起「一刀切」的 760px 限制）。 */
  var SINGLE_MAX_W = 900;
  /* 图内顶部「死留白」回收下限：右上角 toolbox（top:4 + itemSize:13）占 4~17px，
     grid.top 不低于 24px 才能保证工具按钮不与绘图区重叠。 */
  var GRID_TOP_MIN = 24;
  /* 无右轴时的右侧留白：原 18px（其中大部分是给右轴标题/图标预留的余量）→ 12px（仍留视觉边距） */
  var GRID_RIGHT_NOAXIS = 12;
  /* 末行不满时的细分轨道上限（cols ≤ 6 → 6×6 = 36 覆盖所有 best 排版组合；超过则不再细分） */
  var MAX_SUB_TRACKS = 36;

  function U() { return YMS.util; }
  function A() { return YMS.Aggregate; }
  function CB() { return YMS.ChartBuilder; }
  function Store() { return YMS.Store; }

  /* ------------------------------------------------------------- 状态 */
  var dom = { tabs: null, wrap: null };
  var work = null;                                    // 最近一次 Aggregate.build()
  var instances = [];                                 // 当前页已登记的图表实例
  var pageIndex = 0;
  var observer = null;
  var inited = false;
  var rendering = false;
  var themeReady = false;
  var onResize = null;

  /* ------------------------------------------------------------- 小工具 */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * 依排版计算列数、行数与卡片高度（高度按可用高度均分，保证网格撑满绘图区）
   * 最佳排版列数（{@link https://echarts} 之外的约定，见集成烟测反馈）：
   *   n≤1→1；n=2~4→2（=ceil(sqrt(n))）；n=5~9→3；n=10~12→4；n>12→ceil(sqrt(n*1.2))，最多 6 列
   * @param {number} n 本页图表数
   * @param {{mode:string,rows:number,cols:number}} cfg layout 配置
   * @param {number} [viewportH] 视口高度（缺省用 window.innerHeight；测试可显式传入）
   * @param {number} [availH] 实测可用高度（迭代 8：优先用绘图区真实内容高度，
   *        比 vh-200 的粗估更贴边，避免卡片下方留出一条空白带；测试/PPT 走 vh 估算路径）
   */
  function layoutSize(n, cfg, viewportH, availH) {
    n = Math.max(1, Math.floor(Number(n) || 1));
    var mode = (cfg && cfg.mode) || 'best';
    var cols;
    if (mode === 'rc') {
      cols = clamp(Math.floor(Number(cfg.cols) || 1), 1, 12);
    } else {
      if (n <= 1) cols = 1;
      else if (n <= 12) cols = Math.ceil(Math.sqrt(n));
      else cols = Math.ceil(Math.sqrt(n * 1.2));
      cols = clamp(cols, 1, 6);
    }
    var rows;
    if (mode === 'rc') {
      rows = clamp(Math.floor(Number(cfg.rows) || 1), 1, 12);
      rows = Math.max(rows, Math.ceil(n / cols));
    } else {
      rows = Math.max(1, Math.ceil(n / cols));
    }
    var avail;
    if (availH !== undefined && availH !== null && isFinite(availH) && availH > 0) {
      avail = Math.max(360, Math.floor(availH));      // 实测可用高度（已扣 padding）
    } else {
      var vh = (viewportH === undefined || viewportH === null) ? (global.innerHeight || 900) : viewportH;
      avail = Math.max(360, vh - 200);               // 扣掉标题栏/状态栏/页签的大致高度
    }
    var gap = 10;
    var cardH = Math.round(clamp(Math.floor((avail - (rows - 1) * gap) / rows), MIN_CARD_H, MAX_CARD_H));
    return { cols: cols, rows: rows, cardH: cardH };
  }

  /** 绘图区真实可用内容尺寸（宽 × 高，已扣 padding）；取不到/过小时返回 null（走 vh 估算兜底） */
  function measureAvail() {
    var wrap = dom.wrap;
    if (!wrap) return null;
    try {
      var cs = global.getComputedStyle ? global.getComputedStyle(wrap) : null;
      var num2 = function (v) { var x = parseFloat(v); return isFinite(x) ? x : 0; };
      var pl = cs ? num2(cs.paddingLeft) : 0, pr = cs ? num2(cs.paddingRight) : 0;
      var pt = cs ? num2(cs.paddingTop) : 0, pb = cs ? num2(cs.paddingBottom) : 0;
      var w = num2(wrap.clientWidth) - pl - pr;
      var h = num2(wrap.clientHeight) - pt - pb;
      if (!isFinite(w) || !isFinite(h) || w < 120 || h < 120) return null;
      return { w: w, h: h };
    } catch (e) { return null; }
  }

  /**
   * 把排版应用到 .chart-grid：
   *   · 列：默认 repeat(cols, minmax(0,1fr))；末行不满时改用「细分轨道 + span」，
   *     让末行卡片等宽铺满整行（消除右下角的大片空白带）
   *   · 行：repeat(rows, minmax(240px, 1fr)) —— 行高拉伸铺满绘图区，卡片高度 = 行高
   *   · 每页仅 1 张图（n=1）时给网格加 .is-single（plot.css：宽度上限 900px 居中）
   * @param {Element} grid .chart-grid
   * @param {{cols:number,rows:number,cardH:number}} size layoutSize 结果
   * @param {number} n 本页图表数
   */
  function applyGridStyle(grid, size, n) {
    if (!grid) return;
    var count = Math.max(1, Math.floor(Number(n) || 1));
    var cols = size.cols, rows = size.rows;
    /* 迭代 11（用户报障）：同页多图一律等宽等高。
       旧实现为「消除右下空白带」在末行不满时把每行细分成 cols×last 条轨道、让末行卡片跨
       cols 条轨道 —— 结果末行 2 张卡片比首行 3 张宽 1.5×（实测 681 vs 450.7px），
       同一页面图片大小不一致。现改为等宽轨道，末行不足部分留空（卡片左对齐）。 */
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    grid.style.gridAutoRows = size.cardH + 'px';
    grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(' + MIN_CARD_H + 'px, 1fr))';
    if (grid.classList) grid.classList.toggle('is-single', count === 1);
    var cards = grid.children;
    for (var c = 0; c < cards.length; c++) {
      if (cards[c].style.gridColumn) cards[c].style.gridColumn = '';
      cards[c].style.height = size.cardH + 'px';
    }
  }

  /**
   * 迭代 8：压掉图内「死留白」（不改 chart-builder / axis，只在 option 落地前做等价的留白归一）
   *   ① 图内 Title 自迭代 7 起已置空，但 layoutBox 仍按「标题块高度 titleSize×1.35」预留
   *      grid.top 与 legend.top —— 无副标题时把这块整体收回（两处同步平移，
   *      保持「grid.top ≥ legend.top + 图例高 + 6」的不遮挡约束不变），下限 GRID_TOP_MIN
   *      （给右上角 toolbox 让位，避免工具按钮压到绘图区）。
   *   ② 右侧留白：只有存在右轴时才需要（右轴另有 ≥24px 预留）；无右轴时 18 → 12。
   * @param {object} opt ChartBuilder.buildOption 的返回值（就地修改）
   * @returns {object} opt
   */
  function tightenOption(opt) {
    if (!opt) return opt;
    var g = (opt.grid && opt.grid[0]) ? opt.grid[0] : (Array.isArray(opt.grid) ? null : opt.grid);
    if (!g) return opt;
    var top = Number(g.top);
    if (!isFinite(top)) top = 0;
    var t = (opt.title && opt.title[0]) ? opt.title[0] : (Array.isArray(opt.title) ? null : opt.title);
    var hasTitle = !!(t && t.text && String(t.text).length);
    var sub = (t && t.subtext) ? String(t.subtext) : '';
    if (!hasTitle && !sub && top > GRID_TOP_MIN) {
      var fontSize = (t && t.textStyle && Number(t.textStyle.fontSize)) || 13;
      var titleH = fontSize * 1.35;                             // 与 chart-builder 的 titleH 同式
      var shift = Math.min(titleH, top - GRID_TOP_MIN);
      if (shift > 0.5) {
        g.top = Math.round(top - shift);
        var lg = (opt.legend && opt.legend[0]) ? opt.legend[0] : (Array.isArray(opt.legend) ? null : opt.legend);
        if (lg && typeof lg.top === 'number' && isFinite(lg.top) && lg.top >= shift) {
          lg.top = Math.round(lg.top - shift);                  // 图例同步上移，保持不遮挡关系
        }
      }
    }
    var right = Number(g.right);
    /* 任务 F：图例挪到右侧时 grid.right 是**给图例让位的空间**，不许归一成 12 */
    var lgOpt = (opt.legend && opt.legend[0]) ? opt.legend[0] : (Array.isArray(opt.legend) ? null : opt.legend);
    var legendSide = '';
    if (lgOpt && lgOpt.show !== false) {
      var lgPos = opt.__legend && opt.__legend.position;
      if (!lgPos) {
        if (lgOpt.right !== undefined && lgOpt.right !== null) lgPos = 'right';
        else if (lgOpt.bottom !== undefined && lgOpt.bottom !== null) lgPos = 'bottom';
        else if (lgOpt.left !== undefined && lgOpt.left !== null && lgOpt.left !== 'center') lgPos = 'left';
      }
      legendSide = lgPos || '';
    }
    /* 右侧外框轴恒存在（chart-builder 会给上/右各补一条 silent 外框轴），
       故「是否需要右侧留白」看是否真有挂在右轴（yAxisIndex=1）的数据系列 */
    var hasRightAxis = false;
    var se = opt.series ? (Array.isArray(opt.series) ? opt.series : [opt.series]) : [];
    for (var i = 0; i < se.length; i++) {
      if (se[i] && Number(se[i].yAxisIndex) === 1) { hasRightAxis = true; break; }
    }
    if (legendSide === 'right') return opt;
    if (!hasRightAxis && isFinite(right) && right > GRID_RIGHT_NOAXIS) g.right = GRID_RIGHT_NOAXIS;
    return opt;
  }

  function pageOf(i) {
    if (!work || !work.pages || !work.pages.length) return null;
    var idx = clamp(Math.floor(Number(i) || 0), 0, work.pages.length - 1);
    return work.pages[idx];
  }

  /** 打开放大视图（范围 = 全部页全部小图的扁平序号，0 基） */
  function openFullscreen(index) {
    if (!YMS.Fullscreen || typeof YMS.Fullscreen.open !== 'function') {
      U().toast('放大视图模块尚未载入', 'warn');
      return;
    }
    YMS.Fullscreen.open(index);
  }

  /* ------------------------------------------------------- 图表实例管理 */
  /**
   * 登记图表实例（Fullscreen / Report 也会用到同样的登记方式）
   * @param {number} index 扁平序号
   * @param {object} chart ECharts 实例
   */
  function register(index, chart) {
    if (!chart) return null;
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].chart === chart) { instances[i].index = index; return instances[i]; }
    }
    var meta = null;
    try { meta = A().chartOf(work, index); } catch (e) { meta = null; }
    var rec = { el: chart.getDom ? chart.getDom() : null, chart: chart, meta: meta, index: index };
    instances.push(rec);
    return rec;
  }
  /** 注销图表实例（传实例对象） */
  function unregister(chart) {
    for (var i = instances.length - 1; i >= 0; i--) {
      if (instances[i].chart === chart) { instances.splice(i, 1); return true; }
    }
    return false;
  }
  /** 释放当前所有图表实例（render 前调用） */
  function disposeAll() {
    for (var i = 0; i < instances.length; i++) {
      try {
        var c = instances[i].chart;
        if (c && typeof c.off === 'function') c.off('dblclick');
        if (c && typeof c.dispose === 'function') c.dispose();
      } catch (e) { /* 单个实例释放失败不影响其它 */ }
    }
    instances = [];
    if (observer && typeof observer.disconnect === 'function') {
      try { observer.disconnect(); } catch (e2) { /* 忽略 */ }
    }
  }
  /** 当前页图表实例列表 [{el, chart, meta}] */
  function getCharts() {
    return instances.map(function (r) { return { el: r.el, chart: r.chart, meta: r.meta }; });
  }
  /** 全部页图片总数（Work 扁平数） */
  function totalCharts() {
    return (work && work.totalCharts) ? work.totalCharts : 0;
  }
  function pageCount() {
    return (work && work.pages) ? work.pages.length : 0;
  }
  /** 扁平图序列表（Fullscreen 导航 / Report 使用） */
  function getChartMeta() {
    if (!work || !A() || typeof A().metaList !== 'function') return [];
    var list = A().metaList(work);
    for (var i = 0; i < list.length; i++) {
      try {
        var ch = A().chartOf(work, list[i].index);
        if (ch) { list[i].subtext = ch.subtext; list[i].title = ch.title || list[i].title; }
      } catch (e) { /* 忽略单张图的副标题构建失败 */ }
    }
    return list;
  }

  /* --------------------------------------------------------------- 渲染 */
  function renderTabs() {
    var U2 = U();
    if (!dom.tabs) return;
    U2.clear(dom.tabs);
    var pages = (work && work.pages) ? work.pages : [];
    for (var i = 0; i < pages.length; i++) {
      (function (idx) {
        var pg = pages[idx];
        var btn = U2.el('button', {
          class: 'plot-tab' + (idx === pageIndex ? ' is-active' : ''),
          'data-page': idx,
          title: pg.label + '（' + pg.facets.length + ' 张图）',
          text: pg.label
        });
        btn.addEventListener('click', function () { setPage(idx); });
        dom.tabs.appendChild(btn);
      })(i);
    }
    var ms = (Store().state.ui.lastRenderMs === null || Store().state.ui.lastRenderMs === undefined)
      ? '—' : Math.round(Store().state.ui.lastRenderMs) + ' ms';
    var info = U2.el('span', { class: 'tabs-info' }, [
      '共 ' + totalCharts() + ' 张图',
      pages.length > 1 ? ' · 第 ' + (pageIndex + 1) + '/' + pages.length + ' 页' : ' · 单页',
      (work && work.mergeSummary) ? ' · ' + work.mergeSummary : '',
      ' · 渲染 ' + ms
    ]);
    dom.tabs.appendChild(info);
  }

  function emptyHint(msgList) {
    var U2 = U();
    var notes = (msgList && msgList.length) ? msgList : ['尚未绘图 —— 请在右侧「绘图设置区」配置 X Label / Value 后点击 Submit'];
    var html = '<div class="empty-hint plot-empty">';
    html += '<div class="plot-empty-title">' + U2.escapeHtml(notes[0]) + '</div>';
    for (var i = 1; i < notes.length; i++) {
      html += '<div class="plot-empty-note">· ' + U2.escapeHtml(notes[i]) + '</div>';
    }
    html += '</div>';
    return html;
  }

  /* 迭代 10（需求 B）：数据映射未选全（X Label / Value 任一为空）→ 不画空图，显示明确空态提示。
     与 Aggregate 的 notes 无关：这是**配置层**的空态（导入数据后尚未选择参数），
     提示直接指向设置区顶部的「数据映射」分组，避免用户以为软件坏了。 */
  var EMPTY_CONFIG_HINT = '请在上方「数据映射」中选择 X Label 与 Value，然后点击 Submit';

  /** 当前 plot 配置是否缺少 X / Value */
  function configIncomplete() {
    var p = (Store() && Store().state && Store().state.plot) ? Store().state.plot : {};
    return !(p.x && p.x.length) || !(p.values && p.values.length);
  }

  /** 显示「配置为空」的空态（清掉实例与旧卡片/页签，只留一句引导） */
  function showEmptyConfig() {
    if (!dom.wrap) return;
    disposeAll();
    U().clear(dom.wrap);
    dom.wrap.innerHTML = emptyHint([EMPTY_CONFIG_HINT]);
    if (dom.wrap.firstChild) dom.wrap.firstChild.classList.add('plot-empty-wrap');
    if (dom.tabs) {
      U().clear(dom.tabs);
      dom.tabs.appendChild(U().el('span', { class: 'tabs-info', text: '共 0 张图 · 待选择数据映射' }));
    }
    Store().state.ui.lastRenderMs = 0;
  }

  /** 为卡片创建（或复用）ECharts 实例 */
  /** 任务 H：给实例绑定「会触发重排的交互」→ 重新对位箱体（每实例只绑一次） */
  function bindBoxAlign(inst) {
    if (!inst || typeof inst.on !== 'function' || inst.__boxAlignBound) return;
    try { inst.__boxAlignBound = 1; } catch (e0) { return; }
    var run = function () {
      var once = function () {
        try {
          var C = CB();
          if (C && typeof C.alignBoxSeries === 'function') C.alignBoxSeries(inst);
        } catch (e1) { /* 纯视觉修正，失败不影响显示 */ }
      };
      once();
      /* 图例开关是 ECharts 的异步重排：紧随事件的那次可能读到上一帧的图元 → 下一拍再补一次 */
      try { global.setTimeout(once, 40); } catch (e3) { /* 忽略 */ }
    };
    try {
      inst.on('legendselectchanged', run);
      inst.on('restore', run);
    } catch (e2) { /* 事件绑定失败不影响显示 */ }
  }

  function initCard(card) {
    if (!card || card.getAttribute('data-inited') === '1') return;
    var U2 = U();
    var idx = Number(card.getAttribute('data-index'));
    var body = card.querySelector('.chart-body');
    if (!body || !global.echarts) return;
    var chart;
    try { chart = A().chartOf(work, idx); } catch (e) { chart = null; }
    if (!chart) return;
    var inst = null;
    try {
      inst = global.echarts.init(body, themeReady ? THEME_NAME : undefined);
    } catch (e2) {
      U2.toast('图表初始化失败：' + (e2 && e2.message ? e2.message : e2), 'error');
      if (global.console && console.error) console.error('[YMS.PlotView] echarts.init 失败', e2);
      return;
    }
    try {
      var opt = CB().buildOption(chart, work, idx, body);
      tightenOption(opt);                            // 迭代 8：压掉图内死留白（不改 chart-builder）
      inst.setOption(opt, true);
      /* 任务 H：箱体↔数据列对位（ECharts 每次 setOption 都会按「系列总数」重摊箱体 → 每次都要重摆） */
      try {
        var CBa = CB();
        if (CBa && typeof CBa.alignBoxSeries === 'function') CBa.alignBoxSeries(inst);
      } catch (eA) { /* 对位失败不影响显示（是纯视觉修正） */ }
      chart = null;
    } catch (e3) {
      U2.toast('图表渲染失败：' + (e3 && e3.message ? e3.message : e3), 'error');
      if (global.console && console.error) console.error('[YMS.PlotView] setOption 失败', e3);
    }
    card.setAttribute('data-inited', '1');
    register(idx, inst);
    /* 任务 H：图例开关 / 工具箱还原都会让 ECharts 重跑箱线布局（实测关掉一个图例项后
       箱体又偏了 8.54px）→ 这两个动作之后补一次对位（幂等，已对齐时为 0 位移）。 */
    bindBoxAlign(inst);
    try {
      inst.on('dblclick', function () { openFullscreen(idx); });
    } catch (e4) { /* 事件绑定失败不影响显示 */ }
  }

  /** 渲染当前页卡片（DOM 只建当前页；实例 lazy init） */
  function renderPage() {
    var U2 = U();
    if (!dom.wrap) return;
    disposeAll();
    U2.clear(dom.wrap);

    var pages = (work && work.pages) ? work.pages : [];
    var pg = pageOf(pageIndex);
    if (!pg || !pg.facets.length) {
      dom.wrap.innerHTML = emptyHint((work && work.notes) ? work.notes : null);
      if (dom.wrap.firstChild) dom.wrap.firstChild.classList.add('plot-empty-wrap');
      return;
    }
    var n = pg.facets.length;
    var cfg = (Store().state.plot && Store().state.plot.layout) || { mode: 'best' };
    var avail = measureAvail();                        // 迭代 8：优先用实测可用高度
    var size = layoutSize(n, cfg, null, avail ? avail.h : null);

    var grid = U2.el('div', { class: 'chart-grid' });

    var idxOfPage = 0;
    for (var p = 0; p < work.pages.length && work.pages[p] !== pg; p++) idxOfPage += work.pages[p].facets.length;

    for (var f = 0; f < n; f++) {
      var flatIdx = idxOfPage + f;
      var facet = pg.facets[f];
      (function (idx, title) {
        var head = U2.el('div', { class: 'card-head' }, [
          U2.el('span', { class: 'card-title', title: title, text: title }),
          U2.el('div', { class: 'card-tools' }, [
            U2.el('button', {
              class: 'card-tool', title: '放大查看（双击卡片亦可）', text: '⛶',
              onclick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); openFullscreen(idx); }
            })
          ])
        ]);
        var body = U2.el('div', { class: 'chart-body' });
        var card = U2.el('div', {
          class: 'chart-card', 'data-index': idx,
          style: { height: size.cardH + 'px' }
        }, [head, body]);
        card.addEventListener('dblclick', function () { openFullscreen(idx); });
        grid.appendChild(card);
      })(flatIdx, facet.title);
    }
    dom.wrap.appendChild(grid);
    applyGridStyle(grid, size, n);       // 网格撑满绘图区、卡片高度按行均分（末行等宽铺满）

    /* lazy init：视口内（含 260px 余量）卡片才创建 ECharts 实例 */
    var cards = grid.children;
    if (global.IntersectionObserver) {
      try {
        observer = new global.IntersectionObserver(function (entries) {
          for (var k = 0; k < entries.length; k++) {
            if (entries[k].isIntersecting) {
              initCard(entries[k].target);
              observer.unobserve(entries[k].target);
            }
          }
        }, { root: dom.wrap, rootMargin: ROOT_MARGIN, threshold: 0.01 });
        for (var c1 = 0; c1 < cards.length; c1++) observer.observe(cards[c1]);
      } catch (e) {
        observer = null;
      }
    }
    if (!observer) {
      /* 兜底：无 IntersectionObserver 时初始化前 12 张，避免一次性创建过多实例 */
      var lim = Math.min(cards.length, 12);
      for (var c2 = 0; c2 < lim; c2++) initCard(cards[c2]);
    }
  }

  /** 完整渲染：重新聚合 → 页签 → 当前页卡片 */
  function render() {
    if (rendering) return;
    rendering = true;
    var t0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    try {
      if (!dom.tabs || !dom.wrap) {
        var cached = cacheDom();
        if (!cached) return;
      }
      if (!A() || typeof A().build !== 'function') {
        disposeAll();
        U().clear(dom.wrap);
        dom.wrap.innerHTML = '<div class="empty-hint">绘图层尚未就绪</div>';
        return;
      }
      /* 迭代 10：数据映射未选全（X / Value 为空）→ 只显示空态提示，不画空图 */
      if (configIncomplete()) {
        showEmptyConfig();
        U().setStatus('绘图：' + EMPTY_CONFIG_HINT);
        U().setStatusTime('—');
        return;
      }
      work = A().build();
      pageIndex = clamp(Math.floor(Number(Store().state.plot.activePage) || 0), 0,
        Math.max(0, (work.pages ? work.pages.length : 1) - 1));
      Store().state.plot.activePage = pageIndex;
      var ms = ((global.performance && global.performance.now) ? global.performance.now() : Date.now()) - t0;
      Store().state.ui.lastRenderMs = ms;
      renderTabs();
      renderPage();

      if (work.totalCharts) {
        U().setStatus('绘图完成：' + work.totalCharts + ' 张图' + (pageCount() > 1 ? '（' + pageCount() + ' 页）' : ''), 'ok');
      } else {
        U().setStatus('绘图：' + ((work.notes && work.notes[0]) ? work.notes[0] : '无可用数据'));
      }
      U().setStatusTime(YMS.util.fmtDuration(ms));
    } catch (err) {
      if (global.console && console.error) console.error('[YMS.PlotView] render 失败', err);
      U().toast('绘图渲染失败：' + (err && err.message ? err.message : err), 'error');
    } finally {
      rendering = false;
    }
  }

  /** 切换页（只重绘当前页 DOM 与实例） */
  function setPage(i) {
    var pages = pageCount();
    if (!pages) return;
    var idx = clamp(Math.floor(Number(i) || 0), 0, pages - 1);
    if (idx === pageIndex && instances.length) { /* 仍强制刷新页签高亮 */ }
    pageIndex = idx;
    Store().state.plot.activePage = idx;
    renderTabs();
    renderPage();
  }

  /** 窗口尺寸变化 → 重算卡片高度并 resize 全部实例 */
  function resizeAll() {
    /* 卡片高度依赖绘图区尺寸，尺寸变化后重算（保留实例：只改样式） */
    if (dom.wrap && work) {
      var pg = pageOf(pageIndex);
      var grid = dom.wrap.querySelector('.chart-grid');
      if (pg && grid) {
        var cfg = (Store().state.plot && Store().state.plot.layout) || { mode: 'best' };
        var avail2 = measureAvail();
        applyGridStyle(grid, layoutSize(pg.facets.length, cfg, null, avail2 ? avail2.h : null), pg.facets.length);
      }
    }
    for (var i = 0; i < instances.length; i++) {
      try { instances[i].chart.resize(); } catch (e) { /* 忽略单个实例 resize 失败 */ }
    }
  }

  function cacheDom() {
    if (!global.document || typeof global.document.querySelector !== 'function') return false;
    dom.tabs = global.document.querySelector('#plot-tabs');
    dom.wrap = global.document.querySelector('#plot-canvas-wrap');
    return !!(dom.tabs && dom.wrap);
  }

  /** 初始化：缓存 DOM、注册主题、绑定 resize 与 Store 事件 */
  function init() {
    if (inited) return true;
    inited = true;
    if (!cacheDom()) { inited = false; return false; }

    themeReady = !!(CB() && typeof CB().registerTheme === 'function' && CB().registerTheme());

    onResize = U().debounce(function () { resizeAll(); }, 150);
    global.addEventListener('resize', onResize);

    Store().on('mode', function (mode) {
      if (mode !== 'plot') return;
      /* 迭代 10：配置为空 → 明确空态提示（不依赖是否 rendered） */
      if (configIncomplete()) { showEmptyConfig(); return; }
      if (!Store().state.plot.rendered) return;         // 已选好参数但还没 Submit：等用户点 Submit
      render();
    });
    Store().on('data', function () {
      if (Store().state.mode !== 'plot') return;
      if (configIncomplete()) { showEmptyConfig(); return; }   // 迭代 10：导入数据后仍为空 → 空态提示
      if (!Store().state.plot.rendered) return;
      render();
    });

    if (Store().state.mode === 'plot') {
      /* 迭代 10：配置为空 → 空态提示；已配置且渲染过 → 直接出图 */
      if (configIncomplete()) showEmptyConfig();
      else if (Store().state.plot.rendered) render();
    }

    return true;
  }

  P = {
    init: init,
    render: render,
    resizeAll: resizeAll,
    /* 迭代 8 集成：导出「无右轴时卡片路径的 grid.right 归一值」，供 chart-builder 计算
       “表格可用宽度”时同源引用，避免两处硬编码日后漂移（chart-builder 已优先读此常量） */
    GRID_RIGHT_NOAXIS: GRID_RIGHT_NOAXIS,
    disposeAll: disposeAll,
    setPage: setPage,
    pageCount: pageCount,
    register: register,
    unregister: unregister,
    totalCharts: totalCharts,
    getChartMeta: getChartMeta,
    /** 最近一次聚合结果（Report / 调试用） */
    getWork: function () { return work; },
    /** 当前页序号（0 基） */
    getPage: function () { return pageIndex; },
    /** 排版计算（纯函数，可独立自测）：n 张图 + 视口 → {cols, rows, cardH} */
    _layoutSize: layoutSize,
    /** 单图页卡片宽度上限（契约常量，与 plot.css 的 .chart-grid.is-single 规则同值） */
    SINGLE_CARD_MAX_W: SINGLE_MAX_W,
    /** 图内顶部留白下限（给右上角 toolbox 让位，契约常量） */
    GRID_TOP_MIN: GRID_TOP_MIN,
    THEME_NAME: THEME_NAME
  };
  Object.defineProperty(P, 'charts', { get: getCharts, enumerable: true });

  YMS.PlotView = P;
})(typeof window !== 'undefined' ? window : this);
