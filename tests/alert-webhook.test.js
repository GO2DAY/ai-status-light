'use strict';

/**
 * tests/alert-webhook.test.js — v1.5.1 webhook 电话告警单测（纯 node，假 fetch）。
 *
 * 运行：node tests/alert-webhook.test.js
 *
 * 契约：
 *  1. 边沿触发：仅 prev∉{assist,stuck} 且 next∈{assist,stuck} 时发；
 *     持续 assist 不刷屏（prev=assist 的重复上报静默）
 *  2. 同 agent+status 60 秒冷却；不同 status / 不同 agent 各自独立冷却
 *  3. enabled=false / 空 URL / 非 http(s) URL = 空操作（永不发、不崩）
 *  4. payload 与 D:\AI来电提醒 /alert 端点字段对齐（key/notifyType/title/
 *     message/project/source），title/message 以【显示名】开头（老吴铁律）
 *  5. 发送失败只记日志不抛异常；5s 超时经 AbortController
 */

const assert = require('assert');
const { createAlerter, COOLDOWN_MS, FIRE_TIMEOUT_MS } = require('../main/alert-webhook');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** 造一个独立告警器 + 假 fetch（记录调用）。 */
function makeAlerter() {
  const calls = [];
  const logs = [];
  let now = 1_000_000;
  const alerter = createAlerter({
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), signal: opts.signal });
      return { ok: true, status: 200 };
    },
    nowImpl: () => now,
    logImpl: (m) => logs.push(m),
  });
  return { alerter, calls, logs, advance: (ms) => { now += ms; } };
}

const CFG = {
  enabled: true,
  url: 'http://127.0.0.1:3001/alert',
  key: 'test-key',
  onAssist: true,
  onStuck: true,
};

test('边沿触发：idle->assist 发一次；持续 assist（assist->assist）不再发', () => {
  const { alerter, calls } = makeAlerter();
  assert.strictEqual(alerter.maybeAlert('doubao', 'idle', 'assist', '需要扫码', CFG, '豆包'), true);
  assert.strictEqual(calls.length, 1);
  // 粘住状态下的重复上报（sticky 续命路径）：prev=assist -> 不是新边沿
  assert.strictEqual(alerter.maybeAlert('doubao', 'assist', 'assist', '需要扫码', CFG, '豆包'), false);
  assert.strictEqual(calls.length, 1);
});

test('ack 后再 assist = 新边沿，会再报（prev=idle）', () => {
  const { alerter, calls, advance } = makeAlerter();
  alerter.maybeAlert('doubao', 'idle', 'assist', '一', CFG, '豆包');
  advance(COOLDOWN_MS + 1); // 过冷却
  assert.strictEqual(alerter.maybeAlert('doubao', 'idle', 'assist', '二', CFG, '豆包'), true);
  assert.strictEqual(calls.length, 2);
});

test('60 秒冷却：冷却期内同 agent+status 不重复；stuck/assist 独立冷却', () => {
  const { alerter, calls, advance } = makeAlerter();
  alerter.maybeAlert('kimi', 'running', 'assist', '卡A', CFG, 'Kimi');
  advance(10_000);
  // 冷却期内同 agent+assist
  assert.strictEqual(alerter.maybeAlert('kimi', 'idle', 'assist', '卡A2', CFG, 'Kimi'), false);
  // 同 agent 但 stuck：独立冷却键，可发
  assert.strictEqual(alerter.maybeAlert('kimi', 'idle', 'stuck', '卡S', CFG, 'Kimi'), true);
  // 不同 agent：互不影响
  assert.strictEqual(alerter.maybeAlert('mavis', 'idle', 'assist', '卡B', CFG, '马维斯'), true);
  assert.strictEqual(calls.length, 3);
});

test('冷却恰好到期（60s 整）可以再发', () => {
  const { alerter, calls, advance } = makeAlerter();
  alerter.maybeAlert('a', 'idle', 'stuck', '', CFG, 'A');
  advance(COOLDOWN_MS); // t - last == COOLDOWN_MS，不小于 → 放行
  assert.strictEqual(alerter.maybeAlert('a', 'idle', 'stuck', '', CFG, 'A'), true);
  assert.strictEqual(calls.length, 2);
});

test('disabled / 空 URL / 坏 URL：空操作，不发不崩', () => {
  const { alerter, calls } = makeAlerter();
  assert.strictEqual(alerter.maybeAlert('a', 'idle', 'assist', 'x', { ...CFG, enabled: false }), false);
  assert.strictEqual(alerter.maybeAlert('a', 'idle', 'assist', 'x', { ...CFG, url: '' }), false);
  assert.strictEqual(alerter.maybeAlert('a', 'idle', 'assist', 'x', { ...CFG, url: 'ftp://x' }), false);
  assert.strictEqual(alerter.maybeAlert('a', 'idle', 'assist', 'x', null), false);
  assert.strictEqual(alerter.maybeAlert('a', 'idle', 'assist', 'x', undefined), false);
  assert.strictEqual(calls.length, 0);
});

test('非告警状态不触发：running/idle/offline 一律静默', () => {
  const { alerter, calls } = makeAlerter();
  for (const s of ['running', 'idle', 'offline']) {
    assert.strictEqual(alerter.maybeAlert('a', 'idle', s, 'x', CFG, 'A'), false);
  }
  assert.strictEqual(calls.length, 0);
});

test('类别开关：onAssist=false 拦 assist；onStuck=false 拦 stuck', () => {
  const { alerter, calls } = makeAlerter();
  assert.strictEqual(alerter.maybeAlert('a', 'idle', 'assist', 'x', { ...CFG, onAssist: false }), false);
  assert.strictEqual(alerter.maybeAlert('b', 'idle', 'stuck', 'x', { ...CFG, onStuck: false }), false);
  assert.strictEqual(alerter.maybeAlert('c', 'idle', 'stuck', 'x', { ...CFG, onAssist: false }), true); // 互不误拦
  assert.strictEqual(calls.length, 1);
});

test('payload 与 /alert 端点对齐 + 【显示名】开头铁律', async () => {
  const { alerter, calls } = makeAlerter();
  alerter.maybeAlert('workbuddy', 'running', 'assist', '飞书需要扫码登录', CFG, 'WorkBuddy');
  // maybeAlert 内 fireAlert 是异步的，等一拍
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.length, 1);
  const { url, body } = calls[0];
  assert.strictEqual(url, 'http://127.0.0.1:3001/alert');
  // 与 D:\AI来电提醒\server\index.js /alert 逐字段对齐
  assert.strictEqual(body.key, 'test-key');          // 端点读 body.key 或 x-api-key
  assert.strictEqual(body.notifyType, 'assist');     // 端点枚举：assist=微信+电话兜底
  assert.strictEqual(body.project, 'WorkBuddy');     // 端点读 body.project
  assert.strictEqual(body.source, 'AI状态灯');        // 端点读 body.source
  // 铁律：title/message 第一位必须是【agent显示名】
  assert.ok(body.title.startsWith('【WorkBuddy】'), `title 未以显示名开头: ${body.title}`);
  assert.ok(body.message.startsWith('【WorkBuddy】'), `message 未以显示名开头: ${body.message}`);
  assert.ok(body.message.includes('飞书需要扫码登录'));
});

test('stuck 的 title 用「AI 卡死」；task 为空时 message 用类别兜底', async () => {
  const { alerter, calls } = makeAlerter();
  alerter.maybeAlert('gpt', 'idle', 'stuck', '', CFG, 'GPT');
  await new Promise((r) => setImmediate(r));
  assert.ok(calls[0].body.title.includes('卡死'));
  assert.strictEqual(calls[0].body.message, '【GPT】AI 卡死');
});

test('发送失败只记日志不抛异常；AbortController 信号已传', async () => {
  const logs = [];
  const alerter = createAlerter({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    logImpl: (m) => logs.push(m),
  });
  alerter.maybeAlert('a', 'idle', 'assist', 'x', CFG, 'A');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(logs.length, 1);
  assert.ok(logs[0].includes('ECONNREFUSED'));

  // HTTP 500 也只记日志
  const logs2 = [];
  const alerter2 = createAlerter({
    fetchImpl: async (url, opts) => {
      assert.ok(opts.signal && typeof opts.signal.aborted === 'boolean', 'AbortSignal 未传入');
      return { ok: false, status: 500 };
    },
    logImpl: (m) => logs2.push(m),
  });
  alerter2.maybeAlert('a', 'idle', 'assist', 'x', CFG, 'A');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(logs2.length, 1);
  assert.ok(logs2[0].includes('500'));
});

test('常量契约：冷却 60s、超时 5s', () => {
  assert.strictEqual(COOLDOWN_MS, 60_000);
  assert.strictEqual(FIRE_TIMEOUT_MS, 5_000);
});

test('隐私：payload 不含旧主题命名空间/本名/本机路径', async () => {
  const { alerter, calls } = makeAlerter();
  alerter.maybeAlert('a', 'idle', 'assist', '扫码', CFG, 'A');
  await new Promise((r) => setImmediate(r));
  const json = JSON.stringify(calls[0].body);
  for (const bad of ['qrzcfsywp3gmlvi0', '吴建明', 'C:\\Users\\']) {
    assert.ok(!json.includes(bad), `payload 含违禁串 ${bad}`);
  }
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
