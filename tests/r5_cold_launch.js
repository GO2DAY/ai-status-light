// 端到端测试：调用 launcher.js，记录耗时直到 17890 上线
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');

const node = 'C:\\Users\\吴建明\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node.exe';
const launcher = path.resolve(__dirname, '..', 'main', 'launcher.js');
const t0 = Date.now();

const child = spawn(node, [launcher], {
  detached: false,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
console.log('[launcher pid]', child.pid);

child.stdout.on('data', (d) => process.stdout.write('[L-OUT] ' + d));
child.stderr.on('data', (d) => process.stderr.write('[L-ERR] ' + d));
child.on('exit', (code) => console.log('[launcher exit]', code));

const deadline = Date.now() + 45000;
const probe = () => {
  if (Date.now() > deadline) { console.log('TIMEOUT'); process.exit(2); }
  const req = http.get({ host: '127.0.0.1', port: 17890, path: '/' }, (res) => {
    let body = '';
    res.on('data', (c) => body += c);
    res.on('end', () => {
      console.log('READY in', Date.now() - t0, 'ms ->', body);
      process.exit(0);
    });
  });
  req.on('error', () => setTimeout(probe, 250));
  req.setTimeout(700, () => { req.destroy(); setTimeout(probe, 250); });
};
setTimeout(probe, 100);