/* ==========================================================================
   YMS · report/pptx.js
   PPTX 写出层（YMS.Pptx）—— **零依赖**在浏览器里直接生成真正的 .pptx
   （OOXML PresentationML + 自实现 STORED 方式 ZIP 打包），不依赖 SheetJS / JSZip / 任何 CDN。

   职责边界：
     · 只做「结构化地写文件」：把 slides 规格（标题 / 副标题 / 文本 / 图片 / 网格排版）
       翻译成 [Content_Types].xml + _rels + ppt/presentation.xml + slideMaster + slideLayout
       + theme + slides + media 的最小完备 OOXML 包，并打包为 ZIP 字节流；
     · 不读 YMS.Store、不接触 DOM、不截图（截图由 report.js 负责），因此可在 Node 沙箱内直接自测；
     · 生成的包满足 PowerPoint 打开要求：每个 r:id / r:embed 都在对应 .rels 中真实存在，
       部件全部在 [Content_Types].xml 中登记（否则 PowerPoint 会提示「修复」）。

   硬约束（见 docs/DEV-SPEC.md 第 0 节）：
     file:// 下运行 —— 禁止 ES module / fetch / XHR / Worker / CDN；ES2017 以内语法
     （不使用可选链 ?. 与空值合并 ??）；不得依赖 TextEncoder / atob / Buffer，自带 UTF-8 编码
     与 base64 解码，保证浏览器与 Node 行为一致；任何路径不得抛未捕获异常。

   公开 API：
     YMS.Pptx.build(spec) -> Uint8Array
       spec = {
         title:  string,                     // 文档标题（写入 docProps/core.xml）
         author: string,                     // 作者
         slides: [{
           title:    string,                 // 幻灯片标题（顶部大字）
           subtitle: string,                 // 副标题（标题下方小字，可省）
           text:     string,                 // 等宽/普通文本框内容（按 \n 分行，可省）
           textSize: number,                 // 文本框字号 pt（可省，自动按版面收缩）
           textMono: boolean,                // 文本框是否用等宽字体（统计表用）
           images:   [{ png: Uint8Array|base64|dataURL, w: number, h: number, label: string }],
           layout:   { rows: number, cols: number }   // 图片网格（缺省按 ceil(sqrt(n)) 自动）
         }]
       }
     YMS.Pptx.decodePng(dataURLOrBase64) -> Uint8Array     // base64 / dataURL → PNG 字节
     YMS.Pptx.pngSize(bytes) -> {w,h} | null               // 读 IHDR 取像素尺寸
     YMS.Pptx.crc32(bytes) -> number                       // ZIP 校验用（自测可断言）
     YMS.Pptx.SLIDE_W / SLIDE_H / EMU_PER_INCH / VERSION   常量
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};

  /* ==========================================================================
     常量
     ========================================================================== */
  var VERSION = '1.1.0';
  var EMU_PER_INCH = 914400;
  var EMU_PER_PT = 12700;              // 1 pt = 12700 EMU
  var PX_PER_INCH = 96;                // 1 CSS px = 1/96 in（浏览器标准换算，截图尺寸→英寸）
  var SLIDE_W = 12192000;              // 13.333 in（16:9）
  var SLIDE_H = 6858000;               // 7.5 in

  /* 版面常量（EMU） */
  var MARGIN_X = 457200;               // 左右边距 0.5 in
  var MARGIN_TOP = 228600;             // 上边距 0.25 in
  var MARGIN_BOTTOM = 274320;          // 下边距 0.3 in
  var TITLE_H = 457200;                // 标题文本框高 0.5 in
  var SUBTITLE_H = 246888;             // 副标题文本框高 0.27 in
  var GAP = 91440;                     // 图片间距 0.1 in
  var LABEL_MAX_H = 182880;            // 分面标题行最大高 0.2 in

  /* 配色（与界面/报告保持一致的科研冷色调） */
  var C_INK = '16202A';
  var C_SOFT = '4A5866';
  var C_DIM = '7D8B98';
  var C_ACCENT = '0B6E99';
  var FONT_UI = 'Microsoft YaHei';
  var FONT_MONO = 'Consolas';

  var NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  var NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var NS_PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
  var RT = {
    officeDocument: NS_R + '/officeDocument',
    core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
    app: NS_R + '/extended-properties',
    slideMaster: NS_R + '/slideMaster',
    slideLayout: NS_R + '/slideLayout',
    slide: NS_R + '/slide',
    image: NS_R + '/image',
    theme: NS_R + '/theme'
  };
  var CT = {
    rels: 'application/vnd.openxmlformats-package.relationships+xml',
    xml: 'application/xml',
    png: 'image/png',
    presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
    slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
    core: 'application/vnd.openxmlformats-package.core-properties+xml',
    app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml'
  };

  /* ==========================================================================
     小工具
     ========================================================================== */
  function clampInt(v, lo, hi, dflt) {
    var n = Math.floor(Number(v));
    if (!isFinite(n)) n = dflt;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
  }
  function int(n) { var v = Math.round(Number(n)); return isFinite(v) ? v : 0; }
  function isArr(a) { return Object.prototype.toString.call(a) === '[object Array]'; }

  /** XML 文本转义（& < > " ' 全部处理；表单型与属性型通吃） */
  function xmlEsc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');   // 去掉 XML 1.0 非法控制字符
  }

  /** 去掉 XML 非法控制字符（属性值用，不转义） */
  function xmlClean(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  function xmlDecl() { return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'; }

  /* ==========================================================================
     UTF-8 编码（不依赖 TextEncoder；支持代理对）
     ========================================================================== */
  function utf8(str) {
    str = String(str === null || str === undefined ? '' : str);
    var out = new Uint8Array(str.length * 3 + 4);
    var n = 0, i, c, c2;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); i++; }
      }
      if (c < 0x80) {
        out[n++] = c;
      } else if (c < 0x800) {
        out[n++] = 0xC0 | (c >> 6); out[n++] = 0x80 | (c & 63);
      } else if (c < 0x10000) {
        out[n++] = 0xE0 | (c >> 12); out[n++] = 0x80 | ((c >> 6) & 63); out[n++] = 0x80 | (c & 63);
      } else {
        out[n++] = 0xF0 | (c >> 18); out[n++] = 0x80 | ((c >> 12) & 63);
        out[n++] = 0x80 | ((c >> 6) & 63); out[n++] = 0x80 | (c & 63);
      }
      if (n + 4 > out.length) {                     // 极端情况（全是 4 字节）时的兜底扩容
        var bigger = new Uint8Array(out.length * 2);
        bigger.set(out.subarray(0, n));
        out = bigger;
      }
    }
    return out.subarray(0, n);
  }

  /* ==========================================================================
     base64 解码（不依赖 atob / Buffer）
     ========================================================================== */
  var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_MAP = (function () {
    var m = new Int16Array(256);
    for (var i = 0; i < 256; i++) m[i] = -1;
    for (var k = 0; k < B64_CHARS.length; k++) m[B64_CHARS.charCodeAt(k)] = k;
    return m;
  })();

  /**
   * base64 / dataURL → 字节数组
   * @param {string} s 纯 base64 或 'data:image/png;base64,xxx'
   * @returns {Uint8Array}
   */
  function decodePng(s) {
    s = String(s === null || s === undefined ? '' : s);
    var cut = s.indexOf('base64,');
    if (cut >= 0) s = s.slice(cut + 7);
    var out = new Uint8Array(Math.ceil(s.length * 0.75) + 3);
    var n = 0, buf = 0, bits = 0, i, v;
    for (i = 0; i < s.length; i++) {
      v = B64_MAP[s.charCodeAt(i) & 0xFF];
      if (v < 0) continue;                          // 跳过 = / 空白 / 换行
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[n++] = (buf >> bits) & 0xFF;
      }
    }
    return out.subarray(0, n);
  }

  /** PNG 是否合法（签名） */
  function isPng(b) {
    return !!b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
  }

  /**
   * 读 PNG IHDR 取像素尺寸（宽高为大端 32 位，偏移 16 / 20）
   * @param {Uint8Array} b
   * @returns {{w:number,h:number}|null}
   */
  function pngSize(b) {
    if (!isPng(b) || b.length < 24) return null;
    var w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
    var h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
    if (!w || !h || w > 100000 || h > 100000) return null;
    return { w: w, h: h };
  }

  /* ==========================================================================
     CRC32（ZIP 必需）
     ========================================================================== */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256), i, k, c;
    for (i = 0; i < 256; i++) {
      c = i;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  /** @param {Uint8Array} bytes @returns {number} 无符号 32 位 CRC */
  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  /* ==========================================================================
     字节缓冲（自增长）
     ========================================================================== */
  function ByteBuf(cap) {
    this.buf = new Uint8Array(cap || 4096);
    this.len = 0;
  }
  ByteBuf.prototype._ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    var cap = this.buf.length || 1;
    while (cap < this.len + n) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  ByteBuf.prototype.u16 = function (v) {
    this._ensure(2);
    this.buf[this.len++] = v & 0xFF;
    this.buf[this.len++] = (v >>> 8) & 0xFF;
  };
  ByteBuf.prototype.u32 = function (v) {
    this._ensure(4);
    this.buf[this.len++] = v & 0xFF;
    this.buf[this.len++] = (v >>> 8) & 0xFF;
    this.buf[this.len++] = (v >>> 16) & 0xFF;
    this.buf[this.len++] = (v >>> 24) & 0xFF;
  };
  ByteBuf.prototype.bytes = function (b) {
    if (!b || !b.length) return;
    this._ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  };
  ByteBuf.prototype.done = function () { return this.buf.subarray(0, this.len); };

  /* ==========================================================================
     ZIP 打包（STORED 无压缩；写 PPTX / OOXML 最省事且 PowerPoint 完全兼容）
     ========================================================================== */
  /** DOS 时间戳（date/time 各 16 位，1980 基准） */
  function dosDateTime(d) {
    var y = d.getFullYear();
    if (y < 1980) y = 1980;
    if (y > 2107) y = 2107;
    return {
      time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F),
      date: (((y - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
    };
  }

  /**
   * 生成 ZIP 字节流（STORED）
   * @param {Array<{name:string, data:Uint8Array}>} files 顺序即包内顺序
   * @param {Date} [when] 归档时间（默认当前时间）
   * @returns {Uint8Array}
   */
  function zip(files, when) {
    var dt = dosDateTime(when || new Date());
    var central = new ByteBuf(65536);
    var out = new ByteBuf(1024 * 256);
    var offsets = [];
    var i, f, nameBytes, crc, off;

    for (i = 0; i < files.length; i++) {
      f = files[i];
      nameBytes = utf8(f.name);
      crc = crc32(f.data);
      offsets.push(out.len);
      out.u32(0x04034B50);          // local file header
      out.u16(20);                  // version needed
      out.u16(0);                   // flags（文件名全 ASCII，无需 UTF-8 标志）
      out.u16(0);                   // method = STORED
      out.u16(dt.time);
      out.u16(dt.date);
      out.u32(crc);
      out.u32(f.data.length);       // compressed size
      out.u32(f.data.length);       // uncompressed size
      out.u16(nameBytes.length);
      out.u16(0);                   // extra len
      out.bytes(nameBytes);
      out.bytes(f.data);
    }

    var cdStart = out.len;
    for (i = 0; i < files.length; i++) {
      f = files[i];
      nameBytes = utf8(f.name);
      crc = crc32(f.data);
      off = offsets[i];
      central.u32(0x02014B50);      // central directory header
      central.u16(20);              // version made by
      central.u16(20);              // version needed
      central.u16(0);
      central.u16(0);
      central.u16(dt.time);
      central.u16(dt.date);
      central.u32(crc);
      central.u32(f.data.length);
      central.u32(f.data.length);
      central.u16(nameBytes.length);
      central.u16(0);               // extra
      central.u16(0);               // comment
      central.u16(0);               // disk number
      central.u16(0);               // internal attrs
      central.u32(0);               // external attrs
      central.u32(off);
      central.bytes(nameBytes);
    }
    var cdBytes = central.done();
    out.bytes(cdBytes);

    out.u32(0x06054B50);            // end of central directory
    out.u16(0);
    out.u16(0);
    out.u16(files.length);
    out.u16(files.length);
    out.u32(cdBytes.length);
    out.u32(cdStart);
    out.u16(0);
    return out.done();
  }

  /* ==========================================================================
     OOXML 片段构造
     ========================================================================== */
  function relsXml(list) {
    var out = [xmlDecl(), '<Relationships xmlns="' + NS_PR + '">'];
    for (var i = 0; i < list.length; i++) {
      out.push('<Relationship Id="' + xmlEsc(list[i].id) + '" Type="' + list[i].type +
        '" Target="' + xmlEsc(list[i].target) + '"/>');
    }
    out.push('</Relationships>');
    return out.join('');
  }

  function spTree(inner) {
    return '<p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      inner + '</p:spTree>';
  }

  function xfrm(box) {
    return '<a:xfrm><a:off x="' + int(box.x) + '" y="' + int(box.y) + '"/>' +
      '<a:ext cx="' + Math.max(1, int(box.w)) + '" cy="' + Math.max(1, int(box.h)) + '"/></a:xfrm>';
  }

  /**
   * 段落（一行文本）
   * @param {string} text
   * @param {{size:number,bold:boolean,color:string,font:string,eaFont:string,align:string,lnSpcPct:number}} o
   */
  function paraXml(text, o) {
    var sz = clampInt(Math.round(Number(o.size) * 100), 100, 4000, 1200);
    var pPr = '<a:pPr' + (o.align ? ' algn="' + o.align + '"' : '') + '>';
    if (o.lnSpcPct) pPr += '<a:lnSpc><a:spcPct val="' + int(o.lnSpcPct) + '"/></a:lnSpc>';
    pPr += '</a:pPr>';

    if (text === '' || text === null || text === undefined) {
      return '<a:p>' + pPr + '<a:endParaRPr lang="zh-CN" altLang="en-US" sz="' + sz + '"/></a:p>';
    }
    var rPr = '<a:rPr lang="zh-CN" altLang="en-US" sz="' + sz + '"' + (o.bold ? ' b="1"' : '') + ' dirty="0">' +
      '<a:solidFill><a:srgbClr val="' + xmlEsc(o.color || C_INK) + '"/></a:solidFill>' +
      '<a:latin typeface="' + xmlEsc(o.font || FONT_UI) + '"/>' +
      '<a:ea typeface="' + xmlEsc(o.eaFont || FONT_UI) + '"/>' +
      '<a:cs typeface="' + xmlEsc(o.font || FONT_UI) + '"/>' +
      '</a:rPr>';
    return '<a:p>' + pPr + '<a:r>' + rPr +
      '<a:t xml:space="preserve">' + xmlEsc(text) + '</a:t></a:r></a:p>';
  }

  /**
   * 文本框形状
   * @param {number} id 形状 id（同一 slide 内唯一）
   * @param {string} name 形状名
   * @param {{x,y,w,h}} box EMU
   * @param {Array<string>} lines 文本行
   * @param {object} def 默认段落属性
   */
  function textSpXml(id, name, box, lines, def) {
    var body = '';
    for (var i = 0; i < lines.length; i++) {
      var o = {};
      for (var k in def) { if (Object.prototype.hasOwnProperty.call(def, k)) o[k] = def[k]; }
      body += paraXml(lines[i], o);
    }
    return '<p:sp>' +
      '<p:nvSpPr><p:cNvPr id="' + id + '" name="' + xmlEsc(name) + '"/>' +
      '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
      '<p:spPr>' + xfrm(box) + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      '<a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>' +
      '<p:txBody><a:bodyPr wrap="square" anchor="' + (def.anchor || 't') +
      '" lIns="0" tIns="0" rIns="0" bIns="0"><a:noAutofit/></a:bodyPr>' +
      '<a:lstStyle/>' + body + '</p:txBody></p:sp>';
  }

  /** 图片形状（<p:pic> + blipFill + prstGeom rect） */
  function picXml(id, name, rId, box, descr) {
    return '<p:pic>' +
      '<p:nvPicPr><p:cNvPr id="' + id + '" name="' + xmlEsc(name) + '" descr="' + xmlEsc(descr || '') + '"/>' +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="' + xmlEsc(rId) + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      '<p:spPr>' + xfrm(box) + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      '</p:pic>';
  }

  /* ------------------------------------------------------------ 主题（最小完备） */
  var THEME_XML = xmlDecl() +
    '<a:theme xmlns:a="' + NS_A + '" name="YMS 科研主题">' +
    '<a:themeElements>' +
    '<a:clrScheme name="YMS">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="16202A"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="EEF1F4"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="0B6E99"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="B8860B"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="2E7D6B"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="8E44AD"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="C0392B"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="4A5866"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0B6E99"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="7D8B98"/></a:folHlink>' +
    '</a:clrScheme>' +
    '<a:fontScheme name="YMS">' +
    '<a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>' +
    '<a:fmtScheme name="YMS">' +
    '<a:fillStyleLst>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '</a:fillStyleLst>' +
    '<a:lnStyleLst>' +
    '<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '</a:lnStyleLst>' +
    '<a:effectStyleLst>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '</a:effectStyleLst>' +
    '<a:bgFillStyleLst>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '</a:bgFillStyleLst>' +
    '</a:fmtScheme>' +
    '</a:themeElements>' +
    '<a:objectDefaults/><a:extraClrSchemeLst/>' +
    '</a:theme>';

  /* ------------------------------------------------------------ 母版 / 版式 */
  function slideMasterXml() {
    return xmlDecl() +
      '<p:sldMaster xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
      '<p:cSld>' + spTree('') + '</p:cSld>' +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
      'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
      '</p:sldMaster>';
  }

  function slideLayoutXml() {
    return xmlDecl() +
      '<p:sldLayout xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '" type="blank" preserve="1">' +
      '<p:cSld name="空白">' + spTree('') + '</p:cSld>' +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
      '</p:sldLayout>';
  }

  /* ==========================================================================
     版式计算（图片网格 / 文本框尺寸）
     ========================================================================== */
  /**
   * 计算图片网格（未显式给 layout 时按 ceil(sqrt(n)) 自动，最多 6 列）
   * @param {number} n 图片数
   * @param {{rows:number,cols:number}|null} layout
   * @returns {{rows:number,cols:number}}
   */
  function gridOf(n, layout) {
    var cols, rows;
    if (layout && Number(layout.cols) > 0) {
      cols = clampInt(layout.cols, 1, 12, 1);
      rows = clampInt(layout.rows, 1, 12, Math.ceil(n / cols));
      rows = Math.max(rows, Math.ceil(n / cols));
    } else {
      cols = clampInt(Math.ceil(Math.sqrt(Math.max(1, n))), 1, 6, 1);
      rows = Math.max(1, Math.ceil(n / cols));
    }
    if (!n) rows = Math.max(1, rows);
    return { rows: rows, cols: cols };
  }

  /* -------------------------------------------------- 自然尺寸摆放（迭代 10）
     设计要点：截图按「界面实际显示尺寸」截取（CSS px），落到幻灯片时按
     1 CSS px = 1/96 in 的自然尺寸摆放；一页装不下就续包一张，绝不为了塞进
     网格而把图缩成小格子（旧实现把每张图塑成 1280×720 再塞进网格单元格）。
     ========================================================================== */

  /** CSS 像素 → EMU（1 CSS px = 1/96 in，浏览器标准换算） */
  function pxToEmu(px) {
    var v = Math.round((Number(px) || 0) / PX_PER_INCH * EMU_PER_INCH);
    return v > 0 ? v : 0;
  }

  /**
   * 页面页（有标题 + 副标题）的内容区，即图片可用区域（EMU）。
   * 与 build() 中 contentY / contentH 的占位算法严格一致。
   * @returns {{x:number,y:number,w:number,h:number}}
   */
  function contentArea() {
    var y = MARGIN_TOP + TITLE_H + SUBTITLE_H + 18288 + 91440;
    return { x: MARGIN_X, y: y, w: SLIDE_W - MARGIN_X * 2, h: SLIDE_H - y - MARGIN_BOTTOM };
  }

  /**
   * 顺序流式排布：按自然尺寸 × s 左→右、上→下摆放，行内放不下就换行。
   * 返回值同时给出「可缩放部分」与「固定部分」的高度，供 fitScale 精确求缩放系数
   * （分面标签高度固定，不随图片缩放，否则会算出偏大的系数导致溢出）。
   * @param {Array<{w:number,h:number,label?:string}>} items w/h 为 CSS px
   * @param {{x,y,w,h}} area 可用区域（EMU）
   * @param {number} s 统一缩放系数
   * @returns {{placed:Array,w:number,h:number,fixedH:number,scaleH:number}}
   */
  function flowLayout(items, area, s) {
    var right = area.x + area.w;
    var rows = [], placed = [], cur = null;
    var i, r, it, lab, labH, iw, ih;
    for (i = 0; i < items.length; i++) {
      it = items[i] || {};
      lab = (it.label === undefined || it.label === null) ? '' : String(it.label);
      labH = lab ? LABEL_MAX_H : 0;
      iw = Math.max(1, Math.round(pxToEmu(it.w) * s));
      ih = Math.max(1, Math.round(pxToEmu(it.h) * s));
      if (!cur || (cur.count && cur.cursor + iw > right)) {      // 新行（行末放不下）
        cur = { cursor: area.x, imgH: 0, labH: 0, count: 0, y: area.y };
        rows.push(cur);
      }
      placed.push({ src: it, label: lab, w: iw, h: ih, row: rows.length - 1, x: cur.cursor });
      cur.cursor += iw + GAP;
      cur.count++;
      if (ih > cur.imgH) cur.imgH = ih;
      if (labH > cur.labH) cur.labH = labH;
    }
    var y = area.y, maxRight = area.x;
    for (r = 0; r < rows.length; r++) {
      rows[r].y = y;
      y += rows[r].imgH + rows[r].labH + GAP;
    }
    var fixedH = 0, scaleH = 0;
    for (i = 0; i < placed.length; i++) {
      var p = placed[i];
      var row = rows[p.row];
      p.labelBox = p.label ? { x: p.x, y: row.y, w: p.w, h: row.labH } : null;
      p.box = { x: p.x, y: row.y + row.labH, w: p.w, h: p.h };
      if (p.x + p.w > maxRight) maxRight = p.x + p.w;
    }
    for (r = 0; r < rows.length; r++) {
      fixedH += rows[r].labH + (r ? GAP : 0);
      scaleH += rows[r].imgH;
    }
    return {
      placed: placed, w: maxRight - area.x, h: fixedH + scaleH,
      fixedH: fixedH, scaleH: scaleH
    };
  }

  /** 一组图片装进可用区域所需的最大等比缩放（≤1，绝不上采样放大） */
  function fitScale(bbox, area) {
    if (!bbox) return 1;
    var byW = (bbox.w > 0) ? area.w / bbox.w : 1;
    var scaleH = Number(bbox.scaleH) || 0;
    var byH = (scaleH > 0)
      ? Math.max(0, area.h - (Number(bbox.fixedH) || 0)) / scaleH
      : 1;
    var s = Math.min(1, byW, byH);
    if (!isFinite(s) || !(s > 0)) s = 0.0001;
    return s;
  }

  /**
   * 自然尺寸装箱：把同一 Page 的分面图按界面实际尺寸装进幻灯片。
   * 规则（与需求一致）：
   *   · 先算单张图所需的最小等比缩放 s1（≤1）；
   *   · 在不比 s1 缩得更多的前提下，贪心多装（k 越大页数越少）；
   *   · 一组图共用一个缩放系数（相对大小与界面一致），因此不会出现
   *     「每张图被压进 1/3 高度的格子」这种明显变小；
   *   · 只有单张图本身就超出可用区时才等比缩小到刚好放下。
   * @param {Array<{w:number,h:number,label?:string}>} items 自然尺寸（CSS px）
   * @param {{maxPerSlide?:number, area?:object}} [opts]
   * @returns {Array<Array<{src,label,box,labelBox}>>} 每张幻灯片一组
   */
  function packShots(items, opts) {
    opts = opts || {};
    var list = isArr(items) ? items : [];
    var a = opts.area || contentArea();
    var area = {
      x: Number(a.x) || 0, y: Number(a.y) || 0,
      w: Math.max(1, Number(a.w) || 1), h: Math.max(1, Number(a.h) || 1)
    };
    var maxN = clampInt(opts.maxPerSlide, 1, 64, 12);
    var groups = [], i = 0, k, s, guard, f, box;

    while (i < list.length) {
      var rem = Math.min(maxN, list.length - i);
      var slice = list.slice(i, i + rem);
      /* 单张图的基准缩放 s1：宽/高任一超出可用区才缩小，否则 1:1（绝不上采样） */
      var s1 = fitScale(flowLayout(slice.slice(0, 1), area, 1), area);
      /* 在 s1 这一缩放水平上贪心多装：还能放下就继续加（换行也算放下） */
      var bestK = 1;
      box = flowLayout(slice.slice(0, 1), area, s1);
      for (k = 2; k <= rem; k++) {
        var cand = flowLayout(slice.slice(0, k), area, s1);
        if (cand.w > area.w + 1 || cand.h > area.h + 1) break;
        bestK = k;
        box = cand;
      }
      /* 间距固定不随缩放变小，四舍五入后若仍溢出则微缩（最多 4 轮） */
      var s = s1;
      guard = 0;
      while (guard++ < 4 && (box.w > area.w || box.h > area.h)) {
        f = Math.min(area.w / Math.max(1, box.w), area.h / Math.max(1, box.h));
        s = s * f * 0.996;
        box = flowLayout(slice.slice(0, bestK), area, s);
      }
      /* 整组水平居中：只调整留白分布，不改变任何图片的尺寸 */
      if (box.placed.length && box.w < area.w) {
        var dx = Math.round((area.w - box.w) / 2);
        for (var q = 0; q < box.placed.length; q++) {
          box.placed[q].box.x += dx;
          if (box.placed[q].labelBox) box.placed[q].labelBox.x += dx;
        }
      }
      groups.push(box.placed);
      i += bestK;
    }
    return groups;
  }

  /** 单行文本的显示宽度（东亚全角按 2 计） */
  function textWidth(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      w += (c >= 0x1100 && (c <= 0x115F || c === 0x2329 || c === 0x232A ||
        (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3) ||
        (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE6F) ||
        (c >= 0xFF00 && c <= 0xFF60) || (c >= 0xFFE0 && c <= 0xFFE6))) ? 2 : 1;
    }
    return w;
  }

  /**
   * 文本框字号自适应（按行数×行距与最长行宽双向收缩，clamp 到 [minPt, maxPt]）
   * @returns {number} pt
   */
  function fitFontSize(lines, availW, availH, maxPt, minPt, mono) {
    var n = Math.max(1, lines.length);
    var byH = (availH / EMU_PER_PT) / (n * 1.18);
    var widest = 1, i;
    for (i = 0; i < lines.length; i++) widest = Math.max(widest, textWidth(lines[i]));
    var adv = mono ? 0.55 : 0.9;                       // 字符平均宽度系数
    var byW = (availW / EMU_PER_PT) / (widest * adv);
    var pt = Math.floor(Math.min(byH, byW, maxPt));
    if (!isFinite(pt) || pt < minPt) pt = minPt;
    return pt;
  }

  /* ==========================================================================
     主流程：build(spec) -> Uint8Array
     ========================================================================== */
  /**
   * 生成 .pptx 字节流（任何异常都不外抛：内部降级为最小可打开演示文稿）
   * @param {object} spec 见文件头注释
   * @returns {Uint8Array}
   */
  function build(spec) {
    spec = spec || {};
    var slidesIn = isArr(spec.slides) ? spec.slides : [];
    var now = spec.createdAt instanceof Date ? spec.createdAt : new Date();

    var mediaList = [];                 // [{name, bytes}]
    var mediaKey = {};                  // dataURL/base64 文本 → 媒体序号（1 基）
    var slideParts = [];                // [{xml, rels:[{id,type,target}]}]

    function mediaFor(png) {
      var bytes;
      /* 兼容跨 realm 的 typed array（harness vm 沙箱 / 不同 iframe）→ 按鸭子类型判断 */
      if (png && typeof png !== 'string' && typeof png.length === 'number' && typeof png.subarray === 'function') {
        bytes = png;
      } else if (png && png.buffer && typeof png.length === 'number') {
        bytes = new Uint8Array(png.buffer, png.byteOffset || 0, png.length);
      } else {
        bytes = decodePng(png);
      }
      if (!isPng(bytes)) return null;
      var key = (typeof png === 'string') ? png : null;
      if (key && mediaKey[key]) return mediaKey[key];
      for (var i = 0; i < mediaList.length; i++) {          // 非字符串输入按字节长度 + 头部指纹去重
        if (!key && mediaList[i].bytes.length === bytes.length && mediaList[i].bytes[0] === bytes[0] &&
          mediaList[i].bytes[16] === bytes[16] && mediaList[i].bytes[20] === bytes[20] &&
          mediaList[i].bytes[bytes.length - 1] === bytes[bytes.length - 1]) return i + 1;
      }
      mediaList.push({ name: 'ppt/media/image' + (mediaList.length + 1) + '.png', bytes: bytes });
      if (key) mediaKey[key] = mediaList.length;
      return mediaList.length;
    }

    var s, i, k;

    /* ---------------- 逐页组装 ---------------- */
    for (s = 0; s < slidesIn.length; s++) {
      var sl = slidesIn[s] || {};
      var shapes = [];
      /* 每个 slide 必须有自己的 .rels，且必须含指向版式（slideLayout）的关系，
         否则 PowerPoint 判定文件损坏无法读取（实测 0x80070570）。图片关系从 rId2 起。 */
      var rels = [{ id: 'rId1', type: RT.slideLayout, target: '../slideLayouts/slideLayout1.xml' }];
      var idNext = 2;

      var title = xmlClean(sl.title === undefined ? '' : String(sl.title));
      var subtitle = xmlClean(sl.subtitle === undefined ? '' : String(sl.subtitle));
      var textLines = (sl.text === undefined || sl.text === null || sl.text === '') ? [] : String(sl.text).split('\n');
      var imgs = isArr(sl.images) ? sl.images : [];

      /* 标题 */
      if (title) {
        shapes.push(textSpXml(idNext++, '标题', { x: MARGIN_X, y: MARGIN_TOP, w: SLIDE_W - MARGIN_X * 2, h: TITLE_H },
          [title], {
          size: 20, bold: true, color: C_ACCENT, font: FONT_UI, eaFont: FONT_UI,
          align: 'l', lnSpcPct: 100000, anchor: 'ctr'
        }));
      }
      /* 副标题 */
      var contentY = MARGIN_TOP + (title ? TITLE_H : 0);
      if (subtitle) {
        shapes.push(textSpXml(idNext++, '副标题', { x: MARGIN_X, y: contentY + 18288, w: SLIDE_W - MARGIN_X * 2, h: SUBTITLE_H },
          [subtitle], {
          size: 10, bold: false, color: C_DIM, font: FONT_UI, eaFont: FONT_UI,
          align: 'l', lnSpcPct: 100000, anchor: 't'
        }));
        contentY += SUBTITLE_H + 18288;
      }
      contentY += (title || subtitle) ? 91440 : 0;
      var contentH = SLIDE_H - contentY - MARGIN_BOTTOM;
      if (contentH < 457200) contentH = SLIDE_H - contentY - 91440;     // 极端几何兜底
      var innerW = SLIDE_W - MARGIN_X * 2;

      /* 图片区（先算，文本区吃掉上方一条） */
      var useImgs = [];
      var grid = { rows: 1, cols: 1 };
      if (imgs.length) {
        for (i = 0; i < imgs.length; i++) {
          var im = imgs[i] || {};
          var mIdx = mediaFor(im.png);
          if (!mIdx) continue;                                   // 非 PNG → 跳过（不写坏包）
          var bts = mediaList[mIdx - 1].bytes;
          var sz = pngSize(bts);
          var iw = sz ? sz.w : (Number(im.w) > 0 ? Number(im.w) : 1280);
          var ih = sz ? sz.h : (Number(im.h) > 0 ? Number(im.h) : 720);
          var rId = 'rId' + (rels.length + 1);
          rels.push({ id: rId, type: RT.image, target: '', media: mIdx });
          useImgs.push({
            rId: rId, w: iw, h: ih,
            label: im.label === undefined ? '' : String(im.label),
            /* 自然尺寸摆放：report.js 已按界面实际尺寸算好绝对位置（EMU）。 */
            box: (im.box && im.box.w > 0 && im.box.h > 0) ? im.box : null,
            labelBox: (im.labelBox && im.labelBox.w > 0) ? im.labelBox : null
          });
        }
        if (useImgs.length) grid = gridOf(useImgs.length, sl.layout);
      }

      var imgY = contentY, imgH = contentH;
      if (textLines.length && useImgs.length) {
        var bandH = Math.min(Math.round(contentH * 0.42), Math.max(228600, textLines.length * 228600));
        imgY = contentY + bandH + 91440;
        imgH = Math.max(457200, SLIDE_H - imgY - MARGIN_BOTTOM);
      } else if (textLines.length) {
        var pt = (Number(sl.textSize) > 0) ? Number(sl.textSize)
          : fitFontSize(textLines, innerW, contentH, 14, 6, sl.textMono !== false);
        shapes.push(textSpXml(idNext++, '正文', { x: MARGIN_X, y: contentY, w: innerW, h: contentH }, textLines, {
          size: pt, bold: false, color: C_INK,
          font: sl.textMono === false ? FONT_UI : FONT_MONO,
          eaFont: FONT_UI, align: 'l', lnSpcPct: 100000, anchor: 't'
        }));
      }

      /* 文本 + 图片混排时的文本条 */
      if (textLines.length && useImgs.length) {
        var bandH2 = imgY - contentY - 91440;
        var pt2 = (Number(sl.textSize) > 0) ? Number(sl.textSize)
          : fitFontSize(textLines, innerW, bandH2, 12, 6, sl.textMono !== false);
        shapes.push(textSpXml(idNext++, '正文', { x: MARGIN_X, y: contentY, w: innerW, h: bandH2 }, textLines, {
          size: pt2, bold: false, color: C_INK,
          font: sl.textMono === false ? FONT_UI : FONT_MONO,
          eaFont: FONT_UI, align: 'l', lnSpcPct: 100000, anchor: 't'
        }));
      }

      /* 图片摆放：
         · 给了绝对位置（box）→ 自然尺寸摆放，原样落位（不塞网格、不再缩放）；
         · 未给位置 → 兼容旧行为：按网格单元格 contain 铺排（自测/外部调用）。 */
      if (useImgs.length) {
        var allBoxed = true;
        for (i = 0; i < useImgs.length; i++) { if (!useImgs[i].box) { allBoxed = false; break; } }
        if (allBoxed) {
          for (i = 0; i < useImgs.length; i++) {
            var nb = useImgs[i];
            if (nb.label) {
              var labBox = nb.labelBox ||
                { x: nb.box.x, y: Math.max(0, nb.box.y - LABEL_MAX_H), w: nb.box.w, h: LABEL_MAX_H };
              var labPt2 = clampInt(Math.round(labBox.h / EMU_PER_PT * 0.62), 6, 10, 8);
              shapes.push(textSpXml(idNext++, '分面标题' + (i + 1), labBox, [nb.label], {
                size: labPt2, bold: false, color: C_SOFT, font: FONT_UI, eaFont: FONT_UI,
                align: 'l', lnSpcPct: 100000, anchor: 't'
              }));
            }
            shapes.push(picXml(idNext++, '图片' + (i + 1), nb.rId, nb.box,
              nb.label || ('图表 ' + (i + 1))));
          }
        } else {
          var cols = grid.cols, rows = grid.rows;
          var cellW = Math.floor((innerW - (cols - 1) * GAP) / cols);
          var cellH = Math.floor((imgH - (rows - 1) * GAP) / rows);
          if (cellW < 91440) cellW = 91440;
          if (cellH < 91440) cellH = 91440;
          var labH = Math.min(LABEL_MAX_H, Math.max(0, Math.round(cellH * 0.16)));
          var labPt = clampInt(Math.round(labH / EMU_PER_PT * 0.62), 6, 10, 8);
          for (i = 0; i < useImgs.length; i++) {
            var it = useImgs[i];
            var r = Math.floor(i / cols), c = i % cols;
            var cx = MARGIN_X + c * (cellW + GAP);
            var cy = imgY + r * (cellH + GAP);
            if (it.label) {
              shapes.push(textSpXml(idNext++, '分面标题' + (i + 1), { x: cx, y: cy, w: cellW, h: labH },
                [it.label], {
                size: labPt, bold: false, color: C_SOFT, font: FONT_UI, eaFont: FONT_UI,
                align: 'l', lnSpcPct: 100000, anchor: 't'
              }));
            }
            var areaY = cy + labH;
            var areaH = Math.max(45720, cellH - labH);
            var sc = Math.min(cellW / it.w, areaH / it.h);
            var dw = Math.max(1, Math.round(it.w * sc));
            var dh = Math.max(1, Math.round(it.h * sc));
            if (dw > cellW) dw = cellW;                    // 四舍五入防溢出单元格
            if (dh > areaH) dh = areaH;
            shapes.push(picXml(idNext++, '图片' + (i + 1), it.rId,
              { x: cx + Math.round((cellW - dw) / 2), y: areaY + Math.round((areaH - dh) / 2), w: dw, h: dh },
              it.label || ('图表 ' + (i + 1))));
          }
        }
      }

      /* slide 部件 rels：保留指向版式的关系，图片指向 ../media/imageN.png */
      var slideRels = [];
      for (k = 0; k < rels.length; k++) {
        slideRels.push(rels[k].media
          ? { id: rels[k].id, type: rels[k].type, target: '../media/image' + rels[k].media + '.png' }
          : { id: rels[k].id, type: rels[k].type, target: rels[k].target });
      }

      slideParts.push({
        xml: xmlDecl() +
          '<p:sld xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
          '<p:cSld>' + spTree(shapes.join('')) + '</p:cSld>' +
          '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
          '</p:sld>',
        rels: slideRels,
        title: title
      });
    }

    /* 至少一页（空演示文稿也必须结构完整） */
    if (!slideParts.length) {
      slideParts.push({
        xml: xmlDecl() +
          '<p:sld xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
          '<p:cSld>' + spTree('') + '</p:cSld>' +
          '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
        rels: [{ id: 'rId1', type: RT.slideLayout, target: '../slideLayouts/slideLayout1.xml' }], title: ''
      });
    }

    var nSlides = slideParts.length;
    var themeRId = 'rId' + (nSlides + 2);

    /* ---------------- [Content_Types].xml ---------------- */
    var ct = [xmlDecl(), '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="' + CT.rels + '"/>',
      '<Default Extension="xml" ContentType="' + CT.xml + '"/>',
      '<Default Extension="png" ContentType="' + CT.png + '"/>',
      '<Override PartName="/ppt/presentation.xml" ContentType="' + CT.presentation + '"/>',
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="' + CT.slideMaster + '"/>',
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="' + CT.slideLayout + '"/>',
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="' + CT.theme + '"/>',
      '<Override PartName="/docProps/core.xml" ContentType="' + CT.core + '"/>',
      '<Override PartName="/docProps/app.xml" ContentType="' + CT.app + '"/>'];
    for (s = 0; s < nSlides; s++) {
      ct.push('<Override PartName="/ppt/slides/slide' + (s + 1) + '.xml" ContentType="' + CT.slide + '"/>');
    }
    ct.push('</Types>');

    /* ---------------- _rels/.rels ---------------- */
    var rootRels = relsXml([
      { id: 'rId1', type: RT.officeDocument, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: RT.core, target: 'docProps/core.xml' },
      { id: 'rId3', type: RT.app, target: 'docProps/app.xml' }
    ]);

    /* ---------------- ppt/presentation.xml (+rels) ---------------- */
    var presRels = [{ id: 'rId1', type: RT.slideMaster, target: 'slideMasters/slideMaster1.xml' }];
    var sldIds = [];
    for (s = 0; s < nSlides; s++) {
      presRels.push({ id: 'rId' + (s + 2), type: RT.slide, target: 'slides/slide' + (s + 1) + '.xml' });
      sldIds.push('<p:sldId id="' + (256 + s) + '" r:id="rId' + (s + 2) + '"/>');
    }
    presRels.push({ id: themeRId, type: RT.theme, target: 'theme/theme1.xml' });

    var presXml = xmlDecl() +
      '<p:presentation xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '" saveSubsetFonts="1">' +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst>' + sldIds.join('') + '</p:sldIdLst>' +
      '<p:sldSz cx="' + SLIDE_W + '" cy="' + SLIDE_H + '"/>' +
      '<p:notesSz cx="' + SLIDE_H + '" cy="' + SLIDE_W + '"/>' +
      '</p:presentation>';

    /* ---------------- 文档属性 ---------------- */
    var iso = now.getUTCFullYear() + '-' + p2(now.getUTCMonth() + 1) + '-' + p2(now.getUTCDate()) + 'T' +
      p2(now.getUTCHours()) + ':' + p2(now.getUTCMinutes()) + ':' + p2(now.getUTCSeconds()) + 'Z';
    var docTitle = xmlEsc(spec.title || 'YMS 数据报告');
    var author = xmlEsc(spec.author || 'YMS 良率管理系统');
    var coreXml = xmlDecl() +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + docTitle + '</dc:title>' +
      '<dc:creator>' + author + '</dc:creator>' +
      '<cp:lastModifiedBy>' + author + '</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:modified>' +
      '</cp:coreProperties>';
    var appXml = xmlDecl() +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>YMS 良率管理系统</Application>' +
      '<PresentationFormat>宽屏</PresentationFormat>' +
      '<Slides>' + nSlides + '</Slides>' +
      '<Notes>0</Notes>' +
      '<HiddenSlides>0</HiddenSlides>' +
      '<AppVersion>1.0000</AppVersion>' +
      '</Properties>';

    /* ---------------- 打包（顺序：内容类型 → rels → 各部件 → 媒体） ---------------- */
    var files = [];
    files.push({ name: '[Content_Types].xml', data: utf8(ct.join('')) });
    files.push({ name: '_rels/.rels', data: utf8(rootRels) });
    files.push({ name: 'docProps/core.xml', data: utf8(coreXml) });
    files.push({ name: 'docProps/app.xml', data: utf8(appXml) });
    files.push({ name: 'ppt/presentation.xml', data: utf8(presXml) });
    files.push({ name: 'ppt/_rels/presentation.xml.rels', data: utf8(relsXml(presRels)) });
    files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: utf8(slideMasterXml()) });
    files.push({
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: utf8(relsXml([
        { id: 'rId1', type: RT.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', type: RT.theme, target: '../theme/theme1.xml' }
      ]))
    });
    files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: utf8(slideLayoutXml()) });
    files.push({
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: utf8(relsXml([
        { id: 'rId1', type: RT.slideMaster, target: '../slideMasters/slideMaster1.xml' }
      ]))
    });
    files.push({ name: 'ppt/theme/theme1.xml', data: utf8(THEME_XML) });
    for (s = 0; s < nSlides; s++) {
      var sp = slideParts[s];
      files.push({ name: 'ppt/slides/slide' + (s + 1) + '.xml', data: utf8(sp.xml) });
      /* 无条件写出：每个 slide 都必须有 .rels（至少含 slideLayout 关系） */
      files.push({
        name: 'ppt/slides/_rels/slide' + (s + 1) + '.xml.rels',
        data: utf8(relsXml(sp.rels))
      });
    }
    for (i = 0; i < mediaList.length; i++) {
      files.push({ name: mediaList[i].name, data: mediaList[i].bytes });
    }

    return zip(files, now);
  }

  function p2(n) { return (n < 10 ? '0' : '') + n; }

  /* ==========================================================================
     对外暴露
     ========================================================================== */
  YMS.Pptx = {
    build: build,
    decodePng: decodePng,
    pngSize: pngSize,
    crc32: crc32,
    isPng: isPng,
    gridOf: gridOf,
    /* 自然尺寸摆放（迭代 10）：report.js 用 packShots 决定每张幻灯片装几张图 */
    packShots: packShots,
    contentArea: contentArea,
    pxToEmu: pxToEmu,
    VERSION: VERSION,
    PX_PER_INCH: PX_PER_INCH,
    EMU_PER_INCH: EMU_PER_INCH,
    SLIDE_W: SLIDE_W,
    SLIDE_H: SLIDE_H
  };
})(typeof window !== 'undefined' ? window : this);
