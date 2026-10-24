/* ==========================================================================
   YMS · js/core/i18n.js
   运行期双语层（中文 / English）—— 迭代 22
   --------------------------------------------------------------------------
   为什么不做"逐句改源码"：
     本工程用户可见文案上千处，散落在 10+ 个模块里；逐句包 t() 既容易漏、
     又会让每次改文案都要动业务代码。这里改成"渲染后翻译"：
       · 字典：中文原文 → 英文（由 js/core/i18n-dict-*.js 注册，纯数据）
       · 文本节点/属性：整篇扫描，命中字典就替换；切回中文按缓存还原
       · 动态内容（toast / 右键菜单 / 弹层 / 新建的表项）：MutationObserver 兜底
       · 用户数据不翻译：表格单元格 td、输入框 value、文件内容一律跳过

   公开 API（挂 YMS.I18n）：
     lang()          当前语言 'zh' | 'en'
     set(lang)       切换并立即生效（持久化到 localStorage['yms.lang']）
     toggle()        中 ⇄ 英
     t(zh)           取译文（语言为 zh 时原样返回）
     reg(dict)       注册/合并字典 { '中文': 'English' }
     regPatterns([]) 注册动态串规则 [{ re: /^已生成 (.+)（(\d+) 行 × (\d+) 列）$/, en: 'Created $1 ($2 rows × $3 cols)' }]
     onChange(cb)    订阅语言变化
     apply(root)     手动对某棵子树应用当前语言
     remaining()     返回"当前仍未被翻译的中文串"清单（自测用，EN 模式下必须为空）
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var LS_KEY = 'yms.lang';
  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  var lang = 'zh';
  try { lang = localStorage.getItem(LS_KEY) === 'en' ? 'en' : 'zh'; } catch (e0) { /* file:// 下可能不可用 */ }

  var DICT = {};                 /* 中文 → 英文（精确匹配） */
  var REV = {};                  /* 英文 → 中文（还原用；同译名取首个） */
  var PATTERNS = [];             /* 动态串规则 */
  var listeners = [];
  var nodeOrig = null;           /* WeakMap<TextNode, 中文原文> */
  var attrOrig = 'data-i18n-zh-a';
  var applying = false;
  var observer = null;

  try { nodeOrig = new WeakMap(); } catch (e1) { nodeOrig = null; }

  /* 这些区域一律不翻译：用户数据 / 代码 / 输入值 */
  var SKIP_SELECTOR = 'script, style, pre, code, textarea, input[type="hidden"], input[type="file"], ' +
    '[contenteditable="true"], [data-i18n-skip], .data-grid td, .tf-table td, .prop-table td, .fn-table td, .raw-item';

  function hasCJK(s) { return CJK.test(String(s || '')); }
  /* 纯全角标点（。、，（）…）也要过字典，否则英文句末会留中文句号 */
  var PUNCT_ONLY = /^[。、，；：！？（）【】「」『』〈〉《》]+$/;
  function needsTranslate(s) {
    var t = String(s || '').trim();
    if (!t) return false;
    return hasCJK(t) || PUNCT_ONLY.test(t);
  }

  function reg(dict) {
    if (!dict) return 0;
    var n = 0;
    for (var k in dict) {
      if (!Object.prototype.hasOwnProperty.call(dict, k)) continue;
      DICT[k] = dict[k];
      if (REV[dict[k]] === undefined) REV[dict[k]] = k;
      n++;
    }
    return n;
  }

  function regPatterns(list) {
    if (!list || !list.length) return 0;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].re) PATTERNS.push(list[i]);
    return list.length;
  }

  /* 单条文本：字典 → 规则；保留首尾空白 */
  function translateText(raw) {
    var s = String(raw);
    if (!s || !needsTranslate(s)) return s;
    var lead = s.match(/^\s*/)[0];
    var trail = s.match(/\s*$/)[0];
    var core = s.trim();
    if (!core) return s;
    var out = DICT[core];
    if (out === undefined) {
      for (var i = 0; i < PATTERNS.length; i++) {
        var p = PATTERNS[i];
        if (p.re.test(core)) { out = core.replace(p.re, p.en); break; }
      }
    }
    if (out === undefined) return s;      /* 未命中：保持中文，由 remaining() 报出 */
    return lead + out + trail;
  }

  function restoreText(raw) {
    var s = String(raw);
    if (!s) return s;
    var lead = s.match(/^\s*/)[0];
    var trail = s.match(/\s*$/)[0];
    var core = s.trim();
    var out = REV[core];
    if (out === undefined) {
      for (var i = 0; i < PATTERNS.length; i++) {
        /* 反向还原：本层不做逆正则（成本高、且切回中文会整体重渲染），保持原样 */
      }
    }
    return out === undefined ? s : lead + out + trail;
  }

  function isSkipped(el) {
    try { return !!(el && el.closest && el.closest(SKIP_SELECTOR)); } catch (e) { return false; }
  }

  var ATTRS = ['title', 'placeholder', 'aria-label'];

  function walk(root) {
    if (!root) return;
    var en = lang === 'en';
    if (root.nodeType === 3) {                       /* 文本节点 */
      var p = root.parentNode;
      if (p && isSkipped(p)) return;
      if (en) {
        var orig = nodeOrig ? nodeOrig.get(root) : undefined;
        var cur = root.nodeValue;
        if (orig === undefined) {
          var tr = translateText(cur);
          if (tr !== cur) { if (nodeOrig) nodeOrig.set(root, cur); root.nodeValue = tr; }
        }
      } else if (nodeOrig && nodeOrig.has(root)) {
        root.nodeValue = nodeOrig.get(root);
        nodeOrig['delete'](root);
      }
      return;
    }
    if (root.nodeType !== 1) return;

    /* 元素属性（title / placeholder / aria-label） */
    if (!isSkipped(root)) {
      for (var a = 0; a < ATTRS.length; a++) {
        var name = ATTRS[a];
        var v = root.getAttribute ? root.getAttribute(name) : null;
        var store = null;
        try { store = JSON.parse((root.getAttribute && root.getAttribute(attrOrig)) || '{}'); } catch (e2) { store = {}; }
        if (en) {
          if (!v || !needsTranslate(v)) continue;               /* 已是英文 / 无中文 → 不动 */
          if (store[name] === undefined) { store[name] = v; root.setAttribute(attrOrig, JSON.stringify(store)); }
          var tv = translateText(store[name]);
          if (v !== tv) root.setAttribute(name, tv);
        } else if (store[name] !== undefined) {
          /* 切回中文：**先还原**，与当前值是否含中文无关（否则英文属性会永远卡在英文） */
          if (v !== store[name]) root.setAttribute(name, store[name]);
          delete store[name];
          if (Object.keys(store).length) root.setAttribute(attrOrig, JSON.stringify(store));
          else if (root.removeAttribute) root.removeAttribute(attrOrig);
        }
      }
    }

    var kids = root.childNodes;
    for (var i = 0; kids && i < kids.length; i++) walk(kids[i]);
  }

  function apply(root) {
    if (applying) return;
    applying = true;
    try { walk(root || document.body); } catch (e3) { /* 渲染期异常不外抛 */ }
    applying = false;
  }

  function startObserver() {
    if (observer || typeof MutationObserver === 'undefined' || !document.body) return;
    observer = new MutationObserver(function (muts) {
      if (lang !== 'en' || applying) return;
      applying = true;
      try {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'childList') {
            for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
          } else if (m.type === 'characterData' && m.target) {
            walk(m.target);
          } else if (m.type === 'attributes' && m.target) {
            if (m.attributeName === attrOrig) continue;        /* 自己写的缓存属性 → 忽略 */
            walk(m.target);
          }
        }
      } catch (e4) { /* ignore */ }
      applying = false;
    });
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label']
    });
  }

  function setLang(next) {
    var v = next === 'en' ? 'en' : 'zh';
    if (v === lang) { apply(document.body); syncButton(); return lang; }
    lang = v;
    try { localStorage.setItem(LS_KEY, lang); } catch (e5) { /* ignore */ }
    try { document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN'); } catch (e6) { /* ignore */ }
    apply(document.body);
    syncButton();
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](lang); } catch (e7) { /* ignore */ } }
    return lang;
  }

  /* 顶栏按钮：中文模式下按钮显示「EN」，英文模式下显示「中文」（点一下切到对方） */
  function syncButton() {
    var btn = document.getElementById('btn-lang');
    if (!btn) return;
    var toEn = lang !== 'en';
    btn.textContent = toEn ? 'EN' : '中文';
    btn.setAttribute('title', toEn ? 'Switch to English' : '切换为中文（Switch to Chinese）');
    btn.setAttribute('aria-label', toEn ? 'Switch to English' : '切换到中文');
    btn.setAttribute('data-lang', lang);
  }

  /* 自测用：EN 模式下仍含中文的可见文本（去重计数） */
  function remaining() {
    if (lang !== 'en' || !document.body) return [];
    var seen = {}, out = [];
    var w = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */, null, false);
    var n;
    while ((n = w.nextNode())) {
      var p = n.parentNode;
      if (!p || isSkipped(p)) continue;
      if (p.id === 'btn-lang') continue;      /* 语言按钮自身显示「中文」是设计如此 */
      var t = String(n.nodeValue || '').trim();
      if (!t || !needsTranslate(t)) continue;
      if (seen[t]) { seen[t]++; continue; }
      seen[t] = 1;
      out.push(t);
    }
    return out;
  }

  YMS.I18n = {
    lang: function () { return lang; },
    set: setLang,
    toggle: function () { return setLang(lang === 'en' ? 'zh' : 'en'); },
    t: function (zh) { return lang === 'en' ? translateText(zh) : zh; },
    reg: reg,
    regPatterns: regPatterns,
    onChange: function (cb) { if (typeof cb === 'function') listeners.push(cb); },
    apply: apply,
    startObserver: startObserver,
    syncButton: syncButton,
    remaining: remaining,
    hasCJK: hasCJK
  };

  /* 自动接管：#btn-lang 点击切换 + 首屏应用 + 动态节点观察（不依赖 app.js 改造） */
  function boot() {
    syncButton();
    var btn = document.getElementById('btn-lang');
    if (btn && !btn.__i18nBound) {
      btn.addEventListener('click', function (e) {
        if (e) e.stopPropagation();
        setLang(lang === 'en' ? 'zh' : 'en');
      });
      btn.__i18nBound = true;
    }
    apply(document.body);
    startObserver();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  YMS.I18n.boot = boot;

  global.__i18n = YMS.I18n;
})(window);
