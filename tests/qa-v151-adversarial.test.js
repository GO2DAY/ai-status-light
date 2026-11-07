'use strict';

/**
 * tests/qa-v151-adversarial.test.js — v1.5.1 告警 webhook + 集成提示词对抗审查（QA 严过关 R5）。
 *
 * 独立构造，不复用工程师的 alert-webhook/integration-prompt 测试：
 *   A. 3001 字段对齐（对照 D:\AI来电提醒\server\index.js /alert 端点的逐字段契约）
 *   B. 边沿触发完备性（assist→assist 换 task / stuck→assist / force 恢复后再 assist）
 *   C. 异步拒收兜底（reject / 同步抛 / !res.ok 三条路径都不产生 unhandledRejection）
 *   D. 冷却语义（60s 整边界、失败也进冷却、Map 有界性）
 *   E. 配置 roundtrip + 非法 URL 拒收不覆盖旧值 + enabled=false 零网络
 *   F. 提示词卡（真实主题渲染 / 占位 / 双语 / 与 buildTopics 派生一致）
 *   G. 源码锚定（MQTT 同路径、maybeAlert 接线位置、唯一入紫红路径）
 *
 * 运行：node tests/qa-v151-adversarial.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAlerter, COOLDOWN_MS, FIRE_TIMEOUT_MS } = require('../main/alert-webhook');
const settingsOps = require('../main/settings-ops');
const prompt = require('../main/integration-prompt');
const { buildTopics } = (() => {
  // mqtt-bridge 顶层 require('mqtt') 会真连库；只需 buildTopics 纯函数，
  // 用与 mqtt-bridge.test.js 相同的缓存替换法隔离网络。
  const mqttPath = require.resolve('mqtt');
  const realMqtt = require('mqtt');
  require.cache[mqttPath].exports = Object.assign({}, realMqtt, {
    connect: () => { throw new Error('offline test'); },
  });
  return require('../main/mqtt-bridge');
})();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CFG = {
  enabled: true,
  url: 'http://127.0.0.1:3001/alert',
  key: 'TEST_KEY',
  onAssist: true,
  onStuck: true,
};

/** 起一个带间谍的告警器。 */
function makeAlerter({ fetchBehavior, now } = {}) {
  const calls = [];
  const fetchImpl =
    fetchBehavior ||
    ((url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      return Promise.resolve({ ok: true, status: 200 });
    });
  let t = now ? now.start : 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const logs = [];
  const alerter = createAlerter({
    fetchImpl,
    nowImpl: clock.now,
    logImpl: (m) => logs.push(m),
  });
  return { alerter, calls, logs, clock };
}

// ===========================================================================
// A. 3001 字段对齐（对照 D:\AI来电提醒\server\index.js:280-342 读到的契约）
// ===========================================================================

test('3001 对齐：payload 六字段与 /alert 端点契约逐字段一致', () => {
  const { alerter } = makeAlerter();
  const p = alerter.buildPayload('豆包', 'assist', '帮我扫码登录', CFG);
  // 端点：req.headers['x-api-key'] || body.key —— 我们走 body.key
  assert.strictEqual(p.key, 'TEST_KEY');
  // 端点：notifyType 缺省 assist；business 走卡2（生意提醒）——我们必须发 assist
  assert.strictEqual(p.notifyType, 'assist');
  // 端点：title 缺省兜底，但我们必须给（铁律：名字在第一位）
  assert.strictEqual(p.title, '【豆包】AI 求助');
  assert.strictEqual(p.message, '【豆包】帮我扫码登录');
  assert.strictEqual(p.project, '豆包');
  assert.strictEqual(p.source, 'AI状态灯');
  // 端点还读 phone/eventId —— 均有缺省（''/服务端生成），不传不炸
  assert.strictEqual(p.phone, undefined, '不应发明朗 phone 字段（端点缺省空串）');
  // stuck 变体
  const p2 = alerter.buildPayload('Claude', 'stuck', '', CFG);
  assert.strictEqual(p2.title, '【Claude】AI 卡死');
  assert.strictEqual(p2.message, '【Claude】AI 卡死', 'task 空时 message 回退到类别名');
  // task 超 200 字符截断
  const longTask = 'x'.repeat(300);
  const p3 = alerter.buildPayload('A', 'assist', longTask, CFG);
  assert.ok(p3.message.length <= 200 + 4, 'task 未截断');
});

test('3001 对齐源码锚定：端点字段名未漂移（key/notifyType/title/message/project/source）', () => {
  // 直接读对端源码确认契约未变（对端若改字段，此测试立即红）
  const serverSrc = fs.readFileSync('D:\\AI来电提醒\\server\\index.js', 'utf-8');
  for (const field of ['body.key', 'body.notifyType', 'body.title', 'body.message', 'body.project', 'body.source']) {
    assert.ok(serverSrc.includes(field), `3001 端点不再读取 ${field} —— 字段漂移，电话不会响`);
  }
  assert.ok(/req\.url === '\/alert'/.test(serverSrc), '/alert 端点路径变了');
  assert.ok(/process\.env\.PORT \|\| '3001'/.test(serverSrc), '3001 默认端口变了');
});

// ===========================================================================
// B. 边沿触发完备性
// ===========================================================================

test('边沿：idle→assist 触发；assist→assist（换 task）不触发；stuck→assist 不触发（文档化语义）', () => {
  const { alerter, calls, clock } = makeAlerter();
  assert.strictEqual(alerter.maybeAlert('a1', 'idle', 'assist', '任务1', CFG, '豆包'), true);
  assert.strictEqual(calls.length, 1);
  clock.advance(70_000); // 越过冷却，隔离变量只看边沿
  // assist→assist 换 task：prev 已是 assist = 持续状态
  assert.strictEqual(alerter.maybeAlert('a1', 'assist', 'assist', '任务2', CFG, '豆包'), false);
  assert.strictEqual(calls.length, 1, 'assist→assist 换 task 误触发');
  clock.advance(70_000);
  // stuck→assist：prev 是 stuck = 告警状态内切换，不算新事件（模块注释文档化）
  assert.strictEqual(alerter.maybeAlert('a1', 'stuck', 'assist', 't', CFG, '豆包'), false);
  assert.strictEqual(calls.length, 1, 'stuck→assist 误触发');
  // 反向 assist→stuck 同理不触发
  assert.strictEqual(alerter.maybeAlert('a1', 'assist', 'stuck', 't', CFG, '豆包'), false);
  assert.strictEqual(calls.length, 1, 'assist→stuck 误触发');
});

test('边沿：force 恢复（running）后再 assist = 新边沿，再报一次', () => {
  const { alerter, calls, clock } = makeAlerter();
  alerter.maybeAlert('a1', 'idle', 'assist', 't1', CFG, '豆包');
  assert.strictEqual(calls.length, 1);
  // force:true 恢复：applyReport 里 prevStatus=assist → next=running
  assert.strictEqual(alerter.maybeAlert('a1', 'assist', 'running', '', CFG, '豆包'), false);
  assert.strictEqual(calls.length, 1);
  // 恢复后再次 assist —— 但注意 60s 冷却还在！刚触发过 a1:assist
  assert.strictEqual(alerter.maybeAlert('a1', 'running', 'assist', 't2', CFG, '豆包'), false,
    '冷却期内的恢复后再 assist 应被冷却拦（防抖优先）');
  clock.advance(61_000); // 越过冷却
  assert.strictEqual(alerter.maybeAlert('a1', 'running', 'assist', 't2', CFG, '豆包'), true);
  assert.strictEqual(calls.length, 2, '恢复后再 assist（冷却外）未触发');
});

test('类别开关：onAssist=false 只拦 assist 不拦 stuck；offline/running/idle 永不触发', () => {
  const { alerter, calls } = makeAlerter();
  const cfgNoAssist = { ...CFG, onAssist: false };
  assert.strictEqual(alerter.maybeAlert('b1', 'idle', 'assist', 't', cfgNoAssist), false);
  assert.strictEqual(alerter.maybeAlert('b2', 'idle', 'stuck', 't', cfgNoAssist), true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].body.title, '【b2】AI 卡死');
  for (const s of ['running', 'idle', 'offline']) {
    assert.strictEqual(alerter.maybeAlert('b3', 'stuck', s, 't', CFG), false, `${s} 不应触发`);
  }
});

// ===========================================================================
// C. 异步拒收兜底
// ===========================================================================

test('异步拒收：fetch reject / 同步抛 / !res.ok 三条路径全部只记日志不外抛', async () => {
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  try {
    // 路径 1：Promise reject
    const a1 = makeAlerter({
      fetchBehavior: () => Promise.reject(new Error('connection refused')),
    });
    await a1.alerter.fireAlert('豆包', 'assist', 't', CFG);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(unhandled, null, 'reject 路径产生 unhandledRejection');
    assert.ok(a1.logs.some((m) => m.includes('connection refused')), 'reject 未记日志');
    // 路径 2：同步抛（mock 故障/URL 畸形导致 fetch 同步 throw）
    const a2 = makeAlerter({
      fetchBehavior: () => { throw new Error('sync boom'); },
    });
    await a2.alerter.fireAlert('豆包', 'assist', 't', CFG);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(unhandled, null, '同步抛路径产生 unhandledRejection');
    assert.ok(a2.logs.some((m) => m.includes('sync boom')), '同步抛未记日志');
    // 路径 3：HTTP 403/500（res.ok=false）
    const a3 = makeAlerter({
      fetchBehavior: () => Promise.resolve({ ok: false, status: 403 }),
    });
    await a3.alerter.fireAlert('豆包', 'assist', 't', CFG);
    await new Promise((r) => setImmediate(r));
    assert.ok(a3.logs.some((m) => m.includes('403')), '403 未记日志');
    assert.strictEqual(unhandled, null);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('超时：fetch 收到 AbortSignal 且 5s 超时参数存在', () => {
  assert.strictEqual(FIRE_TIMEOUT_MS, 5000);
  const { alerter, calls } = makeAlerter();
  alerter.maybeAlert('a1', 'idle', 'assist', 't', CFG, '豆包');
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].opts && calls[0].opts.signal, 'fetch 未带 AbortSignal（无超时保护）');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.headers['Content-Type'], 'application/json');
});

// ===========================================================================
// D. 冷却语义
// ===========================================================================

test('冷却：60 秒整边界放行；59.999s 拦截；失败也进冷却（防电话刷屏）', async () => {
  const { alerter, calls, clock } = makeAlerter();
  assert.strictEqual(alerter.maybeAlert('c1', 'idle', 'assist', 't', CFG), true);
  assert.strictEqual(calls.length, 1);
  clock.advance(COOLDOWN_MS - 1); // 59.999s
  assert.strictEqual(alerter.maybeAlert('c1', 'idle', 'assist', 't', CFG), false, '59.999s 被放行');
  clock.advance(1); // 恰好 60.000s
  assert.strictEqual(alerter.maybeAlert('c1', 'idle', 'assist', 't', CFG), true, '60s 整边界未放行');
  assert.strictEqual(calls.length, 2);

  // 失败也进冷却：fetch reject 后立刻再触发（不同 prev 边沿）必须被拦
  const fail = makeAlerter({ fetchBehavior: () => Promise.reject(new Error('down')) });
  assert.strictEqual(fail.alerter.maybeAlert('c2', 'idle', 'assist', 't', CFG), true);
  await new Promise((r) => setImmediate(r)); // 让 rejection 落定
  fail.clock.advance(30_000); // 30s 后上报脚本重试
  assert.strictEqual(fail.alerter.maybeAlert('c2', 'running', 'assist', 't', CFG), false,
    '发送失败后未进冷却——电话通道会被刷屏');
  // 不同状态独立冷却：assist 冷却不挡 stuck
  assert.strictEqual(fail.alerter.maybeAlert('c2', 'idle', 'stuck', 't', CFG), true,
    'assist 的冷却误挡了 stuck');
});

test('冷却 Map 有界性：key 为 agentId:status，每 agent 至多 2 条（生产 MAX_AGENTS=32 兜住总量）', () => {
  const { alerter, clock } = makeAlerter();
  // 同 agent 同状态反复触发只更新同一条
  for (let i = 0; i < 50; i += 1) {
    alerter.maybeAlert('d1', 'idle', 'assist', 't', CFG);
    clock.advance(61_000);
  }
  alerter.maybeAlert('d1', 'idle', 'stuck', 't', CFG);
  // 间接验证有界：resetCooldowns 后再触发立即可发（说明 key 复用同一槽位）
  alerter.resetCooldowns();
  assert.strictEqual(alerter.maybeAlert('d1', 'idle', 'assist', 't', CFG), true);
  // 源码锚定：Map 键格式 agentId:status（有界的关键）
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'alert-webhook.js'), 'utf-8');
  assert.ok(/`\$\{agentId\}:\$\{nextStatus\}`/.test(src), '冷却 key 不含 status——不同状态会互相挤占');
});

// ===========================================================================
// E. 配置 roundtrip + 非法拒收
// ===========================================================================

test('配置 roundtrip：alertWebhook 保存-落盘-重读值一致', () => {
  const r = settingsOps.validateSettingsPayload({
    agents: [{ id: 'a1', name: 'A' }],
    alertWebhook: { enabled: true, url: 'http://127.0.0.1:3001/alert', key: 'K', onAssist: true, onStuck: false },
  });
  assert.strictEqual(r.ok, true);
  const extras = { alertWebhook: r.value.alertWebhook };
  const disk = settingsOps.buildConfigPayload({ extras, agents: [], settings: {}, window: null, watchers: [] });
  const tmp = path.join(os.tmpdir(), `asl-qa-v151-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(disk), 'utf-8');
    const reread = settingsOps.extractConfigExtras(JSON.parse(fs.readFileSync(tmp, 'utf-8')));
    assert.deepStrictEqual(reread.alertWebhook, {
      enabled: true, url: 'http://127.0.0.1:3001/alert', key: 'K', onAssist: true, onStuck: false,
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
});

test('非法配置被拒且不产生 value（不覆盖旧值）：ftp:// / 纯字符串 / >500 字符 / 非对象', () => {
  const badInputs = [
    { alertWebhook: { enabled: true, url: 'ftp://evil.com/x' } },
    { alertWebhook: { enabled: true, url: 'httpx://no-scheme' } },
    { alertWebhook: { enabled: true, url: `http://x.com/${'p'.repeat(500)}` } }, // 总长 >500
    { alertWebhook: 'http://127.0.0.1:3001/alert' }, // 纯字符串
    { alertWebhook: null },
    { alertWebhook: 42 },
    { alertWebhook: { enabled: true, url: 'http://ok.com', key: 'k'.repeat(201) } }, // key 超 200
  ];
  for (const bad of badInputs) {
    const r = settingsOps.validateSettingsPayload({ agents: [{ id: 'a1', name: 'A' }], ...bad });
    assert.strictEqual(r.ok, false, `非法配置未拒: ${JSON.stringify(bad).slice(0, 60)}`);
    assert.ok(!('value' in r) || !r.value, '拒绝时携带了 value（调用方可能误覆盖旧值）');
  }
  // 合法边界：恰好 500 字符 URL、200 字符 key
  const okUrl = `http://x.com/${'p'.repeat(500 - 'http://x.com/'.length)}`;
  const rOk = settingsOps.validateSettingsPayload({
    agents: [{ id: 'a1', name: 'A' }],
    alertWebhook: { enabled: true, url: okUrl, key: 'k'.repeat(200) },
  });
  assert.strictEqual(rOk.ok, true, `边界合法值被拒: ${rOk.error}`);
  // payload 不带 alertWebhook -> value 里也没有 -> main.js 不覆盖 configExtra 现存值
  const rNone = settingsOps.validateSettingsPayload({ agents: [{ id: 'a1', name: 'A' }] });
  assert.strictEqual(rNone.value.alertWebhook, undefined, '缺省携带了 alertWebhook 会覆盖旧值');
});

test('enabled=false / URL 非 http(s)：assist 边沿零网络请求（fetch 间谍证明）', () => {
  const { alerter, calls } = makeAlerter();
  const offCfg = { ...CFG, enabled: false };
  alerter.maybeAlert('e1', 'idle', 'assist', 't', offCfg, '豆包');
  alerter.maybeAlert('e1', 'idle', 'stuck', 't', offCfg, '豆包');
  assert.strictEqual(calls.length, 0, 'enabled=false 仍发请求');
  // 运行时双闸：即使绕过 settings-ops 校验，maybeAlert 自己也拦非 http(s)
  alerter.maybeAlert('e2', 'idle', 'assist', 't', { ...CFG, url: 'file:///etc/passwd' });
  alerter.maybeAlert('e2', 'idle', 'assist', 't', { ...CFG, url: '' });
  alerter.maybeAlert('e2', 'idle', 'assist', 't', { ...CFG, url: undefined });
  assert.strictEqual(calls.length, 0, '运行时 URL 闸门失效');
  // 出厂缺省（configExtra.alertWebhook 整个不存在）
  alerter.maybeAlert('e3', 'idle', 'assist', 't', undefined);
  alerter.maybeAlert('e3', 'idle', 'assist', 't', null);
  assert.strictEqual(calls.length, 0, '未配置时仍发请求');
});

// ===========================================================================
// F. 提示词卡
// ===========================================================================

test('MQTT 卡用真实主题渲染；非法/空主题走占位且拼不出坏主题；与 buildTopics 派生一致', () => {
  const real = prompt.buildMqttPrompt('asl/abc123def456', 'zh-CN');
  assert.ok(real.includes('asl/abc123def456/status'), '真实主题未进正文');
  // 与 mqtt-bridge buildTopics 的派生严格一致（提示词给错主题 = 云 AI 报到真空）
  assert.ok(real.includes(buildTopics('asl/abc123def456').statusTopic));
  // 非法主题：占位，不拼接
  for (const bad of ['', null, undefined, 'not-a-topic', 'asl/../hack', 'ASL/UPPER OK  ', 123]) {
    const txt = prompt.buildMqttPrompt(bad, 'zh-CN');
    assert.ok(txt.includes('<你的主题码>/status'), `非法主题 ${JSON.stringify(bad)} 未走占位`);
    assert.ok(!/asl\/[^<]*\s/.test(txt.split('发布主题：')[1] || ''), '占位里混进了脏主题');
  }
  // 尾空格 trim 后是合法的要用起来
  const trimmed = prompt.buildMqttPrompt('  asl/trimmed0001  ', 'zh-CN');
  assert.ok(trimmed.includes('asl/trimmed0001/status'), '合法主题带空格未 trim');
});

test('提示词双语：两卡正文都换语言；协议事实与源码一致（端点/枚举/force 规则）', () => {
  const zhHttp = prompt.buildHttpPrompt('zh-CN');
  const enHttp = prompt.buildHttpPrompt('en-US');
  assert.ok(zhHttp.includes('永久记忆') && !/PERMANENT MEMORY/.test(zhHttp), 'zh 卡混英文');
  assert.ok(enHttp.includes('PERMANENT MEMORY') && !/[一-鿿]/.test(enHttp), 'en 卡残留中文');
  const zhMqtt = prompt.buildMqttPrompt('asl/x1', 'zh-CN');
  const enMqtt = prompt.buildMqttPrompt('asl/x1', 'en-US');
  assert.ok(!/[一-鿿]/.test(enMqtt), 'en MQTT 卡残留中文');
  assert.ok(zhMqtt.includes('永久记忆'));
  // 协议事实锚定 main.js：17890 端点、5 枚举、force:true 解除粘住
  assert.ok(zhHttp.includes('127.0.0.1:17890/status'), 'HTTP 卡端点错');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf-8');
  assert.ok(/VALID_STATUSES = new Set\(\['running', 'idle', 'stuck', 'assist', 'offline'\]\)/.test(mainSrc),
    'main.js 枚举变了，提示词未同步');
  for (const s of ['running', 'idle', 'stuck', 'assist', 'offline']) {
    assert.ok(zhHttp.includes(s) && enHttp.includes(s), `提示词漏枚举 ${s}`);
  }
  assert.ok(zhHttp.includes('"force":true') && enHttp.includes('"force":true'), '提示词漏 force 规则');
  // 未知语言按 zh
  assert.strictEqual(prompt.buildHttpPrompt('fr'), zhHttp);
});

// ===========================================================================
// G. 源码锚定：接线与唯一路径
// ===========================================================================

test('源码锚定：MQTT 与 HTTP 共用 applyReport；maybeAlert 在状态赋值后调用；全仓库入紫/红仅 applyReport 一处', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf-8');
  // MQTT 云上报走同一 applyReport
  assert.ok(/\(body\) => applyReport\(body\)/.test(mainSrc), 'MQTT 桥不再走 applyReport');
  // maybeAlert 在 agent.status = status 之后、broadcastState 之前
  const assignIdx = mainSrc.indexOf('agent.status = status;');
  const alertIdx = mainSrc.indexOf('alertWebhook.maybeAlert(');
  const bcastIdx = mainSrc.indexOf('broadcastState();', alertIdx);
  assert.ok(assignIdx > -1 && alertIdx > assignIdx && bcastIdx > alertIdx,
    'maybeAlert 接线位置变了（必须在状态赋值之后、广播之前）');
  // maybeAlert 调用被 try/catch 包住（告警故障绝不能炸状态机）
  assert.ok(/try \{\s*alertWebhook\.maybeAlert/.test(mainSrc), 'maybeAlert 未被 try/catch 保护');
  // 全 main/ 目录：把 status 直接写成 assist/stuck 的赋值点只有 applyReport
  const dir = path.join(__dirname, '..', 'main');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf-8');
    const writes = src.match(/\.status\s*=\s*'(assist|stuck)'|status:\s*'(assist|stuck)'/g) || [];
    assert.strictEqual(writes.length, 0,
      `${f} 存在绕过 applyReport 的 assist/stuck 写入: ${writes.join(',')} —— 该路径没接 maybeAlert`);
  }
  // watcher 只报 idle/running/offline（不产生紫红）
  const watcherSrc = fs.readFileSync(path.join(dir, 'agent-watcher.js'), 'utf-8');
  const posts = watcherSrc.match(/post\([^)]*'(running|idle|offline|assist|stuck)'/g) || [];
  for (const p of posts) {
    assert.ok(!/'(assist|stuck)'/.test(p), `watcher 上报了紫/红: ${p}`);
  }
});

// ===========================================================================

(async () => {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.error(`FAIL - ${name}: ${err.message}`);
    }
  }
  console.log(`\n${passed}/${passed + failures.length} tests passed`);
  if (failures.length > 0) process.exit(1);
})();
