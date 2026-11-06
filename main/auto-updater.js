'use strict';

/**
 * main/auto-updater.js — 自动更新封装（v1.6.0 功能五）。
 *
 * 两种产物两种策略：
 *   - 安装版（NSIS）：启动 30 秒后 checkForUpdatesAndNotify —— 发现新版本
 *     系统通知，用户确认后下载安装（electron-updater 内置流程）
 *   - 绿色版（portable）：electron-updater 不支持自更新，只向灯条派
 *     「有新版本 vX.Y.Z → 查看」小横幅，点击打开 Releases 页手动下载
 *
 * 静默纪律：开发模式（未打包）/ 拉取失败 / 仓库无 Release 一律静默，
 * 不打搅用户（只写日志）。
 *
 * 沙箱无法实测真更新：核心判断收敛在 evaluateUpdate() 纯逻辑（checkFn /
 * onBanner / log 全注入），单测覆盖分支；真实 electron-updater 接线在
 * startAutoUpdate() 里 lazily require。VERSIONS.md 已注明：本功能需发布
 * 到 GitHub 后真人验证一次。
 */

/** Releases 页（绿色版横幅点击跳转）。TODO-GITHUB-OWNER 发布前统一替换。 */
const RELEASES_URL = 'https://github.com/TODO-GITHUB-OWNER/ai-status-light/releases';

/** 首次检查延迟（启动后 30 秒，避开启动高峰）。 */
const FIRST_CHECK_DELAY_MS = 30_000;

/**
 * 一次更新检查的核心判定（纯逻辑，全注入可测）。
 * @param {object} deps
 * @param {boolean} deps.isPackaged 未打包（dev）= 直接跳过
 * @param {boolean} deps.isPortable 绿色版 = 只发横幅，不自动下载
 * @param {() => Promise<{version?: string}|null>} deps.checkFn 检查实现
 * @param {string} deps.currentVersion 当前版本（如 '1.6.0'）
 * @param {(info: {version: string, url: string}) => void} [deps.onBanner] 绿色版横幅回调
 * @param {(msg: string) => void} [deps.logImpl]
 * @returns {Promise<'skipped'|'installed-flow'|'banner'|'none'|'failed'>}
 */
async function evaluateUpdate({ isPackaged, isPortable, checkFn, currentVersion, onBanner, logImpl } = {}) {
  const log = logImpl || (() => {});
  if (!isPackaged) {
    log('auto-update skipped: not packaged (dev mode)');
    return 'skipped';
  }
  if (typeof checkFn !== 'function') {
    log('auto-update skipped: no checkFn');
    return 'skipped';
  }
  let info = null;
  try {
    info = await checkFn();
  } catch (err) {
    // 拉取失败/无 Release/网络不通：静默，只记日志
    log(`auto-update check failed silently: ${err && err.message}`);
    return 'failed';
  }
  const latest = info && typeof info.version === 'string' ? info.version : '';
  if (!latest || latest === currentVersion) return 'none';
  if (isPortable) {
    // 绿色版不能自更新：给灯条派横幅，用户点了自己去 Releases 下
    if (typeof onBanner === 'function') onBanner({ version: latest, url: RELEASES_URL });
    return 'banner';
  }
  // 安装版：checkFn 即 checkForUpdatesAndNotify，系统通知流程已由它完成
  return 'installed-flow';
}

/**
 * 手动「检查更新」（v1.6.1 功能三）：三态反馈——用户点了按钮就要有回响，
 * 不许静默。复用与自动检查相同的 checkFn 注入形态。
 * @param {object} deps
 * @param {boolean} deps.isPackaged dev 模式 → not-ready
 * @param {() => Promise<{version?: string}|null>} deps.checkFn
 * @param {string} deps.currentVersion
 * @param {(msg: string) => void} [deps.logImpl]
 * @returns {Promise<{state:'new'|'latest'|'not-ready', version?: string, url?: string}>}
 *   new=发现新版（带 version+url）；latest=已是最新；not-ready=更新源未开放/
 *   拉取失败/dev（GitHub 仓库未发布前恒走这态）
 */
async function manualCheck({ isPackaged, checkFn, currentVersion, logImpl } = {}) {
  const log = logImpl || (() => {});
  if (!isPackaged || typeof checkFn !== 'function') return { state: 'not-ready' };
  let info = null;
  try {
    info = await checkFn();
  } catch (err) {
    log(`manual update check failed: ${err && err.message}`);
    return { state: 'not-ready' };
  }
  const latest = info && typeof info.version === 'string' ? info.version : '';
  if (!latest) return { state: 'not-ready' }; // 仓库无 Release = 源未开放
  if (latest === currentVersion) return { state: 'latest' };
  return { state: 'new', version: latest, url: RELEASES_URL };
}

/**
 * 生产接线：30 秒后跑第一次检查（可再调 checkNow 手动触发）。
 * @param {object} deps
 * @param {boolean} deps.isPackaged
 * @param {boolean} deps.isPortable process.env.PORTABLE_EXECUTABLE_FILE 探测
 * @param {string} deps.currentVersion APP_VERSION
 * @param {(info: {version: string, url: string}) => void} deps.onBanner 发到灯条渲染层
 * @param {(msg: string) => void} [deps.logImpl]
 * @returns {{checkNow: () => Promise<string>, checkDetailed: () => Promise<object>, stop: () => void}}
 */
function startAutoUpdate({ isPackaged, isPortable, currentVersion, onBanner, logImpl } = {}) {
  const log = logImpl || ((m) => console.warn(`[status-light] ${m}`));
  let timer = null;

  // lazily require：dev 环境/依赖缺失时装死，绝不影响启动
  function loadUpdater() {
    try {
      return require('electron-updater').autoUpdater;
    } catch (err) {
      log(`electron-updater unavailable: ${err && err.message}`);
      return null;
    }
  }

  function buildCheckFn() {
    const updater = isPackaged ? loadUpdater() : null;
    if (!updater) return null;
    return async () => {
      if (isPortable) {
        // 绿色版：只查不下载
        const res = await updater.checkForUpdates();
        return res && res.updateInfo ? { version: res.updateInfo.version } : null;
      }
      const res = await updater.checkForUpdatesAndNotify();
      return res && res.updateInfo ? { version: res.updateInfo.version } : null;
    };
  }

  function checkNow() {
    return evaluateUpdate({ isPackaged, isPortable, checkFn: buildCheckFn(), currentVersion, onBanner, logImpl: log });
  }

  /** v1.6.1：设置面板「检查更新」按钮的手动入口（三态反馈）。 */
  function checkDetailed() {
    return manualCheck({ isPackaged, checkFn: buildCheckFn(), currentVersion, logImpl: log });
  }

  if (isPackaged) {
    timer = setTimeout(() => checkNow().catch(() => {}), FIRST_CHECK_DELAY_MS);
    if (timer.unref) timer.unref();
  }

  return {
    checkNow,
    checkDetailed,
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { RELEASES_URL, FIRST_CHECK_DELAY_MS, evaluateUpdate, manualCheck, startAutoUpdate };
