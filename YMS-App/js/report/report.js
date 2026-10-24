/* ==========================================================================
   YMS · report/report.js
   报告导出层（YMS.Report）—— 把当前会话汇总成一份**完全自包含**的单文件 HTML 报告：
     报表头 / 处理说明 / 参数统计摘要 / 全部图表截图 / 绘图配置 / 数据预览

   职责边界：
     · 只读 YMS.Store（df、dataSettings、plot、ui.processingNotes、View），不写任何状态；
     · 图表截图复用 YMS.Aggregate（Work）+ YMS.ChartBuilder.buildOption（与屏幕显示同一份配置），
       自行创建隐藏容器与 ECharts 实例，截完即 dispose，不影响参数绘图区；
     · 导出的 HTML 内联全部样式与 base64 PNG，双击即可离线查看，不引用任何外链。

   硬约束：file:// 下运行 —— 禁止 ES module / fetch / XHR / Worker / CDN / 外链资源；
           ES2017 以内语法（不使用可选链与空值合并）；任何路径不得抛未捕获异常；
           无数据时 toast('请先导入数据','warn') 并返回 null。

   公开 API（见 DEV-SPEC 3.E1）：
     YMS.Report.build()        -> Promise<{html, fileName, chartCount, chartImages}|null>
     YMS.Report.exportHTML()   -> Promise<{...}|null>   下载 <tableName>-报告-<stamp>.html
     YMS.Report.exportPPT()    -> Promise<{ok, fileName, slides, chartCount, size}|null>
                                                   下载 <tableName>-报告-<stamp>.pptx（真正的 PPTX）
     YMS.Report.buildPptxSpec(o) -> object             PPTX 规格拼装（纯函数，供自测断言 slide 数）
     YMS.Report.openPreview()  -> Promise<{...}|null>   弹窗预览（iframe srcdoc + sandbox）
     YMS.Report.MAX_CHARTS / PREVIEW_ROWS / CHART_TIMEOUT / PPT_*   常量，供编排层与自测读取

   PPTX 导出（exportPPT）：按 Aggregate 的 Page 分页，**每个 Page 按界面实际尺寸摆放**：
     截图容器 = 该卡片在界面上真实占用的内容盒尺寸（当前页量测真实 DOM，其他页按
     YMS.PlotView._layoutSize 同一套公式推算），pixelRatio 2 保证清晰；
     落到幻灯片时按 1 CSS px = 1/96 in 的自然英寸摆放，一页装不下就续包一张
     （标题标 (1/2)），只有单张图本身超出可用区才等比缩小 —— 不再把图塑成 1280×720
     再塞进网格单元格（那会把图缩得很小）。
     幻灯片：第 1 页 = 标题页，第 2 页 = 参数统计摘要，第 3 页起 = 各 Page。
     zip/OOXML 由 js/report/pptx.js（YMS.Pptx）零依赖写出。
   ========================================================================== */
(function (global) {
  'use strict';

  var YMS = global.YMS = global.YMS || {};
  var U = YMS.util;

  /* ==========================================================================
     常量与中文词典
     ========================================================================== */
  var MAX_CHARTS = 120;      // 单份报告的图表截图上限（超出截断并说明）
  var CHART_TIMEOUT = 300;   // 等待 echarts 'finished' 事件的兜底超时（ms）
  var PREVIEW_ROWS = 100;    // 数据预览行数
  var SHOT_W = 960;          // 截图容器尺寸（与 PlotView 卡片比例接近）
  var SHOT_H = 560;

  /* ------------------------------------------------------------- PPT 导出常量 */
  /* 迭代 10：截图尺寸 = 该卡片在界面上**实际显示的内容盒尺寸**（不再固定 1280×720），
     因此纵横比与界面完全一致；PPT 里按 1 CSS px = 1/96 in 的自然尺寸摆放。 */
  var PPT_PIXEL_RATIO = 2;        // 截图像素密度（2 倍，保证投影/放大清晰）
  var PPT_MAX_PER_SLIDE = 12;     // 单页幻灯片最多分面图数（超过则续包并标 (1/2)）
  var PPT_CSS_PER_IN = 96;        // CSS px → 英寸
  var PPT_CARD_HEAD_H = 24;       // .chart-card .card-head 高度（plot.css）
  var PPT_CARD_BORDER = 2;        // 卡片 1px 边框 × 2
  var PPT_GRID_GAP = 10;          // .chart-grid gap（plot.css）
  var PPT_SINGLE_MAX_W = 900;     // .chart-grid.is-single .chart-card max-width（plot.css）
  var PPT_MIN_CARD_H = 240;       // plot-view.js MIN_CARD_H（布局同源兜底）
  var PPT_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

  var MISSING_LABEL = {
    none: '不处理', drop: '删除含缺失的行',
    mean: '均值填充', median: '中位数填充', zero: '0 填充'
  };
  var PLOT_TYPE_LABEL = {
    scatter: 'Scatter 散点图', line: 'Line 折线图', box: 'Box 箱线图',
    bar: 'Bar 柱状图', hist: 'Hist 直方图'
  };
  var FIT_LABEL = {
    none: '无', linear: '线性', quadratic: '二次多项式', cubic: '三次多项式',
    poly: '多项式', exp: '指数', log: '对数', power: '幂函数'
  };
  var DIR_LABEL = { asc: '升序', desc: '降序' };

  /* ==========================================================================
     导出 HTML 的内联样式（浅色底 / 紧凑表格 / 等宽数字 / 章节下边框 / A4 打印友好）
     ========================================================================== */
  var CSS = [
    '* { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; background: #eef1f4; color: #16202a;',
    '  font-family: "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;',
    '  font-size: 13px; line-height: 1.62; -webkit-text-size-adjust: 100%; }',
    '.rep { max-width: 1020px; margin: 0 auto; padding: 34px 34px 48px; background: #fff;',
    '  border-left: 1px solid #d3dae0; border-right: 1px solid #d3dae0; min-height: 100vh; }',
    /* 报表头 */
    '.rep-head { border-bottom: 3px double #b6c0c9; padding-bottom: 14px; margin-bottom: 6px; }',
    '.rep-kicker { margin: 0; font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: #0b6e99; font-weight: 700; }',
    '.rep-title { margin: 6px 0 2px; font-size: 23px; line-height: 1.3; font-weight: 700; letter-spacing: .01em; }',
    '.rep-sub { margin: 0 0 12px; font-size: 12px; color: #7d8b98; }',
    'table.rep-meta { width: 100%; border-collapse: collapse; font-size: 12px; }',
    'table.rep-meta th, table.rep-meta td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #e9edf0; vertical-align: top; }',
    'table.rep-meta th { width: 118px; color: #6b7a87; font-weight: 600; white-space: nowrap; background: #f7f9fa; }',
    /* 章节 */
    'h2.rep-h { margin: 30px 0 10px; padding-bottom: 6px; font-size: 15px; color: #0b6e99;',
    '  border-bottom: 1px solid #b6c0c9; letter-spacing: .02em; }',
    'h2.rep-h .rep-no { display: inline-block; min-width: 26px; color: #b8860b; font-weight: 700; }',
    'h3.rep-h3 { margin: 16px 0 6px; font-size: 13px; color: #4a5866; font-weight: 700; }',
    /* 表格 */
    'table.rep-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
    'table.rep-table th { background: #f2f5f7; border: 1px solid #d3dae0; padding: 4px 7px;',
    '  font-weight: 600; color: #4a5866; text-align: left; white-space: nowrap; }',
    'table.rep-table td { border: 1px solid #e3e8ec; padding: 3px 7px; vertical-align: top; }',
    'table.rep-table tr:nth-child(even) td { background: #fbfcfd; }',
    'table.rep-table td.num, table.rep-table th.num { text-align: right; white-space: nowrap; }',
    '.num, .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, "SFMono-Regular", monospace;',
    '  font-variant-numeric: tabular-nums; }',
    'table.rep-table.kv td.k { width: 150px; color: #4a5866; background: #f7f9fa; font-weight: 600; white-space: nowrap; }',
    '.ty { display: inline-block; margin-left: 4px; padding: 0 4px; border: 1px solid #d3dae0; border-radius: 2px;',
    '  font-size: 9px; line-height: 14px; color: #7d8b98; background: #fff; font-family: ui-monospace, Consolas, monospace;',
    '  text-transform: lowercase; vertical-align: 1px; }',
    'td.empty { color: #c3ccd3; }',
    /* 说明块 */
    'p.note { margin: 10px 0; padding: 8px 12px; background: #f7f9fa; border-left: 3px solid #0b6e99;',
    '  font-size: 12px; color: #4a5866; }',
    'p.note.warn { border-left-color: #b7791f; background: #fdf8ee; }',
    'p.rep-empty { margin: 8px 0; font-size: 12px; color: #7d8b98; font-style: italic; }',
    'ol.rep-notes { margin: 6px 0 0; padding-left: 22px; font-size: 12px; }',
    'ol.rep-notes li { margin: 2px 0; }',
    /* 图表 */
    'figure.fig { margin: 14px 0 20px; padding: 10px 10px 8px; border: 1px solid #e3e8ec; background: #fcfdfe;',
    '  page-break-inside: avoid; break-inside: avoid; }',
    'figure.fig figcaption { margin: 0 0 2px; font-size: 12px; font-weight: 700; color: #16202a; }',
    'figure.fig .fig-sub { margin: 0 0 6px; font-size: 11px; color: #7d8b98; white-space: pre-line; }',
    'figure.fig img { display: block; width: 100%; height: auto; border: 1px solid #e9edf0; background: #fff; }',
    /* 页脚 */
    '.rep-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 34px;',
    '  padding-top: 10px; border-top: 1px solid #e9edf0; font-size: 11px; color: #7d8b98; }',
    /* A4 打印 */
    '@page { size: A4; margin: 14mm 12mm; }',
    '@media print {',
    '  html, body { background: #fff; font-size: 11px; }',
    '  .rep { max-width: none; padding: 0; border: 0; min-height: 0; }',
    '  h2.rep-h { page-break-after: avoid; break-after: avoid; }',
    '  table.rep-table { page-break-inside: auto; }',
    '  table.rep-table thead { display: table-header-group; }',
    '  figure.fig { border-color: #ccc; background: #fff; }',
    '  p.note { background: #fff; border-left-color: #999; }',
    '  .rep-foot { position: static; }',
    '}'
  ].join('\n');

  /* ==========================================================================
     基础格式化工具（内部）
     ========================================================================== */
  function esc(s) { return U.escapeHtml(s); }

  /** 本地时间 'YYYY-MM-DD HH:MM:SS' */
  function fmtDateTime(d) {
    return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()) +
      ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes()) + ':' + U.pad2(d.getSeconds());
  }

  /**
   * 数值文本：优先列小数位；自动模式抑制浮点噪声（0.52270000000001 → 0.5227）
   * @param {number|null} v
   * @param {number|null|undefined} decimals 列小数位（null/'' = 自动）
   * @returns {string} 已转义的 HTML 文本
   */
  function numText(v, decimals) {
    if (v === null || v === undefined) return '—';
    if (typeof v !== 'number' || isNaN(v)) return esc(String(v));
    if (decimals !== null && decimals !== undefined && decimals !== '') {
      return v.toFixed(U.clamp(Number(decimals), 0, 8));
    }
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e7 || a < 1e-4)) return v.toExponential(4);
    return String(Number(v.toPrecision(6)));
  }

  function typeLabel(type) {
    if (YMS.types && YMS.types.TYPE_LABEL && YMS.types.TYPE_LABEL[type]) return YMS.types.TYPE_LABEL[type];
    return type || '';
  }

  function isTime(type) { return !!(YMS.types && type === YMS.types.TIME); }

  function timeText(ms, timeStyle) {
    if (YMS.types && YMS.types.formatTime) return YMS.types.formatTime(ms, timeStyle || 'datetime');
    return String(ms);
  }

  /** 统计单元格（时间列显示为时间字符串，其余按列小数位） */
  function statCell(v, col, decimals) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number' && isNaN(v)) return '—';
    if (isTime(col.type)) return timeText(v, col.timeStyle);
    return numText(v, decimals);
  }

  /** 标准差单元格：时间列的标准差是**时长（毫秒）**，不能当时间戳格式化 */
  function stdCell(v, col, decimals) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number' && isNaN(v)) return '—';
    return numText(v, decimals) + (isTime(col.type) ? ' ms' : '');
  }

  function decimalsOf(view, name) {
    var d = view && view.decimals ? view.decimals[name] : null;
    return (d === undefined) ? null : d;
  }

  function joinNames(arr) {
    if (!arr || !arr.length) return '—';
    return arr.map(function (x) { return typeof x === 'string' ? x : (x && x.name ? x.name : String(x)); }).join('、');
  }

  function sortersText(sorters) {
    if (!sorters || !sorters.length) return '无';
    return sorters.map(function (s) {
      return s.col + ' ' + (DIR_LABEL[s.dir] || DIR_LABEL.asc);
    }).join(' → ');
  }

  function filterText(f) {
    var op = f.op || '=';
    if (op === '缺失' || op === 'isMissing') return f.col + ' 缺失';
    if (op === '非缺失' || op === 'notMissing') return f.col + ' 非缺失';
    if (op === '包含' || op === '不包含') return f.col + ' ' + op + '「' + (f.value === undefined ? '' : f.value) + '」';
    if (op === '区间') return f.col + ' 在 ' + (f.value === undefined ? '' : f.value) + ' ~ ' + (f.value2 === undefined ? '' : f.value2) + ' 之间';
    return f.col + ' ' + op + ' ' + (f.value === undefined || f.value === null ? '' : f.value);
  }

  function safeFileName(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/^\.+/, '').trim() || '数据表';
  }

  /* ==========================================================================
     进度条安全包装（harness / 无 #progress-root 环境下不得抛异常）
     ========================================================================== */
  function progressOpen(title, note) { try { if (U.progress && U.progress.open) U.progress.open(title, note); } catch (e) { } }
  function progressUpdate(pct, note) { try { if (U.progress && U.progress.update) U.progress.update(pct, note); } catch (e) { } }
  function progressClose() { try { if (U.progress && U.progress.close) U.progress.close(); } catch (e) { } }

  /* ==========================================================================
     图表截图
     ========================================================================== */
  /** 扁平图表元信息（页/分面标签），与 Aggregate.chartOf 的扁平序号一一对应 */
  function flatMeta(work) {
    var out = [];
    if (!work || !work.pages) return out;
    for (var p = 0; p < work.pages.length; p++) {
      var pg = work.pages[p] || {};
      var facets = pg.facets || [];
      for (var f = 0; f < facets.length; f++) {
        var fa = facets[f] || {};
        out.push({
          pageLabel: pg.label || pg.key || '',
          facetLabel: fa.label || '',
          title: fa.title || ''
        });
      }
    }
    return out;
  }

  /** 等待 echarts 渲染完成（'finished' 事件；CHART_TIMEOUT 兜底） */
  function waitFinished(inst) {
    return new Promise(function (resolve) {
      if (!inst || typeof inst.on !== 'function') { setTimeout(resolve, 0); return; }
      var done = false;
      function fin() { if (done) return; done = true; resolve(); }
      try { inst.on('finished', fin); } catch (e) { }
      setTimeout(fin, CHART_TIMEOUT);
    });
  }

  /**
   * 截图专用 option：在 buildOption 结果上关闭动画。
   * 原因：ECharts 的 'finished' 事件在**初始帧**渲染后即触发，柱/线系列的入场动画随后才开始，
   *       离屏容器里若等待 'finished' 或 300ms 兜底就取图，会得到「只有坐标轴没有数据」的空图
   *       （实测深色像素 8 521 vs 关闭动画后 440 846）。截图是静态快照，动画无意义。
   * @param {object} opt YMS.ChartBuilder.buildOption(...) 的返回值
   * @returns {object} 浅拷贝 + animation:false（不修改原对象）
   */
  function shotOption(opt) {
    if (!opt || typeof opt !== 'object') return opt;
    var o = {};
    for (var k in opt) { if (Object.prototype.hasOwnProperty.call(opt, k)) o[k] = opt[k]; }
    o.animation = false;
    return o;
  }

  /** 初始化截图用 ECharts 实例（主题与 PlotView 保持一致；主题名不存在时回退） */
  function initShot(el) {
    var ec = global.echarts;
    var theme = null;
    if (YMS.ChartBuilder && typeof YMS.ChartBuilder.THEME === 'string') theme = YMS.ChartBuilder.THEME;
    else theme = 'yms-registered';
    try { return ec.init(el, theme); } catch (e) { }
    try { return ec.init(el); } catch (e2) { return null; }
  }

  /**
   * 截取当前绘图配置下的全部图表（跨页 / 跨分面，最多 MAX_CHARTS 张）
   * 任何依赖缺失（Aggregate / ChartBuilder / echarts）或渲染失败都降级为说明文字，绝不抛异常。
   * @returns {Promise<{images:Array, total:number, truncated:boolean, note:string, work:object|null}>}
   */
  async function captureCharts() {
    var result = { images: [], total: 0, truncated: false, note: '', work: null };
    var ec = global.echarts;
    var Agg = YMS.Aggregate;
    var CB = YMS.ChartBuilder;

    if (!ec || typeof ec.init !== 'function') {
      result.note = '当前环境未加载 ECharts，本次报告未包含图表截图。';
      return result;
    }
    if (!Agg || typeof Agg.build !== 'function' || typeof Agg.chartOf !== 'function') {
      result.note = '图表模块（YMS.Aggregate）尚未就绪，本次报告未包含图表截图。';
      return result;
    }
    if (!CB || typeof CB.buildOption !== 'function') {
      result.note = '图表构建模块（YMS.ChartBuilder）尚未就绪，本次报告未包含图表截图。';
      return result;
    }

    var work = null;
    try { work = Agg.build(); }
    catch (e) {
      if (global.console && console.error) console.error('[YMS.Report] 图表数据构建失败：', e);
      result.note = '图表数据构建失败（' + (e && e.message ? e.message : e) + '），本次报告未包含图表截图。';
      return result;
    }
    result.work = work;

    var total = (work && work.totalCharts) ? work.totalCharts : 0;
    result.total = total;
    if (!total) { result.note = '本次未配置图表'; return result; }

    var limit = Math.min(total, MAX_CHARTS);
    result.truncated = total > MAX_CHARTS;
    var metas = flatMeta(work);
    var metaOk = metas.length === total;

    /* 隐藏容器（离屏渲染，不干扰参数绘图区） */
    var host = document.createElement('div');
    host.className = 'report-shot-host';
    host.setAttribute('style', 'position:absolute;left:-10000px;top:0;width:' + SHOT_W + 'px;height:' + SHOT_H + 'px;overflow:hidden;pointer-events:none;');
    var cell = document.createElement('div');
    cell.setAttribute('style', 'width:' + SHOT_W + 'px;height:' + SHOT_H + 'px;');
    host.appendChild(cell);
    document.body.appendChild(host);

    progressOpen('正在生成报告', '准备截取 ' + limit + ' 张图表…');
    var skipped = 0, i = 0;

    try {
      for (i = 0; i < limit; i++) {
        var inst = null, opt = null, url = '';
        try {
          inst = initShot(cell);
          var chartData = Agg.chartOf(work, i);
          opt = shotOption(CB.buildOption(chartData, work, i));
          if (inst && opt) {
            /* 先注册 'finished' 再 setOption，避免事件早于监听器触发 */
            var rendered = waitFinished(inst);
            inst.setOption(opt, true);
            await rendered;
          } else {
            await waitFinished(inst);
          }
        } catch (e) {
          if (global.console && console.error) console.error('[YMS.Report] 第 ' + (i + 1) + ' 张图表渲染失败：', e);
          await waitFinished(inst);
        }
        try {
          url = (inst && typeof inst.getDataURL === 'function')
            ? inst.getDataURL({ type: 'png', pixelRatio: 1.5, backgroundColor: '#ffffff' })
            : '';
        } catch (e2) {
          if (global.console && console.error) console.error('[YMS.Report] 第 ' + (i + 1) + ' 张图表取图失败：', e2);
          url = '';
        }
        if (inst && typeof inst.dispose === 'function') { try { inst.dispose(); } catch (e3) { } }

        if (url && url.indexOf('data:image') === 0 && url.length > 64) {
          var m = metaOk ? metas[i] : null;
          var base = (opt && opt.title && opt.title.text) ? opt.title.text : ((m && m.title) || ('图表 ' + (i + 1)));
          var extra = [];
          if (m && m.pageLabel) extra.push('Page：' + m.pageLabel);
          if (m && m.facetLabel && m.facetLabel !== base) extra.push('分面：' + m.facetLabel);
          result.images.push({
            dataURL: url,
            index: i + 1,
            title: base,
            meta: extra.join(' · '),
            subtext: (opt && opt.title && opt.title.subtext) ? String(opt.title.subtext) : ''
          });
        } else {
          skipped++;
        }

        progressUpdate((i + 1) / limit * 92, '已截取 ' + (i + 1) + ' / ' + limit + ' 张');
        if ((i + 1) % 5 === 0) await U.nextTick();
      }
    } catch (e4) {
      if (global.console && console.error) console.error('[YMS.Report] 图表截图中断：', e4);
    } finally {
      try { if (host.parentNode) host.parentNode.removeChild(host); } catch (e5) { }
      progressClose();
    }

    var notes = [];
    if (result.images.length === 0 && skipped > 0) {
      notes.push('图表截图未成功获取（当前渲染环境未返回图像数据），本次报告仅包含文字部分。');
    } else if (skipped > 0) {
      notes.push('有 ' + skipped + ' 张图表未能获取图像，已跳过。');
    }
    if (result.truncated) {
      notes.push('图表共 ' + total + ' 张，超过单份报告上限 ' + MAX_CHARTS + ' 张，本报告仅包含前 ' + limit + ' 张。');
    }
    result.note = notes.join(' ');
    return result;
  }

  /* ==========================================================================
     PPTX 导出（YMS.Report.exportPPT）
       1) 按 Aggregate 的 Page 分组截图（每个 Page 的**全部分面**，与屏幕同一份 option）；
       2) 拼 PPTX 规格（标题页 + 统计摘要页 + 每 Page 一页；超容量拆页标 (1/2)）；
       3) 由 YMS.Pptx 零依赖写出 .pptx 并下载。
     ========================================================================== */

  /** 单行显示宽度（东亚全角按 2 计，用于等宽统计表的列对齐） */
  function dispWidth(s) {
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

  /** 补空格到指定显示宽度（right=true 右对齐） */
  function padTo(s, width, right) {
    s = String(s === null || s === undefined ? '' : s);
    var diff = width - dispWidth(s);
    if (diff <= 0) return s;
    var pad = '';
    while (pad.length < diff) pad += ' ';
    return right ? pad + s : s + pad;
  }

  /**
   * 网格排版：优先复用 YMS.PlotView._layoutSize（保证与屏幕排版一致），
   * 缺失时降级为 ceil(sqrt(n)) 行×列
   * @param {number} n 图表数
   * @param {{mode:string,rows:number,cols:number}|null} layout Store.plot.layout
   * @returns {{rows:number,cols:number}}
   */
  function pptGrid(n, layout) {
    n = Math.max(1, Math.floor(Number(n) || 1));
    var size = null;
    if (YMS.PlotView && typeof YMS.PlotView._layoutSize === 'function') {
      try { size = YMS.PlotView._layoutSize(n, layout || {}); } catch (e) { size = null; }
    }
    var cols, rows;
    if (size && Number(size.cols) > 0 && Number(size.rows) > 0) {
      cols = Number(size.cols); rows = Number(size.rows);
    } else {
      cols = YMS.util.clamp(Math.ceil(Math.sqrt(n)), 1, 6);
      rows = Math.max(1, Math.ceil(n / cols));
    }
    if (rows * cols < n) rows = Math.ceil(n / cols);      // 兜底：容量必须够
    return { rows: rows, cols: cols };
  }

  function pageLabelOf(pg, index) {
    var label = (pg && (pg.label || pg.key)) ? String(pg.label || pg.key) : ('Page ' + (index + 1));
    return label;
  }

  /* ==========================================================================
     界面实际显示尺寸（迭代 10）
       截图不再固定 1280×720，而是按该卡片在界面上**真实占用的内容盒尺寸**离屏渲染，
       所以纵横比、字号密度都与屏幕一致；PPT 再按 1 CSS px = 1/96 in 自然摆放。
       取值优先级：当前渲染页的真实 DOM 量测 → PlotView 同一套布局公式推算。
     ========================================================================== */
  var PPT_AREA_RAIL_SETTINGS = 330;   // 侧栏（左侧工具栏 + 右侧设置区）宽度估算，仅无 DOM 时兜底

  /**
   * 绘图区可用内容尺寸（CSS px）：实测 #plot-canvas-wrap 客户区并扣 padding；
   * 取不到（未渲染/隐藏/尺寸异常）时按窗口估算。
   * @returns {{w:number,h:number,measured:boolean}}
   */
  function plotAreaSize() {
    var w = 0, h = 0;
    try {
      var wrap = document.getElementById('plot-canvas-wrap');
      if (wrap) {
        var cs = (global.getComputedStyle ? global.getComputedStyle(wrap) : null);
        var num = function (v) { var x = parseFloat(v); return isFinite(x) ? x : 0; };
        w = num(wrap.clientWidth) - (cs ? num(cs.paddingLeft) + num(cs.paddingRight) : 0);
        h = num(wrap.clientHeight) - (cs ? num(cs.paddingTop) + num(cs.paddingBottom) : 0);
      }
    } catch (e) { w = 0; h = 0; }
    var ok = (w >= 240 && h >= 200);
    if (!ok) {
      var vw = Number(global.innerWidth) || 1440;
      var vh = Number(global.innerHeight) || 900;
      w = Math.max(480, vw - PPT_AREA_RAIL_SETTINGS);
      h = Math.max(360, vh - 200);          // 与 PlotView.layoutSize 的 vh-200 估算一致
    }
    return { w: Math.round(w), h: Math.round(h), measured: ok };
  }

  /**
   * 与 PlotView 同源的排版尺寸。availH 传入实测可用高度时，卡片高度与界面完全一致。
   * 优先直接调用 YMS.PlotView._layoutSize（单一事实来源）；缺失时按同一套规则内联兜底
   * （rc 模式用手动行列，best 模式按 ceil(sqrt(n)) 取列，卡片高度均分可用高度）。
   * @returns {{rows:number,cols:number,cardH:number}}
   */
  function plotGrid(n, layout, availH) {
    n = Math.max(1, Math.floor(Number(n) || 1));
    var size = null;
    if (YMS.PlotView && typeof YMS.PlotView._layoutSize === 'function') {
      try { size = YMS.PlotView._layoutSize(n, layout || {}, null, availH); } catch (e) { size = null; }
    }
    var cols, rows, cardH = 0;
    if (size && Number(size.cols) > 0 && Number(size.rows) > 0) {
      cols = Number(size.cols); rows = Number(size.rows); cardH = Number(size.cardH) || 0;
    } else {
      var cfg = layout || {};
      if (cfg.mode === 'rc') {
        cols = YMS.util.clamp(Math.floor(Number(cfg.cols) || 1), 1, 12);
        rows = Math.max(YMS.util.clamp(Math.floor(Number(cfg.rows) || 1), 1, 12), Math.ceil(n / cols));
      } else {
        cols = (n <= 1) ? 1 : ((n <= 12) ? Math.ceil(Math.sqrt(n)) : Math.ceil(Math.sqrt(n * 1.2)));
        cols = YMS.util.clamp(cols, 1, 6);
        rows = Math.max(1, Math.ceil(n / cols));
      }
    }
    if (rows * cols < n) rows = Math.ceil(n / cols);
    if (!(cardH > 0)) {
      cardH = YMS.util.clamp(Math.floor((availH - (rows - 1) * PPT_GRID_GAP) / rows), PPT_MIN_CARD_H, 1400);
    }
    return { rows: rows, cols: cols, cardH: cardH };
  }

  /**
   * 某 Page 每张卡片的内容盒尺寸（CSS px，即 .chart-body 的宽高 —— 截图容器就用它）。
   * @param {number} n 该 Page 分面数
   * @param {object|null} layout Store.state.plot.layout
   * @param {{w:number,h:number}} area 绘图区可用内容尺寸
   * @param {Array<{w:number,h:number}>|null} measured 当前渲染页的实测卡片尺寸（数量需与 n 相同）
   * @returns {Array<{w:number,h:number}>}
   */
  function cardBoxes(n, layout, area, measured) {
    var out = [], k;
    if (measured && measured.length === n) {
      for (k = 0; k < n; k++) {
        out.push({ w: Math.round(measured[k].w), h: Math.round(measured[k].h) });
      }
      return out;
    }
    var g = plotGrid(n, layout, area.h);
    var cardW = (n === 1)
      ? Math.min(PPT_SINGLE_MAX_W, area.w)                                   // .is-single 宽度上限
      : Math.floor((area.w - (g.cols - 1) * PPT_GRID_GAP) / g.cols);
    var bodyW = Math.max(120, cardW - PPT_CARD_BORDER);
    var bodyH = Math.max(90, g.cardH - PPT_CARD_HEAD_H - PPT_CARD_BORDER);
    for (k = 0; k < n; k++) out.push({ w: bodyW, h: bodyH });
    return out;
  }

  /** 当前渲染页各卡片内容盒的真实尺寸（CSS px）；取不到返回 null */
  function measureCards() {
    var out = [];
    try {
      var nodes = document.querySelectorAll('#plot-canvas-wrap .chart-card .chart-body');
      for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i].getBoundingClientRect ? nodes[i].getBoundingClientRect() : null;
        if (!r || !(r.width >= 80) || !(r.height >= 60)) return null;
        out.push({ w: r.width, h: r.height });
      }
    } catch (e) { return null; }
    return out.length ? out : null;
  }

  /** 当前渲染页的页号（Store.plot.activePage；取不到返回 -1） */
  function activePageIndex() {
    try {
      var pl = YMS.Store && YMS.Store.state ? YMS.Store.state.plot : null;
      var i = pl ? Math.floor(Number(pl.activePage)) : 0;
      return isFinite(i) && i >= 0 ? i : 0;
    } catch (e) { return 0; }
  }

  /**
   * 截取单个分面图：按该卡片在界面上的实际内容盒尺寸（CSS px）离屏渲染，
   * 像素密度 PPT_PIXEL_RATIO 倍（截图尺寸 = cssW×ratio × cssH×ratio，纵横比与界面一致）。
   * @param {Element} host 离屏宿主（position:absolute; left:-10000px）
   * @param {{w:number,h:number}} box 卡片内容盒尺寸（CSS px）
   * @param {number} index Aggregate 扁平序号
   * @param {string} label 分面标签（页签 / 分面名）
   * @returns {Promise<{png:Uint8Array|string,w:number,h:number,cssW:number,cssH:number,label:string}|null>}
   */
  async function shotFacet(host, box, Agg, CB, work, index, label) {
    var inst = null, url = '', cell = null;
    var cssW = Math.max(120, Math.round(Number(box && box.w) || 0));
    var cssH = Math.max(90, Math.round(Number(box && box.h) || 0));
    try {
      cell = document.createElement('div');
      cell.className = 'report-ppt-shot-cell';
      cell.setAttribute('style', 'width:' + cssW + 'px;height:' + cssH + 'px;');
      host.appendChild(cell);
      inst = initShot(cell);
      var chartData = Agg.chartOf(work, index);
      var opt = shotOption(CB.buildOption(chartData, work, index));
      if (inst && opt) {
        var rendered = waitFinished(inst);        // 先注册 'finished' 再 setOption，避免事件早于监听器
        inst.setOption(opt, true);
        await rendered;
      } else {
        await waitFinished(inst);
      }
      url = (inst && typeof inst.getDataURL === 'function')
        ? inst.getDataURL({ type: 'png', pixelRatio: PPT_PIXEL_RATIO, backgroundColor: '#ffffff' })
        : '';
    } catch (e) {
      if (global.console && console.error) console.error('[YMS.Report] 第 ' + (index + 1) + ' 张图表截图失败：', e);
      await waitFinished(inst);
      url = '';
    }
    if (inst && typeof inst.dispose === 'function') { try { inst.dispose(); } catch (e2) { } }
    try { if (cell && cell.parentNode) cell.parentNode.removeChild(cell); } catch (e3) { }

    if (!url || url.indexOf('data:image') !== 0 || url.length <= 64) return null;
    var png = null, wh = null;
    try {
      if (YMS.Pptx && typeof YMS.Pptx.decodePng === 'function') {
        png = YMS.Pptx.decodePng(url);
        if (YMS.Pptx.pngSize) wh = YMS.Pptx.pngSize(png);
      }
    } catch (e4) { png = null; wh = null; }
    if (!png || !png.length) png = url;             // 极端情况下交给 Pptx 自行解码
    return {
      png: png,
      w: wh ? wh.w : cssW * PPT_PIXEL_RATIO,
      h: wh ? wh.h : cssH * PPT_PIXEL_RATIO,
      cssW: cssW,                                   // 界面显示尺寸（CSS px）—— PPT 自然尺寸基准
      cssH: cssH,
      label: label
    };
  }

  /**
   * 按 Page 分组截取图表（跨 Page 保持与 Aggregate.chartOf 相同的扁平序号）
   * 每张图的离屏容器尺寸 = 该卡片在界面上实际占用的内容盒尺寸（当前页实测 DOM，
   * 其他页按 PlotView 同一套排版公式推算），因此截图与界面 1:1 同构。
   * 进度条由调用方（runExportPPT）统一关闭；依赖缺失时降级为 note，不抛异常。
   * @returns {Promise<{pages:Array, total:number, imageCount:number, skipped:number, note:string, work:object|null}>}
   */
  async function capturePptCharts() {
    var res = { pages: [], total: 0, imageCount: 0, skipped: 0, note: '', work: null, area: null };
    var ec = global.echarts, Agg = YMS.Aggregate, CB = YMS.ChartBuilder;

    if (!ec || typeof ec.init !== 'function') {
      res.note = '当前环境未加载 ECharts，PPT 报告未包含图表截图。';
      return res;
    }
    if (!Agg || typeof Agg.build !== 'function' || typeof Agg.chartOf !== 'function') {
      res.note = '图表模块（YMS.Aggregate）尚未就绪，PPT 报告未包含图表截图。';
      return res;
    }
    if (!CB || typeof CB.buildOption !== 'function') {
      res.note = '图表构建模块（YMS.ChartBuilder）尚未就绪，PPT 报告未包含图表截图。';
      return res;
    }

    var work = null;
    try { work = Agg.build(); }
    catch (e) {
      if (global.console && console.error) console.error('[YMS.Report] 图表数据构建失败：', e);
      res.note = '图表数据构建失败（' + (e && e.message ? e.message : e) + '），PPT 报告未包含图表截图。';
      return res;
    }
    res.work = work;
    res.total = (work && work.totalCharts) ? work.totalCharts : 0;
    if (!res.total) { res.note = '本次未配置图表'; return res; }

    var pages = (work && work.pages && work.pages.length) ? work.pages : [];
    /* 界面可用区与卡片尺寸（与 PlotView 同源）：决定每张截图的离屏容器尺寸 */
    var area = plotAreaSize();
    res.area = area;
    var layout = (YMS.Store && YMS.Store.state && YMS.Store.state.plot) ? YMS.Store.state.plot.layout : null;
    var livePage = activePageIndex();
    var measured = measureCards();

    var host = document.createElement('div');
    host.className = 'report-ppt-shot-host';
    host.setAttribute('style', 'position:absolute;left:-10000px;top:0;width:' + area.w +
      'px;height:' + area.h + 'px;overflow:hidden;pointer-events:none;');
    document.body.appendChild(host);

    progressOpen('正在导出 PPT 报告', '按 Page 截取 ' + res.total + ' 张图表…');
    var flat = 0, done = 0;
    try {
      for (var p = 0; p < pages.length; p++) {
        var pg = pages[p] || {};
        var pLabel = pageLabelOf(pg, p);
        var facets = pg.facets || [];
        var boxes = cardBoxes(facets.length, layout, area, (p === livePage) ? measured : null);
        var rec = { label: pLabel, images: [], cssW: 0, cssH: 0 };
        for (var f = 0; f < facets.length; f++) {
          var facet = facets[f] || {};
          var fl = facet.label ? String(facet.label) : '';
          var box = boxes[f] || boxes[0];
          var img = await shotFacet(host, box, Agg, CB, work, flat, pLabel + (fl ? ' / ' + fl : ''));
          if (img) {
            rec.images.push(img);
            rec.cssW = img.cssW;
            rec.cssH = img.cssH;
            res.imageCount++;
          } else { res.skipped++; }
          done++;
          progressUpdate(done / res.total * 92, '已截取 ' + done + ' / ' + res.total + ' 张');
          if (done % 5 === 0) await U.nextTick();
          flat++;
        }
        res.pages.push(rec);
        await U.nextTick();
      }
    } catch (e4) {
      if (global.console && console.error) console.error('[YMS.Report] PPT 图表截图中断：', e4);
    } finally {
      try { if (host.parentNode) host.parentNode.removeChild(host); } catch (e5) { }
    }

    var notes = [];
    if (!res.imageCount) notes.push('图表截图未成功获取（当前渲染环境未返回图像数据），PPT 仅包含标题页与统计摘要。');
    else if (res.skipped) notes.push('有 ' + res.skipped + ' 张图表未能获取图像，已跳过。');
    res.note = notes.join(' ');
    return res;
  }

  /** 标题页文本（数据文件 / 规模 / 视图行数 / 生成时间 / 绘图配置一行摘要） */
  function titleLines(o) {
    var s = YMS.Store.state;
    var pl = s.plot || {};
    var work = o.work;
    var layoutVal = (pl.layout && pl.layout.mode === 'rc')
      ? ('Row × Column ' + (pl.layout.rows || 1) + ' × ' + (pl.layout.cols || 1))
      : '最佳排版';
    var mergeVal = (pl.merge && pl.merge.mode === 'manual')
      ? ('手动上限 ' + (pl.merge.limit === null || pl.merge.limit === undefined ? '—' : pl.merge.limit))
      : ((pl.merge && pl.merge.mode === 'none') ? '不限制' : '自动');
    var plotLine = [
      (PLOT_TYPE_LABEL[pl.type] || pl.type || '—'),
      'X Label：' + joinNames(pl.x),
      'Value：' + joinNames(pl.values),
      'Sorter：' + sortersText(pl.sorters),
      'Page by：' + joinNames(pl.pageBy),
      'Split by：' + joinNames(pl.splitBy),
      '排版：' + layoutVal,
      '合并：' + mergeVal,
      '拟合：' + (FIT_LABEL[pl.fit] || pl.fit || '无')
    ].join(' · ');

    var lines = [
      '数据文件：' + (s.fileName ? s.fileName : '—'),
      '表格名：' + (s.tableName || '—'),
      '原始规模：' + o.df.rowCount + ' 行 × ' + o.df.cols.length + ' 列' +
      (s.fileSize ? '（' + U.fmtBytes(s.fileSize) + '）' : ''),
      '视图行数：' + U.fmtInt(o.view.count) + ' 行' +
      (o.view.count === o.df.rowCount ? '' : '（原始 ' + U.fmtInt(o.df.rowCount) + ' 行）'),
      '图表数量：' + (o.chartCount || 0) + ' 张 / ' + ((o.pages || []).length) + ' 个 Page' +
      (work && work.mergeSummary ? '（' + work.mergeSummary + '）' : ''),
      '生成时间：' + fmtDateTime(o.generatedAt),
      '绘图配置：' + plotLine,
      '应用版本：YMS ' + (YMS.version || '—')
    ];
    if (o.note) lines.push('导出说明：' + o.note);
    return lines.join('\n');
  }

  /** 统计摘要页文本（等宽对齐的纯文本表，见 DEV-SPEC 3.E1 第 3 节） */
  function statsText(df, view) {
    var miss = (typeof view.missingCounts === 'function') ? view.missingCounts() : null;
    var heads = ['参数', '类型', '有效值', '缺失', '唯一值', 'Min', 'Max', 'Mean', 'Median', 'StdDev'];
    var NAME_W = 12, TYPE_W = 6, NUM_W = 13, SMALL_W = 8, UNIQ_W = 9;
    var i, c;
    for (i = 0; i < df.cols.length; i++) NAME_W = Math.max(NAME_W, dispWidth(df.cols[i].name) + 2);

    function row(name, type, valid, missing, uniq, mi, ma, me, md, sd) {
      return [
        padTo(name, NAME_W), padTo(type, TYPE_W), padTo(valid, SMALL_W, true),
        padTo(missing, SMALL_W, true), padTo(uniq, UNIQ_W, true),
        padTo(mi, NUM_W, true), padTo(ma, NUM_W, true), padTo(me, NUM_W, true),
        padTo(md, NUM_W, true), padTo(sd, NUM_W, true)
      ].join(' ').replace(/\s+$/, '');
    }

    var lines = [row(heads[0], heads[1], heads[2], heads[3], heads[4], heads[5], heads[6], heads[7], heads[8], heads[9])];
    lines.push(new Array(NAME_W + TYPE_W + SMALL_W * 2 + UNIQ_W + NUM_W * 5 + 10).join('-'));
    for (i = 0; i < df.cols.length; i++) {
      c = df.cols[i];
      var st = df.stats(i) || {};
      var m = miss ? miss[i] : 0;
      var dec = decimalsOf(view, c.name);
      lines.push(row(
        c.name,
        typeLabel(c.type),
        String(view.count - m),
        String(m),
        (st.unique === null || st.unique === undefined) ? '—' : String(st.unique),
        rawStat(st.min, c, dec),
        rawStat(st.max, c, dec),
        rawStat(st.mean, c, dec),
        rawStat(st.median, c, dec),
        stdRaw(st.stddev, c, dec)
      ));
    }
    lines.push('');
    lines.push('说明：有效值 / 缺失按当前视图（筛选、删除缺失、填充之后）统计；');
    lines.push('      唯一值、Min / Max / Mean / Median / StdDev 按数据列原始有效值统计；');
    lines.push('      标准差为总体标准差（分母 N）；字符列无数值统计量显示「—」；');
    lines.push('      时间列的 Min / Max / Mean / Median 为时间字符串，StdDev 为时长（ms）。');
    return lines.join('\n');
  }

  /** 统计量文本（纯文本版，无 HTML 转义） */
  function rawStat(v, col, decimals) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number' && isNaN(v)) return '—';
    if (isTime(col.type)) return timeText(v, col.timeStyle);
    var t = numText(v, decimals);
    return t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  function stdRaw(v, col, decimals) {
    var t = rawStat(v, col, decimals);
    return (t === '—') ? t : (t + (isTime(col.type) ? ' ms' : ''));
  }

  /**
   * 把某 Page 的截图按「界面实际尺寸」装箱到若干张幻灯片（迭代 10）：
   * 每张图按 CSS px ÷ 96 的自然英寸摆放，一页装不下就续包一张 —— 不再把图缩进网格单元格；
   * 只有单张图本身超出可用区时才等比缩小到刚好放下（绝不上采样放大）。
   * @param {Array<object>} imgs 该 Page 的截图（含 cssW/cssH = 界面显示尺寸）
   * @returns {Array<Array<object>>} 每张幻灯片的图片列表（带 box / labelBox 绝对位置 EMU）
   */
  function packPageShots(imgs) {
    var PK = YMS.Pptx;
    var items = [], i, j, im;
    for (i = 0; i < imgs.length; i++) {
      im = imgs[i] || {};
      items.push({
        w: (Number(im.cssW) > 0 ? Number(im.cssW) : Number(im.w) || 1),
        h: (Number(im.cssH) > 0 ? Number(im.cssH) : Number(im.h) || 1),
        label: im.label ? String(im.label) : '',
        img: im
      });
    }
    if (!PK || typeof PK.packShots !== 'function') {
      var fallback = [];
      for (i = 0; i < imgs.length; i++) fallback.push([imgs[i]]);   // 降级：一图一页（仍不缩放）
      return fallback;
    }
    var groups = PK.packShots(items, { maxPerSlide: PPT_MAX_PER_SLIDE });
    var out = [];
    for (i = 0; i < groups.length; i++) {
      var row = [], g = groups[i] || [];
      for (j = 0; j < g.length; j++) {
        var src = (g[j] && g[j].src && g[j].src.img) ? g[j].src.img : null;
        if (!src) continue;
        row.push({
          png: src.png, w: src.w, h: src.h, cssW: src.cssW, cssH: src.cssH,
          label: src.label, box: g[j].box, labelBox: g[j].labelBox
        });
      }
      if (row.length) out.push(row);
    }
    return out;
  }

  /** 已摆放图片的实际缩放百分比（相对界面显示尺寸，100 = 1:1） */
  function packScalePct(part) {
    var PK = YMS.Pptx;
    if (!PK || !part || !part.length || !part[0].box) return 100;
    var natW = PK.pxToEmu ? PK.pxToEmu(part[0].cssW) : 0;
    if (!(natW > 0)) return 100;
    return Math.round(part[0].box.w / natW * 100);
  }

  /**
   * 拼装 PPTX 规格（纯函数：只依赖传入的上下文，便于无浏览器自测断言 slide 数）
   * 第 1 页 = 标题页；第 2 页 = 参数统计摘要；第 3 页起 = 每个 Page 一页
   * （某页分面数 > 单页容量时拆为多张，标题标 (1/2)）。
   * @param {{df, view, tableName, generatedAt, pages, work, chartCount, note}} o
   * @returns {{title:string, author:string, createdAt:Date, slides:Array}}
   */
  function buildPptxSpec(o) {
    o = o || {};
    var df = o.df, view = o.view;
    var pages = o.pages || [];
    var layout = (YMS.Store && YMS.Store.state && YMS.Store.state.plot) ? YMS.Store.state.plot.layout : null;
    var tableName = o.tableName || '数据表';
    var slides = [];

    /* 1) 标题页 */
    slides.push({
      title: tableName + ' · 数据报告',
      subtitle: 'YMS 良率管理系统 · 半导体良率数据分析报告（按 Page 分页导出，图表与屏幕显示一致）',
      text: titleLines({
        df: df, view: view, pages: pages, work: o.work,
        chartCount: o.chartCount, generatedAt: o.generatedAt, note: o.note
      }),
      textSize: 12, textMono: false
    });

    /* 2) 参数统计摘要 */
    slides.push({
      title: '参数统计摘要',
      subtitle: '有效值 / 缺失按当前视图统计（' + U.fmtInt(view.count) + ' 行）；统计量为数据列原始有效值',
      text: statsText(df, view),
      textMono: true
    });

    /* 3) 每个 Page 按界面实际尺寸自然摆放（装不下续包一页）；全局没有一张图时不出页面页，避免空洞页面 */
    var totalImages = 0, pi;
    for (pi = 0; pi < pages.length; pi++) totalImages += ((pages[pi] || {}).images || []).length;
    if (!totalImages) return {
      title: tableName + ' 数据报告',
      author: 'YMS 良率管理系统' + (YMS.version ? ' ' + YMS.version : ''),
      createdAt: o.generatedAt,
      slides: slides
    };

    for (var p = 0; p < pages.length; p++) {
      var pg = pages[p] || {};
      var label = pageLabelOf(pg, p);
      var imgs = pg.images || [];
      if (!imgs.length) {
        slides.push({
          title: 'Page ' + label,
          subtitle: '该 Page 无可用图表截图',
          text: '（该页图表未能获取图像数据，可能是渲染环境限制或无分面）'
        });
        continue;
      }
      var full = pptGrid(imgs.length, layout);          // 界面排版（只用于说明文字）
      var groups = packPageShots(imgs);                 // 按界面实际尺寸自然摆放
      var k = Math.max(1, groups.length);
      for (var c = 0; c < k; c++) {
        var part = groups[c];
        if (!part || !part.length) continue;
        var pct = packScalePct(part);
        slides.push({
          title: 'Page ' + label + (k > 1 ? '（' + (c + 1) + '/' + k + '）' : ''),
          subtitle: '分面图表 ' + part.length + ' 张 · 按界面实际显示尺寸摆放（1 CSS px = 1/96 in · 缩放 ' + pct + '%）' +
            ' · 界面排版 ' + full.rows + ' × ' + full.cols +
            (k > 1 ? '（本 Page 共 ' + imgs.length + ' 张，分 ' + k + ' 页导出）' : ''),
          images: part,
          layout: { rows: full.rows, cols: full.cols }
        });
      }
    }
    return {
      title: tableName + ' 数据报告',
      author: 'YMS 良率管理系统' + (YMS.version ? ' ' + YMS.version : ''),
      createdAt: o.generatedAt,
      slides: slides
    };
  }

  function pptFail(e) {
    progressClose();
    var msg = (e && e.message) ? e.message : String(e);
    try { if (global.console && console.error) console.error('[YMS.Report] PPT 导出失败：', e); } catch (x) { }
    try { U.toast('PPT 导出失败：' + U.escapeHtml(msg), 'error'); } catch (y) { }
    return null;
  }

  /** PPT 导出主流程（截图 → 拼规格 → 零依赖写出 PPTX → 下载） */
  async function runExportPPT() {
    var t0 = Date.now();
    var Store = YMS.Store;
    var df = Store.state.df;
    var view = Store.getView();
    if (!df || !view) {
      U.toast('请先导入数据', 'warn');
      return null;
    }
    if (!view.count) U.toast('当前视图没有数据行（请检查筛选条件）', 'warn');

    try {
      var cap = await capturePptCharts();
      var generatedAt = new Date();
      var tableName = Store.state.tableName || '数据表';
      var spec = buildPptxSpec({
        df: df, view: view, tableName: tableName, generatedAt: generatedAt,
        pages: cap.pages, work: cap.work, chartCount: cap.imageCount, note: cap.note
      });

      progressUpdate(96, '正在打包 PPTX（' + spec.slides.length + ' 页幻灯片）…');
      var bytes = YMS.Pptx.build(spec);
      if (!bytes || !bytes.length) throw new Error('PPTX 打包结果为空');

      var fileName = safeFileName(tableName) + '-报告-' + U.nowStamp(generatedAt) + '.pptx';
      U.downloadBlob(fileName, new Blob([bytes], { type: PPT_MIME }));
      progressUpdate(100, '完成');

      var info = {
        ok: true, fileName: fileName, slides: spec.slides.length,
        chartCount: cap.imageCount, size: bytes.length
      };
      if (YMS.debug) console.log('[YMS.Report] PPT 导出 ' + bytes.length + ' 字节 / ' + spec.slides.length + ' 页 / ' +
        cap.imageCount + ' 张图，耗时 ' + (Date.now() - t0) + ' ms');
      U.toast('PPT 报告已导出：' + U.escapeHtml(fileName) + '（' + spec.slides.length + ' 页 · 图表 ' +
        cap.imageCount + ' 张 · ' + U.fmtBytes(bytes.length) + '）', 'ok');
      return info;
    } finally {
      progressClose();
    }
  }

  /**
   * 生成并下载 PPTX 报告（真正的 .pptx：零依赖 OOXML + ZIP 写出）
   * @returns {Promise<{ok:boolean, fileName:string, slides:number, chartCount:number, size:number}|null>}
   *          失败（无数据 / 组件缺失 / 任何异常）→ null，并 toast + console.error
   */
  function exportPPT() {
    if (!YMS.Store || !YMS.Store.hasData || !YMS.Store.hasData()) {
      try { U.toast('请先导入数据', 'warn'); } catch (e) { }
      return Promise.resolve(null);
    }
    if (!YMS.Pptx || typeof YMS.Pptx.build !== 'function') {
      try { if (global.console && console.error) console.error('[YMS.Report] PPTX 写出模块（YMS.Pptx）未载入'); } catch (x) { }
      try { U.toast('PPT 导出组件未载入，无法导出 PPT', 'error'); } catch (y) { }
      return Promise.resolve(null);
    }
    var p;
    try { p = runExportPPT(); } catch (e1) { return Promise.resolve(pptFail(e1)); }
    return Promise.resolve(p).catch(pptFail);
  }

  /* ==========================================================================
     报告各章节（返回 HTML 字符串）
     ========================================================================== */
  function headSection(ctx) {
    var s = YMS.Store.state;
    var sameRows = ctx.view.count === ctx.df.rowCount;
    var rows = [
      '<tr><th>数据文件</th><td>' + (s.fileName ? esc(s.fileName) : '—') + '</td></tr>',
      '<tr><th>表格名</th><td>' + esc(s.tableName || '—') + '</td></tr>',
      '<tr><th>原始规模</th><td class="mono">' + ctx.df.rowCount + ' 行 × ' + ctx.df.cols.length + ' 列' +
        (s.fileSize ? '（' + esc(U.fmtBytes(s.fileSize)) + '）' : '') + '</td></tr>',
      '<tr><th>视图行数</th><td class="mono">' + U.fmtInt(ctx.view.count) + ' 行' +
        (sameRows ? '' : '（原始 ' + U.fmtInt(ctx.df.rowCount) + ' 行）') + '</td></tr>',
      '<tr><th>图表数量</th><td class="mono">' + ctx.cap.images.length + ' / ' + (ctx.cap.total || 0) + ' 张</td></tr>',
      '<tr><th>应用版本</th><td>YMS ' + esc(YMS.version || '—') + '</td></tr>',
      '<tr><th>生成时间</th><td class="mono">' + esc(fmtDateTime(ctx.generatedAt)) + '</td></tr>'
    ];
    return '<header class="rep-head">' +
      '<p class="rep-kicker">YMS · Yield Management System</p>' +
      '<h1 class="rep-title">' + esc(s.tableName || '数据') + ' · 数据报告</h1>' +
      '<p class="rep-sub">半导体良率数据分析报告 · 由 YMS 离线分析工具按当前会话自动生成</p>' +
      '<table class="rep-meta">' + rows.join('') + '</table>' +
      '</header>';
  }

  function processingSection(ctx) {
    var s = YMS.Store.state, ds = s.dataSettings, pp = ds.preprocess || {};
    var out = ['<h2 class="rep-h"><span class="rep-no">一</span>处理说明</h2>'];

    /* 1.1 导入信息 */
    out.push('<h3 class="rep-h3">1.1 导入信息</h3>');
    out.push('<table class="rep-table kv">' + [
      '<tr><td class="k">数据文件</td><td>' + (s.fileName ? esc(s.fileName) : '—') + '</td></tr>',
      '<tr><td class="k">文件大小</td><td class="mono">' + (s.fileSize ? esc(U.fmtBytes(s.fileSize)) : '未知（内置/示例数据）') + '</td></tr>',
      '<tr><td class="k">导入时间</td><td class="mono">' + (s.importedAt ? esc(String(s.importedAt).replace('T', ' ').slice(0, 19)) : '—') + '</td></tr>',
      '<tr><td class="k">原始数据规模</td><td class="mono">' + ctx.df.rowCount + ' 行 × ' + ctx.df.cols.length + ' 列（参数：' + esc(joinNames(ctx.df.colNames())) + '）</td></tr>',
      '<tr><td class="k">当前视图行数</td><td class="mono">' + ctx.view.count + ' 行（预处理后，用于统计表与图表）</td></tr>'
    ].join('') + '</table>');

    /* 1.2 处理与列级操作历史 */
    out.push('<h3 class="rep-h3">1.2 处理记录与列级操作历史</h3>');
    var notes = (s.ui && s.ui.processingNotes) ? s.ui.processingNotes : [];
    if (notes.length) {
      out.push('<ol class="rep-notes">' + notes.map(function (n) {
        return '<li>' + esc(n) + '</li>';
      }).join('') + '</ol>');
    } else {
      out.push('<p class="rep-empty">本次会话未记录处理操作（导入信息与设置如下）。</p>');
    }

    /* 1.3 当前预处理摘要 */
    out.push('<h3 class="rep-h3">1.3 当前预处理摘要</h3>');
    var filters = (pp.filters || []).filter(function (f) { return f && f.col; });
    var enabledCount = filters.filter(function (f) { return f.enabled !== false; }).length;
    var filterVal = filters.length
      ? ('共 ' + enabledCount + ' 条生效 / ' + filters.length + ' 条定义 —— ' + filters.map(function (f) {
        return (f.enabled === false ? '（已停用）' : '') + filterText(f);
      }).join('；'))
      : '无';
    var decKeys = Object.keys(ds.decimals || {}).filter(function (k) {
      var v = ds.decimals[k];
      return v !== null && v !== undefined && v !== '';
    });
    var decVal = decKeys.length
      ? decKeys.map(function (k) { return k + ' = ' + ds.decimals[k] + ' 位'; }).join('；') + '；其余参数自动'
      : '全部参数自动（最多 6 位有效小数）';
    var fontVal = (ds.fontFamily ? esc(ds.fontFamily) : '主题默认字体') + ' / ' + (ds.fontSize || 12) + ' px';

    out.push('<table class="rep-table kv">' + [
      '<tr><td class="k">缺失值处理</td><td>' + esc(MISSING_LABEL[pp.missing] || pp.missing || '不处理') + '</td></tr>',
      '<tr><td class="k">条件筛选</td><td>' + esc(filterVal) + '</td></tr>',
      '<tr><td class="k">行级排序（多级）</td><td>' + esc(sortersText(ds.sorters)) + '</td></tr>',
      '<tr><td class="k">列小数位</td><td>' + esc(decVal) + '</td></tr>',
      '<tr><td class="k">数据显示字体</td><td>' + fontVal + '</td></tr>',
      '<tr><td class="k">视图行数 / 原始行数</td><td class="mono">' + ctx.view.count + ' / ' + ctx.df.rowCount + '</td></tr>'
    ].join('') + '</table>');
    return out.join('\n');
  }

  function statsSection(ctx) {
    var df = ctx.df, view = ctx.view;
    var miss = (typeof view.missingCounts === 'function') ? view.missingCounts() : null;
    var heads = ['参数', '类型', '有效值', '缺失', '唯一值', 'Min', 'Max', 'Mean', 'Median', 'StdDev'];
    var th = heads.map(function (h) {
      return '<th' + (h === '参数' || h === '类型' ? '' : ' class="num"') + '>' + h + '</th>';
    }).join('');

    var body = [];
    for (var ci = 0; ci < df.cols.length; ci++) {
      var c = df.cols[ci];
      var st = df.stats(ci) || {};
      var m = miss ? miss[ci] : 0;
      var valid = view.count - m;
      var dec = decimalsOf(view, c.name);
      var uniq = (st.unique === null || st.unique === undefined) ? '—' : U.fmtInt(st.unique);
      body.push('<tr>' +
        '<td>' + esc(c.name) + '</td>' +
        '<td><span class="ty">' + esc(typeLabel(c.type)) + '</span></td>' +
        '<td class="num">' + U.fmtInt(valid) + '</td>' +
        '<td class="num">' + (m ? U.fmtInt(m) : '0') + '</td>' +
        '<td class="num">' + uniq + '</td>' +
        '<td class="num">' + statCell(st.min, c, dec) + '</td>' +
        '<td class="num">' + statCell(st.max, c, dec) + '</td>' +
        '<td class="num">' + statCell(st.mean, c, dec) + '</td>' +
        '<td class="num">' + statCell(st.median, c, dec) + '</td>' +
        '<td class="num">' + stdCell(st.stddev, c, dec) + '</td>' +
        '</tr>');
    }

    return '<h2 class="rep-h"><span class="rep-no">二</span>参数统计摘要</h2>' +
      '<table class="rep-table">' +
      '<thead><tr>' + th + '</tr></thead>' +
      '<tbody>' + body.join('') + '</tbody>' +
      '</table>' +
      '<p class="note">有效值 / 缺失按<strong>当前视图</strong>（筛选、删除缺失、填充之后）统计；唯一值、Min / Max / Mean / Median / StdDev 按数据列原始有效值统计（' +
      '标准差为总体标准差，分母 N；缺失值不参与计算，故缺失值被填充时统计量不变）。' +
      '字符列不具备数值统计量，显示为「—」；时间列的 Min / Max / Mean / Median 以时间字符串显示，StdDev 为时长（毫秒，标注 ms）。' +
      '唯一值显示「—」表示有效值超过 200 万，统计已跳过。</p>';
  }

  function chartsSection(ctx) {
    var cap = ctx.cap;
    var out = ['<h2 class="rep-h"><span class="rep-no">三</span>图表截图</h2>'];
    if (!cap.total) {
      out.push('<p class="rep-empty">本次未配置图表 —— 请在右侧「绘图设置区」配置 X Label / Value 后点击 Submit，再导出报告。</p>');
      if (cap.note && cap.note !== '本次未配置图表') out.push('<p class="note warn">' + esc(cap.note) + '</p>');
      return out.join('\n');
    }
    if (cap.note) out.push('<p class="note' + (cap.images.length ? '' : ' warn') + '">' + esc(cap.note) + '</p>');

    if (!cap.images.length) {
      out.push('<p class="rep-empty">未生成任何图表图像。</p>');
      return out.join('\n');
    }
    out.push('<p class="note">以下图表按当前绘图配置（含全部 Page / Split 分面）自动截图，共 ' + cap.images.length + ' 张，PNG 已内嵌（base64），报告可离线查看与打印。</p>');
    cap.images.forEach(function (img, k) {
      out.push('<figure class="fig">' +
        '<figcaption>图 ' + (k + 1) + ' · ' + esc(img.title) + '</figcaption>' +
        (img.meta ? '<div class="fig-sub">' + esc(img.meta) + '</div>' : '') +
        (img.subtext ? '<div class="fig-sub">' + esc(img.subtext) + '</div>' : '') +
        '<img src="' + img.dataURL + '" alt="图 ' + (k + 1) + ' ' + esc(img.title) + '">' +
        '</figure>');
    });
    return out.join('\n');
  }

  /** 从 Work 中提取拟合结果（首个含 fit 的分面） */
  function fitFromWork(work) {
    if (!work || !work.pages) return null;
    for (var p = 0; p < work.pages.length; p++) {
      var facets = (work.pages[p] || {}).facets || [];
      for (var f = 0; f < facets.length; f++) {
        var fit = facets[f] && facets[f].fit;
        if (fit) return fit;
      }
    }
    return null;
  }

  function plotConfigSection(ctx) {
    var pl = YMS.Store.state.plot || {};
    var sty = pl.style || {};
    var work = ctx.cap.work;
    var out = ['<h2 class="rep-h"><span class="rep-no">四</span>绘图配置</h2>'];

    var layoutVal;
    if (pl.layout && pl.layout.mode === 'rc') layoutVal = 'Row × Column 手动排版（' + (pl.layout.rows || 1) + ' × ' + (pl.layout.cols || 1) + '）';
    else layoutVal = '最佳排版（按图表数量自动计算列数）';

    var mergeVal;
    if (pl.merge && pl.merge.mode === 'manual') mergeVal = '手动上限 ' + (pl.merge.limit === null || pl.merge.limit === undefined ? '—' : pl.merge.limit) + ' 个类别';
    else if (pl.merge && pl.merge.mode === 'none') mergeVal = '不限制（不合并）';
    else mergeVal = '自动（Box ≤ 40 / Bar·Line ≤ 60 / Scatter·Hist 不限）';
    if (work && work.mergeSummary) mergeVal += '；实际：' + work.mergeSummary;

    var fit = fitFromWork(work);
    var fitVal = FIT_LABEL[pl.fit] || pl.fit || '无';
    if (pl.fit === 'poly') fitVal += '（' + (pl.fitOrder || 2) + ' 阶）';
    if (pl.type === 'hist') fitVal += '；直方图柱数：' + ((pl.histBins === null || pl.histBins === undefined) ? '自动（Sturges，5~80）' : pl.histBins);

    var rows = [
      '<tr><td class="k">图型</td><td>' + esc(PLOT_TYPE_LABEL[pl.type] || pl.type || '—') + '</td></tr>',
      '<tr><td class="k">X Label</td><td>' + esc(joinNames(pl.x)) + (work && work.xAxisName ? '　（X 轴名：' + esc(work.xAxisName) + '）' : '') + '</td></tr>',
      '<tr><td class="k">Value</td><td>' + esc(joinNames(pl.values)) + '</td></tr>',
      '<tr><td class="k">Sorter（X 类别排序）</td><td>' + esc(sortersText(pl.sorters)) + '　（按排序列在各 X 类别上的聚合值排序，数值/时间列取均值，字符列取字典序最小值）</td></tr>',
      '<tr><td class="k">Page by</td><td>' + esc(joinNames(pl.pageBy)) + '</td></tr>',
      '<tr><td class="k">Split by</td><td>' + esc(joinNames(pl.splitBy)) + '</td></tr>',
      '<tr><td class="k">排版</td><td>' + esc(layoutVal) + '</td></tr>',
      '<tr><td class="k">防拥挤合并</td><td>' + esc(mergeVal) + '</td></tr>',
      '<tr><td class="k">图表总数</td><td class="mono">' + ((work && work.totalCharts) ? work.totalCharts : (ctx.cap.total || 0)) + ' 张（本报告截图 ' + ctx.cap.images.length + ' 张）</td></tr>',
      '<tr><td class="k">Scatter 拟合</td><td>' + esc(fitVal) + '</td></tr>'
    ];
    if (fit) {
      Object.keys(fit).forEach(function (colName) {
        var f = fit[colName] || {};
        var r2 = (f.r2 === null || f.r2 === undefined) ? '—' : numText(f.r2, 6);
        rows.push('<tr><td class="k">拟合结果 · ' + esc(colName) + '</td><td class="mono">' +
          (f.formula ? esc(f.formula) + '　' : '') + 'R² = ' + r2 +
          (f.method ? '　（方法：' + esc(FIT_LABEL[f.method] || f.method) + '）' : '') + '</td></tr>');
      });
    }
    if (work && work.histInfo) {
      rows.push('<tr><td class="k">直方图分箱</td><td class="mono">' + work.histInfo.bins + ' 箱，范围 [' +
        numText(work.histInfo.min, null) + ', ' + numText(work.histInfo.max, null) + ']</td></tr>');
    }
    if (work && work.notes && work.notes.length) {
      rows.push('<tr><td class="k">绘图备注</td><td>' + work.notes.map(function (n) { return esc(n); }).join('；') + '</td></tr>');
    }
    out.push('<h3 class="rep-h3">4.1 绘图设置</h3>');
    out.push('<table class="rep-table kv">' + rows.join('') + '</table>');

    /* 图表元素属性 */
    var styleRows = [
      ['X 轴刻度', '字号 ' + sty.xAxisFontSize + ' px · ' + (sty.xAxisFontWeight === 'bold' ? '加粗' : '常规') + ' · 颜色 ' + sty.xAxisColor],
      ['Y 轴刻度', '字号 ' + sty.yAxisFontSize + ' px · ' + (sty.yAxisFontWeight === 'bold' ? '加粗' : '常规') + ' · 颜色 ' + sty.yAxisColor],
      ['标题 / 图例字号', sty.titleSize + ' px / ' + sty.legendSize + ' px'],
      ['Y 轴范围', (sty.yMin === null || sty.yMin === undefined || sty.yMin === '') && (sty.yMax === null || sty.yMax === undefined || sty.yMax === '') ? '自动' : ('min = ' + (sty.yMin === null || sty.yMin === undefined || sty.yMin === '' ? '自动' : sty.yMin) + '，max = ' + (sty.yMax === null || sty.yMax === undefined || sty.yMax === '' ? '自动' : sty.yMax))],
      ['Y 轴对数', sty.yLog ? '开启' : '关闭'],
      ['Y 轴小数位', (sty.yDecimals === null || sty.yDecimals === undefined || sty.yDecimals === '') ? '自动' : (sty.yDecimals + ' 位')],
      ['显示数据值', sty.showValueLabels ? '显示' : '不显示'],
      ['网格线', sty.showGrid ? '显示' : '隐藏'],
      ['Y 轴标题', sty.showYAxisTitle ? '显示' : '隐藏'],
      ['图例', sty.showLegend ? '显示' : '隐藏'],
      ['Box 中位数连线', sty.boxMedianLine ? '显示' : '隐藏'],
      ['X 轴标题居中', sty.xTitleCentered ? '居中显示于刻度下方（按旋转角自动留距）' : '默认位置'],
      ['轴标签旋转策略', sty.rotateMode === 'auto' ? '自动（按类别数与标签长度）' : String(sty.rotateMode)]
    ];
    out.push('<h3 class="rep-h3">4.2 图表元素属性</h3>');
    out.push('<table class="rep-table kv">' + styleRows.map(function (r) {
      return '<tr><td class="k">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>';
    }).join('') + '</table>');
    return out.join('\n');
  }

  function previewSection(ctx) {
    var df = ctx.df, view = ctx.view;
    var n = Math.min(view.count, PREVIEW_ROWS);
    var th = ['<th class="num">#</th>'].concat(df.cols.map(function (c) {
      return '<th>' + esc(c.name) + '<span class="ty">' + esc(typeLabel(c.type)) + '</span></th>';
    })).join('');

    var body = [];
    for (var pos = 0; pos < n; pos++) {
      var tds = ['<td class="num">' + (pos + 1) + '</td>'];
      for (var ci = 0; ci < df.cols.length; ci++) {
        var c = df.cols[ci];
        var txt = '';
        try { txt = view.displayAt(pos, ci); } catch (e) { txt = ''; }
        var isNum = !(YMS.types && c.type === YMS.types.STRING);
        tds.push('<td class="' + (isNum ? 'num' : '') + (txt === '' ? ' empty' : '') + '">' + esc(txt) + '</td>');
      }
      body.push('<tr>' + tds.join('') + '</tr>');
    }
    if (!n) body.push('<tr><td colspan="' + (df.cols.length + 1) + '" class="empty">当前视图无数据行（可能已被筛选条件全部过滤）。</td></tr>');

    return '<h2 class="rep-h"><span class="rep-no">五</span>数据预览</h2>' +
      '<p class="note">显示视图前 ' + n + ' 行，共 ' + view.count + ' 行（原始 ' + df.rowCount + ' 行）。' +
      '空单元格表示缺失值；数值与时间按列小数位 / 时间样式格式化显示。</p>' +
      '<table class="rep-table">' +
      '<thead><tr>' + th + '</tr></thead>' +
      '<tbody>' + body.join('') + '</tbody>' +
      '</table>';
  }

  function footSection(ctx) {
    return '<footer class="rep-foot">' +
      '<span>YMS 良率管理系统 · 应用版本 ' + esc(YMS.version || '—') + ' · 生成于 ' + esc(fmtDateTime(ctx.generatedAt)) + '</span>' +
      '<span>' + esc(ctx.fileName) + '</span>' +
      '</footer>';
  }

  /* ==========================================================================
     主流程
     ========================================================================== */
  async function runBuild() {
    var t0 = Date.now();
    var Store = YMS.Store;
    var df = Store.state.df;
    var view = Store.getView();
    if (!df || !view) {
      U.toast('请先导入数据', 'warn');
      return null;
    }
    if (!view.count) {
      U.toast('当前视图没有数据行（请检查筛选条件）', 'warn');
    }

    var cap = await captureCharts();
    progressClose();

    var generatedAt = new Date();
    var tableName = Store.state.tableName || '数据表';
    var ctx = {
      df: df, view: view, cap: cap,
      generatedAt: generatedAt,
      tableName: tableName
    };
    var fileName = safeFileName(tableName) + '-报告-' + U.nowStamp(generatedAt) + '.html';
    ctx.fileName = fileName;

    var body = [
      headSection(ctx),
      processingSection(ctx),
      statsSection(ctx),
      chartsSection(ctx),
      plotConfigSection(ctx),
      previewSection(ctx),
      footSection(ctx)
    ].join('\n');

    var html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
      '<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + esc(tableName) + ' · 数据报告</title>\n' +
      '<style>\n' + CSS + '\n</style>\n' +
      '</head>\n<body>\n<div class="rep">\n' + body + '\n</div>\n</body>\n</html>\n';

    if (YMS.debug) console.log('[YMS.Report] 生成耗时 ' + (Date.now() - t0) + ' ms，图表 ' + cap.images.length + ' 张');

    return {
      html: html,
      fileName: fileName,
      chartCount: cap.images.length,
      chartImages: cap.images.map(function (x) { return x.dataURL; })
    };
  }

  function failReport(e) {
    progressClose();
    var msg = (e && e.message) ? e.message : String(e);
    try { if (global.console && console.error) console.error('[YMS.Report] 报告生成失败：', e); } catch (x) { }
    try { U.toast('报告生成失败：' + U.escapeHtml(msg), 'error'); } catch (y) { }
    return null;
  }

  /**
   * 生成报告（不下载）
   * @returns {Promise<{html:string, fileName:string, chartCount:number, chartImages:string[]}|null>}
   */
  function build() {
    if (!YMS.Store || !YMS.Store.hasData || !YMS.Store.hasData()) {
      try { U.toast('请先导入数据', 'warn'); } catch (e) { }
      return Promise.resolve(null);
    }
    var p;
    try { p = runBuild(); } catch (e1) { return Promise.resolve(failReport(e1)); }
    return Promise.resolve(p).catch(failReport);
  }

  /**
   * 生成并下载报告文件（<tableName>-报告-<stamp>.html）
   * @returns {Promise<object|null>}
   */
  function exportHTML() {
    return build().then(function (r) {
      if (!r) return null;
      try {
        U.downloadText(r.fileName, r.html, 'text/html');
        U.toast('报告已生成：' + esc(r.fileName) + '（图表 ' + r.chartCount + ' 张）', 'ok');
      } catch (e) {
        U.toast('报告下载失败：' + U.escapeHtml(e && e.message ? e.message : String(e)), 'error');
        return null;
      }
      return r;
    });
  }

  /**
   * 弹窗预览报告（iframe srcdoc + sandbox="" 隔离，避免样式污染主界面）
   * @returns {Promise<object|null>}
   */
  function openPreview() {
    return build().then(function (r) {
      if (!r) return null;
      var bar = document.createElement('div');
      bar.className = 'report-preview-bar';
      bar.textContent = '共 ' + r.chartCount + ' 张图表截图 · 报告为单文件自包含 HTML（内联样式 + base64 图片），可离线查看';

      var frame = document.createElement('iframe');
      frame.className = 'report-preview-frame';
      frame.setAttribute('sandbox', '');
      frame.setAttribute('title', '报告预览');
      frame.setAttribute('srcdoc', r.html);

      var m = U.modal({
        title: '报告预览 · ' + r.fileName,
        width: 'xl',
        footer: [
          {
            text: '导出 PPT',
            cls: 'btn-primary',
            onClick: function (close) {
              close();
              /* 按 Page 分页导出 .pptx（图表与屏幕显示一致） */
              exportPPT();
            }
          },
          {
            text: '导出 HTML', cls: '',
            onClick: function (close) {
              close();
              try {
                U.downloadText(r.fileName, r.html, 'text/html');
                U.toast('报告已导出：' + esc(r.fileName), 'ok');
              } catch (e) {
                U.toast('报告下载失败：' + U.escapeHtml(e && e.message ? e.message : String(e)), 'error');
              }
            }
          },
          { text: '关闭' }
        ]
      });
      m.body.className = 'modal-body is-report';
      m.body.appendChild(bar);
      m.body.appendChild(frame);
      return r;
    });
  }

  YMS.Report = {
    build: build,
    exportHTML: exportHTML,
    exportPPT: exportPPT,
    buildPptxSpec: buildPptxSpec,
    openPreview: openPreview,
    MAX_CHARTS: MAX_CHARTS,
    PREVIEW_ROWS: PREVIEW_ROWS,
    CHART_TIMEOUT: CHART_TIMEOUT,
    PPT_PIXEL_RATIO: PPT_PIXEL_RATIO,
    PPT_MAX_PER_SLIDE: PPT_MAX_PER_SLIDE,
    PPT_CSS_PER_IN: PPT_CSS_PER_IN,
    PPT_AREA: plotAreaSize,          // 绘图区可用内容尺寸（自测可断言截图容器来源）
    PPT_CARD_BOXES: cardBoxes,       // 某 Page 每张卡片的内容盒尺寸（CSS px）
    PPT_MIME: PPT_MIME
  };
})(typeof window !== 'undefined' ? window : this);
