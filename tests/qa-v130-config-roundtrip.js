'use strict';

/**
 * tests/qa-v130-config-roundtrip.js — v1.3.0 QA 独立验证（严过关）
 *
 * 模拟 main.js 的 loadConfig/writeConfigNow 关键路径（共用同一份 settings-ops 实现）：
 *  1. 磁盘 config.json 含未知顶层键（cloudRelay/screenWatch/fgWatch/dbPoll/未来嵌套键）
 *  2. 「拖动窗口」触发一次落盘 -> 未知键必须还在
 *  3. 「设置面板保存」再触发一次落盘（含 agents 增删）-> 未知键必须还在，结构化键以内存为准
 *  4. 损坏的 config.json -> 验证 .bak 备份逻辑（与 main.js loadConfig 同逻辑副本，仅作行为验证）
 *
 * 运行：node tests/qa-v130-config-roundtrip.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ops = require('../main/settings-ops');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-qa-'));
const CONFIG_PATH = path.join(dir, 'config.json');
console.log(`temp dir: ${dir}`);

// --- 模拟主进程内存状态 ---
let agents = new Map();
let settings = { soundOn: true };
let watchersConfig = [];
let windowPosition = { x: 100, y: 0 };
let configExtra = {};
let configLoadFailed = false;

// 与 main.js loadConfig 相同的提取逻辑
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    configExtra = ops.extractConfigExtras(raw);
    for (const entry of Array.isArray(raw.agents) ? raw.agents : []) {
      agents.set(entry.id, { id: entry.id, name: entry.name, status: 'offline', task: '', lastHeartbeat: 0 });
    }
    if (raw.settings && typeof raw.settings.soundOn === 'boolean') settings.soundOn = raw.settings.soundOn;
    if (raw.window && Number.isFinite(raw.window.x) && Number.isFinite(raw.window.y)) {
      windowPosition = { x: raw.window.x, y: raw.window.y };
    }
    if (Array.isArray(raw.watchers)) watchersConfig = raw.watchers;
    return raw;
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      configLoadFailed = true;
      if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
    }
    return null;
  }
}

// 与 main.js writeConfigNow 相同
function writeConfigNow() {
  if (configLoadFailed) return;
  const payload = ops.buildConfigPayload({
    extras: configExtra,
    agents: Array.from(agents.values()).map((a) => ({ id: a.id, name: a.name })),
    settings,
    window: windowPosition,
    watchers: watchersConfig,
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf-8');
}

// ---- 1. 磁盘上的 config.json：含未知顶层键（含嵌套对象） ----
const onDisk = {
  cloudRelay: false,
  screenWatch: true,
  fgWatch: { intervalMs: 500 },
  dbPoll: true,
  openAtLogin: false,
  futureUnknownFlag: { nested: { deep: [1, 2, 3] } },
  agents: [{ id: 'doubao', name: '豆包' }],
  settings: { soundOn: false },
  window: { x: 100, y: 0 },
  watchers: [{ agent: 'doubao', process: 'Doubao.exe', window: ['豆包'] }],
};
fs.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2), 'utf-8');

loadConfig();
assert.strictEqual(configLoadFailed, false);
assert.strictEqual(settings.soundOn, false);
assert.deepStrictEqual(configExtra.futureUnknownFlag, { nested: { deep: [1, 2, 3] } });
console.log('ok - loadConfig 提取 extras（含嵌套未知键）');

// ---- 2. 「拖动窗口」落盘：未知键不丢 ----
windowPosition = { x: 250, y: 10 };
writeConfigNow();
let after = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
assert.strictEqual(after.cloudRelay, false);
assert.strictEqual(after.dbPoll, true);
assert.strictEqual(after.openAtLogin, false);
assert.deepStrictEqual(after.fgWatch, { intervalMs: 500 });
assert.deepStrictEqual(after.futureUnknownFlag, { nested: { deep: [1, 2, 3] } });
assert.deepStrictEqual(after.window, { x: 250, y: 10 });
console.log('ok - 拖窗口落盘后未知顶层键（含嵌套）全部保留');

// ---- 3. 「设置面板保存」：agents 变更 + 开关翻转，未知键仍不丢 ----
const panelResult = ops.validateSettingsPayload({
  agents: [{ id: 'doubao', name: '豆包' }, { id: '', name: '新助手' }],
  watchers: [{ agent: 'doubao', process: 'Doubao.exe' }],
  soundOn: true,
  cloudRelay: true,
  screenWatch: true,
  openAtLogin: true,
});
assert.strictEqual(panelResult.ok, true);
// main.js settingsPanel:save 同款内存更新
agents.set('agent', { id: 'agent', name: '新助手', status: 'offline', task: '', lastHeartbeat: 0 });
settings.soundOn = panelResult.value.soundOn;
configExtra.cloudRelay = panelResult.value.cloudRelay;
configExtra.screenWatch = panelResult.value.screenWatch;
configExtra.openAtLogin = panelResult.value.openAtLogin;
watchersConfig = panelResult.value.watchers;
writeConfigNow();

after = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
assert.strictEqual(after.cloudRelay, true); // 面板翻转生效
assert.strictEqual(after.openAtLogin, true);
assert.strictEqual(after.dbPoll, true); // 面板不管的键原样保留
assert.deepStrictEqual(after.futureUnknownFlag, { nested: { deep: [1, 2, 3] } });
assert.strictEqual(after.agents.length, 2);
assert.deepStrictEqual(after.agents[1], { id: 'agent', name: '新助手' });
console.log('ok - 面板保存后：开关生效 + 未知键保留 + agents 更新');

// ---- 4. 损坏的 config.json：.bak 备份 + 拒绝覆写 ----
fs.writeFileSync(CONFIG_PATH, '{ not valid json !!!', 'utf-8');
configLoadFailed = false;
agents = new Map();
loadConfig();
assert.strictEqual(configLoadFailed, true);
assert.ok(fs.existsSync(`${CONFIG_PATH}.bak`), '.bak 未生成');
assert.strictEqual(fs.readFileSync(`${CONFIG_PATH}.bak`, 'utf-8'), '{ not valid json !!!');
const before = fs.readFileSync(CONFIG_PATH, 'utf-8');
writeConfigNow(); // 必须被拒绝
assert.strictEqual(fs.readFileSync(CONFIG_PATH, 'utf-8'), before, '损坏配置被覆写了！');
console.log('ok - 损坏配置：.bak 备份生成且 writeConfigNow 拒绝覆写');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nALL CONFIG ROUNDTRIP CHECKS PASSED');
