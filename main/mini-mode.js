/**
 * main/mini-mode.js — 迷你模式聚合灯纯逻辑（v1.7.0，electron-free 可单测）。
 *
 * 迷你模式 = 整窗收成一盏聚合小灯（老吴 v1.7.0 需求）：窗口约 40px 见方、
 * 圆灯 20px，聚合状态优先级 assist(紫) > stuck(红) > running(绿闪) >
 * idle(绿不闪) > 全 offline(灰)。老吴明确「正常时只看绿/红/紫」——idle
 * 归为绿色不闪，offline 归为灰色兜底，不单独做黄色。
 *
 * 运行中(running) 与 空闲(idle) 在迷你灯上都映射为绿色，但 running 要闪
 * （有别的事在跑），idle 不闪 —— 闪烁语义由渲染层 MiniLight.jsx 的
 * MINI_DOT_META 按这里返回的状态值区分，本模块只负责「选哪个状态」。
 *
 * UMD 双通道赋值（与 layout.js / strip-name.js 同款，绝不用 else）：
 * module.exports 与 window.ASL_MINI_MODE 同时挂 —— rollup commonjs 垫片
 * 环境下 module 与 window 并存，else 写法会漏挂 window 通道（渲染层空黑条
 * 事故同源）。tests/umd-dual-env.test.js 专守此坑。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ASL_MINI_MODE = api;
  else if (root && typeof root === 'object') root.ASL_MINI_MODE = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** 迷你模式窗口边长（px，正方形）。约 40px 见方，几乎不遮挡内容。 */
  const MINI_WINDOW = 40;

  /** 迷你聚合灯圆直径（px）。老吴建议 20~24，取 20 留出 ring-2 视觉余量。 */
  const MINI_LIGHT_SIZE = 20;

  /**
   * 聚合状态优先级（从高到低）：紫 > 红 > 绿闪 > 绿 > 灰。
   * 顺序即实现：数组里先出现的优先。
   */
  const MINI_PRIORITY = ['assist', 'stuck', 'running', 'idle', 'offline'];

  /**
   * 聚合状态：从一组 agent 状态里选出迷你灯应显示的那一个。
   * @param {Array<string>} statuses 各 agent 的有效状态（可空/含未知值）
   * @returns {string} MINI_PRIORITY 中的一员；空清单/全部未知值回退 offline
   */
  function aggregateStatus(statuses) {
    const list = Array.isArray(statuses) ? statuses : [];
    for (const status of MINI_PRIORITY) {
      if (list.includes(status)) return status;
    }
    return 'offline';
  }

  return { MINI_WINDOW, MINI_LIGHT_SIZE, MINI_PRIORITY, aggregateStatus };
});
