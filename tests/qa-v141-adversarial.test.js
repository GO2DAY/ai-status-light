'use strict';

/**
 * tests/qa-v141-adversarial.test.js — v1.4.1 P1 修复 + 误报收紧的对抗性复核（QA 严过关 R2）。
 *
 * 不复用工程师的 v141-fixes 测试，全部独立构造：
 *   A. P1 豁免语义闭环：豁免 → 重启面板 → 用户真删 的完整路径
 *   B. discoveredAt == snapshotAt 等边界
 *   C. unblacklist 后重新发现的豁免判定
 *   D. 【对抗】豁免 agent 的 watcher 是否在面板保存后存活（配置一致性）
 *   E. 误报收紧对抗：编辑器/浏览器/大小写变体/短词双命中
 *
 * 运行：node tests/qa-v141-adversarial.test.js
 */

const assert = require('assert');
const settingsOps = require('../main/settings-ops');
const { signatureMatches, findNewDiscoveries, AI_SIGNATURES } = require('../main/ai-signatures');

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

const { shouldSkipDeletion, removeFromBlacklist } = settingsOps;

/**
 * 复刻 main.js settingsPanel:save 的关键状态转移（main.js:1766-1791），
 * 用于行为级验证「保存后内存配置的一致性」。main.js 本体依赖 electron
 * 不可单测，此模拟与源码逐行对应，源码改语义这里要同步。
 */
function simulatePanelSave({ agentsMap, watchersConfig, payload }) {
  const result = settingsOps.validateSettingsPayload(payload);
  assert.strictEqual(result.ok, true, `payload 校验失败: ${result.error}`);
  const value = result.value;
  const snapshotAt = payload && Number.isFinite(payload.snapshotAt) ? payload.snapshotAt : 0;
  const keepIds = new Set(value.agents.map((a) => a.id));
  const sparedIds = new Set(); // v1.4.2：与 main.js sparedIds 同步
  for (const id of Array.from(agentsMap.keys())) {
    if (!keepIds.has(id)) {
      const agent = agentsMap.get(id);
      if (shouldSkipDeletion(agent, snapshotAt)) {
        sparedIds.add(id); // main.js 豁免 + 记录
        continue;
      }
      agentsMap.delete(id);
    }
  }
  // v1.4.2 Bug 2 修复（与 main.js 同步）：豁免 agent 的 watcher 成对补回，
  // 不再是 value.watchers 裸整体覆盖
  const newWatchers = settingsOps.mergeSparedWatchers(value.watchers, watchersConfig, sparedIds);
  return { agentsMap, watchersConfig: newWatchers };
}

// ===========================================================================
// A. P1 豁免语义闭环
// ===========================================================================

test('闭环：快照后自动发现被豁免；重启面板后（新快照）用户可正常删除', () => {
  const T0 = 1_000_000; // 面板第一次快照
  const T1 = T0 + 60_000; // 自动发现时刻（快照后）
  const agent = { id: 'doubao', name: '豆包', origin: 'auto', discoveredAt: T1 };
  // 第一次保存：豁免
  assert.strictEqual(shouldSkipDeletion(agent, T0), true, '快照后发现的 agent 未豁免');
  // 用户重启面板：新快照 T2 > T1，agent 出现在面板列表里
  const T2 = T1 + 60_000;
  // 用户在新面板里点删除 -> agent 不在 keepIds -> 此时不应豁免（面板看得见它，删是真意图）
  assert.strictEqual(shouldSkipDeletion(agent, T2), false, '重启面板后仍被豁免，用户永远删不掉');
});

test('边界：discoveredAt == snapshotAt 不豁免；+1ms 豁免', () => {
  const T = 1_000_000;
  const eq = { id: 'a', origin: 'auto', discoveredAt: T };
  const gt = { id: 'a', origin: 'auto', discoveredAt: T + 1 };
  assert.strictEqual(shouldSkipDeletion(eq, T), false, '相等时刻被豁免（并发同刻的保存会漏删）');
  assert.strictEqual(shouldSkipDeletion(gt, T), true);
});

test('边界：snapshotAt 缺省/NaN/0/负数/字符串 一律不豁免（老行为）', () => {
  const agent = { id: 'a', origin: 'auto', discoveredAt: 999_999 };
  for (const bad of [undefined, NaN, 0, -5, '1000000', null, Infinity]) {
    assert.strictEqual(shouldSkipDeletion(agent, bad), false,
      `snapshotAt=${String(bad)} 被豁免`);
  }
});

test('边界：origin 缺失/非 auto、discoveredAt 非法 一律不豁免', () => {
  const T = 1_000_000;
  assert.strictEqual(shouldSkipDeletion({ id: 'a' }, T - 1), false); // 无 origin（手动添加）
  assert.strictEqual(shouldSkipDeletion({ id: 'a', origin: 'manual', discoveredAt: T + 1 }, T), false);
  assert.strictEqual(shouldSkipDeletion({ id: 'a', origin: 'auto' }, T - 1), false); // 无 discoveredAt
  assert.strictEqual(shouldSkipDeletion({ id: 'a', origin: 'auto', discoveredAt: NaN }, T - 1), false);
  assert.strictEqual(shouldSkipDeletion({ id: 'a', origin: 'auto', discoveredAt: '999' }, T - 1), false);
  assert.strictEqual(shouldSkipDeletion(null, T - 1), false);
});

// ===========================================================================
// C. unblacklist 后重新发现
// ===========================================================================

test('unblacklist 后可重新发现，新 discoveredAt 驱动豁免判定（不受旧时间影响）', () => {
  // 1) 用户曾删除 doubao -> 黑名单
  let blacklist = ['doubao'];
  let out = findNewDiscoveries({
    procNames: new Set(['doubao.exe']), windowTitles: [],
    existingIds: new Set(), blacklist,
  });
  assert.strictEqual(out.length, 0, '黑名单未挡住发现');
  // 2) 设置面板解除拉黑
  blacklist = removeFromBlacklist(blacklist, 'doubao');
  assert.deepStrictEqual(blacklist, []);
  // 3) 下轮扫描重新发现
  out = findNewDiscoveries({
    procNames: new Set(['doubao.exe']), windowTitles: [],
    existingIds: new Set(), blacklist,
  });
  assert.strictEqual(out.length, 1, '解除拉黑后未重新发现');
  // 4) main.js 重建条目时打的是「重新发现时刻」的新 discoveredAt：
  //    若此刻面板开着（快照更早），保存仍豁免 —— 语义自洽
  const rediscovered = { id: 'doubao', origin: 'auto', discoveredAt: Date.now() };
  assert.strictEqual(shouldSkipDeletion(rediscovered, Date.now() - 60_000), true);
  // 5) origin 标记只随 agents 条目存亡：agent 被删（非豁免路径）时条目销毁，
  //    重新发现是全新条目 —— 不存在"旧 origin 残留影响豁免"的路径
});

// ===========================================================================
// D.【对抗】豁免 agent 的 watcher 在面板保存后必须存活
// ===========================================================================

test('配置一致性：被豁免的自动发现 agent，其 watcher 在保存后仍存活', () => {
  const T0 = 1_000_000;
  const agentsMap = new Map([
    ['workbuddy', { id: 'workbuddy', name: 'WorkBuddy' }], // 手动添加，无 origin
    ['doubao', { id: 'doubao', name: '豆包', origin: 'auto', discoveredAt: T0 + 30_000 }], // 快照后发现
  ]);
  const watchersConfig = [
    { agent: 'doubao', process: 'doubao.exe', task: '桌面端在线', window: ['豆包', 'Doubao'] },
  ];
  // 面板快照（T0）里没有 doubao —— payload 是快照内容
  const payload = {
    agents: [{ id: 'workbuddy', name: 'WorkBuddy' }],
    watchers: [],
    snapshotAt: T0,
  };
  const after = simulatePanelSave({ agentsMap, watchersConfig, payload });
  // 豁免生效：doubao 灯源还在
  assert.ok(after.agentsMap.has('doubao'), 'P1 修复失效：豁免 agent 被删');
  // 但它的 watcher 也必须活着 —— 否则豆包变成死灯：进程上下线无人上报，
  // 状态永远停在「新发现·待确认」，重启后 loadConfig 同样无 watcher 可加载
  const doubaoWatcher = after.watchersConfig.find((w) => w.agent === 'doubao');
  assert.ok(doubaoWatcher,
    '豁免 agent 的 watcher 被 value.watchers 整体覆盖冲掉（main.js:1791）——灯保住了但监测死了');
});

test('配置一致性：落盘 payload 中豁免 agent 与其 watcher 必须成对出现', () => {
  // 直接验证 writeConfigNow 的输入契约：agents 里有的每个自动发现条目，
  // 若发现时配了 watcher，落盘 watchers 里必须有对应条目。
  // v1.4.2：watchersOnDisk 不再手捏"覆盖后的坏状态"，而是走修复后的真实
  // 链路（mergeSparedWatchers）产出——豁免 agent 的 watcher 被成对补回。
  const agentsOnDisk = [{ id: 'workbuddy', name: 'WorkBuddy' }, { id: 'doubao', name: '豆包', origin: 'auto', discoveredAt: 1_000_030_000 }];
  const currentWatchers = [
    { agent: 'doubao', process: 'doubao.exe', task: '桌面端在线', window: ['豆包', 'Doubao'] },
  ];
  const sparedIds = new Set(['doubao']); // doubao 是快照后发现、被豁免
  const watchersOnDisk = settingsOps.mergeSparedWatchers([], currentWatchers, sparedIds);
  const payload = settingsOps.buildConfigPayload({
    extras: {}, agents: agentsOnDisk, settings: {}, window: null, watchers: watchersOnDisk,
  });
  const orphanAgents = payload.agents
    .filter((a) => a.origin === 'auto')
    .filter((a) => !payload.watchers.some((w) => w.agent === a.id));
  assert.deepStrictEqual(orphanAgents.map((a) => a.id), [],
    `落盘配置里存在无 watcher 的自动发现 agent: ${orphanAgents.map((a) => a.id).join(',')}`);
});

// ===========================================================================
// E. 误报收紧对抗
// ===========================================================================

const sig = (id) => AI_SIGNATURES.find((s) => s.id === id);

test('对抗："My Claude Notes - Visual Studio Code" 不命中 Claude', () => {
  assert.strictEqual(
    signatureMatches(sig('claude'), new Set(), ['My Claude Notes - Visual Studio Code']),
    false, 'VS Code 标题里的 Claude 仍命中'
  );
});

test('对抗：claude.exe 进程在列 = 命中（进程通道不受收紧影响，即使窗口是浏览器）', () => {
  assert.strictEqual(
    signatureMatches(sig('claude'), new Set(['claude.exe']), ['Claude - Google Chrome']),
    true, '进程通道被误收紧'
  );
});

test('对抗："阿布 - Microsoft Edge" 不命中阿布（中文词也过排除后缀闸）', () => {
  assert.strictEqual(
    signatureMatches(sig('abu'), new Set(), ['阿布 - Microsoft Edge']),
    false, 'Edge 浏览器里的阿布仍命中'
  );
});

test('对抗：大小写变体 "claude.ai - GOOGLE CHROME" 不命中', () => {
  assert.strictEqual(
    signatureMatches(sig('claude'), new Set(), ['claude.ai - GOOGLE CHROME']),
    false, '大写 GOOGLE CHROME 后缀未被排除'
  );
});

test('对抗："豆包 - Google Chrome"（网页版）不命中豆包；桌面窗口仍命中', () => {
  assert.strictEqual(
    signatureMatches(sig('doubao'), new Set(), ['豆包 - Google Chrome']),
    false, '浏览器里的豆包网页版仍命中'
  );
  assert.strictEqual(
    signatureMatches(sig('doubao'), new Set(), ['关公推文怎么写 - 豆包']),
    true, '豆包桌面窗口被误伤'
  );
});

test('对抗：Kimi CLI 窗口只命中 kimi-cli，不再双重命中 kimi', () => {
  const out = findNewDiscoveries({
    procNames: new Set(),
    windowTitles: ['Kimi CLI'],
    existingIds: new Set(),
    blacklist: [],
  });
  const ids = out.map((d) => d.id);
  assert.ok(ids.includes('kimi-cli'), 'Kimi CLI 窗口未命中 kimi-cli');
  assert.ok(!ids.includes('kimi'), 'Kimi CLI 窗口同时误命中 kimi（短词未禁用）');
});

test('对抗：Codex++ 桌面窗口（无编辑器后缀）长词通道不再命中但进程命中兜底', () => {
  // "Codex" 6 字符 ≤6 -> 窗口通道禁用。桌面版 Codex++ 靠 codex.exe/codex++.exe 进程命中。
  assert.strictEqual(
    signatureMatches(sig('codex'), new Set(), ['Codex']),
    false, '纯窗口标题 "Codex" 仍命中（短词闸门失效）'
  );
  assert.strictEqual(
    signatureMatches(sig('codex'), new Set(['codex++.exe']), []),
    true, 'codex++.exe 进程通道失效'
  );
});

// ===========================================================================

console.log(`\n${passed}/${passed + failures.length} tests passed`);
if (failures.length > 0) process.exit(1);
