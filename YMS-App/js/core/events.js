/* ==========================================================================
   YMS · core/events.js
   极简发布/订阅：所有视图通过 Store 事件而非直接互相调用（单一数据来源 + 单向数据流）
   ========================================================================== */
(function (global) {
  'use strict';
  var YMS = global.YMS = global.YMS || {};

  function Emitter() { this._handlers = {}; }

  Emitter.prototype.on = function (topic, fn) {
    (this._handlers[topic] = this._handlers[topic] || []).push(fn);
    var self = this;
    return function off() { self.off(topic, fn); };
  };
  Emitter.prototype.off = function (topic, fn) {
    var list = this._handlers[topic];
    if (!list) return;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  Emitter.prototype.emit = function (topic, payload) {
    var list = this._handlers[topic];
    if (list) {
      list.slice().forEach(function (fn) {
        try { fn(payload); }
        catch (err) {
          // 单个订阅者异常不得中断其它视图刷新
          if (global.console) console.error('[YMS] handler error on "' + topic + '":', err);
          if (YMS.util && YMS.util.toast) YMS.util.toast('内部错误（' + topic + '）：' + (err && err.message), 'error');
        }
      });
    }
    var all = this._handlers['*'];
    if (all) all.slice().forEach(function (fn) { try { fn(topic, payload); } catch (e) { console.error(e); } });
  };

  YMS.Emitter = Emitter;
  YMS.bus = new Emitter();
})(typeof window !== 'undefined' ? window : this);
