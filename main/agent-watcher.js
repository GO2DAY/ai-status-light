'use strict';

/**
 * main/agent-watcher.js — 桌面端 AI 应用状态监听（进程内，替代已删除的 main/fg_watcher.py）
 *
 * 原来这些逻辑跑在一个常驻的 python.exe 子进程里（约 38MB 内存、每 2 秒唤醒一次、
 * 依赖写死的 Python 解释器路径）。现在全部收进 Electron 主进程：
 * 无子进程、无 Python、无额外内存开销，配置改动 5 秒内热生效。
 *
 * 四条通道（与原 Python 版 1:1）：
 *   A. WorkBuddy 线程通道（5s）  读 ~/.workbuddy/workbuddy.db 里 status='working'
 *                                的会话标题 -> running "N 线程: t1 | t2"
 *   B. 进程在线通道（5s）         按 config.json 的 watchers 扫进程表
 *                                在 -> idle/桌面端在线；不在 -> offline/桌面端离线
 *   C. 前台窗口通道（2s）         命中前台且持续 1.5s -> running/前台使用中
 *                                失去前台 -> 下一轮回 idle
 *   D. CPU 通道（2s，双屏关键）   该 exe 全部 PID 的 CPU 核数 >= 0.15 持续 2 轮
 *                                -> running/后台计算中 CPU{n}%
 *                                连续 3 轮低于阈值 -> 回 idle
 *   E. 画面活动通道（2s）          desktopCapturer 截目标窗口 320x180 缩略图，
 *                                与上一帧采样比对，diff >= 1% -> running/画面活跃·生成中
 *                                （AI 生成回答时文字持续刷屏；答完静止 -> 回 idle）
 *                                对话型 AI（豆包/马维斯）无法执行 HTTP 上报，
 *                                这条通道让灯不依赖对方配合就能分清"真在生成/已答完"。
 *                                与 D 是"或"关系：任一热 = running，都冷 = idle。
 *
 * 对外只暴露 start() / stop()。所有计时器都是 setInterval，没有阻塞循环，
 * 不会占住主进程事件循环（主进程还要同时响应 HTTP 与窗口拖动）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const koffi = require('koffi');
const win32 = require('./win32');

// 环境变量可覆盖，方便测试时连到另一个实例；默认与主程序 HTTP 端口一致。
const PORT = Number(process.env.ASL_PORT) || 17890;
const HOST = '127.0.0.1';
const DEBUG_LOG = process.env.ASL_DEBUG_LOG || '';

// 配置文件路径必须惰性求值：main.js 的 initPaths() 在 app.whenReady() 里才把
// ASL_CONFIG 设成 %APPDATA%\AI-Status-Light\config.json（那之前 app.getPath
// 会抛 "Cannot get path before app is ready"）。写成模块顶层常量会永远拿到
// 旧的程序目录路径 —— 配置迁走后这里读到空文件，watchers 全废、灯全灰且无日志。
const configPath = () => process.env.ASL_CONFIG || path.join(__dirname, '..', 'config.json');

// 读不到 watchers 时的失败计数。原来 catch 里直接 `return []` 静默吞掉，
// 客户机器上会表现为"灯全灰、error.log 一行报错都没有"。
// 我们要的是"它知道自己瞎了"，而不是每 5 秒刷一条日志 —— 所以累计到
// CFG_FAIL_REPORT_THRESHOLD 次才报一次，之后每 CFG_FAIL_REPORT_EVERY 次再报。
const CFG_FAIL_REPORT_THRESHOLD = 10;
const CFG_FAIL_REPORT_EVERY = 60;
let cfgFailCount = 0;

const WB_AGENT = 'workbuddy';
// 相对用户主目录解析 —— 绝不写死盘符/用户名，换台机器直接可用。
const WB_DB_PARTS = ['.workbuddy', 'workbuddy.db'];

const FG_DEBOUNCE_S = 1.5; // 前台需持续这么久才点亮绿灯（去抖）
const POLL_MS = 2000; // 前台 + CPU 采样周期
const SCAN_MS = 5000; // 进程表 + 数据库扫描周期
const CPU_HOT_CORES = 0.15; // 约 15% 单核（该应用全部 PID 之和）
const CPU_HOT_ROUNDS = 2; // 持续约 4 秒才转绿
const CPU_COOL_ROUNDS = 3; // 安静约 6 秒才回落 idle

// 通道 E（画面活动）参数
// 2026-08-30 本机标定（screen-harness.js）：静止窗口 ratio 恒 0.0000，后台重绘
// 噪声峰值 0.0011，内容翻转的活跃窗口 0.0295 —— 阈值取 0.006，噪声上限的 5 倍，
// 同时保证几行文字变化即可触发。320 缩略图对大窗压缩偏狠，升到 480 保文字细节。
const SCREEN_THUMB_W = 480;
const SCREEN_THUMB_H = 270;
const SCREEN_DIFF_RATIO = 0.006; // 采样像素变化 >= 0.6% 判「画面活跃」
const SCREEN_ACTIVE_TTL_MS = 3500; // 活跃信号有效期（约 2 个采样周期，覆盖异步 jitter）
const SCREEN_SAMPLE_STRIDE = 4; // 每 4 个像素采 1 个（速度 vs 精度的平衡）
const SCREEN_CHANNEL_TOLERANCE = 12; // 单通道差值容忍，抗缩略图压缩噪声

const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_OPEN_READONLY = 0x00000001;
const SQLITE_OPEN_URI = 0x00000040;
const SQLITE_BUSY_TIMEOUT_MS = 500; // 等锁上限：超过 scan 周期(5s)无意义，且不能拖住主进程

// ===========================================================================
// WorkBuddy 会话库读取（Windows 自带 SQLite，koffi 直接调 C API）
// ===========================================================================
// 为什么不用 sql.js：workbuddy.db 是 WAL 模式，主库（196KB）停在旧快照，最新
// 数据全在 2MB 的 workbuddy.db-wal 里。sql.js 只有 Emscripten 内存 VFS，WAL
// 文件根本不在它的文件系统内，实测 working 会话永远查到 0 条（同时刻只读模式的
// 真实结果是 2 条）—— 属于静默失效。
// winsqlite3.dll 是 Windows 10 1809+ / Windows 11 系统自带组件，以
// SQLITE_OPEN_READONLY 打开真实文件，WAL 由 SQLite 自己回放，实测与原 Python
// 版结果完全一致，且不新增任何 npm 依赖、不需要编译环境。
// v1.6.2：标题取值改为「手动命名优先」。WorkBuddy 的 sessions 表有 custom_title
// 列（用户在 WorkBuddy 里手动重命名会话的值），自动 title 从创建日定死从不更新。
// ⚠️ 兼容性铁律：老版本 WorkBuddy 的 DB 可能没有 custom_title 列，直接引用会整个
// 查询报错 —— 必须先 PRAGMA table_info(sessions) 查列存在性再动态拼 SQL。
const WB_SQL_LEGACY =
  "SELECT COALESCE(title,'未命名线程') FROM sessions WHERE deleted_at IS NULL AND status='working'";

/**
 * 按 schema 拼 working 会话标题查询（纯函数，可单测）。
 * @param {boolean} hasCustomTitle sessions 表是否含 custom_title 列
 */
function buildWorkingTitlesSql(hasCustomTitle) {
  if (!hasCustomTitle) return WB_SQL_LEGACY;
  return (
    "SELECT COALESCE(NULLIF(custom_title,''), title, '未命名线程') " +
    "FROM sessions WHERE deleted_at IS NULL AND status='working'"
  );
}

/** @type {object | null} */
let sqliteApi = null;
/** @type {boolean} */
let sqliteApiTried = false;

function buildSqliteApi() {
  const candidates = ['winsqlite3.dll'];
  const sysRoot = process.env.SystemRoot || process.env.windir;
  if (sysRoot) candidates.push(path.join(sysRoot, 'System32', 'winsqlite3.dll'));

  const errors = [];
  for (const dllPath of candidates) {
    try {
      const dll = koffi.load(dllPath);
      return {
        open: dll.func(
          'int sqlite3_open_v2(const char *filename, _Out_ intptr_t *db, int flags, const char *vfs)'
        ),
        close: dll.func('int sqlite3_close(intptr_t db)'),
        // WorkBuddy 正在做 WAL checkpoint 的瞬间我们可能撞上 SQLITE_BUSY。
        // 不设 busy_timeout 的话这一轮查询直接作废、灯不更新；设 500ms 后
        // 绝大多数瞬时冲突都能等到锁释放，灯的稳定性明显变好。
        busyTimeout: dll.func('int sqlite3_busy_timeout(intptr_t db, int ms)'),
        prepare: dll.func(
          'int sqlite3_prepare_v2(intptr_t db, const char *sql, int nByte, _Out_ intptr_t *stmt, intptr_t tail)'
        ),
        step: dll.func('int sqlite3_step(intptr_t stmt)'),
        columnText: dll.func('const char *sqlite3_column_text(intptr_t stmt, int col)'),
        finalize: dll.func('int sqlite3_finalize(intptr_t stmt)'),
      };
    } catch (err) {
      errors.push(`${dllPath}: ${err && err.message}`);
    }
  }
  console.warn(`[status-light] SQLite unavailable (${errors.join('; ')}); workbuddy channel off`);
  return null;
}

function sqlite() {
  if (!sqliteApiTried) {
    sqliteApiTried = true;
    sqliteApi = buildSqliteApi();
  }
  return sqliteApi;
}

/**
 * PRAGMA table_info 查列存在性（v1.6.2 兼容性铁律：老库无 custom_title 列，
 * 直接引用会让整个查询报错）。查询失败保守返回 false（退回旧 SQL）。
 * @param {object} api sqliteApi
 * @param {number} db 已打开的数据库句柄
 * @param {string} table 表名（内部常量，非用户输入，无注入面）
 * @param {string} column 列名（同上）
 */
function tableHasColumn(api, db, table, column) {
  const stmtRef = [0];
  if (api.prepare(db, `PRAGMA table_info(${table})`, -1, stmtRef, 0) !== 0) return false;
  const stmt = stmtRef[0];
  try {
    for (let guard = 0; guard < 500; guard += 1) {
      const rc = api.step(stmt);
      if (rc === SQLITE_ROW) {
        // table_info 行格式：cid|name|type|notnull|dflt_value|pk —— name 在第 2 列
        const name = api.columnText(stmt, 1);
        if (typeof name === 'string' && name.toLowerCase() === column.toLowerCase()) return true;
        continue;
      }
      return false; // DONE 或任何错误码：列没找到 / 查不动，都按无列处理
    }
    return false;
  } finally {
    api.finalize(stmt);
  }
}

/**
 * 在已打开的句柄上查 working 会话标题（v1.6.2 抽出，便于单测直接喂临时库）。
 * @returns {string[] | null} 出错/被锁返回 null（调用方保留上一次灯态）
 */
function queryWorkingTitlesFromDb(api, db) {
  const sql = buildWorkingTitlesSql(tableHasColumn(api, db, 'sessions', 'custom_title'));
  const stmtRef = [0];
  if (api.prepare(db, sql, -1, stmtRef, 0) !== 0) return null;
  const stmt = stmtRef[0];
  try {
    const titles = [];
    for (let guard = 0; guard < 500; guard += 1) {
      const rc = api.step(stmt);
      if (rc === SQLITE_ROW) {
        const v = api.columnText(stmt, 0);
        titles.push(typeof v === 'string' ? v : '未命名线程');
        continue;
      }
      if (rc === SQLITE_DONE) return titles; // 正常读完
      // SQLITE_BUSY / SQLITE_ERROR / 其他任何返回码：busy_timeout 500ms 仍没等到
      // 锁释放（WorkBuddy checkpoint 超过半秒）。绝不能把空数组/半截数据当成
      // "没有活跃线程" —— 返回 null，调用方保留上一次灯态，不让绿灯误灭。
      return null;
    }
    return titles; // guard 用尽（防御性，正常查询远到不了 500 行）
  } finally {
    api.finalize(stmt);
  }
}

/**
 * 返回 status='working' 的会话标题数组；出错返回 null（调用方据此保留上一次灯态，
 * 不做任何改变 —— 数据库被 WorkBuddy 占用/短暂锁住时不能让灯乱跳）。
 */
function workbuddyWorkingTitles() {
  const api = sqlite();
  if (!api) return null;
  const dbPath = path.join(os.homedir(), ...WB_DB_PARTS);
  const dbRef = [0];
  try {
    // sqlite3_open_v2 即使返回错误码，dbRef[0] 也可能已经分配（SQLite 契约：
    // 失败时也必须 close，否则泄漏）。没有 ~/.workbuddy 的机器上 READONLY open
    // 每 5 秒失败一次，不 close 就是每 5 秒漏一个连接对象，长跑内存单调上涨。
    const openRc = api.open(dbPath, dbRef, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, null);
    const db = dbRef[0];
    if (openRc !== 0) {
      if (db) { try { api.close(db); } catch { /* ignore */ } }
      return null;
    }
    if (!db) return null;
    try {
      api.busyTimeout(db, SQLITE_BUSY_TIMEOUT_MS); // 开库后立刻生效，覆盖后续所有语句
      return queryWorkingTitlesFromDb(api, db);
    } finally {
      // 每轮用完必须关闭，绝不能长持句柄（会让 WorkBuddy 侧无法正常 checkpoint）。
      api.close(db);
    }
  } catch (err) {
    return null;
  }
}

// ===========================================================================
// 上报
// ===========================================================================

/** 追加调试日志（仅当设置了 ASL_DEBUG_LOG），任何失败都吞掉。 */
function debug(message) {
  if (!DEBUG_LOG) return;
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * POST /status 到本进程的 HTTP 服务。失败一律静默 —— 主程序可能在重启中，
 * 下一轮（2~5 秒后）自然会重试。
 */
function post(agent, status, task) {
  let req;
  try {
    const body = Buffer.from(JSON.stringify({ agent, status, task }), 'utf-8');
    req = http.request(
      {
        host: HOST,
        port: PORT,
        path: '/status',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      },
      (res) => {
        // 必须消费掉响应体，否则 socket 不会释放，长时间跑会堆积连接。
        res.resume();
        debug(`POST ${agent} ${status} -> ${res.statusCode}`);
      }
    );
    req.setTimeout(3000, () => req.destroy());
    req.on('error', (err) => debug(`POST ${agent} ${status} FAIL ${err && err.message}`));
    req.end(body);
  } catch (err) {
    debug(`POST ${agent} ${status} THROW ${err && err.message}`);
  }
}

// ===========================================================================
// 配置
// ===========================================================================

/**
 * 每轮重新读 config.json，改完 5 秒内热生效，无需重启。
 * 必须按 agent 去重（首条优先）：重复条目会共享同一份运行时状态字典，互相
 * 清零 hot/cool/fgSince 计数，绿灯永远触发不了。
 */
function loadWatchers() {
  const cfg = configPath();
  try {
    const data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    cfgFailCount = 0;
    // 总开关：config.json 里 "screenWatch": false 可整条关掉画面通道
    // （例如客户机器上桌面捕获被安全软件拦截时的一键回退）。
    screenWatchEnabled = data.screenWatch !== false;
    const seen = new Set();
    const out = [];
    for (const w of data.watchers || []) {
      if (!w || !w.agent || !w.process) continue;
      if (seen.has(w.agent)) continue;
      seen.add(w.agent);
      out.push(w);
    }
    return out;
  } catch (err) {
    // 配置文件正在被写入（保存瞬间）是常态，下一轮再读 —— 但如果一直读不到
    // （路径迁走、权限、文件损坏），必须留下痕迹，否则表现为"灯全灰、零日志"。
    cfgFailCount += 1;
    if (
      cfgFailCount === CFG_FAIL_REPORT_THRESHOLD ||
      (cfgFailCount > CFG_FAIL_REPORT_THRESHOLD &&
        (cfgFailCount - CFG_FAIL_REPORT_THRESHOLD) % CFG_FAIL_REPORT_EVERY === 0)
    ) {
      console.warn(
        `[status-light] watchers config unreadable after ${cfgFailCount} attempts: ${err && err.message} (path=${cfg})`
      );
    }
    return [];
  }
}

/** 'N 线程: t1 | t2' —— 标题各截断 18 字符，最多列 3 个，超出显示 '…等N个'。 */
function workbuddyTaskString(titles) {
  const shown = titles
    .slice(0, 3)
    .map((t) => t.slice(0, 18))
    .join(' | ');
  const suffix = titles.length > 3 ? ` …等${titles.length}个` : '';
  return `${titles.length} 线程: ${shown}${suffix}`;
}

// ===========================================================================
// 状态机
// ===========================================================================

/** @type {{online: boolean, fgSince: number, last: string|null, cpuPrev: number|null, cpuPrevT: number, hot: number, cool: number, cpuRate: number, screenPrevMap: Map|null, screenActiveT: number, screenWinCount: number, screenDialog: string, screenWindows: Map|null}} */
function newState() {
  return {
    online: false,
    fgSince: 0,
    last: null,
    cpuPrev: null,
    cpuPrevT: 0,
    hot: 0,
    cool: CPU_COOL_ROUNDS,
    cpuRate: 0,
    screenPrevMap: null, // 每窗口帧基线：sourceId -> bitmap（通道 E）
    screenActiveT: 0, // 最近一次判定「画面活跃」的时间戳（ms）
    screenWinCount: 0, // 该 AI 当前开着的窗口数（= 并行对话数）
    screenDialog: '', // 当前对话主题（从窗口标题提取）
    screenWindows: null, // 每窗口对话信息：sourceId -> {title, activeT}（v1.4.0 对话列表）
  };
}

let procSet = new Set();
const state = new Map(); // agent -> state
let wbPrev = 0; // 上一次查到的 working 会话数
let wbBusy = false; // 数据库查询重入保护
let screenBusy = false; // 画面通道重入保护（getSources 是异步的）
let screenWatchEnabled = true; // config.json "screenWatch": false 可关闭通道 E
let screenEnumLogged = false; // 窗口枚举清单只打一次日志，避免刷屏

/** electron.desktopCapturer 惰性加载（模块在 app ready 前就被 require）。 */
let desktopCapturerRef = null;
function desktopCapturer() {
  if (!desktopCapturerRef) {
    desktopCapturerRef = require('electron').desktopCapturer;
  }
  return desktopCapturerRef;
}

/**
 * 两帧 BGRA 位图的采样差异率（0~1）。长度不一致按完全不同处理（调用方
 * 会据此判活跃 —— 尺寸变化本身就说明窗口重排/内容大变）。
 */
function screenDiffRatio(prev, cur) {
  if (!prev || !cur || prev.length !== cur.length || cur.length === 0) return 1;
  const strideBytes = SCREEN_SAMPLE_STRIDE * 4; // BGRA 每像素 4 字节
  let changed = 0;
  let sampled = 0;
  for (let i = 0; i + 2 < cur.length; i += strideBytes) {
    sampled += 1;
    if (
      Math.abs(cur[i] - prev[i]) > SCREEN_CHANNEL_TOLERANCE ||
      Math.abs(cur[i + 1] - prev[i + 1]) > SCREEN_CHANNEL_TOLERANCE ||
      Math.abs(cur[i + 2] - prev[i + 2]) > SCREEN_CHANNEL_TOLERANCE
    ) {
      changed += 1;
    }
  }
  return sampled ? changed / sampled : 0;
}

/**
 * 通道 E：画面活动检测（每 2 秒，异步）。
 * 只处理配了 window 关键词且进程在线的 watcher；目标进程不在线时零开销。
 * 首帧只建基线不判活跃（否则每次启动/窗口重建都会误亮一次绿灯）。
 */
async function tickScreen() {
  if (screenBusy || !screenWatchEnabled) return;
  const targets = loadWatchers().filter(
    (w) =>
      Array.isArray(w.window) &&
      w.window.length > 0 &&
      procSet.has(String(w.process).toLowerCase())
  );
  if (targets.length === 0) return;
  screenBusy = true;
  try {
    const sources = await desktopCapturer().getSources({
      types: ['window'],
      thumbnailSize: { width: SCREEN_THUMB_W, height: SCREEN_THUMB_H },
      fetchWindowIcons: false,
    });
    if (!screenEnumLogged) {
      screenEnumLogged = true;
      console.log(
        `[status-light] screen-watcher sees ${sources.length} windows: ` +
          sources.map((s) => s.name).filter(Boolean).slice(0, 40).join(' | ')
      );
    }
    const now = Date.now();
    for (const w of targets) {
      if (!state.has(w.agent)) state.set(w.agent, newState());
      const st = state.get(w.agent);
      const kws = w.window.map((k) => String(k).toLowerCase());
      // 线程级检测：同一个 AI 开的每个窗口 = 一个并行对话。
      // 全部匹配（不是只取第一个），窗口数直接显示在灯文案上。
      const matched = sources.filter(
        (s) => s.name && kws.some((k) => s.name.toLowerCase().includes(k))
      );
      if (matched.length === 0) {
        debug(`screen ${w.agent}: window not found (kws=${kws.join(',')})`);
        continue;
      }
      st.screenWinCount = matched.length;
      // 对话名取第一个"有内容"的标题（清洗掉应用名后缀）
      st.screenDialog = '';
      for (const s of matched) {
        const name = dialogName(s.name);
        if (name) {
          st.screenDialog = name;
          break;
        }
      }
      // 每个窗口独立帧基线（source.id 是稳定窗口句柄）
      if (!st.screenPrevMap) st.screenPrevMap = new Map();
      if (!st.screenWindows) st.screenWindows = new Map();
      const seenIds = new Set();
      for (const src of matched) {
        seenIds.add(src.id);
        // 对话列表（v1.4.0）：每个窗口一条 {title, activeT}。
        // 标题优先用剥掉应用名的对话主题，剥不出来（标题就是应用名）用原标题截断。
        const rawTitle = String(src.name || '');
        const winEntry = st.screenWindows.get(src.id) || { title: '', activeT: 0 };
        winEntry.title = dialogName(rawTitle) || rawTitle.slice(0, 24) || '（未命名窗口）';
        st.screenWindows.set(src.id, winEntry);
        const bmp = src.thumbnail.isEmpty() ? null : src.thumbnail.toBitmap();
        if (!bmp || bmp.length === 0) continue;
        const prev = st.screenPrevMap.get(src.id);
        if (!prev) {
          st.screenPrevMap.set(src.id, bmp); // 首帧只建基线
          continue;
        }
        const ratio = screenDiffRatio(prev, bmp);
        st.screenPrevMap.set(src.id, bmp);
        if (ratio >= SCREEN_DIFF_RATIO) {
          st.screenActiveT = now;
          winEntry.activeT = now; // 该窗口标记为活跃（对话列表显示「生成中」）
          const dlg = dialogName(src.name);
          if (dlg) st.screenDialog = dlg; // 活跃窗口的对话名优先显示
          debug(
            `screen ${w.agent} ratio=${ratio.toFixed(4)} ACTIVE (title="${src.name}")`
          );
        } else {
          debug(`screen ${w.agent} ratio=${ratio.toFixed(4)} still (title="${src.name}")`);
        }
      }
      // 窗口关了就丢基线，防止 Map 单调涨
      for (const id of st.screenPrevMap.keys()) {
        if (!seenIds.has(id)) st.screenPrevMap.delete(id);
      }
      for (const id of st.screenWindows.keys()) {
        if (!seenIds.has(id)) st.screenWindows.delete(id);
      }
    }
  } catch (err) {
    debug(`screen tick failed: ${err && err.message}`);
  } finally {
    screenBusy = false;
  }
}

/**
 * 从窗口标题提取对话名：剥掉应用名后缀，剩下的就是对话主题。
 * 例："关公推文怎么写 - 豆包" -> "关公推文怎么写"；"对话主题 - 豆包" -> "对话主题"。
 * 剥完为空（标题就是应用名本身，如 "Marvis"）返回 ''。
 */
function dialogName(title) {
  let t = String(title || '').trim();
  t = t.replace(/\s*[-–—]+\s*(豆包|Doubao|Marvis|马维斯)\s*$/i, '').trim();
  t = t.replace(/[-–—\s]+$/, '').trim(); // 连字符残留（如"标题——豆包"剥后剩"—"）
  if (!t || /^(豆包|doubao|marvis|马维斯)$/i.test(t)) return '';
  return t.slice(0, 24);
}

/** 前台 + CPU 通道（每 2 秒）。 */
function tickFast() {
  const now = Date.now() / 1000;
  const fg = win32.foregroundProcessName();

  for (const w of loadWatchers()) {
    const agent = w.agent;
    const proc = String(w.process).toLowerCase();
    if (!state.has(agent)) state.set(agent, newState());
    const st = state.get(agent);

    const online = procSet.has(proc);
    if (online !== st.online) {
      // 上下线是硬切换：重置去抖与 CPU 基线（基线必须跟着应用本身重置，
      // 否则新起的进程会把旧进程的累计 CPU 算成一次暴涨）。
      st.online = online;
      st.fgSince = 0;
      st.cpuPrev = null;
      st.hot = 0;
      st.cool = CPU_COOL_ROUNDS;
      st.screenPrevMap = null; // 画面基线同样跟着进程重置
      st.screenActiveT = 0;
      st.screenWinCount = 0;
      st.screenDialog = '';
      st.screenWindows = null; // 对话列表同样跟着进程重置
      if (online) {
        post(agent, 'idle', '桌面端在线');
        st.last = 'idle';
      } else {
        post(agent, 'offline', '桌面端离线');
        st.last = 'offline';
      }
      continue;
    }
    if (!online) continue;

    // --- 通道 C：前台命中（最即时，但只能覆盖一个窗口）---
    if (fg === proc) {
      st.fgSince = st.fgSince || now;
      if (now - st.fgSince >= FG_DEBOUNCE_S && st.last !== 'running') {
        post(agent, 'running', '前台使用中');
        st.last = 'running';
      }
      st.hot = 0; // 已经绿了，CPU 计数归零
      st.cool = CPU_COOL_ROUNDS;
      continue;
    }

    // --- 通道 D：CPU 负载（双屏/后台计算场景）---
    st.fgSince = 0;
    let cur = 0;
    try {
      cur = win32.cpuSeconds(win32.imagePids(proc));
    } catch (err) {
      cur = st.cpuPrev === null ? 0 : st.cpuPrev;
    }
    if (st.cpuPrev !== null) {
      const dt = Math.max(now - st.cpuPrevT, 0.5);
      st.cpuRate = (cur - st.cpuPrev) / dt; // 单位：核数（该应用全部 PID 之和）
    }
    st.cpuPrev = cur;
    st.cpuPrevT = now;

    if (st.cpuRate >= CPU_HOT_CORES) {
      st.hot += 1;
      st.cool = 0;
    } else {
      st.hot = 0;
      st.cool += 1;
    }

    // --- 通道 E 融合：画面活跃信号由 tickScreen 异步维护（screenActiveT）---
    // 与 CPU 通道是"或"关系：任一热 = running；都冷且冷却期满 = idle。
    const screenHot =
      st.screenActiveT > 0 && Date.now() - st.screenActiveT <= SCREEN_ACTIVE_TTL_MS;
    if (screenHot) st.cool = 0; // 画面还在变，绝不允许 CPU 冷却把灯打灰
    const cpuHot = st.hot >= CPU_HOT_ROUNDS;
    // 线程级文案：N对话·生成中「对话主题」——一眼看清几个并行对话、在干什么
    const dlgPrefix = st.screenWinCount > 1 ? `${st.screenWinCount}对话·` : '';
    const dlgSuffix = st.screenDialog ? `「${st.screenDialog}」` : '';
    if ((cpuHot || screenHot) && st.last !== 'running') {
      post(
        agent,
        'running',
        screenHot
          ? `${dlgPrefix}生成中${dlgSuffix}`
          : `后台计算中 CPU${Math.round(st.cpuRate * 100)}%`
      );
      st.last = 'running';
    } else if (!cpuHot && !screenHot && st.cool >= CPU_COOL_ROUNDS && st.last === 'running') {
      post(
        agent,
        'idle',
        st.screenWinCount > 0 ? `桌面端在线·${st.screenWinCount}对话` : '桌面端在线'
      );
      st.last = 'idle';
    }
    debug(`${agent} fg=${fg === proc} online=${online} rate=${st.cpuRate.toFixed(2)} hot=${st.hot} cool=${st.cool} screen=${screenHot} last=${st.last}`);
  }
}

/** 进程表通道（每 5 秒）。 */
function tickProcScan() {
  try {
    procSet = win32.processNames();
  } catch (err) {
    debug(`proc scan failed: ${err && err.message}`);
    // 扫描失败时保留上一次的进程表，避免灯态抖动。
  }
}

/** WorkBuddy 数据库通道（每 5 秒，异步）。 */
function tickWorkbuddy() {
  if (wbBusy) return;
  wbBusy = true;
  // 查询本身是同步 FFI，但包一层 microtask，避免与主进程其他回调抢同一个 tick。
  Promise.resolve()
    .then(() => {
      const titles = workbuddyWorkingTitles();
      if (titles === null) return; // 数据库不可用/被占用：保留上一次灯态
      const n = titles.length;
      if (n > 0) {
        // 每轮都刷新心跳（顺带更新标题），running/idle 由本通道独占判定。
        post(WB_AGENT, 'running', workbuddyTaskString(titles));
        wbPrev = n;
      } else if (wbPrev > 0) {
        post(WB_AGENT, 'idle', '空闲');
        wbPrev = 0;
      }
    })
    .catch((err) => debug(`workbuddy tick failed: ${err && err.message}`))
    .finally(() => {
      wbBusy = false;
    });
}

/** 慢通道（进程表 + 数据库，每 5 秒）。 */
function tickSlow() {
  tickProcScan();
  tickWorkbuddy();
}

let fastTimer = null;
let slowTimer = null;
let screenTimer = null;

// ===========================================================================
// 自动发现新 AI 软件（v1.4.0）
// ===========================================================================
// 本模块只做「环境采集」：每 30s 把进程表 + 窗口标题清单交给 main.js 注册的
// 处理器；特征库匹配、已存在/blacklist 过滤、落盘全在 main.js 一侧
// （纯逻辑收在 ai-signatures.js，可单测）。

const DISCOVER_MS = 30_000;
const DISCOVER_FIRST_DELAY_MS = 15_000; // 启动后等进程表/窗口稳定再扫第一轮
let discoverTimer = null;
let discoverFirstTimer = null;
let discoveryHandler = null;

/** main.js 注册发现处理器：fn({ procNames: string[], windowTitles: string[] })。 */
function setDiscoveryHandler(fn) {
  discoveryHandler = typeof fn === 'function' ? fn : null;
}

async function tickDiscovery() {
  if (!discoveryHandler) return;
  const procNames = Array.from(procSet);
  // 窗口标题枚举：thumbnailSize 0x0 不渲染缩略图，纯拿标题，开销极小。
  // 失败（刚启动/捕获被拦）不致命 —— 进程通道照样能发现。
  let windowTitles = [];
  try {
    const sources = await desktopCapturer().getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    windowTitles = sources.map((s) => s.name).filter(Boolean);
  } catch (err) {
    debug(`discovery window enum failed: ${err && err.message}`);
  }
  try {
    discoveryHandler({ procNames, windowTitles });
  } catch (err) {
    debug(`discovery handler failed: ${err && err.message}`);
  }
}

function start() {
  if (fastTimer || slowTimer) return; // 幂等：重复 start 不会起两套计时器
  console.log(`[status-light] agent-watcher started (in-process, port ${PORT})`);
  // 先同步跑一轮，让进程表在第一条上报之前就绪（否则首轮会误报 offline）。
  tickProcScan();
  tickWorkbuddy();
  tickFast();
  tickScreen(); // 首帧只建基线，不会误亮灯
  slowTimer = setInterval(tickSlow, SCAN_MS);
  fastTimer = setInterval(tickFast, POLL_MS);
  screenTimer = setInterval(() => {
    tickScreen().catch((err) => debug(`screen tick unhandled: ${err && err.message}`));
  }, POLL_MS);
  discoverFirstTimer = setTimeout(() => {
    discoverFirstTimer = null;
    tickDiscovery().catch((err) => debug(`first discovery failed: ${err && err.message}`));
  }, DISCOVER_FIRST_DELAY_MS);
  discoverTimer = setInterval(() => {
    tickDiscovery().catch((err) => debug(`discovery tick unhandled: ${err && err.message}`));
  }, DISCOVER_MS);
}

function stop() {
  if (fastTimer) {
    clearInterval(fastTimer);
    fastTimer = null;
  }
  if (slowTimer) {
    clearInterval(slowTimer);
    slowTimer = null;
  }
  if (screenTimer) {
    clearInterval(screenTimer);
    screenTimer = null;
  }
  if (discoverTimer) {
    clearInterval(discoverTimer);
    discoverTimer = null;
  }
  if (discoverFirstTimer) {
    clearTimeout(discoverFirstTimer);
    discoverFirstTimer = null;
  }
  state.clear();
  wbPrev = 0;
  procSet = new Set();
  screenEnumLogged = false;
  console.log('[status-light] agent-watcher stopped');
}

/**
 * 立即重跑一遍全部通道（右键菜单「重新检测」）。
 *
 * 用户在客户机器上刚装完某个 AI 客户端、或刚改完 config.json 时，不想等
 * 下一个 5 秒周期。这里刻意清空每个 agent 的去抖/CPU 基线与进程表缓存：
 * CPU 基线不清的话，新起的进程会拿旧进程的累计 CPU 时间算差值，直接误判
 * 成一次「CPU 暴涨」而点亮绿灯。
 *
 * 注意只清状态、不动计时器 —— start()/stop() 的生命周期不受影响。
 */
function refreshNow() {
  state.clear();
  wbPrev = 0;
  procSet = new Set();
  tickProcScan();
  tickWorkbuddy();
  tickFast();
  tickScreen().catch((err) => debug(`screen refresh failed: ${err && err.message}`));
  debug('manual refresh requested');
}

/**
 * 把某个 agent 的 screenWindows Map 组装成对话列表（纯函数，可单测）。
 * 活跃的在前；active = 该窗口最近 SCREEN_ACTIVE_TTL_MS 内有画面变化。
 * @param {Map|null} screenWindows sourceId -> {title, activeT}
 * @param {number} now 当前时间戳 ms
 * @returns {Array<{title: string, active: boolean}>}
 */
function formatScreenDialogs(screenWindows, now) {
  if (!(screenWindows instanceof Map) || screenWindows.size === 0) return [];
  const list = [];
  for (const entry of screenWindows.values()) {
    if (!entry || !entry.title) continue;
    list.push({
      title: entry.title,
      active: entry.activeT > 0 && now - entry.activeT <= SCREEN_ACTIVE_TTL_MS,
    });
  }
  list.sort((a, b) => Number(b.active) - Number(a.active));
  return list;
}

/**
 * 当前全部 agent 的对话列表：{ agentId: [{title, active}] }。
 * main.js 的 serializeAgents 每轮调用，挂到 agent 状态的 dialogs 字段
 * （/api/state 与 MQTT 快照自动带上）。无对话窗口的 agent 不在返回表里，
 * 调用方按 [] 处理。
 */
function getDialogs() {
  const now = Date.now();
  const out = {};
  for (const [agent, st] of state.entries()) {
    const list = formatScreenDialogs(st.screenWindows, now);
    if (list.length > 0) out[agent] = list;
  }
  return out;
}

module.exports = {
  start,
  stop,
  refreshNow,
  setDiscoveryHandler,
  getDialogs,
  formatScreenDialogs,
  // v1.6.2 测试钩子：纯函数/可注入句柄的内部件，外部勿用
  __test: { buildWorkingTitlesSql, tableHasColumn, queryWorkingTitlesFromDb, sqlite },
};
