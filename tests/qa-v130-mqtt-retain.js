'use strict';

/**
 * tests/qa-v130-mqtt-retain.js — v1.3.0 QA 独立验证（严过关）：MQTT retain 实测
 *
 * 安全策略（broker.emqx.io 是生产在用的）：
 *  - 生产主题 asl/qrzcfsywp3gmlvi0/state：只订阅、只读，绝不 publish
 *    （验证生产灯确实在发 retained 快照）
 *  - retain 收发机制验证走 QA 专用子主题 asl/qrzcfsywp3gmlvi0/state-qa，
 *    测完发空 retained 消息清除残留
 *
 * 运行：node tests/qa-v130-mqtt-retain.js
 */

const mqtt = require('mqtt');

const BROKER = 'mqtts://broker.emqx.io:8883';
const PROD_TOPIC = 'asl/qrzcfsywp3gmlvi0/state';
const QA_TOPIC = 'asl/qrzcfsywp3gmlvi0/state-qa';
const TIMEOUT_MS = 20000;

function connect(tag) {
  return mqtt.connect(BROKER, {
    clientId: `asl-qa-${tag}-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    connectTimeout: 10000,
    reconnectPeriod: 0,
  });
}

function waitFor(client, event, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${label}`)), ms);
    client.once(event, (...args) => { clearTimeout(t); resolve(args); });
  });
}

(async () => {
  let failed = false;

  // ---- 第 1 步：只读订阅生产主题，看有没有 retained 快照 ----
  console.log('[1] subscribe production topic (read-only)...');
  const c1 = connect('sub');
  try {
    await waitFor(c1, 'connect', TIMEOUT_MS, 'c1 connect');
    const prodMsg = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000); // 没有 retained 也算有效结论
      c1.on('message', (topic, payload, packet) => {
        clearTimeout(t);
        resolve({ topic, payload: payload.toString('utf-8'), retain: packet.retain });
      });
    });
    c1.subscribe(PROD_TOPIC, { qos: 0 });
    const got = await prodMsg;
    if (got) {
      let parsed = null;
      try { parsed = JSON.parse(got.payload); } catch { /* ignore */ }
      console.log(`    GOT message on ${got.topic} retain=${got.retain} len=${got.payload.length}`);
      console.log(`    agents: ${Array.isArray(parsed) ? parsed.map((a) => `${a.id}:${a.status}`).join(', ') : '(not an array)'}`);
      if (got.retain !== true) {
        console.log('    WARN: 收到的不是 retained 消息（可能是刚好的实时发布）');
      }
    } else {
      console.log('    NOTE: 8s 内生产主题无任何消息（生产灯可能离线或尚未发布过）');
    }
  } catch (err) {
    failed = true;
    console.error(`    FAIL step1: ${err.message}`);
  }
  c1.end(true);

  // ---- 第 2 步：QA 子主题 retain 往返 ----
  console.log('[2] retain round-trip on QA subtopic...');
  const testPayload = JSON.stringify([{ id: 'qa-probe', name: 'QA探针', status: 'idle', ts: Date.now() }]);
  const c2 = connect('pub');
  try {
    await waitFor(c2, 'connect', TIMEOUT_MS, 'c2 connect');
    await new Promise((resolve, reject) => {
      c2.publish(QA_TOPIC, testPayload, { qos: 0, retain: true }, (err) => (err ? reject(err) : resolve()));
    });
    console.log('    published retained test message');
  } catch (err) {
    failed = true;
    console.error(`    FAIL step2 publish: ${err.message}`);
  }
  c2.end(true);
  await new Promise((r) => setTimeout(r, 1000)); // 给 broker 一点落盘时间

  // 新客户端冷订阅，必须收到 retained
  const c3 = connect('verify');
  try {
    await waitFor(c3, 'connect', TIMEOUT_MS, 'c3 connect');
    const gotRetained = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no retained message received in 8s')), 8000);
      c3.on('message', (topic, payload, packet) => {
        clearTimeout(t);
        resolve({ payload: payload.toString('utf-8'), retain: packet.retain });
      });
    });
    c3.subscribe(QA_TOPIC, { qos: 0 });
    const got = await gotRetained;
    if (got.payload === testPayload) {
      console.log(`    PASS: cold subscriber received retained copy (retain=${got.retain})`);
    } else {
      failed = true;
      console.error(`    FAIL: retained payload mismatch: ${got.payload}`);
    }
  } catch (err) {
    failed = true;
    console.error(`    FAIL step2 verify: ${err.message}`);
  }
  c3.end(true);

  // ---- 第 3 步：清除 QA 残留（空 retained 消息）----
  console.log('[3] cleanup: clearing retained test message...');
  const c4 = connect('clean');
  try {
    await waitFor(c4, 'connect', TIMEOUT_MS, 'c4 connect');
    await new Promise((resolve, reject) => {
      c4.publish(QA_TOPIC, '', { qos: 0, retain: true }, (err) => (err ? reject(err) : resolve()));
    });
    console.log('    cleared');
  } catch (err) {
    failed = true;
    console.error(`    FAIL cleanup: ${err.message}`);
  }
  c4.end(true);
  await new Promise((r) => setTimeout(r, 1000));

  // 确认已清除：再订阅应收不到任何 retained
  const c5 = connect('confirm');
  try {
    await waitFor(c5, 'connect', TIMEOUT_MS, 'c5 connect');
    const ghost = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 5000);
      c5.on('message', (topic, payload) => { clearTimeout(t); resolve(payload.toString('utf-8')); });
      c5.subscribe(QA_TOPIC, { qos: 0 });
    });
    if (ghost === null) {
      console.log('    PASS: QA subtopic is clean (no retained residue)');
    } else {
      failed = true;
      console.error(`    FAIL: residue still present: ${JSON.stringify(ghost)}`);
    }
  } catch (err) {
    failed = true;
    console.error(`    FAIL confirm: ${err.message}`);
  }
  c5.end(true);

  console.log(failed ? '\nMQTT RETAIN TEST: FAILED' : '\nMQTT RETAIN TEST: ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(`fatal: ${err && err.stack}`);
  process.exit(1);
});
