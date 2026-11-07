import React from 'react';
import { MINI_MODE, aggregateStatus } from '../statusMeta';

/**
 * 迷你模式的聚合小灯（v1.7.0）：整窗收成一盏圆灯，几乎不遮挡内容。
 *
 * 聚合优先级：assist(紫) > stuck(红) > running(绿闪) > idle(黄不闪) >
 * 全 offline(灰)。v1.7.0 rev3 修正（老吴实测反馈）：原先 idle 也归绿，导致
 * 「迷你灯绿、展开后满屏黄、绿灯凭空消失」的自相矛盾 —— 现在迷你灯颜色与
 * classic 展开视图一一对应：绿=有 AI 正在干活（闪），黄=开机空闲（不闪），
 * 展开必有与迷你灯同色的一盏。running 与 idle 的闪烁差异由本组件的
 * MINI_DOT_META 按聚合返回的状态值区分，mini-mode.js 只负责「选哪个状态」。
 *
 * 交互契约（与 App.jsx 统一指针处理器配合）：
 *  - 按住拖动 = 移动窗口（复用 pointer capture + DRAG_THRESHOLD_PX 判定，
 *    本组件刻意不挂「禁拖」类名，也不拦截 pointerdown，保证整灯可拖）；
 *  - 单击 = 展开回切换前的模式（App.jsx 按 data-agent-id="asl-mini" 识别，
 *    绝不开详情面板）。
 *
 * MINI_LIGHT_SIZE（20px）与 MINI_WINDOW（40px）来自 main/mini-mode.js；
 * DOM 上用等价 Tailwind 尺寸类（w-5 h-5 / w-10 h-10）保持单一视觉来源。
 */
const MINI_DOT_META = {
  assist: {
    dot: 'bg-purple-500 animate-blink',
    ring: 'ring-purple-400/50',
    glow: 'shadow-[0_0_12px_4px_rgba(168,85,247,0.7)]',
  },
  stuck: {
    dot: 'bg-red-500 animate-blink',
    ring: 'ring-red-500/40',
    glow: 'shadow-[0_0_10px_3px_rgba(239,68,68,0.6)]',
  },
  running: {
    dot: 'bg-green-500 animate-blink',
    ring: 'ring-green-500/40',
    glow: 'shadow-[0_0_8px_2px_rgba(34,197,94,0.55)]',
  },
  idle: {
    // v1.7.0 rev3：idle 改黄色不闪（与 classic 展开视图一致，迷你绿=真在干活）
    dot: 'bg-yellow-400',
    ring: 'ring-yellow-400/40',
    glow: 'shadow-[0_0_8px_2px_rgba(250,204,21,0.45)]',
  },
  offline: {
    dot: 'bg-gray-500',
    ring: 'ring-gray-500/30',
    glow: '',
  },
};

const MINI_LIGHT_CLASS = MINI_MODE && MINI_MODE.MINI_LIGHT_SIZE === 24 ? 'w-6 h-6' : 'w-5 h-5';

/**
 * @param {object} props
 * @param {Array<{status: string}>} props.agents 全部 agent（组件内部做聚合）
 * @param {string} props.miniAria aria-label（i18n 文案由 App 传入）
 */
function MiniLight({ agents, miniAria }) {
  const status = aggregateStatus((agents || []).map((a) => a && a.status));
  const meta = MINI_DOT_META[status] || MINI_DOT_META.offline;
  return (
    <div className="flex h-10 w-10 items-center justify-center bg-[#111827]" data-mini="true">
      <button
        type="button"
        data-agent-id="asl-mini"
        aria-label={miniAria}
        title=""
        className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-white/5"
      >
        <span
          className={`block rounded-full ring-2 ${meta.dot} ${meta.ring} ${meta.glow} ${MINI_LIGHT_CLASS}`}
        />
      </button>
    </div>
  );
}

export default MiniLight;
