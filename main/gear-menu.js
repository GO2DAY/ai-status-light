/**
 * main/gear-menu.js — 齿轮单击下拉菜单的纯定义（v1.6.0 功能二）。
 *
 * 齿轮左键从「直接开面板」改为「灯条内弹小菜单」。菜单项与右键原生菜单
 * 一致 + 一项直达灯源管理区。定义抽成纯数据模块：React（App.jsx）渲染、
 * 主进程（gear:action IPC 白名单）、单测三方共用同一份，防止漂移。
 *
 * 不裁灯契约：菜单是灯条内的绝对定位浮层（overlay），宽度 << 灯条宽，
 * 渲染层不因菜单调 window:setWidth —— 灯条宽度永不受菜单影响
 * （panelWindowWidth 的 max 语义由 tests/gear-menu.test.js 锁死）。
 *
 * UMD 双通道赋值（v1.5.2 P0 修复模式）：module.exports 与 window 全局
 * **同时**挂，绝不用 else。tests/umd-dual-env.test.js 加载清单含本模块。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ASL_GEAR_MENU = api;
  else if (root && typeof root === 'object') root.ASL_GEAR_MENU = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /**
   * 菜单项（顺序即显示顺序）。key 指向 i18n.js 语言包：
   *   agents   → AI 源管理（设置窗口并定位到灯源管理区）
   *   settings → 设置（设置窗口）
   *   refresh  → 重新检测（agentWatcher.refreshNow，与右键菜单同逻辑）
   *   quit     → 退出 AI 状态灯（quitApp 干净退出）
   */
  const GEAR_MENU_ITEMS = [
    { id: 'agents', key: 'menu.agents' },
    { id: 'settings', key: 'menu.settings' },
    { id: 'refresh', key: 'menu.refresh' },
    { id: 'quit', key: 'menu.quit' },
  ];

  const GEAR_MENU_IDS = GEAR_MENU_ITEMS.map(function (it) { return it.id; });

  /**
   * 生成当前语言的菜单（渲染层用）。
   * @param {(key: string) => string} tFn i18n.t 的绑定形态（key -> 文案）
   * @returns {Array<{id: string, label: string}>}
   */
  function gearMenuLabels(tFn) {
    return GEAR_MENU_ITEMS.map(function (it) {
      return { id: it.id, label: tFn(it.key) };
    });
  }

  /** 白名单校验（主进程 gear:action IPC 用，防渲染层发来任意动作串）。 */
  function isGearAction(action) {
    return GEAR_MENU_IDS.indexOf(action) !== -1;
  }

  return { GEAR_MENU_ITEMS, GEAR_MENU_IDS, gearMenuLabels, isGearAction };
});
