/* ==========================================================================
   YMS · data/transform.js
   职责：多表 / 表格转换的**纯函数**引擎（迭代 14 · B 路）
   边界：只做 DataFrame → DataFrame 的变换，不碰 UI、不读写 Store、不入历史栈。
   约定：
     1) 每个操作统一返回 {df, notes}；notes 为 [{level:'info'|'warn', text}]，
        用于报告类型强转 / 空值处理 / 丢列 / 行数放大等需要用户知晓的事实；
     2) **绝不修改入参 df**：需要改动时一律构造新 DataFrame（经 YMS.DataFrame / DFBuilder）；
     3) 参数非法 / 列不存在 / 无同名键等「可预期错误」只记 warn note 并返回原表副本，
        不抛异常（保证 UI 侧零未捕获异常）；
     4) 列类型沿用 YMS.DataFrame 的 string | number | time；time 列在列式存储中即 epoch ms；
     5) 代码为 ES5 风格（与 core / data 层一致），无 console 输出；
     6) 键值语义：空值（null / NaN / ''）自成一类键；number 1 与 string '1' 不是同一个键。
   对外：
     YMS.Transform.pivot / unpivot / transpose / vconcat / hconcat / join /
                    splitColumn / mergeColumns / groupAggregate / dedupe
     YMS.Transform.SUFFIX / suffixFor(kind, how)   —— 派生表名后缀（供 UI 层取用，见契约 §3）
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;
  var U = YMS.util || {};

  var MISSING_KEY = '\u0000N';        /* 空值作为分组键时的占位符 */
  var SEP_KEY = '\u0001';             /* 复合键拼接分隔符（正常文本不会出现） */
  var AGG_LIST = ['first', 'sum', 'mean', 'count', 'max', 'min'];
  var GROUP_FN = ['sum', 'mean', 'count', 'min', 'max', 'std', 'nunique'];

  /* 契约 §3：派生表名后缀 */
  var SUFFIX = {
    pivot: '_pivot', unpivot: '_unpivot', transpose: '_T',
    vconcat: '_vcat', hconcat: '_hcat',
    join: '_inner', joinLeft: '_left', joinRight: '_right', joinOuter: '_outer',
    split: '_split', merge: '_merge', agg: '_agg', dedupe: '_dedup', dedup: '_dedup'
  };

  /* ------------------------------------------------------------ 结果与提示 */
  /** 提示条目 */
  function N(level, text) { return { level: level, text: text }; }
  /** 统一的返回结构 */
  function ret(df, notes) { return { df: df, notes: notes || [] }; }
  /** 空表 */
  function emptyDf(defs) { return YMS.DataFrame.fromRows(defs || [], []); }

  /* ------------------------------------------------------------ 基础判定 */
  function isDf(x) { return !!x && typeof x === 'object' && Array.isArray(x.cols) && typeof x.rowCount === 'number'; }
  function isNaNVal(v) { return typeof v === 'number' && !isFinite(v); }   /* NaN / ±Infinity */
  /** 缺失：null / undefined / NaN / 空字符串 */
  function isMissing(v) {
    return v === null || v === undefined || isNaNVal(v) || (typeof v === 'string' && v === '');
  }
  /** 归一化列名列表（接受数组 / 单值 / 逗号串），过滤空项 */
  function listify(v) {
    if (v === null || v === undefined || v === '') return [];
    if (Array.isArray(v)) {
      var out = [], i;
      for (i = 0; i < v.length; i++) {
        if (v[i] === null || v[i] === undefined) continue;
        var s = String(v[i]);
        if (s === '') continue;
        out.push(s);
      }
      return out;
    }
    return [String(v)];
  }
  /** 去重命名：按 _2 / _3 … 递增 */
  function uniqueName(base, used) {
    if (!used[base]) return base;
    var k = 2;
    while (used[base + '_' + k]) k++;
    return base + '_' + k;
  }

  /* ------------------------------------------------------- 值 / 键 / 文本化 */
  function numStr(v) { return U.fmtNumber ? U.fmtNumber(v, null) : String(v); }
  function fmtTime(v, style) {
    return (T && T.formatValue) ? T.formatValue(v, 'time', null, style || 'datetime') : String(v);
  }
  /** 任意值 → 文本（time 按显示格式、number 无千分位、null → null） */
  function toStr(v, type, timeStyle) {
    if (isMissing(v)) return null;
    if (type === 'time') return fmtTime(v, timeStyle);
    if (typeof v === 'number' || type === 'number') return numStr(v);
    return String(v);
  }
  /** 单元格 → 文本（按列类型格式化） */
  function cellStr(df, ci, r) {
    var c = df.cols[ci];
    if (!c) return null;
    var v = df.cell(ci, r);
    if (v === null) return null;
    if (c.type === 'time') return fmtTime(v, c.timeStyle);
    if (c.type === 'number') return numStr(v);
    return String(v);
  }
  /** 分组键：空值统一占位；number 与 string 不同键 */
  function keyOf(v) {
    if (isMissing(v)) return MISSING_KEY;
    if (typeof v === 'number') return 'n' + v;
    return 's' + String(v);
  }
  /** 标量按目标类型取值（失败 → null） */
  function castScalar(v, type) {
    if (isMissing(v)) return null;
    if (type === 'string') return typeof v === 'number' ? numStr(v) : String(v);
    if (type === 'time') { var ms = typeof v === 'number' ? v : T.parseTime(v); return ms === ms ? ms : null; }
    var n = typeof v === 'number' ? v : T.parseNumber(v);
    return n === n ? n : null;
  }
  /** 单元格按目标类型取值（跨表拼接 / 类型统一时使用） */
  function castCell(df, ci, r, type) {
    var c = df.cols[ci];
    if (!c) return null;
    var v = df.cell(ci, r);
    if (v === null) return null;
    if (type === 'string') return c.type === 'time' ? fmtTime(v, c.timeStyle) : (c.type === 'number' ? numStr(v) : String(v));
    if (type === 'time') return typeof v === 'number' ? v : T.parseTime(v);
    var n = typeof v === 'number' ? v : T.parseNumber(v);
    return n === n ? n : null;
  }
  /** 补位值按目标类型取值 */
  function castFill(fill, type) {
    if (fill === null || fill === undefined) return null;
    return castScalar(fill, type);
  }

  /* ------------------------------------------------------------ 构造 DataFrame */
  function buildDf(defs, rows) {
    var cdefs = [], i;
    for (i = 0; i < defs.length; i++) {
      cdefs.push({ name: defs[i].name, type: defs[i].type || 'string', timeStyle: defs[i].timeStyle || null });
    }
    return YMS.DataFrame.fromRows(cdefs, rows || []);
  }
  /** 列定义（保留源列类型） */
  function defOf(df, ci) {
    var c = df.cols[ci];
    return { name: c.name, type: c.type, timeStyle: c.timeStyle || null };
  }

  /* -------------------------------------------------------------- 聚合内核 */
  /**
   * 单组聚合
   * @param {Array} vals 原始单元格值（可含 null）
   * @param {string} fn first|sum|mean|count|max|min|std|nunique
   * @param {boolean} keepEmpty true = 空字符串算有效值
   * @returns {{value:*, nonNumeric:number, valid:number, allNumeric:boolean}}
   */
  function computeAgg(vals, fn, keepEmpty) {
    var nonNull = [], nums = [], nonNum = 0, i, v, n, allNum = true;
    for (i = 0; i < vals.length; i++) {
      v = vals[i];
      if (v === '') { if (!keepEmpty) continue; }
      else if (isMissing(v)) continue;
      nonNull.push(v);
      if (typeof v === 'number' && isFinite(v)) nums.push(v);
      else {
        allNum = false;
        n = T ? T.parseNumber(v) : NaN;
        if (n === n) nums.push(n); else nonNum++;
      }
    }
    var out = { value: null, nonNumeric: nonNum, valid: nonNull.length, allNumeric: (nonNull.length > 0 && allNum) };
    if (fn === 'count') { out.value = nonNull.length; return out; }
    if (fn === 'nunique') {
      var seen = Object.create(null), c = 0;
      for (i = 0; i < nonNull.length; i++) { var k = keyOf(nonNull[i]); if (!seen[k]) { seen[k] = 1; c++; } }
      out.value = c;
      return out;
    }
    if (!nonNull.length) return out;
    if (fn === 'first') { out.value = nonNull[0]; return out; }
    if (fn === 'sum' || fn === 'mean' || fn === 'std') {
      if (!nums.length) return out;
      var s = 0;
      for (i = 0; i < nums.length; i++) s += nums[i];
      if (fn === 'sum') out.value = s;
      else if (fn === 'mean') out.value = s / nums.length;
      else {
        var m = s / nums.length, ss = 0;
        for (i = 0; i < nums.length; i++) { var d = nums[i] - m; ss += d * d; }
        out.value = Math.sqrt(ss / nums.length);        /* 总体标准差（分母 N），与 DataFrame.stats 一致 */
      }
      return out;
    }
    /* min / max：全数值 → 数值比较；否则按文本比较（返回原值） */
    if (out.allNumeric) {
      var best = nums[0];
      for (i = 1; i < nums.length; i++) { if (fn === 'max' ? nums[i] > best : nums[i] < best) best = nums[i]; }
      out.value = best;
    } else {
      var bv = null, bs = null;
      for (i = 0; i < nonNull.length; i++) {
        var sv = String(nonNull[i]);
        if (bs === null || (fn === 'max' ? sv > bs : sv < bs)) { bs = sv; bv = nonNull[i]; }
      }
      out.value = bv;
    }
    return out;
  }

  /* ------------------------------------------------------------ 类型推断 */
  /** 全部有效值为 number → number，否则 string */
  function inferSeriesType(vals) {
    var n = 0, nums = 0, i;
    for (i = 0; i < vals.length; i++) {
      if (isMissing(vals[i])) continue;
      n++;
      if (typeof vals[i] === 'number') nums++;
    }
    return (n > 0 && nums === n) ? 'number' : 'string';
  }
  /** 有效值中出现 >1 种 JS 类型（number / 非 number） */
  function hasMixedTypes(vals) {
    var num = 0, str = 0, i;
    for (i = 0; i < vals.length; i++) {
      if (isMissing(vals[i])) continue;
      if (typeof vals[i] === 'number') num++; else str++;
    }
    return num > 0 && str > 0;
  }
  /** 列字母序号：A..Z, AA.. */
  function colLetter(i) {
    var s = '', n = i + 1;
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  /* ==========================================================================
     pivot：长 → 宽
     ========================================================================== */
  /**
   * @param {DataFrame} df
   * @param {{ids?:Array<string>, nameCol:string, valueCol:string,
   *          agg?:string, prefix?:string, emptyAsNull?:boolean}} opts
   * @returns {{df:DataFrame, notes:Array}}
   */
  function pivot(df, opts) {
    opts = opts || {};
    var notes = [];
    if (!isDf(df)) { notes.push(N('warn', 'pivot：输入不是有效的数据表')); return ret(new YMS.DataFrame([]), notes); }
    if (!df.cols.length) { notes.push(N('warn', 'pivot：数据表没有列，无法透视')); return ret(df.clone(), notes); }

    var agg = String(opts.agg || 'first').toLowerCase();
    if (AGG_LIST.indexOf(agg) < 0) {
      notes.push(N('warn', 'pivot：不支持的聚合方式「' + opts.agg + '」，已按 first 处理'));
      agg = 'first';
    }
    var emptyAsNull = opts.emptyAsNull !== false;

    var nameCol = opts.nameCol ? String(opts.nameCol) : '';
    var valueCol = opts.valueCol ? String(opts.valueCol) : '';
    var ni = nameCol ? df.colIndex(nameCol) : -1;
    var vi = valueCol ? df.colIndex(valueCol) : -1;
    if (ni < 0) {
      notes.push(N('warn', 'pivot：未找到名称列「' + (nameCol || '（未指定）') + '」，无法透视'));
      return ret(df.clone(), notes);
    }
    if (vi < 0) {
      notes.push(N('warn', 'pivot：未找到值列「' + (valueCol || '（未指定）') + '」，无法透视'));
      return ret(df.clone(), notes);
    }

    /* ---------- 行标识列解析 ---------- */
    var ids = listify(opts.ids), tmp = [], missing = [], i;
    for (i = 0; i < ids.length; i++) {
      if (df.colIndex(ids[i]) < 0) missing.push(ids[i]); else tmp.push(ids[i]);
    }
    ids = tmp;
    if (missing.length) notes.push(N('warn', 'pivot：忽略不存在的分组列「' + missing.join('、') + '」'));
    var selfCols = [];
    for (i = 0; i < ids.length; i++) if (ids[i] === nameCol || ids[i] === valueCol) selfCols.push(ids[i]);
    if (selfCols.length) {
      ids = ids.filter(function (n) { return n !== nameCol && n !== valueCol; });
      notes.push(N('warn', 'pivot：分组列「' + selfCols.join('、') + '」与名称列/值列重复，已忽略'));
    }
    var idIdx = [], k;
    for (i = 0; i < ids.length; i++) idIdx.push(df.colIndex(ids[i]));
    if (!ids.length) {
      for (i = 0; i < df.cols.length; i++) {
        if (i === ni || i === vi) continue;
        ids.push(df.cols[i].name);
        idIdx.push(i);
      }
      if (ids.length) notes.push(N('info', 'pivot：未指定分组列，已用「' + ids.join('、') + '」作为行标识'));
    }

    var prefix = (opts.prefix === undefined || opts.prefix === null) ? (valueCol + '_') : String(opts.prefix);
    var vtype = df.cols[vi].type;

    /* ---------- 分组 + 透视列首次出现顺序 ---------- */
    var groups = [], gmap = Object.create(null);
    var cellOrder = [], cellMap = Object.create(null), nullNames = 0;
    var r, g, gp, gkey, nv, nk;

    for (r = 0; r < df.rowCount; r++) {
      nv = df.cell(ni, r);
      if (isMissing(nv)) { nullNames++; continue; }               /* 名称列为空的行不参与透视 */
      nk = keyOf(nv);
      gp = [];
      for (i = 0; i < idIdx.length; i++) gp.push(keyOf(df.cell(idIdx[i], r)));
      gkey = gp.join(SEP_KEY);
      g = gmap[gkey];
      if (!g) {
        var idVals = [];
        for (i = 0; i < idIdx.length; i++) idVals.push(df.cell(idIdx[i], r));
        g = { ids: idVals, cells: Object.create(null) };
        gmap[gkey] = g;
        groups.push(g);
      }
      if (!cellMap[nk]) { cellMap[nk] = { key: nk, label: String(nv) }; cellOrder.push(cellMap[nk]); }
      if (!g.cells[nk]) g.cells[nk] = [];
      g.cells[nk].push(df.cell(vi, r));
    }
    if (nullNames) notes.push(N('info', 'pivot：跳过 ' + nullNames + ' 行（名称列为空）'));
    if (!groups.length || !cellOrder.length) {
      notes.push(N('warn', 'pivot：没有可透视的数据（名称列全为空或数据行为 0）'));
      return ret(df.clone(), notes);
    }

    /* ---------- 新列名（prefix + 列值，重名自动去重） ---------- */
    var used = Object.create(null), outNames = [], renamed = [];
    for (i = 0; i < ids.length; i++) used[ids[i]] = 1;
    for (i = 0; i < cellOrder.length; i++) {
      var base = prefix + cellOrder[i].label;
      var nm = uniqueName(base, used);
      if (nm !== base) renamed.push(base + ' → ' + nm);
      used[nm] = 1;
      outNames.push(nm);
    }
    if (renamed.length) notes.push(N('warn', 'pivot：透视列名重复，已自动改名（' + renamed.join('；') + '）'));

    /* ---------- 聚合 ---------- */
    var mat = [], nonNumTotal = 0, gi, cj;
    for (gi = 0; gi < groups.length; gi++) {
      var row = groups[gi].ids.slice();
      for (cj = 0; cj < cellOrder.length; cj++) {
        var vals = groups[gi].cells[cellOrder[cj].key];
        if (!vals || !vals.length) { row.push(null); continue; }        /* 缺组合 → null */
        var res = computeAgg(vals, agg, !emptyAsNull);
        if (res.nonNumeric > 0) nonNumTotal += res.nonNumeric;
        row.push(res.value);
      }
      mat.push(row);
    }
    if (nonNumTotal && (agg === 'sum' || agg === 'mean')) {
      notes.push(N('warn', 'pivot：值列含 ' + nonNumTotal + ' 个非数值单元格，' + agg + ' 已忽略这些值'));
    }

    /* ---------- 列定义 + 类型统一 ---------- */
    var defs = [];
    for (i = 0; i < ids.length; i++) defs.push(defOf(df, idIdx[i]));
    for (cj = 0; cj < outNames.length; cj++) {
      var colVals = [];
      for (gi = 0; gi < mat.length; gi++) colVals.push(mat[gi][ids.length + cj]);
      var type;
      if (agg === 'count' || agg === 'sum' || agg === 'mean') type = 'number';
      else if (vtype === 'time' && (agg === 'first' || agg === 'max' || agg === 'min')) type = 'time';
      else type = inferSeriesType(colVals);
      defs.push({ name: outNames[cj], type: type, timeStyle: type === 'time' ? df.cols[vi].timeStyle : null });
    }
    for (gi = 0; gi < mat.length; gi++) {
      for (cj = 0; cj < outNames.length; cj++) {
        var pi = ids.length + cj;
        mat[gi][pi] = castScalar(mat[gi][pi], defs[pi].type);
      }
    }

    notes.push(N('info', 'pivot：' + df.rowCount + ' 行 × ' + df.cols.length + ' 列 → ' +
      mat.length + ' 行 × ' + defs.length + ' 列（聚合 ' + agg + '）'));
    return ret(buildDf(defs, mat), notes);
  }

  /* ==========================================================================
     unpivot：宽 → 长
     ========================================================================== */
  function unpivot(df, opts) {
    opts = opts || {};
    var notes = [];
    if (!isDf(df)) { notes.push(N('warn', 'unpivot：输入不是有效的数据表')); return ret(new YMS.DataFrame([]), notes); }
    if (!df.cols.length) { notes.push(N('warn', 'unpivot：数据表没有列，无法逆透视')); return ret(df.clone(), notes); }

    var varName = opts.varName ? String(opts.varName) : '变量';
    var valName = opts.valName ? String(opts.valName) : '值';
    var i, r;

    /* ---------- 保留列 ---------- */
    var keepRaw = listify(opts.keep), keepIdx = [], missingKeep = [];
    for (i = 0; i < keepRaw.length; i++) {
      var ki = df.colIndex(keepRaw[i]);
      if (ki < 0) missingKeep.push(keepRaw[i]); else keepIdx.push(ki);
    }
    if (missingKeep.length) notes.push(N('warn', 'unpivot：忽略不存在的保留列「' + missingKeep.join('、') + '」'));
    var keepNames = [];
    for (i = 0; i < keepIdx.length; i++) keepNames.push(df.cols[keepIdx[i]].name);

    /* ---------- 值列 ---------- */
    var valRaw = listify(opts.valueCols), valIdx = [], missingVal = [];
    for (i = 0; i < valRaw.length; i++) {
      var vj = df.colIndex(valRaw[i]);
      if (vj < 0) missingVal.push(valRaw[i]); else valIdx.push(vj);
    }
    if (missingVal.length) notes.push(N('warn', 'unpivot：忽略不存在的值列「' + missingVal.join('、') + '」'));
    if (!valIdx.length) {
      for (i = 0; i < df.cols.length; i++) {
        if (keepIdx.indexOf(i) < 0) valIdx.push(i);
      }
      if (valIdx.length) {
        notes.push(N('info', 'unpivot：未指定值列，已展开 ' + valIdx.length + ' 个非保留列'));
      }
    }
    if (!valIdx.length) {
      notes.push(N('warn', 'unpivot：没有可展开的值列（保留列已覆盖全部列）'));
      return ret(df.clone(), notes);
    }

    /* ---------- 值列类型统一 ---------- */
    var typeSet = Object.create(null), typeList = [];
    for (i = 0; i < valIdx.length; i++) {
      var tp = df.cols[valIdx[i]].type;
      if (!typeSet[tp]) { typeSet[tp] = 1; typeList.push(tp); }
    }
    var outType = typeList.length === 1 ? typeList[0] : 'string';
    if (typeList.length > 1) {
      notes.push(N('warn', 'unpivot：值列类型不一致（' + typeList.join('/') + '），值列已统一为字符并转文本'));
    }

    /* ---------- 列名去重 ---------- */
    var used = Object.create(null);
    for (i = 0; i < keepNames.length; i++) used[keepNames[i]] = 1;
    var vn = uniqueName(varName, used); used[vn] = 1;
    var vl = uniqueName(valName, used);
    if (vn !== varName || vl !== valName) {
      notes.push(N('info', 'unpivot：变量/值列名与保留列重名，已改为「' + vn + '」「' + vl + '」'));
    }

    var defs = [];
    for (i = 0; i < keepIdx.length; i++) defs.push(defOf(df, keepIdx[i]));
    defs.push({ name: vn, type: 'string', timeStyle: null });
    defs.push({ name: vl, type: outType, timeStyle: outType === 'time' ? df.cols[valIdx[0]].timeStyle : null });

    var rows = [];
    for (r = 0; r < df.rowCount; r++) {
      for (i = 0; i < valIdx.length; i++) {
        var row = [];
        var j;
        for (j = 0; j < keepIdx.length; j++) row.push(df.cell(keepIdx[j], r));
        row.push(df.cols[valIdx[i]].name);
        row.push(castCell(df, valIdx[i], r, outType));
        rows.push(row);
      }
    }

    notes.push(N('info', 'unpivot：' + df.rowCount + ' 行 × ' + df.cols.length + ' 列 → ' +
      rows.length + ' 行（展开 ' + valIdx.length + ' 个值列）'));
    return ret(buildDf(defs, rows), notes);
  }

  /* ==========================================================================
     transpose：转置（首列「字段」保留原列名，Excel 转置习惯）
     ========================================================================== */
  function transpose(df, opts) {
    opts = opts || {};
    var notes = [];
    if (!isDf(df)) { notes.push(N('warn', 'transpose：输入不是有效的数据表')); return ret(new YMS.DataFrame([]), notes); }
    if (!df.cols.length) { notes.push(N('warn', 'transpose：数据表没有列，无法转置')); return ret(df.clone(), notes); }
    if (!df.rowCount) { notes.push(N('warn', 'transpose：数据表没有数据行，无法转置')); return ret(df.clone(), notes); }

    var headerCol = opts.headerCol ? String(opts.headerCol) : '';
    var hidx = headerCol ? df.colIndex(headerCol) : -1;
    if (headerCol && hidx < 0) {
      notes.push(N('warn', 'transpose：未找到表头列「' + headerCol + '」，改用 A/B/C 序号列名'));
      headerCol = '';
    }

    var srcIdx = [], i, j;
    for (i = 0; i < df.cols.length; i++) if (i !== hidx) srcIdx.push(i);
    if (!srcIdx.length) {
      notes.push(N('warn', 'transpose：除表头列外没有数据列，无法转置'));
      return ret(df.clone(), notes);
    }

    /* 新表头（每个原行一个） */
    var heads = [], used = Object.create(null), renamed = 0;
    used['字段'] = 1;
    for (j = 0; j < df.rowCount; j++) {
      var h = headerCol ? df.cell(hidx, j) : colLetter(j);
      var label = isMissing(h) ? '(空)' : String(h);
      var nm = uniqueName(label, used);
      if (nm !== label) renamed++;
      used[nm] = 1;
      heads.push(nm);
    }
    if (renamed) notes.push(N('warn', 'transpose：新表头有 ' + renamed + ' 个重复/空值，已自动改名为不重复名称'));

    /* 新行 = 原数据列（首列放原列名） */
    var rows = [], mixedCols = 0;
    for (i = 0; i < srcIdx.length; i++) {
      var row = [df.cols[srcIdx[i]].name];
      for (j = 0; j < df.rowCount; j++) row.push(df.cell(srcIdx[i], j));
      rows.push(row);
      if (hasMixedTypes(row.slice(1))) mixedCols++;
    }

    var defs = [{ name: '字段', type: 'string', timeStyle: null }];
    for (j = 0; j < df.rowCount; j++) {
      var colVals = [];
      for (i = 0; i < rows.length; i++) colVals.push(rows[i][j + 1]);
      var type = inferSeriesType(colVals);
      defs.push({ name: heads[j], type: type, timeStyle: null });
      if (type === 'string' && hasMixedTypes(colVals)) mixedCols++;
    }
    if (mixedCols) notes.push(N('warn', 'transpose：转置后存在混合类型列，已统一按字符保存'));

    /* 统一取值 */
    for (i = 0; i < rows.length; i++) {
      for (j = 0; j < heads.length; j++) rows[i][j + 1] = castScalar(rows[i][j + 1], defs[j + 1].type);
    }

    notes.push(N('info', 'transpose：' + df.rowCount + ' 行 × ' + df.cols.length + ' 列 → ' +
      rows.length + ' 行 × ' + defs.length + ' 列（首列「字段」为原列名）'));
    return ret(buildDf(defs, rows), notes);
  }

  /* ==========================================================================
     vconcat：纵向拼接
     ========================================================================== */
  function vconcat(dfs, opts) {
    opts = opts || {};
    var notes = [];
    var mode = opts.mode === 'intersect' ? 'intersect' : 'union';
    var fillRaw = opts.fill === undefined ? null : opts.fill;
    var list = Array.isArray(dfs) ? dfs : (dfs ? [dfs] : []);
    var valid = [], skipped = 0, i, j, r;

    for (i = 0; i < list.length; i++) {
      var d = list[i];
      if (!isDf(d) || !d.cols.length || !d.rowCount) { skipped++; continue; }
      valid.push(d);
    }
    if (skipped) notes.push(N('warn', 'vconcat：跳过 ' + skipped + ' 张空表（无列或 0 行）'));
    if (!valid.length) {
      notes.push(N('warn', 'vconcat：没有可拼接的数据表'));
      return ret(new YMS.DataFrame([]), notes);
    }

    /* 列名（首次出现顺序） */
    var names = [], seen = Object.create(null);
    for (i = 0; i < valid.length; i++) {
      for (j = 0; j < valid[i].cols.length; j++) {
        var n = valid[i].cols[j].name;
        if (!seen[n]) { seen[n] = 1; names.push(n); }
      }
    }
    if (mode === 'intersect') {
      var common = names.filter(function (name) {
        return valid.every(function (d2) { return d2.colIndex(name) >= 0; });
      });
      if (common.length !== names.length) {
        notes.push(N('info', 'vconcat：intersect 只保留 ' + common.length + ' 个共有列，丢弃 ' + (names.length - common.length) + ' 个'));
      }
      names = common;
      if (!names.length) {
        notes.push(N('warn', 'vconcat：各表没有共有列，无法拼接'));
        return ret(new YMS.DataFrame([]), notes);
      }
    }

    /* 列类型统一 */
    var defs = [], conflict = [];
    for (i = 0; i < names.length; i++) {
      var nm = names[i], tset = Object.create(null), types = [], tc = null;
      for (j = 0; j < valid.length; j++) {
        var c = valid[j].col(nm);
        if (!c) continue;
        if (!tset[c.type]) { tset[c.type] = 1; types.push(c.type); }
        if (!tc) tc = c;
      }
      var type = types.length === 1 ? types[0] : 'string';
      if (types.length > 1) conflict.push(nm);
      defs.push({ name: nm, type: type, timeStyle: tc ? tc.timeStyle : null });
    }
    if (conflict.length) {
      notes.push(N('warn', 'vconcat：列「' + conflict.join('、') + '」在各表类型不一致，已统一为字符'));
    }

    var rows = [], filled = 0;
    for (i = 0; i < valid.length; i++) {
      var src = valid[i];
      for (r = 0; r < src.rowCount; r++) {
        var row = [];
        for (j = 0; j < defs.length; j++) {
          var ci = src.colIndex(defs[j].name);
          if (ci < 0) { row.push(castFill(fillRaw, defs[j].type)); filled++; }
          else row.push(castCell(src, ci, r, defs[j].type));
        }
        rows.push(row);
      }
    }
    if (filled) notes.push(N('info', 'vconcat：补齐 ' + filled + ' 个缺失单元格（' + (fillRaw === null ? '空值' : '「' + fillRaw + '」') + '）'));

    notes.push(N('info', 'vconcat：' + valid.length + ' 张表（' + mode + '）→ ' + rows.length + ' 行 × ' + defs.length + ' 列'));
    return ret(buildDf(defs, rows), notes);
  }

  /* ==========================================================================
     hconcat：横向拼接
     ========================================================================== */
  function hconcat(dfs, opts) {
    opts = opts || {};
    var notes = [];
    var mode = opts.mode === 'key' ? 'key' : 'index';
    var fillRaw = opts.fill === undefined ? null : opts.fill;
    var list = Array.isArray(dfs) ? dfs : (dfs ? [dfs] : []);
    var valid = [], skipped = 0, i, j, r;

    for (i = 0; i < list.length; i++) {
      var d = list[i];
      if (!isDf(d) || !d.cols.length) { skipped++; continue; }
      valid.push(d);
    }
    if (skipped) notes.push(N('warn', 'hconcat：跳过 ' + skipped + ' 张空表（无列）'));
    if (!valid.length) {
      notes.push(N('warn', 'hconcat：没有可拼接的数据表'));
      return ret(new YMS.DataFrame([]), notes);
    }

    /* ---------- key 模式：等价 join how='outer' ---------- */
    if (mode === 'key') {
      var key = opts.key ? String(opts.key) : '';
      if (!key) {
        notes.push(N('warn', 'hconcat：key 模式未指定对齐列，已返回第一张表'));
        return ret(valid[0].clone(), notes);
      }
      var acc = valid[0];
      for (i = 1; i < valid.length; i++) {
        var res = join(acc, valid[i], { keys: [key], how: 'outer', suffix: ['_1', '_2'] });
        if (res.notes && res.notes.length) notes = notes.concat(res.notes);
        acc = res.df;
      }
      notes.push(N('info', 'hconcat：按「' + key + '」对齐 ' + valid.length + ' 张表 → ' +
        acc.rowCount + ' 行 × ' + acc.cols.length + ' 列'));
      return ret(acc, notes);
    }

    /* ---------- index 模式：按行号并排 ---------- */
    var maxRows = 0;
    for (i = 0; i < valid.length; i++) maxRows = Math.max(maxRows, valid[i].rowCount);
    var shortTables = [];
    for (i = 0; i < valid.length; i++) if (valid[i].rowCount !== maxRows) shortTables.push(valid[i].rowCount + ' 行');
    if (shortTables.length) {
      notes.push(N('info', 'hconcat：行数不等（最多 ' + maxRows + ' 行），按行号并排，短表补' +
        (fillRaw === null ? '空值' : '「' + fillRaw + '」') + '（' + shortTables.join('、') + '）'));
    }

    /* 重名列统计：出现 >1 次的名字，全部加 _1/_2… 后缀 */
    var count = Object.create(null), occ = Object.create(null), renamed = [], used = Object.create(null);
    for (i = 0; i < valid.length; i++) {
      for (j = 0; j < valid[i].cols.length; j++) {
        var bn = valid[i].cols[j].name;
        count[bn] = (count[bn] || 0) + 1;
      }
    }
    var defs = [], srcs = [];
    for (i = 0; i < valid.length; i++) {
      for (j = 0; j < valid[i].cols.length; j++) {
        var base = valid[i].cols[j].name, nm2 = base;
        if (count[base] > 1) {
          occ[base] = (occ[base] || 0) + 1;
          nm2 = base + '_' + occ[base];
          renamed.push(nm2);
        }
        var fin = uniqueName(nm2, used);
        used[fin] = 1;
        defs.push({ name: fin, type: valid[i].cols[j].type, timeStyle: valid[i].cols[j].timeStyle || null });
        srcs.push({ df: valid[i], ci: j });
      }
    }
    if (renamed.length) notes.push(N('warn', 'hconcat：重名列已加序号后缀（' + renamed.join('、') + '）'));

    var rows = [], filled = 0;
    for (r = 0; r < maxRows; r++) {
      var row = [];
      for (j = 0; j < srcs.length; j++) {
        var s = srcs[j];
        if (r >= s.df.rowCount) { row.push(castFill(fillRaw, defs[j].type)); filled++; }
        else row.push(castCell(s.df, s.ci, r, defs[j].type));
      }
      rows.push(row);
    }
    if (filled) notes.push(N('info', 'hconcat：补齐 ' + filled + ' 个缺失单元格'));

    notes.push(N('info', 'hconcat：' + valid.length + ' 张表（index）→ ' + rows.length + ' 行 × ' + defs.length + ' 列'));
    return ret(buildDf(defs, rows), notes);
  }

  /* ==========================================================================
     join：表连接
     ========================================================================== */
  function join(a, b, opts) {
    opts = opts || {};
    var notes = [];
    var how = String(opts.how || 'inner').toLowerCase();
    if (['inner', 'left', 'right', 'outer'].indexOf(how) < 0) {
      notes.push(N('warn', 'join：不支持的连接方式「' + opts.how + '」，已按 inner 处理'));
      how = 'inner';
    }
    var suffix = (Array.isArray(opts.suffix) && opts.suffix.length >= 2)
      ? [String(opts.suffix[0]), String(opts.suffix[1])] : ['_x', '_y'];
    var nullEqual = opts.nullEqual === true;

    if (!isDf(a)) { notes.push(N('warn', 'join：左表无效')); return ret(new YMS.DataFrame([]), notes); }
    if (!isDf(b) || !b.cols.length) {
      notes.push(N('warn', 'join：右表为空，无法连接，已返回左表'));
      return ret(a.clone(), notes);
    }
    if (!a.cols.length) { notes.push(N('warn', 'join：左表为空，无法连接')); return ret(a.clone(), notes); }

    /* ---------- 键列解析 ---------- */
    var reqKeys = listify(opts.keys), keys = [], i, r, k;
    if (reqKeys.length) {
      var noKey = [];
      for (i = 0; i < reqKeys.length; i++) {
        if (a.colIndex(reqKeys[i]) < 0) noKey.push(reqKeys[i]); else keys.push(reqKeys[i]);
      }
      if (noKey.length) notes.push(N('warn', 'join：左表中不存在键列「' + noKey.join('、') + '」，已忽略'));
    } else {
      /* 自动取同名且类型一致的列 */
      for (i = 0; i < a.cols.length; i++) {
        var cb = b.col(a.cols[i].name);
        if (cb && cb.type === a.cols[i].type) keys.push(a.cols[i].name);
      }
      if (keys.length) notes.push(N('info', 'join：未指定键列，自动使用同名且类型一致的列「' + keys.join('、') + '」'));
    }
    if (!keys.length) {
      notes.push(N('warn', 'join：两表没有同名且类型一致的列可作为键，无法连接，已返回左表'));
      return ret(a.clone(), notes);
    }

    /* 右表缺键列 → 丢弃该键 */
    var bIdx = [], missingB = [];
    for (i = 0; i < keys.length; i++) {
      var bi = b.colIndex(keys[i]);
      if (bi < 0) missingB.push(keys[i]); else bIdx.push(bi);
    }
    if (missingB.length) {
      notes.push(N('warn', 'join：右表缺少键列「' + missingB.join('、') + '」，已忽略该键'));
      keys = keys.filter(function (nm) { return missingB.indexOf(nm) < 0; });
      if (!keys.length) {
        notes.push(N('warn', 'join：没有可用于连接的键列，已返回左表'));
        return ret(a.clone(), notes);
      }
      bIdx = keys.map(function (nm) { return b.colIndex(nm); });
    }
    var aIdx = keys.map(function (nm) { return a.colIndex(nm); });

    /* 键列类型不一致 → 按文本比较 */
    var crossKey = Object.create(null), crossList = [];
    for (i = 0; i < keys.length; i++) {
      if (a.cols[aIdx[i]].type !== b.cols[bIdx[i]].type) {
        crossKey[keys[i]] = 1;
        crossList.push(keys[i] + '（' + a.cols[aIdx[i]].type + '/' + b.cols[bIdx[i]].type + '）');
      }
    }
    if (crossList.length) notes.push(N('warn', 'join：键列类型不一致，已按文本比较：' + crossList.join('、')));

    /* ---------- 右表键索引 ---------- */
    var bMap = Object.create(null), bNullRows = 0;
    for (r = 0; r < b.rowCount; r++) {
      var parts = [], hasNull = false;
      for (i = 0; i < keys.length; i++) {
        var bv = b.cell(bIdx[i], r);
        if (isMissing(bv)) { hasNull = true; parts.push(MISSING_KEY); }
        else parts.push((crossKey[keys[i]] && typeof bv === 'number') ? 's' + numStr(bv) : keyOf(bv));
      }
      if (hasNull && !nullEqual) { bNullRows++; continue; }     /* 默认：空值不匹配任何值 */
      var bk = parts.join(SEP_KEY);
      if (!bMap[bk]) bMap[bk] = [];
      bMap[bk].push(r);
    }
    if (bNullRows) notes.push(N('info', 'join：右表 ' + bNullRows + ' 行键值为空，按 SQL 语义不参与匹配'));

    /* ---------- 左表键计数（多对多检测） ---------- */
    var aKeys = [], aCount = Object.create(null), aNullRows = 0;
    for (r = 0; r < a.rowCount; r++) {
      var ap = [], ah = false;
      for (i = 0; i < keys.length; i++) {
        var av = a.cell(aIdx[i], r);
        if (isMissing(av)) { ah = true; ap.push(MISSING_KEY); }
        else ap.push((crossKey[keys[i]] && typeof av === 'number') ? 's' + numStr(av) : keyOf(av));
      }
      var ak = ap.join(SEP_KEY);
      if (ah && !nullEqual) aNullRows++;
      aKeys.push(ak);
      aCount[ak] = (aCount[ak] || 0) + 1;
    }
    if (aNullRows) notes.push(N('info', 'join：左表 ' + aNullRows + ' 行键值为空，默认不匹配'));

    /* ---------- 配对 ---------- */
    var pairs = [], matchedB = Object.create(null), ampGroups = 0, maxAmp = 1;
    for (r = 0; r < a.rowCount; r++) {
      var brs = bMap[aKeys[r]] || [];
      if (brs.length) {
        for (k = 0; k < brs.length; k++) { pairs.push([r, brs[k]]); matchedB[brs[k]] = 1; }
        if (aCount[aKeys[r]] > 1 && brs.length > 1) {
          ampGroups++;
          maxAmp = Math.max(maxAmp, aCount[aKeys[r]] * brs.length);
        }
      } else if (how === 'left' || how === 'outer') {
        pairs.push([r, -1]);
      }
    }
    if (how === 'right' || how === 'outer') {
      for (r = 0; r < b.rowCount; r++) if (!matchedB[r]) pairs.push([-1, r]);
    }
    if (!pairs.length) notes.push(N('warn', 'join：两表没有匹配的行（结果 0 行）'));
    if (ampGroups) {
      notes.push(N('warn', 'join：存在 ' + ampGroups + ' 组多对多键，行数放大（最多 ' + maxAmp + ' 行/键），结果共 ' +
        pairs.length + ' 行'));
    }

    /* ---------- 输出列 ---------- */
    var defs = [], srcs = [], used = Object.create(null), renamed = [];
    for (i = 0; i < a.cols.length; i++) {
      var aName = a.cols[i].name, isKey = keys.indexOf(aName) >= 0;
      var outName = aName;
      if (!isKey && b.colIndex(aName) >= 0) outName = aName + suffix[0];
      var fin = uniqueName(outName, used);
      if (fin !== outName) renamed.push(outName + ' → ' + fin);
      used[fin] = 1;
      defs.push({ name: fin, type: a.cols[i].type, timeStyle: a.cols[i].timeStyle || null });
      srcs.push({ side: 'a', ci: i, keyIdx: isKey ? keys.indexOf(aName) : -1 });
    }
    for (i = 0; i < b.cols.length; i++) {
      var bName = b.cols[i].name;
      if (keys.indexOf(bName) >= 0) continue;                    /* 键列只保留一份（取左侧） */
      var oName = (a.colIndex(bName) >= 0) ? bName + suffix[1] : bName;
      var f2 = uniqueName(oName, used);
      if (f2 !== oName) renamed.push(oName + ' → ' + f2);
      used[f2] = 1;
      defs.push({ name: f2, type: b.cols[i].type, timeStyle: b.cols[i].timeStyle || null });
      srcs.push({ side: 'b', ci: i, keyIdx: -1 });
    }
    if (renamed.length) notes.push(N('warn', 'join：同名列已加后缀（' + renamed.join('；') + '）'));

    /* ---------- 输出行 ---------- */
    var rows = [];
    for (i = 0; i < pairs.length; i++) {
      var li = pairs[i][0], ri = pairs[i][1], row = [];
      for (k = 0; k < defs.length; k++) {
        var s = srcs[k], dv = null;
        if (s.side === 'a') {
          if (li >= 0) dv = castCell(a, s.ci, li, defs[k].type);
          else if (s.keyIdx >= 0) dv = castCell(b, bIdx[s.keyIdx], ri, defs[k].type);  /* 未匹配右行：键取自右表 */
          else dv = null;
        } else {
          dv = ri >= 0 ? castCell(b, s.ci, ri, defs[k].type) : null;
        }
        row.push(dv);
      }
      rows.push(row);
    }

    notes.push(N('info', 'join：' + how.toUpperCase() + ' → ' + rows.length + ' 行 × ' + defs.length +
      ' 列（键：' + keys.join('、') + '）'));
    return ret(buildDf(defs, rows), notes);
  }

  /* ==========================================================================
     splitColumn：分列
     ========================================================================== */
  function splitColumn(df, opts) {
    opts = opts || {};
    var notes = [];
    if (!isDf(df)) { notes.push(N('warn', 'splitColumn：输入不是有效的数据表')); return ret(new YMS.DataFrame([]), notes); }
    if (!df.cols.length) { notes.push(N('warn', 'splitColumn：数据表没有列，无法分列')); return ret(df.clone(), notes); }

    var colName = opts.col ? String(opts.col) : '';
    var ci = colName ? df.colIndex(colName) : -1;
    if (ci < 0) {
      notes.push(N('warn', 'splitColumn：未找到列「' + (colName || '（未指定）') + '」'));
      return ret(df.clone(), notes);
    }

    var limit = Math.max(0, Math.floor(Number(opts.limit) || 0));
    var sep = (opts.sep === undefined || opts.sep === null || opts.sep === '') ? ',' : String(opts.sep);
    if (opts.sep === undefined || opts.sep === null || opts.sep === '') {
      notes.push(N('info', 'splitColumn：未指定分隔符，默认使用「,」'));
    }

    var chunks = [], maxN = 0, found = 0, r, i, k;
    for (r = 0; r < df.rowCount; r++) {
      var v = df.cell(ci, r);
      if (v === null) { chunks.push(null); continue; }
      var text = (df.cols[ci].type === 'time') ? fmtTime(v, df.cols[ci].timeStyle)
        : (df.cols[ci].type === 'number' ? numStr(v) : String(v));
      var parts = text.split(sep);
      if (parts.length > 1) found++;
      if (limit > 0 && parts.length > limit) {
        parts = parts.slice(0, limit - 1).concat([parts.slice(limit - 1).join(sep)]);
      }
      if (parts.length > maxN) maxN = parts.length;
      chunks.push(parts);
    }
    if (!maxN) {
      notes.push(N('warn', 'splitColumn：列「' + colName + '」全为空值，无法拆分'));
      return ret(df.clone(), notes);
    }
    if (!found) notes.push(N('warn', 'splitColumn：没有任何行包含分隔符「' + sep + '」，仅拆出 1 列'));
    if (limit > 0) notes.push(N('info', 'splitColumn：最多拆 ' + limit + ' 份，超出部分保留在最后一列'));

    /* 新列名 + 类型 */
    var used = Object.create(null);
    for (i = 0; i < df.cols.length; i++) used[df.cols[i].name] = 1;
    var newDefs = [], renamed = [];
    for (k = 0; k < maxN; k++) {
      var nb = colName + '_' + (k + 1);
      var nn = uniqueName(nb, used);
      if (nn !== nb) renamed.push(nb + ' → ' + nn);
      used[nn] = 1;
      var vals = [];
      for (r = 0; r < chunks.length; r++) {
        if (chunks[r] && k < chunks[r].length) vals.push(chunks[r][k]);
      }
      var numeric = vals.length > 0, j;
      for (j = 0; j < vals.length; j++) {
        var pn = T.parseNumber(vals[j]);
        if (pn !== pn) { numeric = false; break; }
      }
      newDefs.push({ name: nn, type: numeric ? 'number' : 'string', timeStyle: null });
    }
    if (renamed.length) notes.push(N('warn', 'splitColumn：新列名与已有列重名，已改名（' + renamed.join('；') + '）'));

    /* 组装（新列紧跟源列，源列保留） */
    var defs = [];
    for (i = 0; i < df.cols.length; i++) {
      defs.push(defOf(df, i));
      if (i === ci) for (k = 0; k < newDefs.length; k++) defs.push(newDefs[k]);
    }
    var rows = [];
    for (r = 0; r < df.rowCount; r++) {
      var row = [];
      for (i = 0; i < df.cols.length; i++) {
        row.push(df.cell(i, r));
        if (i === ci) {
          for (k = 0; k < maxN; k++) {
            var part = (chunks[r] && k < chunks[r].length) ? chunks[r][k] : null;
            row.push(castScalar(part, newDefs[k].type));
          }
        }
      }
      rows.push(row);
    }

    notes.push(N('info', 'splitColumn：列「' + colName + '」→ ' + maxN + ' 列（' + df.rowCount + ' 行）'));
    return ret(buildDf(defs, rows), notes);
  }

  /* ==========================================================================
     mergeColumns：合并列
     ========================================================================== */
  function mergeColumns(df, opts) {
    opts = opts || {};
    var notes = [];
    if (!isDf(df)) { notes.push(N('warn', 'mergeColumns：输入不是有效的数据表')); return ret(new YMS.DataFrame([]), notes); }
    if (!df.cols.length) { notes.push(N('warn', 'mergeColumns：数据表没有列，无法合并')); return ret(df.clone(), notes); }

    var cols = listify(opts.cols), idxs = [], missing = [], i, r, k;
    for (i = 0; i < cols.length; i++) {
      var ci = df.colIndex(cols[i]);
      if (ci < 0) missing.push(cols[i]); else if (idxs.indexOf(ci) < 0) idxs.push(ci);
    }
    if (missing.length) notes.push(N('warn', 'mergeColumns：忽略不存在的列「' + missing.join('、') + '」'));
    if (!idxs.length) {
      notes.push(N('warn', 'mergeColumns：没有可合并的列'));
      return ret(df.clone(), notes);
    }
    cols = idxs.map(function (x) { return df.cols[x].name; });

    var sep = (opts.sep === undefined || opts.sep === null) ? '-' : String(opts.sep);
    var drop = opts.drop !== false;
    var baseName = opts.name ? String(opts.name) : cols.join('_');

    /* 结果列名（被删除的源列不占名） */
    var used = Object.create(null);
    for (i = 0; i < df.cols.length; i++) {
      if (drop && idxs.indexOf(i) >= 0) continue;
      used[df.cols[i].name] = 1;
    }
    var outName = uniqueName(baseName, used);
    if (outName !== baseName) notes.push(N('warn', 'mergeColumns：结果列名「' + baseName + '」已存在，改用「' + outName + '」'));

    /* 合并值（全部为空 → null；数值按原样转字符串） */
    var merged = [], emptyRows = 0;
    for (r = 0; r < df.rowCount; r++) {
      var parts = [];
      for (k = 0; k < idxs.length; k++) {
        var s = cellStr(df, idxs[k], r);
        if (s === null || s === '') continue;
        parts.push(s);
      }
      if (!parts.length) { emptyRows++; merged.push(null); }
      else merged.push(parts.join(sep));
    }
    if (emptyRows) notes.push(N('info', 'mergeColumns：' + emptyRows + ' 行所有源列均为空，结果记为空值'));

    /* 组装（drop=true 时插到首个源列位置） */
    var keepIdx = [], insertedPos = 0;
    for (i = 0; i < df.cols.length; i++) if (!(drop && idxs.indexOf(i) >= 0)) keepIdx.push(i);
    if (drop) {
      var minIdx = Math.min.apply(null, idxs);
      insertedPos = 0;
      for (i = 0; i < keepIdx.length; i++) if (keepIdx[i] < minIdx) insertedPos++;
    } else {
      insertedPos = keepIdx.length;
    }

    var order = [];
    for (i = 0; i < keepIdx.length; i++) order.push(keepIdx[i]);
    order.splice(insertedPos, 0, -1);                            /* -1 = 合并列占位 */

    var defs = [], rows = [];
    for (i = 0; i < order.length; i++) {
      defs.push(order[i] < 0 ? { name: outName, type: 'string', timeStyle: null } : defOf(df, order[i]));
    }
    for (r = 0; r < df.rowCount; r++) {
      var row = [];
      for (i = 0; i < order.length; i++) row.push(order[i] < 0 ? merged[r] : df.cell(order[i], r));
      rows.push(row);
    }

    notes.push(N('info', 'mergeColumns：' + idxs.length + ' 列 → 「' + outName + '」' + (drop ? '（已删除源列）' : '')));
    return ret(buildDf(defs, rows), notes);
  }

  /* ==========================================================================
     groupAggregate：分组汇总
     ========================================================================== */
  function groupAggregate(df, opts) {
    opts = opts || {};
    var notes = [];
    if (!isDf(df)) { notes.push(N('warn', 'groupAggregate：输入不是有效的数据表')); return ret(new YMS.DataFrame([]), notes); }
    if (!df.cols.length) { notes.push(N('warn', 'groupAggregate：数据表没有列，无法汇总')); return ret(df.clone(), notes); }

    var byRaw = listify(opts.by), byIdx = [], missingBy = [], i, r, k;
    for (i = 0; i < byRaw.length; i++) {
      var bi = df.colIndex(byRaw[i]);
      if (bi < 0) missingBy.push(byRaw[i]); else byIdx.push(bi);
    }
    if (missingBy.length) notes.push(N('warn', 'groupAggregate：忽略不存在的分组列「' + missingBy.join('、') + '」'));
    var byNames = byIdx.map(function (ci) { return df.cols[ci].name; });

    var aggs = [];
    if (Array.isArray(opts.aggs)) {
      for (i = 0; i < opts.aggs.length; i++) {
        var a = opts.aggs[i];
        if (!a || !a.col) continue;
        aggs.push(a);
      }
    }
    if (!aggs.length) {
      notes.push(N('warn', 'groupAggregate：未指定汇总项，仅输出分组列的组合'));
    }
    if (!byIdx.length && !aggs.length) {
      notes.push(N('warn', 'groupAggregate：既没有分组列也没有汇总项，已返回原表'));
      return ret(df.clone(), notes);
    }

    /* ---------- 分组 ---------- */
    var groups = [], gmap = Object.create(null);
    if (!byIdx.length) {
      notes.push(N('info', 'groupAggregate：未指定分组列，按全表汇总为 1 行'));
      var all = { vals: [], rows: [] };
      for (r = 0; r < df.rowCount; r++) all.rows.push(r);
      groups.push(all);
    } else {
      for (r = 0; r < df.rowCount; r++) {
        var gp = [], gv = [];
        for (i = 0; i < byIdx.length; i++) { var cv = df.cell(byIdx[i], r); gp.push(keyOf(cv)); gv.push(cv); }
        var gk = gp.join(SEP_KEY);
        var g = gmap[gk];
        if (!g) { g = { vals: gv, rows: [] }; gmap[gk] = g; groups.push(g); }
        g.rows.push(r);
      }
    }

    /* ---------- 汇总列 ---------- */
    var defs = [], colValsList = [], used = Object.create(null);
    for (i = 0; i < byIdx.length; i++) {
      var d = defOf(df, byIdx[i]);
      d.name = uniqueName(d.name, used);
      used[d.name] = 1;
      defs.push(d);
    }

    for (i = 0; i < aggs.length; i++) {
      var spec = aggs[i];
      var fn = String(spec.fn || 'count').toLowerCase();
      if (GROUP_FN.indexOf(fn) < 0) {
        notes.push(N('warn', 'groupAggregate：不支持的汇总函数「' + spec.fn + '」，已按 count 处理'));
        fn = 'count';
      }
      var cname = String(spec.col);
      var ci = df.colIndex(cname);
      var ctype = ci >= 0 ? df.cols[ci].type : 'string';
      var nm = spec.name ? String(spec.name) : (fn + '(' + cname + ')');
      var type;
      if (fn === 'count' || fn === 'nunique' || fn === 'sum' || fn === 'mean' || fn === 'std') type = 'number';
      else type = (ctype === 'number' || ctype === 'time') ? ctype : 'string';

      var vals = [], nonNum = 0, noNum = 0, gi;
      for (gi = 0; gi < groups.length; gi++) {
        if (ci < 0) { vals.push(null); continue; }
        var src = [];
        for (k = 0; k < groups[gi].rows.length; k++) src.push(df.cell(ci, groups[gi].rows[k]));
        var res = computeAgg(src, fn, false);
        if (res.nonNumeric > 0 && (fn === 'sum' || fn === 'mean' || fn === 'std')) nonNum += res.nonNumeric;
        if (res.value === null && src.length && (fn === 'sum' || fn === 'mean' || fn === 'std')) noNum++;
        vals.push(res.value);
      }
      if (ci < 0) notes.push(N('warn', 'groupAggregate：汇总列「' + cname + '」不存在，该列输出空值'));
      if (nonNum) {
        notes.push(N('warn', 'groupAggregate：列「' + cname + '」含 ' + nonNum + ' 个非数值单元格，' + fn + ' 已忽略'));
      } else if (noNum) {
        notes.push(N('warn', 'groupAggregate：列「' + cname + '」没有可' + fn + '的数值，结果记为空值'));
      }

      var fname = uniqueName(nm, used);
      if (fname !== nm) notes.push(N('info', 'groupAggregate：汇总列名「' + nm + '」已存在，改用「' + fname + '」'));
      used[fname] = 1;
      defs.push({ name: fname, type: type, timeStyle: type === 'time' ? df.cols[ci].timeStyle : null });
      colValsList.push(vals);
    }

    /* ---------- 输出 ---------- */
    var rows = [], gi2;
    for (gi2 = 0; gi2 < groups.length; gi2++) {
      var row = [];
      for (i = 0; i < byIdx.length; i++) row.push(castScalar(groups[gi2].vals[i], defs[i].type));
      for (i = 0; i < colValsList.length; i++) {
        row.push(castScalar(colValsList[i][gi2], defs[byIdx.length + i].type));
      }
      rows.push(row);
    }

    notes.push(N('info', 'groupAggregate：' + df.rowCount + ' 行 → ' + rows.length + ' 组 × ' +
      (defs.length) + ' 列（' + (byNames.length ? '按 ' + byNames.join('、') : '全表') + '）'));
    return ret(buildDf(defs, rows), notes);
  }

  /* ==========================================================================
     dedupe：去重
     ========================================================================== */
  function dedupe(df, opts) {
    opts = opts || {};
    var notes = [];
    if (!isDf(df)) { notes.push(N('warn', 'dedupe：输入不是有效的数据表')); return ret(new YMS.DataFrame([]), notes); }
    if (!df.cols.length) { notes.push(N('warn', 'dedupe：数据表没有列，无法去重')); return ret(df.clone(), notes); }

    var cols = listify(opts.cols), idxs = [], missing = [], i, r;
    for (i = 0; i < cols.length; i++) {
      var ci = df.colIndex(cols[i]);
      if (ci < 0) missing.push(cols[i]); else idxs.push(ci);
    }
    if (missing.length) notes.push(N('warn', 'dedupe：忽略不存在的列「' + missing.join('、') + '」'));
    if (!idxs.length) {
      for (i = 0; i < df.cols.length; i++) idxs.push(i);
      notes.push(N('info', 'dedupe：未指定列，按整行判重'));
    }
    var keep = opts.keep === 'last' ? 'last' : 'first';

    var seen = Object.create(null), keepIdx = [], k;
    if (keep === 'first') {
      for (r = 0; r < df.rowCount; r++) {
        var pk = [];
        for (k = 0; k < idxs.length; k++) pk.push(keyOf(df.cell(idxs[k], r)));
        var key = pk.join(SEP_KEY);
        if (seen[key]) continue;
        seen[key] = 1;
        keepIdx.push(r);
      }
    } else {
      for (r = df.rowCount - 1; r >= 0; r--) {
        var pk2 = [];
        for (k = 0; k < idxs.length; k++) pk2.push(keyOf(df.cell(idxs[k], r)));
        var key2 = pk2.join(SEP_KEY);
        if (seen[key2]) continue;
        seen[key2] = 1;
        keepIdx.push(r);
      }
      keepIdx.reverse();
    }

    var removed = df.rowCount - keepIdx.length;
    if (removed > 0) {
      notes.push(N('info', 'dedupe：删除 ' + removed + ' 行重复数据（保留' + (keep === 'last' ? '末行' : '首行') + '）'));
    } else {
      notes.push(N('info', 'dedupe：没有重复行（' + df.rowCount + ' 行）'));
    }
    return ret(df.subset(keepIdx), notes);
  }

  /* ------------------------------------------------------------------ 导出 */
  /** 派生表名后缀（契约 §3） */
  function suffixFor(kind, how) {
    if (kind === 'join') {
      var h = String(how || 'inner').toLowerCase();
      if (h === 'left') return SUFFIX.joinLeft;
      if (h === 'right') return SUFFIX.joinRight;
      if (h === 'outer') return SUFFIX.joinOuter;
      return SUFFIX.join;
    }
    return SUFFIX[kind] || '';
  }

  YMS.Transform = {
    pivot: pivot,
    unpivot: unpivot,
    transpose: transpose,
    vconcat: vconcat,
    hconcat: hconcat,
    join: join,
    splitColumn: splitColumn,
    mergeColumns: mergeColumns,
    groupAggregate: groupAggregate,
    dedupe: dedupe,
    SUFFIX: SUFFIX,
    suffixFor: suffixFor
  };
})(typeof window !== 'undefined' ? window : this);
