'use strict';

/**
 * tests/qa-v150-adversarial.test.js — v1.5.0 全球发布版独立对抗验证（QA 严过关 R4）。
 *
 * 全部独立构造，不复用工程师的 i18n/v150-features 测试：
 *   A. i18n：en 包新控件 key 独立清点、t() 插值在 en 语序下的正确性、
 *      normalizeLanguage/resolveLanguage 边界
 *   B. 迁移三连（复刻 main.js:300-318 分支语义 + 落盘 roundtrip + 源码锚定）
 *   C. regenerateTopic：buildTopics 契约、旧主题停用、节流中快照不发旧主题
 *   D. 不裁灯 panelWindowWidth 对抗边界
 *   E. 两行灯名 stripDisplayName 保险丝
 *   F. 拖入添加的 origin 语义（源码锚定：只有 handleAutoDiscover 打 'auto'）
 *
 * 运行：node tests/qa-v150-adversarial.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// mqtt mock（与 tests/mqtt-bridge.test.js 同款：exports.connect 是 getter-only，
// 必须整对象替换 require 缓存，且必须先 require 真实 mqtt 填缓存）
const mqttPath = require.resolve('mqtt');
const realMqtt = require('mqtt');
let fakeClient = null;
let publishCalls = [];
let subscribeCalls = [];
function fakeConnect() {
  publishCalls = [];
  subscribeCalls = [];
  fakeClient = Object.assign(new EventEmitter(), {
    connected: true,
    subscribe(topic, opts, cb) {
      subscribeCalls.push(topic);
      if (cb) cb(null);
    },
    publish(topic, payload, opts, cb) {
      publishCalls.push({ topic, payload: String(payload) });
      if (cb) cb(null);
    },
    end() {},
  });
  return fakeClient;
}
require.cache[mqttPath].exports = Object.assign({}, realMqtt, { connect: fakeConnect });

const i18n = require('../main/i18n');
const { panelWindowWidth } = require('../main/layout');
const { stripDisplayName, STRIP_NAME_MAX } = require('../main/strip-name');
const settingsOps = require('../main/settings-ops');
const { startMqttBridge, buildTopics, DEFAULT_TOPIC_BASE } = require('../main/mqtt-bridge');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ===========================================================================
// A. i18n
// ===========================================================================

test('en 包独立清点：v1.4.x-v1.5.0 全部新控件 key 在 en-US 存在且非空', () => {
  const mustHave = [
    // v1.5.0 新增：语言下拉 / MQTT 主题 / 脱敏
    'sw.language', 'sw.langAuto', 'sw.langZh', 'sw.langEn',
    'sw.mqttTopic', 'sw.mqttTopicDesc', 'sw.regenerate', 'sw.regenerated', 'sw.regenerateFail',
    'err.languageInvalid',
    // v1.4.3 拖放
    'sw.dropTitle', 'sw.dropHint', 'sw.dropNoPath', 'sw.dropIdentifying', 'sw.dropDup',
    'sw.dropPartial', 'sw.dropAdded', 'sw.dropFail', 'sw.dropFailErr', 'sw.dropReject',
    // v1.4.1 黑名单管理
    'sw.blacklist', 'sw.blacklistHint', 'sw.unblacklist', 'sw.unblacklistOk', 'sw.unblacklistFail',
    // v1.4.0 声音/自动发现
    'sw.volume', 'sw.volLow', 'sw.volMid', 'sw.volHigh', 'sw.repeatAlert',
    'sw.autoDiscover', 'sw.autoDiscoverDesc',
  ];
  for (const key of mustHave) {
    const v = i18n.PACKS['en-US'][key];
    assert.ok(typeof v === 'string' && v.trim().length > 0, `en-US 漏 key: ${key}`);
  }
});

test('两包 key 集合严格相等（独立复验，不信工程师守卫）', () => {
  const zh = Object.keys(i18n.PACKS['zh-CN']).sort();
  const en = Object.keys(i18n.PACKS['en-US']).sort();
  assert.deepStrictEqual(en, zh,
    `key 漂移: en 缺 ${zh.filter((k) => !en.includes(k))} / zh 缺 ${en.filter((k) => !zh.includes(k))}`);
  // 且 en 包不得残留未翻译的中文（漏翻检测：en 文案不应含 CJK，刻意双语/中文名除外）
  const cjkAllowed = new Set([
    'sw.langZh', // 「中文」选项名本就该是中文
    'sw.language', // 'Language / 语言' 刻意双语：en 界面下中文用户也要能认出语言切换器
  ]);
  for (const [k, v] of Object.entries(i18n.PACKS['en-US'])) {
    if (cjkAllowed.has(k)) continue;
    assert.ok(!/[一-鿿]/.test(v), `en-US 文案残留中文（漏翻）: ${k} = ${v}`);
  }
});

test('t() 插值语序：en 数字在中、zh 数字在尾，多占位正确替换', () => {
  assert.strictEqual(i18n.t('en-US', 'sw.valNameEmpty', { n: 3 }), 'Row 3: name cannot be empty');
  assert.strictEqual(i18n.t('zh-CN', 'sw.valNameEmpty', { n: 3 }), '第 3 行：名称不能为空');
  assert.strictEqual(
    i18n.t('en-US', 'sw.unblacklistFail', { err: 'boom' }), 'Unblock failed: boom');
  assert.strictEqual(
    i18n.t('en-US', 'sw.dropIdentifying', { name: 'Doubao' }), 'Identifying "Doubao"…');
  // 双占位：err.watcherDangling 有 {proc} 和 {agent}
  const w = i18n.t('en-US', 'err.watcherDangling', { proc: 'x.exe', agent: 'abc' });
  assert.ok(w.includes('x.exe') && w.includes('abc') && !w.includes('{'),
    `多占位替换失败: ${w}`);
  // 未知 key 回退 key 本身；未知语言回退中文包
  assert.strictEqual(i18n.t('en-US', 'no.such.key'), 'no.such.key');
  assert.strictEqual(i18n.t('klingon', 'status.running'), '运行中');
});

test('normalizeLanguage/resolveLanguage 边界', () => {
  assert.strictEqual(i18n.normalizeLanguage('zh'), 'zh-CN');
  assert.strictEqual(i18n.normalizeLanguage('en'), 'en-US');
  assert.strictEqual(i18n.normalizeLanguage('zh-TW'), 'zh-CN'); // 繁体也进中文包
  assert.strictEqual(i18n.normalizeLanguage('EN_us'), 'en-US'); // 大小写不敏感
  assert.strictEqual(i18n.normalizeLanguage('fr'), null);
  assert.strictEqual(i18n.normalizeLanguage(''), null);
  assert.strictEqual(i18n.normalizeLanguage(null), null);
  assert.strictEqual(i18n.normalizeLanguage(123), null);
  // resolve：显式值优先；auto 跟随系统；非法值按 auto
  assert.strictEqual(i18n.resolveLanguage('en-US', 'zh-CN'), 'en-US');
  assert.strictEqual(i18n.resolveLanguage('auto', 'en-US'), 'en-US');
  assert.strictEqual(i18n.resolveLanguage('auto', 'zh-Hans-CN'), 'zh-CN');
  assert.strictEqual(i18n.resolveLanguage('klingon', 'zh-CN'), 'zh-CN'); // 非法 -> auto -> zh
  assert.strictEqual(i18n.resolveLanguage(undefined, 'ja-JP'), 'en-US'); // 非 zh 系统 -> en
});

// ===========================================================================
// B. 迁移三连（main.js:300-318 的行为级复刻 + 落盘 roundtrip + 源码锚定）
// ===========================================================================

// 与 main.js:216-217 同一正则（main.js 不可单测 require，源码锚定见下一条测试）
const TOPIC_RE = /^asl\/[a-z0-9_-]{1,48}$/i;
function isValidMqttTopic(v) {
  return typeof v === 'string' && TOPIC_RE.test(v);
}

/** 复刻 main.js loadConfig 的迁移分支（300-318 行逐行对应）。 */
function simulateMigration(raw) {
  const configExtra = settingsOps.extractConfigExtras(raw);
  let cloudRelayFlag;
  let migratedCloudRelay = false;
  let generatedTopic = false;
  if (typeof raw.cloudRelay === 'boolean') {
    cloudRelayFlag = raw.cloudRelay;
  } else {
    cloudRelayFlag = true; // 老配置隐含默认开 -> 迁移为显式 true
    configExtra.cloudRelay = true;
    migratedCloudRelay = true;
  }
  if (!isValidMqttTopic(configExtra.mqttTopic)) {
    // 复刻 generateMqttTopic 的形态（asl/ + 12 hex），测试里用固定合法值
    configExtra.mqttTopic = 'asl/abcdef123456';
    generatedTopic = true;
  }
  return { configExtra, cloudRelayFlag, migratedCloudRelay, generatedTopic };
}

test('迁移①：老 config（无 cloudRelay 无 mqttTopic）-> cloudRelay=true 且主题生成，双双落盘', () => {
  const legacy = { agents: [{ id: 'doubao', name: '豆包' }], settings: { soundOn: true }, watchers: [] };
  const { configExtra, cloudRelayFlag, migratedCloudRelay, generatedTopic } = simulateMigration(legacy);
  assert.strictEqual(cloudRelayFlag, true, '老配置云链路被静默掐掉');
  assert.strictEqual(migratedCloudRelay, true, '未迁移为显式 true');
  assert.strictEqual(generatedTopic, true, '未生成随机主题');
  assert.ok(isValidMqttTopic(configExtra.mqttTopic));
  // 落盘 roundtrip：迁移结果必须随盘持久化（否则下次启动又走一遍迁移）
  const tmp = path.join(os.tmpdir(), `asl-qa-v150-${Date.now()}.json`);
  try {
    const disk = settingsOps.buildConfigPayload({
      extras: configExtra, agents: legacy.agents, settings: legacy.settings,
      window: null, watchers: [],
    });
    fs.writeFileSync(tmp, JSON.stringify(disk), 'utf-8');
    const reread = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
    assert.strictEqual(reread.cloudRelay, true, 'cloudRelay=true 未落盘');
    assert.ok(isValidMqttTopic(reread.mqttTopic), 'mqttTopic 未落盘');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
});

test('迁移②：显式 cloudRelay=false 升级后仍 false（迁移不得覆盖用户显式选择）', () => {
  const raw = { agents: [], settings: {}, watchers: [], cloudRelay: false, mqttTopic: 'asl/userkept0001' };
  const { configExtra, cloudRelayFlag, migratedCloudRelay, generatedTopic } = simulateMigration(raw);
  assert.strictEqual(cloudRelayFlag, false, '用户显式关闭被迁移覆盖成开');
  assert.strictEqual(migratedCloudRelay, false);
  assert.strictEqual(generatedTopic, false, '合法主题被重新生成');
  assert.strictEqual(configExtra.mqttTopic, 'asl/userkept0001', '用户主题被换掉');
});

test('迁移③：mqttTopic 被手改成非法字符 -> 回退生成合法主题', () => {
  for (const bad of ['not-a-topic', 'asl/', 'asl/UPPER SPACE!!', 'foo/bar/baz', '', 123, null, 'mqtt://evil']) {
    const raw = { agents: [], settings: {}, watchers: [], cloudRelay: true, mqttTopic: bad };
    const { configExtra, generatedTopic } = simulateMigration(raw);
    assert.ok(generatedTopic, `非法主题 ${JSON.stringify(bad)} 未触发回退`);
    assert.ok(isValidMqttTopic(configExtra.mqttTopic), `回退主题不合法: ${configExtra.mqttTopic}`);
  }
  // 合法的边界形态必须被保留（不被误回退）：大写 hex、下划线、48 字符上限
  for (const good of ['asl/ABCDEF123456', 'asl/a_b-c', `asl/${'x'.repeat(48)}`]) {
    const { configExtra, generatedTopic } = simulateMigration({
      agents: [], settings: {}, watchers: [], cloudRelay: true, mqttTopic: good,
    });
    assert.ok(!generatedTopic && configExtra.mqttTopic === good, `合法主题 ${good} 被误回退`);
  }
});

test('源码锚定：main.js 迁移/回退分支与我复刻的语义一致', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf-8');
  // 迁移分支存在且顺序正确：显式 boolean 优先，否则迁移为显式 true
  assert.ok(/typeof raw\.cloudRelay === 'boolean'[\s\S]{0,200}else \{[\s\S]{0,100}cloudRelayFlag = true;[\s\S]{0,100}configExtra\.cloudRelay = true;/.test(src),
    'cloudRelay 迁移分支缺失或语义变了');
  // 主题回退：非法 -> generateMqttTopic
  assert.ok(/if \(!isValidMqttTopic\(configExtra\.mqttTopic\)\) \{\s*configExtra\.mqttTopic = generateMqttTopic\(\);/.test(src),
    'mqttTopic 回退分支缺失');
  // isValidMqttTopic 正则与我复刻的一致
  assert.ok(/\/\^asl\\\/\[a-z0-9_-\]\{1,48\}\$\/i/.test(src), 'main.js 主题正则被改');
  // 全新安装种子：cloudRelay:false + 随机主题
  assert.ok(/cloudRelay: false,[\s\S]{0,80}mqttTopic: generateMqttTopic\(\)/.test(src),
    '出厂种子配置不是 cloudRelay:false + 随机主题');
});

// ===========================================================================
// C. regenerateTopic / buildTopics
// ===========================================================================

test('buildTopics 契约：合法派生、尾斜杠清理、非法回退默认', () => {
  assert.deepStrictEqual(buildTopics('asl/abc123'), {
    statusTopic: 'asl/abc123/status', stateTopic: 'asl/abc123/state',
  });
  assert.deepStrictEqual(buildTopics('asl/abc123///').stateTopic, 'asl/abc123/state');
  for (const bad of ['', null, undefined, 123, 'no-slash', 'asl/', '/onlysuffix', 'a b/c']) {
    assert.strictEqual(buildTopics(bad).stateTopic, `${DEFAULT_TOPIC_BASE}/state`,
      `非法 base ${JSON.stringify(bad)} 未回退默认主题`);
  }
});

test('重新生成后：旧桥 stop 立即停发，新连接订阅新主题，快照只发新主题', async () => {
  const baseRef = { current: 'asl/oldbase1111' };
  const enabledRef = { current: true };
  const bridge = startMqttBridge(
    () => {}, () => {}, () => enabledRef.current, () => baseRef.current
  );
  fakeClient.emit('connect');
  assert.deepStrictEqual(subscribeCalls, ['asl/oldbase1111/status'], '未订阅旧主题');
  // 发一份快照（首发立即走 doPublish，不节流）
  bridge.publishState([{ id: 'a', status: 'idle' }]);
  assert.strictEqual(publishCalls.length, 1);
  assert.strictEqual(publishCalls[0].topic, 'asl/oldbase1111/state');
  // 第二份立刻进来 -> 进入 500ms 节流（trailing 定时器挂着）
  bridge.publishState([{ id: 'a', status: 'running' }]);
  assert.strictEqual(publishCalls.length, 1, '第二份应被节流挂起');
  // 此刻用户点「重新生成」：旧桥 stop（节流定时器必须被清，快照绝不能发去旧主题）
  bridge.stop();
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(publishCalls.length, 1,
    `节流中的快照泄漏到旧主题（发了 ${publishCalls.length} 次）`);
  // stop 后 publishState 是 no-op
  bridge.publishState([{ id: 'a', status: 'stuck' }]);
  assert.strictEqual(publishCalls.length, 1, 'stop 后仍发布');
  // 新桥（main.js startCloudBridge 重起）读新主题：换 base + 新桥实例
  baseRef.current = 'asl/newbase2222';
  const bridge2 = startMqttBridge(() => {}, () => {}, () => true, () => baseRef.current);
  fakeClient.emit('connect');
  assert.deepStrictEqual(subscribeCalls, ['asl/newbase2222/status'], '新桥未订阅新主题');
  bridge2.publishState([{ id: 'a', status: 'idle' }]);
  assert.strictEqual(publishCalls[0].topic, 'asl/newbase2222/state', '新桥快照未发新主题');
  bridge2.stop();
});

test('节流中快照发新主题（不 stop 仅换 base 的热切换路径）', async () => {
  // currentTopics() 每次现取：即使 trailing 定时器是换主题前挂的，
  // 触发时也应发到「当前」主题（设计语义：无缝跟上）
  const baseRef = { current: 'asl/baseA1111111' };
  const bridge = startMqttBridge(() => {}, () => {}, () => true, () => baseRef.current);
  fakeClient.emit('connect');
  bridge.publishState([{ id: 'x', status: 'idle' }]); // 立即发
  bridge.publishState([{ id: 'x', status: 'running' }]); // 节流挂起
  baseRef.current = 'asl/baseB2222222'; // 节流窗口内换主题
  await new Promise((r) => setTimeout(r, 600));
  const last = publishCalls[publishCalls.length - 1];
  assert.strictEqual(last.topic, 'asl/baseB2222222/state',
    `trailing 快照发到了旧主题: ${last.topic}`);
  bridge.stop();
});

// ===========================================================================
// D. 不裁灯 panelWindowWidth
// ===========================================================================

test('不裁灯：请求宽<灯条宽=灯条宽；>请求宽；0/非法=灯条全宽', () => {
  assert.strictEqual(panelWindowWidth(380, 672), 672, '灯多时不许裁灯');
  assert.strictEqual(panelWindowWidth(800, 672), 800, '请求更宽时用请求宽');
  assert.strictEqual(panelWindowWidth(0, 672), 672, '收起面板回灯条全宽');
  assert.strictEqual(panelWindowWidth(-5, 672), 672);
  assert.strictEqual(panelWindowWidth(NaN, 672), 672);
  assert.strictEqual(panelWindowWidth(undefined, 672), 672);
  assert.strictEqual(panelWindowWidth('380', 672), 672, '数字字符串按数字处理：380<672 不裁灯');
  assert.strictEqual(panelWindowWidth(672, 672), 672, '相等边界');
  // 灯条宽本身非法的防御：请求有效时用请求，都非法归 0
  assert.strictEqual(panelWindowWidth(380, NaN), 380);
  assert.strictEqual(panelWindowWidth(0, NaN), 0);
  assert.strictEqual(panelWindowWidth(380.6, 672.4), 672, '小数应取整后比较');
});

// ===========================================================================
// E. 两行灯名保险丝
// ===========================================================================

test('灯名保险丝：13 字符截断为 12+省略号；6 字中文不截；空名回退', () => {
  assert.strictEqual(STRIP_NAME_MAX, 12);
  const n13 = 'CherryStudioX'; // 13 字符
  const out = stripDisplayName(n13);
  assert.strictEqual(Array.from(out).length, 13, '截断后应为 12 字 + 1 省略号');
  assert.ok(out.endsWith('…') && out.startsWith('CherryStudio'), `截断形态不对: ${out}`);
  assert.strictEqual(stripDisplayName('豆包工作伙伴'), '豆包工作伙伴', '6 字中文被误截');
  const n12 = '樱桃小丸子测验吧'; // 恰好 8 字，再用 12 拉丁测边界
  assert.strictEqual(stripDisplayName(n12), n12);
  assert.strictEqual(stripDisplayName('ABCDEFGHIJKL'), 'ABCDEFGHIJKL', '恰好 12 不应截');
  assert.strictEqual(stripDisplayName(''), '?');
  assert.strictEqual(stripDisplayName('', 'doubao'), 'doubao', '空名未回退 id');
  assert.strictEqual(stripDisplayName('   ', '  '), '?', '全空白未归 ?');
  // CJK/emoji 按码点计（Array.from），不会截断出半个代理对
  const emoji13 = '🔥'.repeat(13);
  const eOut = stripDisplayName(emoji13);
  assert.strictEqual(Array.from(eOut).length, 13, 'emoji 应按码点截断');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(eOut), '截断产生了代理对残片');
});

// ===========================================================================
// F. 拖入添加的 origin 语义（v1.4.3 遗留项，v1.5.0 一并锚定）
// ===========================================================================

test('origin 语义：仅 handleAutoDiscover 打 auto；面板/拖入添加路径不带 origin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf-8');
  // origin:'auto' 只许两种形态：handleAutoDiscover 里的无条件打标（恰好 1 处），
  // 以及 loadConfig 回读落盘标记的条件传播（entry.origin === 'auto' ? ...）。
  // 其他任何位置出现 = 手动/拖入路径误标 auto。
  const lines = src.split('\n');
  const originLines = lines.filter((l) => /origin:\s*'auto'/.test(l));
  let unconditional = 0;
  for (const l of originLines) {
    if (/entry\.origin === 'auto'/.test(l)) continue; // 条件传播，合法
    unconditional += 1;
    // 无条件打标点必须在 handleAutoDiscover 函数体内（其后 30 行内有 discoveredAt 配对）
    const idx = lines.indexOf(l);
    const ctx = lines.slice(Math.max(0, idx - 40), idx).join('\n');
    assert.ok(/function handleAutoDiscover/.test(ctx) && /discoveredAt/.test(lines.slice(idx, idx + 5).join('\n')),
      `handleAutoDiscover 之外出现无条件 origin:'auto' 打标: ${l.trim()}`);
  }
  assert.strictEqual(unconditional, 1, `无条件打标点应为 1，实际 ${unconditional}`);
  // settingsPanel:save 的新增分支（面板/拖入）不设 origin
  const saveNewBranch = src.match(/agents\.set\(a\.id, \{[^}]*\}\)/g) || [];
  for (const branch of saveNewBranch) {
    assert.ok(!branch.includes('origin'), `面板新增分支带了 origin: ${branch}`);
  }
  // 语义后果验证：无 origin 的 agent 走 shouldSkipDeletion 必不豁免（拖入=用户主动）
  assert.strictEqual(
    settingsOps.shouldSkipDeletion({ id: 'x', name: '拖入的' }, 0),
    false, '拖入添加的 agent 被误豁免');
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
