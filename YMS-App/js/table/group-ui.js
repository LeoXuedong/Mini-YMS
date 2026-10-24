/* ==========================================================================
   YMS · table/group-ui.js
   职责：按值分组（Group Mapping）的操作界面 —— 列右键「分组映射…」打开的对话框
   分层：计算全在 js/data/group-map.js（纯函数）；本文件只管 DOM / 交互 / Toast。

   迭代 27 重做（旧版「每个值一个输入框」在取值多时无法使用：12 个值要打 12 次组名）：
     布局 = 左「值列表」（多选 + 搜索 + 虚拟滚动）｜右「分组定义表」（三列）
       ① 左栏：勾选若干值（可搜索；1000+ 值也只渲染可视窗口，DOM 行数恒定）
       ② 右表：第一列 Group Name（手输）/ 第二列 Group Parameter（下拉复选框）/ 第三列操作（↑ ↓ 🗑）
       ③ 勾选值 → 点「+ 新增分组」→ 自动建行并把所选值预填进 Group Parameter，光标落进组名框
       ④ 组顺序仍决定横轴顺序；未分配值仍二选一；.yms 仍往返还原
     值归属：一个值只能属于一个组。加入新组时自动从旧组移出（后加入者生效），
              并在提示条上写明从哪个组移来 —— 提交时不可能出现「一值两组」的歧义结果。
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util;
  var Store = YMS.Store;
  var T = YMS.types;

  var ROW_H = 26;         /* 左栏每行高度（必须与 css 的 .gm-vrow height 一致，虚拟滚动按它算窗口） */
  var OVERSCAN = 6;       /* 虚拟滚动上下各多渲染几行，滚动时不闪白 */
  var PICK_LIMIT = 200;   /* 下拉复选框一次最多渲染多少个值（其余靠面板内搜索，搜索覆盖全部值） */

  var _dlg = null;        /* 当前打开的对话框句柄 */

  function gm() { return YMS.GroupMap; }
  function esc(s) { return U.escapeHtml(s); }

  /** 目标列默认名：<源列>_Group（重名自动加 (2)） */
  function defaultTarget(df, src) {
    var base = String(src || '分组') + '_Group';
    if (df.colIndex(base) < 0) return base;
    var k = 2;
    while (df.colIndex(base + ' (' + k + ')') >= 0) k++;
    return base + ' (' + k + ')';
  }

  /** 可作源列的列 */
  function sourceColumns(df) {
    var out = [];
    df.cols.forEach(function (c) {
      out.push({ name: c.name, label: c.name + ' · ' + (T.TYPE_CN[c.type] || c.type) });
    });
    return out;
  }

  /* ------------------------------------------------------------------ 提交 */
  /** 英文模式？（跟随语言层；词库见 core/i18n-dict-panels.js 迭代 25 / 27 段） */
  function isEn() {
    return !!(YMS.I18n && YMS.I18n.lang && YMS.I18n.lang() === 'en');
  }

  /**
   * 处理说明文本（运行时拼装 → 词库的整串规则覆盖不到，
   * 按「程序生成的文案要随语言」的约定在这里读语言分支）
   */
  function noteText(res) {
    var seq = res.groups.join(' → ');
    if (isEn()) {
      return 'Group mapping: ' + (res.action === 'added' ? 'created column ' : 'updated column ') + res.name +
        ' (' + res.spec.sourceCol + ': ' + res.mapped + ' rows grouped / ' + res.groups.length + ' groups' +
        (res.other ? ', ' + res.other + ' ungrouped' : '') +
        (res.rawKept ? ', ' + res.rawKept + ' kept as original value' : '') +
        (res.missing ? ', ' + res.missing + ' missing' : '') + '; order ' + seq + ')';
    }
    return '分组映射：' + (res.action === 'added' ? '新建列 ' : '更新列 ') + res.name +
      '（' + res.spec.sourceCol + '：' + res.mapped + ' 行已归组 / ' + res.groups.length + ' 组' +
      (res.other ? '，未分组 ' + res.other + ' 行' : '') +
      (res.rawKept ? '，保留原值 ' + res.rawKept + ' 行' : '') +
      (res.missing ? '，缺失 ' + res.missing + ' 行' : '') + '；顺序 ' + seq + '）';
  }

  function toastText(res) {
    if (isEn()) {
      return (res.action === 'added' ? 'Created' : 'Updated') + ' group column “' + esc(res.name) +
        '” · ' + res.groups.length + ' groups';
    }
    return '已' + (res.action === 'added' ? '新建' : '更新') + '分组列「' + esc(res.name) +
      '」 · ' + res.groups.length + ' 组';
  }

  /**
   * 写入派生列（对话框「确定」与编程入口共用）
   * @param {object} spec
   * @returns {{ok:boolean, error?:string}}
   */
  function commit(spec) {
    var df = Store.state.df;
    if (!df) return { ok: false, error: '尚未载入数据' };
    var res = gm().applyToDf(df, spec);
    if (!res.ok) return res;
    Store.replaceDataFrame(df);
    Store.addNote(noteText(res));
    U.toast(toastText(res), 'ok');
    scrollToColumn(res.name);
    return res;
  }

  /** 让新列在数据显示区可见（横向滚到该列，并短暂高亮表头） */
  function scrollToColumn(name) {
    try {
      var cell = document.querySelector('.grid-head-cell[data-col="' + cssEsc(name) + '"], th[data-col="' + cssEsc(name) + '"]');
      if (!cell) {
        var wrap = document.getElementById('grid-wrap') || document.getElementById('grid');
        if (wrap && wrap.scrollLeft !== undefined) wrap.scrollLeft = wrap.scrollWidth;
        return;
      }
      if (cell.scrollIntoView) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      cell.classList.add('is-flash');
      setTimeout(function () { cell.classList.remove('is-flash'); }, 900);
    } catch (e) { /* 滚动失败不影响功能 */ }
  }

  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------------ 对话框 */
  /**
   * 打开分组映射对话框
   * @param {string} colName 源列（从该列右键进入）
   */
  function open(colName) {
    var df = Store.state.df;
    if (!df) { U.toast('尚未载入数据', 'warn'); return null; }
    if (df.colIndex(colName) < 0) { U.toast('参数不存在：' + colName, 'warn'); return null; }

    /* 已有分组列 → 以它的配方为初值（「修改分组映射…」入口） */
    var col = df.col(colName);
    var exist = (col && col.groupMap) ? gm().metaOf(col) : null;
    var st = {
      df: df,
      src: exist ? exist.sourceCol : colName,
      target: exist ? exist.targetCol : defaultTarget(df, colName),
      manualTarget: !!exist,
      /* rows: [{name, values:[]}] —— 顺序 = 横轴顺序；一个值只属于一行 */
      rows: [],
      unassigned: exist ? exist.unassigned : 'other',
      /* 「未分组」标签由 otherLabel() 现算：与用户自定义组名冲突时自动让路 */
      otherLabel: exist ? exist.otherLabel : gm().OTHER_LABEL,
      values: [], total: 0, truncated: false, view: [],
      filter: '',
      sel: Object.create(null),     /* 左栏勾选：value → 1 */
      win: [0, 0]                   /* 当前虚拟窗口 [start, end) */
    };
    if (df.colIndex(st.src) < 0) st.src = df.cols[0].name;
    if (df.colIndex(st.target) >= 0 && !exist) st.target = defaultTarget(df, st.src);

    /* ---- 头部：源列 / 新列名 ---- */
    var srcSel = U.el('select', { class: 'gm-select', id: 'gm-src' },
      sourceColumns(df).map(function (c) {
        return U.el('option', { value: c.name, text: c.label, selected: c.name === st.src });
      }));
    var nameIn = U.el('input', { class: 'gm-text', id: 'gm-name', type: 'text', value: st.target });
    var head = U.el('div', { class: 'gm-head' }, [
      U.el('label', { class: 'gm-lab', for: 'gm-src', text: '源列' }), srcSel,
      U.el('label', { class: 'gm-lab', for: 'gm-name', text: '新列名' }), nameIn,
      U.el('span', { class: 'gm-tip', text: '新列会加到当前表末尾，可直接当 X Label / 分组依据' })
    ]);

    /* ---- 左栏：值列表（多选 + 搜索 + 虚拟滚动）---- */
    var cntEl = U.el('div', { class: 'gm-count', id: 'gm-count', text: '' });
    var searchIn = U.el('input', {
      class: 'gm-text gm-search', id: 'gm-search', type: 'search', placeholder: '搜索值…'
    });
    var btnAll = U.el('button', { class: 'btn gm-mini', id: 'gm-sel-all', type: 'button', title: '勾选当前列表里的全部值', text: '全选' });
    var btnNone = U.el('button', { class: 'btn gm-mini', id: 'gm-sel-none', type: 'button', title: '取消全部勾选', text: '清空' });
    var vlist = U.el('div', { class: 'gm-vlist', id: 'gm-vals' });
    var vpad = U.el('div', { class: 'gm-vpad' });
    vlist.appendChild(vpad);
    var selCount = U.el('span', { class: 'gm-count', id: 'gm-sel-count', text: '' });
    var leftBlock = U.el('div', { class: 'gm-block gm-left' }, [
      U.el('div', { class: 'gm-block-head' }, [
        U.el('span', { class: 'gm-block-title', text: '值列表' }), cntEl
      ]),
      U.el('div', { class: 'gm-left-tools' }, [searchIn, btnAll, btnNone]),
      vlist,
      U.el('div', { class: 'gm-left-foot' }, [
        selCount,
        U.el('span', { class: 'gm-tip', text: '勾选后点「+ 新增分组」建组，只需再打一个组名' })
      ])
    ]);

    /* ---- 右栏：分组定义表 ---- */
    var grows = U.el('div', { class: 'gm-grows', id: 'gm-grows' });
    var addBtn = U.el('button', {
      class: 'btn gm-btn', id: 'gm-add', type: 'button',
      title: '把左栏勾选的值建成一个新分组（没有勾选则建空分组）',
      text: '+ 新增分组', onclick: function () { addGroup(); }
    });
    var addRowBtn = U.el('button', {
      class: 'gm-grp-add', id: 'gm-add-row', type: 'button', title: '新建一个空分组', text: '+',
      onclick: function () { addGroup(); }
    });
    var gTable = U.el('div', { class: 'gm-gtable' }, [
      U.el('div', { class: 'gm-gthead' }, [
        U.el('span', { class: 'gm-gthead-idx', text: '#' }),
        U.el('span', { text: 'Group Name' }),
        U.el('span', { text: 'Group Parameter' }),
        U.el('span', { class: 'gm-gthead-act', text: '' })
      ]),
      grows,
      U.el('div', { class: 'gm-gadd-row' }, [addRowBtn])
    ]);
    var rightBlock = U.el('div', { class: 'gm-block gm-right' }, [
      U.el('div', { class: 'gm-block-head' }, [
        U.el('span', { class: 'gm-block-title', text: '分组定义' }),
        U.el('span', { class: 'gm-tip', text: '组顺序 = 横轴顺序' }),
        addBtn
      ]),
      gTable
    ]);

    /* ---- 未分配值 ---- */
    var radOther = U.el('input', {
      type: 'radio', name: 'gm-unassigned', id: 'gm-unassigned-other', value: 'other',
      checked: st.unassigned === 'other'
    });
    var radRaw = U.el('input', {
      type: 'radio', name: 'gm-unassigned', id: 'gm-unassigned-raw', value: 'raw',
      checked: st.unassigned === 'raw'
    });
    var otherTag = U.el('code', { class: 'gm-other-label', id: 'gm-other-label', text: st.otherLabel });
    var unBlock = U.el('div', { class: 'gm-unassigned' }, [
      U.el('span', { class: 'gm-block-title', text: '未分配值' }),
      U.el('label', { class: 'gm-radio', for: 'gm-unassigned-other' }, [radOther, U.el('span', { text: '归为「' }), otherTag, U.el('span', { text: '」' })]),
      U.el('label', { class: 'gm-radio', for: 'gm-unassigned-raw' }, [radRaw, U.el('span', { text: '保留原值' })]),
      U.el('span', { class: 'gm-tip', text: '未在上表归组的取值按此处理' })
    ]);

    /* ---- 预览 ---- */
    var previewEl = U.el('div', { class: 'gm-preview', id: 'gm-preview' });
    var prevBlock = U.el('div', { class: 'gm-block gm-block-prev' }, [
      U.el('div', { class: 'gm-block-head' }, [
        U.el('span', { class: 'gm-block-title', text: '预览 · 前 5 行' })
      ]),
      previewEl
    ]);

    /* ---- 批量规则（保留原能力，不增强）---- */
    var rulesTa = U.el('textarea', {
      class: 'gm-rules', id: 'gm-rules', rows: '3', spellcheck: 'false',
      placeholder: 'T01-T04=清洗\nT05,T06=沉积\n每行一条：选择器=组名（区间 / 逗号列表 / 单值）'
    });
    var rulesMsg = U.el('div', { class: 'gm-rules-msg', id: 'gm-rules-msg', text: '' });
    var rulesBlock = U.el('details', { class: 'gm-details' }, [
      U.el('summary', { text: '批量规则（可选）' }),
      U.el('div', { class: 'gm-rules-body' }, [
        rulesTa,
        U.el('button', {
          class: 'btn gm-btn', id: 'gm-rules-apply', type: 'button', text: '应用到映射',
          onclick: function () { applyRules(); }
        }),
        rulesMsg
      ])
    ]);

    var msgEl = U.el('div', { class: 'gm-msg', id: 'gm-msg', role: 'status' });
    var errEl = U.el('div', { class: 'gm-err', id: 'gm-err', role: 'alert' });

    var body = U.el('div', { class: 'gm-body', id: 'gm-dlg' }, [
      head,
      U.el('div', { class: 'gm-cols' }, [leftBlock, rightBlock]),
      unBlock,
      prevBlock,
      rulesBlock,
      msgEl,
      errEl
    ]);

    var modal = U.modal({
      title: '分组映射',
      width: 'xl',
      body: body,
      footer: [
        { text: '取消', onClick: function (c) { c(); } },
        {
          text: '确定', cls: 'btn-primary',
          onClick: function (c) {
            var spec = currentSpec();
            var chk = validate(spec);
            if (!chk.ok) { showerr(chk.error); return; }
            var res = commit(spec);
            if (!res.ok) { showerr(res.error); return; }
            c();
          }
        }
      ],
      onClose: function () { destroyPicker(); _dlg = null; }
    });
    if (!modal) return null;

    /* ------------------------------------------------------------ 提示信息 */
    function showerr(msg) {
      errEl.textContent = msg || '';
      errEl.className = 'gm-err' + (msg ? ' is-on' : '');
    }

    function notice(text) {
      msgEl.textContent = text || '';
      msgEl.className = 'gm-msg' + (text ? ' is-on' : '');
    }

    /* --------------------------------------------------------- 数据与派生 */
    /** 当前生效的「未分组」标签（与已有组名冲突时自动让路） */
    function otherLabel() {
      var names = [];
      st.rows.forEach(function (r) { if (r.name) names.push(r.name); });
      return gm().otherLabelFor(names, gm().OTHER_LABEL);
    }

    /** 值 → 所属组名（未归属 → ''） */
    function groupOf(value) {
      for (var i = 0; i < st.rows.length; i++) {
        if (st.rows[i].values.indexOf(value) >= 0) return st.rows[i].name;
      }
      return '';
    }

    /** 值在源列里的先后（组内取值按它排序，结果可预期） */
    function valueIndex(value) {
      for (var i = 0; i < st.values.length; i++) if (st.values[i].value === value) return i;
      return 1e9;
    }

    function sortRowValues(row) {
      row.values.sort(function (a, b) { return valueIndex(a) - valueIndex(b); });
    }

    /** 把 value 从其它所有分组里移出；返回被移出的组名（没有则 ''） */
    function detachFromOthers(value, exceptIdx) {
      var moved = '';
      for (var i = 0; i < st.rows.length; i++) {
        if (i === exceptIdx) continue;
        var at = st.rows[i].values.indexOf(value);
        if (at >= 0) {
          st.rows[i].values.splice(at, 1);
          if (!moved) moved = st.rows[i].name || ('#' + (i + 1));
        }
      }
      return moved;
    }

    /* ---------------------------------------------------------- 左栏渲染 */
    function visibleList() {
      var f = String(st.filter || '').toLowerCase();
      if (!f) return st.values;
      var out = [];
      for (var i = 0; i < st.values.length; i++) {
        if (String(st.values[i].value).toLowerCase().indexOf(f) >= 0) out.push(st.values[i]);
      }
      return out;
    }

    function renderValues(resetScroll) {
      st.view = visibleList();
      vpad.style.height = Math.max(st.view.length * ROW_H, 40) + 'px';
      if (resetScroll) vlist.scrollTop = 0;
      paintWindow();
      var tail = '';
      if (st.filter) tail = ' · 匹配 ' + U.fmtInt(st.view.length) + ' 个';
      else if (st.truncated) tail = ' · 仅载入前 ' + U.fmtInt(st.values.length) + ' 个值';
      cntEl.textContent = '共 ' + U.fmtInt(st.total) + ' 个不同值' + tail;
      updateSelCount();
    }

    /** 只渲染可视窗口（虚拟滚动）—— 1000+ 值也不会一次性建 DOM */
    function paintWindow() {
      var list = st.view || [];
      var boxH = vlist.clientHeight || 320;
      var top = vlist.scrollTop || 0;
      var start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
      var count = Math.ceil(boxH / ROW_H) + OVERSCAN * 2;
      var end = Math.min(list.length, start + count);
      U.clear(vpad);
      var frag = document.createDocumentFragment();
      for (var i = start; i < end; i++) frag.appendChild(valueRow(list[i], i));
      vpad.appendChild(frag);
      st.win = [start, end];
      if (!list.length) {
        vpad.appendChild(U.el('div', { class: 'gm-empty', text: '没有匹配的值' }));
      }
    }

    function valueRow(item, i) {
      var on = !!st.sel[item.value];
      var gname = groupOf(item.value);
      var cb = U.el('input', { type: 'checkbox', class: 'gm-vchk', 'data-value': item.value, checked: on });
      cb.addEventListener('change', function () { setSel(item.value, cb.checked); });
      var row = U.el('div', {
        class: 'gm-vrow' + (on ? ' is-on' : '') + (gname ? ' is-assigned' : ''),
        'data-value': item.value, style: { top: (i * ROW_H) + 'px' }
      }, [
        cb,
        U.el('span', {
          class: 'gm-vval', 'data-i18n-skip': '', title: item.value,
          text: item.value === '' ? '（空白）' : item.value
        }),
        gname ? U.el('span', { class: 'gm-vtag', 'data-i18n-skip': '', title: gname, text: gname }) : null,
        U.el('span', { class: 'gm-cnt', text: U.fmtInt(item.count) + ' 行' })
      ]);
      row.addEventListener('click', function (e) {
        if (e && e.target === cb) return;         /* 复选框自己处理，避免双切换 */
        setSel(item.value, !st.sel[item.value]);
      });
      return row;
    }

    /** 勾选状态变化：只改当前行 DOM（不重建列表，焦点与滚动都不跳） */
    function setSel(value, on) {
      if (on) st.sel[value] = 1; else delete st.sel[value];
      var row = vpad.querySelector('.gm-vrow[data-value="' + cssEsc(value) + '"]');
      if (row) {
        if (on) row.classList.add('is-on'); else row.classList.remove('is-on');
        var cb = row.querySelector('.gm-vchk');
        if (cb && cb.checked !== !!on) cb.checked = !!on;
      }
      updateSelCount();
    }

    function selectedValues() {
      var out = [];
      for (var i = 0; i < st.values.length; i++) {
        if (st.sel[st.values[i].value]) out.push(st.values[i].value);
      }
      return out;
    }

    function updateSelCount() {
      var n = selectedValues().length;
      selCount.textContent = n ? ('已勾选 ' + U.fmtInt(n) + ' 个值') : '未勾选任何值';
      if (btnNone.classList) {
        if (n) btnNone.classList.remove('is-off'); else btnNone.classList.add('is-off');
      }
    }

    /* ---------------------------------------------------------- 右栏渲染 */
    function renderGroups() {
      U.clear(grows);
      otherTag.textContent = otherLabel();
      if (!st.rows.length) {
        grows.appendChild(U.el('div', {
          class: 'gm-empty', id: 'gm-rows-empty',
          text: '还没有分组 —— 勾选左侧的值后点「+ 新增分组」'
        }));
        return;
      }
      st.rows.forEach(function (r, i) { grows.appendChild(groupRow(r, i)); });
    }

    function setParamText(wrap, r) {
      U.clear(wrap);
      if (!r.values.length) {
        wrap.appendChild(U.el('span', { class: 'gm-param-ph', text: '选择值…' }));
        return;
      }
      wrap.appendChild(U.el('span', {
        class: 'gm-param-head', 'data-i18n-skip': '', text: r.values.slice(0, 2).join(', ')
      }));
      if (r.values.length > 2) wrap.appendChild(U.el('span', { class: 'gm-param-more', text: ' …' }));
      wrap.appendChild(U.el('span', { class: 'gm-param-n', text: U.fmtInt(r.values.length) + ' 项' }));
    }

    function groupRow(r, i) {
      var nameInRow = U.el('input', {
        class: 'gm-gname', type: 'text', value: r.name, placeholder: '组名',
        'data-index': i, 'aria-label': 'Group Name'
      });
      nameInRow.addEventListener('input', function () { onNameInput(i, nameInRow); });
      var wrap = U.el('span', { class: 'gm-param-vals' });
      setParamText(wrap, r);
      var trig = U.el('button', {
        class: 'gm-param-trigger', type: 'button', 'data-index': i,
        'aria-haspopup': 'true', 'aria-expanded': 'false',
        title: '下拉勾选该组包含哪些值'
      }, [wrap, U.el('i', { class: 'gm-param-arrow', text: '▾' })]);
      trig.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        openPicker(i, trig);
      });
      return U.el('div', {
        class: 'gm-grp' + (r.values.length ? '' : ' is-empty'), 'data-index': i, 'data-group': r.name
      }, [
        U.el('span', { class: 'gm-grp-idx', text: String(i + 1) }),
        nameInRow,
        trig,
        U.el('span', { class: 'gm-grp-act' }, [
          U.el('button', {
            class: 'btn gm-mini gm-up', type: 'button', title: '上移', text: '↑', disabled: i === 0,
            onclick: function () { moveGroup(i, -1); }
          }),
          U.el('button', {
            class: 'btn gm-mini gm-down', type: 'button', title: '下移', text: '↓',
            disabled: i === st.rows.length - 1, onclick: function () { moveGroup(i, 1); }
          }),
          U.el('button', {
            class: 'btn gm-mini gm-del', type: 'button', title: '删除该组（组内取值回到未分配）', text: '×',
            onclick: function () { deleteGroup(i); }
          })
        ])
      ]);
    }

    /** 改名：只改数据 + 就地反馈，绝不重建右侧表格（否则输入框被替换、光标丢失） */
    function onNameInput(i, inp) {
      var v = String(inp.value || '').trim();
      st.rows[i].name = v;
      var rowEl = inp.parentNode;
      if (rowEl && rowEl.setAttribute) rowEl.setAttribute('data-group', v);
      var dup = false;
      for (var j = 0; j < st.rows.length; j++) {
        if (j !== i && v && st.rows[j].name === v) { dup = true; break; }
      }
      if (inp.classList) {
        if (dup) inp.classList.add('is-dup'); else inp.classList.remove('is-dup');
      }
      otherTag.textContent = otherLabel();
      if (dup) showerr('组名「' + v + '」已存在'); else showerr('');
      paintWindow();          /* 左栏归属标签跟着变 */
      renderPreview();
    }

    /** 刷新所有「Group Parameter」触发器的摘要（不重建行） */
    function refreshParamTriggers() {
      var nodes = grows.querySelectorAll('.gm-param-trigger');
      for (var i = 0; i < nodes.length; i++) {
        var idx = Number(nodes[i].getAttribute('data-index'));
        var wrap = nodes[i].querySelector('.gm-param-vals');
        if (wrap && st.rows[idx]) setParamText(wrap, st.rows[idx]);
      }
    }

    function moveGroup(i, dir) {
      var j = i + dir;
      if (j < 0 || j >= st.rows.length) return;
      var t = st.rows[i]; st.rows[i] = st.rows[j]; st.rows[j] = t;
      renderGroups(); renderPreview();
    }

    function deleteGroup(i) {
      st.rows.splice(i, 1);
      renderGroups(); paintWindow(); renderPreview(); notice('');
    }

    /* ------------------------------------------------- 新增分组的核心链路 */
    /**
     * 「+ 新增分组」：
     *   ① 左栏有勾选 → 新建一行，Group Parameter 预填所选值（从旧组移出并提示）
     *   ② 无勾选 → 新建空行（供先命名再勾选）
     *   ③ 建完清空左栏勾选，光标落进新行的 Group Name 输入框
     */
    function addGroup() {
      if (st.rows.length >= gm().MAX_GROUPS) {
        showerr('组数超过上限 ' + gm().MAX_GROUPS);
        return -1;
      }
      var picked = selectedValues();
      var row = { name: '', values: [] };
      var moved = '';
      picked.forEach(function (v) {
        var old = detachFromOthers(v, -1);
        if (old && !moved) moved = old;
        row.values.push(v);
      });
      sortRowValues(row);
      st.rows.push(row);
      st.sel = Object.create(null);
      showerr('');
      renderGroups();
      renderValues(false);
      renderPreview();
      if (moved) {
        notice(isEn()
          ? ('Moved ' + picked.length + ' value(s) out of “' + moved + '” into the new group')
          : ('已把 ' + picked.length + ' 个值从「' + moved + '」移到新分组'));
      } else {
        notice('');
      }
      var idx = st.rows.length - 1;
      var inp = grows.querySelector('.gm-grp[data-index="' + idx + '"] .gm-gname');
      if (inp) {
        if (inp.scrollIntoView) inp.scrollIntoView({ block: 'nearest' });
        inp.focus();
        if (inp.select) inp.select();
      }
      return idx;
    }

    /* ------------------------------------------------- 下拉复选框（浮层） */
    /* 规矩：面板挂在 body 上、按锚点定位；打开时立即在 document 上以**捕获阶段**监听
       mousedown / keydown / scroll，并用 armed 标志免疫「打开它的那一次事件」；
       面板节点**复用**（同一对话框内只有一个），只在内容变化时重建列表。 */
    var picker = null;                       /* {panel, search, list, count, idx, anchor} */
    var pickState = { armed: false, open: false };

    /** 本组可选的值：排除已被**其它分组**占用的值（本组自己的值保留，便于取消勾选） */
    function pickerAvailable() {
      var cur = (picker && picker.idx >= 0) ? st.rows[picker.idx] : null;
      var out = [];
      for (var i = 0; i < st.values.length; i++) {
        var it = st.values[i], taken = false;
        for (var j = 0; j < st.rows.length; j++) {
          var r = st.rows[j];
          if (r === cur) continue;
          if (r.values.indexOf(it.value) >= 0) { taken = true; break; }
        }
        if (!taken) out.push(it);
      }
      return out;
    }

    function pickerFiltered() {
      /* 迭代 29：下拉只列「目前还能分给本组」的值 —— 已被其它组选走的不再出现，
         避免用户勾了之后又被静默从别组搬走 */
      var pool = pickerAvailable();
      var f = String((picker && picker.search.value) || '').toLowerCase();
      if (!f) return pool;
      var out = [];
      for (var i = 0; i < pool.length; i++) {
        if (String(pool[i].value).toLowerCase().indexOf(f) >= 0) out.push(pool[i]);
      }
      return out;
    }

    function ensurePicker() {
      if (picker) return picker;
      var search = U.el('input', { class: 'gm-text gm-param-search', type: 'search', placeholder: '搜索值…' });
      var list = U.el('div', { class: 'gm-param-list' });
      var count = U.el('span', { class: 'gm-count gm-param-count', text: '' });
      var allBtn = U.el('button', { class: 'btn gm-mini', id: 'gm-param-all', type: 'button', title: '勾选当前列表里的全部值', text: '全选' });
      var noneBtn = U.el('button', { class: 'btn gm-mini', id: 'gm-param-none', type: 'button', title: '取消本组全部值', text: '清空' });
      var panel = U.el('div', { class: 'gm-param-panel', id: 'gm-param-panel', role: 'listbox' }, [
        U.el('div', { class: 'gm-param-panel-head' }, [search]),
        list,
        U.el('div', { class: 'gm-param-panel-foot' }, [count, allBtn, noneBtn])
      ]);
      search.addEventListener('input', function () { renderPickerList(); });
      allBtn.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var row = st.rows[picker.idx];
        if (!row) return;
        var moved = '';
        pickerFiltered().forEach(function (it) {
          if (row.values.indexOf(it.value) >= 0) return;
          var old = detachFromOthers(it.value, picker.idx);
          if (old && !moved) moved = old;
          row.values.push(it.value);
        });
        sortRowValues(row);
        afterParamChange(moved);
      });
      noneBtn.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var row = st.rows[picker.idx];
        if (!row) return;
        row.values = [];
        afterParamChange('');
      });
      picker = { panel: panel, search: search, list: list, count: count, idx: -1, anchor: null };
      return picker;
    }

    function renderPickerList() {
      if (!picker || !pickState.open) return;
      var row = st.rows[picker.idx];
      if (!row) return;
      var list = pickerFiltered();
      U.clear(picker.list);
      var frag = document.createDocumentFragment();
      var shown = Math.min(list.length, PICK_LIMIT);
      for (var i = 0; i < shown; i++) {
        (function (it) {
          var on = row.values.indexOf(it.value) >= 0;
          var cb = U.el('input', { type: 'checkbox', class: 'gm-param-chk', 'data-value': it.value, checked: on });
          cb.addEventListener('change', function () { toggleParam(it.value, cb.checked); });
          frag.appendChild(U.el('label', { class: 'gm-param-opt' + (on ? ' is-on' : ''), 'data-value': it.value }, [
            cb,
            U.el('span', {
              class: 'gm-param-val', 'data-i18n-skip': '', title: it.value,
              text: it.value === '' ? '（空白）' : it.value
            }),
            U.el('span', { class: 'gm-cnt', text: U.fmtInt(it.count) + ' 行' })
          ]));
        })(list[i]);
      }
      picker.list.appendChild(frag);
      if (!list.length) {
        /* 区分「搜索无结果」与「值已全被其它组占用」 */
        picker.list.appendChild(U.el('div', {
          class: 'gm-empty',
          text: pickerAvailable().length ? '没有匹配的值' : '没有可用值（其余值已被其它分组占用）'
        }));
      }
      if (list.length > PICK_LIMIT) {
        picker.list.appendChild(U.el('div', {
          class: 'gm-empty',
          text: '仅列出前 ' + U.fmtInt(PICK_LIMIT) + ' 个值，请用搜索缩小范围'
        }));
      }
      picker.count.textContent = '已选 ' + U.fmtInt(row.values.length) + ' 项';
    }

    function toggleParam(value, on) {
      var i = picker.idx;
      var row = st.rows[i];
      if (!row) return;
      var at = row.values.indexOf(value);
      var moved = '';
      if (on && at < 0) {
        moved = detachFromOthers(value, i);
        row.values.push(value);
        sortRowValues(row);
      } else if (!on && at >= 0) {
        row.values.splice(at, 1);
      }
      afterParamChange(moved);
    }

    /** Group Parameter 变化后的统一收尾（左栏标签 / 触发器摘要 / 预览 / 冲突提示） */
    function afterParamChange(moved) {
      var row = st.rows[picker.idx];
      refreshParamTriggers();
      paintWindow();
      renderPreview();
      var growRow = grows.querySelector('.gm-grp[data-index="' + picker.idx + '"]');
      if (growRow && row) {
        if (row.values.length) growRow.classList.remove('is-empty'); else growRow.classList.add('is-empty');
      }
      if (moved) {
        notice(isEn()
          ? ('A value moved from “' + moved + '” into row ' + (picker.idx + 1))
          : ('有值已从「' + moved + '」移到第 ' + (picker.idx + 1) + ' 组'));
      } else {
        notice('');
      }
      renderPickerList();
    }

    function placePicker() {
      if (!picker || !pickState.open) return;
      var a = picker.anchor;
      if (!a || !a.getBoundingClientRect) return;
      var r = a.getBoundingClientRect();
      var vw = global.innerWidth || 1200, vh = global.innerHeight || 800;
      var w = Math.max(200, Math.min(Math.max(r.width || 240, 240), vw - 12));
      picker.panel.style.width = Math.round(w) + 'px';
      var ph = picker.panel.offsetHeight || 0;
      var below = r.bottom + 4;
      var top = (below + ph <= vh - 6) ? below : Math.max(6, r.top - ph - 4);
      var left = Math.max(6, Math.min(r.left || 6, vw - w - 6));
      picker.panel.style.left = Math.round(left) + 'px';
      picker.panel.style.top = Math.round(top) + 'px';
    }

    function onDocDown(e) {
      if (pickState.armed) { pickState.armed = false; return; }   /* 免疫「打开它的那一次」事件 */
      var t = e && e.target;
      if (!t) return;
      if (picker && picker.anchor && (t === picker.anchor || (picker.anchor.contains && picker.anchor.contains(t)))) return;
      if (picker && picker.panel && picker.panel.contains && picker.panel.contains(t)) return;
      /* 点在面板外：只收面板，不让这次点击继续传给对话框遮罩（否则会连对话框一起关掉） */
      if (e.stopPropagation) e.stopPropagation();
      closePicker();
    }

    function onDocKey(e) {
      if (e && e.key === 'Escape' && pickState.open) {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();   /* 第一下 Esc 只收浮层，对话框留着 */
        closePicker();
      }
    }

    /* 浮层的关闭监听挂在 window 捕获阶段：必须早于 util.modal 注册在 document 捕获阶段的
       Esc / 遮罩逻辑，否则「收面板」会被「关对话框」抢走。 */
    function bindDoc(on) {
      if (!global.addEventListener) return;
      global.removeEventListener('mousedown', onDocDown, true);
      global.removeEventListener('keydown', onDocKey, true);
      global.removeEventListener('scroll', placePicker, true);
      global.removeEventListener('resize', placePicker);
      if (on) {
        global.addEventListener('mousedown', onDocDown, true);
        global.addEventListener('keydown', onDocKey, true);
        global.addEventListener('scroll', placePicker, true);
        global.addEventListener('resize', placePicker);
      }
    }

    function openPicker(i, anchor) {
      var p = ensurePicker();
      if (pickState.open && p.idx === i && p.anchor === anchor) { closePicker(); return; }
      if (pickState.open) closePicker();
      p.idx = i;
      p.anchor = anchor;
      p.search.value = '';
      if (!p.panel.parentNode) document.body.appendChild(p.panel);
      p.panel.classList.add('is-open');
      anchor.setAttribute('aria-expanded', 'true');
      pickState.open = true;
      pickState.armed = true;      /* 打开那一次事件免疫（本帧内不会有别的 mousedown，下一帧自动放开） */
      if (global.setTimeout) global.setTimeout(function () { pickState.armed = false; }, 0);
      renderPickerList();
      placePicker();
      bindDoc(true);
    }

    function closePicker() {
      if (!pickState.open) return;
      pickState.open = false;
      pickState.armed = false;
      if (picker) {
        picker.panel.classList.remove('is-open');
        if (picker.anchor && picker.anchor.setAttribute) picker.anchor.setAttribute('aria-expanded', 'false');
        if (picker.panel.parentNode) picker.panel.parentNode.removeChild(picker.panel);
      }
      bindDoc(false);
    }

    /** 对话框关闭时彻底拆掉浮层（节点与监听都不留） */
    function destroyPicker() {
      closePicker();
      if (picker && picker.panel && picker.panel.parentNode) picker.panel.parentNode.removeChild(picker.panel);
      picker = null;
    }

    /* ---------------------------------------------------------------- 批量规则 */
    function applyRules() {
      var r = gm().parseRules(rulesTa.value, st.values.map(function (v) { return v.value; }));
      if (!r.ok) { rulesMsg.textContent = r.error; rulesMsg.className = 'gm-rules-msg is-err'; return; }
      var made = 0;
      Object.keys(r.map).forEach(function (k) {
        var g = r.map[k];
        var target = -1;
        for (var i = 0; i < st.rows.length; i++) if (st.rows[i].name === g) { target = i; break; }
        if (target < 0) {
          if (st.rows.length >= gm().MAX_GROUPS) return;
          st.rows.push({ name: g, values: [] });
          target = st.rows.length - 1;
          made++;
        }
        if (st.rows[target].values.indexOf(k) >= 0) return;
        detachFromOthers(k, target);
        st.rows[target].values.push(k);
      });
      st.rows.forEach(sortRowValues);
      var skip = r.skipped.length ? ('；跳过：' + r.skipped.slice(0, 3).join('、') + (r.skipped.length > 3 ? ' 等' : '')) : '';
      if (isEn()) {
        var skipEn = r.skipped.length
          ? ('; skipped: ' + r.skipped.slice(0, 3).join(', ') + (r.skipped.length > 3 ? ' …' : ''))
          : '';
        rulesMsg.textContent = 'Applied ' + r.applied + ' rules (' + made + ' groups created)' + skipEn;
      } else {
        rulesMsg.textContent = '应用 ' + r.applied + ' 条规则（新建 ' + made + ' 组）' + skip;
      }
      rulesMsg.className = 'gm-rules-msg is-ok';
      renderGroups(); paintWindow(); renderPreview();
    }

    /* ------------------------------------------------------------------ 预览 */
    function renderPreview() {
      U.clear(previewEl);
      var col0 = df.col(st.src);
      if (!col0) { previewEl.appendChild(U.el('div', { class: 'gm-empty', text: '请选择源列' })); return; }
      var n = Math.min(5, df.rowCount);
      for (var r = 0; r < n; r++) {
        var val = gm().textOf(col0, col0.values[r]);
        var label = labelOf(val);
        previewEl.appendChild(U.el('div', { class: 'gm-prev-row' }, [
          U.el('span', { class: 'gm-prev-idx', text: String(r + 1) }),
          U.el('span', { class: 'gm-prev-src', 'data-i18n-skip': '', text: val === '' ? '（空白）' : val }),
          U.el('span', { class: 'gm-prev-arrow', text: '→' }),
          U.el('span', { class: 'gm-prev-dst' + (label === val ? ' is-raw' : ''), 'data-i18n-skip': '', text: label })
        ]));
      }
      if (!n) previewEl.appendChild(U.el('div', { class: 'gm-empty', text: '表里没有数据行' }));
    }

    function labelOf(val) {
      var g = groupOf(val);
      if (g) return g;
      if (st.unassigned === 'other') return otherLabel();
      return val === '' ? '（空白）' : val;
    }

    /* -------------------------------------------------------------- 规格与校验 */
    function currentSpec() {
      var groups = [], map = Object.create(null);
      st.rows.forEach(function (r) {
        var name = String(r.name || '').trim();
        if (!name || !r.values.length) return;
        if (groups.indexOf(name) < 0) groups.push(name);
        r.values.forEach(function (v) { if (map[v] === undefined) map[v] = name; });
      });
      return {
        sourceCol: st.src,
        targetCol: String(nameIn.value || '').trim(),
        groups: groups, map: map,
        unassigned: st.unassigned,
        otherLabel: otherLabel()
      };
    }

    function validate(spec) {
      if (!spec.targetCol) return { ok: false, error: '请填写新列名' };
      if (df.colIndex(spec.targetCol) >= 0 && !(col.groupMap && spec.targetCol === col.name)) {
        return { ok: false, error: '列名「' + spec.targetCol + '」已存在，请换一个' };
      }
      /* 有值没组名 → 报出第几行（用户在表里能直接对上） */
      for (var i = 0; i < st.rows.length; i++) {
        if (st.rows[i].values.length && !String(st.rows[i].name || '').trim()) {
          return { ok: false, error: '第 ' + (i + 1) + ' 个分组还没有组名' };
        }
      }
      var seen = Object.create(null);
      for (var j = 0; j < st.rows.length; j++) {
        var nm = String(st.rows[j].name || '').trim();
        if (!nm) continue;
        if (seen[nm]) return { ok: false, error: '组名「' + nm + '」已存在' };
        seen[nm] = 1;
      }
      if (!spec.groups.length) return { ok: false, error: '请先为至少一个值指定组名' };
      var nr = gm().normSpec(spec, df);
      if (!nr.ok) return nr;
      if (!Object.keys(nr.spec.map).length) return { ok: false, error: '还没有任何值被归组' };
      return { ok: true };
    }

    /* ------------------------------------------------------------------ 加载 */
    function rowsFromSpec(spec) {
      var rows = [], byName = Object.create(null);
      var pool = (spec.order && spec.order.length) ? spec.order : spec.groups;
      pool.forEach(function (n) {
        if (spec.groups.indexOf(n) < 0 || byName[n]) return;
        var r = { name: n, values: [] };
        byName[n] = r;
        rows.push(r);
      });
      spec.groups.forEach(function (n) {
        if (byName[n]) return;
        var r = { name: n, values: [] };
        byName[n] = r;
        rows.push(r);
      });
      st.values.forEach(function (it) {
        var g = spec.map ? spec.map[it.value] : null;
        if (g && byName[g]) byName[g].values.push(it.value);
      });
      return rows;
    }

    function reloadValues(keepGroups) {
      var r = gm().distinct(df, st.src, gm().MAX_VALUES);
      st.values = r.ok ? r.values : [];
      st.total = r.total || 0;
      st.truncated = !!r.truncated;
      if (!r.ok) showerr(r.error);
      if (!keepGroups) { st.rows = []; st.sel = Object.create(null); }
      else {
        /* 换源列：组保留，剪掉源列上已不存在的取值 */
        var have = Object.create(null);
        st.values.forEach(function (v) { have[v.value] = 1; });
        st.rows.forEach(function (row) {
          row.values = row.values.filter(function (v) { return have[v]; });
        });
        st.sel = Object.create(null);
      }
      renderValues(true);
      renderGroups();
      renderPreview();
    }

    /* ------------------------------------------------------------------ 事件 */
    srcSel.addEventListener('change', function () {
      st.src = srcSel.value;
      reloadValues(true);
      if (!st.manualTarget) nameIn.value = defaultTarget(df, st.src);
      showerr('');
    });
    nameIn.addEventListener('input', function () {
      st.manualTarget = String(nameIn.value || '').trim() !== '';
    });
    searchIn.addEventListener('input', function () {
      st.filter = String(searchIn.value || '');
      renderValues(true);
    });
    btnAll.addEventListener('click', function () {
      var list = visibleList();
      for (var i = 0; i < list.length; i++) st.sel[list[i].value] = 1;
      paintWindow();
      updateSelCount();
    });
    btnNone.addEventListener('click', function () {
      st.sel = Object.create(null);
      paintWindow();
      updateSelCount();
    });

    var rafPending = false;
    vlist.addEventListener('scroll', function () {
      if (rafPending) return;
      rafPending = true;
      var run = function () { rafPending = false; paintWindow(); };
      if (global.requestAnimationFrame) global.requestAnimationFrame(run);
      else setTimeout(run, 16);
    });
    radOther.addEventListener('change', function () {
      if (!radOther.checked) return;
      st.unassigned = 'other';
      otherTag.textContent = otherLabel();
      renderPreview();
    });
    radRaw.addEventListener('change', function () {
      if (!radRaw.checked) return;
      st.unassigned = 'raw';
      renderPreview();
    });

    _dlg = {
      modal: modal, st: st,
      rerender: function () {
        renderValues(false); renderGroups(); renderPreview();
        if (pickState.open) renderPickerList();
      }
    };

    /* 初值：已有配方 → 直接还原成「行 + 参数」；否则空表 */
    var first = gm().distinct(df, st.src, gm().MAX_VALUES);
    st.values = first.ok ? first.values : [];
    st.total = first.total || 0;
    st.truncated = !!first.truncated;
    st.rows = exist ? rowsFromSpec(exist) : [];
    renderValues(true);
    renderGroups();
    renderPreview();
    return _dlg;
  }

  /**
   * 从某列右键「分组映射…」：
   *   · 该列是分组派生列 → 以它的配方为初值重新编辑（open 内自动识别）
   *   · 普通列 → 以它为源列新建映射
   */
  function openFor(colName) {
    return open(colName);
  }

  /* 语言切换时重绘打开中的面板（运行时拼装的计数 / 提示要跟着换语言）。
     模块级只注册一次，靠 _dlg 指针判断当前是否有活面板 —— 每次 open 都注册会在切语言时堆叠回调。 */
  if (YMS.I18n && YMS.I18n.onChange) {
    YMS.I18n.onChange(function () {
      if (!_dlg || !_dlg.rerender) return;
      if (!(_dlg.modal && _dlg.modal.root && _dlg.modal.root.parentNode)) return;
      _dlg.rerender();
    });
  }

  YMS.GroupUI = {
    ROW_H: ROW_H,
    SHOW_LIMIT: PICK_LIMIT,
    open: open,
    openFor: openFor,
    commit: commit,
    defaultTarget: defaultTarget,
    /** 当前打开的对话框状态（自测用；null = 未打开） */
    state: function () {
      if (!_dlg) return null;
      var st = _dlg.st;
      return {
        open: !!(_dlg.modal && _dlg.modal.root && _dlg.modal.root.parentNode),
        src: st.src, target: st.target || '',
        groups: st.rows.map(function (r) { return r.name; }),
        rows: st.rows.map(function (r) { return { name: r.name, values: r.values.slice() }; }),
        unassigned: st.unassigned,
        values: st.values.length, total: st.total,
        selected: Object.keys(st.sel).length,
        window: st.win.slice(),
        domRows: document.querySelectorAll('#gm-vals .gm-vrow').length
      };
    }
  };
})(typeof window !== 'undefined' ? window : this);
