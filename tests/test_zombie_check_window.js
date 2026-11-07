'use strict';

/**
 * test_zombie_check_window.js — QA unit test for the zombie self-healing
 * logic in main/supervisor.js `checkWindow()` (task #5, bug: main process
 * alive + window destroyed => double-click icon does nothing).
 *
 * Strategy: run the REAL supervisor.js code (an unmodified copy placed in a
 * sandbox dir so its error.log cannot pollute the project root log) against
 * a local mock HTTP server that plays the role of the Electron main process.
 * The mock serves /ping OK and a scripted sequence of /window responses.
 *
 * The ONLY lines changed in each sandbox copy are the two pure-timing
 * constants (INTERVAL_MS, RELAUNCH_DELAY_MS) so the test runs in seconds
 * instead of ~30s per scenario. All decision logic — MAX_CONSECUTIVE_ZOMBIE,
 * counter reset rules, JSON-parse-failure handling, restart trigger — is
 * byte-identical to main/supervisor.js, and a source-integrity assertion
 * below verifies the copy matches the original on every logic-bearing line.
 *
 * Scenarios (per task spec):
 *   T1: {"ok":true,"bounds":null} x3 consecutive          -> restart triggered
 *   T2: {"ok":true,"bounds":{...}} (healthy)               -> counter reset, no restart
 *   T3: network error on /window                           -> counter reset, no restart
 *   T4 (bonus): malformed JSON body                         -> inconclusive, no restart
 *   T5 (bonus): zombie x2 -> healthy -> zombie x2 (bounced) -> never 3 consecutive, no restart
 *   T6 (bonus): zombie x2 -> error -> zombie x2 (bounced)   -> never 3 consecutive, no restart
 *
 * Run: node tests/test_zombie_check_window.js
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const SRC_SUPERVISOR = path.join(ROOT, 'main', 'supervisor.js');
const SANDBOX = path.join(__dirname, 'zombie_test');

// Timing constants for the sandbox copies (decision logic untouched).
const INTERVAL_MS = 700;        // original: 8_000
const RELAUNCH_DELAY_MS = 300;  // original: 2_500

const ORIGINAL_SRC = fs.readFileSync(SRC_SUPERVISOR, 'utf8');

/** Lines of supervisor.js that carry decision logic — used to prove the
 *  sandbox copy is identical to the original wherever behavior lives. */
function logicLines(s) {
  return s.split('\n').filter((l) =>
    /MAX_CONSECUTIVE_ZOMBIE|consecutiveZombie|payload\.bounds|JSON\.parse|restartParent\(\)|acting = true/.test(l)
  );
}

/** Copy supervisor.js into <SANDBOX>/<name>/sub/ and patch ONLY the timing
 *  constants. The copy's ERROR_LOG_PATH resolves to <SANDBOX>/<name>/error.log,
 *  so each scenario gets a private log, isolated from the real project log. */
function buildSandboxCopy(name) {
  assert.ok(
    /const INTERVAL_MS = 8_000;/.test(ORIGINAL_SRC) && /const RELAUNCH_DELAY_MS = 2_500;/.test(ORIGINAL_SRC),
    'source integrity: timing constants not found in supervisor.js'
  );
  let src = ORIGINAL_SRC;
  src = src.replace('const INTERVAL_MS = 8_000;', `const INTERVAL_MS = ${INTERVAL_MS};`);
  src = src.replace('const RELAUNCH_DELAY_MS = 2_500;', `const RELAUNCH_DELAY_MS = ${RELAUNCH_DELAY_MS};`);
  assert.deepStrictEqual(logicLines(src), logicLines(ORIGINAL_SRC),
    'source integrity: sandbox copy differs from supervisor.js in decision logic');

  const dir = path.join(SANDBOX, name, 'sub');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'supervisor.js'), src);
  return {
    script: path.join(dir, 'supervisor.js'),
    logPath: path.join(SANDBOX, name, 'error.log'),
  };
}

// --- mock "main process" HTTP server ----------------------------------------

const HEALTHY_WINDOW = JSON.stringify({
  ok: true,
  bounds: { x: 2923, y: 0, width: 392, height: 56 },
});
const ZOMBIE_WINDOW = JSON.stringify({ ok: true, bounds: null });

/**
 * Modes the mock can serve for /window (indexed by ping number):
 *   'zombie'   -> {"ok":true,"bounds":null}
 *   'healthy'  -> {"ok":true,"bounds":{...}}
 *   'error'    -> destroy the socket (simulated network failure)
 *   'garbage'  -> non-JSON body (simulated malformed response)
 */
function startMock(port, modeForPing) {
  let pingCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/ping')) {
      pingCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url.startsWith('/window')) {
      const mode = modeForPing(pingCount);
      if (mode === 'error') {
        res.destroy(); // connection reset before any response
        return;
      }
      if (mode === 'garbage') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('<html>not json</html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(mode === 'zombie' ? ZOMBIE_WINDOW : HEALTHY_WINDOW);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// --- scenario runner ---------------------------------------------------------

const FAKE_PARENT_PID = 999999; // guaranteed non-existent: taskkill must fail harmlessly

function runScenario(name, modeForPing, expectRestart, maxWaitMs = 12000) {
  return new Promise((resolve, reject) => {
    const { script, logPath } = buildSandboxCopy(name);
    const port = 17990 + Math.floor(Math.random() * 100);
    let child = null;
    let server = null;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child && child.exitCode === null) child.kill();
      if (server) server.close();
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '(no log)';
      if (err) {
        err.log = log;
        return reject(err);
      }
      console.log(`  [${name}] supervisor log tail:\n${log.trim().split('\n').slice(-3).map((l) => '    ' + l).join('\n')}`);
      resolve();
    };

    const timer = setTimeout(() => {
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      const triggered = /zombie detected/.test(log);
      const tookRestartPath = /restarting/.test(log) || /cannot relaunch/.test(log);
      try {
        if (expectRestart) {
          assert.ok(triggered, `${name}: expected "zombie detected ... restarting" in log, got: ${log}`);
          assert.ok(tookRestartPath, `${name}: expected restartParent() path to be taken`);
        } else {
          assert.ok(!triggered, `${name}: restart must NOT trigger, but log says: ${log}`);
          if (child && child.exitCode !== null) {
            assert.fail(`${name}: supervisor exited unexpectedly (code ${child.exitCode})`);
          }
        }
        finish(null);
      } catch (e) {
        finish(e);
      }
    }, maxWaitMs);

    startMock(port, modeForPing).then((srv) => {
      server = srv;
      child = spawn(NODE, [script], {
        env: {
          ...process.env,
          ASL_PORT: String(port),
          ASL_PARENT_PID: String(FAKE_PARENT_PID),
          ASL_EXE: '', // deliberately unset: restartParent must not relaunch electron
          ASL_CWD: '',
        },
        stdio: 'ignore',
      });
      child.on('exit', (code) => {
        // Early exit is only legitimate when a restart was triggered
        // (taskkill fails on the fake PID -> missing EXE -> exit 1).
        if (!done && !expectRestart) {
          finish(new Error(`${name}: supervisor exited early with code ${code}`));
        }
      });
    }).catch(finish);
  });
}

// --- main --------------------------------------------------------------------

(async () => {
  const tests = [
    ['T1_zombie_x3_restart', 'T1 zombie x3 consecutive -> restart',
      () => 'zombie', true],
    ['T2_healthy_reset', 'T2 healthy /window -> reset, no restart',
      () => 'healthy', false],
    ['T3_network_error_reset', 'T3 network error on /window -> reset, no restart',
      () => 'error', false],
    ['T4_garbage_json_reset', 'T4 malformed JSON body -> inconclusive, no restart',
      () => 'garbage', false],
    ['T5_bounce_healthy', 'T5 zombie x2 -> healthy -> zombie x2 (bounced)',
      (ping) => (ping % 3 === 0 ? 'healthy' : 'zombie'), false],
    ['T6_bounce_error', 'T6 zombie x2 -> error -> zombie x2 (bounced)',
      (ping) => (ping % 3 === 0 ? 'error' : 'zombie'), false],
  ];

  fs.mkdirSync(SANDBOX, { recursive: true });
  let failed = 0;
  for (const [id, name, modeForPing, expectRestart] of tests) {
    process.stdout.write(`TEST ${name} ... `);
    try {
      await runScenario(id, modeForPing, expectRestart);
      console.log('PASS');
    } catch (e) {
      failed += 1;
      console.log('FAIL');
      console.log(`  ${e.message}`);
      if (e.log) console.log(`  supervisor log:\n${e.log}`);
    }
  }

  // Best-effort cleanup (the host shell may wrap rmSync in a safe-delete
  // shim that refuses to trash files; leftover sandboxes are harmless).
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    console.log('sandbox cleaned up');
  } catch {
    console.log(`note: sandbox left in place (safe-delete refused): ${SANDBOX}`);
  }

  console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED'}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
