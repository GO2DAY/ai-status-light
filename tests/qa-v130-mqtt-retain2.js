'use strict';

/**
 * tests/qa-v130-mqtt-retain2.js — retain 复测（诊断版，仍只碰 QA 子主题）
 *
 * 区分两种失败：a) publish 没落上 broker  b) 落上了但 retain 丢失。
 * 做法：先让一个在线订阅者挂着（应收到实时消息），再冷启动订阅者（应收到 retained）。
 * 结束发空 retained 消息清除残留。
 */

const mqtt = require('mqtt');

const BROKER = 'mqtts://broker.emqx.io:8883';
const QA_TOPIC = 'asl/qrzcfsywp3gmlvi0/state-qa';
const TIMEOUT_MS = 20000;

function connect(tag) {
  return mqtt.connect(BROKER, {
    clientId: `asl-qa2-${tag}-${Math.random().toString(16).slice(2, 8)}`,
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

function subscribeAck(client, topic) {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: 0 }, (err) => (err ? reject(err) : resolve()));
  });
}

function nextMessage(client, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    client.once('message', (topic, payload, packet) => {
      clearTimeout(t);
      resolve({ payload: payload.toString('utf-8'), retain: packet.retain });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failed = false;
  const testPayload = JSON.stringify([{ id: 'qa-probe', status: 'idle', ts: Date.now() }]);

  // A. 在线订阅者先挂好（等 SUBACK）
  const live = connect('live');
  await waitFor(live, 'connect', TIMEOUT_MS, 'live connect');
  await subscribeAck(live, QA_TOPIC);
  console.log('[A] live subscriber ready');

  // B. 发布者发 retained 消息，发完保持连接 1s 再断开
  const pub = connect('pub');
  await waitFor(pub, 'connect', TIMEOUT_MS, 'pub connect');
  await new Promise((resolve, reject) => {
    pub.publish(QA_TOPIC, testPayload, { qos: 0, retain: true }, (err) => (err ? reject(err) : resolve()));
  });
  console.log('[B] published (retain=true)');

  // C. 在线订阅者应收到实时消息
  try {
    const got = await nextMessage(live, 8000, 'live subscriber receive');
    console.log(`[C] live subscriber GOT len=${got.payload.length} retain=${got.retain}`);
    if (got.payload !== testPayload) { failed = true; console.error('    payload mismatch!'); }
  } catch (err) {
    failed = true;
    console.error(`[C] FAIL: live subscriber got nothing -> publish 没落上 broker (${err.message})`);
  }
  await sleep(1000);
  pub.end(true);

  // D. 冷启动订阅者应收到 retained 副本
  await sleep(1500);
  const cold = connect('cold');
  await waitFor(cold, 'connect', TIMEOUT_MS, 'cold connect');
  try {
    const gotP = nextMessage(cold, 10000, 'cold subscriber retained');
    await subscribeAck(cold, QA_TOPIC);
    const got = await gotP;
    if (got.payload === testPayload) {
      console.log(`[D] PASS: cold subscriber GOT retained copy (retain=${got.retain})`);
    } else {
      failed = true;
      console.error(`[D] FAIL: payload mismatch: ${got.payload}`);
    }
  } catch (err) {
    failed = true;
    console.error(`[D] FAIL: cold subscriber got nothing -> retain 未生效 (${err.message})`);
  }
  cold.end(true);
  live.end(true);

  // E. 清除残留 + 确认
  const cleaner = connect('clean');
  await waitFor(cleaner, 'connect', TIMEOUT_MS, 'cleaner connect');
  await new Promise((resolve, reject) => {
    cleaner.publish(QA_TOPIC, '', { qos: 0, retain: true }, (err) => (err ? reject(err) : resolve()));
  });
  await sleep(1500);
  cleaner.end(true);
  await sleep(1500);
  const chk = connect('chk');
  await waitFor(chk, 'connect', TIMEOUT_MS, 'chk connect');
  const ghost = await Promise.race([
    (async () => {
      const p = nextMessage(chk, 5000, 'ghost');
      await subscribeAck(chk, QA_TOPIC);
      return p;
    })(),
    sleep(6000).then(() => null),
  ]).catch(() => null);
  if (ghost === null) console.log('[E] PASS: QA subtopic clean, no residue');
  else { failed = true; console.error(`[E] FAIL: residue: ${JSON.stringify(ghost)}`); }
  chk.end(true);

  console.log(failed ? '\nMQTT RETAIN RETEST: FAILED' : '\nMQTT RETAIN RETEST: ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(`fatal: ${err && err.stack}`);
  process.exit(1);
});
