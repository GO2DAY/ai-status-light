import React from 'react';

/**
 * 拖动把手图标（v1.7.0 rev7，老吴反馈「不知道哪里能拖」）：
 * 6 点握手纹（grip），classic/compact 显示为灯条最左侧的常驻把手列，
 * mini 显示为悬停时左上角浮现的小徽标。纯视觉指示（pointer-events:none），
 * 不拦截指针 —— 拖动仍由 App.jsx 根节点的统一指针处理器负责。
 * 用内联 SVG 而不是 Unicode 盲文符（⠿），避免 Windows 字体缺字形出豆腐块。
 */
function GripIcon({ size = 10, className = '' }) {
  const r = 1.3;
  const pad = 2.5;
  const gap = 4;
  const dots = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      dots.push(
        <circle
          key={`${row}-${col}`}
          cx={pad + col * gap + r}
          cy={pad + row * gap + r}
          r={r}
        />
      );
    }
  }
  return (
    <svg
      width={size}
      height={size + 4}
      viewBox={`0 0 ${pad * 2 + gap + r * 2} ${pad * 2 + gap * 2 + r * 2}`}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="currentColor">{dots}</g>
    </svg>
  );
}

export default GripIcon;
