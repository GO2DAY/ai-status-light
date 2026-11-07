'use strict';

/**
 * tests/qa-v140-boundary.test.js — v1.4.0 独立验证补充的边界用例（QA 严过关）。
 *
 * 覆盖三块：
 *   A. 自动发现：进程名大小写混合命中、特征库同 id 多条冲突、
 *      blacklist 经 writeConfigNow 落盘-重读链路后仍生效（顶层未知键保留回归）
 *   B. 对话列表：activeT 超 TTL 归非活跃、activeT=0、排序（活跃在前）、
 *      窗口关闭/进程退出的清理护栏（源码级回归断言）
 *   C. 声音：soundVolume 非法值（"loud"/空串/null/数字）拒绝、
 *      repeatAlert=false 落值正确、30s 循环的开关守卫与定时器清理（源码级回归断言）
 *
 * 运行：node tests/qa-v140-boundary.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findNewDiscoveries, signatureMatches } = require('../main/ai-signatures');
const settingsOps = require('../main/settings-ops');
const { formatScreenDialogs } = require('../main/agent-watcher');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL - ${name}: ${err.message}`);
  }
}

// ===========================================================================
// A. 自动发现
// ===========================================================================

test('大小写混合：模拟 main.js 归一化链路后 "doubao.EXE" 命中', () => {
  // main.js handleAutoDiscover 第 1226 行：procNames.map(toLowerCase)。
  // 这里复刻同一条归一化链路，验证 Windows 进程表常见的大写 exe 名能命中。
  const rawProcNames = ['doubao.EXE', 'Chrome.exe', 'SYSTEM'];
  const procNames = new Set(rawProcNames.map((p) => String(p).toLowerCase()));
  const out = findNewDiscoveries({
    procNames,
    windowTitles: [],
    existingIds: new Set(),
    blacklist: [],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'doubao');
  assert.strictEqual(out[0].process, 'doubao.exe');
});

test('契约锚定：findNewDiscoveries 要求 procNames 已小写（防 main.js 归一化被删）', () => {
  // signatureMatches 的 procNames 契约是「小写 exe 名集合」。若有人把
  // main.js 的 toLowerCase 归一化删掉，doubao.EXE 会静默发现不了 ——
  // 此测试把契约钉死：未归一化输入不命中（提醒维护者归一化是调用方责任）。
  const sig = { id: 'doubao', name: '豆包', processes: ['doubao.exe'], windowKeywords: [] };
  assert.strictEqual(signatureMatches(sig, new Set(['doubao.exe']), []), true);
  assert.strictEqual(signatureMatches(sig, new Set(['DOUBAO.EXE']), []), false);
});

test('同 id 多条签名冲突：一次扫描只产出一条', () => {
  const sigs = [
    { id: 'doubao', name: '豆包', processes: ['doubao.exe'], windowKeywords: ['豆包'] },
    { id: 'doubao', name: '豆包(旧)', processes: ['doubao-old.exe'], windowKeywords: ['豆包'] },
  ];
  const out = findNewDiscoveries({
    procNames: new Set(['doubao.exe', 'doubao-old.exe']),
    windowTitles: ['随便什么 - 豆包'],
    existingIds: new Set(),
    blacklist: [],
    signatures: sigs,
  });
  assert.strictEqual(out.length, 1, `expected 1, got ${out.length}`);
  assert.strictEqual(out[0].id, 'doubao');
  assert.strictEqual(out[0].name, '豆包'); // 首条优先
});

test('blacklist 落盘-重读链路：writeConfigNow 提取-合并后重读仍生效', () => {
  // 复刻 main.js 的 loadConfig(extractConfigExtras) -> blacklistAgent 追加 ->
  // writeConfigNow(buildConfigPayload) -> 落盘 -> 重读 -> extractConfigExtras 链路。
  const tmp = path.join(os.tmpdir(), `asl-qa-v140-${Date.now()}.json`);
  try {
    // 1) 旧配置：含未知顶层键（cloudRelay/screenWatch/自定义键），无 blacklist
    const rawOnDisk = {
      agents: [{ id: 'doubao', name: '豆包' }],
      settings: { soundOn: true, soundVolume: 'medium', repeatAlert: false },
      window: { x: 10, y: 20 },
      watchers: [{ agent: 'doubao', process: 'doubao.exe', task: '桌面端在线' }],
      cloudRelay: false,
      screenWatch: false,
      futureUnknownKey: { nested: [1, 2, 3] },
    };
    // 2) loadConfig：提取 extras
    const configExtra = settingsOps.extractConfigExtras(rawOnDisk);
    // 3) 用户删除 doubao -> blacklistAgent 追加
    const list = Array.isArray(configExtra.autoDiscoverBlacklist)
      ? configExtra.autoDiscoverBlacklist
      : [];
    configExtra.autoDiscoverBlacklist = [...list, 'doubao'];
    // 4) writeConfigNow：组装完整 payload 落盘
    const payload = settingsOps.buildConfigPayload({
      extras: configExtra,
      agents: [],
      settings: rawOnDisk.settings,
      window: rawOnDisk.window,
      watchers: [],
    });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    // 5) 重读（模拟重启后的 loadConfig）
    const reread = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
    const extras2 = settingsOps.extractConfigExtras(reread);
    assert.deepStrictEqual(extras2.autoDiscoverBlacklist, ['doubao']);
    assert.strictEqual(extras2.cloudRelay, false, '未知顶层键 cloudRelay 丢失');
    assert.strictEqual(extras2.screenWatch, false, '未知顶层键 screenWatch 丢失');
    assert.deepStrictEqual(extras2.futureUnknownKey, { nested: [1, 2, 3] }, '自定义未知键丢失');
    // 6) 重读后 blacklist 仍挡住自动发现
    const out = findNewDiscoveries({
      procNames: new Set(['doubao.exe']),
      windowTitles: [],
      existingIds: new Set(),
      blacklist: extras2.autoDiscoverBlacklist,
    });
    assert.strictEqual(out.length, 0, 'blacklist 里的 doubao 被重新发现');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
});

test('总开关关闭语义的配置值保留：autoDiscover=false 经链路不丢', () => {
  const extras = settingsOps.extractConfigExtras({ autoDiscover: false, agents: [] });
  const payload = settingsOps.buildConfigPayload({
    extras, agents: [], settings: {}, window: null, watchers: [],
  });
  const reread = settingsOps.extractConfigExtras(JSON.parse(JSON.stringify(payload)));
  assert.strictEqual(reread.autoDiscover, false);
});

// ===========================================================================
// B. 对话列表
// ===========================================================================

test('activeT 超过 TTL 后归为非活跃', () => {
  const TTL = 3500; // SCREEN_ACTIVE_TTL_MS（agent-watcher 常量，若改需同步）
  const now = 1_000_000;
  const m = new Map([
    ['w1', { title: '对话A', activeT: now - TTL - 1 }], // 刚过期
    ['w2', { title: '对话B', activeT: now - TTL }], // 边界：仍在有效期内
    ['w3', { title: '对话C', activeT: now - 100 }], // 活跃
  ]);
  const list = formatScreenDialogs(m, now);
  assert.strictEqual(list.length, 3);
  const a = list.find((d) => d.title === '对话A');
  const b = list.find((d) => d.title === '对话B');
  const c = list.find((d) => d.title === '对话C');
  assert.strictEqual(a.active, false, '超过 TTL 仍为活跃');
  assert.strictEqual(b.active, true, 'TTL 边界值误判为非活跃');
  assert.strictEqual(c.active, true);
  // 活跃组（B、C）必须都排在非活跃的 A 前面
  assert.ok(list.indexOf(a) > list.indexOf(b) && list.indexOf(a) > list.indexOf(c),
    '活跃对话未排在非活跃之前');
});

test('activeT=0（从未活跃）归为非活跃；活跃在前排序稳定', () => {
  const now = 5000;
  const m = new Map([
    ['w1', { title: '旧窗口', activeT: 0 }],
    ['w2', { title: '热窗口', activeT: now - 10 }],
  ]);
  const list = formatScreenDialogs(m, now);
  assert.deepStrictEqual(list.map((d) => d.title), ['热窗口', '旧窗口']);
  assert.strictEqual(list[1].active, false);
});

test('screenWindows 为 null/空 Map 时返回空数组（进程退出后 dialogs 清空的直接依据）', () => {
  assert.deepStrictEqual(formatScreenDialogs(null, Date.now()), []);
  assert.deepStrictEqual(formatScreenDialogs(new Map(), Date.now()), []);
  assert.deepStrictEqual(formatScreenDialogs(undefined, Date.now()), []);
});

test('清理护栏：agent-watcher 源码存在窗口关闭清理 + 进程退出清空（内存泄漏回归）', () => {
  // tickScreen 的 seenIds 清理与 tickFast 的上下线硬切换是对话列表不泄漏的
  // 两道闸。逻辑本体依赖 electron 无法单测，这里把关键源码钉死：若有人改坏
  // 清理逻辑（删掉 delete / 置 null），测试立刻红。
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'agent-watcher.js'), 'utf-8');
  assert.ok(
    /for \(const id of st\.screenWindows\.keys\(\)\) \{\s*if \(!seenIds\.has\(id\)\) st\.screenWindows\.delete\(id\);/m.test(src),
    '窗口关闭后 screenWindows 的 seenIds 清理代码缺失（sourceId 键会无限增长）'
  );
  assert.ok(
    /st\.screenWindows = null;/.test(src),
    '进程上下线硬切换时 screenWindows 置空代码缺失（进程退出后 dialogs 残留）'
  );
  assert.ok(
    /st\.screenPrevMap = null;/.test(src),
    '进程上下线硬切换时 screenPrevMap 置空代码缺失（帧基线泄漏）'
  );
});

// ===========================================================================
// C. 声音
// ===========================================================================

test('soundVolume 非法值全部拒绝："loud"/空串/null/数字/大小写变体', () => {
  const base = { agents: [{ id: 'a1', name: 'A' }], watchers: [] };
  for (const bad of ['loud', '', null, 123, 'HIGH', 'Low', {}, ['high']]) {
    const r = settingsOps.validateSettingsPayload({ ...base, soundVolume: bad });
    assert.strictEqual(r.ok, false, `非法值 ${JSON.stringify(bad)} 未被拒绝`);
  }
});

test('soundVolume 缺省 high；undefined 不触发校验', () => {
  const r = settingsOps.validateSettingsPayload({ agents: [{ id: 'a1', name: 'A' }] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.soundVolume, 'high');
});

test('repeatAlert=false 落值为 false（不是被缺省回 true）', () => {
  const r = settingsOps.validateSettingsPayload({
    agents: [{ id: 'a1', name: 'A' }],
    repeatAlert: false,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.repeatAlert, false);
  // 非布尔脏值回落默认 true（面板永远传布尔，这里是容错）
  const r2 = settingsOps.validateSettingsPayload({
    agents: [{ id: 'a1', name: 'A' }],
    repeatAlert: 'no',
  });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.value.repeatAlert, true);
});

test('30s 循环守卫：App.jsx 源码存在 repeatAlert/soundOn 双开关与 clearInterval 清理', () => {
  // 渲染层定时器无法在无浏览器环境单测，源码级钉死三道闸：
  // 1) interval 回调内 repeatAlert === false 直接 return（循环不发声）
  // 2) soundOn === false 直接 return
  // 3) useEffect cleanup 里 clearInterval（卸载不叠音）
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf-8');
  assert.ok(
    /if \(!s\.soundOn \|\| s\.repeatAlert === false\) return;/.test(src),
    '30s 循环缺少 soundOn/repeatAlert 双开关守卫'
  );
  assert.ok(
    /return \(\) => clearInterval\(timer\);/.test(src),
    '30s 循环缺少 clearInterval 清理（组件卸载会叠音）'
  );
  assert.ok(
    /assist[\s\S]{0,200}stuck/.test(src) && /hasAssist[\s\S]{0,120}hasStuck/.test(src),
    'assist 优先 stuck 的发声顺序缺失'
  );
});

// ===========================================================================

console.log(`\n${passed}/${passed + failures.length} tests passed`);
if (failures.length > 0) process.exit(1);
