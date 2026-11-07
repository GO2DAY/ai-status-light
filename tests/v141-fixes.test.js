'use strict';

/**
 * tests/v141-fixes.test.js — v1.4.1 修复单测（无 electron 依赖）。
 *
 * 运行：node tests/v141-fixes.test.js
 *
 * 覆盖：
 *  1. P1 修复：settingsPanel 保存删除豁免（shouldSkipDeletion）
 *  2. blacklist 增删 helper + 解除后落盘回环
 *  3. 误报收紧：排除后缀（编辑器/浏览器标题）、短拉丁词窗口通道禁用
 */

const assert = require('assert');
const {
  AI_SIGNATURES,
  EXCLUDE_SUFFIXES,
  isWindowKeywordTrusted,
  signatureMatches,
  findNewDiscoveries,
} = require('../main/ai-signatures');
const settingsOps = require('../main/settings-ops');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. P1：面板保存删除豁免
// ---------------------------------------------------------------------------

test('豁免：origin=auto 且 discoveredAt 晚于快照 -> 跳过删除', () => {
  const agent = { id: 'kimi', origin: 'auto', discoveredAt: 2000 };
  assert.strictEqual(settingsOps.shouldSkipDeletion(agent, 1000), true);
});

test('不豁免：面板打开前就在的 auto agent（用户真的删它）', () => {
  const agent = { id: 'kimi', origin: 'auto', discoveredAt: 500 };
  assert.strictEqual(settingsOps.shouldSkipDeletion(agent, 1000), false);
});

test('不豁免：手动添加的 agent（无 origin）即使发现时间晚也照删', () => {
  const agent = { id: 'custom', discoveredAt: 9999 };
  assert.strictEqual(settingsOps.shouldSkipDeletion(agent, 1000), false);
  assert.strictEqual(settingsOps.shouldSkipDeletion({ id: 'x' }, 1000), false);
});

test('snapshotAt 缺省/非法（老路径）行为不变：不豁免', () => {
  const agent = { id: 'kimi', origin: 'auto', discoveredAt: 2000 };
  assert.strictEqual(settingsOps.shouldSkipDeletion(agent, undefined), false);
  assert.strictEqual(settingsOps.shouldSkipDeletion(agent, NaN), false);
  assert.strictEqual(settingsOps.shouldSkipDeletion(agent, 0), false);
});

// ---------------------------------------------------------------------------
// 2. blacklist helper + 解除后落盘回环
// ---------------------------------------------------------------------------

test('addToBlacklist：幂等、不改原数组', () => {
  const orig = ['doubao'];
  const next = settingsOps.addToBlacklist(orig, 'kimi');
  assert.deepStrictEqual(next, ['doubao', 'kimi']);
  assert.deepStrictEqual(orig, ['doubao']); // 原数组未被改动
  assert.deepStrictEqual(settingsOps.addToBlacklist(next, 'kimi'), ['doubao', 'kimi']);
  assert.deepStrictEqual(settingsOps.addToBlacklist(undefined, 'a'), ['a']);
});

test('removeFromBlacklist：移除目标、其他保留、不存在的 id 无副作用', () => {
  assert.deepStrictEqual(settingsOps.removeFromBlacklist(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepStrictEqual(settingsOps.removeFromBlacklist(['a'], 'zzz'), ['a']);
  assert.deepStrictEqual(settingsOps.removeFromBlacklist(undefined, 'a'), []);
});

test('解除黑名单后落盘回环：config 顶层 autoDiscoverBlacklist 不再含该 id', () => {
  // 模拟：config 里有黑名单 -> 解除 kimi -> buildConfigPayload 落盘 -> 重读
  const extras = { autoDiscoverBlacklist: ['doubao', 'kimi'], cloudRelay: true };
  extras.autoDiscoverBlacklist = settingsOps.removeFromBlacklist(
    extras.autoDiscoverBlacklist,
    'kimi'
  );
  const payload = settingsOps.buildConfigPayload({
    extras,
    agents: [{ id: 'doubao', name: '豆包' }],
    settings: { soundOn: true },
    window: { x: 0, y: 0 },
    watchers: [],
  });
  const roundTrip = JSON.parse(JSON.stringify(payload));
  assert.deepStrictEqual(roundTrip.autoDiscoverBlacklist, ['doubao']);
  assert.strictEqual(roundTrip.cloudRelay, true); // 其他 extras 不受影响
});

// ---------------------------------------------------------------------------
// 3. 误报收紧：排除后缀 + 短拉丁词
// ---------------------------------------------------------------------------

test('VS Code 标题不命中：codex-notes.md - Visual Studio Code', () => {
  const sig = AI_SIGNATURES.find((s) => s.id === 'codex');
  assert.strictEqual(
    signatureMatches(sig, new Set(), ['codex-notes.md - Visual Studio Code']),
    false
  );
});

test('浏览器标签不命中：Claude - Google Chrome / Kimi - Microsoft Edge', () => {
  const claude = AI_SIGNATURES.find((s) => s.id === 'claude');
  const kimi = AI_SIGNATURES.find((s) => s.id === 'kimi');
  assert.strictEqual(signatureMatches(claude, new Set(), ['Claude - Google Chrome']), false);
  assert.strictEqual(signatureMatches(kimi, new Set(), ['Kimi 新对话 - Microsoft Edge']), false);
});

test('进程通道不受收紧影响：Codex++.exe / claude.exe 正常命中', () => {
  const codex = AI_SIGNATURES.find((s) => s.id === 'codex');
  const claude = AI_SIGNATURES.find((s) => s.id === 'claude');
  assert.strictEqual(signatureMatches(codex, new Set(['codex++.exe']), []), true);
  assert.strictEqual(signatureMatches(claude, new Set(['claude.exe']), []), true);
});

test('短拉丁词窗口通道禁用，长拉丁词/中文词窗口通道保留', () => {
  assert.strictEqual(isWindowKeywordTrusted('Codex'), false); // 5
  assert.strictEqual(isWindowKeywordTrusted('Claude'), false); // 6
  assert.strictEqual(isWindowKeywordTrusted('Kimi'), false); // 4
  assert.strictEqual(isWindowKeywordTrusted('abu'), false); // 3
  assert.strictEqual(isWindowKeywordTrusted('Doubao'), false); // 6（窗口靠中文词）
  assert.strictEqual(isWindowKeywordTrusted('DeepSeek'), true); // 8
  assert.strictEqual(isWindowKeywordTrusted('Cherry Studio'), true); // 13
  assert.strictEqual(isWindowKeywordTrusted('豆包'), true); // 中文
  assert.strictEqual(isWindowKeywordTrusted(''), false);
});

test('长拉丁词在非排除标题里窗口命中正常（Cherry Studio 主窗口）', () => {
  const sig = AI_SIGNATURES.find((s) => s.id === 'cherry-studio');
  assert.strictEqual(signatureMatches(sig, new Set(), ['Cherry Studio']), true);
});

test('中文关键词在非排除标题里窗口命中正常（豆包主窗口）', () => {
  const sig = AI_SIGNATURES.find((s) => s.id === 'doubao');
  assert.strictEqual(signatureMatches(sig, new Set(), ['项目讨论 - 豆包']), true);
});

test('排除后缀常量数组可扩且全小写', () => {
  assert.ok(Array.isArray(EXCLUDE_SUFFIXES) && EXCLUDE_SUFFIXES.length >= 5);
  for (const suf of EXCLUDE_SUFFIXES) {
    assert.strictEqual(suf, suf.toLowerCase());
  }
});

test('findNewDiscoveries 端到端：VS Code 里的 codex 文件不会误报上灯', () => {
  const out = findNewDiscoveries({
    procNames: new Set(['code.exe']),
    windowTitles: ['codex-notes.md - Visual Studio Code', 'claude.ai - Google Chrome'],
    existingIds: new Set(),
    blacklist: [],
  });
  assert.deepStrictEqual(out, []);
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
