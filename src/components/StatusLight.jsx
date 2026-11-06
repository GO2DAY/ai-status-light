import React from 'react';
import { STATUS_META, shortName, stripStatusText } from '../statusMeta';

/**
 * A single status light: circular indicator + short name + status word.
 *
 * The light is itself a drag handle (so the user can grab any light to move
 * the strip). To avoid drag and click fighting, this component intentionally
 * does not handle its own click — App.jsx decides click vs drag from pointer
 * movement, which is the only way to give every light a draggable surface
 * without leaving any dead area.
 *
 * @param {object} props
 * @param {{id: string, name: string, status: string, task: string, lastHeartbeat: number, auto: boolean}} props.agent
 * @param {boolean} props.selected
 * @param {boolean} [props.showStatusText=true] v1.6.3 灯下状态文字（缺省显示）
 * @param {React.Ref<HTMLButtonElement>} props.innerRef forwarded so the parent can attach a unified pointerdown listener
 */
const StatusLight = React.forwardRef(function StatusLight(
  { agent, selected, showStatusText = true },
  innerRef
) {
  const meta = STATUS_META[agent.status] || STATUS_META.offline;

  const handleMouseEnter = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    window.statusLight.showTooltip({
      agent,
      anchorX: window.screenX + rect.left + rect.width / 2,
      anchorTop: window.screenY + rect.top,
      anchorBottom: window.screenY + rect.bottom,
    });
  };

  const handleMouseLeave = () => {
    window.statusLight.hideTooltip();
  };

  return (
    <button
      ref={innerRef}
      type="button"
      data-agent-id={agent.id}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`flex flex-col items-center justify-center w-14 h-[72px] rounded-md transition-colors cursor-pointer ${
        selected ? 'bg-white/10' : 'hover:bg-white/5'
      } ${agent.status === 'assist' ? 'bg-purple-500/15' : ''}`}
      title=""
    >
      <span
        className={`block rounded-full ring-2 ${meta.dot} ${meta.ring} ${meta.glow} ${
          agent.status === 'assist' ? 'w-5 h-5' : 'w-4 h-4'
        }`}
      />
      {/* v1.5.0：灯名全称两行显示（不再截 2 字符）。w-[52px] + break-words
          + line-clamp-2：超 2 字符换行，最多两行，再长才省略号。行高
          11px×2 + 灯 16/20px + v1.6.3 状态词 10px 仍放得下 72px 行高
          （ROW_HEIGHT 同步 56→72）。数据层另有 strip-name.js 的 12 字符
          硬上限兜底。 */}
      <span
        className={`mt-0.5 w-[52px] break-words text-center text-[10px] leading-[11px] line-clamp-2 ${
          agent.status === 'assist' ? 'text-purple-300 font-semibold' : 'text-gray-300'
        }`}
      >
        {shortName(agent)}
      </span>
      {/* v1.6.3 灯下状态文字（老吴需求：不悬停、扫一眼可见）。小号弱化字，
          颜色跟随灯色；文字不闪（圆灯已闪，双闪是噪音）。 */}
      {showStatusText ? (
        <span
          className={`mt-[1px] w-[52px] truncate text-center text-[9px] leading-[10px] ${
            meta.text || 'text-gray-400'
          }`}
        >
          {stripStatusText(agent.status)}
        </span>
      ) : null}
    </button>
  );
});

export default StatusLight;
