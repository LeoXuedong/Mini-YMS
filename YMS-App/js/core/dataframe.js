/* ==========================================================================
   YMS · core/dataframe.js
   列式数据容器（性能优先）：
     · number / time 列 → Float64Array（缺失 = NaN）
     · string 列        → 字典编码 Int32Array + dict: string[]（缺失 = -1）
   典型 6000 行数据占用 < 1 MB；百万行数据 < 100 MB；支持流式增量构建。
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var T = YMS.types;

  /* --------------------------------------------------------------- 列 */
  function Column(name, type, values, dict, timeStyle) {
    this.name = name;
    this.type = type;               // 'number' | 'time' | 'string'
    this.values = values;           // Float64Array | Int32Array
    this.dict = dict || null;       // string[] | null
    this.timeStyle = timeStyle || null;
    this.missing = 0;               // 缺失计数（构建/修改时维护）
    this._stats = null;
    /* M-1 原值/计算值分离：仅当原文被改写时才记录（'95%' 存成 0.95，表格仍显示 95%）。
       数组按行下标稀疏存放显示原文，null = 没有改写（按数值格式化显示）。 */
    this.rawText = null;
    /* 分组映射（按值分组）派生的列在这里记住自己的「配方」，随 .yms 一起持久化：
         order     = 类目顺序（组名按用户排列的顺序，未分配值在末位）——
                     绘图横轴严格按它排（见 plot/aggregate.js 的 orderCategories）
         groupMap  = {sourceCol, targetCol, groups[], map{}, unassigned, otherLabel}
       两字段只在分组派生列上非空，普通列恒为 null（旧代码完全不受影响）。 */
    this.order = null;
    this.groupMap = null;
  }
  Column.prototype.len = function () { return this.values.length; };

  /* ------------------------------------------------------------- DataFrame */
  function DataFrame(cols) {
    this.cols = cols || [];
    this.rowCount = this.cols.length ? this.cols[0].values.length : 0;
  }

  DataFrame.prototype.colIndex = function (name) {
    for (var i = 0; i < this.cols.length; i++) if (this.cols[i].name === name) return i;
    return -1;
  };
  DataFrame.prototype.col = function (name) {
    var i = this.colIndex(name);
    return i < 0 ? null : this.cols[i];
  };
  DataFrame.prototype.colNames = function () { return this.cols.map(function (c) { return c.name; }); };

  /** 原始存储值：number/time → number（NaN=缺失）；string → 字典下标（-1=缺失） */
  DataFrame.prototype.raw = function (ci, ri) { return this.cols[ci].values[ri]; };

  /** 取 JS 值：number → number；time → epoch ms(number)；string → string；缺失 → null */
  DataFrame.prototype.cell = function (ci, ri) {
    var c = this.cols[ci];
    if (!c) return null;
    var v = c.values[ri];
    if (c.type === T.STRING) return v < 0 ? null : c.dict[v];
    return (typeof v === 'number' && YMS.num.isMissing(v)) ? null : v;   /* NaN / ±Infinity → 缺失 */
  };

  DataFrame.prototype.setCell = function (ci, ri, v) {
    var c = this.cols[ci];
    if (!c) return;
    if (c.rawText) c.rawText[ri] = undefined;      /* 值被改写 → 丢弃该行的显示原文 */
    if (c.type === T.STRING) {
      if (v === null || v === undefined || v === '') { c.values[ri] = -1; }
      else {
        var s = String(v);
        var idx = c.dict.indexOf(s);              // 字典很小，线性查找足够快（构建期走 Map）
        if (idx < 0) { c.dict.push(s); idx = c.dict.length - 1; }
        c.values[ri] = idx;
      }
    } else {
      var n = (v === null || v === undefined || v === '') ? NaN : Number(v);
      if (!isFinite(n)) n = NaN;                 /* 非有限值一律按缺失写入 */
      c.values[ri] = n;
    }
    c._stats = null;
    this._recount(c);
  };

  DataFrame.prototype.setRaw = function (ci, ri, rawValue, dictEntry) {
    var c = this.cols[ci];
    if (c.type === T.STRING && dictEntry !== undefined) {
      var idx = c.dict.indexOf(dictEntry);
      if (idx < 0) { c.dict.push(dictEntry); idx = c.dict.length - 1; }
      c.values[ri] = idx;
    } else {
      c.values[ri] = rawValue;
    }
    c._stats = null;
    this._recount(c);
  };

  DataFrame.prototype._recount = function (c) {
    var miss = 0, v = c.values;
    if (c.type === T.STRING) { for (var i = 0; i < v.length; i++) if (v[i] < 0) miss++; }
    else { for (var j = 0; j < v.length; j++) if (YMS.num.isMissing(v[j])) miss++; }   /* NaN / ±Infinity */
    c.missing = miss;
  };

  DataFrame.prototype.refreshMissing = function () {
    for (var i = 0; i < this.cols.length; i++) this._recount(this.cols[i]);
  };

  /** 追加一列（values 长度必须等于 rowCount）
   *  按值分组的派生列可额外带 order / groupMap（见 Column 构造函数的说明） */
  DataFrame.prototype.addColumn = function (def) {
    var c = new Column(def.name, def.type, def.values, def.dict || null, def.timeStyle || null);
    if (def.order && def.order.length) c.order = def.order.slice();
    if (def.groupMap) c.groupMap = def.groupMap;
    this._recount(c);
    this.cols.push(c);
    if (!this.rowCount) this.rowCount = c.values.length;
    return c;
  };
  DataFrame.prototype.removeColumn = function (name) {
    var i = this.colIndex(name);
    if (i < 0) return false;
    this.cols.splice(i, 1);
    return true;
  };
  /**
   * 重命名列。M-4：失败原因写进 lastRenameError（不再静默 return false）
   * @returns {boolean} 是否成功
   */
  DataFrame.prototype.renameColumn = function (oldName, newName) {
    var c = this.col(oldName);
    if (!c) { this.lastRenameError = '列名「' + oldName + '」不存在'; return false; }
    if (newName !== oldName && this.colIndex(newName) >= 0) {
      this.lastRenameError = (YMS.colNames && YMS.colNames.taken) ? YMS.colNames.taken(newName)
        : ('列名「' + newName + '」已存在，请换一个');
      return false;
    }
    this.lastRenameError = null;
    c.name = newName;
    c._stats = null;
    return true;
  };

  /** 增量均值（Welford 一阶式）：sum 溢出时兜底，1e308 量级仍返回有限值 */
  function incrementalMean(arr, n) {
    var m = 0, k = 0, i;
    for (i = 0; i < n; i++) {
      var v = arr[i];
      if (YMS.num.isMissing(v)) continue;
      k++;
      m += (v - m) / k;
    }
    return k ? m : null;
  }

  /**
   * 列统计（缓存）—— 参数属性面板 / 报告 / 图表标注使用
   * 标准差为总体标准差（分母 N）
   */
  DataFrame.prototype.stats = function (ci) {
    var c = this.cols[ci];
    if (!c) return null;
    if (c._stats) return c._stats;
    var n = this.rowCount, st = {
      name: c.name, type: c.type, total: n, valid: 0, missing: 0, unique: 0,
      min: null, max: null, mean: null, median: null, stddev: null, note: null
    };
    var i;
    if (c.type === T.STRING) {
      var seen = new Set(), v = c.values;
      for (i = 0; i < n; i++) {
        var k = v[i];
        if (k < 0) { st.missing++; continue; }
        st.valid++; seen.add(k);
      }
      st.unique = seen.size;
    } else {
      var arr = c.values, cnt = 0, sum = 0, mn = Infinity, mx = -Infinity;
      for (i = 0; i < n; i++) {
        var x = arr[i];
        if (YMS.num.isMissing(x)) { st.missing++; continue; }   /* NaN / ±Infinity */
        cnt++; sum += x;
        if (x < mn) mn = x;
        if (x > mx) mx = x;
      }
      st.valid = cnt;
      if (cnt > 0) {
        var mean = sum / cnt;
        /* 累加可能溢出（1e308 + 1e308 = ∞）：正常数据走上面的直算，结果非有限才兜底 */
        if (!isFinite(mean)) mean = incrementalMean(arr, n);
        st.min = mn; st.max = mx; st.mean = mean;
        var ss = 0, buf = new Float64Array(cnt), p = 0;
        for (i = 0; i < n; i++) {
          var y = arr[i];
          if (YMS.num.isMissing(y)) continue;
          var dv = y - mean;
          ss += dv * dv;
          buf[p++] = y;
        }
        st.stddev = Math.sqrt(ss / cnt);
        if (!isFinite(st.stddev)) {                 /* |值| 过大，平方和溢出：宁可空也不出 ∞ */
          st.stddev = null;
          st.note = '标准差超出数值范围（|值| 过大）';
        }
        buf.sort();
        var med = cnt % 2 ? buf[(cnt - 1) / 2] : (buf[cnt / 2 - 1] + buf[cnt / 2]) / 2;
        if (!isFinite(med) && cnt % 2 === 0) med = buf[cnt / 2 - 1] / 2 + buf[cnt / 2] / 2;   /* 1e308 相加溢出兜底 */
        st.median = med;
        if (cnt <= 2000000) {
          var st2 = new Set();
          for (i = 0; i < n; i++) { var z = arr[i]; if (!YMS.num.isMissing(z)) st2.add(z); }
          st.unique = st2.size;
        } else { st.unique = null; st.note = '唯一值统计已跳过（有效值 > 200 万）'; }
      } else { st.unique = 0; }
    }
    c._stats = st;
    return st;
  };

  /** 按列去重（保留首行）；缺失值视为同一取值，仅保留首次出现 */
  DataFrame.prototype.dedupeBy = function (ci) {
    var c = this.cols[ci];
    if (!c) return this;
    var seen = new Set(), keep = [], i, v = c.values;
    for (i = 0; i < this.rowCount; i++) {
      var k = v[i];
      if (c.type === T.STRING && k < 0) k = '__MISSING__';
      if (c.type !== T.STRING && YMS.num.isMissing(k)) k = '__MISSING__';   /* NaN / ±Infinity 同归缺失 */
      if (!seen.has(k)) { seen.add(k); keep.push(i); }
    }
    if (keep.length === this.rowCount) return this;
    return this.subset(keep);
  };

  /** 按行下标取子集（生成新 DataFrame；列数据被复制） */
  DataFrame.prototype.subset = function (rowIdx) {
    var m = rowIdx.length, cols = this.cols, out = [], i, j;
    for (i = 0; i < cols.length; i++) {
      var c = cols[i], nc;
      if (c.type === T.STRING) {
        var nv = new Int32Array(m);
        for (j = 0; j < m; j++) nv[j] = c.values[rowIdx[j]];
        nc = new Column(c.name, c.type, nv, c.dict.slice(), c.timeStyle);
      } else {
        var fv = new Float64Array(m);
        for (j = 0; j < m; j++) fv[j] = c.values[rowIdx[j]];
        nc = new Column(c.name, c.type, fv, null, c.timeStyle);
      }
      /* M-1：显示原文随行子集一起搬（否则筛选/去重后 95% 又变回 0.95） */
      if (c.rawText) {
        nc.rawText = new Array(m);
        for (j = 0; j < m; j++) nc.rawText[j] = c.rawText[rowIdx[j]];
      }
      /* 分组派生列的类目顺序 / 配方随列一起搬（子集不改组定义，只换行） */
      if (c.order) nc.order = c.order.slice();
      if (c.groupMap) nc.groupMap = JSON.parse(JSON.stringify(c.groupMap));
      out.push(nc);
    }
    var df = new DataFrame(out);
    df.refreshMissing();
    return df;
  };

  DataFrame.prototype.clone = function () {
    return this.subset(Array.from({ length: this.rowCount }, function (_, i) { return i; }));
  };

  /* ==========================================================================
     DFBuilder：流式增量构建（导入大数据不产生中间 JS 数组，内存 ≈ 最终占用）
     ========================================================================== */
  function GrowF64() { this.buf = new Float64Array(8192); this.n = 0; }
  GrowF64.prototype.push = function (v) {
    if (this.n === this.buf.length) { var nb = new Float64Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    this.buf[this.n++] = v;
  };
  GrowF64.prototype.finish = function () { return this.buf.length === this.n ? this.buf : this.buf.slice(0, this.n); };

  function GrowI32() { this.buf = new Int32Array(8192); this.n = 0; }
  GrowI32.prototype.push = function (v) {
    if (this.n === this.buf.length) { var nb = new Int32Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    this.buf[this.n++] = v;
  };
  GrowI32.prototype.finish = function () { return this.buf.length === this.n ? this.buf : this.buf.slice(0, this.n); };

  /**
   * @param {Array<{name:string,type:string,timeStyle?:string}>} defs
   */
  function DFBuilder(defs) {
    this.defs = defs;
    this.n = 0;
    this.missCount = new Int32Array(defs.length);
    this._bufs = defs.map(function (d) {
      if (d.type === T.STRING) return { kind: 'string', idx: new GrowI32(), dictMap: new Map(), dictList: [] };
      return { kind: 'number', arr: new GrowF64() };
    });
    this._cur = new Array(defs.length);
  }

  DFBuilder.prototype.rowCount = function () { return this.n; };

  /** 单值写入：数值列传 number（NaN=缺失）；字符列传 string（''/null=缺失） */
  DFBuilder.prototype.set = function (ci, v) {
    var b = this._bufs[ci];
    if (b.kind === 'string') {
      if (v === null || v === undefined || v === '') { b.idx.push(-1); this.missCount[ci]++; return; }
      var s = typeof v === 'string' ? v : String(v);
      var key = b.dictMap.get(s);
      if (key === undefined) { key = b.dictList.length; b.dictMap.set(s, key); b.dictList.push(s); }
      b.idx.push(key);
    } else {
      var num = (typeof v === 'number') ? v : T.parseNumber(v);
      if (!isFinite(num)) { num = NaN; this.missCount[ci]++; }   /* NaN / ±Infinity 一律按缺失入库 */
      b.arr.push(num);
    }
  };

  DFBuilder.prototype.setMissing = function (ci) {
    var b = this._bufs[ci];
    if (b.kind === 'string') b.idx.push(-1); else b.arr.push(NaN);
    this.missCount[ci]++;
  };

  /** 每行结束时提交（保证各列长度一致 + 行计数） */
  DFBuilder.prototype.endRow = function () { this.n++; };

  DFBuilder.prototype.finish = function () {
    var self = this;
    var cols = this.defs.map(function (d, ci) {
      var b = self._bufs[ci];
      if (b.kind === 'string') {
        var c = new Column(d.name, T.STRING, b.idx.finish(), b.dictList, d.timeStyle || null);
        c.missing = self.missCount[ci];
        return c;
      }
      var c2 = new Column(d.name, d.type, b.arr.finish(), null, d.timeStyle || null);
      c2.missing = self.missCount[ci];
      return c2;
    });
    this._bufs = null;
    return new DataFrame(cols);
  };

  /* ==========================================================================
     M-4：列名唯一化（单一入口）
     重复列名会在 DataFrame.colIndex() 里永远只命中首次出现的列 —— 改名 / 改格式 /
     计算列 / 绘图全部悄悄落到另一列上。因此所有建表入口（CSV/TXT 解析、Excel
     工作表、.yms 模板）都在此处统一改名，不各自实现一套。
     ========================================================================== */
  /**
   * 按出现顺序去重改名：第 2 个起加 `_2`、`_3`…（已占用的名字一律避让）
   *   A,A,B    → A, A_2, B
   *   A,A,A    → A, A_2, A_3
   *   A,A_2,A  → A, A_2, A_3   （第 3 个 A 避让已被第 2 列占用的 A_2）
   * 确定性：纯函数，同一输入必得同一输出（不依赖时间/随机/外部状态）
   * @param {Array<string>} names 原始列名（去空格 / 空名补 ColN 由调用方完成）
   * @returns {{names:Array<string>, renamed:Array<{from:string,to:string,index:number}>, count:number}}
   *          count = 被改名的列数；index 为 0 基列序（提示文案里显示 +1）
   */
  function uniqueNames(names) {
    var list = names || [];
    var used = {};                        /* 已被占用的最终列名 */
    var out = [], renamed = [], i, base, name, k;
    for (i = 0; i < list.length; i++) {
      base = String(list[i] === null || list[i] === undefined ? '' : list[i]);
      name = base;
      if (used[name]) {
        k = 2;
        while (used[base + '_' + k]) k++;
        name = base + '_' + k;
        renamed.push({ from: base, to: name, index: i });
      }
      used[name] = 1;
      out.push(name);
    }
    return { names: out, renamed: renamed, count: renamed.length };
  }

  /** 当前语言（i18n 未加载时按中文）—— 程序生成的文案要随语言 */
  function isEn() {
    return !!(YMS.I18n && YMS.I18n.lang && YMS.I18n.lang() === 'en');
  }

  /** 改名说明文案（导入提示 / 主状态栏 / 处理说明共用，避免三处措辞漂移） */
  function renameNotice(report) {
    if (!report || !report.count) return '';
    var en = isEn();
    var parts = [], list = report.renamed, i, r;
    for (i = 0; i < list.length && i < 3; i++) {
      r = list[i];
      parts.push(en
        ? (r.from + ' → ' + r.to + ' (col ' + (r.index + 1) + ')')
        : (r.from + ' → ' + r.to + '（第 ' + (r.index + 1) + ' 列）'));
    }
    if (list.length > 3) parts.push('…');
    return en
      ? ('Header had ' + report.count + ' duplicate column name(s), auto-renamed: ' + parts.join(', '))
      : ('表头有 ' + report.count + ' 个重复列名，已自动改名：' + parts.join('、'));
  }

  /** 列名已被占用时的统一错误文案（重命名 / 新建列共用） */
  function nameTaken(name) {
    return isEn()
      ? ('Column name "' + name + '" already exists — pick another')
      : ('列名「' + name + '」已存在，请换一个');
  }

  YMS.colNames = { unique: uniqueNames, notice: renameNotice, taken: nameTaken };

  /* 由"行数组"构建（.yms 模板 / 计算列 / 小数据） */
  DataFrame.fromRows = function (colDefs, rows) {
    var b = new DFBuilder(colDefs);
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      for (var c = 0; c < colDefs.length; c++) b.set(c, row[c]);
      b.endRow();
    }
    return b.finish();
  };

  YMS.Column = Column;
  YMS.DataFrame = DataFrame;
  YMS.DFBuilder = DFBuilder;
})(typeof window !== 'undefined' ? window : this);
