/* ==========================================================================
   YMS · table/data-settings.js
   右列「数据设置区」—— YMS.DataSettings
     · 草稿机制：面板内所有改动先进本地草稿，点 Submit 才 Store.applyDataSettings(draft) 生效
     · 分组：① 数据格式（逐列小数位，0–8，空=自动）② 字体与大小（字体下拉 + 字号 10–20）
             ③ 多级 Sorter（[列][升/降][↑][↓][✕] + '+'）④ 预处理（缺失值处理 + 条件筛选多行）
             ⑤ 底部 Submit（.btn-submit）+ 重置
     · 数据变化（Store 'change'/'data' 事件）→ 合并到一次重绘并重建草稿（与 Store 同步）
     · 只从 YMS.Store 读；写入只经 Store.applyDataSettings
   公开 API：init() / render()
   内部纯逻辑（供 Node 自测）：_defaultDraft / _sanitize / _summary / _missingLabel
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util, T = YMS.types, Store = YMS.Store;

  /* 缺失值处理方式（Store.dataSettings.preprocess.missing） */
  var MISSING_OPTS = [
    { value: 'none', label: '不处理' },
    { value: 'drop', label: '删除含缺失的行' },
    { value: 'mean', label: '均值填充' },
    { value: 'median', label: '中位数填充' },
    { value: 'zero', label: '0 填充' }
  ];
  /* 条件筛选运算符（与 Store.matchOne 的实现一致） */
  var OPS = ['=', '≠', '>', '≥', '<', '≤', '区间', '包含', '不包含', '缺失', '非缺失'];
  /* 字体下拉 */
  var FONTS = [
    { value: '', label: '主题默认' },
    { value: 'ui-monospace, "Cascadia Mono", Consolas, "SFMono-Regular", monospace', label: '等宽' },
    { value: '"Segoe UI", system-ui, -apple-system, sans-serif', label: 'Segoe UI' },
    { value: '"Microsoft YaHei", "微软雅黑", sans-serif', label: '微软雅黑' }
  ];
  var DEC_MIN = 0, DEC_MAX = 8, FS_MIN = 10, FS_MAX = 20;

  var _body = null, _bound = false, _draft = null, _pending = false, _dirty = false;

  /* ==========================================================================
     小工具
     ========================================================================== */
  function h(tag, attrs, children) { return U.el(tag, attrs, children); }
  /** 精确类名判断（避免 flt-val / flt-val2 子串误判） */
  function hasCls(el, name) {
    var c = (el && el.className) || '';
    return (' ' + c + ' ').indexOf(' ' + name + ' ') >= 0;
  }
  function opt(value, label, selected, disabled) {
    return h('option', { value: value, text: label, selected: !!selected, disabled: !!disabled });
  }
  function numOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    var n = Math.round(Number(v));
    return isFinite(n) ? n : null;
  }

  /* ==========================================================================
     纯逻辑：草稿默认值 / 规范化 / 摘要
     ========================================================================== */
  /** 空草稿（面板无数据时的初值） */
  function defaultDraft() {
    return {
      decimals: {}, fontFamily: '', fontSize: 12,
      sorters: [], preprocess: { missing: 'none', filters: [] }
    };
  }

  /** 从 Store 读当前设置 → 草稿（列名过滤，保证不与数据脱节） */
  function draftFromStore() {
    var ds = Store.state.dataSettings || {};
    var names = Store.colNames();
    return sanitize({
      decimals: ds.decimals || {},
      fontFamily: ds.fontFamily || '',
      fontSize: ds.fontSize,
      sorters: ds.sorters || [],
      preprocess: ds.preprocess || { missing: 'none', filters: [] }
    }, names);
  }

  /**
   * 规范化草稿（提交前必做）
   * @param {Object} draft
   * @param {string[]} colNames 当前数据的列名
   * @returns {Object} 规范化后的草稿（只含合法键）
   */
  function sanitize(draft, colNames) {
    var d = draft || {};
    var names = colNames || [];
    var exist = {}, i;
    for (i = 0; i < names.length; i++) exist[names[i]] = true;
    var out = defaultDraft();

    var src = d.decimals || {};
    Object.keys(src).forEach(function (k) {
      if (!exist[k]) return;
      var v = numOrNull(src[k]);
      if (v === null) return;                      // 空 / 非法 → 自动（不写入）
      out.decimals[k] = U.clamp(v, DEC_MIN, DEC_MAX);
    });

    out.fontFamily = typeof d.fontFamily === 'string' ? d.fontFamily : '';
    var fs = numOrNull(d.fontSize);
    out.fontSize = fs === null ? 12 : U.clamp(fs, FS_MIN, FS_MAX);

    var seen = {};
    (d.sorters || []).forEach(function (s) {
      if (!s || typeof s.col !== 'string' || !exist[s.col] || seen[s.col]) return;
      seen[s.col] = true;
      out.sorters.push({ col: s.col, dir: s.dir === 'desc' ? 'desc' : 'asc' });
    });

    var pre = d.preprocess || {};
    var okMiss = false;
    for (i = 0; i < MISSING_OPTS.length; i++) if (MISSING_OPTS[i].value === pre.missing) okMiss = true;
    out.preprocess.missing = okMiss ? pre.missing : 'none';

    (pre.filters || []).forEach(function (f) {
      if (!f || typeof f.col !== 'string' || !exist[f.col]) return;
      var op = OPS.indexOf(f.op) >= 0 ? f.op : '=';
      var needsValue = (op !== '缺失' && op !== '非缺失');
      out.preprocess.filters.push({
        col: f.col, op: op,
        value: needsValue ? String(f.value === undefined || f.value === null ? '' : f.value) : '',
        value2: op === '区间' ? String(f.value2 === undefined || f.value2 === null ? '' : f.value2) : '',
        enabled: true
      });
    });
    return out;
  }

  /** 缺失值处理方式的中文名 */
  function missingLabel(v) {
    for (var i = 0; i < MISSING_OPTS.length; i++) if (MISSING_OPTS[i].value === v) return MISSING_OPTS[i].label;
    return '不处理';
  }
  /** 字体中文名 */
  function fontLabel(v) {
    for (var i = 0; i < FONTS.length; i++) if (FONTS[i].value === v) return FONTS[i].label;
    return '自定义';
  }

  /** 草稿摘要（状态栏 / 处理说明用） */
  function summary(draft) {
    var d = draft || defaultDraft();
    var decKeys = Object.keys(d.decimals || {});
    var fAll = ((d.preprocess || {}).filters) || [];
    var fPending = fAll.filter(filterPending).length;
    var fActive = fAll.length - fPending;
    return '小数位 ' + decKeys.length + ' 列 · 字体 ' + fontLabel(d.fontFamily) + ' / ' + (d.fontSize || 12) + 'px · ' +
      '排序 ' + (d.sorters || []).length + ' 级 · 缺失值处理 ' + missingLabel((d.preprocess || {}).missing) +
      ' · 筛选 ' + fActive + ' 条' + (fPending ? '（' + fPending + ' 条未填值，不生效）' : '');
  }

  /** 空状态占位（非说明文字类：用 .group-empty，不使用 hint-inline / field-note） */
  function emptyNote(text) { return h('div', { class: 'group-empty', text: text }); }

  /** 原地选择行：在 hostRow 内插入 [控件…][确定][取消]（不弹窗、不遮罩） */
  function openInlinePicker(hostRow, fields, onCommit) {
    if (!hostRow) return null;
    var existing = hostRow.querySelector ? hostRow.querySelector('.inline-picker') : null;
    if (existing) {
      var s0 = existing.querySelector ? existing.querySelector('select, input') : null;
      if (s0 && s0.focus) s0.focus();
      return existing;
    }
    var picker = h('div', { class: 'inline-picker' });
    fields.forEach(function (f) { if (f) picker.appendChild(f); });
    var okBtn = h('button', { class: 'btn btn-sm pick-ok', text: '确定', title: '确定（Enter）' });
    var cancelBtn = h('button', { class: 'btn btn-sm pick-cancel', text: '取消', title: '取消（Esc）' });
    picker.appendChild(okBtn); picker.appendChild(cancelBtn);
    function close() { if (picker.parentNode) picker.parentNode.removeChild(picker); }
    function commit() { close(); onCommit(); }
    okBtn.addEventListener('click', function (e) { if (e.preventDefault) e.preventDefault(); commit(); });
    cancelBtn.addEventListener('click', function (e) { if (e.preventDefault) e.preventDefault(); close(); });
    picker.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    hostRow.appendChild(picker);
    var first = picker.querySelector ? picker.querySelector('select, input') : null;
    if (first && first.focus) first.focus();
    return picker;
  }

  /* ==========================================================================
     面板构建
     ========================================================================== */
  /** ① 数据格式：逐列小数位（仅数值列可编辑，时间列禁用；字符列不列出） */
  function groupDecimals() {
    var df = Store.state.df, kids = [], count = 0;
    if (df) {
      for (var i = 0; i < df.cols.length; i++) {
        var c = df.cols[i];
        if (c.type === T.STRING) continue;
        count++;
        var isTime = c.type === T.TIME;
        var cur = _draft.decimals[c.name];
        var input = h('input', {
          type: 'number', class: 'dec-input', 'data-col': c.name,
          min: DEC_MIN, max: DEC_MAX, step: 1, placeholder: isTime ? '时间' : '自动',
          value: (cur === null || cur === undefined) ? '' : cur,
          disabled: isTime, title: isTime ? '时间列格式由时间样式控制' : '小数位 0–8，留空=自动'
        });
        kids.push(h('div', { class: 'field dec-row' }, [
          h('label', { text: c.name, title: c.name + '（' + (T.TYPE_CN[c.type] || c.type) + '）' }),
          h('div', { class: 'field-ctl' }, [input])
        ]));
      }
    }
    if (!count) kids.push(emptyNote('无可用数值 / 时间列'));
    return h('div', { class: 'setting-group' }, [
      h('div', { class: 'group-title' }, [h('span', { text: '数据格式' })]),
      h('div', {}, kids)
    ]);
  }

  /** ② 字体与大小 */
  function groupFont() {
    var have = false;
    var fontSel = h('select', { class: 'font-family w-100' }, FONTS.map(function (f) {
      if (f.value === _draft.fontFamily) have = true;
      return opt(f.value, f.label, f.value === _draft.fontFamily);
    }).concat((_draft.fontFamily && !have) ? [opt(_draft.fontFamily, '自定义', true)] : []));
    var sizeInput = h('input', {
      type: 'number', class: 'font-size', min: FS_MIN, max: FS_MAX, step: 1,
      value: _draft.fontSize || 12, placeholder: '自动', title: '字号 ' + FS_MIN + '–' + FS_MAX + ' px'
    });
    return h('div', { class: 'setting-group' }, [
      h('div', { class: 'group-title' }, [h('span', { text: '字体与大小' })]),
      h('div', { class: 'field' }, [h('label', { text: '字体' }), h('div', { class: 'field-ctl' }, [fontSel])]),
      h('div', { class: 'field' }, [h('label', { text: '字号' }), h('div', { class: 'field-ctl' }, [sizeInput])])
    ]);
  }

  /** ③ 多级 Sorter（行级排序，从上到下依次生效） */
  function groupSorters() {
    var names = Store.colNames();
    var rows = [], i;
    for (i = 0; i < _draft.sorters.length; i++) {
      var s = _draft.sorters[i];
      var colSel = h('select', { class: 'sorter-col w-100', 'data-idx': i },
        [opt('', '— 选择参数 —', false)].concat(names.map(function (n) { return opt(n, n, n === s.col); })));
      var dirSel = h('select', { class: 'sorter-dir', 'data-idx': i }, [
        opt('asc', '升序', s.dir !== 'desc'), opt('desc', '降序', s.dir === 'desc')
      ]);
      rows.push(h('div', { class: 'sorter-row', 'data-idx': i }, [
        h('span', { class: 'rank', text: String(i + 1) }),
        colSel, dirSel,
        h('button', { class: 'mini-btn', 'data-act': 'up', 'data-idx': i, title: '上移（提高优先级）', text: '↑' }),
        h('button', { class: 'mini-btn', 'data-act': 'down', 'data-idx': i, title: '下移（降低优先级）', text: '↓' }),
        h('button', { class: 'mini-btn', 'data-act': 'del', 'data-idx': i, title: '删除该排序', text: '✕' })
      ]));
    }
    if (!_draft.sorters.length) rows.push(emptyNote('未设置排序'));
    rows.push(h('div', { class: 'plus-row plus-multi', 'data-host': 'sorter' }, [
      h('button', { class: 'mini-btn', 'data-act': 'add-sorter', title: '新增一级排序 (+)', text: '+' })
    ]));
    return h('div', { class: 'setting-group' }, [
      h('div', { class: 'group-title' }, [h('span', { text: '多级 Sorter' })]),
      h('div', {}, rows)
    ]);
  }

  /** ④ 预处理：缺失值处理 + 条件筛选 */
  /** 条件是否「未填写」（与 Store.isFilterActive 同源语义：未填值 → 不参与过滤） */
  function filterPending(f) {
    if (!f || !f.col) return false;                    /* 连参数都没选：不算「未填值」 */
    return !Store.isFilterActive({ col: f.col, op: f.op, value: f.value, value2: f.value2, enabled: true });
  }
  /** 就地刷新一行的「未填值 · 不生效」提示 */
  function syncRowHint(inputEl, f) {
    var row = inputEl ? inputEl.parentNode : null;
    setHint(row ? row.querySelector('.flt-hint') : null, filterPending(f));
  }
  function setHint(node, pending) {
    if (!node) return;
    node.textContent = pending ? '未填值 · 不生效' : '';
    if (pending) node.removeAttribute('hidden'); else node.setAttribute('hidden', 'hidden');
  }
  function filterRow(f, idx) {
    var names = Store.colNames();
    var needsValue = (f.op !== '缺失' && f.op !== '非缺失');
    var needsValue2 = (f.op === '区间');
    var hintEl = h('span', { class: 'flt-hint', title: '该条件未填值，暂不参与过滤' });
    setHint(hintEl, filterPending(f));
    return h('div', { class: 'plus-row filter-row', 'data-idx': idx, 'data-pending': filterPending(f) ? '1' : '0' }, [
      h('select', { class: 'flt-col' }, [opt('', '— 参数 —', false)].concat(names.map(function (n) { return opt(n, n, n === f.col); }))),
      h('select', { class: 'flt-op', title: '运算符' }, OPS.map(function (o) { return opt(o, o, o === f.op); })),
      h('input', { type: 'text', class: 'flt-val', placeholder: needsValue ? '值' : '—', value: needsValue ? f.value : '', disabled: !needsValue }),
      h('input', { type: 'text', class: 'flt-val2', placeholder: '值2', value: needsValue2 ? f.value2 : '', disabled: !needsValue2 }),
      h('button', { class: 'mini-btn', 'data-act': 'del-filter', 'data-idx': idx, title: '删除该筛选条件', text: '✕' }),
      hintEl
    ]);
  }
  function groupPreprocess() {
    var pre = _draft.preprocess;
    var missSel = h('select', { class: 'pre-missing w-100' }, MISSING_OPTS.map(function (o) { return opt(o.value, o.label, o.value === pre.missing); }));
    var rows = pre.filters.map(function (f, i) { return filterRow(f, i); });
    if (!pre.filters.length) rows.push(emptyNote('无筛选条件'));
    rows.push(h('div', { class: 'plus-row plus-multi', 'data-host': 'filter' }, [
      h('button', { class: 'mini-btn', 'data-act': 'add-filter', title: '新增筛选条件 (+)', text: '+' })
    ]));
    return h('div', { class: 'setting-group' }, [
      h('div', { class: 'group-title' }, [h('span', { text: '预处理' })]),
      h('div', { class: 'field' }, [h('label', { text: '缺失值处理' }), h('div', { class: 'field-ctl' }, [missSel])]),
      h('div', { class: 'group-sub' }, [h('span', { text: '条件筛选' })]),
      h('div', {}, rows)
    ]);
  }

  /** ⑤ 底部动作区（sticky 贴底） */
  function groupActions() {
    return h('div', { class: 'settings-actions' }, [
      h('button', { class: 'btn btn-submit', 'data-act': 'submit', title: '应用设置（重新渲染表格与绘图）', text: 'SUBMIT' }),
      h('button', { class: 'btn btn-block', 'data-act': 'reset', title: '恢复默认设置', text: '重置' })
    ]);
  }

  /** 用草稿重绘面板（结构变化时调用） */
  function paint() {
    if (!_body) _body = U.$('#data-settings-body');
    if (!_body) return;
    if (!Store.hasData()) {
      _body.innerHTML = '';
      _body.appendChild(h('div', { class: 'empty-hint', text: '尚未载入数据' }));
      return;
    }
    var box = h('div', { class: 'data-settings-inner' }, [
      groupDecimals(), groupFont(), groupSorters(), groupPreprocess(), groupActions()
    ]);
    _body.innerHTML = '';
    _body.appendChild(box);
  }

  /* ==========================================================================
     事件：草稿同步 / 结构变化 / 提交
     ========================================================================== */
  /** 读取控件 → 草稿（不重绘，避免打断输入） */
  function syncFromTarget(el) {
    /* 原地选择行（data-pick）不属于设置字段：不写入草稿 */
    if (el && el.getAttribute && el.getAttribute('data-pick') !== null) return;
    var col = el.getAttribute ? el.getAttribute('data-col') : null;
    var idx = el.getAttribute ? Number(el.getAttribute('data-idx')) : 0;
    _dirty = true;
    if (hasCls(el, 'dec-input')) {
      _draft.decimals[col] = numOrNull(el.value);
      if (_draft.decimals[col] !== null) _draft.decimals[col] = U.clamp(_draft.decimals[col], DEC_MIN, DEC_MAX);
      return;
    }
    if (hasCls(el, 'font-family')) { _draft.fontFamily = el.value; return; }
    if (hasCls(el, 'font-size')) {
      var fs = numOrNull(el.value);
      _draft.fontSize = fs === null ? 12 : U.clamp(fs, FS_MIN, FS_MAX);
      if (el.value !== '' && el.value !== String(_draft.fontSize)) el.value = _draft.fontSize;
      return;
    }
    if (hasCls(el, 'sorter-col') && _draft.sorters[idx]) { _draft.sorters[idx].col = el.value; return; }
    if (hasCls(el, 'sorter-dir') && _draft.sorters[idx]) { _draft.sorters[idx].dir = el.value === 'desc' ? 'desc' : 'asc'; return; }
    if (hasCls(el, 'pre-missing')) { _draft.preprocess.missing = el.value; return; }
    var f = _draft.preprocess.filters[idx];
    if (hasCls(el, 'flt-col') && f) { f.col = el.value; return; }
    if (hasCls(el, 'flt-op') && f) {
      f.op = OPS.indexOf(el.value) >= 0 ? el.value : '=';
      var row = el.parentNode;
      var v1 = row ? row.querySelector('.flt-val') : null;
      var v2 = row ? row.querySelector('.flt-val2') : null;
      var need1 = (f.op !== '缺失' && f.op !== '非缺失');
      if (v1) { v1.disabled = !need1; if (!need1) f.value = ''; }
      if (v2) { v2.disabled = (f.op !== '区间'); if (f.op !== '区间') f.value2 = ''; }
      setHint(row ? row.querySelector('.flt-hint') : null, filterPending(f));
      return;
    }
    if (hasCls(el, 'flt-val2') && f) { f.value2 = el.value; syncRowHint(el, f); return; }
    if (hasCls(el, 'flt-val') && f) { f.value = el.value; syncRowHint(el, f); return; }
  }

  /** 点迷你按钮 → 改草稿 → 重绘（结构变化）；新增类操作先原地插入选择行（不弹窗） */
  function onAction(act, idx, btn) {
    var s = _draft.sorters, f = _draft.preprocess.filters;
    if (act === 'add-sorter') {
      /* 原地插入 [列 select][升/降 select][确定][取消] */
      var host = (btn && btn.parentNode) ? btn.parentNode : null;
      var names = Store.colNames();
      var colSel = h('select', { class: 'pick-col w-100', 'data-pick': '1', title: '排序列' },
        [opt('', '— 参数 —', !names.length)].concat(names.map(function (n) { return opt(n, n, n === names[0]); })));
      var sDirSel = h('select', { class: 'pick-dir', 'data-pick': '1', title: '排序方向' },
        [opt('asc', '升序', true), opt('desc', '降序', false)]);
      if (!openInlinePicker(host, [colSel, sDirSel], function () {
        s.push({ col: colSel.value || names[0] || '', dir: sDirSel.value === 'desc' ? 'desc' : 'asc' });
        paint();
      })) { s.push({ col: names[0] || '', dir: 'asc' }); paint(); }
    } else if (act === 'del' && s[idx]) {
      s.splice(idx, 1); paint();
    } else if ((act === 'up' || act === 'down') && s[idx]) {
      var to = act === 'up' ? idx - 1 : idx + 1;
      if (to >= 0 && to < s.length) {
        var t = s[idx]; s[idx] = s[to]; s[to] = t; paint();
      }
    } else if (act === 'add-filter') {
      /* 原地插入 [列][运算符][值][值2][确定][取消] */
      var host2 = (btn && btn.parentNode) ? btn.parentNode : null;
      var names2 = Store.colNames();
      var fc = h('select', { class: 'pick-col', 'data-pick': '1', title: '参数' },
        [opt('', '— 参数 —', false)].concat(names2.map(function (n) { return opt(n, n, n === names2[0]); })));
      var fo = h('select', { class: 'pick-op', 'data-pick': '1', title: '运算符' }, OPS.map(function (o) { return opt(o, o, o === '='); }));
      var fv1 = h('input', { type: 'text', class: 'pick-val', 'data-pick': '1', placeholder: '值' });
      var fv2 = h('input', { type: 'text', class: 'pick-val2', 'data-pick': '1', placeholder: '值2', disabled: true });
      function syncVals() {
        var need1 = (fo.value !== '缺失' && fo.value !== '非缺失');
        var need2 = (fo.value === '区间');
        fv1.disabled = !need1; if (!need1) fv1.value = '';
        fv2.disabled = !need2; if (!need2) fv2.value = '';
      }
      fo.addEventListener('change', syncVals);
      syncVals();
      if (!openInlinePicker(host2, [fc, fo, fv1, fv2], function () {
        f.push({
          col: fc.value || names2[0] || '', op: OPS.indexOf(fo.value) >= 0 ? fo.value : '=',
          value: fv1.value, value2: fv2.value, enabled: true
        });
        paint();
      })) { f.push({ col: names2[0] || '', op: '=', value: '', value2: '', enabled: true }); paint(); }
    } else if (act === 'del-filter' && f[idx]) {
      f.splice(idx, 1); paint();
    } else if (act === 'submit') {
      submit();
    } else if (act === 'reset') {
      reset();
    }
  }

  function onBodyClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    e.preventDefault();
    onAction(btn.getAttribute('data-act'), Number(btn.getAttribute('data-idx')), btn);
  }
  function onBodyInput(e) { if (e.target) syncFromTarget(e.target); }
  function onBodyChange(e) { if (e.target) syncFromTarget(e.target); }

  /** 提交：规范化草稿 → Store.applyDataSettings → 处理说明 + 提示 */
  function submit() {
    try {
      if (!Store.hasData()) { U.toast('尚未载入数据', 'warn'); return; }
      var clean = sanitize(_draft, Store.colNames());
      _draft = clean;
      _dirty = false;
      Store.applyDataSettings({
        decimals: clean.decimals, fontFamily: clean.fontFamily, fontSize: clean.fontSize,
        sorters: clean.sorters, preprocess: clean.preprocess
      });
      Store.addNote('数据设置：' + summary(clean));
      U.toast('数据设置已生效：' + U.escapeHtml(summary(clean)), 'ok');
      U.setStatus('数据设置已生效', 'ok');
    } catch (err) {
      if (global.console) global.console.error('[YMS.DataSettings] submit 失败', err);
      U.toast('应用数据设置失败：' + err.message, 'error');
    }
  }

  /** 重置为默认设置并立即生效 */
  function reset() {
    try {
      _draft = defaultDraft();
      _dirty = false;
      paint();
      if (!Store.hasData()) return;
      Store.applyDataSettings({
        decimals: _draft.decimals, fontFamily: _draft.fontFamily, fontSize: _draft.fontSize,
        sorters: _draft.sorters, preprocess: _draft.preprocess
      });
      Store.addNote('数据设置：已重置为默认');
      U.toast('数据设置已重置', 'ok');
    } catch (err) {
      if (global.console) global.console.error('[YMS.DataSettings] reset 失败', err);
      U.toast('重置失败：' + err.message, 'error');
    }
  }

  /** 事件合并：同一 tick 内多次触发只重绘一次 */
  function scheduleRender() {
    if (_pending) return;
    _pending = true;
    setTimeout(function () {
      _pending = false;
      try { DataSettings.render(); } catch (err) {
        if (global.console) global.console.error('[YMS.DataSettings] render 失败', err);
      }
    }, 0);
  }

  /** 事件处理器包装：任何异常都不得逃逸到全局（硬约束：零未捕获异常） */
  function guard(name, fn) {
    return function (e) {
      try { return fn(e); } catch (err) {
        if (global.console) global.console.error('[YMS.DataSettings] ' + name + ' 失败', err);
      }
    };
  }

  /** 绑定面板事件（幂等；容器节点不会随重绘替换） */
  function bindEvents() {
    if (_bound || !_body || !_body.addEventListener) return;
    _body.addEventListener('click', guard('点击', onBodyClick));
    _body.addEventListener('input', guard('输入', onBodyInput));
    _body.addEventListener('change', guard('变更', onBodyChange));
    _bound = true;
  }

  /* ==========================================================================
     公开 API
     ========================================================================== */
  var DataSettings = {
    MISSING_OPTS: MISSING_OPTS,
    OPS: OPS,
    FONTS: FONTS,

    /** 初始化：缓存 DOM、绑定事件、订阅 Store 变化 */
    init: function () {
      try {
        _body = U.$('#data-settings-body');
        bindEvents();
        Store.on('change', function (p) {
          var topic = p && p.topic;
          if (topic === 'data') scheduleRender();          // 结构/数据变化 → 重建面板 + 草稿
          else if (topic === 'datasettings') {             // 外部改设置 → 同步草稿（有未提交编辑时不覆盖）
            if (!_dirty) _draft = draftFromStore();
          } else if (topic === 'datasettings-render') scheduleRender();
        });
        Store.on('data', scheduleRender);
      } catch (err) {
        if (global.console) global.console.error('[YMS.DataSettings] init 失败', err);
      }
      this.render();
      return this;
    },

    /** 从 Store 重建面板（草稿 = 当前设置） */
    render: function () {
      try {
        if (!_body) _body = U.$('#data-settings-body');
        bindEvents();
        if (!_body) return this;
        _draft = Store.hasData() ? draftFromStore() : defaultDraft();
        _dirty = false;
        paint();
        return this;
      } catch (err) {
        if (global.console) global.console.error('[YMS.DataSettings] render 失败', err);
        return this;
      }
    },

    /** 当前草稿（只读副本，调试/自测用） */
    draft: function () { return U.deepClone(_draft || defaultDraft()); },
    /** 手动提交（等同点击 Submit） */
    submit: submit,
    reset: reset,
    repaint: paint,

    /* ---- 内部纯逻辑导出（Node 自测用，不属公开契约） ---- */
    _defaultDraft: defaultDraft,
    _draftFromStore: draftFromStore,
    _sanitize: sanitize,
    _summary: summary,
    _missingLabel: missingLabel,
    _fontLabel: fontLabel
  };

  YMS.DataSettings = DataSettings;
})(typeof window !== 'undefined' ? window : this);
