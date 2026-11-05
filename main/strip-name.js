/**
 * main/strip-name.js — 灯条灯名显示纯逻辑（v1.5.0，electron-free 可单测）。
 *
 * v1.5.0 变更：灯名从「截 2 字符」改为「两行换行显示全称」。
 * 换行与两行省略由 CSS 完成（line-clamp: 2 + break-words，56px 行高放得下
 * 两行 11px 行高），本模块只做最终兜底：空白回退、超长按字符截断加省略号
 * （防止极端长名把布局撑爆——CSS 省略已兜住视觉，这里是数据层保险丝）。
 *
 * UMD 双通道赋值（v1.5.2 P0 修复）：module.exports 与 window 全局**同时**
 * 挂，绝不用 else —— rollup commonjs 垫片环境下 module 与 window 并存，
 * 旧 else 写法会漏挂 window.ASL_STRIP_NAME，渲染层崩（空黑条事故同源）。
 * tests/umd-dual-env.test.js 专守此坑。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ASL_STRIP_NAME = api;
  else if (root && typeof root === 'object') root.ASL_STRIP_NAME = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** 灯名硬上限（字符数，CJK 按 1 计）。两行 × 每行约 6 个拉丁/3 个汉字富余量。 */
  const STRIP_NAME_MAX = 12;

  /**
   * 灯条上显示的灯名。
   * @param {*} name agent.name（可空）
   * @param {*} fallback name 为空时的回退（通常是 agent.id）
   * @returns {string}  trim 后的名称；空 -> '?'；超过 12 字符截断加 '…'
   */
  function stripDisplayName(name, fallback) {
    const source = String(name || '').trim() || String(fallback || '').trim();
    if (!source) return '?';
    const chars = Array.from(source);
    if (chars.length <= STRIP_NAME_MAX) return source;
    return `${chars.slice(0, STRIP_NAME_MAX).join('')}…`;
  }

  return { STRIP_NAME_MAX, stripDisplayName };
});
