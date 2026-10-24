/* ==========================================================================
   YMS · table/table-view.js
   原始表格区 —— YMS.TableView
     · #tables-panel（迭代 14）：多表列表 —— 「表格（N）」标题 + 每表一行（名称 · 行×列），
       当前表高亮；点击切表；右键「设为当前 / 重命名 / 复制 / 导出 CSV / 删除」；
       >8 张表时列表内部滚动（不挤占列清单高度）；派生表名后加淡色「· 派生」
       迭代 20：派生表按 origin.parentId 紧跟父表下方并缩进两格（多级叠加，CSS --depth），
                右键对被转换过的表（有 origin）多一项「修改转换设置…」→ 回填参数后覆盖本表。
     · #raw-table-name：表格名（Store.state.tableName）；无数据时显示 —
     · #raw-header-list：每行 = 序号 + 参数名 + 类型徽标（number / time / char）
       + 缺失提示（有缺失时显示「缺 N」，title 说明缺失行数）
     · 右键 → YMS.ColumnOps.contextMenu（浏览器内）；单击 → 高亮该行并在数据显示区滚动到该列
     · 只从 YMS.Store 读；用 HTML 字符串一次性 innerHTML 渲染（列数一般 ≤ 数百，足够快）
   公开 API：init() / render() / renderTables()
   内部纯逻辑（供 Node 自测）：_listHtml(df) / _tablesHtml(tables, activeId)
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util, T = YMS.types, Store = YMS.Store;

  var _list = null, _name = null;
  var _tablesList = null, _tablesPanel = null, _tablesCount = null;
  var _bound = false, _tablesBound = false, _tablesSubscribed = false;
  var _activeCol = null;

  /** HTML 转义（util 缺失时退化，保证渲染不抛异常） */
  function esc(s) {
    if (U && U.escapeHtml) return U.escapeHtml(String(s === undefined || s === null ? '' : s));
    return String(s === undefined || s === null ? '' : s);
  }
  function fmtInt(n) { return (U && U.fmtInt) ? U.fmtInt(n) : String(n); }

  /** 类型徽标文本：number / time / char */
  function typeLabel(type) { return T.TYPE_LABEL[type] || type; }
  /** 类型徽标 class：type-number / type-time / type-string */
  function badgeCls(type) { return 'type-badge type-' + type; }

  /**
   * 构建参数列表 HTML（纯函数，Node 可测）
   * @param {DataFrame|null} df
   * @returns {string}
   */
  function listHtml(df) {
    if (!df || !df.cols.length) return '<div class="empty-hint">尚未载入数据</div>';
    var out = [], i;
    for (i = 0; i < df.cols.length; i++) {
      var c = df.cols[i];
      var miss = c.missing || 0;
      out.push('<div class="raw-item" data-col="' + U.escapeHtml(c.name) + '"' +
        ' title="' + U.escapeHtml(c.name + ' · ' + (T.TYPE_CN[c.type] || c.type) + '（' + typeLabel(c.type) + '）' +
          (miss ? ' · 缺失 ' + U.fmtInt(miss) + ' 行' : ' · 无缺失')) + '">' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="pname">' + U.escapeHtml(c.name) + '</span>' +
        '<span class="' + badgeCls(c.type) + '">' + U.escapeHtml(typeLabel(c.type)) + '</span>' +
        (miss ? '<span class="miss-dot" title="缺失 ' + U.fmtInt(miss) + ' 行数据（显示为空）">缺 ' + U.fmtInt(miss) + '</span>' : '') +
        '</div>');
    }
    return out.join('');
  }

  /* ==========================================================================
     迭代 14：多表列表（#tables-panel）
     ========================================================================== */
  /** 行×列 文本（空表 → '—'） */
  function shapeText(df) {
    if (!df || !df.cols.length) return '—';
    return fmtInt(df.rowCount) + '×' + df.cols.length;
  }

  /**
   * 迭代 20：把平铺表数组整理成「树形显示顺序」
   * 规则：某表的父 = origin.parentId（父表必须在列表中，否则按根表处理）；
   *       根表保持 Store 原顺序，每个父表后面紧跟它的子表（递归），子表按原顺序。
   * @param {Array} tables
   * @returns {Array} [{ table, depth, parentId }]
   */
  function treeOrder(tables) {
    var list = tables || [];
    var byId = {}, i;
    for (i = 0; i < list.length; i++) byId[list[i].id] = list[i];
    /** 父 id（父表不存在 / 无 origin / 自指 → ''） */
    var pid = function (t) {
      var p = t && t.origin ? String(t.origin.parentId || '') : '';
      if (!p || p === t.id || !byId[p]) return '';
      return p;
    };
    var kids = {}, roots = [];
    for (i = 0; i < list.length; i++) {
      var p0 = pid(list[i]);
      if (!p0) { roots.push(list[i]); continue; }
      if (!kids[p0]) kids[p0] = [];
      kids[p0].push(list[i]);
    }
    var out = [], seen = {};
    /* 递归展开；seen 防环（理论上不会有，防御性处理） */
    var walk = function (t, depth) {
      if (seen[t.id]) return;
      seen[t.id] = 1;
      out.push({ table: t, depth: depth, parentId: pid(t) });
      var cs = kids[t.id] || [];
      for (var k = 0; k < cs.length; k++) walk(cs[k], depth + 1);
    };
    for (i = 0; i < roots.length; i++) walk(roots[i], 0);
    for (i = 0; i < list.length; i++) if (!seen[list[i].id]) walk(list[i], 0);   // 环内孤儿兜底
    return out;
  }

  /**
   * 构建表格列表 HTML（纯函数，Node 可测）
   * 每项：data-table-id / data-depth / data-parent-id / 名称（派生表加淡色「· 派生」）/ 行×列；
   *       当前表 is-active。派生表紧跟父表并缩进 —— 缩进走 CSS 变量 --depth
   *       （`.tables-item { padding-left: calc(8px + 2ch * var(--depth)) }`），不使用 &nbsp;。
   * @param {Array} tables @param {string} activeId
   * @returns {string}
   */
  function tablesHtml(tables, activeId) {
    if (!tables || !tables.length) return '<div class="empty-hint">尚无表格</div>';
    var rows = treeOrder(tables), out = [], i;
    for (i = 0; i < rows.length; i++) {
      var t = rows[i].table, depth = rows[i].depth;
      var df = t.df;
      var tip = t.name + ' · ' + (df && df.cols.length
        ? fmtInt(df.rowCount) + ' 行 × ' + df.cols.length + ' 列'
        : '空表') + (t.fileName ? ' · 来源 ' + t.fileName : '') +
        (t.origin && t.origin.kind ? ' · 变换 ' + t.origin.kind : '');
      out.push('<div class="tables-item' + (t.id === activeId ? ' is-active' : '') + '"' +
        ' data-table-id="' + esc(t.id) + '"' +
        ' data-depth="' + depth + '"' +
        ' data-parent-id="' + esc(rows[i].parentId) + '"' +
        ' style="--depth:' + depth + '"' +
        ' title="' + esc(tip) + '">' +
        '<span class="tname">' + esc(t.name) +
          (t.derived ? '<span class="tderived">· 派生</span>' : '') + '</span>' +
        '<span class="tshape">' + esc(shapeText(df)) + '</span>' +
        '</div>');
    }
    return out.join('');
  }

  /** 按 id 找表（只读 Store） */
  function findTable(id) {
    var list = (Store && Store.tables) ? Store.tables() : [], i;
    for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /** 导出某张表的 CSV（非当前表先切过去，导出内容与数据显示区一致） */
  function exportTableCsv(t) {
    try {
      if (!t || !t.df || !t.df.rowCount) { U.toast('该表没有可导出的数据行', 'warn'); return false; }
      if (Store.state.activeTableId !== t.id) Store.setActiveTable(t.id);
      var fn = String(t.name || '表格').replace(/[\\/:*?"<>|]/g, '_') + '.csv';
      var ok = (YMS.Exporter && YMS.Exporter.exportCSV) ? YMS.Exporter.exportCSV(fn) : false;
      if (!ok) U.toast('导出失败（导出模块未就绪）', 'error');
      return ok;
    } catch (err) {
      if (global.console) global.console.error('[YMS.TableView] 导出表格 CSV 失败', err);
      U.toast('导出失败：' + (err && err.message ? err.message : err), 'error');
      return false;
    }
  }

  /** 删除表（二次确认；确认后若删的是当前表，Store 会自动激活相邻表） */
  function confirmRemove(t) {
    var df = t.df;
    var shape = df && df.cols.length ? fmtInt(df.rowCount) + ' 行 × ' + df.cols.length + ' 列' : '空表';
    U.confirm({
      title: '删除表格',
      message: '确定删除表格 <b>' + esc(t.name) + '</b>（' + shape + '）？<br>删除后不可恢复。',
      okText: '删除', cancelText: '取消'
    }).then(function (yes) {
      if (!yes) return;
      var name = t.name;
      Store.removeTable(t.id);
      U.toast('已删除表格 <b>' + esc(name) + '</b>', 'ok');
    });
  }

  /** 表格项右键菜单 */
  function openTableMenu(evt, t) {
    var x = evt && evt.clientX ? evt.clientX : 0;
    var y = evt && evt.clientY ? evt.clientY : 0;
    if (!x && !y && _tablesList) {                       // 键盘 / 编程触发：贴列表右下方
      var r = _tablesList.getBoundingClientRect();
      x = Math.round(r.left + 16); y = Math.round(r.top + 24);
    }
    var isActive = Store.state.activeTableId === t.id;
    var rows = (t.df && t.df.rowCount) ? t.df.rowCount : 0;
    var items = [];
    /* 迭代 20：有 origin 的派生表 → 可回填原参数重新设置，执行后直接覆盖本表（不新增表） */
    if (t.origin && t.origin.kind) {
      items.push({
        label: '修改转换设置…',
        sub: transformTitle(t.origin.kind),
        onClick: function () {
          if (!(YMS.TransformUI && YMS.TransformUI.open)) { U.toast('转换模块未加载', 'error'); return; }
          YMS.TransformUI.open(t.origin.kind, { preset: t.origin.params, targetId: t.id });
        }
      });
      items.push('-');
    }
    U.contextMenu(x, y, items.concat([
      {
        label: '设为当前', sub: isActive ? '当前表' : '', disabled: isActive,
        onClick: function () { Store.setActiveTable(t.id); }
      },
      {
        label: '重命名', sub: t.name,
        input: {
          placeholder: '新表名', value: t.name, okText: '确定',
          onConfirm: function (v) {
            var nm = Store.renameTable(t.id, v);
            if (!nm) { U.toast('重命名失败：表格不存在', 'error'); return; }
            if (nm !== String(v === undefined || v === null ? '' : v).trim()) {
              U.toast('已重命名为 <b>' + esc(nm) + '</b>（重名自动加序号）', 'warn');
            } else {
              U.toast('已重命名为 <b>' + esc(nm) + '</b>', 'ok');
            }
          }
        }
      },
      {
        label: '复制', sub: '名称加 _copy',
        onClick: function () {
          var r = Store.duplicateTable(t.id);
          if (r) U.toast('已复制为 <b>' + esc(r.name) + '</b>', 'ok');
          else U.toast('复制失败', 'error');
        }
      },
      {
        label: '导出 CSV', sub: rows ? fmtInt(rows) + ' 行' : '空表',
        onClick: function () { exportTableCsv(t); }
      },
      '-',
      {
        label: '删除', sub: '需二次确认',
        onClick: function () { confirmRemove(t); }
      }
    ]));
  }

  /** 变换操作中文名（右键子标题；TransformUI 未就绪时退化显示 kind） */
  function transformTitle(kind) {
    var t = (YMS.TransformUI && YMS.TransformUI.TITLES) ? YMS.TransformUI.TITLES[kind] : '';
    return t || String(kind || '');
  }

  /** 单击表格项 → 切表 */
  function onTableClick(e) {
    var item = e.target && e.target.closest ? e.target.closest('.tables-item') : null;
    if (!item || !_tablesList) return;
    var id = item.getAttribute('data-table-id');
    if (!id || id === Store.state.activeTableId) return;
    Store.setActiveTable(id);
  }

  /** 表格项右键 */
  function onTableContextMenu(e) {
    var item = e.target && e.target.closest ? e.target.closest('.tables-item') : null;
    if (!item) return;
    var id = item.getAttribute('data-table-id');
    var t = id ? findTable(id) : null;
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    openTableMenu(e, t);
  }

  /** 右键：交给 ColumnOps（DOM 依赖，浏览器内使用） */
  function onContextMenu(e) {
    var item = e.target && e.target.closest ? e.target.closest('.raw-item') : null;
    if (!item) return;
    var col = item.getAttribute('data-col');
    if (!col) return;
    e.preventDefault();
    e.stopPropagation();
    if (YMS.ColumnOps && YMS.ColumnOps.contextMenu) {
      YMS.ColumnOps.contextMenu(e, col);
    } else {
      U.toast('列操作模块未加载', 'error');
    }
  }

  /** 单击：高亮该参数行，并在数据显示区滚动到该列 */
  function onClick(e) {
    var item = e.target && e.target.closest ? e.target.closest('.raw-item') : null;
    if (!item || !_list) return;
    var col = item.getAttribute('data-col');
    if (!col) return;
    var items = _list.querySelectorAll('.raw-item'), i;
    for (i = 0; i < items.length; i++) {
      items[i].className = items[i].className.replace(/\s*is-active/g, '') + (items[i] === item ? ' is-active' : '');
    }
    _activeCol = col;
    scrollGridToColumn(col);
  }

  /** 在数据显示区横向滚动到对应列（直接操作 DOM，不调用其它模块） */
  function scrollGridToColumn(col) {
    try {
      var wrap = U.$('#grid-wrap');
      if (!wrap) return;
      var th = wrap.querySelector('th[data-col="' + String(col).replace(/"/g, '\\"') + '"]');
      if (!th) return;
      var left = th.offsetLeft - 60;
      wrap.scrollLeft = left > 0 ? left : 0;
    } catch (err) {
      if (global.console) global.console.error('[YMS.TableView] 滚动到列失败', err);
    }
  }

  /** 事件处理器包装：任何异常都不得逃逸到全局（硬约束：零未捕获异常） */
  function guard(name, fn) {
    return function (e) {
      try { return fn(e); } catch (err) {
        if (global.console) global.console.error('[YMS.TableView] ' + name + ' 失败', err);
      }
    };
  }

  /** 绑定事件（幂等，容器节点复用时无需重复绑定） */
  function bindEvents() {
    if (_bound || !_list || !_list.addEventListener) return;
    _list.addEventListener('contextmenu', guard('参数右键菜单', onContextMenu));
    _list.addEventListener('click', guard('参数行单击', onClick));
    _bound = true;
  }

  /** 绑定多表列表事件（点击切表 / 右键管理） */
  function bindTablesEvents() {
    if (_tablesBound || !_tablesList || !_tablesList.addEventListener) return;
    _tablesList.addEventListener('click', guard('表格单击', onTableClick));
    _tablesList.addEventListener('contextmenu', guard('表格右键菜单', onTableContextMenu));
    _tablesBound = true;
  }

  var TableView = {
    /** 初始化：缓存 DOM 并绑定事件（可重复调用） */
    init: function () {
      try {
        _name = U.$('#raw-table-name');
        _list = U.$('#raw-header-list');
        _tablesList = U.$('#tables-list');
        _tablesPanel = U.$('#tables-panel');
        _tablesCount = U.$('#tables-count');
        bindEvents();
        bindTablesEvents();
        /* 表的增删改（Store.emit('tables')）→ 只重渲染表格列表，不惊动数据网格 */
        if (!_tablesSubscribed && Store && Store.on) {
          Store.on('tables', function () {
            try { TableView.renderTables(); }
            catch (err) { if (global.console) global.console.error('[YMS.TableView] 表格列表刷新失败', err); }
          });
          _tablesSubscribed = true;
        }
      } catch (err) {
        if (global.console) global.console.error('[YMS.TableView] init 失败', err);
      }
      return this;
    },

    /** 渲染多表列表（标题计数 + 列表项 + 空态） */
    renderTables: function () {
      try {
        if (!_tablesList) _tablesList = U.$('#tables-list');
        if (!_tablesPanel) _tablesPanel = U.$('#tables-panel');
        if (!_tablesCount) _tablesCount = U.$('#tables-count');
        bindTablesEvents();
        var list = (Store && Store.tables) ? Store.tables() : [];
        if (_tablesCount) _tablesCount.textContent = '表格（' + list.length + '）';
        if (_tablesPanel && _tablesPanel.classList) _tablesPanel.classList.toggle('is-empty', !list.length);
        if (_tablesList) {
          var st = _tablesList.scrollTop;
          _tablesList.innerHTML = tablesHtml(list, Store.state.activeTableId);
          _tablesList.scrollTop = st;                     // 重建后保持滚动位置
        }
        return this;
      } catch (err) {
        if (global.console) global.console.error('[YMS.TableView] renderTables 失败', err);
        return this;
      }
    },

    /** 渲染表格名 + 参数列表（含多表列表） */
    render: function () {
      try {
        if (!_name) _name = U.$('#raw-table-name');
        if (!_list) _list = U.$('#raw-header-list');
        bindEvents();
        this.renderTables();
        var df = Store.state.df;
        if (_name) {
          _name.textContent = (df && df.cols.length) ? (Store.state.tableName || '数据表') : '—';
          _name.title = (df && df.cols.length)
            ? (Store.state.tableName || '数据表') + ' · ' + U.fmtInt(df.rowCount) + ' 行 × ' + U.fmtInt(df.cols.length) + ' 列'
            : '尚未载入数据';
        }
        if (_list) {
          _list.innerHTML = listHtml(df);
          if (_activeCol) {                                  // 保持高亮
            var hit = _list.querySelector('.raw-item[data-col="' + String(_activeCol).replace(/"/g, '\\"') + '"]');
            if (hit) hit.className += ' is-active';
          }
        }
        return this;
      } catch (err) {
        if (global.console) global.console.error('[YMS.TableView] render 失败', err);
        U.toast('原始表格区渲染失败：' + err.message, 'error');
        return this;
      }
    },

    /** 当前高亮的参数（调试用） */
    activeColumn: function () { return _activeCol; },

    /* ---- 内部纯逻辑导出（Node 自测用，不属公开契约） ---- */
    _listHtml: listHtml,
    _tablesHtml: tablesHtml,
    _treeOrder: treeOrder,
    _typeLabel: typeLabel
  };

  YMS.TableView = TableView;
})(typeof window !== 'undefined' ? window : this);
