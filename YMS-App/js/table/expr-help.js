/* ==========================================================================
   YMS · table/expr-help.js
   「数据计算」对话框内嵌函数库 —— YMS.ExprHelp（迭代 19 重构）
     · 内容与表达式引擎逐条对应（column-ops.js 的 buildExpr / makeEvaluator）：
         作用域 = 合法标识符列名 + YMS.types.EXPR_FUNCS（16 个）+ 完整 Math 对象 + col('列名')
     · 迭代 24 新增「语法 / 控制流」TAB：语句块模式（if / else、for、while、let / const、
       switch、return，另有 __i / __n 行号变量）与表达式级条件函数 iif / coalesce / between / choose
     · 迭代 19 起不再独立弹层：由表达式对话框在下方内嵌渲染
         横向按类别分 TAB；点函数名 → 插入 func()（光标落在括号内，由调用方负责）；
         再点「可用列」→ 作用到该函数上（round(Yield)）；点示例 / 「填入」→ 回填整条表达式
     · 兼容占位：open() / close() / isOpen() 保留但不再创建浮层（isOpen() 恒 false）
   公开 API：YMS.ExprHelp.renderLibrary(container, opts) → handle
             YMS.ExprHelp.GROUPS / FUNCS / SYNTAX / MATH / MISSING / EXAMPLES（数据，供自测逐条核对）
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util;

  /* ---------------------------------------------------------------- 语法速查 */
  /* [语法, 写法示例, 说明] —— 只列引擎真实支持的写法（new Function 求值） */
  var SYNTAX = [
    ['列引用（标识符列）', 'Yield', '列名以字母 / 下划线 / $ 开头、只含字母数字下划线 $，且不与内置函数同名 → 直接写列名'],
    ['列引用（任意列名）', "col('Measure Time')", '列名含空格、中文或特殊符号时用 col()；列不存在时取到缺失'],
    ['算术运算', '+  -  *  /  %  **', '% 取余；** 求幂（等价 pow(x, y)）'],
    ['括号与优先级', '(Yield + Bin1) / 2', '与 JavaScript 完全一致，可任意嵌套'],
    ['比较运算', '>  <  >=  <=  ===  !==', '结果是布尔值；要作为整列数值输出请用三元转成 1 / 0'],
    ['逻辑运算', '&&   ||   !', '与 / 或 / 非；常与比较组合成条件'],
    ['三元（条件）', 'Wafer > 10 ? 1 : 0', '条件成立取冒号前的值，否则取冒号后的值'],
    ['常量', 'Math.PI   Math.E', '圆周率 / 自然常数（完整 Math 对象都可用）'],
    ['结果类型', '必须能算出数值', '结果不是数值（文本、布尔、NaN）时该行按缺失计']
  ];

  /* ------------------------------------------------------------ 内置函数（16） */
  /* 与 js/core/types.js 的 EXPR_FUNCS 一一对应（顺序一致） */
  var FUNCS = [
    { fn: 'abs', usage: 'abs(x)', desc: '绝对值', ex: 'abs(Vth - 1.2)' },
    { fn: 'round', usage: 'round(x, n)', desc: '四舍五入保留 n 位小数（n 省略 → 取整）', ex: 'round(Yield * 100, 2)' },
    { fn: 'ceil', usage: 'ceil(x)', desc: '向上取整（不小于 x 的最小整数）', ex: 'ceil(Yield * 10)' },
    { fn: 'floor', usage: 'floor(x)', desc: '向下取整（不大于 x 的最大整数）', ex: 'floor(Yield * 10)' },
    { fn: 'sqrt', usage: 'sqrt(x)', desc: '平方根；x 为负 → NaN → 该行缺失', ex: 'sqrt(pow(Vth, 2) + pow(Idsat, 2))' },
    { fn: 'log', usage: 'log(x)', desc: '自然对数 ln(x)；x ≤ 0 → NaN → 缺失', ex: 'log(Yield)' },
    { fn: 'log10', usage: 'log10(x)', desc: '常用对数 lg(x)；x ≤ 0 → NaN → 缺失', ex: 'log10(Yield * 100)' },
    { fn: 'exp', usage: 'exp(x)', desc: 'e 的 x 次幂', ex: 'exp(Vth)' },
    { fn: 'pow', usage: 'pow(x, y)', desc: 'x 的 y 次幂（也可写 x ** y）', ex: 'pow(Vth, 2)' },
    { fn: 'min', usage: 'min(a, b, …)', desc: '最小值，可传多个参数', ex: 'min(Yield, Bin1)' },
    { fn: 'max', usage: 'max(a, b, …)', desc: '最大值，可传多个参数', ex: 'max(Yield, Bin1)' },
    { fn: 'sign', usage: 'sign(x)', desc: '符号：负数 -1 / 零 0 / 正数 1', ex: 'sign(Vth - 1.2)' },
    { fn: 'sin', usage: 'sin(x)', desc: '正弦（x 为弧度）', ex: 'sin(Math.PI / 4)' },
    { fn: 'cos', usage: 'cos(x)', desc: '余弦（x 为弧度）', ex: 'cos(Math.PI / 3)' },
    { fn: 'tan', usage: 'tan(x)', desc: '正切（x 为弧度）', ex: 'tan(Math.PI / 6)' },
    { fn: 'atan', usage: 'atan(x)', desc: '反正切，结果弧度（-π/2 ~ π/2）', ex: 'atan(Vth / Idsat)' }
  ];

  /* --------------------------------------------------------------- Math 常用 */
  var MATH = [
    { fn: 'Math.hypot', usage: 'Math.hypot(a, b)', desc: '平方和的平方根（欧氏距离）', ex: 'Math.hypot(Vth, Idsat)' },
    { fn: 'Math.trunc', usage: 'Math.trunc(x)', desc: '截断小数部分取整（向 0 收）', ex: 'Math.trunc(Yield * 100)' },
    { fn: 'Math.PI', usage: 'Math.PI', desc: '圆周率 3.14159…', ex: 'Vth * Math.PI' },
    { fn: 'Math.E', usage: 'Math.E', desc: '自然常数 2.71828…', ex: 'Math.pow(Math.E, Vth)' }
  ];

  /* -------------------------------------------------------------- 缺失值语义 */
  var MISSING = [
    '列里的缺失值进入表达式后是 NaN，NaN 会沿任何运算传播 —— <code>Yield * 100</code> 遇到 Yield 缺失，该行结果仍缺失。',
    '除 “列本身缺失” 外，<code>log(0)</code>、<code>sqrt(-1)</code>、<code>0 / 0</code> 也会得到 NaN，同样按缺失计。',
    '「缺失值处理」决定结果列怎么写：<b>保留缺失</b> → 该行留空（NaN）；<b>补齐为 0 / 1</b> → 该行写成 0 或 1。',
    '整个表达式的结果不是数值（文本、布尔、对象）时，该行一律按缺失计 —— 比较结果要用三元转成 1 / 0。'
  ];

  /* --------------------------------------------------------------- 可填示例 */
  var EXAMPLES = [
    { expr: 'Yield * 100', note: '把良率换算成百分比' },
    { expr: 'round(Idsat, 2)', note: 'Idsat 保留 2 位小数' },
    { expr: '(Yield + Bin1) / 2', note: '两列取平均' },
    { expr: 'Wafer > 10 ? 1 : 0', note: '条件打标：Wafer > 10 记 1，否则 0' },
    { expr: 'sqrt(pow(Vth, 2) + pow(Idsat, 2))', note: 'Vth 与 Idsat 的平方和再开方' },
    { expr: "col('Measure Time')", note: '列名含空格 / 特殊字符时用 col() 取整列（把 Measure Time 换成你的列名）' }
  ];

  /* ---------------------------------------------------------- 语法 / 控制流 */
  /* 迭代 24：语句块模式（引擎在 column-ops.js 的 buildExpr 里判定 + 编译）
       · insert 不以 '()' 结尾 → 点函数名整段插入（光标落末尾，可继续写分支）
       · example / insert 里的列名都用当前样例数据里真实存在的 Yield / Vth，点开即可跑
       · 示例里的阈值按样例 Yield（86 ~ 97 之间）取值，分布有 0 也有 1 */
  var FLOW = [
    {
      name: 'if / else',
      usage: 'if (cond) { return a; } else { return b; }',
      note: '条件分支：命中 if 就 return 它里面的值，否则走后面的兜底 return',
      ex: 'if (Yield > 94) { return 1; } return 0;'
    },
    {
      name: 'for 循环',
      usage: 'for (init; cond; inc) { … }',
      note: '计数循环：三段与 JavaScript 的 for 完全一致；循环体里改累加变量',
      ex: 'let s = 0; for (let k = 0; k < 3; k++) { s += k; } return s;'
    },
    {
      name: 'while 循环',
      usage: 'while (cond) { … }',
      note: '条件循环：条件不成立时退出，记得在循环体里改变量',
      ex: 'let k = 0; while (k < 4) { k++; } return k;'
    },
    {
      name: 'let / const',
      usage: 'let a = …; const b = …;',
      note: '局部变量：可写多步计算，最后一句 return 结果（变量只在本次计算内有效）',
      ex: 'let a = Vth * 2; const b = a + 1; return b;'
    },
    {
      name: 'switch',
      usage: 'switch (true) { case cond: return a; default: return b; }',
      note: '多分支：switch (true) + case 条件，命中第一个成立的 case',
      ex: 'switch (true) { case Yield > 95: return 2; case Yield > 92: return 1; default: return 0; }'
    },
    {
      name: 'return',
      usage: 'return 结果;',
      note: '语句块必须以 return 交回一个数值；只写语句不写 return 会报错',
      ex: 'let x = Vth * 2; return x;'
    },
    {
      name: 'iif(cond, a, b)', call: 'iif',
      usage: 'iif(cond, a, b)',
      note: '表达式内条件：cond 成立取 a，否则取 b（条件为缺失按不成立处理）',
      ex: 'iif(Yield > 94, 1, 0)'
    },
    {
      name: 'coalesce(a, b, …)', call: 'coalesce',
      usage: 'coalesce(a, b, …)',
      note: '首个非缺失值：缺失按 NaN 处理，全缺失得缺失',
      ex: 'coalesce(Vth, 0)'
    },
    {
      name: 'between(x, lo, hi)', call: 'between',
      usage: 'between(x, lo, hi)',
      note: '闭区间判断：lo ≤ x ≤ hi 得 1，否则 0；x 缺失得缺失',
      ex: 'between(Yield, 90, 95)'
    },
    {
      name: 'choose(idx, …)', call: 'choose',
      usage: 'choose(idx, a, b, …)',
      note: '按序号取值（0 基）：choose(0, a, b) 得 a，越界得缺失',
      ex: 'choose(1, Yield, Vth)'
    }
  ];

  /**
   * 语句块卡片：点函数名整段插入模版（光标落末尾，可继续补分支）；
   * 辅助函数卡片（有 call）照旧插入 f()，光标落在括号内由调用方处理
   */
  var FLOW_ITEMS = FLOW.map(function (f) {
    return {
      name: f.name, usage: f.usage, note: f.note, example: f.ex,
      insert: f.call ? (f.call + '()') : f.ex
    };
  });

  /** 语法 / 控制流 TAB 的说明（语句块规则 + 防护） */
  var FLOW_NOTES = [
    '语句块要自己 return：没写 return 会提示「语句块需要以 return 返回一个值」；普通表达式（如 Yield * 100）不需要 return。',
    '语句块里可用 __i（0 基行号）与 __n（总行数）；列值 / Math / col() / 内置函数与 iif、coalesce、between、choose 照常可用。',
    '循环有保护：单行循环超过 20 万次或总耗时超时会被中止并报错，不会卡住页面。'
  ];

  /* ------------------------------------------------------------ 卡片数据构建 */
  /** 内置函数名 → FUNCS 条目 */
  var FN_BY_NAME = {};
  FUNCS.forEach(function (f) { FN_BY_NAME[f.fn] = f; });

  /** 由 FUNCS 条目生成卡片项（insert 以 '()' 结尾 → 光标落进括号） */
  function fnItem(name) {
    var f = FN_BY_NAME[name] || { fn: name, usage: name + '(x)', desc: '', ex: '' };
    return { name: f.fn, usage: f.usage, note: f.desc, example: f.ex, insert: f.fn + '()' };
  }
  /** Math 扩展卡片（带点的函数名照常插入；常量不带括号） */
  function mathItem(fn) {
    var m = null;
    MATH.forEach(function (x) { if (x.fn === fn) m = x; });
    var isCall = !(fn === 'Math.PI' || fn === 'Math.E');
    return {
      name: fn,
      usage: m ? m.usage : (isCall ? fn + '(x)' : fn),
      note: m ? m.desc : '',
      example: m ? m.ex : '',
      insert: isCall ? fn + '()' : fn
    };
  }

  /** 语法速查条目（不可“插入函数”，点用法 / 示例回填整条写法） */
  var SYNTAX_ITEMS = SYNTAX.map(function (r) {
    return { name: r[0], usage: r[1], note: r[2], example: r[1], insert: '' };
  });

  /* 顺序即 TAB 顺序；items 覆盖 FUNCS 全部 16 个 + Math 常用，一个不漏
     迭代 24：「语法 / 控制流」紧跟「基础数学」，承载语句块模式（if / for / while / …） */
  var GROUPS = [
    {
      id: 'basic', name: '基础数学', desc: '绝对值 / 最值 / 符号 —— 最常用的一档',
      items: ['abs', 'min', 'max', 'sign'].map(fnItem)
    },
    {
      id: 'flow', name: '语法 / 控制流', desc: 'if / else、for、while、let / const、switch、return 与条件辅助函数',
      items: FLOW_ITEMS
    },
    {
      id: 'round', name: '取整与舍入', desc: '取整与四舍五入；round 的第二个参数是小数位数',
      items: ['round', 'ceil', 'floor'].map(fnItem)
    },
    {
      id: 'power', name: '幂与对数', desc: '乘方 / 开方 / 对数 / 指数；x ≤ 0 时 log 与 sqrt 得缺失',
      items: ['pow', 'sqrt', 'log', 'log10', 'exp'].map(fnItem)
    },
    {
      id: 'trig', name: '三角函数', desc: '弧度制三角函数与反三角（90° = Math.PI / 2）',
      items: ['sin', 'cos', 'tan', 'atan'].map(fnItem)
    },
    {
      id: 'math', name: 'Math 扩展', desc: '完整 Math 对象都可用，这里列出最常搭配的几个',
      items: [
        mathItem('Math.hypot'), mathItem('Math.trunc'), mathItem('Math.expm1'),
        mathItem('Math.cbrt'), mathItem('Math.PI'), mathItem('Math.E')
      ]
    },
    {
      id: 'syntax', name: '语法速查', desc: '运算符 / 比较与逻辑 / 三元 / col() / 缺失语义 / 数学常量',
      items: SYNTAX_ITEMS
    }
  ];

  /* ---------------------------------------------------------------- 渲染 */
  function esc(s) { return U.escapeHtml(s); }

  function findGroup(id) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].id === id) return GROUPS[i];
    return null;
  }
  function findItem(name) {
    for (var i = 0; i < GROUPS.length; i++) {
      var items = GROUPS[i].items;
      for (var j = 0; j < items.length; j++) if (items[j].name === name) return items[j];
    }
    return null;
  }

  /** 函数卡片：函数名 / 用法 / 一句说明 / 示例 */
  function cardsHTML(g) {
    var out = ['<div class="fn-cards">'];
    g.items.forEach(function (it) {
      var callable = !!it.insert;
      out.push('<div class="fn-card' + (callable ? '' : ' is-syntax') + '" data-fn="' + esc(it.name) + '">');
      if (callable) {
        out.push('<button type="button" class="fn-card-name" data-fn="' + esc(it.name) +
          '" title="点击插入 ' + esc(it.insert) + '">' + esc(it.name) + '</button>');
        out.push('<code class="fn-card-usage">' + esc(it.usage) + '</code>');
        if (it.note) out.push('<div class="fn-card-note">' + esc(it.note) + '</div>');
        if (it.example) {
          out.push('<code class="fn-card-ex" data-ex="' + esc(it.example) + '" title="点击填入示例">' +
            esc(it.example) + '</code>');
        }
      } else {
        /* 语法速查：写法本身就是卡片里可点的示例（避免与「用法」重复） */
        out.push('<span class="fn-card-name is-static">' + esc(it.name) + '</span>');
        out.push('<code class="fn-card-ex" data-ex="' + esc(it.example || it.usage) +
          '" title="点击填入示例">' + esc(it.usage) + '</code>');
        if (it.note) out.push('<div class="fn-card-note">' + esc(it.note) + '</div>');
      }
      out.push('</div>');
    });
    out.push('</div>');
    return out.join('');
  }

  /** 语法 TAB 的附加内容：缺失值语义 + 6 条可填示例 */
  function syntaxExtraHTML() {
    var out = ['<h4 class="fn-h">缺失值语义</h4><ul class="fn-notes">'];
    MISSING.forEach(function (t) { out.push('<li>' + t + '</li>'); });
    out.push('</ul>');
    out.push('<h4 class="fn-h">填一个试试（点「填入」整条写进表达式框）</h4><div class="fn-examples">');
    EXAMPLES.forEach(function (e) {
      out.push('<div class="fn-example">' +
        '<code class="fn-expr">' + esc(e.expr) + '</code>' +
        '<span class="fn-note">' + esc(e.note) + '</span>' +
        '<button type="button" class="btn btn-sm fn-pick" data-expr="' + esc(e.expr) + '">填入</button>' +
        '</div>');
    });
    out.push('</div>');
    return out.join('');
  }

  /** 语法 / 控制流 TAB 的附加内容：语句块规则（三条） */
  function flowExtraHTML() {
    var out = ['<h4 class="fn-h">语句块规则</h4><ul class="fn-notes">'];
    FLOW_NOTES.forEach(function (t) { out.push('<li>' + esc(t) + '</li>'); });
    out.push('</ul>');
    return out.join('');
  }

  function contentHTML(g) {
    var out = [];
    if (g.desc) out.push('<div class="fn-tab-desc">' + esc(g.desc) + '</div>');
    out.push(cardsHTML(g));
    if (g.id === 'syntax') out.push(syntaxExtraHTML());
    if (g.id === 'flow') out.push(flowExtraHTML());
    return out.join('');
  }

  /**
   * 在容器里渲染「横向 TAB 条 + 当前 TAB 内容」
   * @param {Element} container 宿主容器（对话框内的 .expr-lib）
   * @param {{onInsertFn:function(Object), onInsertExample:function(string)}} [opts]
   *        点函数名卡片 → onInsertFn(item)；点示例 → onInsertExample(表达式文本)
   * @returns {{root:Element, selectTab:function(string), focusFirstCard:function():boolean,
   *            current:function():string}|null}
   */
  function renderLibrary(container, opts) {
    opts = opts || {};
    if (!container || typeof document === 'undefined') return null;
    var onFn = typeof opts.onInsertFn === 'function' ? opts.onInsertFn : function () {};
    var onEx = typeof opts.onInsertExample === 'function' ? opts.onInsertExample : function () {};
    var state = { id: GROUPS[0].id };

    U.clear(container);
    var wrap = U.el('div', { class: 'fn-lib' });
    var head = U.el('div', { class: 'fn-lib-head' }, [
      U.el('span', { class: 'fn-lib-title', text: '函数与语法' }),
      U.el('span', {
        class: 'fn-lib-tip',
        text: '点函数 → 插入表达式（光标在括号内）；再点「可用列」→ 作用到该列'
      })
    ]);
    var bar = U.el('div', { class: 'fn-tabs', role: 'tablist', 'aria-label': '函数分类' });
    var body = U.el('div', {
      id: 'fn-tab-body', class: 'fn-tab-body', role: 'tabpanel', tabindex: '-1'
    });

    /* TAB 条（横向不换行，窄屏横向滚动） */
    var tabs = GROUPS.map(function (g, gi) {
      var b = U.el('button', {
        type: 'button', class: 'fn-tab', role: 'tab', 'data-tab': g.id,
        id: 'fn-tab-' + g.id, 'aria-controls': 'fn-tab-body', title: g.desc, text: g.name
      });
      b.addEventListener('click', function (e) { e.preventDefault(); select(g.id, false); });
      b.addEventListener('keydown', function (e) {
        var d = (e.key === 'ArrowRight' || e.key === 'Right') ? 1
          : ((e.key === 'ArrowLeft' || e.key === 'Left') ? -1 : 0);
        if (!d) return;                                     /* ← → 切换 TAB */
        e.preventDefault();
        select(GROUPS[(gi + d + GROUPS.length) % GROUPS.length].id, true);
      });
      bar.appendChild(b);
      return b;
    });

    /* 切换 TAB 只重绘内容区（TAB 条节点不重建） */
    function select(id, focusTab) {
      var g = findGroup(id) || GROUPS[0];
      state.id = g.id;
      tabs.forEach(function (b) {
        var on = b.getAttribute('data-tab') === g.id;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        if (on && focusTab) { try { b.focus(); } catch (e1) { /* 无焦点能力 */ } }
      });
      body.setAttribute('aria-labelledby', 'fn-tab-' + g.id);
      body.innerHTML = contentHTML(g);
      try { body.scrollTop = 0; } catch (e2) { /* 忽略 */ }
    }

    /* 事件委托：示例 / 「填入」→ 回填；函数名 → 插入函数 */
    body.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var pick = t.closest('.fn-pick');
      if (pick) { e.preventDefault(); onEx(pick.getAttribute('data-expr') || ''); return; }
      var ex = t.closest('.fn-card-ex');
      if (ex) { e.preventDefault(); onEx(ex.getAttribute('data-ex') || ''); return; }
      var nm = t.closest('.fn-card-name');
      if (!nm || (nm.classList && nm.classList.contains('is-static'))) return;
      e.preventDefault();
      var item = findItem(nm.getAttribute('data-fn'));
      if (item) onFn(item);
    });

    wrap.appendChild(head);
    wrap.appendChild(bar);
    wrap.appendChild(body);
    container.appendChild(wrap);

    /** 聚焦当前 TAB 的第一张函数卡片（右键菜单 ⓘ 进入时用） */
    function focusFirstCard() {
      var first = body.querySelector('.fn-card-name:not(.is-static)') ||
        body.querySelector('.fn-card-name') || null;
      if (!first) { try { body.focus(); } catch (e3) { /* 忽略 */ } return false; }
      try { first.focus(); } catch (e4) { /* 忽略 */ }
      return true;
    }

    select(GROUPS[0].id, false);
    return {
      root: wrap, el: wrap, tabBar: bar, body: body,
      selectTab: select,
      focusFirstCard: focusFirstCard,
      current: function () { return state.id; }
    };
  }

  /* ------------------------------------------------- 兼容占位（内嵌后无浮层） */
  /** 旧 API：独立说明面板已内嵌进表达式对话框，这里只保留空实现（不报错） */
  function open() { return null; }
  function close() { return false; }
  function isOpen() { return false; }

  YMS.ExprHelp = {
    open: open, close: close, isOpen: isOpen,
    renderLibrary: renderLibrary,
    GROUPS: GROUPS,
    SYNTAX: SYNTAX, FUNCS: FUNCS, MATH: MATH, MISSING: MISSING, EXAMPLES: EXAMPLES,
    FLOW: FLOW, FLOW_NOTES: FLOW_NOTES
  };
})(typeof window !== 'undefined' ? window : this);
