/* ==========================================================================
   YMS · table/transform-ui.js
   迭代 14 · 转换面板（C 路）
     · 监听 YMS.bus 的 'transform:open' {kind} → 打开对应参数面板
       （居中弹层，一次只允许一个；Esc / 点遮罩 / 取消 → 关闭且不改任何状态）
     · 面板结构：标题（操作中文名）→ 参数区 → 预览区（前 5 行 × 前 8 列，只读）
       → 底部「执行 / 取消」
     · 执行：YMS.Transform.*(…) → Store.addTable(res.df, {name: 基名+后缀, derived:true})
       （addTable 自动激活）→ 关闭面板 → toast「已生成 X（r 行 × c 列）」
       → res.notes 非空时再加一条 warn toast（最多 3 条，其余「等 N 条」）
     · 校验：必填缺失 / 表数不足 / 键为空 / 同一列既是键又是值 … → 行内提示且不关闭
     · 预览：参数一变即用当前参数在所选表上试算，只取前 5 行；试算失败只在预览区显示
       错误文字，不阻断继续改参数、不弹窗
   命名后缀严格按 docs/DEV-SPEC-迭代14.md §3；转换语义按 §2。
   迭代 20：变量名默认 Parameter / 值名默认 Value（预览表头跟随）；
            执行时把 {kind, params, parentId} 写进新表 origin（Store.addTable）；
            派生表右键「修改转换设置…」→ open(kind,{preset,targetId}) → 回填参数后
            执行走 Store.replaceTable(targetId, df, {name})：id 不变、表数不增、当前视图立即刷新。
   公开 API：YMS.TransformUI.init() / open(kind, opts?) / close() / currentKind()
             / TITLES（kind → 中文名）/ SUFFIXES（kind → 后缀 or 函数）/ NAMES（名字默认值）
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util;

  /* 基名去扩展名（表名一般已去掉扩展名，这里兜底 .yms / .csv 等） */
  var EXT_RE = /\.(csv|txt|xlsx|xls|yms)$/i;
  /* 预览上限：前 5 行 × 前 8 列（契约 §4.3） */
  var PREVIEW_ROWS = 5, PREVIEW_COLS = 8;

  /* 迭代 20：名字类输入框的统一默认值
       · 变量名 / 参数名 → Parameter
       · 值名 / 数据名   → Value
     10 个操作逐一审计（详见文件末「名字默认值审计」）：只有逆透视会**新建两个名字列**
     （varName / valName），其余操作的名字类字段都是「选择已有列」（nameCol / valueCol /
     headerCol / col / cols / by）或由数据推导的表头，不涉及用户输入的变量名 / 值名。
     三处同步点（init 默认值 / 控件占位 hint / run 兜底回退）全部引用这两个常量，避免漂移。 */
  var NAME_VAR = 'Parameter';
  var NAME_VAL = 'Value';

  /* 操作中文名（面板标题 = 菜单项名；自测按此逐项核对） */
  var TITLES = {
    pivot: '透视（长 → 宽）',
    unpivot: '逆透视（宽 → 长）',
    transpose: '转置',
    vconcat: '纵向连接（多表拼接）',
    hconcat: '横向连接（并排 / 按列）',
    join: '表连接 Join',
    split: '分列',
    merge: '合并列',
    agg: '分组汇总',
    dedup: '去重'
  };

  var _active = null;     // 当前打开的面板句柄（一次一个）
  var _subscribed = false;

  /* ======================================================================
     基础工具
     ====================================================================== */
  function esc(s) {
    if (U && U.escapeHtml) return U.escapeHtml(String(s === null || s === undefined ? '' : s));
    return String(s === null || s === undefined ? '' : s);
  }
  function store() { return YMS.Store; }
  function tables() {
    var S = store();
    return (S && S.tables) ? S.tables() : [];
  }
  function activeTable() {
    var S = store();
    return (S && S.activeTable) ? S.activeTable() : null;
  }
  function tableById(id) {
    var list = tables(), i;
    for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function colsOf(df) {
    return (df && df.cols) ? df.cols : [];
  }
  function typeCn(t) {
    var map = (YMS.types && YMS.types.TYPE_CN) || {};
    return map[t] || t;
  }
  function colOptions(df) {
    return colsOf(df).map(function (c) {
      return { value: c.name, label: c.name, title: c.name + ' · ' + typeCn(c.type) };
    });
  }
  function tableOptions(list) {
    return (list || []).map(function (t) {
      var df = t.df, shape = (df && df.cols.length) ? (df.rowCount + ' 行 × ' + df.cols.length + ' 列') : '空表';
      return { value: t.id, label: t.name, title: t.name + ' · ' + shape };
    });
  }
  function firstOfType(df, type) {
    var cols = colsOf(df), i;
    for (i = 0; i < cols.length; i++) if (cols[i].type === type) return cols[i].name;
    return '';
  }
  function firstColNot(df, names) {
    var cols = colsOf(df), i;
    for (i = 0; i < cols.length; i++) if (names.indexOf(cols[i].name) < 0) return cols[i].name;
    return '';
  }
  function numOf(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
  }
  function baseName(name) {
    var s = String(name || '').trim();
    if (!s) return '表格';
    return s.replace(EXT_RE, '') || '表格';
  }

  /* ======================================================================
     通用控件（沿用 U() 工厂：checkList / select / 数字 / 文本 / 勾选）
     ====================================================================== */
  function row(field, labelText, nodes, cls) {
    var ctl = U.el('div', { class: 'tf-ctl' + (cls ? ' ' + cls : '') });
    (Array.isArray(nodes) ? nodes : [nodes]).forEach(function (n) { if (n) ctl.appendChild(n); });
    return U.el('div', { class: 'tf-row', 'data-field': field || '' }, [
      U.el('label', { class: 'tf-label', text: labelText }),
      ctl
    ]);
  }
  /** 单选下拉（空选项 = 不指定） */
  function selectNode(options, value, onChange, attrs) {
    var sel = U.el('select', { class: 'tf-select' });
    (options || []).forEach(function (o) {
      sel.appendChild(U.el('option', { value: o.value, text: o.label, title: o.title || '' }));
    });
    sel.value = (value === undefined || value === null) ? '' : String(value);
    sel.addEventListener('change', function () { onChange(sel.value); });
    if (attrs && attrs.id) sel.id = attrs.id;
    return sel;
  }
  function textNode(value, placeholder, onChange, cls) {
    var inp = U.el('input', {
      class: 'tf-text' + (cls ? ' ' + cls : ''), type: 'text',
      value: (value === undefined || value === null) ? '' : String(value),
      placeholder: placeholder || ''
    });
    inp.addEventListener('input', function () { onChange(inp.value); });
    return inp;
  }
  function numNode(value, min, max, onChange) {
    var inp = U.el('input', { class: 'tf-num', type: 'number', value: String(numOf(value, 0)) });
    if (min !== null && min !== undefined) inp.setAttribute('min', String(min));
    if (max !== null && max !== undefined) inp.setAttribute('max', String(max));
    inp.addEventListener('input', function () { onChange(numOf(inp.value, 0)); });
    return inp;
  }
  function checkNode(text, checked, onChange) {
    var box = U.el('input', { type: 'checkbox' });
    box.checked = !!checked;
    box.addEventListener('change', function () { onChange(!!box.checked); });
    return U.el('label', { class: 'tf-check' }, [box, U.el('span', { text: text })]);
  }
  function btnNode(text, cls, title, onClick) {
    var b = U.el('button', { class: 'tf-btn' + (cls ? ' ' + cls : ''), type: 'button', text: text, title: title || '' });
    b.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); onClick(); });
    return b;
  }
  /** 多选（U.checkList 平铺 chip：点一下选中 / 再点取消） */
  function multiNode(options, values, placeholder, onChange) {
    var ctl = U.checkList({
      options: options, values: values, placeholder: placeholder || '未选择',
      onChange: function (vals) { onChange(vals.slice()); }
    });
    return ctl && ctl.node ? ctl.node : ctl;
  }

  /* ======================================================================
     预览：用当前参数试算 → 前 5 行 × 前 8 列
     ====================================================================== */
  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return (U && U.fmtNumber) ? U.fmtNumber(v, null) : String(v);
    return String(v);
  }
  function previewHtml(df) {
    if (!df) return '';
    var nc = Math.min(df.cols.length, PREVIEW_COLS);
    var nr = Math.min(df.rowCount, PREVIEW_ROWS);
    var out = ['<table class="tf-table"><thead><tr><th class="tf-h-idx">#</th>'];
    var j, r;
    for (j = 0; j < nc; j++) {
      out.push('<th title="' + esc(df.cols[j].name + ' · ' + typeCn(df.cols[j].type)) + '">' +
        esc(df.cols[j].name) + '</th>');
    }
    out.push('</tr></thead><tbody>');
    if (!nr) out.push('<tr><td class="tf-empty" colspan="' + (nc + 1) + '">（无数据行）</td></tr>');
    for (r = 0; r < nr; r++) {
      out.push('<tr><td class="tf-h-idx">' + (r + 1) + '</td>');
      for (j = 0; j < nc; j++) {
        var v = df.cell(j, r);
        var blank = (v === null || v === undefined || v === '');
        out.push('<td' + (blank ? ' class="tf-null"' : '') + ' title="' + esc(cellText(v)) + '">' +
          esc(cellText(v)) + '</td>');
      }
      out.push('</tr>');
    }
    out.push('</tbody></table>');
    return out.join('');
  }

  /** 刷新预览（任何异常都只在预览区显示，不抛、不弹窗） */
  function refreshPreview(p) {
    if (!p || !p.alive) return;
    var res = null, err = '';
    try {
      res = DEFS[p.kind].run(p.state, p);
    } catch (e) {
      err = (e && e.message) ? e.message : String(e);
    }
    var df = res && res.df ? res.df : null;
    if (err || !df) {
      p.shape.textContent = err ? '无法预览' : '—';
      p.preview.className = 'tf-preview is-empty';
      p.preview.innerHTML = '<div class="tf-preview-empty">' +
        esc(err ? ('无法预览：' + err) : '（参数不完整，暂无预览）') + '</div>';
      return;
    }
    p.shape.textContent = df.rowCount + ' 行 × ' + df.cols.length + ' 列' +
      (df.cols.length > PREVIEW_COLS ? '（列多，仅显示前 ' + PREVIEW_COLS + '）' : '');
    p.preview.className = 'tf-preview';
    p.preview.innerHTML = previewHtml(df);
  }

  /* ======================================================================
     面板：参数区 + 预览区 + 底部按钮
     ====================================================================== */
  function showError(p, msg) {
    if (!p || !p.err) return;
    p.err.textContent = msg || '';
    if (msg) p.err.classList.add('is-on'); else p.err.classList.remove('is-on');
  }

  /** 参数快照（origin.params 用：只留可 JSON 化的纯值，不存 df） */
  function snapParams(state) {
    try { return JSON.parse(JSON.stringify(state || {})); } catch (e) { return {}; }
  }
  /** 回填：只覆盖 def.init 已声明的字段（旧文件里的历史键不会污染状态） */
  function applyPreset(state, preset) {
    Object.keys(preset || {}).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(state, k)) return;
      var v = preset[k];
      state[k] = (v && typeof v === 'object') ? snapParams(v) : v;
    });
    return state;
  }

  /**
   * 创建面板（kind 已校验）
   * @param {string} kind
   * @param {{preset?:object, targetId?:string}} [opts]
   *        preset   —— 回填参数（来自派生表 origin.params）
   *        targetId —— 覆盖目标：执行时 replaceTable 覆盖这张表，不新增表；
   *                    参数与预览都基于它的**父表**（原始表格）计算
   */
  function createPanel(kind, opts) {
    var def = DEFS[kind];
    opts = opts || {};
    var S = store();
    if (!S || !S.state || !S.state.df || !colsOf(S.state.df).length) {
      if (U.toast) U.toast('请先导入数据', 'warn');
      return null;
    }
    closePanel();                              /* 一次只允许一个面板 */

    /* 覆盖模式：定位目标表与它的父表（origin.parentId） */
    var targetId = opts.targetId ? String(opts.targetId) : '';
    var target = targetId ? tableById(targetId) : null;
    if (targetId && !target) {
      if (U.toast) U.toast('要修改的表格已不存在', 'warn');
      return null;
    }
    var parentId = '';
    if (target && target.origin && target.origin.parentId) {
      parentId = String(target.origin.parentId);
      if (!tableById(parentId)) parentId = '';             /* 父表已删 → 退回目标表自身 */
    }
    var parentTable = parentId ? tableById(parentId) : null;
    var srcDf = (parentTable && parentTable.df) ? parentTable.df
      : (target && target.df) ? target.df : S.state.df;
    if (!colsOf(srcDf).length) {
      if (U.toast) U.toast('源表没有可用列', 'warn');
      return null;
    }

    var p = {
      kind: kind,
      alive: true,
      state: applyPreset(def.init(srcDf, tables()), opts.preset),
      refs: {},
      df: srcDf,
      /* 迭代 20：覆盖目标 / 来源父表 / 默认父 id（写进新表 origin.parentId） */
      targetId: targetId,
      targetName: target ? target.name : '',
      parentId: parentId,
      srcId: parentTable ? parentTable.id : (target ? target.id : S.state.activeTableId)
    };
    p.params = U.el('div', { class: 'tf-params' });
    p.err = U.el('div', { class: 'tf-error', id: 'tf-error', role: 'alert' });
    p.preview = U.el('div', { class: 'tf-preview' });
    p.shape = U.el('span', { class: 'tf-shape', text: '' });
    p.body = U.el('div', { class: 'tf-body', 'data-tf-kind': kind }, [
      p.params,
      p.err,
      U.el('div', { class: 'tf-preview-block' }, [
        U.el('div', { class: 'tf-preview-head' }, [
          U.el('span', { class: 'tf-preview-title', text: '预览 · 前 ' + PREVIEW_ROWS + ' 行 × 前 ' + PREVIEW_COLS + ' 列' }),
          p.shape
        ]),
        U.el('div', { class: 'tf-preview-scroll' }, [p.preview])
      ])
    ]);

    /* 参数变更 → 清行内提示 + 刷新预览（防抖，避免连续点选时反复试算） */
    p.touch = U.debounce(function () {
      showError(p, '');
      refreshPreview(p);
    }, 90);
    p.changed = function () { if (p.alive) p.touch(); };
    /* 结构变化（依赖项变了要重建参数区） */
    p.rebuild = function () {
      if (!p.alive) return;
      buildParams(p);
      p.touch();
    };

    var m = U.modal({
      title: def.title + (p.targetId ? ' · 修改设置' : ''),
      body: p.body,
      footer: [
        {
          text: p.targetId ? '更新表格' : '执行', cls: 'btn-primary tf-run',
          onClick: function (close) { execute(p, close); }
        },
        { text: '取消', cls: 'tf-cancel', onClick: function (close) { close(); } }
      ],
      onClose: function () {
        p.alive = false;
        if (_active === p) _active = null;
        if (U.closeDropSelect) U.closeDropSelect();
      }
    });
    if (!m) return null;
    p.modal = m;
    m.box.classList.add('tf-modal');
    m.box.id = 'tf-panel';
    m.box.setAttribute('data-tf-kind', kind);
    _active = p;

    buildParams(p);
    refreshPreview(p);
    return p;
  }

  /** 构建参数区（依赖项变化时整体重建，控件状态全部来自 p.state） */
  function buildParams(p) {
    U.clear(p.params);
    (DEFS[p.kind].controls(p) || []).forEach(function (n) { if (n) p.params.appendChild(n); });
  }

  /* ======================================================================
     执行（校验 → 转换 → addTable → 关闭 → toast + notes 汇总）
     ====================================================================== */
  function notesToast(notes) {
    /* 只汇总真正需要用户知道的提示（level==='warn'；info 类多为「N 行 → M 行」摘要，
       已由成功 toast 的「行 × 列」表达，不再重复刷一条） */
    var texts = (notes || []).filter(function (n) {
      return n && n.level !== 'info';
    }).map(function (n) {
      return (n && n.text) ? String(n.text) : String(n || '');
    }).filter(function (t) { return !!t; });
    if (!texts.length) return;
    var head = texts.slice(0, 3).join('；');
    var rest = texts.length - 3;
    if (U.toast) U.toast('提示：' + head + (rest > 0 ? ' 等 ' + rest + ' 条' : ''), 'warn', 6000);
  }

  function execute(p, close) {
    var def = DEFS[p.kind], msg, res;
    msg = def.validate(p.state, p);
    if (msg) { showError(p, msg); return false; }          /* 非法 → 行内提示，不关闭 */
    try {
      res = def.run(p.state, p);
    } catch (e) {
      showError(p, '执行失败：' + ((e && e.message) ? e.message : e));
      return false;
    }
    if (!res || !res.df) { showError(p, '执行失败：没有得到结果表'); return false; }

    var S = store();
    var suffix = (typeof def.suffix === 'function') ? def.suffix(p.state) : def.suffix;
    var df = res.df;
    var info;

    /* 迭代 20：origin —— 参数快照 + 父表 id，供列表树形缩进与「修改转换设置…」回填 */
    var parentId = p.targetId
      ? (p.parentId || '')                                     /* 覆盖模式：保持原父表不变 */
      : ((typeof def.parentId === 'function') ? def.parentId(p.state, p) : p.srcId);
    var origin = { kind: p.kind, params: snapParams(p.state), parentId: parentId || '' };

    try {
      if (p.targetId) {
        /* 覆盖模式：id 不变、表数不变、名称按「父表基名 + 新后缀」 */
        var par = parentId ? tableById(parentId) : null;
        var base0 = baseName(par ? par.name : p.targetName);
        info = S.replaceTable(p.targetId, df, { name: base0 + suffix, origin: origin });
        if (!info) { showError(p, '更新表格失败（目标表已不存在）'); return false; }
        p.alive = false;
        if (close) close();
        if (U.toast) {
          U.toast('已更新 ' + info.name + '（' + df.rowCount + ' 行 × ' + df.cols.length + ' 列）', 'ok');
        }
        notesToast(res.notes);
        return true;
      }
      var act = (S && S.activeTable) ? S.activeTable() : null;
      var base = baseName(act ? act.name : (S && S.state ? S.state.tableName : ''));
      info = S.addTable(df, { name: base + suffix, derived: true, origin: origin });
    } catch (e2) {
      showError(p, (p.targetId ? '更新表格失败：' : '生成新表失败：') + ((e2 && e2.message) ? e2.message : e2));
      return false;
    }
    if (!info) { showError(p, '生成新表失败'); return false; }

    p.alive = false;                                       /* 先标记，避免 onClose 后重建 */
    if (close) close();
    if (U.toast) U.toast('已生成 ' + info.name + '（' + df.rowCount + ' 行 × ' + df.cols.length + ' 列）', 'ok');
    notesToast(res.notes);
    return true;
  }

  /* ======================================================================
     10 个操作定义：init 默认值 / controls 参数区 / validate 校验 / run 试算&执行
     ====================================================================== */
  var DEFS = {
    /* ---------------------------------------------------------- 透视 pivot */
    pivot: {
      title: TITLES.pivot,
      suffix: '_pivot',
      init: function (df) {
        var cols = colsOf(df);
        var nameCol = firstOfType(df, 'string') || (cols[0] ? cols[0].name : '');
        var valueCol = firstOfType(df, 'number');
        if (!valueCol || valueCol === nameCol) valueCol = firstColNot(df, [nameCol]) || nameCol;
        var ids = cols.map(function (c) { return c.name; }).filter(function (n) {
          return n !== nameCol && n !== valueCol;
        });
        return { ids: ids, nameCol: nameCol, valueCol: valueCol, agg: 'first', prefix: '' };
      },
      controls: function (p) {
        var s = p.state, df = p.df;
        var opts = colOptions(df);
        return [
          row('ids', '行标识列', multiNode(opts, s.ids, '未选择（留空＝其余全部列）', function (vals) {
            s.ids = vals;
            p.changed();
          })),
          row('nameCol', '列名来源列', selectNode(opts, s.nameCol, function (v) {
            s.nameCol = v;
            s.ids = s.ids.filter(function (n) { return n !== v; });   /* 同列不能既做行标识又做列名 */
            p.rebuild();
          })),
          row('valueCol', '值列', selectNode(opts, s.valueCol, function (v) {
            s.valueCol = v;
            s.ids = s.ids.filter(function (n) { return n !== v; });
            p.rebuild();
          })),
          row('agg', '聚合', selectNode([
            { value: 'first', label: 'first（首个值）' },
            { value: 'sum', label: 'sum（求和）' },
            { value: 'mean', label: 'mean（平均）' },
            { value: 'count', label: 'count（计数）' },
            { value: 'max', label: 'max（最大）' },
            { value: 'min', label: 'min（最小）' }
          ], s.agg, function (v) { s.agg = v; p.changed(); })),
          row('prefix', '列名前缀', textNode(s.prefix, '留空＝「值列_」', function (v) {
            s.prefix = v;
            p.changed();
          }))
        ];
      },
      validate: function (s) {
        if (!s.nameCol) return '请选择列名来源列';
        if (!s.valueCol) return '请选择值列';
        if (s.nameCol === s.valueCol) return '列名来源列与值列不能是同一列';
        if (s.ids.indexOf(s.nameCol) >= 0 || s.ids.indexOf(s.valueCol) >= 0) {
          return '行标识列不能包含「' + (s.ids.indexOf(s.nameCol) >= 0 ? s.nameCol : s.valueCol) +
            '」（同一列不能既是行标识又是列名/值列）';
        }
        return '';
      },
      run: function (s, p) {
        var opts = { ids: s.ids.slice(), nameCol: s.nameCol, valueCol: s.valueCol, agg: s.agg };
        if (String(s.prefix || '').trim() !== '') opts.prefix = String(s.prefix).trim();
        return YMS.Transform.pivot(p.df, opts);
      }
    },

    /* ------------------------------------------------------- 逆透视 unpivot */
    unpivot: {
      title: TITLES.unpivot,
      suffix: '_unpivot',
      init: function (df) {
        var all = colsOf(df).map(function (c) { return c.name; });
        /* 迭代 20：变量名默认 Parameter、值名默认 Value（用户可直接改，预览表头实时跟随） */
        return { keep: [], valueCols: all, varName: NAME_VAR, valName: NAME_VAL };
      },
      controls: function (p) {
        var s = p.state, df = p.df;
        var opts = colOptions(df);
        var vopts = opts.filter(function (o) { return s.keep.indexOf(o.value) < 0; });
        return [
          row('keep', '保留列', multiNode(opts, s.keep, '不保留（全部展开）', function (vals) {
            s.keep = vals;
            s.valueCols = s.valueCols.filter(function (n) { return vals.indexOf(n) < 0; });
            p.rebuild();
          })),
          row('valueCols', '展开列', multiNode(vopts, s.valueCols, '未选择（默认全部非保留列）', function (vals) {
            s.valueCols = vals;
            p.changed();
          })),
          row('varName', '变量名', textNode(s.varName, NAME_VAR, function (v) { s.varName = v; p.changed(); })),
          row('valName', '值名', textNode(s.valName, NAME_VAL, function (v) { s.valName = v; p.changed(); }))
        ];
      },
      validate: function (s) {
        if (!s.valueCols.length) return '请至少选择一个展开列';
        var dup = s.valueCols.filter(function (n) { return s.keep.indexOf(n) >= 0; });
        if (dup.length) return '「' + dup.join('、') + '」不能同时作为保留列与展开列';
        return '';
      },
      run: function (s, p) {
        return YMS.Transform.unpivot(p.df, {
          keep: s.keep.slice(), valueCols: s.valueCols.slice(),
          /* 兜底回退与默认值同源：清空输入框 → 仍落在 Parameter / Value */
          varName: String(s.varName || '').trim() || NAME_VAR,
          valName: String(s.valName || '').trim() || NAME_VAL
        });
      }
    },

    /* ------------------------------------------------------- 转置 transpose */
    transpose: {
      title: TITLES.transpose,
      suffix: '_T',
      init: function () { return { headerCol: '' }; },
      controls: function (p) {
        var s = p.state;
        var opts = [{ value: '', label: '（不用，A/B/C 序号）' }].concat(colOptions(p.df));
        return [
          row('headerCol', '表头来源列', selectNode(opts, s.headerCol, function (v) {
            s.headerCol = v;
            p.changed();
          }))
        ];
      },
      validate: function () { return ''; },
      run: function (s, p) {
        return YMS.Transform.transpose(p.df, { headerCol: s.headerCol || null });
      }
    },

    /* ------------------------------------------------- 纵向连接 vconcat */
    vconcat: {
      title: TITLES.vconcat,
      suffix: '_vcat',
      init: function () { return { tableIds: tables().map(function (t) { return t.id; }), mode: 'union' }; },
      controls: function (p) {
        var s = p.state;
        return [
          row('tableIds', '参与表（≥2）', multiNode(tableOptions(tables()), s.tableIds, '未选择', function (vals) {
            s.tableIds = vals;
            p.changed();
          }), 'is-stack'),
          row('mode', '列对齐', selectNode([
            { value: 'union', label: '并集 union（缺列补空）' },
            { value: 'intersect', label: '交集 intersect（只留共有列）' }
          ], s.mode, function (v) { s.mode = v; p.changed(); }))
        ];
      },
      /* 树形归属：结果挂在「第一张参与表」下 */
      parentId: function (s, p) { return (s.tableIds && s.tableIds[0]) || p.srcId; },
      validate: function (s) {
        if (s.tableIds.length < 2) return '请至少选择 2 张表（当前 ' + s.tableIds.length + ' 张）';
        return '';
      },
      run: function (s) {
        var dfs = s.tableIds.map(tableById).filter(Boolean).map(function (t) { return t.df; });
        return YMS.Transform.vconcat(dfs, { mode: s.mode });
      }
    },

    /* ------------------------------------------------- 横向连接 hconcat */
    hconcat: {
      title: TITLES.hconcat,
      suffix: '_hcat',
      init: function () {
        return { tableIds: tables().map(function (t) { return t.id; }), mode: 'index', key: '' };
      },
      controls: function (p) {
        var s = p.state;
        var sel = s.tableIds.map(tableById).filter(Boolean);
        var common = sel.length ? colsOf(sel[0].df).map(function (c) { return c.name; }) : [];
        sel.slice(1).forEach(function (t) {
          common = common.filter(function (n) { return t.df && t.df.colIndex(n) >= 0; });
        });
        var kopts = [{ value: '', label: '（未选择）' }].concat(common.map(function (n) {
          return { value: n, label: n };
        }));
        var rows = [
          row('tableIds', '参与表（≥2）', multiNode(tableOptions(tables()), s.tableIds, '未选择', function (vals) {
            s.tableIds = vals;
            s.key = '';                       /* 参与表变了，公共键需重选 */
            p.rebuild();
          }), 'is-stack'),
          row('mode', '模式', selectNode([
            { value: 'index', label: '按行序号 index（并排）' },
            { value: 'key', label: '按公共键 key（对齐）' }
          ], s.mode, function (v) {
            s.mode = v;
            p.rebuild();
          }))
        ];
        if (s.mode === 'key') {
          rows.push(row('key', '键列', selectNode(kopts, s.key, function (v) { s.key = v; p.changed(); })));
        }
        return rows;
      },
      /* 树形归属：结果挂在「第一张参与表」下 */
      parentId: function (s, p) { return (s.tableIds && s.tableIds[0]) || p.srcId; },
      validate: function (s) {
        if (s.tableIds.length < 2) return '请至少选择 2 张表（当前 ' + s.tableIds.length + ' 张）';
        if (s.mode === 'key' && !s.key) return 'key 模式必须选择键列';
        return '';
      },
      run: function (s) {
        var sel = s.tableIds.map(tableById).filter(Boolean);
        var dfs = sel.map(function (t) { return t.df; });
        var opts = { mode: s.mode };
        if (s.mode === 'key') opts.key = s.key;
        return YMS.Transform.hconcat(dfs, opts);
      }
    },

    /* ------------------------------------------------------------ 表连接 join */
    join: {
      title: TITLES.join,
      suffix: function (s) { return '_' + (s.how || 'inner'); },
      init: function () {
        var list = tables();
        var act = activeTable();
        var leftId = act ? act.id : (list[0] ? list[0].id : '');
        var rightId = '', i;
        /* 右表默认：优先取「有同名同类型列」的另一张表（可直接自动匹配键），否则取第一张其它表 */
        for (i = 0; i < list.length; i++) {
          if (list[i].id === leftId) continue;
          if (!rightId) rightId = list[i].id;
          if (autoKeys(leftId, list[i].id).length) { rightId = list[i].id; break; }
        }
        return { leftId: leftId, rightId: rightId, keys: autoKeys(leftId, rightId), how: 'inner', nullEqual: false };
      },
      controls: function (p) {
        var s = p.state, list = tables();
        var ldf = s.leftId ? (tableById(s.leftId) || {}).df : null;
        var kOpts = colOptions(ldf);
        return [
          row('leftId', '左表', selectNode(tableOptions(list), s.leftId, function (v) {
            s.leftId = v;
            if (s.rightId === v) {
              var alt = tables().filter(function (t) { return t.id !== v; })[0];
              s.rightId = alt ? alt.id : '';
            }
            s.keys = autoKeys(s.leftId, s.rightId);
            p.rebuild();
          })),
          row('rightId', '右表', selectNode(tableOptions(list), s.rightId, function (v) {
            s.rightId = v;
            s.keys = autoKeys(s.leftId, s.rightId);
            p.rebuild();
          })),
          row('keys', '键列', [
            multiNode(kOpts, s.keys, '未选择（点「自动」或手动选）', function (vals) {
              s.keys = vals;
              p.changed();
            }),
            btnNode('自动', 'tf-auto', '自动：两侧同名且类型一致的列', function () {
              s.keys = autoKeys(s.leftId, s.rightId);
              p.rebuild();
            })
          ]),
          row('how', '方式', selectNode([
            { value: 'inner', label: '内 inner（交集）' },
            { value: 'left', label: '左 left（保留左表全部）' },
            { value: 'right', label: '右 right（保留右表全部）' },
            { value: 'outer', label: '外 outer（并集）' }
          ], s.how, function (v) { s.how = v; p.changed(); })),
          row('nullEqual', '空值处理', checkNode('空值与空值视为相等', s.nullEqual, function (v) {
            s.nullEqual = v;
            p.changed();
          }))
        ];
      },
      /* 树形归属：结果挂在「左表」下 */
      parentId: function (s, p) { return s.leftId || p.srcId; },
      validate: function (s) {
        if (tables().length < 2) return '至少需要 2 张表才能连接（当前 1 张）';
        if (!s.rightId) return '请选择右表';
        if (s.leftId === s.rightId) return '左表与右表不能是同一张表';
        if (!s.keys.length) return '请至少选择一个键列（可点「自动」）';
        var b = tableById(s.rightId);
        var miss = s.keys.filter(function (k) {
          return !(b && b.df && b.df.colIndex(k) >= 0);
        });
        if (miss.length) return '右表缺少键列「' + miss.join('、') + '」';
        return '';
      },
      run: function (s) {
        var a = tableById(s.leftId), b = tableById(s.rightId);
        if (!a || !b) throw new Error('请选择左表与右表');
        return YMS.Transform.join(a.df, b.df, {
          keys: s.keys.slice(), how: s.how, nullEqual: !!s.nullEqual
        });
      }
    },

    /* -------------------------------------------------------------- 分列 split */
    split: {
      title: TITLES.split,
      suffix: '_split',
      init: function (df) {
        var col = firstOfType(df, 'string') || (colsOf(df)[0] ? colsOf(df)[0].name : '');
        return { col: col, sep: ',', limit: 0 };
      },
      controls: function (p) {
        var s = p.state;
        return [
          row('col', '源列', selectNode(colOptions(p.df), s.col, function (v) { s.col = v; p.changed(); })),
          row('sep', '分隔符', textNode(s.sep, '例如 , 或 -', function (v) { s.sep = v; p.changed(); })),
          row('limit', '最多拆分份数', numNode(s.limit, 0, 200, function (v) { s.limit = v; p.changed(); }))
        ];
      },
      validate: function (s) {
        if (!s.col) return '请选择源列';
        if (String(s.sep) === '') return '分隔符不能为空';
        return '';
      },
      run: function (s, p) {
        return YMS.Transform.splitColumn(p.df, { col: s.col, sep: String(s.sep), limit: numOf(s.limit, 0) });
      }
    },

    /* ------------------------------------------------------------- 合并列 merge */
    merge: {
      title: TITLES.merge,
      suffix: '_merge',
      init: function () { return { cols: [], sep: '-', name: '合并列', drop: true }; },
      controls: function (p) {
        var s = p.state;
        return [
          row('cols', '待合并列（≥2）', multiNode(colOptions(p.df), s.cols, '未选择', function (vals) {
            s.cols = vals;
            p.changed();
          })),
          row('sep', '分隔符', textNode(s.sep, '-', function (v) { s.sep = v; p.changed(); })),
          row('name', '新列名', textNode(s.name, '合并列', function (v) { s.name = v; p.changed(); })),
          row('drop', '选项', checkNode('删除源列', s.drop, function (v) { s.drop = v; p.changed(); }))
        ];
      },
      validate: function (s) {
        if (s.cols.length < 2) return '请至少选择 2 列（当前 ' + s.cols.length + ' 列）';
        if (!String(s.name || '').trim()) return '新列名不能为空';
        return '';
      },
      run: function (s, p) {
        return YMS.Transform.mergeColumns(p.df, {
          cols: s.cols.slice(), sep: String(s.sep), name: String(s.name).trim(), drop: !!s.drop
        });
      }
    },

    /* ------------------------------------------------------- 分组汇总 agg */
    agg: {
      title: TITLES.agg,
      suffix: '_agg',
      init: function (df) {
        var col = firstOfType(df, 'number') || (colsOf(df)[0] ? colsOf(df)[0].name : '');
        return { by: [], aggs: [{ col: col, fn: 'sum' }] };
      },
      controls: function (p) {
        var s = p.state;
        var opts = colOptions(p.df);
        var rows = [
          row('by', '分组列', multiNode(opts, s.by, '不分组（全表汇总 1 行）', function (vals) {
            s.by = vals;
            p.changed();
          }), 'is-stack')
        ];
        s.aggs.forEach(function (a, i) {
          rows.push(row('agg-' + i, i === 0 ? '聚合项' : '', [
            selectNode(opts, a.col, function (v) { a.col = v; p.changed(); }),
            selectNode([
              { value: 'sum', label: 'sum' },
              { value: 'mean', label: 'mean' },
              { value: 'count', label: 'count' },
              { value: 'min', label: 'min' },
              { value: 'max', label: 'max' },
              { value: 'std', label: 'std' },
              { value: 'nunique', label: 'nunique' }
            ], a.fn, function (v) { a.fn = v; p.changed(); }),
            btnNode('✕', 'tf-del', '删除该聚合项', function () {
              s.aggs.splice(i, 1);
              p.rebuild();
            })
          ], 'tf-agg-row'));
        });
        rows.push(row('add', '', [
          btnNode('+ 添加聚合项', 'tf-add', '再加一行「列 + 函数」', function () {
            s.aggs.push({ col: (opts[0] || {}).value || '', fn: 'sum' });
            p.rebuild();
          })
        ]));
        return rows;
      },
      validate: function (s) {
        if (!s.aggs.length) return '请至少添加一个聚合项';
        for (var i = 0; i < s.aggs.length; i++) {
          if (!s.aggs[i].col) return '第 ' + (i + 1) + ' 个聚合项未选择列';
        }
        return '';
      },
      run: function (s, p) {
        return YMS.Transform.groupAggregate(p.df, {
          by: s.by.slice(),
          aggs: s.aggs.map(function (a) { return { col: a.col, fn: a.fn }; })
        });
      }
    },

    /* ------------------------------------------------------------ 去重 dedup */
    dedup: {
      title: TITLES.dedup,
      suffix: '_dedup',
      init: function () { return { cols: [], keep: 'first' }; },
      controls: function (p) {
        var s = p.state;
        return [
          row('cols', '判重列', multiNode(colOptions(p.df), s.cols, '不选＝整行判重', function (vals) {
            s.cols = vals;
            p.changed();
          })),
          row('keep', '保留', selectNode([
            { value: 'first', label: '首个 first' },
            { value: 'last', label: '末个 last' }
          ], s.keep, function (v) { s.keep = v; p.changed(); }))
        ];
      },
      validate: function () { return ''; },
      run: function (s, p) {
        return YMS.Transform.dedupe(p.df, { cols: s.cols.slice(), keep: s.keep });
      }
    }
  };
  /** 自动键列：两侧同名且类型一致的列 */
  function autoKeys(leftId, rightId) {
    var a = tableById(leftId), b = tableById(rightId);
    if (!a || !b || !a.df || !b.df) return [];
    var out = [];
    colsOf(a.df).forEach(function (c) {
      var cb = b.df.col(c.name);
      if (cb && cb.type === c.type) out.push(c.name);
    });
    return out;
  }

  /* ======================================================================
     打开 / 关闭 / 订阅
     ====================================================================== */
  function closePanel() {
    if (_active && _active.modal) {
      var m = _active.modal;
      _active.alive = false;
      _active = null;
      m.close();
    } else {
      _active = null;
    }
  }

  /**
   * 打开转换面板
   * @param {string} kind 操作
   * @param {{preset?:object, targetId?:string}} [opts]
   *        迭代 20：preset = 回填参数（origin.params）；targetId = 覆盖目标（执行时原地覆盖该表）
   */
  function open(kind, opts) {
    if (!DEFS[kind]) return null;
    return createPanel(kind, opts || {});
  }

  /** 订阅 'transform:open'（重复 init 只生效一次；payload 可带 preset / targetId） */
  function init() {
    if (_subscribed) return true;
    if (!YMS.bus || !YMS.bus.on) return false;
    YMS.bus.on('transform:open', function (payload) {
      var kind = payload && payload.kind;
      if (!kind) return;
      open(kind, payload);
    });
    _subscribed = true;
    return true;
  }

  /* ======================================================================
     迭代 20 · 名字默认值审计（10 个操作逐一核对）
     ----------------------------------------------------------------------
     统一规则：涉及「变量名 / 参数名」的输入默认 Parameter，涉及「值名 / 数据名」的默认 Value。
       pivot       —— 无名字输入：ids / nameCol / valueCol 都是**选列**，prefix 是列名前缀（可留空）
       unpivot     —— varName = Parameter、valName = Value  ✔（唯一的名字输入对）
       transpose   —— 无名字输入：headerCol 选列，未选时表头为 A/B/C 序号
       vconcat     —— 无名字输入：tableIds / mode
       hconcat     —— 无名字输入：tableIds / mode / key
       join        —— 无名字输入：leftId / rightId / keys / how / nullEqual
       split       —— 无名字输入：col / sep / limit（新列名为「源列_序号」，由数据推导）
       merge       —— 「新列名」默认「合并列」：这是**结果列名**而非变量名 / 值名，
                      且用户多半要自取语义名，按用户既有习惯保留（未纳入 Parameter/Value 统一）
       agg         —— 无名字输入：by / aggs（聚合结果列名为「列_fn」，由数据推导）
       dedup       —— 无名字输入：cols / keep
     三处同步点（任一漂移就会出现「输入框显示 A、结果列叫 B」）：
       ① init 默认值 ② 控件 placeholder（hint） ③ run 的 || 兜底回退  —— 全部引用 NAME_VAR / NAME_VAL
     预览表头不写死：预览由 run 的结果表渲染，表头即 varName / valName 当前值，输入即变。
     ====================================================================== */

  YMS.TransformUI = {
    init: init,
    open: open,
    close: closePanel,
    currentKind: function () { return _active ? _active.kind : ''; },
    isOpen: function () { return !!_active; },
    /* 当前面板是否为「修改转换设置」覆盖模式（自测用） */
    currentTargetId: function () { return _active ? (_active.targetId || '') : ''; },
    kinds: function () { return Object.keys(DEFS); },
    TITLES: TITLES,
    /* 名字类默认值（自测比对用，与 init / hint / 兜底同源） */
    NAMES: { varName: NAME_VAR, valName: NAME_VAL },
    /* 供自测阅读的纯逻辑入口（不改变状态） */
    _baseName: baseName,
    _previewHtml: previewHtml,
    _snapParams: snapParams,
    _applyPreset: applyPreset
  };

  init();     /* 脚本加载即订阅（YMS.bus 在 core/events.js 已就绪） */
})(typeof window !== 'undefined' ? window : this);
