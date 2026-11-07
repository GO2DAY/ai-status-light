'use strict';

/**
 * AI Status Light - Electron main process.
 *
 * Responsibilities:
 *  - Create a frameless, always-on-top, narrow overlay window.
 *  - Run a local HTTP service (127.0.0.1:17890) that AI tools/scripts POST
 *    status reports to: {"agent":"kimi","status":"running|idle|stuck|offline","task":"..."}
 *  - Track heartbeats: >60s without a report downgrades running -> idle,
 *    >300s downgrades to offline. "stuck" is never auto-downgraded.
 *  - Persist agent list and window position in config.json.
 */

const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, Menu, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 应用版本号（窗口标题/语言包插值共用，升级只改这里）。 */
const APP_VERSION = '1.7.0';

const HTTP_PORT = 17890;
const HTTP_HOST = '127.0.0.1';
const HEARTBEAT_IDLE_MS = 60_000;
const HEARTBEAT_OFFLINE_MS = 300_000;
// tooltip 纯提示阈值：idle 且心跳超过 5 分钟时输出 stale: true。
// 数值与 HEARTBEAT_OFFLINE_MS 相同，但语义完全不同 —— 只加提示字段，
// 绝不把后台干活、稀疏上报的 AI / MQTT 云 AI 判成 offline（下一版再评估）。
const STALE_IDLE_MS = 5 * 60 * 1000;
const TICK_MS = 5_000;
// v1.6.3：56 → 72。灯下新增一行状态词（9px 字 + 1px 间距 = +11px），
// 原 56px 里名称两行（22px）+ 灯（20px）+ 间距已接近满高，16px 余量
// 保证 assist 大灯（20px）+ 名称两行 + 状态词不裁切。
// 渲染层 App.jsx 的 h-14 → h-[72px] 必须同步改（两侧只差会裁内容或露底）。
const ROW_HEIGHT = 72;
// v1.7.0 三档显示模式的另两档基准行高：
// compact（精简）= 灯 + 名称、去状态词行，回到 v1.6.2 的 56px 视觉；
// mini（迷你）= 整窗收成一盏聚合小灯，边长取自 main/mini-mode.js（40px）。
// 渲染层 App.jsx 的两个行高类（h-[72px] / h-[56px]）必须与这里同步。
const ROW_HEIGHT_COMPACT = 56;
// v1.7.0 自动收起：autoCollapse 开启且所有 agent 无 stuck/assist 持续满
// 此时长后自动切到 mini；任一 stuck/assist 出现立即恢复收起前模式。
const AUTO_COLLAPSE_DELAY_MS = 60_000;
const LIGHT_WIDTH = 56;
const SIDE_PADDING = 12;
const SETTINGS_WIDTH = 32;
const MIN_PANEL_HEIGHT = 40;
const MAX_PANEL_HEIGHT = 600;
const TIP_WIDTH = 224;
const TIP_HEIGHT = 148;
const AGENT_ID_PATTERN = /^[a-z0-9_-]{1,24}$/i;

// "assist" = the AI hit a blocker, already fired the urgent-call skill (phone
// notification), and is waiting for the human to show up. The purple light
// blinks until the human explicitly acknowledges it (agents:ack / panel
// button); it never auto-clears.
const VALID_STATUSES = new Set(['running', 'idle', 'stuck', 'assist', 'offline']);

// ---------------------------------------------------------------------------
// Paths: config + logs live in the per-user data dir, NOT next to the app.
// ---------------------------------------------------------------------------
// Installed under C:\Program Files\ the program directory is read-only for a
// standard user: saving an agent from the settings panel would throw EACCES,
// get swallowed by saveConfig()'s catch, and the user would silently fall back
// to factory defaults on the next launch (all lights grey, nothing in the log).
// So everything writable goes to app.getPath('userData') == %APPDATA%\AI-Status-Light.
//
// Must be lazy: app.getPath('userData') throws "Cannot get path before app is
// ready", so initPaths() runs at the top of app.whenReady() — not at module
// load. Until then the paths stay null and logError() falls back to the temp
// dir, so early failures are never lost.
const LEGACY_DIR = path.join(__dirname, '..'); // pre-migration location (dev / portable)
const LEGACY_CONFIG_PATH = path.join(LEGACY_DIR, 'config.json');
const FALLBACK_ERROR_LOG = path.join(os.tmpdir(), 'ai-status-light-error.log');

/** @type {string | null} */
let CONFIG_PATH = null;
/** @type {string | null} */
let ERROR_LOG_PATH = null;

function initPaths() {
  let dir = null;
  try {
    dir = app.getPath('userData');
  } catch (err) {
    logError(`app.getPath('userData') failed: ${err.message}`);
  }
  if (!dir) {
    CONFIG_PATH = LEGACY_CONFIG_PATH;
    ERROR_LOG_PATH = path.join(LEGACY_DIR, 'error.log');
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logError(`failed to create userData dir ${dir}: ${err.message}`);
  }
  CONFIG_PATH = path.join(dir, 'config.json');
  ERROR_LOG_PATH = path.join(dir, 'error.log');

  // One-time migration: an existing install already has config.json next to the
  // app (the user's agents, watchers and window position). Copy it over so an
  // upgrade never silently resets to factory defaults.
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(LEGACY_CONFIG_PATH)) {
      fs.copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
      logError(`migrated legacy config from ${LEGACY_CONFIG_PATH} to ${CONFIG_PATH}`);
    }
  } catch (err) {
    logError(`legacy config migration failed: ${err.message}`);
  }

  // First run on a clean machine: neither the new path nor the legacy path has a
  // config. Seed factory defaults so the customer sees something sensible on
  // first launch instead of an empty grey strip. Window position is deliberately
  // omitted — the app computes a guaranteed-visible spot from the actual displays,
  // and a hard-coded coordinate would land off-screen on a different-resolution
  // machine (the exact "the light vanished" bug we already hit once).
  //
  // v1.5.0 脱敏（全球发布版）：出厂 agents/watchers 为空清单 —— 新装的机器上
  // 有什么 AI 由「自动发现」30 秒扫描出来，不预置任何个人灯源；云端中转默认
  // 关闭（公共 broker 不应默认连）；MQTT 主题前缀每台机器随机生成。
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      const factoryConfig = {
        agents: [],
        settings: { soundOn: true, language: 'auto' },
        watchers: [],
        cloudRelay: false,
        mqttTopic: generateMqttTopic(),
        fgWatch: true,
        dbPoll: true,
        screenWatch: true
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(factoryConfig, null, 2), 'utf-8');
      logError('seeded factory config (first run on clean machine)');
    }
  } catch (err) {
    logError(`factory config seed failed: ${err.message}`);
  }

  // Hand the resolved paths to child processes (supervisor) and to the
  // in-process watcher, which both build their own paths independently.
  process.env.ASL_CONFIG = CONFIG_PATH;
  process.env.ASL_ERROR_LOG = ERROR_LOG_PATH;
}

/** Appends a line to error.log (best-effort, never throws). */
// error.log rotation. The renderer's console is mirrored here (every drag
// frame can log), so without a cap this file grows without bound on a customer
// machine — months later the overlay is "slow again" and the cause is a 2GB
// log file. Cap at 1MB, keeping the tail (most recent context) when rotating.
// Checked every 100 writes to amortize the statSync cost.
const ERROR_LOG_MAX_BYTES = 1024 * 1024;
let logWriteCount = 0;

function logError(message) {
  try {
    const p = ERROR_LOG_PATH || FALLBACK_ERROR_LOG;
    logWriteCount += 1;
    if (logWriteCount % 100 === 0 && fs.existsSync(p) && fs.statSync(p).size > ERROR_LOG_MAX_BYTES) {
      const tail = fs.readFileSync(p).subarray(-512 * 1024);
      fs.writeFileSync(p, tail);
    }
    fs.appendFileSync(p, `${new Date().toISOString()} ${message}\n`);
  } catch { /* ignore */ }
}

// Last-resort crash logging: keep the overlay alive and record the error
// instead of dying silently (field diagnosis for a desktop widget).
process.on('uncaughtException', (err) => {
  logError(`uncaughtException: ${err && err.stack}`);
  console.error('[status-light] uncaughtException:', err);
});

// ---------------------------------------------------------------------------
// Event-loop watchdog
// ---------------------------------------------------------------------------
// QA observed intermittent, unrecoverable main-process freezes (HTTP silent,
// message pump stopped, no crash log). A watchdog cannot prevent a freeze,
// but it detects recovery gaps: if the 5s tick ever fires >15s late, the
// loop was frozen and we record the duration for diagnosis.

const WATCHDOG_INTERVAL_MS = 5_000;
const WATCHDOG_FREEZE_THRESHOLD_MS = 15_000;
let lastWatchdogTick = 0;

function startWatchdog() {
  lastWatchdogTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastWatchdogTick;
    lastWatchdogTick = now;
    if (gap > WATCHDOG_FREEZE_THRESHOLD_MS) {
      logError(`watchdog: event loop was frozen for ~${Math.round(gap / 1000)}s`);
    }
  }, WATCHDOG_INTERVAL_MS);
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let tooltipWindow = null;
/** @type {Map<string, {id: string, name: string, status: string, task: string, lastHeartbeat: number}>} */
const agents = new Map();
let windowPosition = { x: null, y: null };
let saveTimer = null;

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

// Persisted user settings (rendered settings panel toggles these).
// soundVolume: 提示音音量档位 low/medium/high（v1.4.0，默认 high）
// repeatAlert: 紫灯(assist)/红灯(stuck) 每 30s 重复提醒直到 ack/解除（v1.4.0，默认开）
// language: 界面语言 auto/zh-CN/en-US（v1.5.0，默认 auto=跟随系统 locale）
// showStatusText: 灯下状态文字（v1.6.3，老吴需求，默认开——不悬停扫一眼可见）
// displayMode: 显示模式 classic/compact/mini（v1.7.0，缺省 classic，非法兜底 classic）
// autoCollapse: 全绿 60s 自动收迷你（v1.7.0，缺省关；出现 stuck/assist 立即展开）
let settings = { soundOn: true, soundVolume: 'high', repeatAlert: true, showStatusText: true, displayMode: 'classic', autoCollapse: false, language: 'auto' };

/**
 * 生成每台机器唯一的 MQTT 主题前缀（v1.5.0 脱敏）：asl/ + 12 位随机 hex。
 * 主题名即凭据，随机化后二进制/源码里不再含任何可关联到特定用户的固定主题。
 */
function generateMqttTopic() {
  return `asl/${crypto.randomBytes(6).toString('hex')}`;
}

/** 主题前缀合法性：asl/ 前缀 + 1-48 位小写字母数字-_（兼容手工编辑过的配置）。 */
function isValidMqttTopic(v) {
  return typeof v === 'string' && /^asl\/[a-z0-9_-]{1,48}$/i.test(v);
}

/**
 * 当前生效的界面语言（已解析）：settings.language 为 auto 时跟随系统 locale。
 */
function currentLanguage() {
  let locale = 'zh-CN';
  try {
    locale = app.getLocale();
  } catch { /* app 未 ready 的极端早期调用 */ }
  return i18n.resolveLanguage(settings.language, locale);
}

/**
 * 语言变更广播：右键菜单重建（下次弹出生效）+ 灯条渲染层即时切换。
 * tooltip 小窗语言随下一次 tooltip:show 的载荷走，无需单独通知。
 */
function notifyLanguageChanged() {
  contextMenu = null; // showContextMenu 每次按当前语言重建
  const lang = currentLanguage();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('language:change', lang);
  }
}

// Desktop process watchers (see main/agent-watcher.js): GUI apps like
// Doubao/Marvis cannot report their own status, so the in-process watcher
// polls the Windows process table and reports idle/offline on their behalf.
let watchersConfig = [];

// Set when config.json exists but fails to parse. While true, we refuse to
// write config back — a corrupted file must never be silently overwritten by
// an empty/default one (that would permanently destroy the user's agent list).
let configLoadFailed = false;

// config.json 顶层的「非结构化」键（cloudRelay / screenWatch / fgWatch /
// dbPoll / openAtLogin，以及未来新增的任何开关）。加载时原样提取、写回时
// 原样合并 —— 此前 writeConfigNow 只写四个结构化键，每次拖动窗口触发的
// 落盘都会把顶层开关悄悄冲掉（用户关掉云端中转，拖一下灯条它又活了）。
let configExtra = {};

// 画面活动通道（agent-watcher 通道 E）的出厂窗口标题关键词。
// 老用户的 config.json 里没有 window 字段 —— 加载时自动补齐，
// 绝不要求删配置重置（那会把用户的灯源/窗口位置一起冲掉）。
const DEFAULT_WATCHER_WINDOWS = {
  doubao: ['豆包', 'Doubao'],
  mavis: ['Marvis', '马维斯'],
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    configExtra = settingsOps.extractConfigExtras(raw);
    const list = Array.isArray(raw.agents) ? raw.agents : [];
    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string') continue;
      agents.set(entry.id, {
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
        status: 'offline',
        task: '',
        lastHeartbeat: 0,
        // v1.4.1：自动发现标记随配置落盘（设置面板删除豁免判定要用）
        ...(entry.origin === 'auto' ? { origin: 'auto' } : {}),
        ...(Number.isFinite(entry.discoveredAt) ? { discoveredAt: entry.discoveredAt } : {}),
      });
    }
    if (raw.settings && typeof raw.settings.soundOn === 'boolean') {
      settings.soundOn = raw.settings.soundOn;
    }
    // v1.4.0 新增声音设置：音量档位 + 紫/红灯重复提醒开关（缺省 高/开）
    if (raw.settings && typeof raw.settings.soundVolume === 'string' &&
        ['low', 'medium', 'high'].includes(raw.settings.soundVolume)) {
      settings.soundVolume = raw.settings.soundVolume;
    }
    if (raw.settings && typeof raw.settings.repeatAlert === 'boolean') {
      settings.repeatAlert = raw.settings.repeatAlert;
    }
    // v1.6.3 灯下状态文字开关（缺省 true = 显示；老配置无此键行为不变）
    if (raw.settings && typeof raw.settings.showStatusText === 'boolean') {
      settings.showStatusText = raw.settings.showStatusText;
    }
    // v1.7.0 显示模式三档（classic/compact/mini；缺省 classic，非法值兜底 classic）
    if (raw.settings && typeof raw.settings.displayMode === 'string') {
      settings.displayMode = settingsOps.normalizeDisplayMode(raw.settings.displayMode) || 'classic';
    }
    // v1.7.0 自动收起开关（缺省 false；老配置无此键行为不变）
    if (raw.settings && typeof raw.settings.autoCollapse === 'boolean') {
      settings.autoCollapse = raw.settings.autoCollapse;
    }
    // v1.5.0 界面语言（auto/zh-CN/en-US；非法值按 auto 跟随系统）
    if (raw.settings && typeof raw.settings.language === 'string') {
      settings.language = settingsOps.normalizeLanguage(raw.settings.language) || 'auto';
    }
    // 云端中转桥总开关。v1.5.0 脱敏：出厂（种子配置）显式 false，全新安装
    // 默认不连公共 broker。但【老配置没有 cloudRelay 键】时旧版本的隐含默认
    // 是开 —— 升级不能把在用的云链路静默掐掉，迁移为显式 true 并落盘一次
    //（用户随时可在设置面板关掉）。
    if (typeof raw.cloudRelay === 'boolean') {
      cloudRelayFlag = raw.cloudRelay;
    } else {
      cloudRelayFlag = true;
      configExtra.cloudRelay = true;
      saveConfig();
      logError('migrated legacy implicit cloudRelay default -> true (pre-v1.5.0 config)');
    }
    // v1.5.0 脱敏：老配置没有 mqttTopic（主题曾硬编码在二进制里）——
    // 升级后补一个随机主题并落盘，设置面板可查看/重新生成。
    if (!isValidMqttTopic(configExtra.mqttTopic)) {
      configExtra.mqttTopic = generateMqttTopic();
      saveConfig();
      logError('generated per-install random mqttTopic (v1.5.0)');
    }
    if (raw.window && Number.isFinite(raw.window.x) && Number.isFinite(raw.window.y)) {
      windowPosition = { x: raw.window.x, y: raw.window.y };
    }
    if (Array.isArray(raw.watchers)) {
      watchersConfig = raw.watchers
        .filter(
          (w) => w && typeof w.agent === 'string' && typeof w.process === 'string' && w.process
        )
        .map((w) => {
          // 老配置缺 window 字段时按 agent 补出厂关键词（画面通道需要）
          if (!Array.isArray(w.window) && DEFAULT_WATCHER_WINDOWS[w.agent]) {
            return { ...w, window: DEFAULT_WATCHER_WINDOWS[w.agent] };
          }
          return w;
        });
    }
  } catch (err) {
    // ENOENT = first run / clean machine: not a failure, just start empty.
    // Anything else (JSON corrupted, permission, etc.) = the file EXISTS but we
    // couldn't read it. Back it up before anything can overwrite it.
    if (err && err.code !== 'ENOENT') {
      configLoadFailed = true;
      try {
        if (CONFIG_PATH && fs.existsSync(CONFIG_PATH)) {
          fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
          logError(`config.json unreadable (${err.message}); backed up to config.json.bak and refusing to overwrite`);
        }
      } catch { /* ignore */ }
    }
    console.warn('[status-light] failed to load config.json, starting empty:', err.message);
  }
}

/** Writes config to disk immediately (synchronous). Refuses when configLoadFailed. */
function writeConfigNow() {
  if (configLoadFailed) return; // never clobber a corrupted config with an empty one
  const payload = settingsOps.buildConfigPayload({
    extras: configExtra,
    // origin/discoveredAt 随盘持久化：重启后设置面板的删除豁免判定仍成立
    agents: Array.from(agents.values()).map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.origin ? { origin: a.origin } : {}),
      ...(Number.isFinite(a.discoveredAt) ? { discoveredAt: a.discoveredAt } : {}),
    })),
    settings,
    window: windowPosition,
    watchers: watchersConfig,
  });
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[status-light] failed to save config.json:', err.message);
  }
}

function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeConfigNow, 300);
}

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

/**
 * Computes the effective status of an agent, applying heartbeat timeouts.
 * "stuck" and "assist" are sticky: they only clear when the agent reports a
 * new status or the human acknowledges (agents:ack).
 * "idle" is also stable now: hook-based reporters (WorkBuddy) only fire on
 * events, so a quiet 5-minute wait used to wrongly decay idle -> offline
 * (user saw "离线" while the client was simply waiting for the next prompt).
 * Only "running" decays (60s -> idle); "offline" appears only on an explicit
 * offline report, a missing heartbeat, or a watcher seeing the process gone.
 */
function effectiveStatus(agent, now) {
  if (agent.status === 'stuck') return 'stuck';
  if (agent.status === 'assist') return 'assist';
  if (agent.status === 'offline') return 'offline';
  if (!agent.lastHeartbeat) return 'offline';
  const age = now - agent.lastHeartbeat;
  if (agent.status === 'running' && age > HEARTBEAT_IDLE_MS) return 'idle';
  return agent.status;
}

function serializeAgents() {
  const now = Date.now();
  // 对话列表（v1.4.0）：agent-watcher 按窗口跟踪的 {title, active} 数组，
  // /api/state、渲染层详情面板、MQTT 快照共用这一份。
  const dialogsMap = agentWatcher.getDialogs ? agentWatcher.getDialogs() : {};
  return Array.from(agents.values()).map((a) => {
    const status = effectiveStatus(a, now);
    // 纯提示字段：idle 且心跳超过 5 分钟时让 tooltip 显示「长时间未更新」。
    // 只加提示，不改 status、不触发任何降级（避免误伤稀疏上报的 AI）。
    const stale =
      status === 'idle' && a.lastHeartbeat > 0 && now - a.lastHeartbeat > STALE_IDLE_MS;
    return {
      id: a.id,
      name: a.name,
      status,
      auto: status !== a.status,
      task: a.task,
      lastHeartbeat: a.lastHeartbeat,
      dialogs: dialogsMap[a.id] || [],
      ...(stale ? { stale: true } : {}),
    };
  });
}

function broadcastState() {
  const snapshot = serializeAgents();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:update', snapshot);
  }
  // 手机端地基：灯态变化同步上云（STATE_TOPIC，retain）。
  // broadcastState 是所有状态变化的唯一收口（applyReport / ack / 增删 agent /
  // 心跳降级的 5s tick 都走这里），mqtt-bridge 内部做 JSON 去重 + 500ms 节流，
  // 灯没变一条都不发，cloudRelay 关闭时一并停发。
  if (cloudBridge) cloudBridge.publishState(snapshot);
  // v1.7.0 自动收起判定（autoCollapse 关闭时为空操作）。挂在唯一收口上，
  // 5s tick 兜底「最后一次上报早已全绿」的静默场景。
  try {
    maybeAutoCollapse(snapshot);
  } catch (err) {
    logError(`maybeAutoCollapse failed: ${err && err.message}`);
  }
}

// ---------------------------------------------------------------------------
// v1.7.0 显示模式与自动收起
// ---------------------------------------------------------------------------
// displayMode 三档（classic/compact/mini）的窗口尺寸换算与切换落点收在这里；
// 自动收起是主进程职责（状态机/心跳都在主进程），渲染层只负责按
// displayMode:change 广播重排 DOM。maybeAutoCollapse 挂在 broadcastState
// 上 —— 它是所有状态变化的唯一收口（上报/ack/增删/5s tick 都走这里），
// 「出现 stuck/assist 立即展开」和「全绿满 60s 收起」都在这里判定。

/** v1.7.0 自动收起的运行时标记：全绿起始时刻 / mini 是否自动收起进入的 / 收起前模式。 */
let allClearSince = 0;
let autoCollapsed = false;
let autoCollapsePrevMode = 'classic';

/** 重置自动收起计时（autoCollapse 开关切换 / 用户手动切模式时调用，重新给 60s 观察期）。 */
function resetAutoCollapseTimer() {
  allClearSince = 0;
  autoCollapsed = false;
}

/** 当前显示模式（已规范化，绝不出非法值）。 */
function currentDisplayMode() {
  return settingsOps.normalizeDisplayMode(settings.displayMode) || 'classic';
}

/** 三档模式的窗口基准尺寸：mini=40×40，compact=灯条全宽×56，classic=灯条全宽×72。 */
function baseWindowSizeForMode(mode) {
  if (mode === 'mini') {
    return { width: miniMode.MINI_WINDOW, height: miniMode.MINI_WINDOW };
  }
  if (mode === 'compact') {
    return { width: computeWidth(), height: ROW_HEIGHT_COMPACT };
  }
  return { width: computeWidth(), height: ROW_HEIGHT };
}

/** 迷你模式下灯条是否收起为一盏聚合小灯。 */
function isMiniMode() {
  return currentDisplayMode() === 'mini';
}

/**
 * 应用当前 displayMode 的窗口尺寸：保持右上角锚点（右缘/上缘不动），
 * 再按工作区吸附兜底（迷你灯绝不落半屏外）；切换后广播渲染层重排。
 * 拖动进行中时 setMainWindowBounds 自带守卫（只移位不改尺寸），不会
 * 把用户手上的窗口抢走 —— 面板/设置窗口路径同样安全。
 */
function applyDisplayModeSize() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [curX, curY] = mainWindow.getPosition();
  const [curWidth] = mainWindow.getSize();
  const { width, height } = baseWindowSizeForMode(currentDisplayMode());
  const snapped = snapToWorkAreaEdges(curX + curWidth - width, curY, width, height);
  setMainWindowBounds({ x: snapped.x, y: snapped.y, width, height });
  windowPosition = { x: snapped.x, y: snapped.y };
  mainWindow.webContents.send('displayMode:change', currentDisplayMode());
  saveConfig();
}

/**
 * 自动收起判定（settings.autoCollapse 开启时生效）：
 *   - 任一 stuck/assist：清计时；若 mini 是「自动收起」进入的，立即恢复收起前模式。
 *     （用户手动切的 mini 不打扰 —— 那是他自己的选择，点小灯自己展开。）
 *   - 全绿：从首个全绿时刻起计满 AUTO_COLLAPSE_DELAY_MS 后切 mini，
 *     记住收起前模式（classic/compact）供恢复。
 * @param {Array<{status: string}>} snapshot serializeAgents() 的快照
 */
function maybeAutoCollapse(snapshot) {
  if (!settings.autoCollapse) {
    resetAutoCollapseTimer();
    return;
  }
  const attention = Array.isArray(snapshot)
    && snapshot.some((a) => a && (a.status === 'stuck' || a.status === 'assist'));
  const now = Date.now();
  if (attention) {
    allClearSince = 0;
    if (autoCollapsed && settings.displayMode === 'mini') {
      settings.displayMode = settingsOps.normalizeDisplayMode(autoCollapsePrevMode) || 'classic';
      autoCollapsed = false;
      applyDisplayModeSize();
      logError(`auto-collapse: attention detected, restored to ${settings.displayMode}`);
    }
    return;
  }
  if (!allClearSince) allClearSince = now;
  if (settings.displayMode !== 'mini' && now - allClearSince >= AUTO_COLLAPSE_DELAY_MS) {
    autoCollapsePrevMode = currentDisplayMode() === 'compact' ? 'compact' : 'classic';
    autoCollapsed = true;
    settings.displayMode = 'mini';
    applyDisplayModeSize();
    logError(`auto-collapse: all clear ${Math.round(AUTO_COLLAPSE_DELAY_MS / 1000)}s, collapsed to mini (prev=${autoCollapsePrevMode})`);
  }
}

// Hard cap on tracked agents. The HTTP server is reachable from any local
// process; without a cap a malicious or buggy client could upsert thousands of
// agents and blow up the window width, the state Map, and config.json.
const MAX_AGENTS = 32;

function upsertAgent(id, name) {
  const existing = agents.get(id);
  if (existing) {
    if (name && name !== existing.name) {
      existing.name = name;
      saveConfig();
    }
    return existing;
  }
  if (agents.size >= MAX_AGENTS) {
    logError(`upsertAgent rejected: agent cap ${MAX_AGENTS} reached (id=${id})`);
    return null;
  }
  const created = { id, name: name || id, status: 'offline', task: '', lastHeartbeat: 0 };
  agents.set(id, created);
  saveConfig();
  resizeWindowToAgents();
  return created;
}

function removeAgent(id) {
  if (agents.delete(id)) {
    setWatcher(id, ''); // drop its process watcher too, if any
    saveConfig();
    resizeWindowToAgents();
    broadcastState();
    return true;
  }
  return false;
}

/**
 * Adds / replaces / removes the process watcher entry for an agent.
 * Empty processName removes the watcher. The in-process agent-watcher re-reads
 * config.json on every poll round, so changes take effect within ~5s with
 * no restart. The settings panel manages watchers visually (user self-service).
 */
function setWatcher(agentId, processName) {
  const proc = (processName || '').trim();
  const others = watchersConfig.filter((w) => w.agent !== agentId);
  if (proc) {
    const prev = watchersConfig.find((w) => w.agent === agentId);
    others.push({ agent: agentId, process: proc, task: (prev && prev.task) || '桌面端在线' });
  }
  watchersConfig = others;
  saveConfig();
}

function applyReport(body) {
  if (!body || typeof body.agent !== 'string' || !body.agent.trim()) {
    return { ok: false, error: 'missing "agent" field' };
  }
  const id = body.agent.trim();
  if (!AGENT_ID_PATTERN.test(id)) {
    return { ok: false, error: `invalid agent id "${id}" (1-24 chars: a-z 0-9 _ -)` };
  }
  const status = typeof body.status === 'string' ? body.status.toLowerCase() : '';
  if (!VALID_STATUSES.has(status)) {
    return { ok: false, error: `invalid status "${body.status}" (running|idle|stuck|assist|offline)` };
  }
  const agent = upsertAgent(id, typeof body.name === 'string' ? body.name : undefined);
  if (!agent) {
    return { ok: false, error: `agent cap ${MAX_AGENTS} reached` };
  }
  // Sticky statuses: assist(紫)/stuck(红) 只能被「新的 assist/stuck 上报」、
  // 「人工 ack」或「带 force 的上报」（= 用户本人回来打字了）解除。
  // 否则 agent-watcher 每 2 秒一次的 running 轮询会把紫灯瞬间冲掉。
  const sticky = agent.status === 'assist' || agent.status === 'stuck';
  if (sticky && !body.force && (status === 'running' || status === 'idle')) {
    agent.lastHeartbeat = Date.now(); // 顺手续命，但不改状态和任务文案
    broadcastState();
    return { ok: true, sticky: true, agent: serializeAgents().find((a) => a.id === id) };
  }
  const prevStatus = agent.status;
  agent.status = status;
  if (typeof body.task === 'string') agent.task = body.task.slice(0, 500);
  // An explicit "offline" clears the heartbeat so timeouts don't resurrect it.
  agent.lastHeartbeat = status === 'offline' ? 0 : Date.now();
  // v1.5.1 webhook 电话告警：assist/stuck 边沿触发（applyReport 是状态落入
  // 紫/红的唯一路径——watcher/心跳只会写 idle/offline，ack 只会解除）。
  // fire-and-forget，失败只记日志，绝不影响状态机。
  try {
    alertWebhook.maybeAlert(
      id, prevStatus, agent.status, agent.task, configExtra.alertWebhook, agent.name
    );
  } catch (err) {
    logError(`alert webhook dispatch failed: ${err && err.message}`);
  }
  broadcastState();
  return { ok: true, agent: serializeAgents().find((a) => a.id === id) };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function computeWidth() {
  const count = Math.max(agents.size, 1);
  // v1.7.0 rev2：右端两颗图标按钮（⚙ 齿轮 + ◐ 模式循环，老吴拍板保留）；
  // 设置窗口顶部冻结栏的「显示模式」下拉为第二入口。
  return SIDE_PADDING * 2 + count * LIGHT_WIDTH + SETTINGS_WIDTH * 2;
}

function resizeWindowToAgents() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const [currentWidth, currentHeight] = mainWindow.getSize();
    // v1.7.0：mini 模式下窗口恒为 40×40 聚合小灯，与 agent 数量无关；
    // classic/compact 高度仍由渲染层 ResizeObserver → setHeight 管理。
    const target = baseWindowSizeForMode(currentDisplayMode());
    if (target.width !== currentWidth || (isMiniMode() && target.height !== currentHeight)) {
      setMainWindowBounds({ width: target.width, height: isMiniMode() ? target.height : currentHeight });
    }
  }
}

/**
 * Sets the main window bounds reliably. Windows ignores programmatic
 * shrink (setSize/setBounds with a smaller size) on non-resizable windows,
 * so resizability is temporarily enabled for the operation.
 *
 * While a drag is in progress we refuse to change the width: a width
 * change goes through setResizable(true), and that gives Windows DWM a
 * window of opportunity to drag-resize the edge of the strip while the
 * user's mouse is held down — which is the root cause of "horizontal drag
 * stretches the window". Same applies to height when the strip is mid-drag
 * to keep the strip's pinned size absolutely stable.
 */
function setMainWindowBounds({ x, y, width, height }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [currentX, currentY] = mainWindow.getPosition();
  const [currentWidth, currentHeight] = mainWindow.getSize();
  const bounds = {
    x: x ?? currentX,
    y: y ?? currentY,
    width: width ?? currentWidth,
    height: height ?? currentHeight,
  };
  if (
    bounds.x === currentX &&
    bounds.y === currentY &&
    bounds.width === currentWidth &&
    bounds.height === currentHeight
  ) {
    return;
  }
  if (dragContext) {
    // Strict no-resize mode: only position is allowed to move, size stays
    // pinned at dragStart's baseWidth/baseHeight so the user can never end
    // up dragging an OS resize into the strip.
    mainWindow.setPosition(bounds.x, bounds.y);
    return;
  }
  mainWindow.setResizable(true);
  mainWindow.setBounds(bounds);
  mainWindow.setResizable(false);
}

/**
 * True when the whole window rect actually lands inside some display's work
 * area. Guarding the full rect (not just the top-left corner) matters: the
 * strip remembers its position in config.json, and when a monitor is unplugged
 * (e.g. saved x=3055 on a since-removed third screen) a corner-only check can
 * still pass while the strip is effectively unreachable.
 *
 * Note this uses workArea, not bounds, so the strip never gets restored onto
 * the taskbar.
 */
function isPositionVisible(x, y, width = 0, height = 0) {
  return screen.getAllDisplays().some((d) => {
    const { x: dx, y: dy, width: dw, height: dh } = d.workArea;
    return (
      x >= dx - 10 &&
      y >= dy - 10 &&
      x + width < dx + dw &&
      y + height < dy + dh
    );
  });
}

/**
 * Safe landing spot for the strip: top-right corner of the primary display's
 * work area, inset by a margin. Used when the remembered position is no longer
 * reachable (monitor unplugged, resolution changed, moved to another machine) —
 * without this the overlay would open off-screen and look like it vanished.
 */
function safeFallbackPosition(width) {
  const wa = screen.getPrimaryDisplay().workArea;
  const margin = 12;
  return {
    x: Math.round(Math.max(wa.x + margin, wa.x + wa.width - width - margin)),
    y: Math.round(wa.y + margin),
  };
}

function createWindow() {
  // Idempotent guard: both app.whenReady() and the second-instance handler call
  // this. With auto-start enabled, the user double-clicking the icon during
  // startup would otherwise create TWO windows (one here, one when whenReady
  // fires) and leak the first. If a live window already exists, just surface it.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.show();
      mainWindow.focus();
    } catch { /* ignore */ }
    return;
  }
  // v1.7.0：三档模式的启动尺寸。mini 启动 = 40×40 聚合小灯；
  // classic = 灯条全宽×72；compact = 灯条全宽×56。
  const mode = currentDisplayMode();
  const { width: modeWidth, height: modeHeight } = baseWindowSizeForMode(mode);
  const width = modeWidth;
  const savedX = windowPosition.x;
  const savedY = windowPosition.y;
  const hasSaved = savedX !== null && savedY !== null;
  let useSavedPosition = hasSaved && isPositionVisible(savedX, savedY, width, modeHeight);

  if (hasSaved && !useSavedPosition) {
    // Remembered position is off-screen (monitor unplugged / resolution changed
    // / config copied from another machine). Reset to a guaranteed-visible spot
    // and persist it, so the overlay is always findable on next launch too.
    windowPosition = safeFallbackPosition(width);
    saveConfig();
    logError(
      `saved window position (${savedX},${savedY}) is off-screen; reset to (${windowPosition.x},${windowPosition.y})`
    );
    useSavedPosition = true;
  }

  const iconPath = path.join(__dirname, '..', 'assets', 'status-light.ico');
  mainWindow = new BrowserWindow({
    width,
    height: modeHeight,
    ...(useSavedPosition ? { x: windowPosition.x, y: windowPosition.y } : {}),
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#111827',
    title: i18n.t(currentLanguage(), 'title.main', { version: APP_VERSION }),
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Never throttle this widget's timers/rAF when occluded or unfocused —
      // it spends most of its life idle in a corner and must stay live.
      backgroundThrottling: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setMenu(null);

  // Some Win11 frameless+alwaysOnTop combos default to a hidden window even
  // when show:true. Force-show + restore so the overlay is visible from t=0.
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();

  mainWindow.on('unresponsive', () => logError('main window became unresponsive'));
  mainWindow.on('responsive', () => logError('main window responsive again'));
  // Make a dead window traceable in error.log. Without this, the window can
  // be destroyed silently (renderer/GPU children vanish, main process lives
  // on answering /ping), leaving no trace of when/why it died.
  mainWindow.on('closed', () => logError('main window closed'));

  mainWindow.on('moved', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [x, y] = mainWindow.getPosition();
    windowPosition = { x, y };
    saveConfig();
  });

  const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
  if (!process.env.ASL_DEV && fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }
  // Pipe renderer console output to error.log so the operator can see React
  // pointerdown/click traces without having to open DevTools.
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    logError(`[renderer console:${level}] ${message}`);
  });
}

// ---------------------------------------------------------------------------
// HTTP status service
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  // Deliberately NO Access-Control-Allow-Origin header. This server is bound to
  // 127.0.0.1 and consumed by our own main process / supervisor / local watcher
  // — none of which enforce CORS. A wildcard origin would let ANY web page the
  // front-desk staff happens to browse call POST /status or DELETE /agents/:id
  // from JavaScript. Omitting the header makes browsers block cross-origin reads
  // and writes, while leaving non-browser local clients fully functional.
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(body);
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HTTP_HOST}:${HTTP_PORT}`);

    // /debug/* endpoints (expandPanel, dragStart, forceShow, setWatcher, …) are
    // a development backdoor: any local process can move the window and rewrite
    // config through them. Ship-build must not expose them — return 404 so a
    // customer machine has no such attack surface. Dev mode keeps them.
    if (app.isPackaged && url.pathname.startsWith('/debug/')) {
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }

    if (req.method === 'OPTIONS') {
      return sendJson(res, 204, {});
    }

    try {
      if (req.method === 'GET' && url.pathname === '/ping') {
        // Lightweight liveness probe used by the keepalive child process.
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/status') {
        const body = await readJsonBody(req);
        const result = applyReport(body);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'GET' && (url.pathname === '/agents' || url.pathname === '/api/state')) {
        return sendJson(res, 200, { ok: true, agents: serializeAgents() });
      }
      if (req.method === 'POST' && url.pathname === '/agents') {
        const body = await readJsonBody(req);
        if (!body || typeof body.id !== 'string' || !AGENT_ID_PATTERN.test(body.id.trim())) {
          return sendJson(res, 400, { ok: false, error: 'missing or invalid "id"' });
        }
        upsertAgent(body.id.trim(), typeof body.name === 'string' ? body.name : undefined);
        broadcastState();
        return sendJson(res, 200, { ok: true });
      }
      const deleteMatch = url.pathname.match(/^\/agents\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'DELETE' && deleteMatch) {
        const removed = removeAgent(deleteMatch[1]);
        return sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: 'agent not found' });
      }
      // HTTP mirror of the IPC "agents:ack": acknowledge an assist alert.
      const ackMatch = url.pathname.match(/^\/agents\/([A-Za-z0-9_-]+)\/ack$/);
      if (req.method === 'POST' && ackMatch) {
        const agent = agents.get(ackMatch[1]);
        if (!agent) return sendJson(res, 404, { ok: false, error: 'agent not found' });
        agent.status = 'idle';
        agent.lastHeartbeat = Date.now();
        broadcastState();
        return sendJson(res, 200, { ok: true, agent: serializeAgents().find((a) => a.id === ackMatch[1]) });
      }
      if (req.method === 'GET' && url.pathname === '/window') {
        // Debug endpoint: reports the overlay window's current bounds.
        if (!mainWindow || mainWindow.isDestroyed()) {
          return sendJson(res, 200, { ok: true, bounds: null });
        }
        const [width, height] = mainWindow.getSize();
        const [x, y] = mainWindow.getPosition();
        return sendJson(res, 200, { ok: true, bounds: { x, y, width, height } });
      }
      // Debug-only: tell the renderer to force-open a panel so tests can
      // verify the drag-while-panel-open path without having to issue a
      // real mouse click (which the sandbox sometimes races against Electron
      // pointer capture). Removed in production builds is not necessary —
      // the endpoint only opens a panel that the user can also open normally.
      if (req.method === 'POST' && url.pathname === '/debug/expandPanel') {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return sendJson(res, 400, { ok: false, error: 'no window' });
        }
        const id = url.searchParams.get('id') || '';
        if (!AGENT_ID_PATTERN.test(id)) {
          return sendJson(res, 400, { ok: false, error: 'invalid id' });
        }
        mainWindow.webContents.send('debug:expandPanel', { id });
        return sendJson(res, 200, { ok: true, id });
      }
      if (req.method === 'POST' && url.pathname === '/debug/collapsePanel') {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return sendJson(res, 400, { ok: false, error: 'no window' });
        }
        mainWindow.webContents.send('debug:collapsePanel');
        return sendJson(res, 200, { ok: true });
      }
      // Debug-only: simulate dragStart at the current cursor position. Used
      // by tests to verify the "collapse panel on drag" path without having
      // to race pyautogui against Electron's pointer event system.
      if (req.method === 'POST' && url.pathname === '/debug/dragStart') {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return sendJson(res, 400, { ok: false, error: 'no window' });
        }
        const cur = screen.getCursorScreenPoint();
        const [width, height] = mainWindow.getSize();
        const [x, y] = mainWindow.getPosition();
        logError(`[debug-dragStart] cur=${JSON.stringify(cur)} win=${width}x${height}`);
        let baseWidth = width;
        let baseHeight = height;
        // v1.7.0：面板收起基准高按当前模式取（mini=40 / compact=56 / classic=72）。
        const debugBaseTargetHeight = baseWindowSizeForMode(currentDisplayMode()).height;
        if (height > debugBaseTargetHeight + 4) {
          baseHeight = debugBaseTargetHeight;
          setMainWindowBounds({ x, y, height: baseHeight });
          logError(`[debug-dragStart] collapsed panel: set height=${baseHeight}`);
          mainWindow.webContents.send('window:collapsePanels');
        }
        dragContext = {
          startX: x,
          startY: y,
          cursorX: cur.x,
          cursorY: cur.y,
          baseWidth,
          baseHeight,
        };
        return sendJson(res, 200, { ok: true, baseWidth, baseHeight });
      }
      if (req.method === 'POST' && url.pathname === '/debug/dragMove') {
        if (!dragContext || !mainWindow || mainWindow.isDestroyed()) {
          return sendJson(res, 400, { ok: false, error: 'no drag in progress' });
        }
        const cur = screen.getCursorScreenPoint();
        // Use the cached baseWidth, NOT getSize(), to avoid the same
        // in-flight OS resize poisoning that bit the IPC handler.
        mainWindow.setBounds({
          x: dragContext.startX + Math.round(cur.x - dragContext.cursorX),
          y: dragContext.startY + Math.round(cur.y - dragContext.cursorY),
          width: dragContext.baseWidth,
          height: dragContext.baseHeight,
        });
        return sendJson(res, 200, { ok: true, baseWidth: dragContext.baseWidth, baseHeight: dragContext.baseHeight });
      }
      if (req.method === 'POST' && url.pathname === '/debug/dragEnd') {
        if (!dragContext || !mainWindow || mainWindow.isDestroyed()) {
          return sendJson(res, 400, { ok: false, error: 'no drag in progress' });
        }
        const [curX, curY] = mainWindow.getPosition();
        const snapped = snapToWorkAreaEdges(curX, curY, dragContext.baseWidth, dragContext.baseHeight);
        mainWindow.setBounds({
          x: snapped.x,
          y: snapped.y,
          width: dragContext.baseWidth,
          height: dragContext.baseHeight,
        });
        windowPosition = { x: snapped.x, y: snapped.y };
        saveConfig();
        dragContext = null;
        return sendJson(res, 200, { ok: true });
      }
      // Debug: synthetically click the gear button from inside the renderer
      // (bypasses OS pointer events so we can confirm the panel toggle wiring
      // is correct even when Windows DWM eats real clicks).
      if (req.method === 'POST' && url.pathname === '/debug/clickGear') {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return sendJson(res, 400, { ok: false, error: 'no window' });
        }
        const code = `
          (function(){
            const btn = document.querySelector('button[aria-label="设置"]');
            console.log('clickGear: found=' + !!btn + ' rect=' + (btn ? JSON.stringify(btn.getBoundingClientRect()) : 'n/a'));
            if (btn) btn.click();
            return btn ? 'clicked' : 'not-found';
          })();
        `;
        mainWindow.webContents
          .executeJavaScript(code, true)
          .then((result) => sendJson(res, 200, { ok: true, result }))
          .catch((err) => sendJson(res, 500, { ok: false, error: String(err) }));
        return;
      }
      // Debug: hot-set/remove a process watcher for an agent. Localhost only,
      // used by automated tests to verify the settings panel's self-service
      // IPC end-to-end without needing a renderer-driven click.
      if (req.method === 'POST' && url.pathname === '/debug/setWatcher') {
        try {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
              if (typeof body.agent !== 'string' || !body.agent.trim()) {
                return sendJson(res, 400, { ok: false, error: 'missing agent' });
              }
              setWatcher(body.agent.trim(), typeof body.process === 'string' ? body.process : '');
              return sendJson(res, 200, { ok: true, watchers: watchersConfig });
            } catch (e) {
              return sendJson(res, 400, { ok: false, error: 'bad json: ' + e.message });
            }
          });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return sendJson(res, 200, {
          ok: true,
          service: 'ai-status-light',
          usage: 'POST /status {"agent":"kimi","status":"running|idle|stuck|assist|offline","task":"..."}',
        });
      }
      // Debug: force-show the overlay window + reload renderer. Useful when a
      // stale instance from sandbox tests is sitting around without a visible
      // surface — the user perceives "the click did nothing".
      if (req.method === 'POST' && url.pathname === '/debug/forceShow') {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return sendJson(res, 400, { ok: false, error: 'no window' });
        }
        try {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.setOpacity(1);
          mainWindow.show();
          mainWindow.focus();
          mainWindow.moveTop();
          const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
          if (!process.env.ASL_DEV && fs.existsSync(distIndex)) {
            mainWindow.loadFile(distIndex);
          }
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e.message });
        }
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  // EADDRINUSE is expected when a previous instance is still shutting down
  // (or a half-dead one is squatting on the port). It must never take the
  // process down: the overlay stays usable, and the agent-watcher keeps
  // running so the lights stay alive even if the other instance is a zombie.
  let portBusyReported = false;
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      if (!portBusyReported) {
        portBusyReported = true;
        const msg =
          `[status-light] port ${HTTP_PORT} is already in use — another AI Status Light ` +
          `instance is probably still running (or did not exit cleanly). ` +
          `This instance will keep its window and watcher, but its HTTP status ` +
          `service is disabled; reports are going to the instance holding the port.`;
        console.error(msg);
        logError(`EADDRINUSE on ${HTTP_HOST}:${HTTP_PORT}`);
      }
      return;
    }
    console.error(`[status-light] HTTP server error on port ${HTTP_PORT}:`, err && err.message);
    logError(`HTTP server error: ${err && err.message}`);
  });

  server.listen(HTTP_PORT, HTTP_HOST, () => {
    console.log(`[status-light] HTTP status service listening on http://${HTTP_HOST}:${HTTP_PORT}`);
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('state:get', () => serializeAgents());

ipcMain.handle('agents:add', (_event, payload) => {
  if (!payload || typeof payload.id !== 'string' || !AGENT_ID_PATTERN.test(payload.id.trim())) {
    return { ok: false, error: 'invalid id (1-24 chars: a-z 0-9 _ -)' };
  }
  upsertAgent(payload.id.trim(), typeof payload.name === 'string' ? payload.name : undefined);
  // Optional "process": create/update the desktop process watcher for this agent.
  if (payload.process !== undefined && payload.process !== null) {
    setWatcher(payload.id.trim(), String(payload.process));
  }
  broadcastState();
  return { ok: true };
});

/** Returns the current process watchers so the settings panel can show/edit them. */
ipcMain.handle('watchers:get', () => watchersConfig);

/** Sets (or removes, when process is empty) an agent's process watcher. */
ipcMain.handle('watchers:set', (_event, payload) => {
  if (!payload || typeof payload.agent !== 'string' || !payload.agent.trim()) {
    return { ok: false, error: 'missing agent' };
  }
  setWatcher(payload.agent.trim(), typeof payload.process === 'string' ? payload.process : '');
  return { ok: true, watchers: watchersConfig };
});

ipcMain.handle('agents:remove', (_event, id) => {
  const removed = removeAgent(id);
  if (removed) {
    // 手动删除 = 拉黑：自动发现不再加回（v1.4.0）
    blacklistAgent(id);
    saveConfig();
  }
  return { ok: removed };
});

/**
 * Human acknowledges an "assist" alert (purple blinking light): the agent is
 * reset to idle so the light stops flashing. Returns {ok}.
 */
ipcMain.handle('agents:ack', (_event, id) => {
  const agent = typeof id === 'string' ? agents.get(id) : null;
  if (!agent) return { ok: false, error: 'agent not found' };
  agent.status = 'idle';
  agent.lastHeartbeat = Date.now();
  broadcastState();
  return { ok: true };
});

// v1.5.0：附带已解析界面语言（resolvedLanguage），渲染层据此切换语言包
ipcMain.handle('settings:get', () => ({ ...settings, resolvedLanguage: currentLanguage() }));

ipcMain.handle('settings:set', (_event, payload) => {
  if (payload && typeof payload.soundOn === 'boolean') {
    settings.soundOn = payload.soundOn;
  }
  if (payload && typeof payload.soundVolume === 'string' &&
      ['low', 'medium', 'high'].includes(payload.soundVolume)) {
    settings.soundVolume = payload.soundVolume;
  }
  if (payload && typeof payload.repeatAlert === 'boolean') {
    settings.repeatAlert = payload.repeatAlert;
  }
  // v1.7.0 自动收起开关：切换时重置计时（重新给 60s 观察期）。
  if (payload && typeof payload.autoCollapse === 'boolean') {
    if (settings.autoCollapse !== payload.autoCollapse) resetAutoCollapseTimer();
    settings.autoCollapse = payload.autoCollapse;
  }
  // v1.7.0 显示模式（classic/compact/mini）：非法值忽略不切；合法且变化时
  // 换算窗口尺寸（右上角锚点+吸附）并广播渲染层。用户手动切模式 = 接管，
  // 自动收起的「恢复」标记清掉（mini 不再被误判为自动收起进入的）。
  if (payload && typeof payload.displayMode === 'string') {
    const mode = settingsOps.normalizeDisplayMode(payload.displayMode);
    if (mode && mode !== settings.displayMode) {
      settings.displayMode = mode;
      resetAutoCollapseTimer();
      applyDisplayModeSize();
    }
  }
  saveConfig();
  return { ok: true, settings };
});

ipcMain.on('window:setHeight', (_event, height) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const clamped = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, Math.round(height)));
  setMainWindowBounds({ height: clamped });
});

/**
 * Renderer asks for a specific width: e.g. 380 when a settings/detail panel
 * is open (the agent strip is only ~224px for few lights, which cramps the
 * panel text). Pass 0 to fall back to the agent-count-based default width.
 * v1.5.0: the applied width is max(strip full width, requested) — expanding
 * a panel NEVER shrinks the strip and cuts off lights on the right.
 * Subject to the same dragContext guard as setHeight so a live drag can't
 * be hijacked by a panel opening mid-drag.
 */
ipcMain.on('window:setWidth', (_event, width) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // v1.7.0：mini 模式下面板永不打开，任何宽度请求都按 mini 基准（40）兜底。
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) {
    resizeWindowToAgents();
    return;
  }
  if (isMiniMode()) {
    resizeWindowToAgents();
    return;
  }
  // v1.5.0 修复「打开详情面板裁灯」：面板请求宽（380）可能小于灯条全宽
  //（灯多时 strip > 380），直接收缩会把右侧的灯切出窗口。窗口宽 =
  // max(灯条全宽, 面板请求宽) —— 灯永远完整，面板作为下方下拉区域展开。
  setMainWindowBounds({ width: layoutMath.panelWindowWidth(w, computeWidth()) });
});

/** @type {import('child_process').ChildProcess | null} */
let supervisorChild = null;
let supervisorRespawnAttempts = 0;
let supervisorRespawnTimer = null;

/**
 * Starts the supervisor child process. Background: on this Windows 11 machine
 * the main process intermittently freezes after a few idle minutes (message
 * pump stops; TCP keeps LISTENING but HTTP never answers; no crash logs).
 * Anti-throttling flags did not eliminate it, so the supervisor detects the
 * freeze via ping timeouts and restarts the app (see supervisor.js). An
 * intentional quit kills the supervisor first, so closing the window never
 * triggers a relaunch.
 *
 * NOTE: deliberately spawn(detached) instead of fork(). fork() wires an IPC
 * channel between parent and child; when the supervisor taskkills the frozen
 * main process, Windows hard-kills the whole attached child tree — including
 * the supervisor itself — before its taskkill callback can run the relaunch
 * (error.log showed "restarting" with zero "relaunched" follow-ups). A
 * detached child with stdio:'ignore' survives the parent's death and can
 * finish the relaunch. The supervisor only communicates via env vars, so the
 * lost IPC channel is irrelevant. ELECTRON_RUN_AS_NODE=1 must be set
 * explicitly: fork() set it implicitly so electron.exe runs supervisor.js as
 * plain Node instead of trying to boot a second app instance.
 */
function startSupervisor() {
  try {
    supervisorChild = spawn(process.execPath, [path.join(__dirname, 'supervisor.js')], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ASL_PORT: String(HTTP_PORT),
        ASL_PARENT_PID: String(process.pid),
        ASL_EXE: process.execPath,
        ASL_CWD: path.join(__dirname, '..'),
        // The supervisor is a detached process and does NOT inherit our
        // resolved paths — it rebuilds them itself. Without this it would log
        // into the (read-only) program directory and we'd be blind on customer
        // machines.
        ASL_ERROR_LOG: ERROR_LOG_PATH || '',
      },
    });
    supervisorChild.on('error', (err) => logError(`supervisor child error: ${err.message}`));
    supervisorChild.on('exit', (code) => {
      logError(`supervisor child exited: code=${code}`);
      supervisorChild = null;
      scheduleSupervisorRespawn();
    });
    // A successful (re)start resets the backoff — the previous death was
    // incidental, not a systemic crash loop.
    supervisorRespawnAttempts = 0;
  } catch (err) {
    logError(`failed to start supervisor child: ${err.message}`);
    supervisorChild = null;
    scheduleSupervisorRespawn();
  }
}

/**
 * The watcher of the watcher. If the supervisor dies while the main process is
 * alive (crash, OOM, antivirus kill), the app silently loses its self-healing
 * for the rest of the session — the overlay keeps running but nothing restarts
 * it on a freeze. Respawn the supervisor with exponential backoff.
 *
 * Why this never fires on the two paths that must NOT respawn:
 *  - Intentional quit: quitApp() sets `quitting` BEFORE killing the supervisor,
 *    so the guard below returns early.
 *  - Supervisor restarts a frozen main process: the main process is taskkilled,
 *    so this exit handler never executes in that path. A live exit event
 *    therefore always means "supervisor died, main process still alive" → the
 *    correct response is to respawn it.
 */
function scheduleSupervisorRespawn() {
  if (quitting) return;
  if (supervisorRespawnTimer) return; // already scheduled
  supervisorRespawnAttempts += 1;
  if (supervisorRespawnAttempts > 8) {
    logError('supervisor respawn gave up after 8 attempts (systemic failure?)');
    return;
  }
  // Exponential backoff capped at 60s so a crash loop can't spin the CPU.
  const delay = Math.min(2000 * Math.pow(2, supervisorRespawnAttempts - 1), 60000);
  supervisorRespawnTimer = setTimeout(() => {
    supervisorRespawnTimer = null;
    if (!quitting) {
      logError(`respawning supervisor (attempt ${supervisorRespawnAttempts})`);
      startSupervisor();
    }
  }, delay);
}

const agentWatcher = require('./agent-watcher');
const win32 = require('./win32');
const settingsOps = require('./settings-ops');
const aiSignatures = require('./ai-signatures');
const lnkParser = require('./lnk-parser');
const i18n = require('./i18n');
const layoutMath = require('./layout');
const miniMode = require('./mini-mode');
const alertWebhook = require('./alert-webhook');
// v1.6.0：预选库 / 齿轮菜单白名单 / 作者配置中心 / 自动更新
const aiPresets = require('./ai-presets');
const gearMenu = require('./gear-menu');
const remoteConfigModule = require('./remote-config');
const autoUpdaterModule = require('./auto-updater');

/**
 * Starts the desktop watcher (see main/agent-watcher.js). It polls the
 * Windows process table, the foreground window and per-process CPU time for
 * GUI apps (Doubao, Marvis...) that have no hooks to report their own status:
 *   process gone            -> offline (桌面端离线)
 *   process alive, bg       -> idle    (桌面端在线)
 *   process alive, fg >=1.5s-> running (前台使用中)
 *   CPU >= 0.15 core, ~4s   -> running (后台计算中) — dual-monitor case.
 *
 * This used to be a resident Python child process (main/fg_watcher.py, ~38MB,
 * spawned from a hard-coded interpreter path). It now runs in-process on top
 * of koffi (main/win32.js) + the OS-provided SQLite: no child process, no
 * Python, no per-machine paths — so the packaged app installs cleanly anywhere.
 */
/**
 * Asks Windows to relaunch us if the process ever dies outright (crash, killed
 * from Task Manager, machine update reboot). This is the second safety net
 * alongside the supervisor, and they cover different failures:
 *   - supervisor: process alive but frozen (heartbeat timeout -> self-restart)
 *   - this:       process gone entirely — a case the supervisor cannot save us
 *                 from because it dies with us.
 *
 * Packaged builds only: registering during development would put
 * node_modules/electron/dist/electron.exe into Windows' restart list, i.e.
 * silently turn the dev build into a login item.
 *
 * Failure is never fatal — log and move on, the startup flow must not break.
 */
function registerForRestart() {
  if (!app.isPackaged) return;
  try {
    if (win32.registerApplicationRestart()) {
      console.log('[status-light] registered for application restart');
    } else {
      logError('RegisterApplicationRestart returned failure');
    }
  } catch (err) {
    logError(`RegisterApplicationRestart failed: ${err.message}`);
  }
}

/**
 * Register the overlay to start with Windows.
 *
 * Only in the packaged build — calling this from the dev build would register
 * `node_modules/electron/dist/electron.exe` as a login item, which means every
 * login would boot a bare Electron with no app on it.
 *
 * v1.3.0 起尊重设置面板的「开机自启」开关（config.json 顶层 openAtLogin，
 * 缺省 true —— 老用户无此字段，行为与之前完全一致）。此前是无条件开启，
 * 面板加了开关后若无视它，用户关掉自启、下次启动又被重新打开，等于开关
 * 是假的。
 */
function enableAutoStart() {
  if (!app.isPackaged) return;
  try {
    // Portable (绿色版) unpacks itself to %TEMP% and runs from there, so
    // process.execPath points at a throwaway path that's gone after reboot —
    // registering THAT as a login item is a dead entry. Electron's portable
    // launcher sets PORTABLE_EXECUTABLE_FILE to the real exe the user
    // double-clicked; prefer it so auto-start survives reboots.
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const want = configExtra.openAtLogin !== false;
    app.setLoginItemSettings({ openAtLogin: want, path: exePath });
    console.log(`[status-light] auto-start at login: ${want} (${exePath})`);
  } catch (err) {
    logError(`setLoginItemSettings failed: ${err.message}`);
  }
}

function startDesktopWatcher() {
  try {
    agentWatcher.setDiscoveryHandler(handleAutoDiscover);
    agentWatcher.start();
  } catch (err) {
    logError(`failed to start agent-watcher: ${err.message}`);
  }
}

/**
 * 记录被用户手动删除的 agent id（config 顶层 autoDiscoverBlacklist）：
 * 自动发现永不再把它加回来。老吴删 = 明确表态"别烦我"。
 */
function blacklistAgent(id) {
  if (!id) return;
  const list = Array.isArray(configExtra.autoDiscoverBlacklist)
    ? configExtra.autoDiscoverBlacklist
    : [];
  if (!list.includes(id)) {
    configExtra.autoDiscoverBlacklist = [...list, id];
  }
}

/**
 * 自动发现处理器（agent-watcher 每 30s 回调）。
 * 本函数只做过滤与落盘；特征匹配纯逻辑在 ai-signatures.js。
 */
function handleAutoDiscover({ procNames, windowTitles }) {
  try {
    if (configExtra.autoDiscover === false) return; // 总开关（设置面板可关）
    const existing = new Set([...agents.keys(), ...watchersConfig.map((w) => w.agent)]);
    const fresh = aiSignatures.findNewDiscoveries({
      procNames: new Set((procNames || []).map((p) => String(p).toLowerCase())),
      windowTitles: windowTitles || [],
      existingIds: existing,
      blacklist: Array.isArray(configExtra.autoDiscoverBlacklist)
        ? configExtra.autoDiscoverBlacklist
        : [],
    });
    if (fresh.length === 0) return;
    const discovered = [];
    for (const sig of fresh) {
      if (agents.size >= MAX_AGENTS) break;
      // 初始状态：offline + 心跳 0（未上报），不凭空给新鲜心跳 / 不一点亮就黄灯。
      // 基础状态构造收在 ai-signatures.discoveredAgentState（纯函数，可单测）；
      // origin/discoveredAt 仍在此处无条件打标，保持设置面板删除豁免语义。
      agents.set(sig.id, {
        ...aiSignatures.discoveredAgentState(sig),
        origin: 'auto', // v1.4.1：设置面板删除豁免判定 + 落盘持久化
        discoveredAt: Date.now(),
      });
      if (sig.process) {
        watchersConfig.push({
          agent: sig.id,
          process: sig.process,
          task: '桌面端在线',
          ...(sig.windowKeywords && sig.windowKeywords.length
            ? { window: sig.windowKeywords }
            : {}),
        });
      }
      discovered.push({ id: sig.id, name: sig.name });
      console.log(`[status-light] auto-discover: added ${sig.id} (${sig.name}, ${sig.process || 'window-only'})`);
    }
    if (discovered.length === 0) return;
    saveConfig();
    resizeWindowToAgents();
    broadcastState();
    // 渲染层播一次发现提示音（soundOn 关时渲染层自己静音）
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:discovered', discovered);
    }
  } catch (err) {
    logError(`auto-discover failed: ${err && err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Cloud relay bridge (route A: public MQTT broker as the relay)
// ---------------------------------------------------------------------------

const mqttBridge = require('./mqtt-bridge');
let cloudBridge = null;

/**
 * Starts the MQTT bridge that receives status reports from AIs running on
 * cloud machines (Ubuntu 云电脑 etc.). Messages land in the same applyReport
 * state machine as local HTTP reports — sticky rules and light colors are
 * identical. Kill switch: "cloudRelay": false in config.json (hot, ~30s).
 */
function startCloudBridge() {
  try {
    cloudBridge = mqttBridge.startMqttBridge(
      (body) => applyReport(body),
      logError,
      () => currentConfigCloudRelay() === true,
      // v1.5.0：主题前缀从 config 读（每台机器随机生成），每次 connect/
      // publish 现取，设置面板重新生成主题后随重连无缝生效。
      () => configExtra.mqttTopic,
      // v1.6.0 功能四：broker 地址从 config 读，connect 时现取，
      // 面板改配置随重连生效（保存时若变化会主动重启桥，见 settingsPanel:save）。
      () => configExtra.mqttBroker
    );
  } catch (err) {
    logError(`failed to start mqtt bridge: ${err.message}`);
  }
}

// cloudRelay toggle lives in config.json; read lazily so it never breaks startup.
// v1.5.0 初始值 false（隐私安全的 fail-safe）：loadConfig 读到显式值或走
// 老配置迁移（隐含开 -> 显式 true 落盘）后覆盖。
let cloudRelayFlag = false;
function currentConfigCloudRelay() {
  return cloudRelayFlag;
}

// ---------------------------------------------------------------------------
// Author config center + auto update (v1.6.0 功能三/五)
// ---------------------------------------------------------------------------

/** @type {ReturnType<remoteConfigModule.createRemoteConfig> | null} */
let remoteConfig = null;

/** 启动作者配置中心：10 秒首拉 + 6 小时轮询；离线静默降级（缓存>内置默认）。 */
function startRemoteConfig() {
  try {
    remoteConfig = remoteConfigModule.createRemoteConfig({
      cachePath: path.join(app.getPath('userData'), 'author-config-cache.json'),
      logImpl: logError,
    });
    remoteConfig.start();
  } catch (err) {
    logError(`remote config start failed: ${err.message}`);
  }
}

/** @type {ReturnType<autoUpdaterModule.startAutoUpdate> | null} */
let updateFlow = null;

/** 启动自动更新：安装版 30 秒后 checkForUpdatesAndNotify；绿色版只派灯条横幅。 */
function startAutoUpdateFlow() {
  try {
    updateFlow = autoUpdaterModule.startAutoUpdate({
      isPackaged: app.isPackaged,
      isPortable: !!process.env.PORTABLE_EXECUTABLE_FILE,
      currentVersion: APP_VERSION,
      onBanner: (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:available', info);
        }
      },
      logImpl: logError,
    });
  } catch (err) {
    logError(`auto-update start failed: ${err.message}`);
  }
}

// v1.6.1 功能三：设置面板「检查更新」按钮。三态反馈（new/latest/not-ready），
// 点了必须有回响——更新源未开放（GitHub 未发布/dev）也要明确告诉用户。
ipcMain.handle('update:checkNow', async () => {
  try {
    if (!updateFlow) return { state: 'not-ready' };
    return await updateFlow.checkDetailed();
  } catch (err) {
    logError(`update:checkNow failed: ${err.message}`);
    return { state: 'not-ready' };
  }
});

// v1.6.0 功能二：齿轮单击下拉菜单的动作出口。白名单校验（gear-menu.js），
// 渲染层不能发任意动作串；refresh 与右键菜单共用 agentWatcher.refreshNow。
ipcMain.on('gear:action', (_event, action) => {
  if (!gearMenu.isGearAction(action)) return;
  if (action === 'agents') openSettingsWindow('agents');
  else if (action === 'settings') openSettingsWindow();
  else if (action === 'refresh') {
    try {
      agentWatcher.refreshNow();
    } catch (err) {
      logError(`gear refreshNow failed: ${err.message}`);
    }
  } else if (action === 'quit') {
    quitApp();
  }
});

// 渲染层开外部链接（预设官网↗ / Ko-fi / Releases）：仅放行 https://，长度设限。
ipcMain.on('shell:openExternal', (_event, url) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url) || url.length > 300) return;
  shell.openExternal(url).catch((err) => logError(`openExternal failed: ${err.message}`));
});

// ---------------------------------------------------------------------------
// IPC dragging
// ---------------------------------------------------------------------------
// Dragging is implemented over IPC instead of -webkit-app-region: drag.
// The native app-region drag enters an OS modal move loop on the main
// thread; if that loop ever gets stuck (e.g. hitting a screen edge), the
// entire main process freezes — timers stop and the HTTP service goes
// silent. IPC dragging keeps the event loop pumping during moves.

/** @type {{startX: number, startY: number, cursorX: number, cursorY: number, baseHeight: number} | null} */
let dragContext = null;

ipcMain.on('window:dragStart', (_event, pos) => {
  if (!mainWindow || mainWindow.isDestroyed() || !pos) return;
  const [x, y] = mainWindow.getPosition();
  const [width, height] = mainWindow.getSize();
  logError(`[drag] dragStart ENTER win=${width}x${height} cur=(${pos.cursorX},${pos.cursorY})`);
  // If the user starts a drag while a detail/settings panel is open (window
  // height > 基准行高), collapse it back to the base strip height. The
  // strip must never get dragged while it's been stretched open by a panel.
  // v1.7.0：基准高按当前模式取（mini=40 / compact=56 / classic=72）。
  let baseWidth = width;
  let baseHeight = height;
  const baseTargetHeight = baseWindowSizeForMode(currentDisplayMode()).height;
  if (height > baseTargetHeight + 4) {
    baseHeight = baseTargetHeight;
    setMainWindowBounds({ x, y, height: baseHeight });
    logError(`[drag] collapsed panel on dragStart: was ${height} -> ${baseHeight}`);
    // Ask the renderer to also drop its panel state so React stops sending
    // the tall ResizeObserver height back through the IPC.
    mainWindow.webContents.send('window:collapsePanels');
  }
  dragContext = {
    startX: x,
    startY: y,
    cursorX: pos.cursorX,
    cursorY: pos.cursorY,
    // Cache the original width/height so dragMove can pin them without
    // re-reading getSize(). Reading getSize() while a drag is in progress
    // is unsafe: any in-flight ResizeObserver -> setMainWindowBounds call
    // temporarily flips resizable=true, and Windows DWM then gets a chance
    // to drag-resize the window edge, so the next getSize() returns a
    // stretched width and dragMove writes it back, locking the window at
    // the wrong size.
    baseWidth,
    baseHeight,
  };
});

ipcMain.on('window:dragMove', (_event, pos) => {
  if (!dragContext || !mainWindow || mainWindow.isDestroyed() || !pos) return;
  // setBounds (not setPosition) so we can pin width AND height back to the
  // values captured at dragStart. Using getSize() here would let any in-
  // flight OS resize (or another setBounds call from setMainWindowBounds)
  // poison the base values into the bounds we write.
  mainWindow.setBounds({
    x: dragContext.startX + Math.round(pos.cursorX - dragContext.cursorX),
    y: dragContext.startY + Math.round(pos.cursorY - dragContext.cursorY),
    width: dragContext.baseWidth,
    height: dragContext.baseHeight,
  });
});

ipcMain.on('window:dragEnd', () => {
  if (dragContext && mainWindow && !mainWindow.isDestroyed()) {
    const [curX, curY] = mainWindow.getPosition();
    // Snap and persist using the locked base width/height, not whatever size
    // the window happened to have when the user let go (which may have been
    // stretched by an OS mid-drag resize).
    const snapped = snapToWorkAreaEdges(curX, curY, dragContext.baseWidth, dragContext.baseHeight);
    mainWindow.setBounds({
      x: snapped.x,
      y: snapped.y,
      width: dragContext.baseWidth,
      height: dragContext.baseHeight,
    });
    windowPosition = { x: snapped.x, y: snapped.y };
    saveConfig();
  }
  dragContext = null;
});

// ---------------------------------------------------------------------------
// Right-click context menu
// ---------------------------------------------------------------------------
// 这个软件此前没有任何正常退出路径：没有托盘、没有右键菜单、preload 里也没有
// 退出接口。客户想关掉它只能开任务管理器杀进程 —— 这是流氓软件的行为，直接
// 违背"能体面地装给别人"这条底线。所以这里补一个原生右键菜单。
//
// 刻意不做系统托盘：托盘要常驻图标、要处理图标缓存和 DPI 变化，对这个 56px
// 的灯条来说太重，而且托盘反而会让"退出"变得更隐蔽。右键菜单已经足够。
//
// 菜单放在主进程而不是页面里做，是因为「退出」必须能真正结束进程 —— 渲染进程
// 自己调 window.close() 只会走 window-all-closed，快是快，但一旦将来加了隐藏
// 窗口就会退不干净。app.quit() 会触发 app.on('quit')，那里会先杀掉 supervisor
// 再停 agent-watcher，保证不会又被看门狗拉起来。

let contextMenu = null;

/**
 * 干净退出。
 *
 * 为什么不用 app.quit()：实测（2026-08-29）app.quit() 会卡在这个无边框置顶
 * 窗口的关闭握手上 —— 主进程 40 秒不响应、HTTP 停答、tasklist /V 显示「没有
 * 响应」，看门狗数满 4 次去问 Windows，Windows 说它死了，于是把用户刚关掉的
 * 应用重新拉起来。用户看到的是"关不掉，过一会儿它又自己活了"，比没有退出还糟。
 * 对照实验：同一个进程里新建一个普通空白窗口 destroy() 正常返回，只有这个
 * 加载了 React 渲染进程的主窗口会死锁 —— 所以问题在窗口销毁握手，绕开它即可。
 *
 * app.exit(0) 跳过窗口关闭握手直接结束进程（不发 before-quit / will-quit /
 * quit），所以收尾必须在这里自己做：
 *   1. 先杀 supervisor —— 绝不能让它把我们的退出误判成"主进程没了"；
 *   2. 停掉 agent-watcher 的计时器，别让 FFI 调用落在进程销毁过程中；
 *   3. 落盘一次配置（窗口位置等变更时已经存过，这里只是兜底）；
 *   4. app.exit(0)。
 */
let quitting = false;
function quitApp() {
  if (quitting) return;
  quitting = true;
  if (supervisorChild && !supervisorChild.killed) {
    supervisorChild.kill();
  }
  try {
    agentWatcher.stop();
  } catch (err) {
    logError(`agent-watcher stop failed: ${err.message}`);
  }
  try {
    if (cloudBridge) cloudBridge.stop();
  } catch (err) {
    logError(`mqtt bridge stop failed: ${err.message}`);
  }
  try {
    // saveConfig() is debounced 300ms; app.exit(0) right after would kill the
    // process before the timer fires, silently losing the last config change.
    // Cancel the debounce and write synchronously.
    clearTimeout(saveTimer);
    writeConfigNow();
  } catch (err) {
    logError(`saveConfig on quit failed: ${err.message}`);
  }
  app.exit(0);
}


function showContextMenu() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!contextMenu) {
    // v1.5.0：菜单文案走语言包；语言切换后 notifyLanguageChanged 把
    // contextMenu 置 null，下次弹出时按新语言重建。
    const lang = currentLanguage();
    contextMenu = Menu.buildFromTemplate([
      {
        label: i18n.t(lang, 'menu.settings'),
        click: () => {
          // v1.3.0：打开独立的图形化设置窗口（灯源管理/监视配置/开关）。
          // 灯条内嵌的 React 小面板仍可通过灯条上的齿轮按钮打开，互不影响。
          openSettingsWindow();
        },
      },
      {
        label: i18n.t(lang, 'menu.refresh'),
        click: () => {
          try {
            agentWatcher.refreshNow();
          } catch (err) {
            logError(`refreshNow failed: ${err.message}`);
          }
        },
      },
      { type: 'separator' },
      { label: i18n.t(lang, 'menu.quit'), click: () => quitApp() },
    ]);
  }
  // 没有窗口时 popup 到光标位置；有窗口时绑定窗口，菜单才会正确响应 Esc /
  // 点击别处关闭（否则会残留一个抢焦点的菜单）。
  if (win) contextMenu.popup({ window: win });
  else contextMenu.popup();
}

ipcMain.on('window:contextMenu', () => {
  showContextMenu();
});

// ---------------------------------------------------------------------------
// Edge snapping
// ---------------------------------------------------------------------------
// When a drag ends within SNAP_PX of a monitor's work-area edge, the strip
// snaps flush to that edge (and is always clamped fully inside the work area,
// so it can never be dropped half off-screen or onto the taskbar).

// ---------------------------------------------------------------------------
// Display lookup cache
// ---------------------------------------------------------------------------
// screen.getDisplayNearestPoint() 每次调用都会同步走一遍所有显示器的枚举和高
// DPI 度量。tooltip:show 在每次鼠标悬停时触发（一天几百次），拖动结束也会调用，
// 在远程桌面/高 DPI/睡眠唤醒后这个调用可能把主进程卡住几秒 —— Windows 事件日志
// 里的 "Application Hang ... electron.exe stopped interacting with Windows"
// 就是这么来的。而我们自己的看门狗不会报，因为每次只卡几秒，够不到 15 秒阈值。
//
// 显示器配置的真实变化 Electron 会以 display-metrics-changed / display-added /
// display-removed 三个事件广播出来，所以缓存失效是精确的：除此之外（用户把灯条
// 拖来拖去）完全可以复用上一次的结果。
//
// 注意：这里缓存的是"显示器列表"本身（条目数 = 显示器个数，天然有界），然后用纯
// JS 算最近显示器 —— 而不是按 100px 网格量化坐标做 key。原因是网格量化在显示器
// 交界处会返回隔壁那台显示器，导致 snapToWorkAreaEdges 把灯条吸到错误的边上
// （多屏、且副屏分辨率/位置不成百整除时必然出现）。纯 JS 计算是 O(显示器数量)，
// 桌面场景下不超过 4 台，开销可忽略，结果精确。

/** @type {Electron.Display[] | null} */
let displayListCache = null;
let displayCacheHooked = false;

function clearDisplayCache() {
  displayListCache = null;
}

/**
 * 显示器变化时把跑到屏幕外的灯条救回来。
 *
 * createWindow() 里已经有这套检查，但那只在【启动时】跑一次。真实场景是：
 * 灯正跑着，用户拔掉副屏 / 关掉投影 / 改分辨率 —— 这时灯条的位置没变，但它
 * 脚下的那块屏幕没了，于是它停在虚拟桌面外面。窗口还在、进程还活着、HTTP
 * 服务照常应答，但用户就是看不见它。
 *
 * 这正是"灯又没了"最难查的一种形态：从日志看一切正常，实际上它站在屏幕外。
 * 老吴 2026-08-29 就踩了这个 —— 配置里存着 x:3055（副屏坐标），主屏才 2520 宽。
 *
 * 只在显示器拓扑真变化时触发，不是轮询，开销可忽略。
 */
function rescueOffscreenWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  try {
    const [x, y] = mainWindow.getPosition();
    const [w, h] = mainWindow.getSize();
    if (isPositionVisible(x, y, w, h)) return;

    const safe = safeFallbackPosition(w);
    mainWindow.setPosition(safe.x, safe.y);
    windowPosition = safe;
    saveConfig();
    logError(
      `display topology changed: strip was off-screen at (${x},${y}); rescued to (${safe.x},${safe.y})`
    );
  } catch (err) {
    logError(`rescueOffscreenWindow failed: ${err && err.message}`);
  }
}

function hookDisplayCache() {
  if (displayCacheHooked) return;
  displayCacheHooked = true;
  const onDisplayChange = () => {
    clearDisplayCache();
    rescueOffscreenWindow();
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);
}

/** getDisplayNearestPoint 的等价实现，但走缓存，不做同步枚举。 */
function getDisplayForPoint(x, y) {
  hookDisplayCache(); // screen 的事件在 app ready 之前注册会失败，所以惰性挂上
  if (!displayListCache) displayListCache = screen.getAllDisplays();
  const displays = displayListCache;
  if (displays.length === 0) return screen.getPrimaryDisplay();
  if (displays.length === 1) return displays[0];

  let best = displays[0];
  let bestDist = Infinity;
  for (const d of displays) {
    const b = d.bounds;
    // 点到矩形的最短距离的平方（点落在矩形内时为 0）
    const dx = Math.max(b.x - x, 0, x - (b.x + b.width));
    const dy = Math.max(b.y - y, 0, y - (b.y + b.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
      if (dist === 0) break; // 命中内部，不可能更近
    }
  }
  return best;
}

const SNAP_PX = 24;

function snapToWorkAreaEdges(x, y, width, height) {
  const display = getDisplayForPoint(x + width / 2, y + height / 2);
  const wa = display.workArea;
  let nx = Math.round(Math.max(wa.x, Math.min(x, wa.x + wa.width - width)));
  let ny = Math.round(Math.max(wa.y, Math.min(y, wa.y + wa.height - height)));
  if (Math.abs(nx - wa.x) <= SNAP_PX) nx = wa.x;
  if (Math.abs(nx + width - (wa.x + wa.width)) <= SNAP_PX) nx = wa.x + wa.width - width;
  if (Math.abs(ny - wa.y) <= SNAP_PX) ny = wa.y;
  if (Math.abs(ny + height - (wa.y + wa.height)) <= SNAP_PX) ny = wa.y + wa.height - height;
  return { x: nx, y: ny };
}

// ---------------------------------------------------------------------------
// Tooltip window
// ---------------------------------------------------------------------------

/**
 * The tooltip is a separate frameless window: the main strip is only 56px
 * tall with clipped overflow, so an in-page tooltip can never be visible.
 * A dedicated window also lets the tooltip float above or below the strip
 * depending on the strip's screen position.
 */
function ensureTooltipWindow() {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) return tooltipWindow;
  tooltipWindow = new BrowserWindow({
    width: TIP_WIDTH,
    height: TIP_HEIGHT,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: '#111827',
    webPreferences: {
      preload: path.join(__dirname, 'tooltip-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // 'floating' 而不是 'screen-saver'：后者是 Windows 的最高层级，会盖住锁屏、
  // 全屏视频和 UAC 提示，且走一套特殊的调度路径 —— 是已知的 Application Hang
  // 触发源。悬浮提示只需要浮在普通窗口之上，'floating' 与主灯条同一层级即可。
  tooltipWindow.setAlwaysOnTop(true, 'floating');
  tooltipWindow.setMenu(null);
  tooltipWindow.loadFile(path.join(__dirname, 'tooltip.html'));
  tooltipWindow.on('closed', () => {
    tooltipWindow = null;
  });
  return tooltipWindow;
}

ipcMain.on('tooltip:show', (_event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || !payload || !payload.agent) return;
  const tip = ensureTooltipWindow();
  const anchorX = Number(payload.anchorX) || 0;
  const anchorTop = Number(payload.anchorTop) || 0;
  const anchorBottom = Number(payload.anchorBottom) || 0;

  const area = getDisplayForPoint(anchorX, anchorTop).workArea;
  let x = Math.round(anchorX - TIP_WIDTH / 2);
  x = Math.max(area.x + 4, Math.min(x, area.x + area.width - TIP_WIDTH - 4));
  const belowY = Math.round(anchorBottom + 6);
  // Pop below the strip when there is room; otherwise pop above it.
  const fitsBelow = belowY + TIP_HEIGHT <= area.y + area.height;
  const y = fitsBelow ? belowY : Math.max(area.y + 4, Math.round(anchorTop - TIP_HEIGHT - 6));

  tip.setBounds({ x, y, width: TIP_WIDTH, height: TIP_HEIGHT });
  const deliver = () => {
    if (tooltipWindow && !tooltipWindow.isDestroyed()) {
      // v1.5.0：携带当前界面语言，tooltip 文案随语言设置切换
      tip.webContents.send('tooltip:data', { agent: payload.agent, lang: currentLanguage() });
      if (!tip.isVisible()) tip.showInactive();
    }
  };
  if (tip.webContents.isLoading()) {
    tip.webContents.once('did-finish-load', deliver);
  } else {
    deliver();
  }
});

ipcMain.on('tooltip:hide', () => {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) {
    tooltipWindow.hide();
  }
});

// ---------------------------------------------------------------------------
// Settings window（图形化设置面板，v1.3.0）
// ---------------------------------------------------------------------------
// 独立普通窗口（非置顶、不抢主浮窗层级），原生 HTML + 专用 preload，不走
// Vite/React 构建链。右键菜单「⚙️ 设置」打开；关闭即销毁（closed -> null）。
// 配置写回走 settings-ops 校验 + writeConfigNow 原子落盘；agent-watcher 每
// tick 重读 config.json，所以保存后 30 秒内热生效，无需重启。

/** @type {BrowserWindow | null} */
let settingsWindow = null;

/**
 * 打开设置窗口。
 * @param {string} [section] v1.6.0 齿轮菜单「AI 源管理」传 'agents'：
 *   经 URL hash 定位，settings.html 加载后滚动到灯源管理区。
 */
function openSettingsWindow(section) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    // 窗口已开时也要响应定位请求（用户从齿轮菜单再点「AI 源管理」）
    if (section === 'agents') {
      settingsWindow.webContents.send('settingsPanel:scrollTo', 'agents');
    }
    return;
  }
  const iconPath = path.join(__dirname, '..', 'assets', 'status-light.ico');
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 720,
    title: i18n.t(currentLanguage(), 'title.settings'),
    autoHideMenuBar: true,
    alwaysOnTop: false,
    backgroundColor: '#111827',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(
    path.join(__dirname, 'settings.html'),
    section === 'agents' ? { hash: 'agents' } : {}
  );
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/** 面板读取当前完整配置快照。snapshotAt 供保存时做删除豁免判定（v1.4.1）。 */
ipcMain.handle('settingsPanel:get', () => ({
  agents: Array.from(agents.values()).map((a) => ({ id: a.id, name: a.name })),
  watchers: watchersConfig,
  soundOn: settings.soundOn !== false,
  soundVolume: ['low', 'medium', 'high'].includes(settings.soundVolume)
    ? settings.soundVolume
    : 'high',
  repeatAlert: settings.repeatAlert !== false,
  // v1.6.3 灯下状态文字开关（缺省开）
  showStatusText: settings.showStatusText !== false,
  // v1.7.0 显示模式三档与自动收起开关（缺省 classic/false）
  displayMode: currentDisplayMode(),
  autoCollapse: settings.autoCollapse === true,
  autoDiscover: configExtra.autoDiscover !== false,
  cloudRelay: currentConfigCloudRelay() === true,
  // v1.5.0：语言（原始设置值 + 已解析值）与每台机器随机 MQTT 主题
  language: settingsOps.normalizeLanguage(settings.language) || 'auto',
  resolvedLanguage: currentLanguage(),
  mqttTopic: isValidMqttTopic(configExtra.mqttTopic) ? configExtra.mqttTopic : '',
  // v1.6.0 功能四：broker 可配置（空串 = 面板显示「默认」语义，placeholder 展示默认地址）
  mqttBroker: typeof configExtra.mqttBroker === 'string' ? configExtra.mqttBroker : '',
  mqttBrokerWss: typeof configExtra.mqttBrokerWss === 'string' ? configExtra.mqttBrokerWss : '',
  // v1.6.0 功能一：快捷添加预选库（本地内置为底，远程作者配置更新为准）
  presets: aiPresets.pickPresets(aiPresets.PRESET_GROUPS, aiPresets.PRESETS_UPDATED_AT, remoteConfig ? remoteConfig.get() : null),
  // v1.6.0 功能三/六：作者配置中心有效值（联系邮箱/支持链接/宣传位/公告）
  authorConfig: remoteConfig ? remoteConfig.get() : remoteConfigModule.DEFAULT_AUTHOR_CONFIG,
  // v1.5.1：电话告警 webhook 配置（出厂关闭、空 URL/key）
  alertWebhook: {
    enabled: false,
    url: '',
    key: '',
    onAssist: true,
    onStuck: true,
    ...(configExtra.alertWebhook && typeof configExtra.alertWebhook === 'object'
      ? configExtra.alertWebhook
      : {}),
  },
  screenWatch: configExtra.screenWatch !== false,
  // config 里的开关是权威值（启动时 enableAutoStart 会按它重放），
  // 直接读注册表在便携版/开发版上会给出误导性答案。
  openAtLogin: app.isPackaged ? configExtra.openAtLogin !== false : false,
  // 自动发现黑名单：id -> 特征库中文名反查（查不到回退 id 本身）
  blacklist: (Array.isArray(configExtra.autoDiscoverBlacklist)
    ? configExtra.autoDiscoverBlacklist
    : []
  ).map((id) => {
    const sig = aiSignatures.AI_SIGNATURES.find((s) => s.id === id);
    return { id, name: sig ? sig.name : id };
  }),
  snapshotAt: Date.now(),
  packaged: app.isPackaged,
  configBroken: configLoadFailed,
  // v1.6.1：顶部冻结栏左侧显示当前版本号
  version: APP_VERSION,
}));

/** 面板整包保存：校验 -> 更新内存状态 -> 原子落盘 -> 应用开机自启。 */
ipcMain.handle('settingsPanel:save', (_event, payload) => {
  if (configLoadFailed) {
    // config.json 已损坏（.bak 已备份）：拒绝写入，绝不用空配置盖掉它。
    return { ok: false, error: 'config.json 已损坏，已拒绝保存（原文件已备份为 config.json.bak，请修复后重启）', key: 'err.configBroken' };
  }
  const result = settingsOps.validateSettingsPayload(payload);
  if (!result.ok) return result;
  const value = result.value;

  // AI 灯源：删掉被移除的、改名保留的、加入新增的（运行中状态原样保留）。
  // v1.4.1 P1 修复：面板打开后自动发现的新 agent 不在 payload 里属正常
  // （面板没看见它），跳过删除且不拉黑 —— 它自动并入保存结果。
  const snapshotAt = payload && Number.isFinite(payload.snapshotAt) ? payload.snapshotAt : 0;
  const keepIds = new Set(value.agents.map((a) => a.id));
  const sparedIds = new Set(); // 本次被豁免的 agent：watcher 必须成对补回（v1.4.2）
  for (const id of Array.from(agents.keys())) {
    if (!keepIds.has(id)) {
      const agent = agents.get(id);
      if (settingsOps.shouldSkipDeletion(agent, snapshotAt)) {
        sparedIds.add(id);
        console.log(`[status-light] settings save: keep auto-discovered ${id} (after snapshot)`);
        continue;
      }
      agents.delete(id);
      blacklistAgent(id); // 手动删除 = 拉黑，自动发现不再加回（v1.4.0）
    }
  }
  for (const a of value.agents) {
    const existing = agents.get(a.id);
    if (existing) {
      existing.name = a.name;
    } else {
      agents.set(a.id, { id: a.id, name: a.name, status: 'offline', task: '', lastHeartbeat: 0 });
    }
  }

  // v1.4.2 Bug 2 修复：payload 的 watchers 来自面板旧快照，不含被豁免
  // agent 的 watcher——整体覆盖会让 agent 活着、watcher 消失（死灯）。
  // 把内存中现存的豁免 agent watcher 条目并入，agent/watcher 成对存活。
  watchersConfig = settingsOps.mergeSparedWatchers(value.watchers, watchersConfig, sparedIds);
  settings.soundOn = value.soundOn;
  settings.soundVolume = value.soundVolume;
  settings.repeatAlert = value.repeatAlert;
  // v1.6.3 灯下状态文字开关（面板总是显式回传）
  settings.showStatusText = value.showStatusText;
  // v1.7.0 显示模式三档 + 自动收起（面板总是显式回传）。displayMode 变化时
  // 换算窗口尺寸并广播渲染层；autoCollapse 切换时重置 60s 观察期。
  settings.autoCollapse = value.autoCollapse;
  const prevDisplayMode = settings.displayMode;
  settings.displayMode = value.displayMode;
  if (settings.displayMode !== prevDisplayMode) {
    resetAutoCollapseTimer();
    applyDisplayModeSize();
  } else if (settings.autoCollapse) {
    // displayMode 没变但保存动作发生：给自动收起一个全新观察期，避免
    // 「面板开着改了别的东西，保存后立刻收起」的突兀体验。
    allClearSince = Date.now();
  }
  configExtra.cloudRelay = value.cloudRelay;
  configExtra.screenWatch = value.screenWatch;
  configExtra.openAtLogin = value.openAtLogin;
  configExtra.autoDiscover = value.autoDiscover;
  cloudRelayFlag = value.cloudRelay; // MQTT 桥的热开关（30s 内生效）
  // v1.5.1 电话告警 webhook（面板总是显式回传；没带就保持现存配置）
  if (value.alertWebhook) {
    configExtra.alertWebhook = value.alertWebhook;
  }
  // v1.6.0 功能四：broker 可配置。空串 = 恢复默认（不落具体值，读侧回退）。
  // 地址变化时主动重启桥，立刻换 broker（不等 30s 重连周期）。
  if (value.mqttBroker !== undefined || value.mqttBrokerWss !== undefined) {
    const prevBroker = `${configExtra.mqttBroker || ''}|${configExtra.mqttBrokerWss || ''}`;
    if (value.mqttBroker !== undefined) configExtra.mqttBroker = value.mqttBroker;
    if (value.mqttBrokerWss !== undefined) configExtra.mqttBrokerWss = value.mqttBrokerWss;
    const nextBroker = `${configExtra.mqttBroker || ''}|${configExtra.mqttBrokerWss || ''}`;
    if (prevBroker !== nextBroker) {
      try {
        if (cloudBridge) {
          cloudBridge.stop();
          cloudBridge = null;
        }
        startCloudBridge();
        broadcastState(); // 新 broker 上立刻补 retain 快照（同 regenerateTopic 的 backlog 修复）
        logError('mqtt broker changed via settings; bridge restarted');
      } catch (err) {
        logError(`mqtt broker change bridge restart failed: ${err.message}`);
      }
    }
  }
  // v1.5.0 界面语言：变化时重建右键菜单 + 推送渲染层即时切换
  const prevLanguage = currentLanguage();
  settings.language = value.language;

  // 跳过 300ms 防抖直接落盘 —— 用户点「保存」期待的是立即生效。
  clearTimeout(saveTimer);
  writeConfigNow();

  // 开机自启：仅打包版可写（开发版写注册表会指向 node_modules 里的 electron）。
  if (app.isPackaged) {
    try {
      const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      app.setLoginItemSettings({ openAtLogin: value.openAtLogin, path: exePath });
    } catch (err) {
      logError(`settingsPanel:save setLoginItemSettings failed: ${err.message}`);
    }
  }

  resizeWindowToAgents();
  broadcastState();
  if (currentLanguage() !== prevLanguage) notifyLanguageChanged();
  logError('settings panel saved config (agents/watchers/switches updated)');
  return { ok: true };
});

/**
 * 重新生成 MQTT 主题前缀（v1.5.0 脱敏）：每台机器随机主题被泄露/换机时
 * 一键换新。旧主题立即失效 —— 桥重启（旧连接断开、订阅新主题），
 * 云端上报脚本需同步换成新主题（面板上有明示）。
 */
ipcMain.handle('settingsPanel:regenerateTopic', () => {
  configExtra.mqttTopic = generateMqttTopic();
  clearTimeout(saveTimer);
  writeConfigNow();
  try {
    if (cloudBridge) {
      cloudBridge.stop();
      cloudBridge = null;
    }
    startCloudBridge();
    // v1.5.1 顺带（v1.5.0 backlog）：新桥未连接时 publishState 会记住
    // lastSnapshotJson 并在 connect 后补发 retain —— 主动广播一次，
    // 新主题上立刻有最新快照（订阅者冷启动不再空等下一次灯变）。
    broadcastState();
  } catch (err) {
    logError(`settingsPanel:regenerateTopic bridge restart failed: ${err.message}`);
  }
  console.log(`[status-light] mqtt topic regenerated: ${configExtra.mqttTopic}`);
  return { ok: true, topic: configExtra.mqttTopic };
});

ipcMain.on('settingsPanel:close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
});

/** 解除自动发现黑名单（v1.4.1）：从 autoDiscoverBlacklist 移除，下次扫描可重新发现。 */
ipcMain.handle('settingsPanel:unblacklist', (_event, id) => {
  if (typeof id !== 'string' || !AGENT_ID_PATTERN.test(id)) {
    return { ok: false, error: 'invalid id' };
  }
  configExtra.autoDiscoverBlacklist = settingsOps.removeFromBlacklist(
    configExtra.autoDiscoverBlacklist,
    id
  );
  clearTimeout(saveTimer);
  writeConfigNow();
  console.log(`[status-light] auto-discover blacklist removed: ${id}`);
  return { ok: true };
});

/**
 * 解析拖入的快捷方式 / exe（v1.4.3）。
 * 入参是渲染层经 webUtils.getPathForFile 拿到的绝对路径；
 * 纯同步读文件，解析逻辑在 main/lnk-parser.js（纯 JS，不依赖 PowerShell）。
 * 返回 {ok, displayName?, processName?, targetPath?, partial?, error?}。
 */
ipcMain.handle('settingsPanel:resolveShortcut', (_event, filePath) => {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 1024) {
    return { ok: false, partial: false, error: '只支持快捷方式(.lnk)或 exe' };
  }
  try {
    return lnkParser.resolveDroppedFile(filePath);
  } catch (err) {
    logError(`settingsPanel:resolveShortcut failed: ${err.message}`);
    return { ok: false, partial: false, error: '解析失败，请手动添加' };
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// The Chromium sandbox is disabled by default: when this app is launched from
// non-interactive shells (agent runners, remote sessions) the sandboxed GPU
// process fails to start and kills the whole app. This overlay only loads
// local bundled content (no remote pages) and the renderer runs with
// contextIsolation + nodeIntegration off, so the risk is minimal.
// Set ASL_SANDBOX=1 to re-enable the Chromium sandbox.
if (!process.env.ASL_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}
// Optional escape hatch for machines where even the unsandboxed GPU process
// is unusable: ASL_DISABLE_GPU=1 forces software rendering.
if (process.env.ASL_DISABLE_GPU) {
  app.disableHardwareAcceleration();
}

// Anti-throttling: this overlay is idle >90% of the time but must never go
// to sleep. Windows 11 (EcoQoS / efficiency mode) and Chromium's own
// background/occlusion throttling are both known to freeze widget processes.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// CalculateNativeWinOcclusion is a documented source of idle freezes on
// Windows for small always-on-top windows (Chromium's native occlusion
// tracker runs in the browser process).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// The alert beep is played by the renderer without user gesture (the whole
// point is an unattended audible alert), so autoplay must be unrestricted.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      // Half-dead instance: main process alive (it owns the single-instance
      // lock and answers /ping) but the window is gone. Relaunching the
      // desktop icon lands here; recreate the window instead of doing
      // nothing (which the user perceives as "the icon does nothing").
      logError('second-instance: window was dead, recreated');
      createWindow();
    }
  });

  app.whenReady().then(() => {
    // Must be first: every later step (config load/save, logging, watcher,
    // supervisor) depends on the resolved userData paths.
    initPaths();
    // Ask Windows to not suspend / efficiency-throttle this process.
    try {
      const blockerId = powerSaveBlocker.start('prevent-app-suspension');
      console.log(`[status-light] powerSaveBlocker active: ${powerSaveBlocker.isStarted(blockerId)}`);
    } catch (err) {
      logError(`powerSaveBlocker failed to start: ${err.message}`);
    }

    loadConfig();
    createWindow();
    startHttpServer();
    setInterval(broadcastState, TICK_MS);
    startWatchdog();
    startSupervisor();
    startDesktopWatcher();
    startCloudBridge();
    registerForRestart();
    enableAutoStart();
    // v1.6.0：作者配置中心（10s 首拉+6h 轮询）与自动更新（30s 后首查）。
    // 两者都自带静默降级，失败不影响任何既有功能。
    startRemoteConfig();
    startAutoUpdateFlow();
  });

  // Observability for abnormal child-process deaths (renderer/GPU/utility).
  app.on('child-process-gone', (_event, details) => {
    logError(`child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  });
  app.on('render-process-gone', (_event, _webContents, details) => {
    logError(`render process gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------
  // 正常退出走 quitApp()（右键菜单「退出 AI 状态灯」、以及所有窗口关闭时）。
  // 它用 app.exit(0) 绕开窗口销毁握手 —— 那个握手会死锁，详见 quitApp 的注释。
  app.on('window-all-closed', quitApp);

  // 保险网：不经过 quitApp 的 app.quit() 路径（例如单实例锁没抢到时）至少能
  // 收掉 supervisor 和计时器。这里刻意不 destroy 窗口 —— 那一步会死锁。
  app.on('before-quit', () => {
    if (supervisorChild && !supervisorChild.killed) {
      supervisorChild.kill();
    }
    try {
      agentWatcher.stop();
    } catch (err) {
      logError(`agent-watcher stop failed: ${err.message}`);
    }
    try {
      if (cloudBridge) cloudBridge.stop();
    } catch (err) {
      logError(`mqtt bridge stop failed: ${err.message}`);
    }
  });
}
