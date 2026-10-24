/* ==========================================================================
   YMS · table/data-grid.js
   数据显示区（分页渲染）—— YMS.DataGrid
     · 只渲染当前页（HTML 字符串拼接 + 一次性 innerHTML，禁止逐 cell createElement）
     · 首列 '#'（视图行号，1 基）；数值/时间列右对齐 .num，字符列左对齐 .cell-string，
       缺失显示为空字符串并加 .cell-missing
     · 分页器：首页 | 上一页 | 页码输入 | / 总页数 | 下一页 | 末页 | 每页行数 | 共 N 行
       （被预处理过滤时显示「共 N 行（原始 M 行）」）
     · 分页状态写回 Store.state.dataSettings.page/pageSize，并 emit('datasettings')
     · 只从 YMS.Store 读（Store.getView() 为唯一数据入口），不直接调用其它模块
     · 表头筛选（迭代 23）：每个列表头右侧 ▾ 打开 Excel 式面板（搜索 + 多选值 + 计数 +
       缺失值），确定后在基视图之上包一层子视图（colFilters 为模块级状态，不写 Store，
       与右侧「条件筛选」各自独立；不参与绘图 / 导出 / .yms）
   公开 API：init() / render() / goto(page) / setPageSize(n)
   内部纯逻辑（供 Node 自测）：resolvePage / buildTableHtml / buildPagerHtml
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util, T = YMS.types, Store = YMS.Store;

  var PAGE_SIZES = [1000, 2000, 5000, 10000, 20000];   // 每页行数下拉选项
  var MIN_PAGE_SIZE = 100;
  var MAX_PAGE_SIZE = 200000;                          // 上限保护（防止一次渲染炸内存）
  var HUGE_ROWS = 20000;                               // ≥ 该行数/页时给出性能提示
  var _hugeWarned = -1;                                // 已提示过的 pageSize（避免重复 toast）

  var _wrap = null, _pager = null, _count = null;      // 缓存 DOM（index.html 已固定）
  var _boundWrap = false, _boundPager = false;         // 事件只绑一次
  var _lastInfo = null;                                // 最近一次分页信息（调试/自测用）

  /* ---- 表头筛选（迭代 23）常量 ---- */
  var FMAX_ITEMS = 800;          // 值列表一次最多渲染的项数（超出靠搜索缩小范围）
  var FMAX_TRACK = 20000;        // 唯一值追踪上限（防止 1000 万行 × 高基数列炸内存）
  var FSEARCH_MS = 90;           // 搜索框输入防抖

  /* ==========================================================================
     纯逻辑：分页计算
     ========================================================================== */
  /**
   * 解析分页参数（页码 clamp 到 [1, 总页数]，行数区间 [start, end) 0 基）
   * @param {number} count    视图行数
   * @param {number} pageSize 每页行数
   * @param {number} page     期望页码（1 基）
   * @returns {{page:number,pageSize:number,pageCount:number,count:number,start:number,end:number,from:number,to:number}}
   */
  function resolvePage(count, pageSize, page) {
    var ps = Math.round(Number(pageSize) || 0);
    if (!isFinite(ps) || ps <= 0) ps = 5000;
    ps = U.clamp(ps, MIN_PAGE_SIZE, MAX_PAGE_SIZE);
    var total = Math.max(0, Math.floor(Number(count) || 0));
    var pageCount = Math.max(1, Math.ceil(total / ps));
    var p = Math.floor(Number(page) || 0);
    if (!isFinite(p) || p < 1) p = 1;
    if (p > pageCount) p = pageCount;
    var start = (p - 1) * ps;
    var end = Math.min(start + ps, total);
    return {
      page: p, pageSize: ps, pageCount: pageCount, count: total,
      start: start, end: end, from: start + 1, to: end
    };
  }

  /** 类型缩写（number / time / char） */
  function typeLabel(type) { return T.TYPE_LABEL[type] || type; }

  /* ==========================================================================
     纯逻辑：HTML 构建
     ========================================================================== */
  /**
   * 构建数据表 HTML（只含当前页）
   * @param {Object} view   Store.getView() 返回的视图
   * @param {Object} opts   {pageSize, page, fontSize, fontFamily}
   * @returns {{html:string, info:Object, colCount:number}}
   */
  function buildTableHtml(view, opts) {
    opts = opts || {};
    var cols = view.df.cols, n = cols.length;
    var info = resolvePage(view.count, opts.pageSize, opts.page);
    var fontFamily = opts.fontFamily || '';
    var fontSize = U.clamp(Number(opts.fontSize) || 12, 10, 20);
    var style = (fontFamily ? 'font-family:' + U.escapeHtml(fontFamily) + ';' : '') + 'font-size:' + fontSize + 'px';

    var head = ['<thead><tr><th class="rowno-h" title="视图行号">#</th>'];
    var filters = opts.colFilters || null;
    var ci, k;
    for (ci = 0; ci < n; ci++) {
      var c = cols[ci];
      var isStr = c.type === T.STRING;
      var filtered = !!(filters && filters[c.name]);
      var nameAttr = U.escapeHtml(c.name);
      var title = c.name + ' · ' + typeLabel(c.type) + (c.missing ? ' · 缺 ' + U.fmtInt(c.missing) : '');
      head.push('<th class="' + (isStr ? 'th-str' : 'th-num') + (filtered ? ' is-filtered' : '') + '" data-col="' + nameAttr + '"' +
        ' title="' + U.escapeHtml(title) + '">' +
        '<span class="th-name">' + U.escapeHtml(c.name) + '</span>' +
        '<span class="th-type">' + U.escapeHtml(typeLabel(c.type)) + '</span>' +
        '<span class="dg-fbtn' + (filtered ? ' is-active' : '') + '" data-col="' + nameAttr + '"' +
        ' role="button" tabindex="0" title="筛选本列" aria-label="筛选本列">▾</span></th>');
    }
    head.push('</tr></thead>');

    var body = ['<tbody>'];
    for (var pos = info.start; pos < info.end; pos++) {
      var cells = ['<td class="rowno">' + (pos + 1) + '</td>'];
      for (k = 0; k < n; k++) {
        var col = cols[k];
        var v = view.valueAt(pos, k);
        var txt, cls;
        if (v === null) {
          txt = '';                                              // 缺失：显示为空
          cls = (col.type === T.STRING ? 'cell-string ' : '') + 'cell-missing';
        } else {
          txt = view.textAt(pos, k);                             // 原文优先（'95%'），否则按列小数位/时间样式格式化
          cls = col.type === T.STRING ? 'cell-string' : 'num';
        }
        cells.push('<td class="' + cls + '">' + U.escapeHtml(txt) + '</td>');
      }
      body.push('<tr>' + cells.join('') + '</tr>');
    }
    body.push('</tbody>');

    return {
      html: '<table class="data-grid" style="' + style + '">' + head.join('') + body.join('') + '</table>',
      info: info,
      colCount: n
    };
  }

  /**
   * 构建分页器 HTML
   * @param {number} count         视图行数
   * @param {number} originalCount 原始行数（> count 时提示「原始 M 行」）
   * @param {Object} opts          {page, pageSize}
   */
  function buildPagerHtml(count, originalCount, opts) {
    opts = opts || {};
    var info = resolvePage(count, opts.pageSize, opts.page);
    var sizes = PAGE_SIZES.slice();
    if (sizes.indexOf(info.pageSize) < 0) sizes.push(info.pageSize);   // 模板恢复的非标准行数
    sizes.sort(function (a, b) { return a - b; });
    var sel = ['<select class="page-size" title="每页行数">'];
    for (var i = 0; i < sizes.length; i++) {
      sel.push('<option value="' + sizes[i] + '"' + (sizes[i] === info.pageSize ? ' selected' : '') + '>' +
        U.fmtInt(sizes[i]) + '</option>');
    }
    sel.push('</select>');

    var filtered = Number(originalCount) > Number(count);
    var txt = '共 ' + U.fmtInt(count) + ' 行' + (filtered ? '（原始 ' + U.fmtInt(originalCount) + ' 行）' : '');

    return '<button class="btn btn-sm" data-act="first" title="首页">首页</button>' +
      '<button class="btn btn-sm" data-act="prev" title="上一页">上一页</button>' +
      '<input class="page-input" type="text" inputmode="numeric" value="' + info.page + '" title="输入页码后回车">' +
      '<span class="pager-of">/ ' + U.fmtInt(info.pageCount) + ' 页</span>' +
      '<button class="btn btn-sm" data-act="next" title="下一页">下一页</button>' +
      '<button class="btn btn-sm" data-act="last" title="末页">末页</button>' +
      '<span class="pager-sep"></span>' + sel.join('') +
      '<span class="pager-info">' + txt + '</span>';
  }

  /* ==========================================================================
     表头筛选（迭代 23）—— Excel 式：每列下拉多选值 + 搜索
     --------------------------------------------------------------------------
     语义约定：
       · colFilters 是**模块级**状态 { 列名: {keys:Object, missing:bool} }，
         从不写入 Store / dataSettings，因此不参与绘图、导出与 .yms 内容
       · 值列表基于「未应用表头筛选」的基视图（Store.getView()）统计：
         条件筛选 / 缺失处理 / 排序已生效，表头筛选不叠加
       · 全部勾选 = 该列无筛选（删除该列条目）；子视图 = 基视图位置的子集，
         分页 / 行号 / 排序 / 列高亮全部沿用基视图顺序
     ========================================================================== */
  var colFilters = Object.create(null);   // 列名 → {keys, missing}
  var _filterTable = '';                  // 表头筛选所属表 id（切表即清空）
  var _filterDs = null;                   // 所属 dataSettings 对象（重新导入会换新对象 → 清空）
  var _uniqCache = [];                    // 唯一值缓存（按 基视图对象 + 列名 失效）

  var _pop = null;                        // 面板 DOM（挂 body，fixed 定位）
  var _popCol = null, _popAnchor = null, _popStat = null;
  var _popView = [];                      // 当前可见项（搜索后）
  var _popSel = Object.create(null);      // key → true
  var _popMissing = false;
  var _popQuery = '';
  var _popTimer = 0;
  var _boundDoc = false;

  var _labelWant = null;                  // 标题行 / 状态栏应为的中文原文（无筛选时 null）
  var _labelObs = null;

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function nowMs() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }
  /** 中文 → 当前语言（用于与 i18n 观察器比对的文本，避免来回改写） */
  function tr(s) { return (YMS.I18n && YMS.I18n.t) ? YMS.I18n.t(s) : s; }
  function isEmptyFilters() {
    for (var k in colFilters) if (hasOwn(colFilters, k)) return false;
    return true;
  }
  function activeCols(df) {
    var out = [], k;
    for (k in colFilters) {
      if (!hasOwn(colFilters, k)) continue;
      var ci = df ? df.colIndex(k) : -1;
      if (ci >= 0) out.push({ col: k, ci: ci, f: colFilters[k] });
    }
    return out;
  }
  /** 列名不存在（删列 / 改名 / 换表）→ 丢掉脏筛选 */
  function pruneFilters(df) {
    var k, dead = [];
    for (k in colFilters) if (hasOwn(colFilters, k) && df.colIndex(k) < 0) dead.push(k);
    for (var i = 0; i < dead.length; i++) delete colFilters[dead[i]];
    return dead.length > 0;
  }
  function resetFilters(tableId, ds) {
    var k;
    for (k in colFilters) if (hasOwn(colFilters, k)) delete colFilters[k];
    _uniqCache.length = 0;
    _filterTable = tableId || '';
    _filterDs = ds || null;
  }

  /* ---- 子视图：基视图位置子集（保持基视图顺序 = 排序/条件筛选全部保留） ---- */
  function subView(base, keep) {
    return {
      df: base.df, cols: base.df.cols, count: keep.length, base: base, keep: keep,
      fontFamily: base.fontFamily, fontSize: base.fontSize, decimals: base.decimals,
      rowAt: function (p) { return base.rowAt(keep[p]); },
      valueAt: function (p, ci) { return base.valueAt(keep[p], ci); },
      displayAt: function (p, ci) { return base.displayAt(keep[p], ci); },
      textAt: function (p, ci) { return base.textAt(keep[p], ci); },
      typeAt: function (ci) { return base.typeAt(ci); }
    };
  }
  /** 按 colFilters 求保留位置（无筛选 → null） */
  function buildKeep(base) {
    var act = activeCols(base.df);
    if (!act.length) return null;
    var keep = [], p, a, ok, v, k;
    for (p = 0; p < base.count; p++) {
      ok = true;
      for (a = 0; a < act.length && ok; a++) {
        v = base.valueAt(p, act[a].ci);
        if (v === null) { if (!act[a].f.missing) ok = false; }
        else {
          k = (base.typeAt(act[a].ci) === T.STRING ? 's' : 'n') + v;
          if (!hasOwn(act[a].f.keys, k)) ok = false;
        }
      }
      if (ok) keep.push(p);
    }
    return keep;
  }

  /* ---- 唯一值统计（只扫一遍；按 基视图 + 列 缓存） ---- */
  function uniqueStats(base, ci, col) {
    var i;
    for (i = 0; i < _uniqCache.length; i++) {
      var c0 = _uniqCache[i];
      if (c0.view === base && c0.col === col) return c0;
    }
    var t0 = nowMs();
    var type = base.typeAt(ci), isStr = type === T.STRING;
    var map = new Map(), order = [], missing = 0, overflow = false, p, v, key, slot;
    for (p = 0; p < base.count; p++) {
      v = base.valueAt(p, ci);
      if (v === null) { missing++; continue; }
      key = (isStr ? 's' : 'n') + v;
      slot = map.get(key);
      if (slot !== undefined) { slot.count++; continue; }
      if (order.length >= FMAX_TRACK) { overflow = true; continue; }
      slot = { key: key, v: v, count: 1, label: base.textAt(p, ci) };   /* 标签与单元格显示一致（'95%' 而不是 0.95） */
      map.set(key, slot);
      order.push(slot);
    }
    var st = { view: base, col: col, ci: ci, entries: order, missing: missing, overflow: overflow, ms: nowMs() - t0 };
    _uniqCache.unshift(st);
    while (_uniqCache.length > 6) _uniqCache.pop();
    return st;
  }
  /** 值得显示文本（与单元格 displayAt 完全一致：小数位 / 时间样式） */
  function entryLabel(ent, ci, base) {
    if (ent.label !== null && ent.label !== undefined) return ent.label;
    var c = base.df.cols[ci];
    ent.label = T.formatValue(ent.v, c.type, base.decimals ? base.decimals[c.name] : null, c.timeStyle);
    return ent.label;
  }

  /* ---- 标题行 / 状态栏文案（app.js 的 renderStatus 会回写，故用观察器纠偏） ---- */
  function ensureClearBtn() {
    var head = U.$('#grid-panel .panel-head');
    if (!head) return null;
    var b = U.$('.dg-fclear', head);
    if (b) return b;
    b = U.el('button', { class: 'dg-fclear btn btn-sm', type: 'button', title: '清除全部表头筛选' });
    b.textContent = '清除表头筛选';
    b.style.display = 'none';
    b.addEventListener('click', guard('清除表头筛选', function (e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      clearAllFilters();
    }));
    head.appendChild(b);
    return b;
  }
  function applyLabelWant() {
    if (!_labelWant) return;
    var c = U.$('#grid-count'), s = U.$('#status-filter');
    var cw = tr(_labelWant.count), sw = tr(_labelWant.status);
    if (c && c.textContent !== cw) c.textContent = cw;
    if (s) {
      if (s.textContent !== sw) s.textContent = sw;
      if (s.classList.contains('status-dim')) s.classList.remove('status-dim');
    }
  }
  function ensureLabelWatch() {
    if (_labelObs || typeof MutationObserver === 'undefined') return;
    var c = U.$('#grid-count'), s = U.$('#status-filter');
    if (!c && !s) return;
    _labelObs = new MutationObserver(function () { applyLabelWant(); });
    var opt = { childList: true, characterData: true, subtree: true };
    if (c) _labelObs.observe(c, opt);
    if (s) _labelObs.observe(s, opt);
  }
  function syncFilterChrome(baseCount, filteredCount, active) {
    var btn = ensureClearBtn();
    if (btn) btn.style.display = active ? '' : 'none';
    var df = Store.state.df, orig = (df && df.rowCount) || baseCount;
    if (!active) {
      _labelWant = null;
      /* 表头筛选已清空：状态栏交回「未过滤 / 过滤后 N 行」（app.js 后续会写同样的值） */
      var s0 = U.$('#status-filter');
      if (s0 && df) {
        var baseFiltered = orig > baseCount;
        s0.textContent = baseFiltered ? '过滤后 ' + U.fmtInt(baseCount) + ' 行' : '未过滤';
        if (s0.classList) {
          if (baseFiltered) s0.classList.remove('status-dim'); else s0.classList.add('status-dim');
        }
      }
      return;
    }
    var txt = '共 ' + U.fmtInt(baseCount) + ' 行';
    if (orig > baseCount) txt += '（原始 ' + U.fmtInt(orig) + ' 行）';
    txt += ' · 筛选后 ' + U.fmtInt(filteredCount) + ' 行';
    _labelWant = {
      count: txt,
      status: '表头筛选：' + U.fmtInt(filteredCount) + ' / ' + U.fmtInt(baseCount) + ' 行'
    };
    ensureLabelWatch();
    applyLabelWant();
  }

  /* ---- 面板：开 / 关 / 定位 ---- */
  function closePop() {
    if (_popTimer) { clearTimeout(_popTimer); _popTimer = 0; }
    if (_pop && _pop.parentNode) _pop.parentNode.removeChild(_pop);
    _pop = null; _popCol = null; _popAnchor = null; _popStat = null;
    _popView = []; _popQuery = '';
  }
  function positionPop(pop, anchor) {
    if (!pop || !anchor || !anchor.getBoundingClientRect) return;
    var r = anchor.getBoundingClientRect();
    var pw = pop.offsetWidth || 240, ph = pop.offsetHeight || 300;
    var vw = global.innerWidth || 1200, vh = global.innerHeight || 800;
    var left = r.right - pw;                                   // 右缘贴按钮（Excel 手感）
    if (left < 8) left = 8;
    if (left + pw > vw - 8) left = Math.max(8, vw - 8 - pw);
    var top = r.bottom + 4;
    if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 4);   // 下方放不下 → 翻到上方
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  }
  function selCount() {
    var n = 0, k;
    for (k in _popSel) if (hasOwn(_popSel, k) && _popSel[k]) n++;
    return n;
  }
  function totalCount() {
    var st = _popStat;
    return st ? st.entries.length + (st.missing > 0 ? 1 : 0) : 0;
  }
  /** 渲染值列表（搜索命中数可超过 800，只渲染前 800） */
  function renderList(base, ci) {
    var st = _popStat;
    if (!st) return;
    var q = _popQuery.toLowerCase(), i, it, lb, matched = 0, html = [];
    _popView = [];
    if (st.missing > 0) {
      lb = '（空白）';
      if (!q || lb.toLowerCase().indexOf(q) >= 0) { matched++; _popView.push({ miss: true, label: lb, count: st.missing }); }
    }
    for (i = 0; i < st.entries.length; i++) {
      it = st.entries[i];
      lb = entryLabel(it, ci, base);
      if (q && lb.toLowerCase().indexOf(q) < 0) continue;
      matched++;
      if (_popView.length < FMAX_ITEMS) _popView.push({ miss: false, key: it.key, label: lb, count: it.count });
    }
    for (i = 0; i < _popView.length; i++) {
      var o = _popView[i];
      var on = o.miss ? _popMissing : !!_popSel[o.key];
      html.push('<label class="dg-fitem' + (on ? ' is-on' : '') + '">' +
        '<input type="checkbox" data-k="' + i + '"' + (on ? ' checked' : '') + '>' +
        '<span class="dg-fval"' + (o.miss ? '' : ' data-i18n-skip') + '>' + U.escapeHtml(o.label) + '</span>' +
        '<span class="dg-fnum">' + U.fmtInt(o.count) + '</span></label>');
    }
    if (!html.length) html.push('<div class="dg-fempty">没有匹配的值</div>');
    var list = _pop.querySelector('.dg-flist');
    if (list) { list.innerHTML = html.join(''); list.scrollTop = 0; }
    var more = _pop.querySelector('.dg-fmore');
    if (more) {
      if (matched > FMAX_ITEMS) {
        more.textContent = '仅显示前 ' + FMAX_ITEMS + ' 个值，请用搜索缩小范围';
        more.style.display = '';
      } else { more.textContent = ''; more.style.display = 'none'; }
    }
    updateSelText();
    var rst = _pop.querySelector('.dg-freset');
    if (rst) rst.disabled = !colFilters[_popCol];
  }
  function updateSelText() {
    var el = _pop && _pop.querySelector('.dg-fsel');
    if (!el) return;
    el.textContent = '已选 ' + selCount() + ' / 共 ' + totalCount();
  }
  /** 全选 / 清空：无搜索时作用于「全部追踪值」，有搜索时只作用于可见项（Excel 手感） */
  function setVisibleChecked(on) {
    var list = _pop && _pop.querySelector('.dg-flist');
    if (!list) return;
    var st = _popStat, i;
    if (!_popQuery && st) {
      _popSel = Object.create(null);
      if (on) for (i = 0; i < st.entries.length; i++) _popSel[st.entries[i].key] = true;
      _popMissing = !!(on && st.missing > 0);
    }
    var boxes = list.querySelectorAll('input[type="checkbox"]');
    for (i = 0; i < boxes.length; i++) {
      var it = _popView[Number(boxes[i].getAttribute('data-k'))];
      if (!it) continue;
      if (_popQuery) {                                           // 搜索中：只改可见项
        if (it.miss) _popMissing = on;
        else if (on) _popSel[it.key] = true; else delete _popSel[it.key];
      }
      var checked = it.miss ? _popMissing : !!_popSel[it.key];
      boxes[i].checked = checked;
      var lab = boxes[i].parentNode;
      if (lab && lab.classList) {
        if (checked) lab.classList.add('is-on'); else lab.classList.remove('is-on');
      }
    }
    updateSelText();
  }
  function openPop(btn) {
    var col = btn && btn.getAttribute ? btn.getAttribute('data-col') : '';
    if (!col) return;
    if (_pop && _popCol === col) { closePop(); return; }   // 再点一次收起
    closePop();
    var base = Store.getView();
    if (!base || !base.count) { U.toast('当前没有可显示的数据', 'warn'); return; }
    var ci = base.df.colIndex(col);
    if (ci < 0) return;
    var st = uniqueStats(base, ci, col);
    _popCol = col; _popAnchor = btn; _popStat = st; _popQuery = '';
    _popSel = Object.create(null);
    var f = colFilters[col], i;
    if (f) {
      for (i = 0; i < st.entries.length; i++) if (hasOwn(f.keys, st.entries[i].key)) _popSel[st.entries[i].key] = true;
      _popMissing = !!(f.missing && st.missing > 0);
    } else {
      for (i = 0; i < st.entries.length; i++) _popSel[st.entries[i].key] = true;
      _popMissing = st.missing > 0;
    }

    _pop = U.el('div', { class: 'dg-fpop', role: 'dialog', 'aria-label': '筛选本列' });
    _pop.innerHTML =
      '<div class="dg-fhead" data-i18n-skip><span class="dg-fcol"></span></div>' +
      '<div class="dg-fsearch-row">' +
        '<input class="dg-fsearch" type="text" placeholder="搜索值…" aria-label="搜索值" autocomplete="off" spellcheck="false">' +
      '</div>' +
      '<div class="dg-fbar">' +
        '<button class="dg-fall btn btn-sm" type="button">全选</button>' +
        '<button class="dg-fnone btn btn-sm" type="button">清空</button>' +
        '<span class="dg-fsel"></span>' +
      '</div>' +
      '<div class="dg-fcols"><span>值</span><span>计数</span></div>' +
      '<div class="dg-flist"></div>' +
      '<div class="dg-fmore" style="display:none"></div>' +
      '<div class="dg-factions">' +
        '<button class="dg-freset btn btn-sm" type="button">清除本列筛选</button>' +
        '<button class="dg-fcancel btn btn-sm" type="button">取消</button>' +
        '<button class="dg-fok btn btn-primary btn-sm" type="button">确定</button>' +
      '</div>';
    var head = _pop.querySelector('.dg-fcol');
    if (head) head.textContent = col;
    _pop.addEventListener('click', guard('表头筛选面板', onPopClick));
    _pop.addEventListener('change', guard('表头筛选勾选', onPopChange));
    _pop.addEventListener('input', guard('表头筛选搜索', onPopInput));
    _pop.addEventListener('keydown', guard('表头筛选面板键盘', onPopKeydown));
    document.body.appendChild(_pop);
    renderList(base, ci);
    positionPop(_pop, btn);
    var inp = _pop.querySelector('.dg-fsearch');
    if (inp && inp.focus) { try { inp.focus(); } catch (e) { /* 忽略 */ } }
  }
  /** 确定：勾选覆盖全部值 → 删除该列筛选（= 无筛选） */
  function applyPop() {
    var col = _popCol, st = _popStat;
    if (!col || !st) return;
    var keys = Object.create(null), n = 0, k;
    for (k in _popSel) if (hasOwn(_popSel, k) && _popSel[k]) { keys[k] = true; n++; }
    var hasMiss = st.missing > 0;
    var selTotal = n + (_popMissing && hasMiss ? 1 : 0);
    if (selTotal >= totalCount() && !st.overflow) delete colFilters[col];
    else colFilters[col] = { keys: keys, missing: !!(_popMissing && hasMiss) };
    closePop();
    gotoPageOne();
    DataGrid.render();
  }
  /** 清除本列筛选 */
  function clearPopColumn() {
    var col = _popCol;
    if (!col) return;
    delete colFilters[col];
    closePop();
    gotoPageOne();
    DataGrid.render();
  }
  /** 一键清除全部表头筛选 */
  function clearAllFilters() {
    if (isEmptyFilters()) return;
    resetFilters(Store.state.activeTableId || '');
    gotoPageOne();
    DataGrid.render();
    U.toast('已清除表头筛选', 'ok');
  }
  function gotoPageOne() {
    var ds = Store.state.dataSettings;
    if (ds) ds.page = 1;
  }

  /* ---- 面板事件 ---- */
  function onPopClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.dg-fcancel')) { e.preventDefault(); closePop(); return; }
    if (t.closest('.dg-fok')) { e.preventDefault(); applyPop(); return; }
    if (t.closest('.dg-freset')) { e.preventDefault(); clearPopColumn(); return; }
    if (t.closest('.dg-fall')) { e.preventDefault(); setVisibleChecked(true); return; }
    if (t.closest('.dg-fnone')) { e.preventDefault(); setVisibleChecked(false); return; }
  }
  function onPopChange(e) {
    var cb = e.target;
    if (!cb || cb.type !== 'checkbox') return;
    var it = _popView[Number(cb.getAttribute('data-k'))];
    if (!it) return;
    if (it.miss) _popMissing = cb.checked;
    else if (cb.checked) _popSel[it.key] = true; else delete _popSel[it.key];
    var lab = cb.parentNode;
    if (lab && lab.classList) {
      if (cb.checked) lab.classList.add('is-on'); else lab.classList.remove('is-on');
    }
    updateSelText();
  }
  function onPopInput(e) {
    var t = e.target;
    if (!t || String(t.className).indexOf('dg-fsearch') < 0) return;
    var val = t.value;
    if (_popTimer) clearTimeout(_popTimer);
    _popTimer = setTimeout(guard('表头筛选搜索', function () {
      _popTimer = 0;
      if (!_pop) return;
      _popQuery = val;
      var base = Store.getView();
      if (base) renderList(base, _popStat ? _popStat.ci : 0);
    }), FSEARCH_MS);
  }
  function onPopKeydown(e) {
    if (e.key === 'Enter' && e.target && String(e.target.className).indexOf('dg-fsearch') >= 0) {
      e.preventDefault();
      if (_popTimer) { clearTimeout(_popTimer); _popTimer = 0; }
      _popQuery = e.target.value;
      var base = Store.getView();
      if (base) renderList(base, _popStat ? _popStat.ci : 0);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); closePop();
    }
  }
  function onDocDown(e) {
    if (!_pop) return;
    var t = e.target;
    if (t && _pop.contains(t)) return;
    if (t && t.closest && t.closest('.dg-fbtn')) return;    // 交给按钮自己切换
    closePop();
  }
  function onDocKey(e) {
    if (!_pop) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); }
  }
  function bindDoc() {
    if (_boundDoc || !document.addEventListener) return;
    document.addEventListener('mousedown', guard('表头筛选外部点击', onDocDown), true);
    document.addEventListener('keydown', guard('表头筛选键盘', onDocKey), true);
    _boundDoc = true;
  }

  /* ==========================================================================
     渲染
     ========================================================================== */
  /** 取容器（index.html 已就绪；缺失时返回 null 并静默降级） */
  function nodes() {
    _wrap = U.$('#grid-wrap');
    _pager = U.$('#grid-pager');
    _count = U.$('#grid-count');
    return { wrap: _wrap, pager: _pager, count: _count };
  }

  /** 空状态展示 */
  function renderEmpty(msg) {
    if (_wrap) _wrap.innerHTML = '<div class="empty-hint">' + U.escapeHtml(msg) + '</div>';
    if (_pager) _pager.innerHTML = '';
    if (_count) _count.textContent = '共 0 行';
    _lastInfo = null;
  }

  /** 状态栏行数（#status-rows） */
  function setStatusRows(count, original) {
    var n = U.$('#status-rows');
    if (!n) return;
    n.textContent = (original > count)
      ? U.fmtInt(count) + ' / ' + U.fmtInt(original) + ' 行'
      : U.fmtInt(count) + ' 行';
  }

  /** 表格区事件（表头右键 → ColumnOps；单击 → 高亮该列 / 点 ▾ 开筛选面板） */
  function onWrapContextMenu(e) {
    var t = e.target;
    if (t && t.closest && t.closest('.dg-fbtn')) { e.preventDefault(); return; }
    var th = t && t.closest ? t.closest('th') : null;
    if (!th) return;
    var col = th.getAttribute('data-col');
    if (!col) return;
    e.preventDefault();
    e.stopPropagation();
    if (YMS.ColumnOps && YMS.ColumnOps.contextMenu) YMS.ColumnOps.contextMenu(e, col);
  }
  function onWrapClick(e) {
    var t = e.target;
    var fb = t && t.closest ? t.closest('.dg-fbtn') : null;
    if (fb) {                                                     // ▾ 按钮：开 / 关本列筛选
      if (e) { e.preventDefault(); e.stopPropagation(); }
      openPop(fb);
      return;
    }
    var th = t && t.closest ? t.closest('th') : null;
    if (!th || !_wrap) return;
    var col = th.getAttribute('data-col');
    if (!col) return;
    highlightColumn(col);
  }
  /** ▾ 按钮的键盘触发（Enter / 空格） */
  function onWrapKeydown(e) {
    var t = e.target;
    var fb = t && t.closest ? t.closest('.dg-fbtn') : null;
    if (!fb) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault(); e.stopPropagation();
      openPop(fb);
    }
  }
  /** 高亮某列（表头 + 该列单元格） */
  function highlightColumn(col) {
    var table = _wrap ? _wrap.querySelector('table.data-grid') : null;
    if (!table) return;
    var ths = table.querySelectorAll('thead th'), i;
    var idx = -1;
    for (i = 0; i < ths.length; i++) {
      var isHit = ths[i].getAttribute('data-col') === col;
      ths[i].className = ths[i].className.replace(/\s*is-active/g, '') + (isHit ? ' is-active' : '');
      if (isHit) idx = i;
    }
    var tds = table.querySelectorAll('td.col-active');
    for (i = 0; i < tds.length; i++) tds[i].className = tds[i].className.replace(/\s*col-active/g, '');
    if (idx < 0) return;
    var hits = table.querySelectorAll('tbody td:nth-child(' + (idx + 1) + ')');
    for (i = 0; i < hits.length; i++) hits[i].className += ' col-active';
  }

  /** 分页器事件 */
  function onPagerClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    e.preventDefault();
    var act = btn.getAttribute('data-act');
    var ds = Store.state.dataSettings;
    var view = Store.hasData() ? Store.getView() : null;
    if (!view) return;
    var info = resolvePage(view.count, ds.pageSize, ds.page);
    if (act === 'first') DataGrid.goto(1);
    else if (act === 'prev') DataGrid.goto(info.page - 1);
    else if (act === 'next') DataGrid.goto(info.page + 1);
    else if (act === 'last') DataGrid.goto(info.pageCount);
  }
  function onPagerChange(e) {
    var t = e.target;
    if (!t || !t.className || String(t.className).indexOf('page-size') < 0) return;
    DataGrid.setPageSize(Number(t.value));
  }
  function onPagerKeydown(e) {
    var t = e.target;
    if (!t || !t.className || String(t.className).indexOf('page-input') < 0) return;
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var v = Math.floor(Number(t.value));
    DataGrid.goto(isFinite(v) ? v : 1);
  }
  /** 焦点离开页码输入框时校正显示值（不触发翻页） */
  function onPagerBlur(e) {
    var t = e.target;
    if (!t || !t.className || String(t.className).indexOf('page-input') < 0) return;
    if (_lastInfo) t.value = _lastInfo.page;
  }

  /** 事件处理器包装：任何异常都不得逃逸到全局（硬约束：零未捕获异常） */
  function guard(name, fn) {
    return function (e) {
      try { return fn(e); } catch (err) {
        if (global.console) global.console.error('[YMS.DataGrid] ' + name + ' 失败', err);
      }
    };
  }

  function bindWrap() {
    if (_boundWrap || !_wrap || !_wrap.addEventListener) return;
    _wrap.addEventListener('contextmenu', guard('表头右键菜单', onWrapContextMenu));
    _wrap.addEventListener('click', guard('表头单击', onWrapClick));
    _wrap.addEventListener('keydown', guard('表头筛选按钮', onWrapKeydown));
    _boundWrap = true;
  }
  function bindPager() {
    if (_boundPager || !_pager || !_pager.addEventListener) return;
    _pager.addEventListener('click', guard('分页按钮', onPagerClick));
    _pager.addEventListener('change', guard('每页行数', onPagerChange));
    _pager.addEventListener('keydown', guard('页码输入', onPagerKeydown));
    _pager.addEventListener('focusout', guard('页码失焦', onPagerBlur));
    _boundPager = true;
  }

  /* ==========================================================================
     公开 API
     ========================================================================== */
  var DataGrid = {
    PAGE_SIZES: PAGE_SIZES,

    /** 初始化：缓存 DOM 并绑定事件（可重复调用） */
    init: function () {
      try {
        nodes();
        bindWrap();
        bindPager();
        bindDoc();
        ensureLabelWatch();
        if (YMS.I18n && YMS.I18n.onChange) {
          YMS.I18n.onChange(function () { applyLabelWant(); });   // 切语言后标题行 / 状态栏重新对齐
        }
      } catch (err) {
        if (global.console) global.console.error('[YMS.DataGrid] init 失败', err);
      }
      return this;
    },

    /** 按 Store 视图 + dataSettings.page/pageSize 渲染当前页（表头筛选 → 子视图） */
    render: function () {
      try {
        nodes();
        bindWrap();
        bindPager();
        bindDoc();
        if (!_wrap) return this;                                    // 无容器：静默降级（Node 自测用）

        var df = Store.state.df;
        if (!df || !df.rowCount) {
          resetFilters('');
          renderEmpty('尚未载入数据');
          setStatusRows(0, 0);
          syncFilterChrome(0, 0, false);
          return this;
        }
        /* 切表 / 重新导入（dataSettings 换新对象）/ 删表 → 清空表头筛选 */
        var tid = Store.state.activeTableId || '';
        var dsNow = Store.state.dataSettings;
        if (tid !== _filterTable || dsNow !== _filterDs) resetFilters(tid, dsNow);
        closePop();
        pruneFilters(df);

        var view = Store.getView();
        if (!view || !view.count) {
          renderEmpty('当前筛选 / 缺失值处理条件下没有数据');
          if (_count) _count.textContent = '共 0 行';
          setStatusRows(0, df.rowCount);
          syncFilterChrome(0, 0, false);
          return this;
        }

        var base = view;
        var keep = buildKeep(base);
        if (keep) view = subView(base, keep);                       // 表头筛选：基视图之上包一层
        var hasFilter = !!keep;
        var ds = Store.state.dataSettings;

        if (hasFilter && !view.count) {                             // 筛选后无数据：保留分页器与一键清除
          var info0 = resolvePage(0, ds.pageSize, 1);
          if (ds.page !== info0.page) ds.page = info0.page;
          _lastInfo = info0;
          _wrap.innerHTML = '<div class="empty-hint">筛选后无数据</div>';
          if (_pager) _pager.innerHTML = buildPagerHtml(0, base.count, info0);
          setStatusRows(base.count, df.rowCount);
          syncFilterChrome(base.count, 0, true);
          return this;
        }

        var info = resolvePage(view.count, ds.pageSize, ds.page);
        if (ds.page !== info.page) ds.page = info.page;              // 静默校正（不触发事件，避免重入）
        _lastInfo = info;

        var res = buildTableHtml(view, {
          page: info.page, pageSize: info.pageSize,
          fontFamily: view.fontFamily, fontSize: view.fontSize,
          colFilters: colFilters
        });
        _wrap.innerHTML = res.html;
        if (_pager) _pager.innerHTML = buildPagerHtml(view.count, hasFilter ? base.count : df.rowCount, info);
        syncFilterChrome(base.count, view.count, hasFilter);        // 有表头筛选：标题行文案在其中写
        if (_count && !hasFilter) {
          _count.textContent = df.rowCount > view.count
            ? '共 ' + U.fmtInt(view.count) + ' 行（原始 ' + U.fmtInt(df.rowCount) + ' 行）'
            : '共 ' + U.fmtInt(view.count) + ' 行';
        }
        setStatusRows(base.count, df.rowCount);                      // 表头筛选另由 #status-filter 报告，避免重复

        if (info.pageSize >= HUGE_ROWS && _hugeWarned !== info.pageSize) {
          _hugeWarned = info.pageSize;
          U.toast('每页 ' + U.fmtInt(info.pageSize) + ' 行，仅渲染当前页；大数据翻页可能较慢', 'warn');
        }
        return this;
      } catch (err) {
        if (global.console) global.console.error('[YMS.DataGrid] render 失败', err);
        U.toast('数据显示区渲染失败：' + err.message, 'error');
        return this;
      }
    },

    /** 跳转到指定页（1 基，自动 clamp） */
    goto: function (page) {
      try {
        if (!Store.hasData()) { U.toast('尚未载入数据', 'warn'); return this; }
        var view = Store.getView();
        if (!view || !view.count) { U.toast('当前没有可显示的数据', 'warn'); return this; }
        var ds = Store.state.dataSettings;
        var info = resolvePage(view.count, ds.pageSize, page);
        var changed = ds.page !== info.page;
        ds.page = info.page;                                         // 写回 Store
        this.render();
        if (changed) Store.emit('datasettings', { page: ds.page, pageSize: ds.pageSize });
        return this;
      } catch (err) {
        if (global.console) global.console.error('[YMS.DataGrid] goto 失败', err);
        return this;
      }
    },

    /** 设置每页行数（clamp 到 [100, 200000]，回到第 1 页） */
    setPageSize: function (n) {
      try {
        if (!Store.hasData()) { U.toast('尚未载入数据', 'warn'); return this; }
        var ds = Store.state.dataSettings;
        var size = U.clamp(Math.round(Number(n) || 0) || ds.pageSize, MIN_PAGE_SIZE, MAX_PAGE_SIZE);
        var changed = ds.pageSize !== size || ds.page !== 1;
        ds.pageSize = size;                                          // 写回 Store
        ds.page = 1;
        this.render();
        if (changed) Store.emit('datasettings', { page: ds.page, pageSize: ds.pageSize });
        return this;
      } catch (err) {
        if (global.console) global.console.error('[YMS.DataGrid] setPageSize 失败', err);
        return this;
      }
    },

    /** 当前分页信息（只读；未渲染过时返回 null） */
    info: function () { return _lastInfo; },

    /* ---- 表头筛选（迭代 23；只读 → 自测 / 帮助文档用） ---- */
    /** 当前表头筛选快照：{ 列名: {values:N, missing:bool} } */
    filters: function () {
      var out = {}, k;
      for (k in colFilters) {
        if (!hasOwn(colFilters, k)) continue;
        var f = colFilters[k], n = 0, kk;
        for (kk in f.keys) if (hasOwn(f.keys, kk) && f.keys[kk]) n++;
        out[k] = { values: n, missing: !!f.missing };
      }
      return out;
    },
    /** 表头筛选后的可见行数（无筛选时等于基视图行数） */
    filteredCount: function () {
      var base = Store.hasData() ? Store.getView() : null;
      if (!base || !base.count) return 0;
      var keep = buildKeep(base);
      return keep ? keep.length : base.count;
    },
    /** 一键清除全部表头筛选（与标题行按钮同义） */
    clearFilters: function () { clearAllFilters(); return this; },

    /* ---- 内部纯逻辑导出（Node 自测用，不属公开契约） ---- */
    _resolvePage: resolvePage,
    _buildTableHtml: buildTableHtml,
    _buildPagerHtml: buildPagerHtml,
    _subView: subView,
    _buildKeep: buildKeep,
    _uniqueStats: uniqueStats,
    _colFilters: function () { return colFilters; },
    _panelCol: function () { return _popCol; },
    _searchMs: FSEARCH_MS,
    _maxItems: FMAX_ITEMS
  };

  YMS.DataGrid = DataGrid;
})(typeof window !== 'undefined' ? window : this);
