/* ==========================================================================
   YMS · js/app.js
   编排层（Orchestrator）：
     · 启动引导（主题、模块初始化、事件接线）
     · 菜单区 / 快捷方式区 / 键盘快捷键
     · 视图模式切换（数据视图 ↔ 绘图视图）与右列设置区联动
     · 状态栏、全局错误捕获
     · 自动化验收接口 window.__YMS__（供 Playwright 逐项验证）
   本文件是唯一允许"跨模块编排"的地方；业务逻辑一律在对应模块内实现。
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util, Store = YMS.Store;

  var errors = [];         // 全局错误收集（验收要求：全程零 JS 报错）
  var logs = [];           // 轻量操作日志（验收与报告可用）

  /* ------------------------------------------------------------ 错误捕获 */
  function hookErrors() {
    global.addEventListener('error', function (e) {
      errors.push({ type: 'error', message: e.message, file: e.filename, line: e.lineno, stack: e.error && e.error.stack });
      U.setStatus('脚本错误：' + e.message, 'error');
    });
    global.addEventListener('unhandledrejection', function (e) {
      var r = e.reason;
      errors.push({ type: 'rejection', message: r && (r.message || String(r)), stack: r && r.stack });
      U.setStatus('未处理异常：' + (r && (r.message || r)), 'error');
    });
  }
  function logStep(text) { logs.push({ t: Date.now(), text: text }); }

  /** 安全调用：模块可能尚未就绪时不抛异常 */
  function safe(path, args, fallback) {
    try {
      var parts = path.split('.'), obj = global.YMS, i;
      for (i = 0; i < parts.length - 1; i++) obj = obj && obj[parts[i]];
      var fn = obj && obj[parts[parts.length - 1]];
      if (typeof fn !== 'function') return fallback;
      return fn.apply(obj, args || []);
    } catch (e) {
      console.error('[YMS] 调用 ' + path + ' 失败：', e);
      U.toast('操作失败：' + e.message, 'error');
      return fallback;
    }
  }

  /* ---------------------------------------------------------------- 主题 */
  /* 迭代 18（用户要求）：主题精简为五套，点「主题」按钮**依次轮换**，不再用下拉浮层。
     顺序：atlas 企业蓝 → observatory 暗色仪器 → ledger 瑞士网格 → ion 离子深色 → paper 纸白。
     · 移除 light（浅色仪器）/ dark（深色仪表）两套；默认主题 = atlas 企业蓝。
     · 旧本地存储里的 light / dark 自动归一到 atlas（老用户升级不报错、不残留已删主题）。
     · 每套主题只覆盖 css/theme.css 里的同名令牌；ECharts 主题由令牌重建
       （ChartBuilder.registerTheme），切主题后重绘当前视图。 */
  var THEMES = [
    { id: 'atlas', name: '企业蓝', sw: '#1E40AF' },
    { id: 'observatory', name: '暗色仪器', sw: '#0A0E27' },
    { id: 'ledger', name: '瑞士网格', sw: '#FFFFFF' },
    { id: 'ion', name: '离子深色', sw: '#0a0e14' },
    { id: 'paper', name: '纸白', sw: '#f6f7f9' }
  ];
  var THEME_LEGACY = { light: 'atlas', dark: 'atlas' };
  var THEME_DEFAULT = 'atlas';

  function themeIndex(id) {
    for (var ti = 0; ti < THEMES.length; ti++) if (THEMES[ti].id === id) return ti;
    return 0;
  }
  function themeById(id) { return THEMES[themeIndex(id)]; }

  /* 按主题重建 ECharts 主题并重绘（否则深色主题下图内文字仍是深色） */
  function repaintForTheme() {
    if (YMS.ChartBuilder && typeof YMS.ChartBuilder.registerTheme === 'function') safe('ChartBuilder.registerTheme');
    if (Store.state.plot.rendered) safe('PlotView.render');
  }

  /* 按钮提示同步：当前主题 + 下一次会切到哪套（鼠标悬停即可知道，无需弹出层） */
  function syncThemeBtn() {
    var btn = U.$('#btn-theme');
    if (!btn) return;
    var cur = themeById(Store.state.ui.theme);
    var nxt = THEMES[(themeIndex(cur.id) + 1) % THEMES.length];
    btn.setAttribute('title', '当前主题：' + cur.name + '（点击切换到：' + nxt.name + '）');
    btn.setAttribute('aria-label', '切换主题，当前 ' + cur.name + '，点击切换到 ' + nxt.name);
    btn.setAttribute('data-theme-cur', cur.id);
  }

  function applyTheme(theme) {
    var t = themeById(theme).id;
    document.documentElement.setAttribute('data-theme', t);
    Store.state.ui.theme = t;
    try { localStorage.setItem('yms.theme', t); } catch (e) { /* file:// 下可能不可用 */ }
    syncThemeBtn();
    repaintForTheme();
    return t;
  }

  /* 依次轮换到下一套（末项回到首项） */
  function cycleTheme() {
    var next = THEMES[(themeIndex(Store.state.ui.theme) + 1) % THEMES.length];
    applyTheme(next.id);
    U.toast('主题：' + next.name, 'info');
    return next.id;
  }

  function initTheme() {
    var t = THEME_DEFAULT;
    try { t = localStorage.getItem('yms.theme') || THEME_DEFAULT; } catch (e) { /* ignore */ }
    if (THEME_LEGACY[t]) t = THEME_LEGACY[t];   /* 已删除的旧主题归一到 atlas */
    t = themeById(t).id;
    document.documentElement.setAttribute('data-theme', t);
    Store.state.ui.theme = t;
    /* 归一结果写回本地（否则旧的 light/dark 值会一直残留，下次读到的还是已删主题） */
    try { localStorage.setItem('yms.theme', t); } catch (e) { /* ignore */ }
    syncThemeBtn();
  }

  /* ------------------------------------------------- 布局：设置区宽度 / 分隔条 */
  var SPLIT_MIN = 240, SPLIT_MAX = 520, SPLIT_DEFAULT = 300, SPLIT_KEY = 'yms.settingsWidth';

  /** 读取持久化的设置区宽度（localStorage 在 file:// 下可能不可用 → 一律兜底为默认 300） */
  function readSplitWidth() {
    try {
      var v = parseInt(global.localStorage.getItem(SPLIT_KEY), 10);
      if (isFinite(v) && v >= SPLIT_MIN && v <= SPLIT_MAX) return v;
    } catch (e) { /* file:// 下可能不可用 */ }
    return SPLIT_DEFAULT;
  }
  function writeSplitWidth(w) {
    try { global.localStorage.setItem(SPLIT_KEY, String(w)); } catch (e) { /* 忽略：不影响布局 */ }
  }
  /** 把设置区宽度写进 CSS 变量 --settings-w（#settings-col 与绘图区随 flex 布局即时响应） */
  function applySplitWidth(w) {
    var v = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, Math.round(w)));
    if (document.documentElement && document.documentElement.style) {
      document.documentElement.style.setProperty('--settings-w', v + 'px');
    }
    return v;
  }
  /** 设置区实测宽度（px） */
  function settingsWidth() {
    var el = document.getElementById ? document.getElementById('settings-col') : null;
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  }
  /** 拖拽/复位结束才重排图表（拖拽过程中只改 CSS 变量，不触发图卡重绘） */
  function resizeCharts() {
    if (Store.state.mode !== 'plot') return;
    if (!hasLiveCharts()) return;
    safe('PlotView.resizeAll');
  }

  /**
   * 初始化绘图区 ↔ 设置区之间的可拖拽竖分隔条（#ps-splitter）：
   *   · 拖动实时改设置区宽度（240 ~ 520 px），松手才持久化 + 重排图表
   *   · 双击恢复默认宽度 300px
   *   · 键盘 ←/→ 微调 10px（role=separator 的可访问性）
   * 宽度持久化在 localStorage('yms.settingsWidth')，重载后保持。
   */
  function initLayoutSplitter() {
    var layout = document.getElementById ? document.getElementById('layout') : null;
    if (!layout) return false;
    applySplitWidth(readSplitWidth());      // 恢复上次宽度（首次为默认 300px）

    var bar = document.getElementById('ps-splitter');
    if (!bar) {
      bar = U.el('div', {
        id: 'ps-splitter', class: 'layout-splitter', role: 'separator',
        tabindex: '0', 'aria-orientation': 'vertical',
        'aria-label': '拖动调节设置区宽度',
        title: '拖动调节设置区宽度（240 ~ 520 px）；双击恢复默认 300 px'
      });
      var col = document.getElementById('settings-col');
      if (col && col.parentNode === layout) layout.insertBefore(bar, col);   // 插在绘图区与设置区之间
      else layout.appendChild(bar);
    }

    var dragging = false, lastWidth = settingsWidth();
    function setWidth(w, persist) {
      lastWidth = applySplitWidth(w);
      if (persist) writeSplitWidth(lastWidth);
      return lastWidth;
    }
    function onMouseMove(e) {
      if (!dragging) return;
      if (e.preventDefault) e.preventDefault();
      setWidth(global.innerWidth - e.clientX, false);   // 设置区右边缘贴齐窗口右边
    }
    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('is-dragging');
      if (document.body && document.body.classList) document.body.classList.remove('is-col-resizing');
      writeSplitWidth(lastWidth);
      resizeCharts();                                   // 拖拽结束：重排图表
    }
    bar.addEventListener('mousedown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      bar.classList.add('is-dragging');
      if (document.body && document.body.classList) document.body.classList.add('is-col-resizing');
      if (e.preventDefault) e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    bar.addEventListener('dblclick', function (e) {
      if (e.preventDefault) e.preventDefault();
      setWidth(SPLIT_DEFAULT, true);                    // 双击恢复默认 300px
      resizeCharts();
    });
    bar.addEventListener('keydown', function (e) {
      var step = 0;
      if (e.key === 'ArrowLeft') step = 10;
      else if (e.key === 'ArrowRight') step = -10;
      if (!step) return;
      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();     // 不让方向键外泄给全局快捷键（如全屏导航）
      setWidth(settingsWidth() + step, true);
      resizeCharts();
    });
    return true;
  }

  /* ------------------------------------------- 数据设置区：默认收起 + 持久化 */
  /* 需求（迭代 8）：打开表格时右侧数据设置区默认不展示任何设置项（把宽度让给表格），
     但保留明显入口随时展开；展开/收起状态持久化。
     · 持久化键：localStorage('yms.dataSettingsOpen') —— '1' 展开 / '0' 收起
     · 未显式设置过时：表格视图「有数据」→ 默认收起（= 用户打开了一张表格）；
       还没载入数据 → 保持展开（此时面板里只有「尚未载入数据」引导，没有任何设置项，
       同时也是迭代 7 之前的既有默认布局，避免影响其它模块的既有断言）
     · 绘图视图一律展开（面板本身隐藏），行为与迭代 7 完全一致（回归红线） */
  var DS_OPEN_KEY = 'yms.dataSettingsOpen';
  var dsOpen = null;                                   // null = 用户未显式设置过

  function readDsOpen() {
    try {
      var v = global.localStorage.getItem(DS_OPEN_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) { /* file:// 下可能不可用 */ }
    return null;
  }
  function writeDsOpen(v) {
    try { global.localStorage.setItem(DS_OPEN_KEY, v ? '1' : '0'); } catch (e) { /* 忽略：不影响布局 */ }
  }
  /** 当前模式下数据设置区是否收起 */
  function isDsCollapsed() {
    if (Store.state.mode !== 'data') return false;     // 绘图视图：设置区宽度/内容保持迭代 7 现状
    if (dsOpen === true) return false;
    if (dsOpen === false) return true;
    return Store.hasData();
  }
  /** 应用收起/展开状态（列宽、面板显隐、入口按钮、分隔条） */
  function applyDsCollapse() {
    var col = document.getElementById ? document.getElementById('settings-col') : null;
    if (!col) return false;
    var collapsed = isDsCollapsed();
    if (col.classList) col.classList.toggle('is-collapsed', collapsed);
    var bar = document.getElementById('ps-splitter');
    if (bar && bar.classList) bar.classList.toggle('is-collapsed', collapsed);
    var rail = document.getElementById('ds-rail-btn');
    if (rail) {
      rail.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      rail.title = collapsed
        ? '展开数据设置区（当前已收起，宽度已让给表格）'
        : '收起数据设置区';
    }
    var tog = document.getElementById('ds-head-toggle');
    if (tog) {
      tog.style.display = collapsed ? 'none' : '';
      tog.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    return collapsed;
  }
  /** 展开 / 收起数据设置区（并持久化） */
  function setDsOpen(open) {
    dsOpen = !!open;
    writeDsOpen(dsOpen);
    var collapsed = applyDsCollapse();
    if (!collapsed) resizeCharts();                    // 展开后（绘图视图下）重排图表
    return !collapsed;
  }
  function toggleDsOpen() { return setDsOpen(isDsCollapsed()); }
  function dsSettingsState() {
    return {
      collapsed: isDsCollapsed(),
      persisted: (function () { try { return global.localStorage.getItem(DS_OPEN_KEY); } catch (e) { return null; } })()
    };
  }
  /** 建出收起态细轨 + 面板头部的收起按钮（不删功能：面板内容仍在 DOM 中，仅按需隐藏） */
  function initDataSettingsCollapse() {
    dsOpen = readDsOpen();
    var col = document.getElementById ? document.getElementById('settings-col') : null;
    if (!col) return false;
    if (!document.getElementById('ds-rail')) {
      var btn = U.el('button', {
        id: 'ds-rail-btn', class: 'settings-rail-btn', type: 'button',
        'aria-expanded': 'false', 'aria-controls': 'data-settings-body',
        title: '展开数据设置区'
      }, [
        U.el('span', { class: 'rail-ico', text: '⚙' }),
        U.el('span', { class: 'rail-text', text: '数据设置' })
      ]);
      btn.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        toggleDsOpen();                                 // 收起 → 展开；再点 → 收起
      });
      var rail = U.el('div', { id: 'ds-rail', class: 'settings-rail' }, [btn]);
      col.appendChild(rail);
    }
    var head = document.querySelector('#data-settings .settings-head');
    if (head && !document.getElementById('ds-head-toggle')) {
      var tog = U.el('button', {
        id: 'ds-head-toggle', class: 'settings-head-toggle', type: 'button',
        'aria-expanded': 'true', 'aria-controls': 'data-settings-body',
        title: '收起数据设置区（把宽度让给表格；状态会记住）', text: '收起 ▸'
      });
      tog.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        setDsOpen(false);
      });
      head.appendChild(tog);
    }
    applyDsCollapse();
    return true;
  }

  /* ---------------------------------------------------------------- 菜单 */
  /** 迭代 14：无数据时 Table 菜单整组禁用（并提示「请先导入数据」） */
  function updateTableMenuState() {
    var has = Store.hasData();
    U.$$('#menu-table-list .menu-item').forEach(function (item) {
      if (item.classList) item.classList.toggle('is-disabled', !has);
      item.setAttribute('aria-disabled', has ? 'false' : 'true');
      item.title = has ? '' : '请先导入数据';
    });
    var list = U.$('#menu-table-list');
    if (list && list.classList) list.classList.toggle('is-disabled', !has);
  }

  /** 迭代 14：Table 菜单壳 —— 10 个转换入口，点击发 YMS.bus.emit('transform:open', {kind})（面板由转换面板模块订阅） */
  function initTableMenu() {
    var list = U.$('#menu-table-list');
    if (!list) return false;
    U.$$('#menu-table-list .menu-item').forEach(function (item) {
      item.addEventListener('click', function () {
        U.$$('.menu').forEach(function (m) { m.classList.remove('is-open'); });
        var kind = item.getAttribute('data-tr');
        if (!kind) return;
        if (!Store.hasData()) { U.toast('请先导入数据', 'warn'); return; }
        logStep('菜单 Table → ' + kind);
        YMS.bus.emit('transform:open', { kind: kind });   // 面板侧订阅此事件（本模块不实现面板）
      });
    });
    updateTableMenuState();
    return true;
  }

  function initMenus() {
    U.$$('.menu .menu-title').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        /* Table 菜单：无数据时不开菜单，只提示（整组禁用） */
        if (btn.id === 'menu-table' && !Store.hasData()) {
          U.$$('.menu').forEach(function (m) { m.classList.remove('is-open'); });
          U.toast('请先导入数据', 'warn');
          return;
        }
        var menu = btn.parentNode;
        var open = menu.classList.contains('is-open');
        U.$$('.menu').forEach(function (m) { m.classList.remove('is-open'); });
        if (!open) menu.classList.add('is-open');
      });
    });
    document.addEventListener('click', function () { U.$$('.menu').forEach(function (m) { m.classList.remove('is-open'); }); });

    U.$$('#menu-data-list .menu-item').forEach(function (item) {
      item.addEventListener('click', function () {
        U.$$('.menu').forEach(function (m) { m.classList.remove('is-open'); });
        var act = item.dataset.action;
        logStep('菜单 Data → ' + act);
        if (act === 'import') safe('Importer.openDialog');
        else if (act === 'outport') safe('Exporter.openOutportDialog');
        else if (act === 'save') safe('Exporter.saveData');
        else if (act === 'save-template') safe('YmsTemplate.save');
        else if (act === 'report') doReport();
      });
    });
    U.$$('#menu-plot-list .menu-item').forEach(function (item) {
      item.addEventListener('click', function () {
        U.$$('.menu').forEach(function (m) { m.classList.remove('is-open'); });
        setPlotType(item.dataset.plot);
      });
    });
  }

  function doReport() {
    if (!Store.hasData()) { U.toast('请先导入数据', 'warn'); return; }
    // 报告导出：默认 PPT（按 Page 分页），HTML 报告作为后备保留
    var p = safe('Report.exportPPT', [], null);
    if (!p) p = safe('Report.exportHTML', [], null);
    if (p && p.then) {
      p.then(function () { U.toast('报告导出完成', 'ok'); })
        .catch(function (e) {
          console.error(e);
          U.toast('报告导出失败：' + e.message, 'error');
        });
    }
  }

  /* ------------------------------------------------------------ 快捷方式区 */
  function initShortcuts() {
    U.$$('#shortcut-bar .sc-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.view === 'table') { setMode('data'); logStep('快捷方式 → Table'); }
        else { setPlotType(btn.dataset.plot); logStep('快捷方式 → ' + btn.dataset.plot); }
      });
    });
    U.$('#btn-theme').addEventListener('click', function (e) {
      if (e) e.stopPropagation();
      cycleTheme();          /* 迭代 18：每点一次依次切到下一套主题（无下拉） */
    });
    U.$('#btn-help').addEventListener('click', showHelp);
  }

  function setPlotType(type) {
    if (!type) return;
    if (!Store.hasData()) { U.toast('请先导入数据', 'warn'); return; }
    safe('PlotSettings.setType', [type, true]);
  }

  /* -------------------------------------------------------- 模式切换 */
  function setMode(mode) {
    if (mode !== 'data' && mode !== 'plot') return;
    var same = Store.state.mode === mode;
    Store.setMode(mode);            // 模式变化时会触发 'mode' 事件 → afterModeChange
    if (same) { renderMode(); afterModeChange(); }
  }

  /** 模式切换后的绘图区兜底：首次进入由 PlotSettings 自行初始化，这里只保证有图可看 */
  function afterModeChange() {
    if (Store.state.mode !== 'plot') return;
    if (!Store.hasData()) return;
    var p = Store.state.plot;
    if (!(p.x && p.x.length) || !(p.values && p.values.length)) return;   // 配置为空：交给 PlotSettings.ensureDefaults/自动初始化
    Store.state.plot.rendered = true;
    if (!hasLiveCharts()) safe('PlotView.render');
    else safe('PlotView.resizeAll');
  }

  /** 当前是否已有真实的图表实例（防空白卡片） */
  function hasLiveCharts() {
    try {
      var pv = global.YMS.PlotView;
      if (!pv) return false;
      var n = (pv.charts && typeof pv.charts.length === 'number') ? pv.charts.length : 0;
      return n > 0;
    } catch (e) { return false; }
  }

  function renderMode() {
    var mode = Store.state.mode;
    U.$('#data-view').classList.toggle('is-active', mode === 'data');
    U.$('#plot-view').classList.toggle('is-active', mode === 'plot');
    U.$('#data-settings').classList.toggle('is-active', mode === 'data');
    U.$('#plot-settings').classList.toggle('is-active', mode === 'plot');
    applyDsCollapse();          // 表格视图 ⇄ 绘图视图：数据设置区收起状态随之切换
    U.$$('#shortcut-bar .sc-btn').forEach(function (b) {
      var active = (mode === 'data' && b.dataset.view === 'table') ||
        (mode === 'plot' && b.dataset.plot === Store.state.plot.type);
      b.classList.toggle('is-active', !!active);
    });
    var chip = U.$('#chip-mode');
    if (chip) chip.textContent = mode === 'data' ? '数据视图' : '绘图视图 · ' + chartTypeCN(Store.state.plot.type);
  }
  function chartTypeCN(t) {
    return { scatter: 'Scatter', line: 'Line', hist: 'Hist', bar: 'Bar', box: 'Box' }[t] || t;
  }

  /* -------------------------------------------------------------- 状态栏 */
  function renderStatus() {
    var df = Store.state.df;
    var rowsEl = U.$('#status-rows');
    var filterEl = U.$('#status-filter');
    var chipFile = U.$('#chip-file');
    var chipShape = U.$('#chip-shape');
    if (!df) {
      if (rowsEl) rowsEl.textContent = '0 行';
      if (filterEl) filterEl.textContent = '未过滤';
      if (chipFile) chipFile.textContent = '未载入数据';
      if (chipShape) chipShape.textContent = '0 行 × 0 列';
      var g0 = U.$('#grid-count'); if (g0) g0.textContent = '共 0 行';
      return;
    }
    var view = Store.getView();
    var ds = Store.state.dataSettings;
    var filtered = (view && view.count !== df.rowCount);
    if (rowsEl) rowsEl.textContent = U.fmtInt(df.rowCount) + ' 行 × ' + df.cols.length + ' 列';
    if (filterEl) {
      filterEl.textContent = filtered ? ('过滤后 ' + U.fmtInt(view.count) + ' 行') : '未过滤';
      filterEl.classList.toggle('status-dim', !filtered);
    }
    if (chipFile) chipFile.textContent = Store.state.fileName || Store.state.tableName || '数据表';
    if (chipShape) chipShape.textContent = U.fmtInt(df.rowCount) + ' 行 × ' + df.cols.length + ' 列';
    var g = U.$('#grid-count');
    if (g) {
      g.textContent = filtered
        ? '共 ' + U.fmtInt(view.count) + ' 行（原始 ' + U.fmtInt(df.rowCount) + ' 行）'
        : '共 ' + U.fmtInt(df.rowCount) + ' 行';
    }
    var missingTotal = 0;
    for (var i = 0; i < df.cols.length; i++) missingTotal += df.cols[i].missing;
    if (missingTotal > 0) {
      U.$('#status-msg').title = '数据中存在 ' + missingTotal + ' 个缺失值';
    }
  }

  /* ---------------------------------------------------------- 拖拽导入 */
  function initDragDrop() {
    var overlay = null;
    function showOverlay() {
      if (overlay) return;
      overlay = U.el('div', {
        style: {
          position: 'fixed', inset: '0', zIndex: '500', display: 'flex',
          alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
          background: 'rgba(11,110,153,.12)', border: '2px dashed rgba(11,110,153,.65)'
        }
      }, [
        U.el('div', {
          style: {
            padding: '14px 22px', background: 'var(--panel)', color: 'var(--accent-hover)',
            border: '1px solid var(--accent)', borderRadius: '4px', fontWeight: '600',
            boxShadow: 'var(--shadow-2)', fontSize: '14px'
          },
          text: '释放以导入数据文件（CSV / TXT / Excel / .yms）'
        })
      ]);
      document.body.appendChild(overlay);
    }
    function hideOverlay() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
    }
    document.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      showOverlay();
    });
    document.addEventListener('dragleave', function (e) {
      if (e.relatedTarget === null) hideOverlay();       // 离开窗口
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      hideOverlay();
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      var p = safe('Importer.importFiles', [files], null);
      if (p && p.catch) p.catch(function (err) { U.toast('拖拽导入失败：' + err.message, 'error'); });
      logStep('拖拽导入 ' + files.length + ' 个文件');
    });
    /* 阻止把文件拖到非拖拽区时浏览器直接打开文件 */
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });
  }

  /* -------------------------------------------------------------- 帮助 */
  function showHelp() {
    U.modal({
      title: 'YMS 良率管理系统 · 使用说明',
      width: 'wide',
      bodyHTML: YMS.helpHTML || '<div class="help-body">使用说明未加载</div>',
      footer: [{ text: '关闭', cls: 'btn-primary' }]
    });
  }

  /* -------------------------------------------------------- 模块初始化 */
  function initModules() {
    safe('TableView.init');
    safe('DataGrid.init');
    safe('DataSettings.init');
    safe('PlotSettings.init');
    safe('PlotView.init');
    safe('Fullscreen.init');
    safe('Importer.init');
    if (YMS.ChartBuilder && YMS.ChartBuilder.registerTheme) safe('ChartBuilder.registerTheme');
  }

  /* ------------------------------------------------------ Store 事件接线 */
  function wireStoreEvents() {
    Store.on('change', function (payload) {
      var topic = payload && payload.topic;
      try {
        if (topic === 'data' || topic === 'all') {
          safe('TableView.render');
          safe('DataGrid.render');
          safe('DataSettings.render');
          safe('PlotSettings.render');
          if (Store.state.mode === 'plot' && Store.state.plot.rendered) safe('PlotView.render');
        } else if (topic === 'datasettings') {
          safe('DataGrid.render');
        } else if (topic === 'plot') {
          if (Store.state.plot.rendered) safe('PlotView.render');
        }
      } finally {
        renderStatus();
        renderMode();
        updateTableMenuState();          // 迭代 14：数据有无变化 → Table 菜单可用性
      }
    });
    Store.on('mode', function () { renderMode(); afterModeChange(); });
  }

  /* ==========================================================================
     自动化验收接口：window.__YMS__
     （Playwright 通过 page.evaluate 直接调用，避免依赖 UI 交互的脆弱性）
     ========================================================================== */
  function buildTestApi() {
    var api = {
      version: YMS.version,
      errors: errors,
      logs: logs,
      ready: function () {
        return !!(YMS.Store && YMS.DataGrid && YMS.PlotView && YMS.Importer && YMS.Exporter && YMS.Report);
      },
      getState: function () {
        var df = Store.state.df, view = Store.getView();
        return {
          hasData: Store.hasData(),
          fileName: Store.state.fileName,
          tableName: Store.state.tableName,
          rowCount: df ? df.rowCount : 0,
          colCount: df ? df.cols.length : 0,
          columns: df ? df.cols.map(function (c) {
            return {
              name: c.name, type: c.type, missing: c.missing,
              /* 迭代 25：分组派生列的类目顺序 / 配方（普通列均为 null） */
              order: (c.order && c.order.length) ? c.order.slice() : null,
              groupMap: c.groupMap ? U.deepClone(c.groupMap) : null
            };
          }) : [],
          viewCount: view ? view.count : 0,
          mode: Store.state.mode,
          dataSettings: U.deepClone(Store.state.dataSettings),
          plot: U.deepClone(Store.state.plot),
          theme: Store.state.ui.theme,
          processingNotes: Store.state.ui.processingNotes.slice()
        };
      },
      importText: function (name, text) { return safe('Importer.importText', [name, text], null) || Promise.reject(new Error('Importer 不可用')); },
      importSample: function () { return safe('Importer.importSample', [], null) || Promise.reject(new Error('Importer 不可用')); },
      importFile: function (file) { return safe('Importer.importFile', [file], null) || Promise.reject(new Error('Importer 不可用')); },
      /** 迭代 14：多表快照（供自测读取真实 Store 状态） */
      tables: function () {
        return Store.tables().map(function (t) {
          return {
            id: t.id, name: t.name, derived: !!t.derived,
            rows: t.df ? t.df.rowCount : 0, cols: t.df ? t.df.cols.length : 0,
            fileName: t.fileName || '', active: t.id === Store.state.activeTableId
          };
        });
      },
      activeTableId: function () { return Store.state.activeTableId; },
      setActiveTable: function (id) { return Store.setActiveTable(id); },
      setMode: setMode,
      applyDataSettings: function (patch) { return Store.applyDataSettings(patch); },
      applyPlot: function (patch) { Store.applyPlot(patch); return Store.state.plot; },
      submitPlot: function (patch) {
        if (patch) Store.applyPlot(patch);
        Store.state.plot.rendered = true;
        safe('PlotView.render');
        return api.chartMeta();
      },
      setPlotType: function (type) { setPlotType(type); },
      // 列操作（走 ColumnOps 的编程入口，便于自动化验证）
      columnStats: function (col) {
        var df = Store.state.df, ci = df ? df.colIndex(col) : -1;
        return ci < 0 ? null : df.stats(ci);
      },
      computeColumn: function (name, expr, fill) {
        var r = safe('ColumnOps.computeColumnProgrammatic', [name, expr, fill], null);
        return r;
      },
      fillMissing: function (col, method, value) {
        return safe('ColumnOps.fillMissingProgrammatic', [col, method, value], null);
      },
      convertType: function (col, type, timeStyle) {
        return safe('ColumnOps.convertTypeProgrammatic', [col, type, timeStyle], null);
      },
      dedupeBy: function (col) { return safe('ColumnOps.dedupeByProgrammatic', [col], null) || safe('ColumnOps.dedupeBy', [col], null); },
      renameColumn: function (a, b) { return safe('ColumnOps.renameColumnProgrammatic', [a, b], null); },
      deleteColumn: function (col) { return safe('ColumnOps.deleteColumnProgrammatic', [col], null); },
      // 绘图
      chartMeta: function () { return safe('PlotView.getChartMeta', [], []); },
      totalCharts: function () { return safe('PlotView.totalCharts', [], 0); },
      aggregateWork: function () {
        var w = safe('Aggregate.build', [], null);
        if (!w) return null;
        return {
          chartType: w.chartType, xAxisName: w.xAxisName, totalCharts: w.totalCharts,
          mergeSummary: w.mergeSummary,
          pages: w.pages.map(function (p) {
            return {
              key: p.key, label: p.label,
              facets: p.facets.map(function (f) {
                return {
                  key: f.key, label: f.label, merge: f.merge, fit: f.fit,
                  catCount: f.cats.length,
                  firstCats: f.cats.slice(0, 3).map(function (c) { return { key: c.key, label: c.label, count: c.count, stats: c.stats }; })
                };
              })
            };
          })
        };
      },
      lastFit: function () {
        var w = safe('Aggregate.build', [], null);
        if (!w || !w.pages[0] || !w.pages[0].facets[0]) return null;
        return w.pages[0].facets[0].fit;
      },
      rotatePolicy: function (count, label) { return safe('Axis.rotatePolicy', [count, label ? label.length : 6], null); },
      fitTest: function (xs, ys, method, order) {
        var f = YMS.Fitting && YMS.Fitting.fit(xs, ys, method, order);
        return f ? { ok: f.ok, r2: f.r2, formula: f.formula, coefficients: f.coefficients, reason: f.reason } : null;
      },
      openFullscreen: function (i) { return safe('Fullscreen.open', [i], null); },
      closeFullscreen: function () { return safe('Fullscreen.close', [], null); },
      fullscreenInfo: function () {
        var root = document.getElementById('fullscreen-root');
        var idx = document.querySelector('.fs-index');
        return { open: !!(root && root.classList.contains('is-open')), indexText: idx ? idx.textContent.trim() : null, panOnly: !!Store.state.ui.panOnly };
      },
      // 导出 / 报告 / 模板
      exportCSVString: function (opts) { return safe('Exporter.toCSV', [opts || {}], null); },
      saveYms: function () { return Store.serialize(); },
      loadYms: function (obj) { return safe('YmsTemplate.load', [obj], null); },
      buildReport: function () {
        var p = safe('Report.build', [], null);
        return p;
      },
      // 其它
      getView: function () {
        var v = Store.getView();
        if (!v) return null;
        return {
          count: v.count,
          missing: Array.prototype.slice.call(v.missingCounts()),
          sample: [0, 1, 2].map(function (pos) {
            if (pos >= v.count) return null;
            return Store.state.df.cols.map(function (_, ci) { return v.displayAt(pos, ci); });
          })
        };
      },
      getCell: function (pos, colName) {
        var v = Store.getView(); if (!v) return null;
        var ci = Store.state.df.colIndex(colName);
        return v.displayAt(pos, ci);
      },
      rawCell: function (row, colName) {
        var df = Store.state.df; if (!df) return null;
        var ci = df.colIndex(colName);
        return df.cell(ci, row);
      },
      /* 迭代 25：按值分组（Group Mapping）—— 自动化验收入口
         · open(col) / dialog() 走真实对话框 DOM，供点击式子用例
         · apply(spec) 走与「确定」完全相同的提交路径（GroupUI.commit）
         · meta(col) 读回写在列上的配方（.yms 往返后用它核对） */
      groupMap: {
        open: function (col) { return !!safe('GroupUI.openFor', [col], null); },
        dialog: function () { return safe('GroupUI.state', [], null); },
        close: function () {
          var mask = document.querySelector('#modal-root .modal-mask');
          if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
          return !document.querySelector('#modal-root .modal-mask');
        },
        apply: function (spec) {
          var r = safe('GroupUI.commit', [spec], null);
          if (!r) return { ok: false, error: 'GroupUI 不可用' };
          return {
            ok: !!r.ok, error: r.error ? String(r.error) : null, name: r.name || null,
            action: r.action || null, groups: r.groups || [], order: r.order || [],
            mapped: r.mapped || 0, other: r.other || 0, rawKept: r.rawKept || 0, missing: r.missing || 0
          };
        },
        distinct: function (col) {
          var r = safe('GroupMap.distinct', [Store.state.df, col], null);
          return r ? { ok: !!r.ok, error: r.error || null, total: r.total, values: r.values } : null;
        },
        meta: function (col) {
          var df = Store.state.df;
          if (!df) return null;
          return safe('GroupMap.metaOf', [df.col(col)], null);
        },
        parseRules: function (text, col) {
          var df = Store.state.df;
          var d = safe('GroupMap.distinct', [df, col], null);
          return safe('GroupMap.parseRules', [text, d && d.values ? d.values.map(function (v) { return v.value; }) : []], null);
        }
      },
      /** 已渲染图表的 ECharts option 片段（xAxis.data / series 名），读的是 ECharts 自身状态 */
      xAxisData: function (i) {
        var list = (YMS.PlotView && YMS.PlotView.charts) ? YMS.PlotView.charts : [];
        var item = list[i === undefined ? 0 : i];
        if (!item || !item.chart || !item.chart.getOption) return null;
        var opt = item.chart.getOption();
        var ax = opt.xAxis && opt.xAxis[0] ? opt.xAxis[0] : null;
        return ax ? { data: (ax.data || []).slice(), type: ax.type } : null;
      },
      theme: applyTheme,
      cycleTheme: cycleTheme,
      /* 迭代 17：主题注册表（自测直接读，避免解析弹层 DOM） */
      themes: function () {
        return THEMES.map(function (t, i) { return { id: t.id, name: t.name, sw: t.sw, index: i, cur: Store.state.ui.theme === t.id }; });
      },
      /* 迭代 8：数据设置区收起/展开（默认收起 + 持久化）—— 供自测直接读取真实 DOM 状态 */
      dataSettingsPanel: function () {
        var col = document.getElementById('settings-col');
        var body = document.getElementById('data-settings-body');
        var railBtn = document.getElementById('ds-rail-btn');
        var st = dsSettingsState();
        var vis = 0;
        if (body) {
          var items = body.querySelectorAll('.field, .setting-group, .sorter-row, .plus-row, .chk-line');
          for (var i = 0; i < items.length; i++) if (items[i].offsetParent !== null) vis++;
        }
        return {
          collapsed: st.collapsed,
          persisted: st.persisted,
          colW: col ? Math.round(col.getBoundingClientRect().width) : 0,
          rail: !!(railBtn && railBtn.offsetParent !== null),
          railText: railBtn ? String(railBtn.textContent).replace(/\s+/g, '') : null,
          bodyVisible: !!(body && body.offsetParent !== null),
          visibleSettings: vis,
          headToggle: !!document.getElementById('ds-head-toggle'),
          splitterHidden: !!(function () { var b = document.getElementById('ps-splitter'); return b && b.offsetParent === null; })()
        };
      },
      toggleDataSettings: function () { return toggleDsOpen(); }
    };
    global.__YMS__ = api;
    return api;
  }

  /* ==========================================================================
     启动
     ========================================================================== */
  function boot() {
    hookErrors();
    initTheme();
    initLayoutSplitter();
    initDataSettingsCollapse();
    initMenus();
    initTableMenu();
    initShortcuts();
    initDragDrop();
    initModules();
    wireStoreEvents();
    buildTestApi();
    renderMode();
    renderStatus();
    U.setStatus('就绪 · 请通过 Data → Data Import 导入数据（CSV / TXT / Excel / .yms）；示例数据见包内 sample/sample_yield_data.csv', 'ok');
    logStep('应用启动完成 v' + YMS.version);
    if (global.console && console.info) console.info('[YMS] 已启动 v' + YMS.version + '（离线模式，file:// 直开）');
  }

  YMS.app = { boot: boot, setMode: setMode, setPlotType: setPlotType, doReport: doReport, getErrors: function () { return errors; }, getLogs: function () { return logs; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : this);
