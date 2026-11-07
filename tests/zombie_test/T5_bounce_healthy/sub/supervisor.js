'use strict';

/**
 * supervisor.js - watchdog + self-healing supervisor for AI Status Light.
 *
 * Runs as a detached plain-Node child process of the Electron main process
 * (spawned with stdio:'ignore' so no IPC channel ties it to the parent's
 * lifetime — see startSupervisor() in main.js).
 *
 * Background: on this Windows 11 machine the Electron main process
 * intermittently freezes after a few idle minutes (message pump stops,
 * TCP keeps LISTENING but HTTP never responds, no crash logs). The root
 * cause is at the Windows/Chromium pump level and could not be eliminated
 * by anti-throttling flags, so the app heals itself instead:
 *
 *   - Pings the main process's own /ping endpoint every 8s.
 *   - Response TIMEOUT x3  -> the main process is alive but frozen:
 *     kill its process tree and relaunch a fresh instance.
 *   - ECONNREFUSED x2      -> the listener is gone (user closed the app,
 *     or it was killed deliberately): exit quietly, never resurrect.
 *   - /ping OK but /window reports bounds:null x3 -> zombie: the main
 *     process answers pings but its window is destroyed (renderer/GPU
 *     children died). /ping alone can never detect this, so /window is
 *     checked as a second liveness signal; a zombie is restarted via the
 *     same restartParent() path as a freeze.
 *
 * On a normal quit the main process kills this supervisor before exiting,
 * so an intentional close never triggers a relaunch.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.ASL_PORT) || 17890;
const PARENT_PID = Number(process.env.ASL_PARENT_PID) || 0;
const EXE = process.env.ASL_EXE || '';
const CWD = process.env.ASL_CWD || '';
const INTERVAL_MS = 700;
const TIMEOUT_MS = 4_000;
const MAX_CONSECUTIVE_TIMEOUTS = 3;
const MAX_CONSECUTIVE_REFUSED = 2;
const MAX_CONSECUTIVE_ZOMBIE = 3;
const RELAUNCH_DELAY_MS = 300;
const ERROR_LOG_PATH = path.join(__dirname, '..', 'error.log');

let consecutiveTimeouts = 0;
let consecutiveRefused = 0;
let consecutiveZombie = 0;
let acting = false;

function log(message) {
  try {
    fs.appendFileSync(ERROR_LOG_PATH, `${new Date().toISOString()} supervisor: ${message}\n`);
  } catch { /* ignore */ }
}

function ping() {
  if (acting) return;
  const req = http.get(
    { host: '127.0.0.1', port: PORT, path: '/ping', timeout: TIMEOUT_MS },
    (res) => {
      res.resume();
      consecutiveTimeouts = 0;
      consecutiveRefused = 0;
      // /ping healthy: probe the window too, so a half-dead instance
      // (main process alive, window destroyed) doesn't slip through.
      checkWindow();
    }
  );
  req.on('timeout', () => {
    req.destroy();
    onTimeout();
  });
  req.on('error', (err) => onRequestError(err));
}

/**
 * Zombie probe: GET /window. The endpoint returns bounds:null when the main
 * window is destroyed. A /ping-OK + bounds:null state means the process is a
 * zombie — counted like the ping timeouts; N consecutive hits trigger a
 * restart. Any request failure (network error/timeout) is inconclusive and
 * resets the counter instead of counting toward a restart.
 */
function checkWindow() {
  if (acting) return;
  const req = http.get(
    { host: '127.0.0.1', port: PORT, path: '/window', timeout: TIMEOUT_MS },
    (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        let payload = null;
        try {
          payload = JSON.parse(body);
        } catch { /* malformed body: treat as inconclusive */ }
        if (!payload || payload.bounds !== null) {
          consecutiveZombie = 0;
          return;
        }
        consecutiveZombie += 1;
        if (consecutiveZombie >= MAX_CONSECUTIVE_ZOMBIE) {
          acting = true;
          log(
            `zombie detected (window dead but /ping ok) - pid ${PARENT_PID}, ` +
              `${consecutiveZombie} consecutive /window bounds:null, restarting`
          );
          restartParent();
        }
      });
      res.resume();
    }
  );
  req.on('timeout', () => {
    req.destroy();
    consecutiveZombie = 0;
  });
  req.on('error', () => {
    // Inconclusive probe: do not count toward a restart.
    consecutiveZombie = 0;
  });
}

function onTimeout() {
  // TCP connected (or queued) but no HTTP response: alive but frozen.
  consecutiveTimeouts += 1;
  consecutiveRefused = 0;
  if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
    acting = true;
    log(`main process (pid ${PARENT_PID}) frozen - ${consecutiveTimeouts} consecutive ping timeouts, restarting`);
    restartParent();
  }
}

function onRequestError(err) {
  if (err && err.code === 'ECONNREFUSED') {
    // Listener gone: parent exited on purpose (window closed) or was killed.
    consecutiveRefused += 1;
    if (consecutiveRefused >= MAX_CONSECUTIVE_REFUSED) {
      log('parent gone (connection refused), supervisor exiting without relaunch');
      process.exit(0);
    }
    return;
  }
  log(`ping error: ${err && err.message}`);
}

function restartParent() {
  // NOTE: deliberately NO taskkill /T here. The supervisor is itself a child
  // of the main process, so killing the whole tree would kill the supervisor
  // before it can relaunch anything. Killing only the main process is enough:
  // Electron's renderer/GPU/utility children exit on their own when the
  // browser process dies.
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
      const child = spawn(EXE, ['.'], { cwd: CWD, env, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      log(`relaunched main process, new pid=${child.pid}`);
      process.exit(0);
    }, RELAUNCH_DELAY_MS);
  });
}

setInterval(ping, INTERVAL_MS);
ping();
