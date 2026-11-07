'use strict';

// parent.js (test E) — forks child.js via IPC (exactly like main.js does).
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, 'teste.log');
fs.writeFileSync(LOG, '');
const log = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

log(`parent started pid=${process.pid}`);
fork(path.join(__dirname, 'child.js'), [], { silent: true });
setInterval(() => {}, 60000);
