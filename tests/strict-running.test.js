'use strict';

/**
 * tests/strict-running.test.js — 「误判绿 / 僵尸黄灯」修复回归（纯 node，离线）。
 *
 * 运行：node tests/strict-running.test.js
 *
 * 全部用例只依赖纯函数 / 静态源码锚点 / vm 沙箱：
 *   - 不 require main.js（顶层 require('electron')，纯 node 加载不了）
 *   - 不启动 agent-watcher 的任何计时器
 *   - 不调用 post()／不发送任何 /status 请求（不碰 127.0.0.1:17890）
 *
 * 规格 6 条必测：
 *   1. 前台命中但无 CPU/画面/会话标题 -> 不产生 running 上报（用户报的 bug）
 *   2. CPU 热 -> 产生 running 上报
 *   3. 有会话标题 -> 产生 running 上报
 *   4. strictRunning:false -> 恢复旧行为（前台即可绿）
 *   5. 自动发现初始状态为 offline 且 lastHeartbeat === 0
 *   6. 未上线且从未上报 -> 只补一次 offline，不重复发
 * 另加：帧尺寸变化、会话标题信号、stale 字段、i18n 双语、tooltip 渲染、
 *       strictRunning 开关可逆性（配置未知键写回不丢）、前台分支不再直接点绿。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const agentWatcher = require('../main/agent-watcher');
const { discoveredAgentState } = require('../main/ai-signatures');
const { extractConfigExtras, buildConfigPayload } = require('../main/settings-ops');
const i18n = require('../main/i18n');

const {
  dialogName,
  screenDiffRatio,
  hasSessionTitleSignal,
  decideFastStatus,
  shouldPostOfflineForUnknown,
} = agentWatcher.__test;

const ROOT = path.join(__dirname, '..');
const awSrc = fs.readFileSync(path.join(ROOT, 'main', 'agent-watcher.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
const tipHtml = fs.readFileSync(path.join(ROOT, 'main', 'tooltip.html'), 'utf8');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** decideFastStatus 用的最小运行时状态快照（纯对象，便于造边界）。 */
function state(overrides) {
  return {
    last: 'idle',
    cpuRate: 0,
    screenWinCount: 0,
    screenDialog: '',
    cool: 999, // 冷却期满（旧行为 idle 回落判定用）
    ...(overrides || {}),
  };
}

/** 默认严格模式入参。 */
function opts(overrides) {
  return {
    strictRunning: true,
    st: state(),
    fgHit: false,
    fgDebounced: false,
    cpuHot: false,
    screenHot: false,
    hasSessionTitle: false,
    ...(overrides || {}),
  };
}

// ---------------------------------------------------------------------------
// 规格 1~4：融合判定（纯函数）
// ---------------------------------------------------------------------------

test('1. 前台命中但无 CPU/画面/会话标题 -> 不产生 running 上报（用户报的 bug）', () => {
  // 只打开马维斯、没登录：前台 >=1.5s 也不得点绿
  assert.strictEqual(
    decideFastStatus(opts({ fgHit: true, fgDebounced: true, cpuHot: false, screenHot: false, hasSessionTitle: false })),
    null,
    '前台本身不得作为充分条件点亮绿灯'
  );
  // 若上一轮已经是 running，无活动信号时应回落 idle（不是继续保持绿）
  assert.deepStrictEqual(
    decideFastStatus(opts({
      fgHit: true, fgDebounced: true,
      st: state({ last: 'running' }),
    })),
    { status: 'idle', task: '已打开·未在工作' }
  );
  // 严格模式缺省（undefined）也必须是新行为
  const noFlag = opts({ fgHit: true, fgDebounced: true });
  delete noFlag.strictRunning;
  assert.strictEqual(decideFastStatus(noFlag), null, 'strictRunning 缺省必须按严格模式');
});

test('2. CPU 热 -> 产生 running 上报（前台只影响文案）', () => {
  assert.deepStrictEqual(
    decideFastStatus(opts({ cpuHot: true })),
    { status: 'running', task: '后台运行中' }
  );
  assert.deepStrictEqual(
    decideFastStatus(opts({ cpuHot: true, fgHit: true, fgDebounced: true })),
    { status: 'running', task: '前台使用中' },
    '前台命中只改文案，不改变是否点绿'
  );
  // 已经是 running 且仍热 -> 本轮不重复上报
  assert.strictEqual(
    decideFastStatus(opts({ cpuHot: true, st: state({ last: 'running' }) })),
    null
  );
  // 画面热同样是活动信号
  assert.deepStrictEqual(
    decideFastStatus(opts({ screenHot: true })),
    { status: 'running', task: '后台运行中' }
  );
});

test('3. 有会话标题 -> 产生 running 上报（第三个活动信号）', () => {
  assert.deepStrictEqual(
    decideFastStatus(opts({ hasSessionTitle: true })),
    { status: 'running', task: '后台运行中' }
  );
  // 复用 dialogName：窗口标题剥掉应用名后仍有会话/任务名才算
  assert.strictEqual(dialogName('关公推文怎么写 - 豆包'), '关公推文怎么写');
  assert.strictEqual(dialogName('Marvis'), '');
  assert.strictEqual(hasSessionTitleSignal(null, '关公推文怎么写'), true);
  assert.strictEqual(hasSessionTitleSignal(null, 'Marvis'), false, '只开应用没登录不得算会话标题');
  assert.strictEqual(hasSessionTitleSignal(null, ''), false);
  // 逐窗口列表会随窗口关闭清理：只有纯应用名窗口时不得靠残留主题判活跃
  const wins = new Map([['w1', { title: 'Marvis', activeT: 0 }]]);
  assert.strictEqual(hasSessionTitleSignal(wins, '旧会话主题'), false);
  wins.set('w2', { title: '新对话主题', activeT: 0 });
  assert.strictEqual(hasSessionTitleSignal(wins, ''), true);
});

test('4. strictRunning:false -> 恢复旧行为（前台去抖即可绿）', () => {
  assert.deepStrictEqual(
    decideFastStatus(opts({ strictRunning: false, fgHit: true, fgDebounced: true })),
    { status: 'running', task: '前台使用中' }
  );
  // 旧行为：前台未达 1.5s 去抖不绿
  assert.strictEqual(
    decideFastStatus(opts({ strictRunning: false, fgHit: true, fgDebounced: false })),
    null
  );
  // 旧行为：CPU 热绿，且保留「后台计算中 CPU{n}%」文案
  assert.deepStrictEqual(
    decideFastStatus(opts({ strictRunning: false, cpuHot: true, st: state({ cpuRate: 0.42 }) })),
    { status: 'running', task: '后台计算中 CPU42%' }
  );
  // 旧行为：冷却期满才回落 idle（严格模式新语义无冷却，两者不同）
  assert.strictEqual(
    decideFastStatus(opts({ strictRunning: false, st: state({ last: 'running', cool: 0 }) })),
    null
  );
  assert.deepStrictEqual(
    decideFastStatus(opts({ strictRunning: false, st: state({ last: 'running', cool: 999 }) })),
    { status: 'idle', task: '桌面端在线' }
  );
  // 同一场景严格模式：无活动信号立即回落，不受冷却期影响
  assert.deepStrictEqual(
    decideFastStatus(opts({ st: state({ last: 'running', cool: 0 }) })),
    { status: 'idle', task: '已打开·未在工作' }
  );
});

// ---------------------------------------------------------------------------
// 规格 5：自动发现初始状态（纯函数 + 主进程接入锚点）
// ---------------------------------------------------------------------------

test('5. 自动发现初始状态为 offline 且 lastHeartbeat === 0', () => {
  const a = discoveredAgentState({ id: 'mavis', name: '马维斯' });
  assert.strictEqual(a.status, 'offline');
  assert.strictEqual(a.lastHeartbeat, 0, '不得凭空给新鲜心跳');
  assert.strictEqual(a.id, 'mavis');
  assert.strictEqual(a.name, '马维斯');
  assert.strictEqual(a.task, '新发现·待确认');
  // 纯函数只返回基础状态；origin/discoveredAt 由 main.js 打标（语义不变）
  assert.strictEqual(Object.keys(a).sort().join(','), 'id,lastHeartbeat,name,status,task');
  const b = discoveredAgentState({ id: 'doubao', name: '豆包' });
  assert.strictEqual(b.lastHeartbeat, 0);
  assert.notStrictEqual(a, b, '每次调用必须返回新对象');
  // main.js 确实展开纯函数，且 handleAutoDiscover 里没有残留 idle/新鲜心跳
  const start = mainSrc.indexOf('function handleAutoDiscover');
  assert.ok(start >= 0, 'handleAutoDiscover 找不到');
  const body = mainSrc.slice(start, start + 2600);
  assert.ok(body.includes('aiSignatures.discoveredAgentState'), 'handleAutoDiscover 未改用纯函数');
  assert.ok(!body.includes("status: 'idle'"), '仍在凭空写 idle');
  assert.ok(!body.includes('lastHeartbeat: Date.now()'), '仍在凭空写新鲜心跳');
  // origin 无条件打标仍在 handleAutoDiscover（设置面板删除豁免语义 + 现有源码锚点）
  assert.ok(body.includes("origin: 'auto'"), 'origin 打标丢失');
  assert.ok(body.includes('discoveredAt: Date.now()'), 'discoveredAt 打标丢失');
});

// ---------------------------------------------------------------------------
// 规格 6：未上线且从未上报只补一次 offline
// ---------------------------------------------------------------------------

test('6. 未上线且从未上报 -> 只补一次 offline，不重复发', () => {
  assert.strictEqual(shouldPostOfflineForUnknown(false, null), true);
  // 模拟调用方：命中后置 st.last='offline'，连续多轮不得重复发
  let last = null;
  let posts = 0;
  const online = false;
  for (let round = 0; round < 5; round += 1) {
    if (shouldPostOfflineForUnknown(online, last)) {
      posts += 1;
      last = 'offline';
    }
  }
  assert.strictEqual(posts, 1, '只能补一次，不能每轮发');
  // 已上报过任意状态 / 进程在线 都不补
  assert.strictEqual(shouldPostOfflineForUnknown(false, 'offline'), false);
  assert.strictEqual(shouldPostOfflineForUnknown(false, 'idle'), false);
  assert.strictEqual(shouldPostOfflineForUnknown(false, 'running'), false);
  assert.strictEqual(shouldPostOfflineForUnknown(true, null), false);
  // tickFast 里确实在 !online 分支调用了它
  assert.ok(/if \(!online\) \{[\s\S]{0,400}shouldPostOfflineForUnknown\(online, st\.last\)/.test(awSrc));
});

// ---------------------------------------------------------------------------
// 改动 3：帧尺寸变化不再误判画面活跃
// ---------------------------------------------------------------------------

test('改动3：帧尺寸变化返回 0（不判活跃），同尺寸内容变化仍算活跃', () => {
  const full = Buffer.alloc(64, 0);
  const resized = Buffer.alloc(32, 0);
  assert.strictEqual(screenDiffRatio(full, resized), 0, '尺寸变化不得返回 1');
  assert.strictEqual(screenDiffRatio(null, full), 0);
  assert.strictEqual(screenDiffRatio(full, Buffer.alloc(0)), 0);
  // 同尺寸、内容全变 -> ratio 高（仍判活跃）
  const changed = Buffer.alloc(64, 200);
  assert.ok(screenDiffRatio(full, changed) > 0.9);
  // 同尺寸、完全相同 -> 0
  assert.strictEqual(screenDiffRatio(full, Buffer.from(full)), 0);
});

// ---------------------------------------------------------------------------
// 改动 2：stale 纯提示字段 / 不实现 offline 过期
// ---------------------------------------------------------------------------

test('改动2：serializeAgents 只加 stale 提示，不改状态、不实现 offline 过期', () => {
  assert.ok(/const STALE_IDLE_MS = 5 \* 60 \* 1000;/.test(mainSrc));
  assert.ok(
    /status === 'idle' && a\.lastHeartbeat > 0 && now - a\.lastHeartbeat > STALE_IDLE_MS/.test(mainSrc),
    'stale 判定条件缺失'
  );
  assert.ok(/\.\.\.\(stale \? \{ stale: true \} : \{\}\)/.test(mainSrc), 'stale 字段未输出');
  // 规格明确：不实现 age > HEARTBEAT_OFFLINE_MS -> offline
  assert.ok(!/age > HEARTBEAT_OFFLINE_MS/.test(mainSrc), '不得实现 offline 过期（留给下一版）');
  // effectiveStatus 仍只做 running(60s) -> idle，idle 原样返回
  assert.ok(/if \(agent\.status === 'running' && age > HEARTBEAT_IDLE_MS\) return 'idle';/.test(mainSrc));
});

test('改动2：tip.stale 中英双语存在且非空（i18n 双包守卫不破）', () => {
  assert.strictEqual(i18n.t('zh-CN', 'tip.stale'), '长时间未更新');
  assert.strictEqual(i18n.t('en-US', 'tip.stale'), 'Not updated for a while');
  assert.ok(Object.keys(i18n.PACKS['zh-CN']).includes('tip.stale'));
  assert.ok(Object.keys(i18n.PACKS['en-US']).includes('tip.stale'));
});

test('改动2：tooltip 在 agent.stale 时显示提示，双语随 lang 切换', () => {
  const m = tipHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'tooltip.html 内联脚本找不到');
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, { textContent: '', className: '', style: {} });
      return els.get(id);
    },
  };
  let onData = null;
  const sandbox = {
    document,
    window: { ASL_I18N: i18n, tooltipApi: { onData: (fn) => { onData = fn; } } },
    setInterval: () => 0,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox);
  assert.ok(typeof onData === 'function', 'tooltip 未注册 onData');
  const base = {
    id: 'mavis', name: '马维斯', status: 'idle',
    lastHeartbeat: Date.now() - 11 * 3600 * 1000, auto: false,
  };
  onData({ agent: { ...base, stale: true }, lang: 'zh-CN' });
  assert.ok(els.get('stale').textContent.includes('长时间未更新'));
  onData({ agent: { ...base, stale: true }, lang: 'en-US' });
  assert.ok(els.get('stale').textContent.includes('Not updated for a while'));
  onData({ agent: base, lang: 'zh-CN' }); // 快照无 stale -> 不显示
  assert.strictEqual(els.get('stale').textContent, '');
});

// ---------------------------------------------------------------------------
// 改动 1：前台分支降级 + 开关可逆性
// ---------------------------------------------------------------------------

test('改动1：严格模式前台不再直接 post running / 不清零 hot / 不 continue', () => {
  const start = awSrc.indexOf('/** 前台 + CPU 通道（每 2 秒）。 */');
  assert.ok(start >= 0);
  const body = awSrc.slice(start, awSrc.indexOf('/** 进程表通道', start));
  assert.ok(!body.includes("post(agent, 'running', '前台使用中')"), '前台分支仍直接点绿');
  assert.ok(body.includes('st.fgHit = true'), '前台命中未记录 fgHit');
  assert.ok(body.includes('st.fgHit = false'), 'fgHit 未每轮重置');
  assert.ok(body.includes('sampleCpu(st, proc, now)'), '严格模式未在同一轮执行 CPU 通道');
  assert.ok(body.includes('hasSessionTitleSignal'), '缺少会话标题信号');
  // 旧分支（可回退）仍保留前台去抖 + 清零
  assert.ok(body.includes('if (!strict && fgHit)'), 'strictRunning:false 旧分支缺失');
  assert.ok(/st\.hot = 0; \/\/ 已经绿了/.test(body), '旧分支未保留 hot 清零');
});

test('改动1：strictRunning 缺省 true，显式 false 才回退；配置写回不丢该键', () => {
  assert.ok(/let strictRunning = true;/.test(awSrc), '缺省必须是 true');
  assert.ok(/strictRunning = data\.strictRunning !== false;/.test(awSrc), '未从 config 读取开关');
  // settings-ops 通用保留未知顶层键 -> 手动写 strictRunning:false 后写回不会被冲掉
  const extras = extractConfigExtras({ agents: [], settings: {}, window: {}, watchers: [], strictRunning: false });
  assert.strictEqual(extras.strictRunning, false);
  const payload = buildConfigPayload({ extras, agents: [], settings: {}, window: {}, watchers: [] });
  assert.strictEqual(payload.strictRunning, false);
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
