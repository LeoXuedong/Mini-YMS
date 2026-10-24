/* ==========================================================================
   YMS · data/yms-template.js
   职责：.yms 模板（数据 + 格式 + 排序 + 绘图配置）的生成 / 保存 / 载入 / 校验
   依赖：YMS.util（toast / confirm / downloadText / nowStamp / fmtBytes / setStatus）
         YMS.Store（serialize / deserialize / addNote / setMode / state）
         YMS.types（列类型常量）
   要点：
     1) .yms 即 YMS.Store.serialize() 的 JSON 文本（format:'YMS-TEMPLATE'），
        恢复内容包含：数据、列类型、列小数位等数值格式、字体、多级行排序、
        预处理、绘图配置（含 style / layout / merge / fit）、活跃 page；
     2) 保存文件名 <tableName>-<stamp>.yms；数据 > 30 万行时先用 YMS.util.confirm 提示体积；
     3) 载入成功后：Store.deserialize → Store.addNote → 切到绘图视图 + toast
        「模板已恢复：数据 + 格式 + 排序 + 绘图」；
     4) 所有失败路径 toast + console.error，不抛未捕获异常（返回 {ok:false, error}）。
     5) S-2（2026-10-21）：模板设置项走 schema 白名单 + 逐字段类型校验
        （实现在 core/store.js 的 applyRules —— 唯一入口）。不认识的字段一律忽略，
        类型 / 取值不合法的字段回落默认值，两条都会进「处理说明」与 toast；
        另加三档体量保护（见下方 MAX_* 常量），超限直接拒绝载入且不动当前表。
   对外：
     YMS.YmsTemplate.build() -> object                 // = YMS.Store.serialize()
     YMS.YmsTemplate.save() -> Promise<boolean>        // 生成并下载 .yms
     YMS.YmsTemplate.load(textOrObj) -> {ok, df, meta, error}
     YMS.YmsTemplate.validate(objOrText) -> {ok, error}
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;
  var U = YMS.util;

  var FORMAT = 'YMS-TEMPLATE';
  var BIG_ROWS = 300000;                    /* 超过该行数保存前先确认 */
  /* S-2 体量保护（阈值理由见 docs/迭代记录.md 与 OB 修复记录）：
     · 32 MB —— 本项目 10 万行 × 3 列模板实测约 3 MB，32 MB 留 10 倍余量；再大则 JSON.parse
       与建表会长时间卡住主线程（file:// 单线程，无 Worker 可用）；
     · 50 张表 —— 表列表本身没有分页，超过 50 张后侧栏不可用；
     · 单表 100 万行 —— 与本项目「10 万行级」需求留 10 倍余量，再大则 DataFrame 列数组
       内存翻倍且渲染必然超时；
     · 合计 200 万行 —— 50 张表各 100 万行必然 OOM，按总量再兜一道。 */
  var MAX_TEMPLATE_BYTES = 32 * 1024 * 1024;
  var MAX_TABLES = 50;
  var MAX_TABLE_ROWS = 1000000;
  var MAX_TOTAL_ROWS = 2000000;
  /* 任务 F（2026-10-23）：图例 / 图元设置项的**键白名单**（.yms 保存 → 载入的登记处）。
     真正的逐字段类型校验由 core/store.js 的 plotRules() 里的
     `{ k:'legend', sub: LEGEND_RULES }` / `{ k:'mark', sub: MARK_RULES }` 执行（applyRules 唯一入口，
     deserialize 时调用）；这里再登记一份供自测与文档核对 —— 两处必须逐字段一致，
     漏登记的历史后果：保存后再载入该字段被静默丢弃（s2-yms-schema.js 的教训）。 */
  var PLOT_EXTRA_KEYS = {
    legend: ['position', 'orient', 'textColor', 'bgColor', 'borderColor', 'borderWidth',
      'padding', 'itemWidth', 'itemHeight', 'itemGap', 'scrollMode'],
    mark: ['boxRatio', 'boxLineWidth', 'barRatio', 'barRadius', 'lineWidth', 'lineType',
      'showSymbol', 'symbolSize', 'symbolShape', 'scatterSize', 'scatterOpacity', 'scatterShape']
  };

  function toast(html, kind, ms) { if (U && U.toast) U.toast(html, kind, ms); }
  function esc(s) { return (U && U.escapeHtml) ? U.escapeHtml(s) : String(s); }
  function fmtInt(n) { return (U && U.fmtInt) ? U.fmtInt(n) : String(n); }
  function fmtBytes(n) { return (U && U.fmtBytes) ? U.fmtBytes(n) : (Math.round(n / 1024) + ' KB'); }
  function setStatus(m, k) { if (U && U.setStatus) U.setStatus(m, k); }
  function tableName() {
    var n = (YMS.Store && YMS.Store.state && YMS.Store.state.tableName) || '';
    return n ? String(n) : 'YMS-数据';
  }

  /** 估算字符串 UTF-8 字节数（优先 Blob，退化按字符估算） */
  function byteLen(str) {
    try {
      if (typeof global.Blob === 'function') {
        var b = new global.Blob([str]);
        if (b && typeof b.size === 'number') return b.size;
      }
    } catch (e) { /* 忽略，走估算 */ }
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      n += c < 0x80 ? 1 : (c < 0x800 ? 2 : 3);
    }
    return n;
  }

  /**
   * 构建模板对象
   * @returns {object} = YMS.Store.serialize()
   */
  function build() {
    return YMS.Store.serialize();
  }

  /**
   * 校验模板对象（或 JSON 文本）
   * @param {object|string} objOrText
   * @returns {{ok:boolean, error:string|null}}
   */
  function validate(objOrText) {
    var obj = objOrText;
    if (obj === null || obj === undefined) return { ok: false, error: '模板内容为空' };
    if (typeof obj === 'string') {
      if (obj.trim() === '') return { ok: false, error: '模板内容为空' };
      /* S-2 体量保护①：先量字节再 JSON.parse（超大文本连 parse 都不做，主线程不受牵连） */
      var bytes = byteLen(obj);
      if (bytes > MAX_TEMPLATE_BYTES) {
        return {
          ok: false,
          error: '模板文件过大（' + fmtBytes(bytes) + '，上限 ' + fmtBytes(MAX_TEMPLATE_BYTES) + '），已拒绝载入'
        };
      }
      try { obj = JSON.parse(obj); }
      catch (e) { return { ok: false, error: '文件不是有效的 JSON 文本（' + (e && e.message ? e.message : e) + '）' }; }
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return { ok: false, error: '模板格式不正确（顶层应为 JSON 对象）' };
    }
    if (obj.format !== FORMAT) {
      return { ok: false, error: '不是有效的 .yms 模板（缺少 format:"' + FORMAT + '" 标记）' };
    }
    /* S-2 体量保护②③：表数 / 单表行数 / 总行数上限（超限一律拒绝，绝不写 Store） */
    var tbls = Array.isArray(obj.tables) ? obj.tables : null;
    if (tbls && tbls.length > MAX_TABLES) {
      return { ok: false, error: '模板含 ' + tbls.length + ' 张表，超过上限 ' + MAX_TABLES + ' 张，已拒绝载入' };
    }
    var totalRows = 0, i2;
    if (tbls && tbls.length) {
      for (i2 = 0; i2 < tbls.length; i2++) {
        var trs = (tbls[i2] && Array.isArray(tbls[i2].rows)) ? tbls[i2].rows : null;
        if (!trs) continue;
        if (trs.length > MAX_TABLE_ROWS) {
          return {
            ok: false,
            error: '模板第 ' + (i2 + 1) + ' 张表 ' + fmtInt(trs.length) + ' 行，超过单表上限 ' +
              fmtInt(MAX_TABLE_ROWS) + ' 行，已拒绝载入'
          };
        }
        totalRows += trs.length;
      }
    } else if (Array.isArray(obj.rows) && obj.rows.length > MAX_TABLE_ROWS) {
      return {
        ok: false,
        error: '模板 ' + fmtInt(obj.rows.length) + ' 行，超过单表上限 ' + fmtInt(MAX_TABLE_ROWS) + ' 行，已拒绝载入'
      };
    } else if (Array.isArray(obj.rows)) {
      totalRows = obj.rows.length;
    }
    if (totalRows > MAX_TOTAL_ROWS) {
      return {
        ok: false,
        error: '模板合计 ' + fmtInt(totalRows) + ' 行，超过总行数上限 ' + fmtInt(MAX_TOTAL_ROWS) + ' 行，已拒绝载入'
      };
    }
    if (!Array.isArray(obj.columns) || obj.columns.length === 0) {
      return { ok: false, error: '模板缺少列定义（columns 为空）' };
    }
    if (!Array.isArray(obj.rows)) {
      return { ok: false, error: '模板缺少数据行（rows 不是数组）' };
    }
    if (obj.rows.length && !Array.isArray(obj.rows[0])) {
      return { ok: false, error: '模板数据行格式不正确（rows 的元素应为数组）' };
    }
    for (var i = 0; i < obj.columns.length; i++) {
      var c = obj.columns[i];
      if (!c || typeof c !== 'object') return { ok: false, error: '第 ' + (i + 1) + ' 列的列定义无效' };
      if (!c.name || typeof c.name !== 'string') return { ok: false, error: '第 ' + (i + 1) + ' 列缺少列名（name）' };
      if (c.type !== T.NUMBER && c.type !== T.TIME && c.type !== T.STRING) {
        return { ok: false, error: '列「' + c.name + '」的类型无效：' + String(c.type) };
      }
    }
    return { ok: true, error: null };
  }

  /**
   * 保存并下载 .yms 模板
   * @returns {Promise<boolean>} 是否已发起下载
   */
  function save() {
    if (!YMS.Store.hasData()) {
      toast('没有可保存的数据，请先通过 Data → Data Import 导入数据', 'error');
      return Promise.resolve(false);
    }
    try {
      var json = JSON.stringify(build());
      var rows = YMS.Store.state.df ? YMS.Store.state.df.rowCount : 0;
      var cols = YMS.Store.state.df ? YMS.Store.state.df.cols.length : 0;
      var size = byteLen(json);
      var stamp = (U && U.nowStamp) ? U.nowStamp() : String(Date.now());
      var name = tableName() + '-' + stamp + '.yms';

      var doSave = function () {
        try {
          U.downloadText(name, json, 'application/json');
          setStatus('已保存模板：' + name + '（' + fmtInt(rows) + ' 行 × ' + cols + ' 列）', 'ok');
          toast('模板已保存：<b>' + esc(name) + '</b>（含数据 + 格式 + 排序 + 绘图）', 'ok', 4200);
          return true;
        } catch (e) {
          console.error('[YMS.YmsTemplate.save] 下载失败', e);
          toast('模板保存失败：' + esc(e && e.message ? e.message : e), 'error');
          return false;
        }
      };

      if (rows > BIG_ROWS) {
        var msg = '当前数据 <b>' + fmtInt(rows) + ' 行 × ' + cols + ' 列</b>，' +
          '模板需内嵌全部数据，文件体积约 <b>' + (U && U.fmtBytes ? U.fmtBytes(size) : size + ' B') + '</b>。<br>' +
          '生成与再次载入都可能较慢，是否继续保存？';
        return U.confirm({ title: '保存模板（大文件提示）', message: msg, okText: '继续保存', cancelText: '取消' })
          .then(function (yes) {
            if (!yes) { setStatus('已取消模板保存', null); return false; }
            return doSave();
          });
      }
      return Promise.resolve(doSave());
    } catch (e) {
      console.error('[YMS.YmsTemplate.save] 失败', e);
      toast('模板保存失败：' + esc(e && e.message ? e.message : e), 'error');
      return Promise.resolve(false);
    }
  }

  /**
   * 载入模板（JSON 文本或已解析对象）→ Store.deserialize → 切绘图视图
   * @param {string|object} textOrObj
   * @returns {{ok:boolean, df:object|null, meta:object|null, error:string|null}}
   */
  function load(textOrObj) {
    try {
      var v = validate(textOrObj);
      if (!v.ok) {
        console.error('[YMS.YmsTemplate.load] 模板校验失败：' + v.error);
        toast('模板载入失败：' + esc(v.error), 'error');
        setStatus('模板载入失败：' + v.error, 'error');
        return { ok: false, df: null, meta: null, error: v.error };
      }
      var obj = (typeof textOrObj === 'string') ? JSON.parse(textOrObj) : textOrObj;

      var df = YMS.Store.deserialize(obj);          /* 数据 + 格式 + 排序 + 绘图配置 */
      var note = '恢复 .yms 模板：' + (obj.tableName || obj.fileName || '未命名') +
        '（' + df.rowCount + ' 行 × ' + df.cols.length + ' 列）';
      YMS.Store.addNote(note);
      /* M-4：模板里的重复列名也已在建表处改名，这里给出可见提示（状态栏 + toast + 处理说明） */
      var dupNotice = (df.dupHeader && df.dupHeader.count && YMS.colNames)
        ? YMS.colNames.notice(df.dupHeader) : '';
      if (dupNotice) YMS.Store.addNote('导入提示：' + dupNotice);
      /* S-2：schema 归一化报告 —— 未知设置项已丢弃 / 非法值已回落默认，
         这里把它变成可见提示（处理说明 + toast + meta），不留静默 */
      var fixes = (YMS.Store.sanitizeMessages ? YMS.Store.sanitizeMessages() : []);
      for (var fi = 0; fi < fixes.length; fi++) YMS.Store.addNote(fixes[fi]);
      YMS.Store.setMode('plot');                    /* 模板恢复后直接进入绘图视图 */

      var meta = {
        fileName: obj.fileName || '',
        tableName: obj.tableName || YMS.Store.state.tableName || '',
        rowCount: df.rowCount,
        colCount: df.cols.length,
        createdAt: obj.createdAt || '',
        version: obj.version || '',
        mode: 'plot',
        sanitize: fixes.slice()
      };
      var warn = !!(dupNotice || fixes.length);
      setStatus('已恢复模板：' + (meta.tableName || meta.fileName || '') +
        '（' + fmtInt(df.rowCount) + ' 行 × ' + df.cols.length + ' 列）' +
        (dupNotice ? ' · ' + dupNotice : '') +
        (fixes.length ? ' · 模板设置已校验：' + fixes.length + ' 条提示（见处理说明）' : ''),
        warn ? 'warn' : 'ok');
      toast('模板已恢复：数据 + 格式 + 排序 + 绘图' +
        (dupNotice ? '<br>' + esc(dupNotice) : '') +
        (fixes.length ? '<br>' + esc(fixes.join('；')) : ''), warn ? 'warn' : 'ok', 4200);
      return { ok: true, df: df, meta: meta, error: null };
    } catch (e) {
      console.error('[YMS.YmsTemplate.load] 失败', e);
      var msg = e && e.message ? e.message : String(e);
      toast('模板载入失败：' + esc(msg), 'error');
      setStatus('模板载入失败：' + msg, 'error');
      return { ok: false, df: null, meta: null, error: msg };
    }
  }

  YMS.YmsTemplate = {
    FORMAT: FORMAT,
    /** 任务 F：图例 / 图元设置的键白名单（与 store.js 的 LEGEND_RULES / MARK_RULES 逐字段对应） */
    PLOT_EXTRA_KEYS: PLOT_EXTRA_KEYS,
    build: build,
    save: save,
    load: load,
    validate: validate
  };
})(typeof window !== 'undefined' ? window : this);
