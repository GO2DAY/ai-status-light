'use strict';

/**
 * tests/qa-v142-pairwise.test.js — v1.4.2 Bug 2 修复的独立落盘级验证（QA 严过关 R3）。
 *
 * 与工程师的 v142-fixes 测试无关、与 qa-v141-adversarial 的内存级模拟也不同：
 * 这里走完整「validate → sparedIds → mergeSparedWatchers → buildConfigPayload →
 * 临时文件落盘 → 重读」链路，断言 config.json 层面的最终事实：
 *   1. 豁免场景：agent+watcher 成对存活，origin/discoveredAt 随盘持久化，不进黑名单
 *   2. 真删场景（重启面板后用户真删）：agent+watcher 成对消失，进黑名单
 *   3. 面板提交优先：用户在面板里手动配的 watcher 不被 merge 弄丢/覆盖
 *
 * 运行：node tests/qa-v142-pairwise.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settingsOps = require('../main/settings-ops');

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

/**
 * 落盘级模拟 main.js settingsPanel:save + writeConfigNow 全链路
 * （main.js:1769-1808 逐行对应），返回重读后的 config 对象。
 */
function simulateSaveAndReload({ agentsMap, watchersConfig, configExtra, payload, tmpFile }) {
  const result = settingsOps.validateSettingsPayload(payload);
  assert.strictEqual(result.ok, true, `payload 校验失败: ${result.error}`);
  const value = result.value;
  const snapshotAt = payload && Number.isFinite(payload.snapshotAt) ? payload.snapshotAt : 0;

  // main.js:1770-1783 删除循环（含 v1.4.1 豁免 + v1.4.2 sparedIds 收集 + 拉黑）
  const keepIds = new Set(value.agents.map((a) => a.id));
  const sparedIds = new Set();
  for (const id of Array.from(agentsMap.keys())) {
    if (!keepIds.has(id)) {
      const agent = agentsMap.get(id);
      if (settingsOps.shouldSkipDeletion(agent, snapshotAt)) {
        sparedIds.add(id);
        continue;
      }
      agentsMap.delete(id);
      configExtra.autoDiscoverBlacklist = settingsOps.addToBlacklist(
        configExtra.autoDiscoverBlacklist, id
      );
    }
  }
  // main.js:1796 v1.4.2 merge（替代裸覆盖）
  const newWatchers = settingsOps.mergeSparedWatchers(value.watchers, watchersConfig, sparedIds);

  // writeConfigNow：agents 序列化含 origin/discoveredAt 持久化（main.js:299-302）
  const diskPayload = settingsOps.buildConfigPayload({
    extras: configExtra,
    agents: Array.from(agentsMap.values()).map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.origin ? { origin: a.origin } : {}),
      ...(Number.isFinite(a.discoveredAt) ? { discoveredAt: a.discoveredAt } : {}),
    })),
    settings: { soundOn: true, soundVolume: 'high', repeatAlert: true },
    window: { x: 1, y: 2 },
    watchers: newWatchers,
  });
  fs.writeFileSync(tmpFile, JSON.stringify(diskPayload, null, 2), 'utf-8');
  return JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
}

function withTmp(fn) {
  const tmp = path.join(os.tmpdir(), `asl-qa-v142-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fn(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ===========================================================================

test('豁免场景：落盘后 agent+watcher 成对存活，origin/discoveredAt 持久化，不进黑名单', () => {
  withTmp((tmp) => {
    const T0 = 1_000_000;
    const agentsMap = new Map([
      ['workbuddy', { id: 'workbuddy', name: 'WorkBuddy' }],
      ['doubao', { id: 'doubao', name: '豆包', origin: 'auto', discoveredAt: T0 + 30_000 }],
    ]);
    const watchersConfig = [
      { agent: 'doubao', process: 'doubao.exe', task: '桌面端在线', window: ['豆包', 'Doubao'] },
    ];
    const configExtra = { cloudRelay: false };
    const reloaded = simulateSaveAndReload({
      agentsMap, watchersConfig, configExtra,
      payload: { agents: [{ id: 'workbuddy', name: 'WorkBuddy' }], watchers: [], snapshotAt: T0 },
      tmpFile: tmp,
    });
    // agent 在
    const doubao = reloaded.agents.find((a) => a.id === 'doubao');
    assert.ok(doubao, '豁免 agent 未落盘');
    // origin/discoveredAt 随盘持久化（重启后面板豁免判定仍成立的前提）
    assert.strictEqual(doubao.origin, 'auto', 'origin 未持久化');
    assert.strictEqual(doubao.discoveredAt, T0 + 30_000, 'discoveredAt 未持久化');
    // watcher 成对在
    const w = reloaded.watchers.find((x) => x.agent === 'doubao');
    assert.ok(w, '豁免 agent 的 watcher 未落盘（Bug 2 未修复）');
    assert.strictEqual(w.process, 'doubao.exe');
    assert.deepStrictEqual(w.window, ['豆包', 'Doubao'], 'watcher 的 window 关键词丢失');
    // 不进黑名单
    assert.ok(!Array.isArray(reloaded.autoDiscoverBlacklist) ||
      !reloaded.autoDiscoverBlacklist.includes('doubao'), '豁免 agent 被误拉黑');
    // 未知顶层键保留
    assert.strictEqual(reloaded.cloudRelay, false);
  });
});

test('真删场景：重启面板后用户删除，agent+watcher 成对消失并进黑名单', () => {
  withTmp((tmp) => {
    const T0 = 1_000_000;
    const agentsMap = new Map([
      ['workbuddy', { id: 'workbuddy', name: 'WorkBuddy' }],
      // 面板重启后拿到新快照 T2 > discoveredAt：agent 在面板里，用户点删除 = 真删
      ['doubao', { id: 'doubao', name: '豆包', origin: 'auto', discoveredAt: T0 + 30_000 }],
    ]);
    const watchersConfig = [
      { agent: 'doubao', process: 'doubao.exe', task: '桌面端在线' },
    ];
    const configExtra = {};
    const reloaded = simulateSaveAndReload({
      agentsMap, watchersConfig, configExtra,
      payload: { agents: [{ id: 'workbuddy', name: 'WorkBuddy' }], watchers: [], snapshotAt: T0 + 120_000 },
      tmpFile: tmp,
    });
    assert.ok(!reloaded.agents.some((a) => a.id === 'doubao'), '真删 agent 仍在');
    assert.ok(!reloaded.watchers.some((w) => w.agent === 'doubao'),
      '真删 agent 的 watcher 残留（merge 把非豁免 id 也补回了）');
    assert.deepStrictEqual(reloaded.autoDiscoverBlacklist, ['doubao'], '真删未进黑名单');
  });
});

test('面板提交优先：用户手动配的 watcher 不被 merge 弄丢，豁免补回不覆盖同 agent 条目', () => {
  withTmp((tmp) => {
    const T0 = 1_000_000;
    const agentsMap = new Map([
      ['workbuddy', { id: 'workbuddy', name: 'WorkBuddy' }],
      ['doubao', { id: 'doubao', name: '豆包', origin: 'auto', discoveredAt: T0 + 30_000 }],
    ]);
    // 内存里 doubao 的 watcher 是自动发现时建的
    const watchersConfig = [
      { agent: 'doubao', process: 'doubao.exe', task: '桌面端在线' },
    ];
    // 面板快照里用户给 workbuddy 配了 watcher（payload 的权威内容）
    const reloaded = simulateSaveAndReload({
      agentsMap, watchersConfig, configExtra: {},
      payload: {
        agents: [{ id: 'workbuddy', name: 'WorkBuddy' }],
        watchers: [{ agent: 'workbuddy', process: 'workbuddy.exe', window: 'WorkBuddy' }],
        snapshotAt: T0,
      },
      tmpFile: tmp,
    });
    const wbW = reloaded.watchers.find((w) => w.agent === 'workbuddy');
    assert.ok(wbW, '面板手动配的 watcher 被 merge 弄丢');
    assert.strictEqual(wbW.process, 'workbuddy.exe');
    // doubao 豁免补回，且只有一条（不重复）
    const dbWs = reloaded.watchers.filter((w) => w.agent === 'doubao');
    assert.strictEqual(dbWs.length, 1, `豁免补回应恰好 1 条，实际 ${dbWs.length}`);
    // 面板提交在前：workbuddy 的条目排在自动补回之前
    assert.ok(
      reloaded.watchers.findIndex((w) => w.agent === 'workbuddy') <
      reloaded.watchers.findIndex((w) => w.agent === 'doubao'),
      '面板提交的 watcher 未排在前（用户意图应优先于自动补回）'
    );
  });
});

// ===========================================================================

console.log(`\n${passed}/${passed + failures.length} tests passed`);
if (failures.length > 0) process.exit(1);
