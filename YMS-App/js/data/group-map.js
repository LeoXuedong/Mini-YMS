/* ==========================================================================
   YMS · data/group-map.js
   职责：按值分组（Group Mapping）的**纯函数**引擎
   场景：某列（如 Tool = T01~T12）的离散值 → 用户定义的组名（清洗 / 沉积 / …），
         产出一个字符型派生列；该派生列可直接当 X Label / Sorter / Page by /
         Split by / 颜色分组列使用，绘图侧不需要任何专用通路。

   边界（与 data/transform.js 同一范式）：
     1) 只做「DF + 规格 → 列定义」的计算，不碰 UI、不读写 Store、不入历史栈；
     2) **绝不修改入参 df**：产出 {dict, values, order} 交给调用方写入 table；
     3) 参数非法（列不存在 / 组名为空 / 重名）一律返回 {ok:false, error}，不抛异常；
     4) 组顺序 order = 用户在 UI 里排的顺序（横轴严格按它排），未分配值排在最后；
     5) ES5 风格，无 console 输出。

   对外：
     YMS.GroupMap.OTHER_LABEL / MAX_VALUES / MAX_GROUPS
     YMS.GroupMap.distinct(df, colName[, limit])       → 源列不同值（出现序 / 数值序）
     YMS.GroupMap.normSpec(spec, df)                   → 归一化规格（含校验）
     YMS.GroupMap.build(df, spec)                      → {dict, values, order, counts}
     YMS.GroupMap.applyToDf(df, spec)                  → 生成 / 原地更新派生列
     YMS.GroupMap.parseRules(text, values)             → 批量规则 T01-T04=清洗
     YMS.GroupMap.metaOf(col) / YMS.GroupMap.sameSpec  → 列元数据读取与比较
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;

  var OTHER_LABEL = '未分组';      /* 「未分配值 → 归为未分组」时的特殊组名 */
  var MAX_VALUES = 2000;           /* 单个映射最多覆盖的不同值个数（超出请先筛选数据） */
  var MAX_GROUPS = 200;            /* 组数上限 */
  var MAX_NAME = 200;              /* 组名 / 列名长度上限（与 store.js 的 MAX_STR_LEN 同量级） */

  function err(text) { return { ok: false, error: text }; }

  /** 去空白的文本（null / undefined / 非字符串一律转字符串） */
  function txt(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  /**
   * 源列的「显示文本」—— 映射键、预览、派生列取值三处共用同一个函数，
   * 保证「勾的是哪个值」和「写进新列的是哪个值」永远一致。
   */
  function textOf(col, raw) {
    if (!col) return '';
    if (col.type === T.STRING) return (raw < 0 || raw === undefined || raw === null) ? '' : col.dict[raw];
    if (YMS.num.isMissing(raw)) return '';
    return T.formatValue(raw, col.type, null, col.timeStyle || 'datetime');
  }

  /**
   * 源列的不同值列表
   *   字符列：按字典顺序 = 数据里的**首次出现顺序**（导入时的建字典顺序）
   *   数值 / 时间列：去重后按数值升序
   * @param {DataFrame} df
   * @param {string} colName
   * @param {number} [limit] 默认 MAX_VALUES
   * @returns {{ok:boolean, error?:string, values:Array<{value:string,count:number}>, total:number, truncated:boolean}}
   */
  function distinct(df, colName, limit) {
    if (!df) return { ok: false, error: '尚未载入数据', values: [], total: 0, truncated: false };
    var ci = df.colIndex(colName);
    if (ci < 0) return { ok: false, error: '参数不存在：' + colName, values: [], total: 0, truncated: false };
    limit = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : MAX_VALUES;
    var c = df.cols[ci], out = [], i, v, total;
    if (c.type === T.STRING) {
      var cnt = new Int32Array(c.dict.length);
      for (i = 0; i < c.values.length; i++) { v = c.values[i]; if (v >= 0 && v < cnt.length) cnt[v]++; }
      for (i = 0; i < c.dict.length; i++) {
        if (cnt[i]) out.push({ value: c.dict[i], count: cnt[i] });
      }
    } else {
      var map = Object.create(null), list = [];
      for (i = 0; i < c.values.length; i++) {
        v = c.values[i];
        if (YMS.num.isMissing(v)) continue;
        var s = textOf(c, v);
        var rec = map[s];
        if (!rec) { rec = { value: s, count: 0, num: v }; map[s] = rec; list.push(rec); }
        rec.count++;
      }
      list.sort(function (a, b) { return a.num - b.num; });
      out = list.map(function (r) { return { value: r.value, count: r.count }; });
    }
    total = out.length;
    var truncated = false;
    if (out.length > limit) { out = out.slice(0, limit); truncated = true; }
    return { ok: true, values: out, total: total, truncated: truncated };
  }

  /** 组名去重 / 合法性（'' 与超长一律剔除，重复只留首个） */
  function normGroups(list) {
    var out = [], seen = Object.create(null), i, g;
    if (!list || !list.length) return out;
    for (i = 0; i < list.length; i++) {
      g = txt(list[i]);
      if (!g || g.length > MAX_NAME) continue;
      if (seen[g]) continue;
      seen[g] = 1;
      out.push(g);
      if (out.length >= MAX_GROUPS) break;
    }
    return out;
  }

  /** 「未分组」标签：与已有组名冲突时自动加序号（'未分组 (2)'） */
  function otherLabelFor(groups, wanted) {
    var base = txt(wanted) || OTHER_LABEL, out = base, k = 2;
    if (!groups || !groups.length) return out;
    while (groups.indexOf(out) >= 0) { out = base + ' (' + k + ')'; k++; if (k > 99) break; }
    return out;
  }

  /**
   * 规格归一化（唯一的校验入口）
   * @param {object} spec {sourceCol, targetCol, groups:[], map:{}, unassigned:'other'|'raw', otherLabel}
   * @param {DataFrame} df 用于确认源列存在
   * @returns {{ok:boolean, error?:string, spec?:object}}
   */
  function normSpec(spec, df) {
    if (!spec || typeof spec !== 'object') return err('分组规格为空');
    var sourceCol = txt(spec.sourceCol);
    if (!sourceCol) return err('请选择源列');
    if (df && df.colIndex(sourceCol) < 0) return err('源列不存在：' + sourceCol);
    var targetCol = txt(spec.targetCol) || (sourceCol + '_Group');
    var groups = normGroups(spec.groups);
    if (groups.length > MAX_GROUPS) return err('组数超过上限 ' + MAX_GROUPS);
    var useOther = spec.unassigned !== 'raw';
    var otherLabel = useOther ? otherLabelFor(groups, spec.otherLabel) : (txt(spec.otherLabel) || OTHER_LABEL);
    /* 映射表：键 = 源值文本，值 = 组名；指向不存在组 / 空组名的条目直接丢弃 */
    var rawMap = (spec.map && typeof spec.map === 'object') ? spec.map : {};
    var map = Object.create(null), keys = Object.keys(rawMap), i, k, g, n = 0;
    for (i = 0; i < keys.length; i++) {
      k = String(keys[i]);
      if (!k || k.length > MAX_NAME) continue;
      g = txt(rawMap[k]);
      if (!g || groups.indexOf(g) < 0) continue;
      map[k] = g;
      n++;
      if (n >= MAX_VALUES) break;
    }
    return {
      ok: true, spec: {
        sourceCol: sourceCol, targetCol: targetCol,
        groups: groups, map: map,
        unassigned: useOther ? 'other' : 'raw',
        otherLabel: otherLabel
      }
    };
  }

  /** 规格的普通对象副本（写入列元数据 / 序列化用；不含原型） */
  function plainSpec(sp) {
    var out = {
      sourceCol: sp.sourceCol, targetCol: sp.targetCol,
      groups: sp.groups.slice(), map: {},
      unassigned: sp.unassigned, otherLabel: sp.otherLabel
    };
    Object.keys(sp.map).forEach(function (k) { out.map[k] = sp.map[k]; });
    return out;
  }

  /**
   * 计算派生列的列数据（纯函数，不改 df）
   * @returns {{ok:boolean, error?:string, name?:string, dict?:string[], values?:Int32Array,
   *            order?:string[], counts?:object, mapped?:number, other?:number, rawKept?:number,
   *            missing?:number, spec?:object}}
   */
  function build(df, spec) {
    var nr = normSpec(spec, df);
    if (!nr.ok) return nr;
    var sp = nr.spec;
    var ci = df.colIndex(sp.sourceCol);
    var col = df.cols[ci];
    var gi = Object.create(null);
    sp.groups.forEach(function (g, i) { gi[g] = i; });

    /* dict 顺序 = 组顺序（+ 未分组固定末位）——UI / tooltip / 表头筛选读到的标签顺序一致 */
    var labels = sp.groups.slice();
    if (sp.unassigned === 'other') labels.push(sp.otherLabel);
    var dict = [], dictMap = Object.create(null);
    function idxOf(name) {
      var k = dictMap[name];
      if (k === undefined) { k = dict.length; dict.push(name); dictMap[name] = k; }
      return k;
    }
    labels.forEach(idxOf);

    var rowCount = df.rowCount;
    var values = new Int32Array(rowCount);
    var mapped = 0, other = 0, rawKept = 0, missing = 0, r, t, g;
    var rawVals = Object.create(null);
    for (r = 0; r < rowCount; r++) {
      t = textOf(col, col.values[r]);
      g = (t !== '') ? sp.map[t] : undefined;
      if (g !== undefined && gi[g] !== undefined) {
        values[r] = idxOf(g); mapped++;
      } else if (sp.unassigned === 'other') {
        values[r] = idxOf(sp.otherLabel); other++;
      } else if (t === '') {
        values[r] = -1; missing++;
      } else {
        values[r] = idxOf(t); rawKept++;
        rawVals[t] = (rawVals[t] || 0) + 1;
      }
    }
    /* 未分配原值（'raw' 模式）：已知组之后按首现顺序追加，保证「已知组顺序」优先 */
    var order = sp.groups.slice();
    if (sp.unassigned === 'other') order.push(sp.otherLabel);
    else Object.keys(rawVals).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });

    return {
      ok: true, name: sp.targetCol, spec: plainSpec(sp),
      dict: dict, values: values, order: order,
      mapped: mapped, other: other, rawKept: rawKept, missing: missing,
      counts: { rows: rowCount, values: Object.keys(sp.map).length, groups: sp.groups.length }
    };
  }

  /**
   * 生成 / 原地更新派生列（唯一写入口）
   *   · 目标列不存在 → 追加到表尾
   *   · 目标列已存在且是分组列 → 原位替换（不产生 `Tool_Group (2)`）
   *   · 目标列已存在但不是分组列（用户自己的同名列）→ 报错，不覆盖
   * 注意：本函数**会修改 df**（替换 / 追加列），调用方负责 Store.replaceDataFrame(df)。
   * @returns {{ok:boolean, error?:string, name?:string, action?:'added'|'updated', order?:string[], ...}}
   */
  function applyToDf(df, spec) {
    if (!df) return err('尚未载入数据');
    var nr = normSpec(spec, df);
    if (!nr.ok) return nr;
    var sp = nr.spec;
    var res = build(df, sp);
    if (!res.ok) return res;
    var existCi = df.colIndex(sp.targetCol);
    var action = 'added';
    if (existCi >= 0) {
      var old = df.cols[existCi];
      if (!old.groupMap) return err('列名「' + sp.targetCol + '」已被其他参数占用，请换一个');
      action = 'updated';
    }
    var col = new YMS.Column(sp.targetCol, T.STRING, res.values, res.dict, null);
    col.order = res.order.slice();
    col.groupMap = res.spec;
    if (action === 'updated') df.cols[existCi] = col;
    else df.cols.push(col);
    df.refreshMissing();
    return {
      ok: true, name: sp.targetCol, action: action, index: df.colIndex(sp.targetCol),
      order: res.order.slice(), groups: res.spec.groups.slice(),
      mapped: res.mapped, other: res.other, rawKept: res.rawKept, missing: res.missing,
      counts: res.counts, spec: res.spec
    };
  }

  /** 列上的分组元数据（无 → null） */
  function metaOf(col) {
    if (!col || !col.groupMap) return null;
    var nr = normSpec(col.groupMap, null);
    if (!nr.ok) return null;
    var out = plainSpec(nr.spec);
    out.order = (col.order && col.order.length) ? col.order.slice() : [].concat(nr.spec.groups);
    return out;
  }

  /** 两份规格是否语义相同（源列 / 目标列 / 组顺序 / 映射 / 未分配模式） */
  function sameSpec(a, b) {
    if (!a || !b) return false;
    if (a.sourceCol !== b.sourceCol || a.targetCol !== b.targetCol) return false;
    if (String(a.unassigned) !== String(b.unassigned)) return false;
    var ga = a.groups || [], gb = b.groups || [], i;
    if (ga.length !== gb.length) return false;
    for (i = 0; i < ga.length; i++) if (ga[i] !== gb[i]) return false;
    var ma = a.map || {}, mb = b.map || {};
    var ka = Object.keys(ma), kb = Object.keys(mb);
    if (ka.length !== kb.length) return false;
    for (i = 0; i < ka.length; i++) if (mb[ka[i]] !== ma[ka[i]]) return false;
    return true;
  }

  /**
   * 批量规则解析：每行 `选择器=组名`
   *   选择器支持：单值 T01、逗号列表 T01,T03、区间 T01-T04（T01/T04 必须是已知值，
   *   按值列表下标取区间，含两端）。'=' 只按第一个切分，组名里允许再出现等号。
   * @param {string} text  多行规则
   * @param {Array<string>} valueList 已知值（出现序 / 数值序）
   * @returns {{ok:boolean, error?:string, map:object, applied:number, skipped:string[]}}
   */
  function parseRules(text, valueList) {
    var lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/);
    var map = Object.create(null), applied = 0, skipped = [], idx = Object.create(null);
    (valueList || []).forEach(function (v, i) { idx[v] = i; });
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line || line.charAt(0) === '#') continue;
      var eq = line.indexOf('=');
      if (eq <= 0) { skipped.push(line); continue; }
      var sel = line.slice(0, eq).trim(), group = line.slice(eq + 1).trim();
      if (!sel || !group) { skipped.push(line); continue; }
      var hit = 0;
      var parts = sel.split(',');
      for (var pi = 0; pi < parts.length; pi++) {
        var part = parts[pi].trim();
        if (!part) continue;
        if (idx[part] !== undefined) { map[part] = group; hit++; continue; }
        var dash = part.indexOf('-');
        if (dash > 0) {
          var a = part.slice(0, dash).trim(), b = part.slice(dash + 1).trim();
          if (idx[a] !== undefined && idx[b] !== undefined) {
            var i0 = Math.min(idx[a], idx[b]), i1 = Math.max(idx[a], idx[b]);
            for (var vi = i0; vi <= i1; vi++) { if (valueList[vi] !== undefined) { map[valueList[vi]] = group; hit++; } }
            continue;
          }
        }
        skipped.push(part);
      }
      if (hit) applied++;
      else skipped.push(line);
    }
    if (!applied) return { ok: false, error: '没有可应用的规则（格式：T01-T04=组名，每行一条）', map: {}, applied: 0, skipped: skipped };
    return { ok: true, map: map, applied: applied, skipped: skipped };
  }

  YMS.GroupMap = {
    OTHER_LABEL: OTHER_LABEL,
    MAX_VALUES: MAX_VALUES,
    MAX_GROUPS: MAX_GROUPS,
    MAX_NAME: MAX_NAME,
    distinct: distinct,
    normSpec: normSpec,
    build: build,
    applyToDf: applyToDf,
    metaOf: metaOf,
    sameSpec: sameSpec,
    parseRules: parseRules,
    otherLabelFor: otherLabelFor,
    textOf: textOf,
    plainSpec: plainSpec
  };
})(typeof window !== 'undefined' ? window : this);
