'use strict';

/**
 * tests/settings-ops.test.js — 设置面板纯逻辑层的 node 单测（无 electron 依赖）。
 *
 * 运行：node tests/settings-ops.test.js
 *
 * 覆盖：
 *  1. id 校验（非法字符/长度/重复/留空自动生成）
 *  2. slugify / uniqueAgentId 的生成与去重
 *  3. watcher 归属校验（指向不存在的 agent、按 agentName 解析、空进程剔除、
 *     关键词数组/逗号串两种输入的规范化）
 *  4. 开关缺省值
 *  5. extractConfigExtras + buildConfigPayload 的「未知顶层键不丢」回环
 *     （模拟 config.json 读写：cloudRelay/screenWatch/fgWatch 在保存后仍在）
 */

const assert = require('assert');
const ops = require('../main/settings-ops');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// slugify / uniqueAgentId
// ---------------------------------------------------------------------------

test('slugify: 英文名称转小写、空白转连字符', () => {
  assert.strictEqual(ops.slugifyName('My Agent'), 'my-agent');
  assert.strictEqual(ops.slugifyName('AutoClaw'), 'autoclaw');
});

test('slugify: 中文被剥掉（无拼音库），剥空返回空串', () => {
  assert.strictEqual(ops.slugifyName('豆包'), '');
  assert.strictEqual(ops.slugifyName('小马 bot'), 'bot');
});

test('uniqueAgentId: 空 base 兜底 agent-N，冲突时加序号', () => {
  const taken = new Set(['agent', 'agent-2', 'doubao']);
  assert.strictEqual(ops.uniqueAgentId('', taken), 'agent-3');
  assert.strictEqual(ops.uniqueAgentId('doubao', taken), 'doubao-2');
  assert.strictEqual(ops.uniqueAgentId('kimi', taken), 'kimi');
});

// ---------------------------------------------------------------------------
// validateSettingsPayload — agents
// ---------------------------------------------------------------------------

test('合法提交：完整通过并规范化', () => {
  const r = ops.validateSettingsPayload({
    agents: [
      { id: 'Doubao', name: '豆包' },
      { id: '', name: 'New Bot' },
    ],
    watchers: [{ agent: 'doubao', process: 'Doubao.exe', window: '豆包, Doubao' }],
    soundOn: false,
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value.agents, [
    { id: 'doubao', name: '豆包' },
    { id: 'new-bot', name: 'New Bot' },
  ]);
  assert.deepStrictEqual(r.value.watchers, [
    { agent: 'doubao', process: 'Doubao.exe', task: '桌面端在线', window: ['豆包', 'Doubao'] },
  ]);
  assert.strictEqual(r.value.soundOn, false);
  assert.strictEqual(r.value.cloudRelay, false); // v1.5.0 脱敏：缺省【关】（公共 broker 不默认连）
  assert.strictEqual(r.value.screenWatch, true);
  assert.strictEqual(r.value.openAtLogin, true);
});

// v1.5.0：language 设置校验（auto/zh/en/zh-CN/en-US 收，其余拒绝）
test('language：auto/zh/en 合法并规范化，非法值拒绝', () => {
  const base = { agents: [{ id: 'a', name: 'A' }] };
  assert.strictEqual(ops.validateSettingsPayload(base).value.language, 'auto'); // 缺省 auto
  assert.strictEqual(ops.validateSettingsPayload({ ...base, language: 'zh' }).value.language, 'zh-CN');
  assert.strictEqual(ops.validateSettingsPayload({ ...base, language: 'en' }).value.language, 'en-US');
  assert.strictEqual(ops.validateSettingsPayload({ ...base, language: 'zh-CN' }).value.language, 'zh-CN');
  const bad = ops.validateSettingsPayload({ ...base, language: 'fr' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.key, 'err.languageInvalid');
});

test('非法 id 被拒绝', () => {
  const r = ops.validateSettingsPayload({ agents: [{ id: 'bad id!', name: 'x' }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不合法/);
});

test('重复 id 被拒绝', () => {
  const r = ops.validateSettingsPayload({
    agents: [
      { id: 'doubao', name: 'A' },
      { id: 'Doubao', name: 'B' },
    ],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /重复/);
});

test('名称为空被拒绝', () => {
  const r = ops.validateSettingsPayload({ agents: [{ id: 'a', name: '  ' }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /名称不能为空/);
});

test('id 留空：中文名生成兜底 id 且互不冲突', () => {
  const r = ops.validateSettingsPayload({
    agents: [
      { id: '', name: '豆包' },
      { id: '', name: '马维斯' },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    r.value.agents.map((a) => a.id),
    ['agent', 'agent-2']
  );
});

test('超过 MAX_AGENTS 被拒绝', () => {
  const many = Array.from({ length: ops.MAX_AGENTS + 1 }, (_, i) => ({ id: `a${i}`, name: `A${i}` }));
  const r = ops.validateSettingsPayload({ agents: many });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /上限/);
});

// ---------------------------------------------------------------------------
// validateSettingsPayload — watchers
// ---------------------------------------------------------------------------

test('watcher 指向不存在的 agent 被拒绝', () => {
  const r = ops.validateSettingsPayload({
    agents: [{ id: 'doubao', name: '豆包' }],
    watchers: [{ agent: 'ghost', process: 'Ghost.exe' }],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不存在/);
});

test('watcher 按 agentName 解析（新行 id 留空 + 配了进程）', () => {
  const r = ops.validateSettingsPayload({
    agents: [{ id: '', name: '新助手' }],
    watchers: [{ agent: '', agentName: '新助手', process: 'NewAI.exe', window: ['新助手'] }],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.watchers[0].agent, 'agent');
  assert.strictEqual(r.value.watchers[0].process, 'NewAI.exe');
});

test('空进程 watcher 被剔除（未配置仅接收上报）', () => {
  const r = ops.validateSettingsPayload({
    agents: [{ id: 'doubao', name: '豆包' }],
    watchers: [{ agent: 'doubao', process: '  ' }],
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value.watchers, []);
});

test('同一 agent 的重复 watcher 只保留首条', () => {
  const r = ops.validateSettingsPayload({
    agents: [{ id: 'doubao', name: '豆包' }],
    watchers: [
      { agent: 'doubao', process: 'A.exe' },
      { agent: 'doubao', process: 'B.exe' },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.watchers.length, 1);
  assert.strictEqual(r.value.watchers[0].process, 'A.exe');
});

// ---------------------------------------------------------------------------
// extractConfigExtras + buildConfigPayload —— 配置读写回环
// ---------------------------------------------------------------------------

test('读写回环：顶层开关（cloudRelay/screenWatch/fgWatch/dbPoll）保存后不丢', () => {
  // 模拟磁盘上的 config.json（含顶层开关 + 未来未知键）
  const onDisk = {
    cloudRelay: false,
    screenWatch: false,
    fgWatch: true,
    dbPoll: true,
    futureUnknownFlag: { nested: 1 },
    agents: [{ id: 'doubao', name: '豆包' }],
    settings: { soundOn: true },
    window: { x: 100, y: 0 },
    watchers: [{ agent: 'doubao', process: 'Doubao.exe' }],
  };
  // 主进程加载：提取 extras
  const extras = ops.extractConfigExtras(onDisk);
  assert.deepStrictEqual(extras, {
    cloudRelay: false,
    screenWatch: false,
    fgWatch: true,
    dbPoll: true,
    futureUnknownFlag: { nested: 1 },
  });
  // 主进程写回（例如拖动窗口触发的落盘）：extras 必须原样回来
  const payload = ops.buildConfigPayload({
    extras,
    agents: [{ id: 'doubao', name: '豆包' }],
    settings: { soundOn: true },
    window: { x: 250, y: 0 },
    watchers: [{ agent: 'doubao', process: 'Doubao.exe' }],
  });
  const roundTrip = JSON.parse(JSON.stringify(payload)); // 模拟落盘再读
  assert.strictEqual(roundTrip.cloudRelay, false);
  assert.strictEqual(roundTrip.screenWatch, false);
  assert.strictEqual(roundTrip.fgWatch, true);
  assert.strictEqual(roundTrip.dbPoll, true);
  assert.deepStrictEqual(roundTrip.futureUnknownFlag, { nested: 1 });
  assert.strictEqual(roundTrip.window.x, 250);
  assert.strictEqual(roundTrip.agents.length, 1);
});

test('buildConfigPayload: extras 里的结构键不会覆盖内存状态（双保险）', () => {
  const payload = ops.buildConfigPayload({
    extras: { agents: [{ id: 'stale', name: ' stale ' }], cloudRelay: true },
    agents: [{ id: 'fresh', name: 'Fresh' }],
    settings: { soundOn: false },
    window: { x: 1, y: 2 },
    watchers: [],
  });
  assert.deepStrictEqual(payload.agents, [{ id: 'fresh', name: 'Fresh' }]);
  assert.strictEqual(payload.cloudRelay, true);
});

// ---------------------------------------------------------------------------
// 严过关（QA v1.3.0 独立验证）补充的边界用例
// ---------------------------------------------------------------------------

test('边界：纯中文 id 被拒绝；24 字符 id 通过；25 字符 id 被拒绝', () => {
  const cn = ops.validateSettingsPayload({ agents: [{ id: '豆包', name: 'x' }] });
  assert.strictEqual(cn.ok, false);
  assert.match(cn.error, /不合法/);

  const ok24 = ops.validateSettingsPayload({ agents: [{ id: 'a'.repeat(24), name: 'x' }] });
  assert.strictEqual(ok24.ok, true);
  assert.strictEqual(ok24.value.agents[0].id, 'a'.repeat(24));

  const bad25 = ops.validateSettingsPayload({ agents: [{ id: 'a'.repeat(25), name: 'x' }] });
  assert.strictEqual(bad25.ok, false);
  assert.match(bad25.error, /不合法/);
});

test('边界：uniqueAgentId 对 24 字符冲突 base 加序号后总长仍 ≤24', () => {
  const base = 'a'.repeat(24);
  const taken = new Set([base]);
  const id = ops.uniqueAgentId(base, taken);
  assert.strictEqual(id, `${'a'.repeat(22)}-2`);
  assert.ok(id.length <= 24, `id 超长: ${id}`);
});

test('边界：watcher 的 agent 大小写不敏感（DOUBAO -> doubao）', () => {
  const r = ops.validateSettingsPayload({
    agents: [{ id: 'doubao', name: '豆包' }],
    watchers: [{ agent: 'DOUBAO', process: 'Doubao.exe' }],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.watchers[0].agent, 'doubao');
});

test('边界：窗口关键词超 12 个截断、单条超 64 字符截断、中文逗号分隔', () => {
  const many = Array.from({ length: 20 }, (_, i) => `k${i}`);
  const r = ops.validateSettingsPayload({
    agents: [{ id: 'doubao', name: '豆包' }],
    watchers: [{ agent: 'doubao', process: 'D.exe', window: many }],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.watchers[0].window.length, 12);

  const longKw = 'x'.repeat(100);
  const r2 = ops.validateSettingsPayload({
    agents: [{ id: 'doubao', name: '豆包' }],
    watchers: [{ agent: 'doubao', process: 'D.exe', window: `豆包，${longKw}` }],
  });
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(r2.value.watchers[0].window, ['豆包', 'x'.repeat(64)]);
});

test('边界：agents 非数组被拒绝；watchers 非数组按空处理', () => {
  const bad = ops.validateSettingsPayload({ agents: 'doubao' });
  assert.strictEqual(bad.ok, false);

  const r = ops.validateSettingsPayload({ agents: [{ id: 'a', name: 'A' }], watchers: 'oops' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value.watchers, []);
});

test('边界：extras 嵌套对象读写回环后深值保留；window 缺省补 {x:null,y:null}', () => {
  const onDisk = {
    fgWatch: { intervalMs: 500, exclude: ['explorer.exe'] },
    agents: [{ id: 'a', name: 'A' }],
  };
  const extras = ops.extractConfigExtras(onDisk);
  const payload = ops.buildConfigPayload({
    extras,
    agents: [{ id: 'a', name: 'A' }],
    settings: { soundOn: true },
    window: null,
    watchers: [],
  });
  const roundTrip = JSON.parse(JSON.stringify(payload));
  assert.deepStrictEqual(roundTrip.fgWatch, { intervalMs: 500, exclude: ['explorer.exe'] });
  assert.deepStrictEqual(roundTrip.window, { x: null, y: null });
});

// ---------------------------------------------------------------------------
// v1.6.0 功能四：broker 可配置的白名单校验
// ---------------------------------------------------------------------------

test('broker：缺省不传不出现在 value（不覆盖现存配置）；空串 = 恢复默认', () => {
  const base = { agents: [{ id: 'a', name: 'A' }] };
  const r0 = ops.validateSettingsPayload(base);
  assert.strictEqual(r0.ok, true);
  assert.strictEqual('mqttBroker' in r0.value, false);
  assert.strictEqual('mqttBrokerWss' in r0.value, false);

  const r1 = ops.validateSettingsPayload({ ...base, mqttBroker: '', mqttBrokerWss: '  ' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.value.mqttBroker, ''); // 空串落盘，读侧回退默认
  assert.strictEqual(r1.value.mqttBrokerWss, '');
});

test('broker：mqtt(s):// 与 ws(s):// 前缀放行，其余拒绝（errorKey 双语映射）', () => {
  const base = { agents: [{ id: 'a', name: 'A' }] };
  for (const ok of ['mqtts://mqtt.example.com:8883', 'mqtt://192.168.1.10:1883',
    'wss://mqtt.example.com:8084/mqtt', 'ws://192.168.1.10:8083']) {
    const r = ops.validateSettingsPayload({ ...base, mqttBroker: ok, mqttBrokerWss: ok });
    assert.strictEqual(r.ok, true, `合法前缀被拒：${ok}`);
    assert.strictEqual(r.value.mqttBroker, ok);
  }
  for (const bad of ['ftp://x', 'broker.emqx.io:8883', 'javascript:x', 'http://x']) {
    const r = ops.validateSettingsPayload({ ...base, mqttBroker: bad });
    assert.strictEqual(r.ok, false, `非法前缀被放行：${bad}`);
    assert.strictEqual(r.key, 'err.mqttBrokerInvalid');
    const r2 = ops.validateSettingsPayload({ ...base, mqttBrokerWss: bad });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.key, 'err.mqttBrokerWssInvalid');
  }
  const tooLong = `mqtts://${'x'.repeat(210)}`;
  assert.strictEqual(ops.validateSettingsPayload({ ...base, mqttBroker: tooLong }).ok, false);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
