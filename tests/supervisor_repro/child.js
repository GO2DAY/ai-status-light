'use strict';

// child.js (test E) — forked with IPC like supervisor.js, but IMMEDIATELY
// calls process.disconnect() to drop the IPC channel, then performs the
// exact restartParent() sequence: taskkill parent -> setTimeout -> spawn.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, 'teste.log');
const log = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

process.on('uncaughtException', (e) => log(`child UNCAUGHT: ${e && e.stack}`));
process.on('exit', (code) => log(`child EXIT code=${code}`));

log(`child started pid=${process.pid} ppid=${process.ppid}`);
if (process.connected) {
  process.disconnect(); // candidate one-line fix
  log('child: IPC disconnected at startup');
}
setInterval(() => log('child hb'), 500);

setTimeout(() => {
  log('child: calling restartParent()');
  execFile('taskkill', ['/F', '/PID', String(process.ppid)], (killErr) => {
    log(`child: taskkill callback err=${killErr ? killErr.message : 'none'}`);
    setTimeout(() => {
      const dummy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},50)'], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      dummy.unref();
      log(`child: RELAUNCH DONE pid=${dummy.pid} — disconnect() fix works`);
      process.exit(0);
    }, 2500);
  });
}, 1500);

setInterval(() => {}, 60000);
