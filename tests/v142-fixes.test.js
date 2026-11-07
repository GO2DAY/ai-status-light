'use strict';

/**
 * tests/v142-fixes.test.js — v1.4.2 Bug 2 修复单测（无 electron 依赖）。
 *
 * 运行：node tests/v142-fixes.test.js
 *
 * Bug 2：settingsPanel:save 的 watchers 整体覆盖来自面板旧快照，
 * shouldSkipDeletion 豁免保住的 agent，其 watcher 被覆盖冲掉 → 死灯
 * （config 里 agent 有、watchers 无，进程不再被监测，灯永远停在 idle）。
 *
 * 这里用纯函数完整模拟保存链路，锁死「豁免 agent 与其 watcher 成对存活、
 * 真删 agent 与其 watcher 成对消失」的契约。
 */

const assert = require('assert');
const settingsOps = require('../main/settings-ops');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// mergeSparedWatchers 单元行为
// ---------------------------------------------------------------------------

test('豁免 agent 的 watcher 从内存并入保存结果', () => {
  const payloadWatchers = [{ agent: 'doubao', process: 'Doubao.exe', task: '桌面端在线' }];
  const currentWatchers = [
    { agent: 'doubao', process: 'Doubao.exe', task: '桌面端在线' },
    { agent: 'kimi', process: 'kimi.exe', task: '桌面端在线', window: ['Kimi'] },
  ];
  const out = settingsOps.mergeSparedWatchers(payloadWatchers, currentWatchers, new Set(['kimi']));
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[1], { agent: 'kimi', process: 'kimi.exe', task: '桌面端在线', window: ['Kimi'] });
});

test('payload 已含豁免 agent 的 watcher 时不重复并入', () => {
  const payloadWatchers = [{ agent: 'kimi', process: 'kimi-new.exe' }];
  const currentWatchers = [{ agent: 'kimi', process: 'kimi.exe' }];
  const out = settingsOps.mergeSparedWatchers(payloadWatchers, currentWatchers, new Set(['kimi']));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].process, 'kimi-new.exe'); // 以面板提交为准
});

test('未被豁免的缺失 watcher 不并入（用户真删场景）', () => {
  const payloadWatchers = [{ agent: 'doubao', process: 'Doubao.exe' }];
  const currentWatchers = [
    { agent: 'doubao', process: 'Doubao.exe' },
    { agent: 'kimi', process: 'kimi.exe' },
  ];
  const out = settingsOps.mergeSparedWatchers(payloadWatchers, currentWatchers, new Set());
  assert.strictEqual(out.length, 1);
});

test('sparedIds 为空/非 Set 时原样返回 payload（新数组）', () => {
  const payloadWatchers = [{ agent: 'a', process: 'a.exe' }];
  const out = settingsOps.mergeSparedWatchers(payloadWatchers, [{ agent: 'b', process: 'b.exe' }], new Set());
  assert.deepStrictEqual(out, payloadWatchers);
  assert.notStrictEqual(out, payloadWatchers); // 返回新数组
});

// ---------------------------------------------------------------------------
// 成对契约：完整保存链路模拟（agents 删除循环 + watchers 合并 + 落盘回环）
// ---------------------------------------------------------------------------

/** 模拟 settingsPanel:save 的核心链路（与 main.js 同一份纯函数）。 */
function simulateSave({ agentsMap, currentWatchers, payload, snapshotAt }) {
  const value = settingsOps.validateSettingsPayload(payload);
  assert.strictEqual(value.ok, true, value.error);
  const v = value.value;
  const keepIds = new Set(v.agents.map((a) => a.id));
  const sparedIds = new Set();
  const blacklist = [];
  for (const id of Array.from(agentsMap.keys())) {
    if (!keepIds.has(id)) {
      const agent = agentsMap.get(id);
      if (settingsOps.shouldSkipDeletion(agent, snapshotAt)) {
        sparedIds.add(id);
        continue;
      }
      agentsMap.delete(id);
      blacklist.push(id);
    }
  }
  const finalWatchers = settingsOps.mergeSparedWatchers(v.watchers, currentWatchers, sparedIds);
  // 落盘（与 writeConfigNow 相同的 agents 映射）
  const diskPayload = settingsOps.buildConfigPayload({
    extras: {},
    agents: Array.from(agentsMap.values()).map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.origin ? { origin: a.origin } : {}),
      ...(Number.isFinite(a.discoveredAt) ? { discoveredAt: a.discoveredAt } : {}),
    })),
    settings: {},
    window: { x: 0, y: 0 },
    watchers: finalWatchers,
  });
  return { disk: JSON.parse(JSON.stringify(diskPayload)), sparedIds, blacklist };
}

test('成对存活：面板快照后自动发现的 agent 保存后 agent+watcher 都在', () => {
  const agentsMap = new Map([
    ['doubao', { id: 'doubao', name: '豆包' }],
    // 面板快照(1000)之后自动发现的新 agent
    ['kimi', { id: 'kimi', name: 'Kimi', origin: 'auto', discoveredAt: 2000 }],
  ]);
  const currentWatchers = [
    { agent: 'doubao', process: 'Doubao.exe', task: '桌面端在线' },
    { agent: 'kimi', process: 'kimi.exe', task: '桌面端在线', window: ['Kimi'] },
  ];
  // 面板旧快照：只有 doubao
  const { disk, sparedIds, blacklist } = simulateSave({
    agentsMap,
    currentWatchers,
    snapshotAt: 1000,
    payload: {
      snapshotAt: 1000,
      agents: [{ id: 'doubao', name: '豆包' }],
      watchers: [{ agent: 'doubao', process: 'Doubao.exe' }],
    },
  });
  assert.ok(sparedIds.has('kimi'));
  assert.deepStrictEqual(blacklist, []); // 豁免的不拉黑
  const diskAgents = disk.agents.map((a) => a.id);
  const diskWatcherAgents = disk.watchers.map((w) => w.agent);
  assert.ok(diskAgents.includes('kimi'), 'agent kimi 必须活着');
  assert.ok(diskWatcherAgents.includes('kimi'), 'watcher kimi 必须成对活着（死灯修复点）');
  // origin/discoveredAt 随盘持久化（重启后豁免判定仍成立）
  const kimi = disk.agents.find((a) => a.id === 'kimi');
  assert.strictEqual(kimi.origin, 'auto');
  assert.strictEqual(kimi.discoveredAt, 2000);
});

test('成对消失：重启面板新快照后真删，agent+watcher 一起没了', () => {
  const agentsMap = new Map([
    ['doubao', { id: 'doubao', name: '豆包' }],
    ['kimi', { id: 'kimi', name: 'Kimi', origin: 'auto', discoveredAt: 2000 }],
  ]);
  const currentWatchers = [
    { agent: 'doubao', process: 'Doubao.exe' },
    { agent: 'kimi', process: 'kimi.exe', window: ['Kimi'] },
  ];
  // 新快照(3000 > discoveredAt 2000)：kimi 已在面板里，用户点删除 -> 不在 payload
  const { disk, sparedIds, blacklist } = simulateSave({
    agentsMap,
    currentWatchers,
    snapshotAt: 3000,
    payload: {
      snapshotAt: 3000,
      agents: [{ id: 'doubao', name: '豆包' }],
      watchers: [{ agent: 'doubao', process: 'Doubao.exe' }],
    },
  });
  assert.strictEqual(sparedIds.size, 0); // 新快照下不豁免
  assert.deepStrictEqual(blacklist, ['kimi']); // 真删要拉黑
  assert.deepStrictEqual(disk.agents.map((a) => a.id), ['doubao']);
  assert.deepStrictEqual(disk.watchers.map((w) => w.agent), ['doubao']);
});

test('兜底：payload 里豁免 agent 的 watcher 被删，也按成对存活补回', () => {
  // 极端场景：豁免 agent 的 watcher 在 payload 里缺失（无论何种原因），
  // mergeSparedWatchers 都会用内存条目补回——灯不会死。
  const agentsMap = new Map([
    ['kimi', { id: 'kimi', name: 'Kimi', origin: 'auto', discoveredAt: 2000 }],
  ]);
  const currentWatchers = [{ agent: 'kimi', process: 'kimi.exe', window: ['Kimi'] }];
  const { disk } = simulateSave({
    agentsMap,
    currentWatchers,
    snapshotAt: 1000,
    payload: { snapshotAt: 1000, agents: [], watchers: [] },
  });
  assert.deepStrictEqual(disk.agents.map((a) => a.id), ['kimi']);
  assert.deepStrictEqual(disk.watchers.map((w) => w.agent), ['kimi']);
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
