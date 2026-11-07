'use strict';

/**
 * tests/auto-discover.test.js — v1.4.0 新功能单测（无 electron 依赖）。
 *
 * 运行：node tests/auto-discover.test.js
 *
 * 覆盖：
 *  1. 特征库匹配（进程命中/窗口命中/大小写/未命中）
 *  2. findNewDiscoveries 过滤（已存在/blacklist/返回结构）
 *  3. 对话列表组装 formatScreenDialogs（活跃在前/TTL/空表）
 *  4. settings-ops 的 v1.4.0 新字段（soundVolume 档位校验/repeatAlert/autoDiscover）
 */

const assert = require('assert');
const { AI_SIGNATURES, signatureMatches, findNewDiscoveries } = require('../main/ai-signatures');
const agentWatcher = require('../main/agent-watcher');
const settingsOps = require('../main/settings-ops');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. 特征库匹配
// ---------------------------------------------------------------------------

test('进程命中：Doubao.exe 大写混写也能匹配', () => {
  const sig = AI_SIGNATURES.find((s) => s.id === 'doubao');
  assert.strictEqual(signatureMatches(sig, new Set(['doubao.exe']), []), true);
  assert.strictEqual(signatureMatches(sig, new Set(['Doubao.EXE'.toLowerCase()]), []), true);
});

test('窗口命中：进程表没有但窗口标题含可信关键词（>6 字符拉丁词）', () => {
  // v1.4.1 收紧后：短拉丁词（Kimi 4 字符）窗口通道不再可信，
  // 用 8 字符的 DeepSeek 验证长词窗口通道保留。
  const sig = AI_SIGNATURES.find((s) => s.id === 'deepseek');
  assert.strictEqual(signatureMatches(sig, new Set(), ['DeepSeek - 新对话']), true);
});

test('未命中：进程和窗口都不沾边', () => {
  const sig = AI_SIGNATURES.find((s) => s.id === 'claude');
  assert.strictEqual(signatureMatches(sig, new Set(['chrome.exe']), ['我的文档 - Word']), false);
});

test('出厂库条目结构合法：id 合规、有进程或窗口词', () => {
  for (const sig of AI_SIGNATURES) {
    assert.ok(settingsOps.AGENT_ID_PATTERN.test(sig.id), `id 不合规: ${sig.id}`);
    assert.ok(sig.name, `缺 name: ${sig.id}`);
    assert.ok(
      (sig.processes && sig.processes.length) || (sig.windowKeywords && sig.windowKeywords.length),
      `既无进程又无窗口词: ${sig.id}`
    );
  }
  const ids = AI_SIGNATURES.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, '特征库 id 有重复');
});

// ---------------------------------------------------------------------------
// 2. findNewDiscoveries 过滤
// ---------------------------------------------------------------------------

test('已存在的 id（agent 或 watcher）不再发现', () => {
  const out = findNewDiscoveries({
    procNames: new Set(['doubao.exe', 'kimi.exe']),
    windowTitles: [],
    existingIds: new Set(['doubao']),
    blacklist: [],
  });
  assert.deepStrictEqual(out.map((s) => s.id), ['kimi']);
});

test('blacklist 里的 id 命中也不加回', () => {
  const out = findNewDiscoveries({
    procNames: new Set(['doubao.exe']),
    windowTitles: ['豆包 - 新对话'],
    existingIds: new Set(),
    blacklist: ['doubao'],
  });
  assert.deepStrictEqual(out, []);
});

test('返回结构：命中进程取实际进程名，窗口词原样带上', () => {
  const out = findNewDiscoveries({
    procNames: new Set(['doubao.exe']),
    windowTitles: [],
    existingIds: new Set(),
    blacklist: [],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'doubao');
  assert.strictEqual(out[0].name, '豆包');
  assert.strictEqual(out[0].process, 'doubao.exe');
  assert.deepStrictEqual(out[0].windowKeywords, ['豆包', 'Doubao']);
});

test('纯窗口命中（进程名猜错）也能发现，process 回退到 processes[0]', () => {
  const out = findNewDiscoveries({
    procNames: new Set(),
    windowTitles: ['Cherry Studio'],
    existingIds: new Set(),
    blacklist: [],
  });
  const cherry = out.find((s) => s.id === 'cherry-studio');
  assert.ok(cherry, 'cherry-studio 应被窗口关键词发现');
  assert.strictEqual(cherry.process, 'cherry studio.exe'); // processes[0] 占位
});

// ---------------------------------------------------------------------------
// 3. 对话列表组装（agent-watcher.formatScreenDialogs，纯函数）
// ---------------------------------------------------------------------------

test('对话列表：活跃在前，TTL 内算活跃，超时算静止', () => {
  const now = 100_000;
  const map = new Map([
    ['w1', { title: '对话甲', activeT: now - 1000 }], // 1s 前活跃 -> active
    ['w2', { title: '对话乙', activeT: now - 60_000 }], // 60s 前 -> 不活跃
    ['w3', { title: '对话丙', activeT: 0 }], // 从未活跃
  ]);
  const out = agentWatcher.formatScreenDialogs(map, now);
  assert.deepStrictEqual(out, [
    { title: '对话甲', active: true },
    { title: '对话乙', active: false },
    { title: '对话丙', active: false },
  ]);
});

test('对话列表：空/无效输入返回空数组；无标题条目被剔除', () => {
  assert.deepStrictEqual(agentWatcher.formatScreenDialogs(null, 1), []);
  assert.deepStrictEqual(agentWatcher.formatScreenDialogs(new Map(), 1), []);
  assert.deepStrictEqual(
    agentWatcher.formatScreenDialogs(new Map([['w1', { title: '', activeT: 1 }]]), 2),
    []
  );
});

// ---------------------------------------------------------------------------
// 4. settings-ops 的 v1.4.0 新字段
// ---------------------------------------------------------------------------

test('soundVolume：合法档位通过，非法档位拒绝，缺省 high', () => {
  for (const v of ['low', 'medium', 'high']) {
    const r = settingsOps.validateSettingsPayload({
      agents: [{ id: 'a', name: 'A' }],
      soundVolume: v,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.soundVolume, v);
  }
  const bad = settingsOps.validateSettingsPayload({
    agents: [{ id: 'a', name: 'A' }],
    soundVolume: 'loud',
  });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /音量/);
  const dflt = settingsOps.validateSettingsPayload({ agents: [{ id: 'a', name: 'A' }] });
  assert.strictEqual(dflt.value.soundVolume, 'high');
});

test('repeatAlert / autoDiscover：缺省 true，显式 false 通过', () => {
  const dflt = settingsOps.validateSettingsPayload({ agents: [{ id: 'a', name: 'A' }] });
  assert.strictEqual(dflt.value.repeatAlert, true);
  assert.strictEqual(dflt.value.autoDiscover, true);
  const off = settingsOps.validateSettingsPayload({
    agents: [{ id: 'a', name: 'A' }],
    repeatAlert: false,
    autoDiscover: false,
  });
  assert.strictEqual(off.value.repeatAlert, false);
  assert.strictEqual(off.value.autoDiscover, false);
});

// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err && err.stack);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed${process.exitCode ? ' (with failures)' : ''}`);
})();
