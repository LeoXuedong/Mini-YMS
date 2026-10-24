/* ==========================================================================
   YMS · core/util.js
   通用工具：DOM、格式化、下载、Toast / Modal / 进度条 / 确认框 / 状态栏
   注意：本工程必须在 file:// 下零依赖运行 —— 禁止 ES module / fetch / XHR / Worker。
   全部模块挂在全局命名空间 YMS 下，用普通 <script> 顺序加载。
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  YMS.version = '1.0.0';

  /* ------------------------------------------------------------------ DOM */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /**
   * 创建元素。el('div', {class:'x', 'data-a':1, onclick:fn}, ['文本', childEl])
   */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class' || k === 'className') { node.className = v; }
        else if (k === 'style' && typeof v === 'object') { Object.assign(node.style, v); }
        else if (k === 'html') { node.innerHTML = v; }
        else if (k === 'text') { node.textContent = v; }
        else if (k.indexOf('on') === 0 && typeof v === 'function') { node.addEventListener(k.slice(2), v); }
        else if (k === 'dataset' && typeof v === 'object') { Object.assign(node.dataset, v); }
        else { node.setAttribute(k, v === true ? '' : v); }
      });
    }
    if (children !== null && children !== undefined) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
      });
    }
    return node;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  /* ------------------------------------------------------------- 字符串/数值 */
  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** 千分位整数 */
  function fmtInt(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  /** 数值显示：decimals 为 null → 自动（最多 6 位有效小数，去尾零） */
  function fmtNumber(v, decimals) {
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '';
    if (typeof v !== 'number') return String(v);
    if (decimals !== null && decimals !== undefined && decimals !== '') {
      return v.toFixed(Math.max(0, Math.min(8, Number(decimals))));
    }
    if (Number.isInteger(v)) return String(v);
    var s = String(v);
    if (s.indexOf('e') >= 0 || s.indexOf('E') >= 0) return s;
    var dot = s.indexOf('.');
    if (dot < 0) return s;
    // 自动模式：小数位不超过 6 位，去掉多余尾零
    var frac = s.slice(dot + 1, dot + 7).replace(/0+$/, '');
    return frac ? s.slice(0, dot + 1) + frac : s.slice(0, dot);
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }
  function fmtDuration(ms) {
    if (ms < 1000) return Math.round(ms) + ' ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + ' s';
    return Math.floor(s / 60) + ' min ' + (s % 60).toFixed(0) + ' s';
  }
  function nowStamp(d) {
    d = d || new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  /* ------------------------------------------------------------------ 杂项 */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  var _uid = 0;
  function uid(prefix) { return (prefix || 'id') + '_' + (++_uid) + '_' + Date.now().toString(36); }
  function deepClone(o) { return o === undefined ? o : JSON.parse(JSON.stringify(o)); }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms || 120);
    };
  }
  /** 让出主线程，保持 UI 响应（长任务分片执行） */
  function nextTick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* --------------------------------------------------------------- 文件下载 */
  function downloadBlob(fileName, blob) {
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: fileName });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  }
  function downloadText(fileName, text, mime) {
    downloadBlob(fileName, new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' }));
  }

  /* ------------------------------------------------------------------ 状态栏 */
  function setStatus(msg, kind) {
    var n = $('#status-msg');
    if (!n) return;
    n.textContent = msg;
    n.className = 'status-msg' + (kind ? ' is-' + kind : '');
  }
  function setStatusTime(text) {
    var n = $('#status-time');
    if (n) n.textContent = text || '—';
  }

  /* ------------------------------------------------------------------ Toast */
  function toast(msg, kind, ms) {
    var root = $('#toast-root');
    if (!root) return;
    var node = el('div', { class: 'toast' + (kind ? ' is-' + kind : ''), html: msg });
    root.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .2s';
      node.style.opacity = '0';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 220);
    }, ms || (kind === 'error' ? 5200 : 3000));
  }

  /* ---------------------------------------------------------------- Modal */
  /**
   * modal({title, body|bodyHTML, footer:[{text, cls, onClick(close)}], width:'wide'|'xl'|null,
   *        onClose, closable:true}) -> {root, close(), setBody(node|html)}
   */
  function modal(opts) {
    opts = opts || {};
    var root = $('#modal-root');
    var mask = el('div', { class: 'modal-mask' });
    var box = el('div', { class: 'modal' + (opts.width ? ' modal-' + opts.width : '') });
    var closer = null;
    function close() {
      if (!mask.parentNode) return;
      mask.parentNode.removeChild(mask);
      document.removeEventListener('keydown', onKey, true);
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    var head = el('div', { class: 'modal-head' }, [
      el('span', { text: opts.title || '' }),
      el('button', { class: 'modal-x', title: '关闭 (Esc)', text: '✕', onclick: close })
    ]);
    if (opts.closable === false) head.lastChild.style.display = 'none';
    var body = el('div', { class: 'modal-body' });
    if (opts.bodyHTML !== undefined) body.innerHTML = opts.bodyHTML;
    else if (opts.body) body.appendChild(opts.body);
    box.appendChild(head);
    box.appendChild(body);
    if (opts.footer) {
      var foot = el('div', { class: 'modal-foot' });
      opts.footer.forEach(function (b) {
        foot.appendChild(el('button', {
          class: 'btn ' + (b.cls || ''), text: b.text, disabled: !!b.disabled,
          onclick: function () { if (b.onClick) b.onClick(close); else close(); }
        }));
      });
      box.appendChild(foot);
    }
    mask.appendChild(box);
    mask.addEventListener('mousedown', function (e) { if (e.target === mask && opts.closable !== false) close(); });
    root.appendChild(mask);
    document.addEventListener('keydown', onKey, true);
    closer = { root: mask, box: box, body: body, close: close, setBody: function (c) { clear(body); body.appendChild(typeof c === 'object' ? c : el('div', { html: String(c) })); } };
    return closer;
  }

  /** 确认框 -> Promise<boolean> */
  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      var m = modal({
        title: opts.title || '确认',
        bodyHTML: '<div style="max-width:520px">' + (opts.message || '') + '</div>',
        footer: [
          { text: opts.cancelText || '取消', onClick: function (c) { done = true; c(); resolve(false); } },
          { text: opts.okText || '确定', cls: 'btn-primary', onClick: function (c) { done = true; c(); resolve(true); } }
        ],
        onClose: function () { if (!done) resolve(false); }
      });
      return m;
    });
  }

  /** 进度条 ------------------------------------------------ */
  var progress = {
    open: function (title, note) {
      var root = $('#progress-root');
      root.innerHTML = '';
      var pct = el('i');
      var sub = el('div', { class: 'progress-sub', text: note || '准备中…' });
      var noteEl = el('div', { class: 'progress-note', text: '' });
      var bar = el('div', { class: 'progress-bar' }, [pct]);
      var card = el('div', { class: 'progress-card' }, [
        el('div', { class: 'progress-title', text: title || '处理中' }), sub, bar, noteEl
      ]);
      root.appendChild(card);
      root.classList.add('is-open');
      this._pct = pct; this._sub = sub; this._note = noteEl; this._root = root;
      return this;
    },
    update: function (pct, note) {
      if (this._pct) this._pct.style.width = clamp(pct || 0, 0, 100).toFixed(1) + '%';
      if (note !== undefined && this._sub) this._sub.textContent = note;
    },
    note: function (text) { if (this._note) this._note.textContent = text || ''; },
    close: function () { if (this._root) { this._root.classList.remove('is-open'); this._root.innerHTML = ''; } }
  };

  /* --------------------------------------------------------------- 右键菜单 */
  /* 支持三种菜单项：
     · {label, sub, disabled, title, onClick}            —— 普通项（向后兼容）
     · {label, submenu:[...]}                            —— 二级菜单（向右原地展开 flyout，自动避让屏幕边缘）
     · {label, input:{placeholder|fields, okText, onConfirm(valueOrValues)}} —— 原地输入行（不弹窗）
     · {input:{..., open:true}}                          —— 直接展开输入行（无需先点标签）
     · '-'                                               —— 分隔线                                            */
  var _ctxNode = null;        // 顶层菜单节点
  var _ctxFly = null;         // 当前展开的二级菜单（最内层）
  var _ctxAutoOpen = [];      // 需要构建后立即展开的输入行
  var _ctxRow = null;         // 菜单内原地输入行
  var _ctxRowAnchor = null;   // 输入行所属的菜单项
  var _ctxArmed = false;      // 打开后同一轮事件内不响应"外部点击"（否则刚开就被自己关掉）
  var _ctxLeaveTimer = null;  // 鼠标移出菜单区域的延时收起定时器

  /** 当前所有二级菜单（多级可同时展开，以 DOM 为准，不用单个指针推断） */
  function _ctxFlies() {
    if (!_ctxNode || !_ctxNode.querySelectorAll) return [];
    return Array.prototype.slice.call(_ctxNode.querySelectorAll('.ctx-submenu'));
  }
  /** 关闭全部二级菜单（悬停到别的项 / 鼠标移出整个菜单区域时立即调用） */
  function _closeAllFlies() {
    _ctxFly = null;
    var flies = _ctxFlies();
    for (var i = 0; i < flies.length; i++) if (flies[i].parentNode) flies[i].parentNode.removeChild(flies[i]);
  }
  /** 关闭菜单内的原地输入行 */
  function _closeCtxRow() {
    if (_ctxRow && _ctxRow.parentNode) _ctxRow.parentNode.removeChild(_ctxRow);
    _ctxRow = null; _ctxRowAnchor = null;
  }
  /**
   * 关闭除 anchor 所在祖先链以外的所有二级菜单（保证多层子菜单可同时展开）
   * 保留条件：该子菜单包含 anchor（anchor 在它里面），或该子菜单恰好由 anchor 展开
   * （后者保证"鼠标在同一父项内移动"时不会把已经展开的子菜单拆掉重建 → 无闪烁 / 无残影）
   */
  function _closeOtherFlies(anchor) {
    if (!_ctxNode) { _ctxFly = null; return; }
    var flies = _ctxFlies();
    for (var i = 0; i < flies.length; i++) {
      var f = flies[i];
      if (f._anchor === anchor) continue;                 // 该项自己的子菜单 → 保留
      if (f.contains && f.contains(anchor)) continue;      // 祖先链上的子菜单 → 保留
      if (f.parentNode) f.parentNode.removeChild(f);
    }
    _ctxFly = null;
  }
  /** 查找 anchor 已经展开的二级菜单 */
  function _findFly(anchor) {
    var flies = _ctxFlies();
    for (var i = 0; i < flies.length; i++) if (flies[i]._anchor === anchor) return flies[i];
    return null;
  }

  /** 二级菜单定位：优先贴锚点右侧，越界时向左 / 向上避让 */
  function _placeCtxFly(anchor, fly) {
    var base = _ctxNode || anchor.parentNode;
    var br = base.getBoundingClientRect ? base.getBoundingClientRect() : { left: 0, top: 0 };
    var ar = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: br.left, right: br.left, top: br.top };
    var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    var fw = fly.offsetWidth || 180, fh = fly.offsetHeight || 120;
    var left = (ar.right + fw + 6 > vw) ? (ar.left - fw + 4) : (ar.right - 4);
    if (left < 4) left = 4;
    var top = ar.top - 4;
    if (top + fh > vh - 6) top = Math.max(4, vh - fh - 8);
    fly.style.left = Math.round(left - br.left) + 'px';
    fly.style.top = Math.round(top - br.top) + 'px';
  }

  /** 原地输入行：[input…][确定][取消]（插入在锚点项下方，不遮罩、不弹窗） */
  function _openInputRow(anchor, spec) {
    spec = spec || {};
    _closeCtxRow();                                   // 同一时刻只允许一行动态输入
    var fields = (spec.fields && spec.fields.length) ? spec.fields
      : [{ placeholder: spec.placeholder, value: spec.value, width: spec.width, mono: spec.mono }];
    var inputs = fields.map(function (f) {
      f = f || {};
      var attrs = {
        class: 'ctx-input' + (f.mono ? ' mono' : ''),
        type: 'text',
        placeholder: f.placeholder || '',
        value: (f.value === undefined || f.value === null) ? '' : f.value,
        'data-pick': '1'
      };
      if (f.width) attrs.style = { width: f.width };
      return el('input', attrs);
    });
    var row = el('div', { class: 'ctx-input-row' });
    inputs.forEach(function (i) { row.appendChild(i); });
    var okBtn = el('button', { class: 'ctx-ok', text: spec.okText || '确定' });
    var cancelBtn = el('button', { class: 'ctx-cancel', text: '取消' });
    row.appendChild(okBtn); row.appendChild(cancelBtn);
    anchor.parentNode.insertBefore(row, anchor.nextSibling);
    _ctxRow = row; _ctxRowAnchor = anchor;
    function done() {
      if (_ctxRow === row) { _ctxRow = null; _ctxRowAnchor = null; }
      if (row.parentNode) row.parentNode.removeChild(row);
    }
    function commit() {
      var vals = inputs.map(function (i) { return i.value; });
      var payload = (fields.length > 1) ? vals : vals[0];
      done();
      if (spec.keepOpen !== true) closeContextMenu();   // 执行完立刻收整个菜单
      if (typeof spec.onConfirm === 'function') spec.onConfirm(payload);
    }
    okBtn.addEventListener('click', function (e) { e.stopPropagation(); commit(); });
    /* 取消 / Esc 同样立刻收掉整个菜单（不留残影） */
    cancelBtn.addEventListener('click', function (e) { e.stopPropagation(); done(); closeContextMenu(); });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); closeContextMenu(); }
    });
    /* 点输入行内部不应被当作"外部点击"，也不应触发上层菜单项的点击 */
    row.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    try { inputs[0].focus(); } catch (e2) { /* 无焦点能力（如 Node 桩）时忽略 */ }
    return row;
  }

  /** 悬停到某个菜单项：立即收起不在其祖先链上的二级菜单，并收起其它项的输入行 */
  function _ctxHoverItem(node) {
    if (!node) return;
    _closeOtherFlies(node);
    if (_ctxRowAnchor && _ctxRowAnchor !== node) _closeCtxRow();
  }

  /** 递归构建菜单项 */
  function _buildCtxItems(container, items) {
    (items || []).forEach(function (it) {
      if (it === '-') { container.appendChild(el('div', { class: 'ctx-sep' })); return; }
      if (!it) return;
      var hasSub = !!(it.submenu && it.submenu.length);
      var node = el('div', {
        class: 'ctx-item' + (it.disabled ? ' is-disabled' : '') + (hasSub ? ' has-sub' : ''),
        title: it.title || ''
      });
      if (it.label !== undefined && it.label !== null) node.appendChild(el('span', { class: 'ctx-label', text: it.label }));
      if (it.sub) node.appendChild(el('span', { class: 'ctx-sub', text: it.sub }));
      /* ⓘ：只打开说明面板，不执行本项的主动作（不冒泡到菜单项） */
      if (it.info) {
        var infoBtn = el('span', {
          class: 'expr-info',
          title: it.infoTitle || '函数与语法说明',
          role: 'button',
          text: 'ⓘ'
        });
        infoBtn.addEventListener('mousedown', function (e) { e.stopPropagation(); });
        infoBtn.addEventListener('click', function (e) {
          e.stopPropagation(); e.preventDefault();
          closeContextMenu();
          if (typeof it.info === 'function') it.info();
        });
        node.appendChild(infoBtn);
      }
      if (hasSub) node.appendChild(el('span', { class: 'ctx-arrow', text: '›' }));
      container.appendChild(node);
      if (it.disabled) return;

      if (hasSub) {
        var openSub = function () {
          if (!node.parentNode || (node.parentNode.classList && node.parentNode.classList.contains('is-closing'))) return;
          _closeOtherFlies(node);                       // 只保留祖先链上的二级菜单
          var already = _findFly(node);                 // 已展开 → 直接复用
          if (already) { _ctxFly = already; return; }
          var fly = el('div', { class: 'ctx-menu ctx-submenu' });
          _buildCtxItems(fly, it.submenu);
          (_ctxNode || container).appendChild(fly);
          fly._anchor = node;
          _ctxFly = fly;
          _placeCtxFly(node, fly);
        };
        /* 悬停 / 点击 → 向右原地展开（不弹窗）；收起由顶层 mouseover 委托统一处理 */
        node._ctxOpenSub = openSub;
        node.addEventListener('click', function (e) { e.stopPropagation(); _ctxHoverItem(node); openSub(); });
        return;
      }
      if (it.input) {
        node.addEventListener('click', function (e) { e.stopPropagation(); _openInputRow(node, it.input); });
        if (it.open) _ctxAutoOpen.push(function () { _openInputRow(node, it.input); });
        return;
      }
      if (it.onClick) {
        /* 执行动作前先关菜单，再执行（弹层 / 确认框不会顶着菜单打开） */
        node.addEventListener('click', function (e) { e.stopPropagation(); closeContextMenu(); it.onClick(); });
      }
    });
  }

  function contextMenu(x, y, items) {
    closeContextMenu();
    var root = $('#context-menu-root');
    if (!root) return null;
    var menu = el('div', { class: 'ctx-menu' });
    _ctxNode = menu;
    _buildCtxItems(menu, items);
    root.appendChild(menu);
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 8)) + 'px';

    /* 顶层委托：悬停到任一菜单项 → 立即收起不相干的二级菜单与输入行；移出整个菜单区域 → 收起子菜单 */
    menu.addEventListener('mouseover', function (e) {
      var t = e.target;
      var item = (t && t.closest) ? t.closest('.ctx-item') : null;
      if (!item || !menu.contains(item)) return;
      _ctxHoverItem(item);
      if (item._ctxOpenSub) item._ctxOpenSub();
    });
    menu.addEventListener('mouseleave', function () {
      if (_ctxLeaveTimer) clearTimeout(_ctxLeaveTimer);
      _ctxLeaveTimer = setTimeout(function () {
        _ctxLeaveTimer = null;
        _closeAllFlies();                            // 鼠标已离开整个菜单（含子菜单）→ 不留悬空子菜单
      }, 40);
    });
    menu.addEventListener('mouseenter', function () {
      if (_ctxLeaveTimer) { clearTimeout(_ctxLeaveTimer); _ctxLeaveTimer = null; }
    });

    var auto = _ctxAutoOpen; _ctxAutoOpen = [];
    auto.forEach(function (fn) { try { fn(); } catch (e) { /* 忽略：输入行展开失败不影响菜单 */ } });

    /* 事件监听**立即**绑定（捕获阶段）：点外部任意处 / 在别处右键 / 按 Esc 都当场关闭。
       用 _ctxArmed 挡住"打开菜单的那一次事件本身"，避免刚打开就被关掉。 */
    _ctxArmed = false;
    document.addEventListener('mousedown', _ctxOutside, true);
    document.addEventListener('contextmenu', _ctxOutside, true);
    document.addEventListener('click', _ctxOutside, true);
    document.addEventListener('keydown', _ctxKey, true);
    setTimeout(function () { _ctxArmed = true; }, 0);
    return menu;
  }
  function _ctxOutside(e) {
    if (!_ctxNode || !_ctxArmed || !e || !e.target) return;
    if (_ctxNode.contains(e.target)) return;         // 菜单内部（含子菜单 / 输入行）→ 不关闭
    closeContextMenu();
  }
  function _ctxKey(e) {
    if (!_ctxNode) return;
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    closeContextMenu();
  }
  function closeContextMenu() {
    _closeAllFlies();
    _closeCtxRow();
    _ctxAutoOpen = [];
    _ctxArmed = false;
    if (_ctxLeaveTimer) { clearTimeout(_ctxLeaveTimer); _ctxLeaveTimer = null; }
    if (_ctxNode && _ctxNode.parentNode) _ctxNode.parentNode.removeChild(_ctxNode);
    _ctxNode = null;
    document.removeEventListener('mousedown', _ctxOutside, true);
    document.removeEventListener('contextmenu', _ctxOutside, true);
    document.removeEventListener('click', _ctxOutside, true);
    document.removeEventListener('keydown', _ctxKey, true);
  }

  /* --------------------------------------------------------------- 通用小控件 */
  /** 多选 + 可增删的 "+" 控件（数据设置区等仍在用；绘图设置区的四个参数字段已改用 checkList）
   *  点 "+"（或控件本体）→ 在控件正下方原地插入一行 [select][确定][取消]（不遮罩、不弹窗）：
   *  自动 focus；Enter 确认 / Esc 取消；失焦不自动提交；确认后加入标签并移除该行。 */
  var activePickerClose = null;   // 全局：同一时刻只允许一个原地下拉展开（点另一个控件会收起前一个）

  function multiSelect(opts) {
    // opts: {options:[{value,label}], values:[...], placeholder, onChange(values)}
    // 交互：直接点控件本体即可在原地下拉选择，不必先点 "+"（"+" 保留为等效入口）
    var wrap = el('div', { class: 'plus-row plus-multi' });
    var box = el('div', { class: 'multi-select-box', tabindex: '0', role: 'button', title: '点击选择参数' });
    var addBtn = el('button', { class: 'mini-btn', title: '新增一项 (+)', text: '+' });
    var values = (opts.values || []).slice();
    var picker = null;                       // 原地选择行（展开时非 null）

    function render() {
      clear(box);
      if (!values.length) box.appendChild(el('span', { class: 'tag-placeholder', text: opts.placeholder || '未选择' }));
      values.forEach(function (v, i) {
        box.appendChild(el('span', { class: 'tag is-accent' }, [
          el('span', { text: labelOf(v) }),
          el('span', {
            class: 'tag-x', text: '✕', title: '移除',
            onclick: function (ev) {
              if (ev && ev.stopPropagation) ev.stopPropagation();   // 删除标签不要触发展开下拉
              values.splice(i, 1); render(); fire();
            }
          })
        ]));
      });
    }
    function labelOf(v) {
      var f = (opts.options || []).filter(function (o) { return o.value === v; })[0];
      return f ? f.label : v;
    }
    function fire() { if (opts.onChange) opts.onChange(values.slice()); }
    /** 移除原地选择行 */
    function closePicker() {
      if (picker && picker.parentNode) picker.parentNode.removeChild(picker);
      picker = null;
      if (box.classList) box.classList.remove('is-open');
      if (activePickerClose === closePicker) activePickerClose = null;
    }
    /** 确认：写入多选集（重复项行为与原有实现一致） */
    function commitPicker() {
      if (!picker) return;
      var sel = picker.querySelector ? picker.querySelector('select') : null;
      var v = sel ? sel.value : '';
      if (v !== '') { values.push(v); render(); fire(); }
      closePicker();
    }
    /** 点 "+" → 原地插入 [select][确定][取消] */
    function openPicker() {
      if (picker) { var s0 = picker.querySelector ? picker.querySelector('select') : null; if (s0 && s0.focus) s0.focus(); return; }
      if (activePickerClose) { try { activePickerClose(); } catch (e0) { } }   // 收起其它控件已展开的下拉
      var sel = el('select', { class: 'pick-select w-100' });
      sel.appendChild(el('option', { value: '', text: '— 选择参数 —' }));
      (opts.options || []).forEach(function (o) { sel.appendChild(el('option', { value: o.value, text: o.label })); });
      var okBtn = el('button', { class: 'btn btn-sm pick-ok', text: '确定', title: '添加（Enter）' });
      var cancelBtn = el('button', { class: 'btn btn-sm pick-cancel', text: '取消', title: '取消（Esc）' });
      picker = el('div', { class: 'inline-picker' }, [sel, okBtn, cancelBtn]);
      okBtn.addEventListener('click', function (e) { if (e.preventDefault) e.preventDefault(); commitPicker(); });
      cancelBtn.addEventListener('click', function (e) { if (e.preventDefault) e.preventDefault(); closePicker(); });
      picker.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitPicker(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
      });
      wrap.appendChild(picker);              // 控件正下方（第二行）
      activePickerClose = closePicker;       // 登记为当前展开者
      if (box.classList) box.classList.add('is-open');
      if (sel.focus) sel.focus();
    }
    addBtn.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); openPicker(); });
    /* 直接点控件本体（含占位文字区域）→ 展开原地下拉；点 ✕ 只删标签不展开 */
    box.addEventListener('click', function (e) {
      var t = e && e.target;
      if (t && t.className && String(t.className).indexOf('tag-x') >= 0) return;
      if (e && e.preventDefault) e.preventDefault();
      openPicker();
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
      else if (e.key === 'Escape') closePicker();
    });
    render();
    wrap.appendChild(box); wrap.appendChild(addBtn);
    return {
      node: wrap, box: box,
      openPicker: openPicker,
      get: function () { return values.slice(); },
      set: function (arr) { closePicker(); values = (arr || []).slice(); render(); },
      setOptions: function (o) { opts.options = o; render(); }
    };
  }

  /* --------------------------------------------------------------- 通用小控件 */
  /**
   * 参数直接点选列表（checkList）—— 把候选参数平铺成一组小方块（chip）：
   * 点一下即选中、再点一下即取消；没有下拉、没有「确定 / 取消」按钮、不弹任何窗口。
   * 顺序语义：values 的顺序 = 用户点击先后（X Label 多列会拼成复合类别、
   * Value 多列是多条 series，顺序有意义），选中 chip 右上角显示序号角标 1/2/3…；
   * 取消后再选会排到末尾。
   * opts: {options:[{value,label,title}], values:[...], placeholder, columns, id, onChange(values)}
   * 返回：{node, get(), set(arr), setOptions(list), clear()}
   */
  function checkList(opts) {
    opts = opts || {};
    var root = el('div', { class: 'check-list' });
    if (opts.id) root.id = opts.id;
    var values = (opts.values || []).slice();                 // 选中顺序 = 数组顺序
    var head = el('div', { class: 'check-list-head' });
    var empty = el('span', { class: 'chk-empty', text: opts.placeholder || '未选择' });
    /* 「清空」入口：纯文字链接样式，一键取消该字段全部选中（无弹窗、无二次确认） */
    var clearBtn = el('button', {
      class: 'chk-clear', type: 'button', title: '清空该字段（取消全部选中）', text: '清空'
    });
    head.appendChild(empty);
    head.appendChild(clearBtn);
    var chips = el('div', { class: 'chk-chips' });
    var cols = String(clamp(opts.columns || 2, 1, 4));      // 网格列数（默认两列）
    /* 极简 DOM 桩（单测里常见）只有 style 对象、没有 setProperty → 兜底避免整条面板初始化失败 */
    if (chips.style && typeof chips.style.setProperty === 'function') chips.style.setProperty('--chk-cols', cols);
    else if (chips.style) chips.style['--chk-cols'] = cols;
    root.appendChild(head);
    root.appendChild(chips);

    function fire() { if (typeof opts.onChange === 'function') opts.onChange(values.slice()); }
    function render() {
      clear(chips);
      (opts.options || []).forEach(function (o) {
        var idx = values.indexOf(o.value);                    // -1 = 未选中
        var on = idx >= 0;
        var chip = el('button', {
          class: 'chk-chip' + (on ? ' is-on' : ''),
          type: 'button',
          'data-value': o.value,
          'aria-pressed': on ? 'true' : 'false',
          title: (on ? '已选中（第 ' + (idx + 1) + ' 位），点击取消：' : '点击选中：') + (o.title || o.label)
        });
        chip.appendChild(el('span', { class: 'chip-label', text: o.label }));
        /* 选中项带序号角标：1 号 = 第一个点的，便于确认 X / Value 的顺序 */
        if (on) chip.appendChild(el('i', { class: 'chip-order', text: String(idx + 1) }));
        chip.addEventListener('click', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          toggle(o.value);
        });
        chips.appendChild(chip);
      });
      empty.style.display = values.length ? 'none' : '';       // 空列表才显示占位文字
      if (values.length) clearBtn.classList.remove('is-off');  // 空列表时「清空」置灰
      else clearBtn.classList.add('is-off');
    }
    /** 点一下切换选中态：选中 → 追加到末尾；取消 → 移除 */
    function toggle(v) {
      var i = values.indexOf(v);
      if (i >= 0) values.splice(i, 1); else values.push(v);
      render();
      fire();
    }
    clearBtn.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (!values.length) return;
      values = [];
      render();
      fire();
    });
    render();
    return {
      node: root, chips: chips, clearBtn: clearBtn,
      get: function () { return values.slice(); },
      set: function (arr) { values = (arr || []).slice(); render(); },
      setOptions: function (list) { opts.options = list || []; render(); },
      clear: function () { values = []; render(); fire(); }
    };
  }

  /* --------------------------------------------------------------- 通用小控件 */
  /**
   * 下拉式多选控件（dropSelect）—— 绘图设置区 X Label / Value / Page by / Split by 用：
   * 平时只显示当前选择（标签摘要 / 占位文字）+ 下拉箭头，**不铺开未选项**；
   * 点一下触发器 → 在触发器正下方弹出选项面板（限高可滚动）；点选项立即选中 / 再点即取消，
   * **面板不关闭**（方便连选）；没有「确定 / 取消」按钮、没有遮罩弹窗；
   * 点击面板外或按 Esc 关闭。顺序语义：values 顺序 = 点击先后（X Label 多列拼成复合类别、
   * Value 多列是多条 series），已选项带 1/2/3… 序号角标；取消后再选排到末尾。
   * opts: {options:[{value,label,title}], values:[...], placeholder, id, maxHeight, onChange(values)}
   * 返回：{node, trigger, get(), set(arr), setOptions(list), toggle(v), clear(), close()}
   */
  var _dropClose = null;        // 当前展开的下拉面板关闭器（同一时刻只允许一个字段展开）

  /** 收起当前展开的下拉面板（重建设置面板前调用，避免面板残留在 body 上） */
  function closeDropSelect() { if (_dropClose) { try { _dropClose(); } catch (e) { _dropClose = null; } } }

  function dropSelect(opts) {
    opts = opts || {};
    var root = el('div', { class: 'check-list drop-select' });
    if (opts.id) root.id = opts.id;
    var values = (opts.values || []).slice();                 // 选中顺序 = 数组顺序 = 点击先后
    /* 触发器：长得像普通下拉框 —— 只显示当前选择 + 箭头，选项一个都不铺 */
    var tagsBox = el('span', { class: 'drop-tags' });
    var trigger = el('button', {
      class: 'drop-trigger', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false'
    });
    trigger.appendChild(tagsBox);
    trigger.appendChild(el('i', { class: 'drop-arrow', text: '▾' }));
    root.appendChild(trigger);

    var panel = null;             // 选项面板（挂在 body 上，首次展开才创建）
    var opened = false;

    function fire() { if (typeof opts.onChange === 'function') opts.onChange(values.slice()); }
    function labelOf(v) {
      var hit = null;
      (opts.options || []).forEach(function (o) { if (o.value === v) hit = o; });
      return hit ? hit.label : v;
    }
    function titleOf(v) {
      var hit = null;
      (opts.options || []).forEach(function (o) { if (o.value === v) hit = o; });
      return (hit && hit.title) ? hit.title : labelOf(v);
    }

    /** 触发器内容：未选 → 占位文字；已选 → 标签（带顺序角标），未选项绝不出现 */
    function renderTrigger() {
      tagsBox.innerHTML = '';
      if (!values.length) {
        tagsBox.appendChild(el('span', { class: 'drop-ph', text: opts.placeholder || '未选择' }));
        trigger.title = '点击选择' + (opts.placeholder ? '（' + opts.placeholder + '）' : '');
      } else {
        values.forEach(function (v, i) {
          tagsBox.appendChild(el('span', {
            class: 'drop-tag', 'data-value': v,
            title: '第 ' + (i + 1) + ' 个选中：' + titleOf(v)
          }, [
            el('span', { class: 'drop-tag-label', text: labelOf(v) }),
            el('i', { class: 'drop-order', text: String(i + 1) })
          ]));
        });
        trigger.title = '已选 ' + values.length + ' 项（顺序 = 点击先后），点击展开选项';
      }
    }

    /** 面板行：每行一个选项；选中行高亮 + 勾选标记 + 序号角标；点一下即切换（不关面板） */
    function renderOptions() {
      if (!panel) return;
      var list = panel.list;
      list.innerHTML = '';
      (opts.options || []).forEach(function (o) {
        var idx = values.indexOf(o.value), on = idx >= 0;
        var row = el('button', {
          class: 'drop-opt' + (on ? ' is-on' : ''), type: 'button',
          'data-value': o.value, 'aria-selected': on ? 'true' : 'false',
          title: (on ? '已选中（第 ' + (idx + 1) + ' 位），点击取消：' : '点击选中：') + (o.title || o.label)
        });
        row.appendChild(el('i', { class: 'drop-check', text: '✓' }));
        row.appendChild(el('span', { class: 'drop-opt-label', text: o.label }));
        if (on) row.appendChild(el('i', { class: 'drop-order', text: String(idx + 1) }));
        row.addEventListener('click', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          toggle(o.value);
        });
        list.appendChild(row);
      });
      if (panel.clearBtn && panel.clearBtn.classList) {
        if (values.length) panel.clearBtn.classList.remove('is-off');
        else panel.clearBtn.classList.add('is-off');
      }
    }

    /** 点一下切换选中态：选中 → 追加到末尾；取消 → 移除（并立即 fire，无需「确定」） */
    function toggle(v) {
      var i = values.indexOf(v);
      if (i >= 0) values.splice(i, 1); else values.push(v);
      renderTrigger();
      renderOptions();
      fire();
    }

    /** 面板定位：优先贴触发器下方；下方空间不足则向上弹；按视口夹住左右边界（不越界、不被裁切） */
    function place() {
      if (!panel || !opened) return;
      var r = trigger.getBoundingClientRect ? trigger.getBoundingClientRect() : null;
      if (!r) return;
      var vw = global.innerWidth || 1200, vh = global.innerHeight || 800;
      var w = Math.max(150, Math.min(r.width || 200, vw - 12));
      panel.style.width = Math.round(w) + 'px';
      var ph = panel.offsetHeight || 0;
      var below = r.bottom + 4;
      var top = (below + ph <= vh - 6) ? below : Math.max(6, r.top - ph - 4);
      var left = Math.max(6, Math.min(r.left || 6, vw - w - 6));
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
    }

    function onDocKey(e) {
      if (e && e.key === 'Escape') {
        if (e.stopPropagation) e.stopPropagation();
        close();
      }
    }
    /* 点击面板外关闭：触发器自身的按压缩起由 trigger 的 click 处理，这里放行 */
    function onDocDown(e) {
      var t = e && e.target;
      if (!t) return;
      if (t === trigger || (trigger.contains && trigger.contains(t))) return;
      if (panel && panel.contains && panel.contains(t)) return;
      close();
    }

    function open() {
      if (opened) { place(); return; }
      if (_dropClose && _dropClose !== close) closeDropSelect();            // 同一时刻只展开一个
      if (activePickerClose && activePickerClose !== close) {
        try { activePickerClose(); } catch (e0) { /* 收起其它控件已展开的下拉 */ }
      }
      panel = el('div', { class: 'drop-panel', role: 'listbox' });
      panel.style.maxHeight = (opts.maxHeight || 200) + 'px';
      var list = el('div', { class: 'drop-opts' });
      var foot = el('div', { class: 'drop-foot' });
      var clearBtn = el('button', {
        class: 'chk-clear', type: 'button', title: '清空该字段（取消全部选中）', text: '清空'
      });
      clearBtn.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        if (!values.length) return;
        values = [];
        renderTrigger();
        renderOptions();
        fire();
      });
      foot.appendChild(clearBtn);
      panel.appendChild(list);
      panel.appendChild(foot);
      panel.list = list;                    // 供渲染复用（避免再查 DOM）
      panel.clearBtn = clearBtn;
      if (global.document && global.document.body) global.document.body.appendChild(panel);
      opened = true;
      renderOptions();
      trigger.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      place();
      _dropClose = close;
      activePickerClose = close;
      var doc = global.document;
      if (doc) {
        doc.addEventListener('mousedown', onDocDown, true);
        doc.addEventListener('keydown', onDocKey, true);
        doc.addEventListener('scroll', place, true);
      }
      if (global.addEventListener) global.addEventListener('resize', place);
    }

    function close() {
      if (!opened) return;
      opened = false;
      var doc = global.document;
      if (doc) {
        doc.removeEventListener('mousedown', onDocDown, true);
        doc.removeEventListener('keydown', onDocKey, true);
        doc.removeEventListener('scroll', place, true);
      }
      if (global.removeEventListener) global.removeEventListener('resize', place);
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
      trigger.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      if (_dropClose === close) _dropClose = null;
      if (activePickerClose === close) activePickerClose = null;
    }

    trigger.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (opened) close(); else open();
    });
    /* 键盘：Enter / 空格 同「点一下」，Esc 收起 */
    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (opened) close(); else open();
      } else if (e.key === 'Escape') {
        close();
      }
    });

    renderTrigger();
    return {
      node: root, trigger: trigger,
      isOpen: function () { return opened; },
      open: open, close: close, toggle: toggle,
      get: function () { return values.slice(); },
      set: function (arr) { values = (arr || []).slice(); renderTrigger(); renderOptions(); },
      setOptions: function (list) { opts.options = list || []; renderOptions(); },
      clear: function () { values = []; renderTrigger(); renderOptions(); fire(); }
    };
  }

  /* ------------------------------------------- 迭代 17 · 焦点可见兜底（键盘） */
  /* 只做一件事：键盘聚焦把控件完整滚进可视区，并避开吸顶表头 / 吸底动作区。
     不接管焦点顺序、不改 DOM、不产生动画（reduced-motion 下同样安全）。 */
  var FOCUS_PAD = 8;

  /** 是否为可滚动容器（内容确实溢出才算） */
  function isScrollable(node) {
    if (!node || node.nodeType !== 1 || !global.getComputedStyle) return false;
    var cs = global.getComputedStyle(node);
    if (!cs) return false;
    var oy = String(cs.overflowY || ''), ox = String(cs.overflowX || '');
    var canY = /(auto|scroll|overlay)/.test(oy) && node.scrollHeight > node.clientHeight + 1;
    var canX = /(auto|scroll|overlay)/.test(ox) && node.scrollWidth > node.clientWidth + 1;
    return canY || canX;
  }

  /** 容器内吸顶/吸底元素占据的上下边界（表格 sticky 表头、设置区 sticky 动作区） */
  function stickyInsets(scroller, box) {
    var inset = { top: box.top, bottom: box.bottom };
    var nodes = scroller.querySelectorAll('.settings-actions, .ps-actions, .data-grid thead');
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      var cs = global.getComputedStyle(nodes[i]);
      if (!cs || cs.position !== 'sticky' || !r.height) continue;
      if (r.top <= box.top + 2 && r.bottom > box.top) inset.top = Math.max(inset.top, r.bottom);
      if (r.bottom >= box.bottom - 2 && r.top < box.bottom) inset.bottom = Math.min(inset.bottom, r.top);
    }
    return inset;
  }

  /**
   * 把获得焦点的控件滚到可见位置（避开吸顶条与吸底条）。
   * @returns {boolean} 是否发生了滚动
   */
  function revealFocus(node) {
    if (!node || node.nodeType !== 1 || !node.getBoundingClientRect) return false;
    var rect = node.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return false;
    var scroller = null, p = node.parentNode;
    while (p && p.nodeType === 1 && p !== document.body) {
      if (isScrollable(p)) { scroller = p; break; }
      p = p.parentNode;
    }
    if (!scroller) return false;
    var box = scroller.getBoundingClientRect();
    var cs = global.getComputedStyle(scroller);
    var inset = stickyInsets(scroller, box);
    var top = Math.max(box.top + (parseFloat(cs.paddingTop) || 0), inset.top) + FOCUS_PAD;
    var bottom = Math.min(box.bottom - (parseFloat(cs.paddingBottom) || 0), inset.bottom) - FOCUS_PAD;
    if (bottom <= top) return false;
    var dy = 0;
    if (rect.top < top) dy = rect.top - top;
    else if (rect.bottom > bottom) dy = rect.bottom - bottom;
    if (Math.abs(dy) < 1) return false;
    scroller.scrollTop = scroller.scrollTop + dy;
    return true;
  }

  /* 键盘聚焦（:focus-visible）时自动滚到可见；鼠标点击不干预 */
  if (document.addEventListener) {
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || t.nodeType !== 1 || !t.matches) return;
      var keyboard = true;
      try { keyboard = t.matches(':focus-visible'); } catch (err) { keyboard = true; }
      if (!keyboard) return;
      try { revealFocus(t); } catch (err2) { /* 焦点滚动失败不影响任何功能 */ }
    }, true);
  }

  YMS.util = {
    $: $, $$: $$, el: el, clear: clear,
    escapeHtml: escapeHtml, fmtInt: fmtInt, fmtNumber: fmtNumber, fmtBytes: fmtBytes,
    fmtDuration: fmtDuration, nowStamp: nowStamp, pad2: pad2,
    clamp: clamp, uid: uid, deepClone: deepClone, debounce: debounce, nextTick: nextTick,
    downloadBlob: downloadBlob, downloadText: downloadText,
    setStatus: setStatus, setStatusTime: setStatusTime, toast: toast,
    modal: modal, confirm: confirmDialog, progress: progress,
    contextMenu: contextMenu, closeContextMenu: closeContextMenu, multiSelect: multiSelect,
    checkList: checkList, dropSelect: dropSelect, closeDropSelect: closeDropSelect,
    revealFocus: revealFocus, isScrollable: isScrollable
  };
})(typeof window !== 'undefined' ? window : this);
