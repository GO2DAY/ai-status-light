'use strict';
// Detached launcher: spawns the Electron app fully detached so it survives
// the parent shell, with ELECTRON_RUN_AS_NODE stripped from the child env.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = fs.openSync(path.join(__dirname, 'app.log'), 'a');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.ELECTRON_ENABLE_LOGGING = '1';

const child = spawn(
  path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--enable-logging'],
  { cwd: root, env, detached: true, stdio: ['ignore', out, out], windowsHide: false }
);
child.unref();
console.log('launched electron pid=' + child.pid);
