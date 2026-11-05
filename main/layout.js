/**
 * main/layout.js — 灯条窗口尺寸纯计算（v1.5.0 抽离，electron-free 可单测）。
 *
 * v1.5.0 修复「打开详情面板裁灯」：渲染层在面板打开时请求一个面板宽
 * （如 380px），但灯条全宽 = 灯数 × 56 + 边距，灯多时比 380 还宽 ——
 * 直接采用请求宽会把右侧的灯切出窗口。规则改为：窗口宽 = max(灯条全宽,
 * 面板请求宽)，面板作为灯条下方的下拉区域展示；收起时（请求 0）回退到
 * 灯条全宽。
 *
 * UMD 双通道赋值（v1.5.2 P0 修复）：module.exports 与 window.ASL_LAYOUT
 * **同时**挂，绝不用 else —— 防 rollup commonjs 垫片环境漏挂 window 全局。
 * tests/umd-dual-env.test.js 专守此坑。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ASL_LAYOUT = api;
  else if (root && typeof root === 'object') root.ASL_LAYOUT = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /**
   * 计算面板展开/收起时的窗口宽度。
   * @param {number} requested 渲染层请求的宽度；<=0 或非法 = 面板收起
   * @param {number} stripWidth 灯条全宽（computeWidth() 的输出）
   * @returns {number} 窗口目标宽度（>=stripWidth，永不低于灯条全宽）
   */
  function panelWindowWidth(requested, stripWidth) {
    const strip = Number.isFinite(stripWidth) && stripWidth > 0 ? Math.round(stripWidth) : 0;
    const req = Number(requested);
    if (!Number.isFinite(req) || req <= 0) return strip;
    return Math.max(Math.round(req), strip);
  }

  return { panelWindowWidth };
});
