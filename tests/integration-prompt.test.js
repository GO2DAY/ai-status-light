'use strict';

/**
 * tests/integration-prompt.test.js — v1.5.1 接入提示词生成器单测（纯 node）。
 *
 * 运行：node tests/integration-prompt.test.js
 *
 * 契约：
 *  1. 双语言渲染：zh/en 各一份完整正文
 *  2. 主题码插值：合法 base 嵌入正文且无占位残留；非法 base 留占位提示
 *  3. 协议关键串必须出现（端点/枚举/force 规则/broker/主题派生）
 *  4. 隐私：正文不得含旧主题命名空间等违禁串（与 privacy-scan 同规则）
 */

const assert = require('assert');
const prompt = require('../main/integration-prompt');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const TEST_BASE = 'asl/abcd1234ef01';

test('HTTP 提示词：zh 版包含端点/枚举/粘住规则/忽略重试', () => {
  const text = prompt.buildHttpPrompt('zh-CN');
  assert.ok(text.includes('POST http://127.0.0.1:17890/status'));
  assert.ok(text.includes('application/json'));
  for (const s of ['running', 'idle', 'stuck', 'assist', 'offline']) {
    assert.ok(text.includes(s), `zh 版缺状态枚举 ${s}`);
  }
  assert.ok(text.includes('"force":true'), 'zh 版缺粘住解除规则');
  assert.ok(text.includes('不要重试'), 'zh 版缺连接拒绝忽略规则');
  assert.ok(text.includes('永久记忆'));
});

test('HTTP 提示词：en 版与 zh 版同协议事实', () => {
  const text = prompt.buildHttpPrompt('en-US');
  assert.ok(text.includes('POST http://127.0.0.1:17890/status'));
  assert.ok(text.includes('"force":true'));
  for (const s of ['running', 'idle', 'stuck', 'assist', 'offline']) {
    assert.ok(text.includes(s), `en 版缺状态枚举 ${s}`);
  }
  assert.ok(text.includes('do NOT retry'));
  assert.ok(text.includes('PERMANENT MEMORY'));
});

test('MQTT 提示词：主题码插值成功且无占位残留（zh/en）', () => {
  const zh = prompt.buildMqttPrompt(TEST_BASE, 'zh-CN');
  const en = prompt.buildMqttPrompt(TEST_BASE, 'en-US');
  for (const text of [zh, en]) {
    assert.ok(text.includes(`${TEST_BASE}/status`), '主题码未嵌入');
    // 注：正文里的 JSON 示例本身含 {}，只查主题占位符残留
    assert.ok(!text.includes('<你的主题码>'), '存在占位残留');
    assert.ok(text.includes('mqtts://broker.emqx.io:8883'));
    assert.ok(text.includes('wss://broker.emqx.io:8084/mqtt'));
    assert.ok(text.includes('QoS 0'));
    assert.ok(text.includes('"force":true'));
  }
  assert.ok(zh.includes('勿外传') || zh.includes('不要外传'), 'zh 版缺保密提示');
  assert.ok(en.includes('do NOT share'), 'en 版缺保密提示');
});

test('MQTT 提示词：非法/空主题码 → 留占位提示，不硬拼坏主题', () => {
  for (const bad of ['', undefined, null, 'not-a-base', 'asl/', '  ']) {
    const text = prompt.buildMqttPrompt(bad, 'zh-CN');
    assert.ok(text.includes('<你的主题码>/status'), `非法 base ${JSON.stringify(bad)} 未走占位`);
  }
  // 尾斜杠容忍
  assert.ok(prompt.buildMqttPrompt(`${TEST_BASE}`, 'zh-CN').includes(`${TEST_BASE}/status`));
});

test('MQTT 提示词反映自定义 broker（v1.6.0 功能四）；缺省/非法回退 emqx', () => {
  const custom = prompt.buildMqttPrompt(TEST_BASE, 'zh-CN', {
    tcp: 'mqtts://mqtt.example.com:8883',
    wss: 'wss://mqtt.example.com:8084/mqtt',
  });
  assert.ok(custom.includes('mqtts://mqtt.example.com:8883'), 'zh 版未写自定义 TCP broker');
  assert.ok(custom.includes('wss://mqtt.example.com:8084/mqtt'), 'zh 版未写自定义 WSS broker');
  assert.ok(!custom.includes('broker.emqx.io'), '自定义 broker 时仍写死 emqx');
  const en = prompt.buildMqttPrompt(TEST_BASE, 'en-US', { tcp: 'mqtt://192.168.1.10:1883' });
  assert.ok(en.includes('mqtt://192.168.1.10:1883'));
  assert.ok(en.includes('wss://broker.emqx.io:8084/mqtt'), 'wss 缺省应回退默认');
  // 非法 broker 值（设置面板拦不住的手改 config）→ 回退默认，不写坏地址进提示词
  const bad = prompt.buildMqttPrompt(TEST_BASE, 'zh-CN', { tcp: 'ftp://evil', wss: '' });
  assert.ok(bad.includes('mqtts://broker.emqx.io:8883'));
  assert.ok(bad.includes('wss://broker.emqx.io:8084/mqtt'));
  // 兼容老调用：第三参省略 = 公共默认
  assert.ok(prompt.buildMqttPrompt(TEST_BASE, 'zh-CN').includes('broker.emqx.io'));
});

test('隐私：提示词正文零违禁串（旧命名空间/本名/本机路径）', () => {
  const all = [
    prompt.buildHttpPrompt('zh-CN'),
    prompt.buildHttpPrompt('en-US'),
    prompt.buildMqttPrompt(TEST_BASE, 'zh-CN'),
    prompt.buildMqttPrompt(TEST_BASE, 'en-US'),
  ].join('\n');
  for (const bad of ['qrzcfsywp3gmlvi0', '吴建明', 'C:\\Users\\']) {
    assert.ok(!all.includes(bad), `提示词正文含违禁串 ${bad}`);
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
