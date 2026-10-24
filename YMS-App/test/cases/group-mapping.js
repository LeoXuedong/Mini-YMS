/* ==========================================================================
   YMS · test/cases/group-mapping.js
   断言对象：迭代 25 按值分组（Group Mapping）+ 迭代 27 面板 UI 重做
   命中代码：js/data/group-map.js（纯函数引擎，本轮未改）
             js/table/group-ui.js（面板重做：左值列表多选 + 右三列表格 + 下拉复选框）
             js/core/i18n-dict-panels.js（迭代 27 文案）
             js/table/column-ops.js（列右键入口）
             js/core/dataframe.js / store.js（Column.order / groupMap 与白名单）
             js/plot/aggregate.js（orderCategories 读 col.order）
   目标语义（6 个原有语义点全部保留 + 本轮新交互）：
     1) 12 个取值 → 4 组，派生列逐行组名正确（未分配值默认归「未分组」）
     2) 横轴顺序 = 用户在表里排的组顺序（不是字母序 / 不是出现序）
     3) 未分配值两种模式：归为「未分组」/ 保留原值
     4) 派生列能直接当 X Label / 颜色分组 / Page by
     5) .yms 往返还原映射、组名、组顺序
     6) 源数据变化：派生列是快照，重新应用才重算
     7) 新交互：左栏多选 → 点「+」自动建组并预填 → 只打组名 → 确定
     8) 新交互：一个值只能属于一个组，后加入者生效并有明确提示
   ========================================================================== */
'use strict';

const app = require('../helpers/app');

/* --------------------------------------------------------------- 夹具 */

/** Tool × Wafer × Yield 12 行（T01~T12，Yield 各不相同，便于认列） */
function csv12() {
  const rows = ['Tool,Wafer,Yield'];
  for (let i = 1; i <= 12; i++) {
    const t = 'T' + (i < 10 ? '0' + i : String(i));
    rows.push(t + ',W' + (i < 10 ? '0' + i : i) + ',' + (90 + i * 0.5).toFixed(1));
  }
  return rows.join('\n');
}

/** 1200 个不同取值（虚拟滚动 / 性能） */
function csvMany(n) {
  const rows = ['Tool,Yield'];
  for (let i = 1; i <= n; i++) {
    rows.push('TL' + String(i).padStart(4, '0') + ',' + (80 + (i % 20)).toFixed(1));
  }
  return rows.join('\n');
}

const GROUP_A = { T01: '清洗', T02: '清洗', T03: '沉积', T04: '沉积', T05: '沉积', T06: '沉积', T07: '光刻', T08: '光刻', T09: '光刻', T10: '其他' };
const ORDER_A = ['光刻', '清洗', '沉积', '其他'];
const DERIVED_12 = '清洗,清洗,沉积,沉积,沉积,沉积,光刻,光刻,光刻,其他,未分组,未分组';

/* --------------------------------------------------------------- 页面内动作 */

/** 收起可能残留的右键菜单（否则它会盖住表头，下一次右击点不到） */
async function closeMenu(page) {
  await page.evaluate(function () {
    if (window.YMS && window.YMS.util && window.YMS.util.closeContextMenu) window.YMS.util.closeContextMenu();
  });
  await page.waitForTimeout(60);
}

/** 右键列头 → 读菜单项文本 */
async function menuLabels(page, col) {
  await closeMenu(page);
  await page.click('th[data-col="' + col + '"]', { button: 'right' });
  await page.waitForTimeout(120);
  return page.evaluate(function () {
    const root = document.getElementById('context-menu-root');
    return Array.prototype.slice.call(root.querySelectorAll('.ctx-menu > .ctx-item')).map(function (n) {
      const lb = n.querySelector('.ctx-label');
      return lb ? String(lb.textContent).trim() : '';
    });
  });
}

/** 点右键菜单里包含某文本的项（DOM 直接 click，事件仍是真实 click） */
async function clickMenuItem(page, col, contains) {
  await closeMenu(page);
  await page.click('th[data-col="' + col + '"]', { button: 'right' });
  await page.waitForTimeout(120);
  return page.evaluate(function (needle) {
    const items = Array.prototype.slice.call(document.querySelectorAll('#context-menu-root .ctx-item'));
    for (const it of items) {
      const lb = it.querySelector('.ctx-label');
      if (lb && String(lb.textContent).indexOf(needle) >= 0) { it.click(); return true; }
    }
    return false;
  }, contains);
}

/** 打开面板（真实菜单入口） */
async function openDialog(page, col) {
  const ok = await clickMenuItem(page, col, '分组映射');
  await page.waitForSelector('#gm-dlg', { timeout: 5000 });
  await page.waitForTimeout(120);
  return ok;
}

/** 面板 DOM 快照 */
function snapshot(page) {
  return page.evaluate(function () {
    const q = function (s) { const n = document.querySelector(s); return n ? String(n.textContent).trim() : null; };
    const rows = Array.prototype.slice.call(document.querySelectorAll('#gm-grows .gm-grp'));
    const norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
    const act = document.activeElement;
    return {
      open: !!document.querySelector('#gm-dlg'),
      vrows: document.querySelectorAll('#gm-vals .gm-vrow').length,
      vchecks: document.querySelectorAll('#gm-vals .gm-vrow .gm-vchk').length,
      vvals: Array.prototype.slice.call(document.querySelectorAll('#gm-vals .gm-vrow .gm-vval')).map(function (n) { return String(n.textContent); }),
      vcounts: Array.prototype.slice.call(document.querySelectorAll('#gm-vals .gm-vrow .gm-cnt')).map(function (n) { return String(n.textContent).trim(); }),
      vtags: Array.prototype.slice.call(document.querySelectorAll('#gm-vals .gm-vrow .gm-vtag')).map(function (n) { return String(n.textContent).trim(); }),
      legacyInputs: document.querySelectorAll('#gm-vals .gm-in').length,
      count: q('#gm-count'),
      selCount: q('#gm-sel-count'),
      thead: Array.prototype.slice.call(document.querySelectorAll('.gm-gthead span')).map(function (n) { return String(n.textContent).trim(); }),
      src: document.getElementById('gm-src') ? document.getElementById('gm-src').value : null,
      target: document.getElementById('gm-name') ? document.getElementById('gm-name').value : null,
      groupRows: rows.length,
      names: rows.map(function (n) { const i = n.querySelector('.gm-gname'); return i ? i.value : null; }),
      params: rows.map(function (n) { const p = n.querySelector('.gm-param-vals'); return p ? norm(p.textContent) : null; }),
      upDisabled: rows.map(function (n) { const b = n.querySelector('.gm-up'); return !!b && b.disabled; }),
      downDisabled: rows.map(function (n) { const b = n.querySelector('.gm-down'); return !!b && b.disabled; }),
      emptyHint: !!document.getElementById('gm-rows-empty'),
      preview: q('#gm-preview'),
      other: document.getElementById('gm-unassigned-other') ? document.getElementById('gm-unassigned-other').checked : null,
      raw: document.getElementById('gm-unassigned-raw') ? document.getElementById('gm-unassigned-raw').checked : null,
      err: q('#gm-err'),
      errOn: !!document.querySelector('#gm-err.is-on'),
      msg: q('#gm-msg'),
      msgOn: !!document.querySelector('#gm-msg.is-on'),
      focusCls: act ? String(act.className) : '',
      focusIndex: act && act.getAttribute ? act.getAttribute('data-index') : null,
      focusValue: act && act.tagName === 'INPUT' ? act.value : null
    };
  });
}

/** 面板状态（GroupUI.state：rows 里的 values 是真实数据，不是 DOM 摘要） */
function gmState(page) {
  return page.evaluate(function () { return window.YMS.GroupUI.state(); });
}

/** 勾选 / 取消左栏若干值（真实 click → change 事件） */
async function setTick(page, values, on) {
  return page.evaluate(function (a) {
    const missing = [];
    a.values.forEach(function (v) {
      const cb = document.querySelector('.gm-vchk[data-value="' + v + '"]');
      if (!cb) { missing.push(v); return; }
      if (cb.checked !== a.on) cb.click();
    });
    return missing;
  }, { values: values, on: on });
}

/** 点「+ 新增分组」 */
async function addGroup(page) {
  await page.click('#gm-add');
  await page.waitForTimeout(80);
}

/** 打组名 */
async function nameGroup(page, idx, name) {
  await page.fill('.gm-grp[data-index="' + idx + '"] .gm-gname', name);
  await page.waitForTimeout(60);
}

/** 关闭已展开的下拉复选框（只在确实打开时按 Esc，避免误关对话框） */
async function closePanel(page) {
  const open = await page.evaluate(function () { return !!document.querySelector('#gm-param-panel.is-open'); });
  if (open) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
}

/** 打开某一行的 Group Parameter 下拉复选框 */
async function openParam(page, idx) {
  await closePanel(page);
  await page.click('.gm-grp[data-index="' + idx + '"] .gm-param-trigger');
  await page.waitForTimeout(140);
}

/** 下拉复选框面板快照 */
function panelState(page) {
  return page.evaluate(function () {
    const p = document.getElementById('gm-param-panel');
    if (!p) return { exists: false };
    const opts = p.querySelectorAll('.gm-param-opt');
    const cnt = p.querySelector('.gm-param-count');
    return {
      exists: true,
      open: p.classList.contains('is-open'),
      inBody: p.parentNode === document.body,
      insideDialog: !!p.closest('#gm-dlg'),
      count: opts.length,
      checked: Array.prototype.slice.call(p.querySelectorAll('.gm-param-chk'))
        .filter(function (c) { return c.checked; })
        .map(function (c) { return c.getAttribute('data-value'); }),
      countText: cnt ? String(cnt.textContent).trim() : null,
      text: String(p.textContent || '').replace(/\s+/g, ' ').trim()
    };
  });
}

/** 在面板里点某个值的复选框 */
async function toggleParam(page, value) {
  await page.click('#gm-param-panel .gm-param-opt[data-value="' + value + '"] .gm-param-chk');
  await page.waitForTimeout(120);
}

/** 逐行读某列（显示文本） */
function colValues(page, name) {
  return page.evaluate(function (n) {
    const df = window.YMS.Store.state.df;
    const ci = df.colIndex(n);
    if (ci < 0) return null;
    const out = [];
    for (let r = 0; r < df.rowCount; r++) out.push(df.cell(ci, r));
    return out;
  }, name);
}

/** 列元数据（order / groupMap / type） */
function colMeta(page, name) {
  return page.evaluate(function (n) {
    const df = window.YMS.Store.state.df;
    const c = df.col(n);
    if (!c) return null;
    return {
      order: c.order ? c.order.slice() : null,
      groupMap: c.groupMap ? JSON.parse(JSON.stringify(c.groupMap)) : null,
      type: c.type
    };
  }, name);
}

/** 退出面板（点取消） */
async function cancelDialog(page) {
  await page.evaluate(function () {
    const btns = Array.prototype.slice.call(document.querySelectorAll('.modal-foot .btn'));
    const b = btns.filter(function (x) { return String(x.textContent).indexOf('取消') >= 0; })[0];
    if (b) b.click();
  });
  await page.waitForTimeout(150);
}

/* --------------------------------------------------------------- 用例 */

module.exports = {
  id: 'group-mapping',
  title: '迭代 25/27 按值分组（Group Mapping）+ 面板 UI 重做 + 横轴分组依据',
  async run(ctx) {
    const page = ctx.page, t = ctx.t;

    /* ==================================================================
       1. 入口 + 新面板骨架（左值列表 / 右三列表格）
       ================================================================== */
    const imp = await app.importText(page, 'group12.csv', csv12());
    t.eq('1.1 导入 12 行 × 3 列', imp.rows + 'x' + imp.cols, '12x3');

    const labels = await menuLabels(page, 'Tool');
    t.ok('1.2 列右键菜单含「分组映射…」', labels.some(function (x) { return x.indexOf('分组映射') >= 0; }), labels);
    t.ok('1.3 与「参数属性」「数据计算」同级（同一层出现）',
      labels.indexOf('参数属性') >= 0 && labels.some(function (x) { return x.indexOf('数据计算') >= 0; }), labels);

    await openDialog(page, 'Tool');
    let d = await snapshot(page);
    t.eq('1.4 面板已打开', d.open, true);
    t.eq('1.5 左栏自动列出该列 12 个不同值', d.vrows, 12);
    t.eq('1.6 每个值前都有复选框（12 个）', d.vchecks, 12);
    t.eq('1.7 每个值后显示「N 行」权重（首行）', d.vcounts[0], '1 行');
    t.contains('1.8 计数文案含「共 12 个不同值」', d.count, '共 12 个不同值');
    t.eq('1.9 右表三列表头 = # / Group Name / Group Parameter',
      d.thead.join('|'), '#|Group Name|Group Parameter|');
    t.eq('1.10 初始没有分组行', d.groupRows, 0);
    t.eq('1.11 空态提示存在（引导勾选后点 +）', d.emptyHint, true);
    t.eq('1.12 旧版「每个值一个输入框」已彻底移除（.gm-in = 0）', d.legacyInputs, 0);
    t.eq('1.13 源列默认 = 右键的那一列（Tool）', d.src, 'Tool');
    t.eq('1.14 新列名默认 = Tool_Group', d.target, 'Tool_Group');
    t.eq('1.15 未分配值默认「归为未分组」', d.other, true);
    t.eq('1.16 默认不选「保留原值」', d.raw, false);
    t.eq('1.17 左栏初始未勾选任何值', d.selCount, '未勾选任何值');

    /* ==================================================================
       2. 核心链路：多选 → 点 + → 自动建组并预填 → key 组名
       ================================================================== */
    let miss = await setTick(page, ['T01', 'T02'], true);
    t.eq('2.1 勾选 T01 / T02 均命中（无缺失）', miss.length, 0);
    d = await snapshot(page);
    t.eq('2.2 勾选计数文案 = 已勾选 2 个值', d.selCount, '已勾选 2 个值');

    await addGroup(page);
    let st = await gmState(page);
    t.eq('2.3 点「+ 新增分组」→ 右侧新增 1 行分组', st.rows.length, 1);
    t.eq('2.4 新行 Group Name 为空（等用户命名）', st.rows[0].name, '');
    t.eq('2.5 Group Parameter 已自动预填所选值', st.rows[0].values.join(','), 'T01,T02');
    d = await snapshot(page);
    t.contains('2.6 触发器摘要含 T01、T02 与「2 项」',
      d.params[0], 'T01, T02');
    t.contains('2.6b 触发器摘要带项数', d.params[0], '2 项');
    t.eq('2.7 光标自动落进新行的 Group Name 输入框', d.focusCls, 'gm-gname');
    t.eq('2.8 光标落在第 1 行（data-index=0）', d.focusIndex, '0');
    t.eq('2.9 新行输入框为空（只差打一个组名）', d.focusValue, '');
    t.eq('2.10 建组成功后左栏勾选被清空', d.selCount, '未勾选任何值');
    t.eq('2.11 左栏勾选态同步清掉（.is-on 行数）',
      await page.evaluate(function () { return document.querySelectorAll('#gm-vals .gm-vrow.is-on').length; }), 0);

    await nameGroup(page, 0, '清洗');
    d = await snapshot(page);
    t.eq('2.12 输入组名后行 data-group = 清洗',
      await page.evaluate(function () { return document.querySelector('.gm-grp[data-index="0"]').getAttribute('data-group'); }), '清洗');
    t.eq('2.13 左栏 T01/T02 出现归属标签「清洗」', d.vtags.join(','), '清洗,清洗');
    t.eq('2.14 打组名没有重建左栏（仍是 12 行）', d.vrows, 12);

    /* 其余 3 组：同样「多选 → + → 打名字」 */
    await setTick(page, ['T03', 'T04', 'T05', 'T06'], true);
    await addGroup(page);
    await nameGroup(page, 1, '沉积');
    await setTick(page, ['T07', 'T08', 'T09'], true);
    await addGroup(page);
    await nameGroup(page, 2, '光刻');
    await setTick(page, ['T10'], true);
    await addGroup(page);
    await nameGroup(page, 3, '其他');

    st = await gmState(page);
    d = await snapshot(page);
    t.eq('2.15 12 个值分成 4 组（行数 = 4）', st.rows.length, 4);
    t.eq('2.16 组名 = 清洗/沉积/光刻/其他', st.rows.map(function (r) { return r.name; }).join('|'), '清洗|沉积|光刻|其他');
    t.eq('2.17 每组参数个数 = 2/4/3/1',
      st.rows.map(function (r) { return r.values.length; }).join('|'), '2|4|3|1');
    t.eq('2.18 已归组值合计 = 10（T11/T12 未分配）',
      st.rows.reduce(function (n, r) { return n + r.values.length; }, 0), 10);
    t.eq('2.19 效率：12 个取值只需 4 次「组名输入」（组数 < 取值数）',
      st.rows.length < st.values, true);
    t.eq('2.20 左栏 10 个值已有归属标签、2 个没有',
      d.vtags.length, 10);

    /* ==================================================================
       3. 组顺序 = 横轴顺序（↑ / ↓ 移动）
       ================================================================== */
    t.eq('3.1 首行「↑」禁用（不能上移到表外）', d.upDisabled[0], true);
    t.eq('3.2 末行「↓」禁用', d.downDisabled[3], true);
    await page.click('.gm-grp[data-group="光刻"] .gm-up');
    await page.click('.gm-grp[data-group="光刻"] .gm-up');
    await page.waitForTimeout(100);
    st = await gmState(page);
    t.eq('3.3 上移两次后组顺序 = 光刻/清洗/沉积/其他',
      st.rows.map(function (r) { return r.name; }).join('|'), ORDER_A.join('|'));
    t.ok('3.4 该顺序 ≠ 字母（码点）序', ORDER_A.join('|') !== ORDER_A.slice().sort().join('|'), ORDER_A);
    const kr = st.rows.filter(function (r) { return r.name === '光刻'; })[0];
    t.eq('3.5 移动后组内参数跟着走（光刻仍是 T07-T09）', kr.values.join(','), 'T07,T08,T09');

    /* ==================================================================
       4. Group Parameter 下拉复选框
       ================================================================== */
    await openParam(page, 0);       /* 第 1 行 = 光刻（上移两次后排在首位） */
    let p = await panelState(page);
    t.eq('4.1 点触发器打开下拉复选框面板', p.open, true);
    t.ok('4.2 面板挂在 body 上（项目浮层规矩，不在对话框 DOM 里）', p.inBody && !p.insideDialog, { inBody: p.inBody, insideDialog: p.insideDialog });
    /* 迭代 29：下拉只列「本组自己的 + 未被任何组占用」的值 */
    const g4 = await gmState(page);
    const litRow = g4.rows.filter(function (r) { return r.name === '光刻'; })[0];
    const availVals = await page.evaluate(function () {
      const p2 = document.getElementById('gm-param-panel');
      if (!p2) return [];
      return Array.prototype.slice.call(p2.querySelectorAll('.gm-param-opt'))
        .map(function (n) { return n.getAttribute('data-value'); });
    });
    const ownedByOthers = [];
    g4.rows.forEach(function (r) {
      if (r === litRow) return;
      for (let vi = 0; vi < r.values.length; vi++) ownedByOthers.push(r.values[vi]);
    });
    const allVals4 = await page.evaluate(function () {
      return Array.prototype.slice.call(document.querySelectorAll('.gm-vchk'))
        .map(function (n) { return n.getAttribute('data-value'); });
    });
    const freeVals = allVals4.filter(function (v) {
      return !g4.rows.some(function (r) { return r.values.indexOf(v) >= 0; });
    });
    const expectAvail = litRow.values.concat(freeVals).sort().join(',');
    t.eq('4.3 面板选项 = 本组已选 + 未被任何组占用的值', availVals.slice().sort().join(','), expectAvail);
    t.eq('4.4 已勾选的正好是该组的 3 个值', p.checked.join(','), 'T07,T08,T09');
    t.contains('4.5 面板底部计数 = 已选 3 项', p.countText, '已选 3 项');
    t.eq('4.5b 面板中不含任何其它组已占用的值（泄漏 0 个）',
      availVals.filter(function (v) { return ownedByOthers.indexOf(v) >= 0; }).join(','), '');

    const expectT1 = availVals.filter(function (v) { return String(v).toLowerCase().indexOf('t1') >= 0; }).length;
    await page.fill('.gm-param-search', 'T1');
    await page.waitForTimeout(120);
    p = await panelState(page);
    t.eq('4.6 搜索 T1 → 只剩可用值里匹配的 ' + expectT1 + ' 个（其它组的已被排除）', p.count, expectT1);
    await page.fill('.gm-param-search', '');
    await page.waitForTimeout(120);
    p = await panelState(page);
    t.eq('4.7 清空搜索 → 回到全部可用值 ' + availVals.length + ' 个', p.count, availVals.length);

    /* 别的组的值在下拉里**根本不存在**，不再是「勾了之后静默从别组搬走」 */
    const hasOther0 = await page.evaluate(function (v) {
      return !!document.querySelector('#gm-param-panel .gm-param-opt[data-value="' + v + '"]');
    }, ownedByOthers[0]);
    t.eq('4.8 下拉中不存在其它组的值 ' + ownedByOthers[0] + '（只列目前可分给本组的值）', hasOther0, false);

    /* 取消勾选本组一个值 → 它回到未分配 → 仍可被本组重新勾回 */
    await toggleParam(page, 'T07');
    st = await gmState(page);
    const g4lit = st.rows.filter(function (r) { return r.name === '光刻'; })[0];
    t.eq('4.9 取消勾选 T07 → 光刻剩 2 个值', g4lit.values.length, 2);
    p = await panelState(page);
    t.eq('4.10 取消后 T07 回到未分配 → 面板可用值数量不变', p.count, availVals.length);
    t.eq('4.11 此时已勾选 2 项', p.checked.join(','), 'T08,T09');

    /* 勾回 T07，恢复原配方 */
    await toggleParam(page, 'T07');
    st = await gmState(page);
    t.eq('4.12 勾回 T07 → 光刻恢复 3 个值（T07,T08,T09）',
      st.rows.filter(function (r) { return r.name === '光刻'; })[0].values.join(','), 'T07,T08,T09');
    t.ok('4.13 全程未影响其它组（T01 仍在「清洗」）',
      st.rows.filter(function (r) { return r.name === '清洗'; })[0].values.indexOf('T01') >= 0,
      st.rows.filter(function (r) { return r.name === '清洗'; })[0].values);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);

    p = await panelState(page);
    t.eq('4.14 Esc 先关浮层（面板已收起）', p.open === true, false);
    t.eq('4.15 Esc 不连带关掉对话框（第二次 Esc 才关）',
      await page.evaluate(function () { return !!document.getElementById('gm-dlg'); }), true);
    t.eq('4.16 关闭后浮层节点已从 body 移除（不留残影）', p.exists, false);

    await openParam(page, 1);
    await page.mouse.click(760, 46);      /* 点面板外的空白处 */
    await page.waitForTimeout(140);
    p = await panelState(page);
    t.eq('4.17 点面板外只收面板', p.open === false || p.exists === false, true);
    t.eq('4.18 点面板外不关对话框',
      await page.evaluate(function () { return !!document.getElementById('gm-dlg'); }), true);

    /* ==================================================================
       5. 一个值勾进两组的冲突处理（后加入者生效 + 明确提示）
       ================================================================== */
    st = await gmState(page);
    const before5 = st.rows.map(function (r) { return r.name + ':' + r.values.length; }).join(',');
    miss = await setTick(page, ['T05'], true);
    t.eq('5.1 勾选 T05（它此刻属于「沉积」）', miss.length, 0);
    await addGroup(page);
    st = await gmState(page);
    d = await snapshot(page);
    t.ok('5.2 建出第 5 行且预填 T05',
      st.rows.length === 5 && st.rows[4].values.join(',') === 'T05', st.rows);
    t.contains('5.3 提示条写明从「沉积」移到新分组', d.msg, '沉积');
    t.contains('5.3b 提示条含「移到新分组」', d.msg, '移到新分组');
    t.eq('5.4 沉积组只剩 3 个值（T03/T04/T06）',
      st.rows.filter(function (r) { return r.name === '沉积'; })[0].values.join(','), 'T03,T04,T06');
    /* 无命名 + 有值 → 确定时报错（第 5 行还没有组名） */
    await page.click('.modal-foot .btn-primary');
    await page.waitForTimeout(140);
    d = await snapshot(page);
    t.eq('5.5 有值没组名 → 面板不关', d.open, true);
    t.contains('5.6 报错指明是第几个分组缺组名', d.err, '第 5 个分组还没有组名');
    /* 删掉这一行 */
    await page.click('.gm-grp[data-index="4"] .gm-del');
    await page.waitForTimeout(100);
    st = await gmState(page);
    t.eq('5.7 删除该行 → 行数回到 4', st.rows.length, 4);
    t.eq('5.8 删除后 T05 不属于任何组（不会同时留在两组）',
      st.rows.reduce(function (acc, r) { return acc.concat(r.values); }, []).filter(function (v) { return v === 'T05'; }).length, 0);
    /* 用面板把 T05 放回沉积 */
    await openParam(page, 2);
    await toggleParam(page, 'T05');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    st = await gmState(page);
    t.eq('5.9 用下拉复选框把 T05 放回「沉积」（恢复 4 个值）',
      st.rows.filter(function (r) { return r.name === '沉积'; })[0].values.join(','), 'T03,T04,T05,T06');
    const allVals = st.rows.reduce(function (acc, r) { return acc.concat(r.values); }, []);
    t.eq('5.10 任一取值最多只出现在一个组（总数 = 去重数）',
      allVals.length, Array.from(new Set(allVals)).length);
    t.eq('5.11 组名唯一（提交前 groups 无重复）',
      st.rows.map(function (r) { return r.name; }).length,
      Array.from(new Set(st.rows.map(function (r) { return r.name; }))).length);

    /* ==================================================================
       6. 未分配值两模式 + 预览 + 确定
       ================================================================== */
    d = await snapshot(page);
    t.contains('6.1 默认预览：第 1 行 T01 → 清洗', d.preview, 'T01→清洗');
    t.eq('6.2 预览只显示前 5 行（T06 不出现）', String(d.preview).indexOf('T06') < 0, true);

    /* 让 T03~T06 回到未分配，才能在前 5 行里看到「未分组 / 原值」两种表现 */
    await page.click('.gm-grp[data-group="沉积"] .gm-del');
    await page.waitForTimeout(140);
    d = await snapshot(page);
    t.contains('6.3 删掉「沉积」后，未分配的 T03 在预览里显示为「未分组」', d.preview, 'T03→未分组');
    await page.click('#gm-unassigned-raw');
    await page.waitForTimeout(140);
    d = await snapshot(page);
    t.contains('6.4 切「保留原值」→ 预览 T03 显示原值 T03', d.preview, 'T03→T03');
    await page.click('#gm-unassigned-other');
    await page.waitForTimeout(140);
    d = await snapshot(page);
    t.contains('6.5 切回「归为未分组」→ 预览恢复「未分组」', d.preview, 'T03→未分组');

    /* 恢复 沉积 组（并移回原位置，保证组顺序与 ORDER_A 一致） */
    await setTick(page, ['T03', 'T04', 'T05', 'T06'], true);
    await addGroup(page);
    await nameGroup(page, 3, '沉积');
    await page.click('.gm-grp[data-group="沉积"] .gm-up');
    await page.waitForTimeout(120);
    st = await gmState(page);
    t.eq('6.6 重新建组并上移后顺序恢复 = 光刻/清洗/沉积/其他',
      st.rows.map(function (r) { return r.name; }).join('|'), ORDER_A.join('|'));
    t.eq('6.7 沉积组参数恢复为 4 个值',
      st.rows.filter(function (r) { return r.name === '沉积'; })[0].values.join(','), 'T03,T04,T05,T06');

    await page.click('.modal-foot .btn-primary');
    await page.waitForTimeout(300);
    d = await snapshot(page);
    t.eq('6.8 确定后面板关闭', d.open, false);
    t.eq('6.9 确定后浮层没有残留', await page.evaluate(function () { return !document.getElementById('gm-param-panel'); }), true);

    /* ==================================================================
       7. 派生列与横轴（分组顺序 → 横轴顺序）
       ================================================================== */
    const st1 = await app.getState(page);
    t.eq('7.1 新列追加到表尾', st1.columns.map(function (c) { return c.name; }).join('|'), 'Tool|Wafer|Yield|Tool_Group');
    const vals = await colValues(page, 'Tool_Group');
    t.eq('7.2 新列 12 行全部有值', vals.length, 12);
    t.eq('7.3 逐行组名（T01~T12 拼接）', vals.join(','), DERIVED_12);
    const meta1 = await colMeta(page, 'Tool_Group');
    t.eq('7.4 派生列类型 = 字符', meta1.type, 'string');
    t.eq('7.5 列上的 order = 组顺序 + 未分组', meta1.order.join('|'), '光刻|清洗|沉积|其他|未分组');
    t.eq('7.6 列上的 groupMap.sourceCol = Tool', meta1.groupMap.sourceCol, 'Tool');
    t.eq('7.7 列上的 groupMap.groups = 用户顺序', meta1.groupMap.groups.join('|'), ORDER_A.join('|'));
    t.eq('7.8 列上的 groupMap.map 条目数 = 10（T11/T12 未分配）', Object.keys(meta1.groupMap.map).length, 10);
    t.eq('7.9 映射未污染源列（Tool 值不变）', (await colValues(page, 'Tool')).join(','),
      'T01,T02,T03,T04,T05,T06,T07,T08,T09,T10,T11,T12');
    t.ok('7.10 处理说明记录了组顺序',
      st1.processingNotes.some(function (n) { return n.indexOf('分组映射') >= 0 && n.indexOf('光刻 → 清洗 → 沉积 → 其他') >= 0; }),
      st1.processingNotes);

    await page.evaluate(function () { window.__YMS__.setMode('plot'); });
    await page.evaluate(function () {
      window.__YMS__.applyPlot({
        type: 'bar', x: ['Tool_Group'], values: ['Yield'], sorters: [], splitBy: [], pageBy: [], display: 'facet'
      });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(600);
    let axis = await page.evaluate(function () { return window.__YMS__.xAxisData(0); });
    t.ok('7.11 图已建出且 xAxis 为类目轴', !!axis && axis.type === 'category', axis);
    t.eq('7.12 xAxis.data = 用户定义的组顺序', axis.data.join('|'), '光刻|清洗|沉积|其他|未分组');
    const sortedZip = ['光刻', '清洗', '沉积', '其他', '未分组'].slice().sort().join('|');
    t.ok('7.13 顺序 ≠ 字母（码点）序', axis.data.join('|') !== sortedZip, { actual: axis.data.join('|'), sorted: sortedZip });

    /* 换一个更「不巧」的顺序：沉积 → 其他 → 光刻 → 清洗 */
    const r2 = await page.evaluate(function (spec) {
      return window.__YMS__.groupMap.apply(spec);
    }, {
      sourceCol: 'Tool', targetCol: 'Tool_Group',
      groups: ['沉积', '其他', '光刻', '清洗'], map: GROUP_A,
      unassigned: 'other', otherLabel: '未分组'
    });
    t.eq('7.14 改顺序后仍是原地更新（不产生 Tool_Group (2)）', r2.action, 'updated');
    await page.evaluate(function () { window.__YMS__.submitPlot({}); });
    await page.waitForTimeout(400);
    axis = await page.evaluate(function () { return window.__YMS__.xAxisData(0); });
    t.eq('7.15 横轴立即跟随新顺序', axis.data.join('|'), '沉积|其他|光刻|清洗|未分组');

    /* 显式 Sorter 优先 */
    await page.evaluate(function () {
      window.__YMS__.applyPlot({ sorters: [{ col: 'Yield', dir: 'desc' }] });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(400);
    const axisSorted = await page.evaluate(function () { return window.__YMS__.xAxisData(0); });
    t.ok('7.16 配置 Sorter 时 Sorter 优先于组顺序', axisSorted.data.join('|') !== axis.data.join('|'),
      { withSorter: axisSorted.data.join('|'), withoutSorter: axis.data.join('|') });
    await page.evaluate(function () {
      window.__YMS__.applyPlot({ sorters: [] });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(300);

    /* 颜色分组 / Page by（零改动通路） */
    await page.evaluate(function () {
      window.__YMS__.applyPlot({ type: 'bar', x: ['Tool_Group'], values: ['Yield'], group: { colorBy: 'Tool_Group', symbolBy: '', colors: {} } });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(400);
    const agg4 = await page.evaluate(function () {
      const w = window.YMS.Aggregate.build();
      const f = w && w.pages[0] && w.pages[0].facets[0];
      return {
        catCount: f ? f.cats.length : -1,
        groups: f && f.groups ? f.groups.map(function (g) { return g.label; }) : null
      };
    });
    t.eq('7.17 分组列可作颜色分组列（series 组数 = 5）', agg4.groups ? agg4.groups.length : -1, 5);
    t.eq('7.18 颜色分组的标签集合 = 组名 + 未分组',
      (agg4.groups || []).slice().sort().join('|'), ['光刻', '清洗', '沉积', '其他', '未分组'].sort().join('|'));
    await page.evaluate(function () {
      window.__YMS__.applyPlot({ group: { colorBy: '', symbolBy: '', colors: {} }, pageBy: ['Tool_Group'] });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(400);
    const aggPage = await page.evaluate(function () { return window.__YMS__.aggregateWork(); });
    t.eq('7.19 分组列可作 Page by（页数 = 5）', aggPage.pages.length, 5);
    await page.evaluate(function () {
      window.__YMS__.applyPlot({ pageBy: [], display: 'facet' });
      window.__YMS__.submitPlot({});
    });
    await page.waitForTimeout(300);

    /* ==================================================================
       8. 未分配值「保留原值」模式的列内容与横轴
       ================================================================== */
    const raw = await page.evaluate(function (spec) {
      const r = window.__YMS__.groupMap.apply(spec);
      window.__YMS__.submitPlot({});
      return r;
    }, {
      sourceCol: 'Tool', targetCol: 'Tool_Group', groups: ORDER_A, map: GROUP_A,
      unassigned: 'raw', otherLabel: '未分组'
    });
    await page.waitForTimeout(400);
    t.eq('8.1 「保留原值」模式的 order 尾部是两个原值', raw.order.slice(-2).join('|'), 'T11|T12');
    const valsRaw = await colValues(page, 'Tool_Group');
    t.eq('8.2 未分配行写成原值 T11 / T12', valsRaw.slice(10).join('|'), 'T11|T12');
    t.eq('8.3 已分组行不受影响', valsRaw.slice(0, 2).join('|'), '清洗|清洗');
    axis = await page.evaluate(function () { return window.__YMS__.xAxisData(0); });
    t.eq('8.4 图上类目 = 组 + 原值（无「未分组」）', axis.data.join('|'), '光刻|清洗|沉积|其他|T11|T12');
    t.ok('8.5 「保留原值」模式图上不再有「未分组」', axis.data.indexOf('未分组') < 0, axis.data);

    /* 恢复默认模式，供后续断言 */
    await page.evaluate(function (spec) { window.__YMS__.groupMap.apply(spec); }, {
      sourceCol: 'Tool', targetCol: 'Tool_Group', groups: ORDER_A, map: GROUP_A,
      unassigned: 'other', otherLabel: '未分组'
    });
    await page.evaluate(function () { window.__YMS__.submitPlot({}); });
    await page.waitForTimeout(300);

    /* ==================================================================
       9. .yms 往返（列级白名单没过滤掉 order / groupMap）
       ================================================================== */
    const rt = await page.evaluate(async function () {
      const saved = window.__YMS__.saveYms();
      const specCol = saved.tables[0].columns.filter(function (c) { return c.name === 'Tool_Group'; })[0];
      const r = await window.__YMS__.loadYms(JSON.parse(JSON.stringify(saved)));
      const c = window.YMS.Store.state.df.col('Tool_Group');
      return {
        loaded: !!r,
        savedHasOrder: !!(specCol && specCol.order),
        savedHasMap: !!(specCol && specCol.groupMap),
        savedMapKeys: specCol && specCol.groupMap ? Object.keys(specCol.groupMap.map).length : -1,
        order: c ? c.order.slice() : null,
        groups: c && c.groupMap ? c.groupMap.groups.slice() : null,
        mapKeys: c && c.groupMap ? Object.keys(c.groupMap.map).length : -1,
        unassigned: c && c.groupMap ? c.groupMap.unassigned : null,
        otherLabel: c && c.groupMap ? c.groupMap.otherLabel : null,
        cells: (function () {
          const df = window.YMS.Store.state.df, ci = df.colIndex('Tool_Group'), out = [];
          for (let i = 0; i < df.rowCount; i++) out.push(df.cell(ci, i));
          return out;
        })(),
        columns: window.__YMS__.getState().columns.map(function (x) { return x.name; })
      };
    });
    t.eq('9.1 保存的 .yms 列定义含 order', rt.savedHasOrder, true);
    t.eq('9.2 保存的 .yms 列定义含 groupMap', rt.savedHasMap, true);
    t.eq('9.3 保存的 map 条目 = 10', rt.savedMapKeys, 10);
    t.eq('9.4 载入成功', rt.loaded, true);
    t.eq('9.5 载入后 order 逐字还原', (rt.order || []).join('|'), '光刻|清洗|沉积|其他|未分组');
    t.eq('9.6 载入后 groups（组名 + 顺序）还原', (rt.groups || []).join('|'), ORDER_A.join('|'));
    t.eq('9.7 载入后 map 条目仍是 10（白名单没丢字段）', rt.mapKeys, 10);
    t.eq('9.8 载入后 unassigned 模式还原', rt.unassigned, 'other');
    t.eq('9.9 载入后 otherLabel 还原', rt.otherLabel, '未分组');
    t.eq('9.10 载入后逐行组名一致', rt.cells.join(','), DERIVED_12);
    t.eq('9.11 载入后列数 = 4', rt.columns.length, 4);

    const bad = await page.evaluate(async function () {
      const saved = window.__YMS__.saveYms();
      const col = saved.tables[0].columns.filter(function (c) { return c.name === 'Tool_Group'; })[0];
      col.order = ['光刻', '清洗'];
      col.groupMap.evil = 'x';                         /* 未登记字段 */
      col.groupMap.map = { T01: 123, T02: '清洗' };     /* 非字符串值 → 丢弃 */
      col.groupMap.unassigned = 'nope';                /* 非法枚举 → 回落 other */
      const r = await window.__YMS__.loadYms(JSON.parse(JSON.stringify(saved)));
      const c = window.YMS.Store.state.df.col('Tool_Group');
      return {
        loaded: !!r,
        order: c.order.slice(),
        groups: c.groupMap.groups.slice(),
        mapKeys: Object.keys(c.groupMap.map).length,
        mapT02: c.groupMap.map['T02'],
        hasEvil: Object.prototype.hasOwnProperty.call(c.groupMap, 'evil'),
        unassigned: c.groupMap.unassigned
      };
    });
    t.eq('9.12 带脏字段的模板仍能载入（不抛异常）', bad.loaded, true);
    t.eq('9.13 合法 order 保留', bad.order.join('|'), '光刻|清洗');
    t.eq('9.14 groups 不受 map 脏值影响', bad.groups.join('|'), ORDER_A.join('|'));
    t.eq('9.15 非法 map 值被丢弃（只剩合法的那条）', bad.mapKeys, 1);
    t.eq('9.16 合法映射值保留', bad.mapT02, '清洗');
    t.eq('9.17 未登记字段 evil 被丢弃', bad.hasEvil, false);
    t.eq('9.18 非法 unassigned 回落 other', bad.unassigned, 'other');

    /* ==================================================================
       10. 源数据变化策略：派生列是快照，重新应用才重算
       ================================================================== */
    await app.importText(page, 'group12.csv', csv12());
    await page.evaluate(function (spec) { window.__YMS__.groupMap.apply(spec); }, {
      sourceCol: 'Tool', targetCol: 'Tool_Group', groups: ORDER_A, map: GROUP_A,
      unassigned: 'other', otherLabel: '未分组'
    });
    const before10 = await colValues(page, 'Tool_Group');
    const changed = await page.evaluate(function () {
      const df = window.YMS.Store.state.df;
      df.setCell(df.colIndex('Tool'), 0, 'T12');       /* 源列第 1 行 T01 → T12 */
      window.YMS.Store.replaceDataFrame(df);
      return {
        src: df.cell(df.colIndex('Tool'), 0),
        derived: df.cell(df.colIndex('Tool_Group'), 0)
      };
    });
    t.eq('10.1 源列第 1 行已改成 T12', changed.src, 'T12');
    t.eq('10.2 派生列保持旧值（快照语义，不自动重算）', changed.derived, before10[0]);
    const reapplied = await page.evaluate(function (spec) {
      const r = window.__YMS__.groupMap.apply(spec);
      return {
        r: r,
        cell0: window.YMS.Store.state.df.cell(window.YMS.Store.state.df.colIndex('Tool_Group'), 0),
        note: window.__YMS__.getState().processingNotes.slice(-1)[0]
      };
    }, {
      sourceCol: 'Tool', targetCol: 'Tool_Group', groups: ORDER_A, map: GROUP_A,
      unassigned: 'other', otherLabel: '未分组'
    });
    t.eq('10.3 重新应用映射 → 走「更新」而非新建列', reapplied.r.action, 'updated');
    t.eq('10.4 重算后第 1 行变成新取值对应的「未分组」', reapplied.cell0, '未分组');
    t.contains('10.5 更新写进处理说明', reapplied.note, '更新列 Tool_Group');
    t.eq('10.6 列数没有膨胀（仍是 4 列）', (await app.getState(page)).colCount, 4);

    /* ==================================================================
       11. 重开面板：已有配方还原成「行 + 参数」（修改分组映射…）
       ================================================================== */
    /* 先把源数据与派生列恢复到干净状态（§10 改过源列第 1 行） */
    await app.importText(page, 'group12.csv', csv12());
    await page.evaluate(function (spec) { window.__YMS__.groupMap.apply(spec); }, {
      sourceCol: 'Tool', targetCol: 'Tool_Group', groups: ORDER_A, map: GROUP_A,
      unassigned: 'other', otherLabel: '未分组'
    });
    await page.waitForTimeout(150);

    const relabels = await menuLabels(page, 'Tool_Group');
    t.ok('11.1 派生列右键菜单项为「修改分组映射…」',
      relabels.some(function (x) { return x.indexOf('修改分组映射') >= 0; }), relabels);
    const reopened = await clickMenuItem(page, 'Tool_Group', '修改分组映射');
    t.eq('11.2 从派生列打开面板成功', reopened, true);
    await page.waitForSelector('#gm-dlg', { timeout: 5000 });
    await page.waitForTimeout(150);
    st = await gmState(page);
    t.eq('11.3 组行数还原 = 4', st.rows.length, 4);
    t.eq('11.4 组名与顺序还原', st.rows.map(function (r) { return r.name; }).join('|'), ORDER_A.join('|'));
    t.eq('11.5 每行 Group Parameter 还原（清洗 = T01,T02）',
      st.rows.filter(function (r) { return r.name === '清洗'; })[0].values.join(','), 'T01,T02');
    d = await snapshot(page);
    t.eq('11.6 目标列名回填 = Tool_Group', d.target, 'Tool_Group');
    t.eq('11.7 源列回填 = Tool', d.src, 'Tool');
    t.contains('11.8 预览按还原后的映射显示', d.preview, 'T01→清洗');

    /* ==================================================================
       12. 搜索 / 全选 / 批量规则 / 校验 / 取消
       ================================================================== */
    await page.fill('#gm-search', 'T1');
    await page.waitForTimeout(120);
    d = await snapshot(page);
    t.eq('12.1 左栏搜索 T1 → 只剩 T10/T11/T12', d.vrows, 3);
    t.contains('12.2 搜索时计数提示匹配数', d.count, '匹配 3 个');
    await page.fill('#gm-search', '');
    await page.waitForTimeout(120);
    d = await snapshot(page);
    t.eq('12.3 清空搜索 → 恢复 12 行', d.vrows, 12);

    await page.click('#gm-sel-all');
    await page.waitForTimeout(100);
    d = await snapshot(page);
    t.eq('12.4 全选 → 12 个值全勾上', d.selCount, '已勾选 12 个值');
    await page.click('#gm-sel-none');
    await page.waitForTimeout(100);
    d = await snapshot(page);
    t.eq('12.5 清空 → 勾选归零', d.selCount, '未勾选任何值');

    /* 批量规则：T01-T04=清洗（合并进已有「清洗」组） */
    await page.click('.gm-details > summary');
    await page.fill('#gm-rules', 'T01-T04=清洗');
    await page.click('#gm-rules-apply');
    await page.waitForTimeout(150);
    st = await gmState(page);
    d = await snapshot(page);
    t.eq('12.6 批量规则按组名并入已有组（行数仍是 4）', st.rows.length, 4);
    t.eq('12.7 规则把 T03/T04 并进「清洗」（4 个值）',
      st.rows.filter(function (r) { return r.name === '清洗'; })[0].values.join(','), 'T01,T02,T03,T04');
    t.contains('12.8 规则结果提示已应用 1 条',
      await page.evaluate(function () { return document.getElementById('gm-rules-msg').textContent; }),
      '应用 1 条规则');

    /* 校验：列名撞车 */
    await page.fill('#gm-name', 'Yield');
    await page.click('.modal-foot .btn-primary');
    await page.waitForTimeout(140);
    d = await snapshot(page);
    t.eq('12.9 列名重复 → 面板不关', d.open, true);
    t.eq('12.10 列名重复 → 红字报错', d.errOn, true);
    t.contains('12.11 报错文案说明列名已存在', d.err, '已存在');
    t.eq('12.12 列数没变（没有写入半成品列）', (await app.getState(page)).colCount, 4);
    await page.fill('#gm-name', 'Tool_Group');

    /* 切回原配方，取消后数据不变 */
    await page.fill('#gm-rules', '');
    await cancelDialog(page);
    d = await snapshot(page);
    t.eq('12.13 取消后面板关闭', d.open, false);
    t.eq('12.14 取消后列数不变（仍是 4）', (await app.getState(page)).colCount, 4);
    t.eq('12.15 取消后派生列逐行仍是原值', (await colValues(page, 'Tool_Group')).join(','), DERIVED_12);

    /* ==================================================================
       13. 1000+ 取值：虚拟滚动（DOM 行数恒定）+ 打开耗时
       ================================================================== */
    const big = await app.importText(page, 'many.csv', csvMany(1200));
    t.eq('13.1 导入 1200 行', big.rows, 1200);
    const perf = await page.evaluate(function () {
      const t0 = performance.now();
      window.YMS.GroupUI.openFor('Tool');
      const t1 = performance.now();
      const stt = window.YMS.GroupUI.state();
      return {
        ms: Math.round((t1 - t0) * 10) / 10,
        values: stt.values,
        domRows: stt.domRows,
        window: stt.window
      };
    });
    await page.waitForTimeout(150);
    t.eq('13.2 面板认出 1200 个不同取值', perf.values, 1200);
    t.ok('13.3 启用虚拟滚动：DOM 行数远小于取值数（< 60）', perf.domRows > 0 && perf.domRows < 60, perf);
    t.ok('13.4 打开面板耗时 < 800ms', perf.ms < 800, perf);
    const scrolled = await page.evaluate(async function () {
      const v = document.getElementById('gm-vals');
      v.scrollTop = 5200;
      v.dispatchEvent(new Event('scroll'));
      await new Promise(function (r) { setTimeout(r, 120); });
      return {
        top: v.scrollTop,
        domRows: document.querySelectorAll('#gm-vals .gm-vrow').length,
        window: window.YMS.GroupUI.state().window,
        first: (document.querySelector('#gm-vals .gm-vrow .gm-vval') || {}).textContent
      };
    });
    t.ok('13.5 滚到中段 → 渲染窗口前移（不再从第 0 行开始）', scrolled.window[0] > 150, scrolled);
    t.ok('13.6 滚动后 DOM 行数仍然恒定（< 60）', scrolled.domRows > 0 && scrolled.domRows < 60, scrolled);
    await page.fill('#gm-search', 'TL11');
    await page.waitForTimeout(150);
    const sr = await page.evaluate(function () {
      const w = window.YMS.GroupUI.state().window;
      return {
        size: w[1] - w[0],
        count: document.getElementById('gm-count').textContent,
        first: (document.querySelector('#gm-vals .gm-vrow .gm-vval') || {}).textContent
      };
    });
    t.contains('13.7 搜索计数显示匹配 100 个（覆盖全部 1200 个值）', sr.count, '匹配 100 个');
    t.eq('13.8 命中的第一行是 TL1100（说明搜索从全部 1200 值里取）', sr.first, 'TL1100');
    t.ok('13.9 搜索结果同样走虚拟滚动（DOM 行数仍 < 60）', sr.size > 0 && sr.size < 60, sr);
    await cancelDialog(page);

    /* ==================================================================
       14. 其它列 / 页面健康
       ================================================================== */
    const st14 = await app.getState(page);
    t.eq('14.1 行数仍是 1200', st14.rowCount, 1200);
    t.eq('14.2 列数 = 2（Tool/Yield，未产生垃圾列）', st14.colCount, 2);
    t.noErrors('14.3 全程零未捕获异常 / 控制台错误', ctx.errors);
  }
};
