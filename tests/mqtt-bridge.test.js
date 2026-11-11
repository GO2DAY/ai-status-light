'use strict';

/**
 * tests/mqtt-bridge.test.js — mqtt-bridge 的 node 单测（无网络，mock mqtt.connect）。
 *
 * 运行：node tests/mqtt-bridge.test.js
 *
 * 背景（v1.3.1 修复）：cloudRelay 是整条云端中继通道的 kill-switch。
 * 发布侧在 doPublish 里查 isEnabled，但接收侧的 message handler 原来没查 ——
 * 开关关掉后云 AI 的消息照样进 applyReport 改变灯状态。这里用假 client
 * 直接驱动 message/publish 两条路径，锁死这个回归。
 *
 * mock 原理：mqtt v5 的 exports.connect 是 getter-only（defineProperty），
 * 不能直接赋值。改为替换 require 缓存里的整个 exports 对象 —— mqtt-bridge
 * 顶层 require('mqtt') 时命中缓存，拿到注入假 connect 的版本。
 */

const assert = require('assert');
const { EventEmitter } = require('events');

const mqttPath = require.resolve('mqtt');
const realMqtt = require('mqtt'); // 先正常加载，填充 require 缓存

let fakeClient = null;
let publishCalls = [];
let subscribeCalls = [];
let connectUrls = []; // v1.6.0：记录每次 connect 的 broker URL
function fakeConnect(url) {
  publishCalls = [];
  subscribeCalls = [];
  connectUrls.push(url);
  fakeClient = Object.assign(new EventEmitter(), {
    connected: true,
    subscribe(topic, opts, cb) {
      subscribeCalls.push(topic);
      if (cb) cb(null);
    },
    publish(topic, payload, opts, cb) {
      publishCalls.push({ topic, payload: String(payload), opts });
      if (cb) cb(null);
    },
    end() {},
  });
  return fakeClient;
}

// 必须在 require mqtt-bridge 之前完成替换
require.cache[mqttPath].exports = Object.assign({}, realMqtt, { connect: fakeConnect });

// v1.5.0：主题不再硬编码导出，改为 getTopicBase 回调 + buildTopics 派生。
const { startMqttBridge, buildTopics, DEFAULT_TOPIC_BASE } = require('../main/mqtt-bridge');
const TEST_BASE = 'asl/testbase0000';
const { statusTopic: STATUS_TOPIC, stateTopic: STATE_TOPIC } = buildTopics(TEST_BASE);

// 测试注册表：统一在末尾顺序 await 执行（支持 async 用例）
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** 起一座桥并返回操控柄。enabledRef.current 控制 isEnabled；baseRef.current 控制主题前缀；brokerRef.current 控制 broker 地址（v1.6.0）。 */
function makeBridge(enabledRef, baseRef, brokerRef) {
  const reports = [];
  const logs = [];
  const bridge = startMqttBridge(
    (body) => reports.push(body),
    (m) => logs.push(m),
    () => enabledRef.current,
    () => (baseRef ? baseRef.current : TEST_BASE),
    brokerRef ? () => brokerRef.current : undefined
  );
  fakeClient.emit('connect'); // 模拟连接成功（触发 subscribe）
  return { bridge, reports, logs };
}

function emitStatusMessage(obj) {
  fakeClient.emit('message', STATUS_TOPIC, Buffer.from(JSON.stringify(obj), 'utf-8'));
}

// ---------------------------------------------------------------------------
// 接收侧 kill-switch（v1.3.1 修复点）
// ---------------------------------------------------------------------------

test('enabled=false：status 消息被拦截，applyReport 不被调用', () => {
  // 真实场景：桥在开关打开时已连上，之后用户才关掉 cloudRelay ——
  // 旧代码里这条存活连接的消息照进 applyReport（本次修复点）。
  const enabledRef = { current: true };
  const { bridge, reports } = makeBridge(enabledRef);
  enabledRef.current = false;
  emitStatusMessage({ agent: 'doubao', status: 'running', task: '云端任务' });
  assert.strictEqual(reports.length, 0);
  bridge.stop();
});

test('enabled=true：status 消息正常进入 applyReport 回调', () => {
  const enabledRef = { current: true };
  const { bridge, reports } = makeBridge(enabledRef);
  emitStatusMessage({ agent: 'doubao', status: 'running', task: '云端任务' });
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].agent, 'doubao');
  assert.strictEqual(reports[0].task, '云端任务');
  bridge.stop();
});

test('开关热切换：true->false 后消息立即被拦，false->true 立即恢复', () => {
  const enabledRef = { current: true };
  const { bridge, reports } = makeBridge(enabledRef);
  emitStatusMessage({ agent: 'a', status: 'running' });
  assert.strictEqual(reports.length, 1);
  enabledRef.current = false;
  emitStatusMessage({ agent: 'a', status: 'idle' });
  assert.strictEqual(reports.length, 1); // 被拦
  enabledRef.current = true;
  emitStatusMessage({ agent: 'a', status: 'idle' });
  assert.strictEqual(reports.length, 2); // 恢复
  bridge.stop();
});

test('垃圾 JSON 消息静默丢弃（enabled=true 也不进 applyReport）', () => {
  const enabledRef = { current: true };
  const { bridge, reports } = makeBridge(enabledRef);
  fakeClient.emit('message', STATUS_TOPIC, Buffer.from('not-json{{{', 'utf-8'));
  assert.strictEqual(reports.length, 0);
  bridge.stop();
});

// ---------------------------------------------------------------------------
// 发布侧对称行为（publishState，v1.3.0 引入，一并锁住）
// ---------------------------------------------------------------------------

test('publishState：enabled=true 发 retain 快照到 STATE_TOPIC，重复快照去重', () => {
  const enabledRef = { current: true };
  const { bridge } = makeBridge(enabledRef);
  const snap = [{ id: 'doubao', name: '豆包', status: 'running', task: '生成中', lastHeartbeat: 1 }];
  bridge.publishState(snap);
  assert.strictEqual(publishCalls.length, 1);
  assert.strictEqual(publishCalls[0].topic, STATE_TOPIC);
  assert.strictEqual(publishCalls[0].opts.retain, true);
  assert.strictEqual(publishCalls[0].opts.qos, 0);
  assert.ok(publishCalls[0].payload.includes('豆包'));
  bridge.publishState(snap); // 相同快照：去重不发
  assert.strictEqual(publishCalls.length, 1);
  bridge.stop();
});

test('publishState：enabled=false 时不发，但记住快照，开关恢复后可发', () => {
  const enabledRef = { current: true };
  const { bridge } = makeBridge(enabledRef);
  enabledRef.current = false; // 连上之后才关开关（与真实操作顺序一致）
  const snap = [{ id: 'mavis', name: '马维斯', status: 'idle', task: '', lastHeartbeat: 2 }];
  bridge.publishState(snap);
  assert.strictEqual(publishCalls.length, 0); // 开关关：不发
  enabledRef.current = true;
  bridge.publishState(snap); // 同一快照再来一次：lastPublished 仍是 null，这次该发
  assert.strictEqual(publishCalls.length, 1);
  assert.ok(publishCalls[0].payload.includes('马维斯'));
  bridge.stop();
});

test('publishState：500ms 节流合并（连发两条不同快照只出一条最新的）', async () => {
  const enabledRef = { current: true };
  const { bridge } = makeBridge(enabledRef);
  bridge.publishState([{ id: 'a', status: 'running', task: '一', lastHeartbeat: 1 }]);
  assert.strictEqual(publishCalls.length, 1); // 第一条立即发
  bridge.publishState([{ id: 'a', status: 'running', task: '二', lastHeartbeat: 2 }]);
  bridge.publishState([{ id: 'a', status: 'running', task: '三', lastHeartbeat: 3 }]);
  // 第二条触发节流（距上次 <500ms），第三条顶替 trailing 内容
  await new Promise((r) => setTimeout(r, 700));
  assert.strictEqual(publishCalls.length, 2);
  assert.ok(publishCalls[1].payload.includes('三'));
  assert.ok(!publishCalls[1].payload.includes('二'));
  bridge.stop();
});

test('重连补发：断线期间的快照不发，再次 connect 时补发最新一份', () => {
  const enabledRef = { current: true };
  const { bridge } = makeBridge(enabledRef);
  bridge.publishState([{ id: 'a', status: 'idle', task: '', lastHeartbeat: 9 }]);
  assert.strictEqual(publishCalls.length, 1);
  // 模拟断线期间灯变了（未连接发不出去，只记快照）
  fakeClient.connected = false;
  bridge.publishState([{ id: 'a', status: 'running', task: '恢复', lastHeartbeat: 10 }]);
  assert.strictEqual(publishCalls.length, 1); // 未连接：不发
  // 重连成功：补发最新快照
  fakeClient.connected = true;
  fakeClient.emit('connect');
  assert.strictEqual(publishCalls.length, 2);
  assert.ok(publishCalls[1].payload.includes('恢复'));
  bridge.stop();
});

// ---------------------------------------------------------------------------
// 主题配置化（v1.5.0 脱敏）：主题前缀来自 getTopicBase 回调，不再硬编码
// ---------------------------------------------------------------------------

test('订阅/发布主题均由 getTopicBase 派生（asl/<base>/status|state，rev5 增 cmd）', () => {
  const enabledRef = { current: true };
  const baseRef = { current: 'asl/mach1ne00001' };
  const { bridge } = makeBridge(enabledRef, baseRef);
  // v1.7.0 rev5：手机端灯管理远程指令通道，cmd 主题与 status 一起订阅
  assert.deepStrictEqual(subscribeCalls, ['asl/mach1ne00001/status', 'asl/mach1ne00001/cmd']);
  bridge.publishState([{ id: 'a', status: 'idle', task: '', lastHeartbeat: 1 }]);
  assert.strictEqual(publishCalls[0].topic, 'asl/mach1ne00001/state');
  bridge.stop();
});

test('运行中换主题：getTopicBase 返回新值后，下一条快照发到新主题（面板重新生成场景）', async () => {
  const enabledRef = { current: true };
  const baseRef = { current: TEST_BASE };
  const { bridge } = makeBridge(enabledRef, baseRef);
  bridge.publishState([{ id: 'a', status: 'idle', task: '一', lastHeartbeat: 1 }]);
  assert.strictEqual(publishCalls[0].topic, STATE_TOPIC);
  // 面板「重新生成」→ 配置里的主题变了（桥由主进程重启；这里直接验证
  // 每次发布现取回调值这一半契约 —— 重启后新桥自然用新主题）。
  // 注意 500ms 节流：等它过去再发第二条，避免被 trailing 合并干扰断言。
  await new Promise((r) => setTimeout(r, 600));
  baseRef.current = 'asl/newtopic0002';
  bridge.publishState([{ id: 'a', status: 'idle', task: '二', lastHeartbeat: 2 }]);
  assert.strictEqual(publishCalls.length, 2);
  assert.strictEqual(publishCalls[1].topic, 'asl/newtopic0002/state');
  bridge.stop();
});

test('buildTopics：非法前缀回退默认；尾斜杠容忍', () => {
  // v1.7.0 rev5：新增 cmd 主题派生（手机端灯管理 remove-agent 指令）
  assert.deepStrictEqual(buildTopics('asl/abc123'), {
    statusTopic: 'asl/abc123/status',
    stateTopic: 'asl/abc123/state',
    cmdTopic: 'asl/abc123/cmd',
  });
  assert.strictEqual(buildTopics('asl/abc123/').stateTopic, 'asl/abc123/state');
  assert.strictEqual(buildTopics('').stateTopic, `${DEFAULT_TOPIC_BASE}/state`);
  assert.strictEqual(buildTopics(undefined).statusTopic, `${DEFAULT_TOPIC_BASE}/status`);
  assert.strictEqual(buildTopics('asl/').statusTopic, `${DEFAULT_TOPIC_BASE}/status`);
});

// ---------------------------------------------------------------------------
// broker 可配置（v1.6.0 功能四）：connect 现取回调值，非法回退公共默认
// ---------------------------------------------------------------------------

test('broker 地址来自 getBrokerUrl 回调（自托管 broker 场景）', () => {
  const { BROKER_URL } = require('../main/mqtt-bridge');
  const enabledRef = { current: true };
  const brokerRef = { current: 'mqtts://mqtt.example.com:8883' };
  connectUrls = [];
  const { bridge } = makeBridge(enabledRef, undefined, brokerRef);
  assert.strictEqual(connectUrls[0], 'mqtts://mqtt.example.com:8883');
  bridge.stop();
  // 缺省回调 / 非法值 → 公共默认
  connectUrls = [];
  const b2 = makeBridge({ current: true });
  assert.strictEqual(connectUrls[0], BROKER_URL);
  b2.bridge.stop();
  connectUrls = [];
  const b3 = makeBridge({ current: true }, undefined, { current: 'ftp://evil' });
  assert.strictEqual(connectUrls[0], BROKER_URL);
  b3.bridge.stop();
});

// ---------------------------------------------------------------------------
// 顺序执行（支持 async 用例），恢复真实 connect 后退出
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
  require.cache[mqttPath].exports = realMqtt; // 恢复真实模块（防御性）
  console.log(`\n${passed}/${tests.length} tests passed${process.exitCode ? ' (with failures)' : ''}`);
})();
