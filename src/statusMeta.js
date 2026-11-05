/**
 * Shared status metadata and formatting helpers for the overlay UI.
 *
 * v1.5.0 双语：文案不再写死中文 —— STATUS_META[*].labelKey 指向
 * main/i18n.js 语言包，formatRelativeTime 收 lang 参数。两个语言包经
 * UMD 副作用 import 挂到 window（Vite dev 把源码当 ESM 直发浏览器，
 * 裸 CJS 会炸；UMD 在浏览器分支挂 window，在 node 测试走 module.exports）。
 */
import '../main/i18n';
import '../main/strip-name';
// v1.6.0：齿轮菜单定义。src/ 消费 window.ASL_* 的唯一锚点是本文件
// （QA 闸口 qa-v152-adversarial 锁死），App.jsx 一律从这里转口。
import '../main/gear-menu';

const I18N = window.ASL_I18N;
const STRIP = window.ASL_STRIP_NAME;

/** 齿轮下拉菜单定义（main/gear-menu.js，UMD 双通道挂 window）。 */
export const GEAR_MENU = window.ASL_GEAR_MENU;

/** 当前界面语言（App.jsx 在用户切换时调用设置；默认中文）。 */
let currentLang = 'zh-CN';

/**
 * 设置渲染层语言（'zh-CN' | 'en-US'）。App.jsx 在 getSettings /
 * onLanguageChange 时调用。
 */
export function setUiLanguage(lang) {
  currentLang = I18N.PACKS[lang] ? lang : 'zh-CN';
}

export function getUiLanguage() {
  return currentLang;
}

/** 取当前语言文案的快捷方式。 */
export function t(key, params) {
  return I18N.t(currentLang, key, params);
}

export const STATUS_META = {
  running: {
    labelKey: 'status.running',
    dot: 'bg-green-500',
    ring: 'ring-green-500/40',
    glow: 'shadow-[0_0_8px_2px_rgba(34,197,94,0.55)]',
  },
  idle: {
    labelKey: 'status.idle',
    dot: 'bg-yellow-400',
    ring: 'ring-yellow-400/40',
    glow: 'shadow-[0_0_8px_2px_rgba(250,204,21,0.45)]',
  },
  stuck: {
    labelKey: 'status.stuck',
    dot: 'bg-red-500 animate-blink',
    ring: 'ring-red-500/40',
    glow: 'shadow-[0_0_10px_3px_rgba(239,68,68,0.6)]',
  },
  assist: {
    labelKey: 'status.assist',
    dot: 'bg-purple-500 animate-blink',
    ring: 'ring-purple-400/50',
    glow: 'shadow-[0_0_12px_4px_rgba(168,85,247,0.7)]',
  },
  offline: {
    labelKey: 'status.offline',
    dot: 'bg-gray-500',
    ring: 'ring-gray-500/30',
    glow: '',
  },
};

/** 状态文案（当前语言）。 */
export function statusLabel(status) {
  return t(`status.${status || 'offline'}`);
}

/**
 * Formats a heartbeat timestamp as a short relative-time string
 * (current UI language).
 * @param {number} ts epoch milliseconds; 0 means "never reported".
 * @returns {string}
 */
export function formatRelativeTime(ts) {
  if (!ts) return t('time.never');
  const diff = Date.now() - ts;
  if (diff < 5_000) return t('time.just');
  if (diff < 60_000) return t('time.secAgo', { n: Math.floor(diff / 1000) });
  if (diff < 3_600_000) return t('time.minAgo', { n: Math.floor(diff / 60_000) });
  return t('time.hourAgo', { n: Math.floor(diff / 3_600_000) });
}

/**
 * 灯条灯名（v1.5.0）：返回全称（不再截 2 字符），两行换行/省略由 CSS
 * 完成；超长（>12 字符）在这里截断加省略号兜底。保留 shortName 导出名
 * 是为了兼容既有调用点。
 * @param {{id: string, name: string}} agent
 * @returns {string}
 */
export function shortName(agent) {
  return STRIP.stripDisplayName(agent && agent.name, agent && agent.id);
}
