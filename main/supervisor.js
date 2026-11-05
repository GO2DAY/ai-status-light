'use strict';

/**
 * supervisor.js - watchdog + self-healing supervisor for AI Status Light.
 *
 * Runs as a detached plain-Node child process of the Electron main process
 * (spawned with stdio:'ignore' so no IPC channel ties it to the parent's
 * lifetime — see startSupervisor() in main.js).
 *
 * ── 设计原则（v2，2026-08-29 重写）───────────────────────────────────
 *
 * v1 的行为是「连续 3 次 ping 超时 4s」就强杀重启 —— 也就是主进程只要
 * 沉默 24 秒就人头落地。实测结果（8/28 12:47–16:27，error.log）：
 *   15:07:46 / 15:17:49 / 15:27:47 / 15:37:49 / 15:47:43 / 15:57:42 / 16:07:45
 * 一小时被自己枪毙 7 次。Windows 事件日志里也留了案底：
 *   Application Hang ID=1002 ——「程序 electron.exe 停止与 Windows 交互」
 * 也就是说它确实会卡，但 v1 的处置方式太粗暴：不管三七二十一先杀再说，
 * 卡 24 秒就重启，重启完灯闪一下、位置抖一下，用户看到的就是"这个软件
 * 老毛病不断"。这不是自愈，这是抽搐。
 *
 * v2 的三条铁律：
 *
 *   1) 耐心。单次等待 4s → 10s，连续次数 3 → 4。也就是说主进程必须沉默
 *      40 秒以上才会被提上议程（原来是 24 秒）。偶发的系统抖动（杀毒扫
 *      描、磁盘唤醒、DPC 延迟峰值）根本够不到这条线。
 *
 *   2) 动手前先问操作系统，绝不自作主张。Windows 自己会把不响应消息的
 *      GUI 程序标记为「没有响应 / Not Responding」（tasklist /V 的状态列）。
 *      只有操作系统都说它死了，我们才动手。如果 tasklist 显示它「运行中」，
 *      或者 tasklist 本身调用失败 —— 一律不动手，重置计数，只记一行日志。
 *      宁可漏杀，不可误杀。误杀一次用户就看到灯黑一下；漏杀一次只不过
 *      多等一个周期。
 *
 *   3) 冷却期。两次重启之间至少间隔 5 分钟。万一真遇上了重启即卡的死循
 *      环，最多 5 分钟一次，不会变成每秒一次的重启风暴把机器拖垮。
 *
 * 另外一处工程修正：所有 http 请求显式 `agent: false`。Node 默认的全局
 * Agent 会做 keep-alive 连接复用，而服务端空闲后会单方面关掉连接；复用
 * 一个已经被服务端关掉的 socket 就会拿到 ECONNRESET。虽然这条不会直接
 * 导致误杀（v1 里 error 分支不计数），但它会在 error.log 里刷满噪音，
 * 把真正有价值的信号淹掉。
 *
 * 正常退出时主进程会先杀掉本 supervisor，所以用户主动关闭永远不会触发
 * 重启。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.ASL_PORT) || 17890;
const PARENT_PID = Number(process.env.ASL_PARENT_PID) || 0;
const EXE = process.env.ASL_EXE || '';
const CWD = process.env.ASL_CWD || '';

const INTERVAL_MS = 10_000; // 探测周期（原 8s）
const TIMEOUT_MS = 10_000; // 单次响应耐心（原 4s）
const MAX_CONSECUTIVE_TIMEOUTS = 4; // 需连续 4 次无响应才进入确认流程（原 3）
const MAX_CONSECUTIVE_REFUSED = 3; // 连接被拒 N 次 = 主进程真的没了（原 2）
const MAX_CONSECUTIVE_ZOMBIE = 3; // /ping 通但窗口已销毁
const RESTART_COOLDOWN_MS = 5 * 60_000; // 两次重启最小间隔
const RELAUNCH_DELAY_MS = 2_500;
// This process is spawned detached and shares no state with the main process,
// so it rebuilds its own paths. ASL_ERROR_LOG is injected by main.js
// (startSupervisor); the fallback to the program directory only applies when
// running standalone. Installed under C:\Program Files\ the program directory
// is not writable, in which case the fallback below silently loses every log
// line — hence the env var being mandatory in practice.
const ERROR_LOG_PATH =
  process.env.ASL_ERROR_LOG || path.join(__dirname, '..', 'error.log');

// Windows 判定 GUI 程序无响应时给出的状态串，中英文都要认。
const NOT_RESPONDING_MARKERS = ['没有响应', 'not responding'];

// 冷却时间戳持久化文件。必须用固定路径：supervisor 重启主进程后自身退出，
// 新主进程 spawn 出的下一代 supervisor 要能从同一个文件读回上次重启时间，
// 冷却期才能跨代生效。放在 tmpdir 是因为 Program Files 下不可写。
const COOLDOWN_STAMP_PATH = path.join(os.tmpdir(), 'ai-status-light-last-restart');

/** 启动时恢复上次重启时间；文件不存在/损坏一律当作从未重启过。 */
function loadLastRestart() {
  try {
    const ts = Number(fs.readFileSync(COOLDOWN_STAMP_PATH, 'utf8').trim());
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  } catch {
    return 0;
  }
}

/** 把重启时间戳落盘；写不进去也不能影响自救动作本身。 */
function persistLastRestart(ts) {
  try {
    fs.writeFileSync(COOLDOWN_STAMP_PATH, String(ts));
  } catch {
    /* 冷却期最多退化为进程内有效，不能阻止重启 */
  }
}

let consecutiveTimeouts = 0;
let consecutiveRefused = 0;
let consecutiveZombie = 0;
let acting = false;
let lastRestartAt = loadLastRestart();

function log(message) {
  try {
    fs.appendFileSync(ERROR_LOG_PATH, `${new Date().toISOString()} supervisor: ${message}\n`);
  } catch {
    /* 日志写不进去也不能影响看门狗本身 */
  }
}

/** 统一的探测请求：显式禁用 keep-alive，避免复用已被服务端关闭的 socket。 */
function probe(pathname, onResponse) {
  const req = http.get(
    {
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      timeout: TIMEOUT_MS,
      agent: false,
      headers: { Connection: 'close' },
    },
    onResponse
  );
  req.on('timeout', () => {
    req.destroy();
  });
  req.on('error', () => {
    /* 各调用方自行处理 */
  });
  return req;
}

function ping() {
  if (acting) return;
  const req = probe('/ping', (res) => {
    res.resume();
    consecutiveTimeouts = 0;
    consecutiveRefused = 0;
    // /ping 健康：再探一次窗口，避免"进程活着但窗口没了"的僵尸态溜过去。
    checkWindow();
  });
  req.on('error', (err) => onRequestError(err));
}

/**
 * 僵尸探测：GET /window。窗口销毁时该接口返回 bounds:null。
 * /ping 通 + bounds:null = 僵尸，按连续计数重启。
 * 任何请求失败都算"证据不足"，重置计数而不是累加。
 */
function checkWindow() {
  if (acting) return;
  const req = probe('/window', (res) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        /* 响应体畸形：证据不足，重置 */
        consecutiveZombie = 0;
        return;
      }
      if (!payload || payload.bounds !== null) {
        consecutiveZombie = 0;
        return;
      }
      consecutiveZombie += 1;
      if (consecutiveZombie >= MAX_CONSECUTIVE_ZOMBIE) {
        log(
          `zombie suspected (window dead but /ping ok) - pid ${PARENT_PID}, ` +
            `${consecutiveZombie} consecutive /window bounds:null, asking OS to confirm`
        );
        // 与 HTTP 超时路径共用同一条 OS 确认流程：窗口重建期的短暂
        // bounds:null 会被 tasklist 的「运行中」状态挡回去，不会误杀。
        // 冷却期在 restartParent() 入口统一强制。
        confirmWithOperatingSystem();
      }
    });
  });
  req.on('error', () => {
    consecutiveZombie = 0;
  });
}

/** 累计一次超时；够数了就进入操作系统确认流程。 */
function onTimeout() {
  consecutiveTimeouts += 1;
  consecutiveRefused = 0;
  log(
    `no response from main process (pid ${PARENT_PID}) - ${consecutiveTimeouts}/${MAX_CONSECUTIVE_TIMEOUTS}`
  );
  if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
    confirmWithOperatingSystem();
  }
}

/**
 * 关键：动手之前先问 Windows 自己怎么看待这个进程。
 *
 * `tasklist /V` 的状态列会给出「运行中 / 没有响应」。只有操作系统判定它
 * 没有响应，我们才重启。除此之外的一切情况（还在运行、tasklist 调用失败、
 * 解析不出来）都选择不动手 —— 漏杀的代价远小于误杀。
 */
function confirmWithOperatingSystem() {
  if (acting) return;
  acting = true; // 确认期间停止一切探测，避免并发重启

  execFile(
    'tasklist',
    ['/FI', `PID eq ${PARENT_PID}`, '/V', '/FO', 'CSV', '/NH'],
    { windowsHide: true, timeout: 8_000 },
    (err, stdout) => {
      const output = String(stdout || '');

      if (err) {
        log(
          `cannot verify parent state (tasklist failed: ${err.message}) - ` +
            'NOT restarting: absence of evidence is not evidence of death'
        );
        return backOffAndResume();
      }

      if (!output.trim() || /信息: 没有运行的任务|INFO: No tasks/i.test(output)) {
        log(`parent pid ${PARENT_PID} no longer exists - supervisor exiting without relaunch`);
        process.exit(0);
        return;
      }

      const status = parseTasklistStatus(output);
      const osSaysHung = NOT_RESPONDING_MARKERS.some((m) => status.toLowerCase().includes(m));

      if (!osSaysHung) {
        // 操作系统说它还活着 —— 那只是我们的 HTTP 探测出了问题，或者只是
        // 一次短暂卡顿。绝对不动手。
        log(
          `parent pid ${PARENT_PID} is ${status || 'running'} per Windows - ` +
            'NOT restarting (OS does not consider it hung)'
        );
        return backOffAndResume();
      }

      log(`main process (pid ${PARENT_PID}) confirmed hung by Windows (${status}) - restarting`);
      restartParent();
    }
  );
}

/** 从 tasklist /V 的 CSV 输出里取出「状态」列（第 6 个字段）。 */
function parseTasklistStatus(csvLine) {
  const line = csvLine.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  // 形如："electron.exe","1234","Console","1","158,736 K","运行中","...","0:00:12","AI Status Light"
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return (fields[5] || '').trim();
}

/** 判定不成立：重置计数，恢复探测。 */
function backOffAndResume() {
  consecutiveTimeouts = 0;
  consecutiveZombie = 0;
  acting = false;
}

function onRequestError(err) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED') {
    // 监听没了：主进程主动退出（用户关窗）或被外部杀掉。
    consecutiveRefused += 1;
    if (consecutiveRefused >= MAX_CONSECUTIVE_REFUSED) {
      log('parent gone (connection refused), supervisor exiting without relaunch');
      process.exit(0);
    }
    return;
  }
  if (code === 'ECONNRESET' || /socket hang up/i.test((err && err.message) || '')) {
    // 这是我们在 timeout 分支里 destroy() 掉自己的请求必然产生的伴生错误。
    // 真正的计数由 onTimeout() 负责，这里只记一次，避免刷屏。
    onTimeout();
    return;
  }
  log(`ping error: ${code || (err && err.message)}`);
}

function restartParent() {
  // 防御深度的唯一落点：不管哪条路径（HTTP 超时、僵尸检测、未来新增）
  // 调用这里，冷却期都在入口处统一强制，绝不分散到各调用点。
  const sinceLast = Date.now() - lastRestartAt;
  if (lastRestartAt && sinceLast < RESTART_COOLDOWN_MS) {
    log(
      `restart suppressed by cooldown (${Math.round(sinceLast / 1000)}s since ` +
        'last restart) - waiting to avoid a restart storm'
    );
    return backOffAndResume();
  }
  // 先落盘再动手：本进程随后会退出，下一代 supervisor 靠这个文件继承冷却期。
  lastRestartAt = Date.now();
  persistLastRestart(lastRestartAt);
  // 注意：这里刻意不用 taskkill /T。supervisor 本身是主进程的子进程，
  // 杀整棵树会把自己一起带走。只杀主进程就够了：Electron 的 renderer /
  // GPU / utility 子进程会在 browser process 死后自行退出。
  execFile('taskkill', ['/F', '/PID', String(PARENT_PID)], (killErr) => {
    if (killErr) log(`taskkill parent failed: ${killErr.message}`);
    setTimeout(() => {
      if (!EXE || !CWD) {
        log('missing ASL_EXE/ASL_CWD, cannot relaunch');
        process.exit(1);
        return;
      }
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(EXE, ['.'], {
        cwd: CWD,
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      log(`relaunched main process, new pid=${child.pid}`);
      process.exit(0);
    }, RELAUNCH_DELAY_MS);
  });
}

setInterval(ping, INTERVAL_MS);
ping();
