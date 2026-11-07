'use strict';

/**
 * tests/v163-status-text.test.js — v1.6.3「灯下状态文字」+ 漂移锁修复（纯 node，离线）。
 *
 * 运行：node tests/v163-status-text.test.js
 *
 * 覆盖面：
 *   A. 状态词映射（五种状态 → 文案，中英双语，短词版 strip.status.*）
 *   B. statusMeta 静态锚点（短词函数 + 状态着色 + 灯闪文字不闪）
 *   C. showStatusText 配置链路（缺省 true / 显式关闭保留 / 写回不丢新键）
 *   D. 布局增高（ROW_HEIGHT 56→72 与渲染层 h-[72px] 两侧一致）
 *   E. 设置窗口双语开关（settings.html 锚点）
 *   F. 版本档案（1.6.3 三处一致 + VERSIONS.md 条目）
 *
 * 约束同 strict-running.test.js：不 require main.js（顶层 require('electron')），
 * 用纯函数 + 静态源码锚点；不发起任何网络/HTTP 请求。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../main/i18n');
const settingsOps = require('../main/settings-ops');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const STATUSES = ['running', 'idle', 'stuck', 'assist', 'offline'];

// ---------------------------------------------------------------------------
// A. 状态词映射（中英双语）
// ---------------------------------------------------------------------------

test('A1 状态词映射 zh-CN：五态短词精确匹配（offline=离线/running=运行中/idle=空闲/stuck=卡住/assist=等你处理）', () => {
  assert.strictEqual(i18n.t('zh-CN', 'strip.status.offline'), '离线');
  assert.strictEqual(i18n.t('zh-CN', 'strip.status.running'), '运行中');
  assert.strictEqual(i18n.t('zh-CN', 'strip.status.idle'), '空闲');
  assert.strictEqual(i18n.t('zh-CN', 'strip.status.stuck'), '卡住');
  assert.strictEqual(i18n.t('zh-CN', 'strip.status.assist'), '等你处理');
});

test('A2 状态词映射 en-US：五态齐全、非空、与中文不同', () => {
  for (const s of STATUSES) {
    const en = i18n.t('en-US', `strip.status.${s}`);
    const zh = i18n.t('zh-CN', `strip.status.${s}`);
    assert.ok(en && en.length > 0, `en-US 缺 strip.status.${s}`);
    assert.notStrictEqual(en, zh, `en-US 与 zh-CN 撞文案：strip.status.${s}`);
  }
  assert.strictEqual(i18n.t('en-US', 'strip.status.offline'), 'Offline');
  assert.strictEqual(i18n.t('en-US', 'strip.status.running'), 'Running');
});

test('A3 短词与长文案并存：strip.status.* 是独立 key，不复用也不破坏 status.*（tooltip/详情用长文案）', () => {
  // 长文案原样保留（既有消费方不被波及）
  assert.strictEqual(i18n.t('zh-CN', 'status.assist'), '求助/已电话通知，待人工处理');
  // 短词确实更短（灯条 52px 宽度约束）
  assert.ok(
    i18n.t('zh-CN', 'strip.status.assist').length < i18n.t('zh-CN', 'status.assist').length
  );
  // 未知/空状态回退 offline（statusMeta.stripStatusText 同规则，锚点在 B1）
  assert.strictEqual(i18n.t('zh-CN', 'strip.status.offline'), '离线');
});

// ---------------------------------------------------------------------------
// B. statusMeta 静态锚点（src/ 为 ESM + window 依赖，纯 node 不直接加载）
// ---------------------------------------------------------------------------

test('B1 statusMeta.js：stripStatusText 走 strip.status.* 模板，未知状态回退 offline', () => {
  const src = read('src/statusMeta.js');
  assert.ok(/export function stripStatusText\(status\)/.test(src), '缺 stripStatusText 导出');
  assert.ok(
    /strip\.status\.\$\{status \|\| 'offline'\}/.test(src),
    'stripStatusText 未走 strip.status.<status||offline> 模板'
  );
});

test('B2 STATUS_META 五态各带 text 色类（状态词着色与灯色一致）', () => {
  const src = read('src/statusMeta.js');
  const expected = {
    running: 'text-green-400',
    idle: 'text-yellow-300',
    stuck: 'text-red-400',
    assist: 'text-purple-300',
    offline: 'text-gray-400',
  };
  for (const [status, cls] of Object.entries(expected)) {
    const block = src.slice(src.indexOf(`  ${status}: {`), src.indexOf(`  ${status}: {`) + 400);
    assert.ok(block.includes(cls), `STATUS_META.${status} 缺文字色 ${cls}`);
  }
});

test('B3 灯闪文字不闪：stuck/assist 圆灯仍 animate-blink，状态词不加 animate-blink', () => {
  const src = read('src/statusMeta.js');
  assert.ok(/stuck:[\s\S]{0,200}dot: 'bg-red-500 animate-blink'/.test(src));
  assert.ok(/assist:[\s\S]{0,200}dot: 'bg-purple-500 animate-blink'/.test(src));
  const light = read('src/components/StatusLight.jsx');
  const statusWord = light.slice(light.indexOf('v1.6.3 灯下状态文字'));
  assert.ok(!statusWord.includes('animate-blink'), '状态词不应闪烁（圆灯已闪，双闪是噪音）');
});

// ---------------------------------------------------------------------------
// C. showStatusText 配置链路（缺省 true；写回不丢新键）
// ---------------------------------------------------------------------------

test('C1 settings-ops：缺省 payload → showStatusText === true（缺省行为=显示）', () => {
  const r = settingsOps.validateSettingsPayload({
    agents: [{ name: '豆包' }],
    watchers: [],
  });
  assert.ok(r.ok);
  assert.strictEqual(r.value.showStatusText, true);
});

test('C2 settings-ops：显式 false 保留、非布尔值按缺省 true 兜底', () => {
  const off = settingsOps.validateSettingsPayload({ agents: [{ name: 'a' }], watchers: [], showStatusText: false });
  assert.strictEqual(off.value.showStatusText, false, '显式关闭被吞');
  const junk = settingsOps.validateSettingsPayload({ agents: [{ name: 'a' }], watchers: [], showStatusText: 'no' });
  assert.strictEqual(junk.value.showStatusText, true, '非布尔未兜底');
});

test('C3 配置写回不丢新键：buildConfigPayload 原样带走 settings.showStatusText', () => {
  const payload = settingsOps.buildConfigPayload({
    extras: {},
    agents: [{ id: 'a', name: 'A' }],
    settings: { soundOn: true, repeatAlert: true, showStatusText: false, language: 'auto' },
    window: { x: null, y: null },
    watchers: [],
  });
  assert.strictEqual(payload.settings.showStatusText, false, '写回丢 showStatusText');
  // 未知顶层键保留逻辑不受影响（回归锚点）
  const extras = settingsOps.extractConfigExtras({ futureKey: { nested: 1 }, settings: {} });
  assert.deepStrictEqual(extras.futureKey, { nested: 1 });
});

test('C4 main.js 链路锚点：默认 settings 含 showStatusText: true；loadConfig 读盘；面板视图回传', () => {
  const src = read('main/main.js');
  assert.ok(
    /let settings = \{[^}]*showStatusText: true[^}]*\};/.test(src),
    '默认 settings 缺 showStatusText: true'
  );
  assert.ok(
    /raw\.settings\.showStatusText === 'boolean'/.test(src),
    'loadConfig 未读 raw.settings.showStatusText'
  );
  assert.ok(
    /showStatusText: settings\.showStatusText !== false/.test(src),
    'settingsPanel:get 未回传 showStatusText'
  );
  assert.ok(
    /settings\.showStatusText = value\.showStatusText;/.test(src),
    'settingsPanel:save 未应用 showStatusText'
  );
});

// ---------------------------------------------------------------------------
// D. 布局增高（ROW_HEIGHT 56→72，两侧一致）
// ---------------------------------------------------------------------------

test('D1 主进程 ROW_HEIGHT = 72（v1.6.3 灯下状态文字增高）', () => {
  const src = read('main/main.js');
  assert.ok(/const ROW_HEIGHT = 72;/.test(src), 'ROW_HEIGHT 不是 72');
  assert.ok(!/const ROW_HEIGHT = 56;/.test(src), '残留旧 56 定义');
});

test('D2 渲染层两侧同步：App.jsx 灯条行 h-[72px]，StatusLight 按钮 h-[72px]，旧 h-14 灯条行不再存在', () => {
  const app = read('src/App.jsx');
  assert.ok(/className="flex h-\[72px\] items-stretch bg-\[#111827\]"/.test(app), 'App.jsx 灯条行未增高');
  assert.ok(!/flex h-14 items-stretch/.test(app), '残留 56px 灯条行');
  const light = read('src/components/StatusLight.jsx');
  assert.ok(/w-14 h-\[72px\]/.test(light), 'StatusLight 按钮未增高');
  assert.ok(!/h-14 /.test(light.replace(/w-14 h-\[72px\]/g, '')), 'StatusLight 残留 h-14');
});

test('D3 App.jsx → StatusLight 传参：showStatusText={settings.showStatusText !== false}', () => {
  const app = read('src/App.jsx');
  assert.ok(
    /showStatusText=\{settings\.showStatusText !== false\}/.test(app),
    'App.jsx 未把 showStatusText 传给 StatusLight'
  );
  const light = read('src/components/StatusLight.jsx');
  assert.ok(/showStatusText = true/.test(light), 'StatusLight prop 缺省值必须为 true');
  assert.ok(/stripStatusText\(agent\.status\)/.test(light), '状态词未接 stripStatusText');
});

// ---------------------------------------------------------------------------
// E. 设置窗口双语开关（settings.html 锚点）
// ---------------------------------------------------------------------------

test('E1 settings.html：swShowStatusText 开关齐四件套（checkbox/label/desc/gather/回填）', () => {
  const html = read('main/settings.html');
  assert.ok(html.includes('id="swShowStatusText"'), '缺 checkbox');
  assert.ok(html.includes('id="lbShowStatusText"') && html.includes('id="descShowStatusText"'), '缺双语 label/desc 挂点');
  assert.ok(/showStatusText: document\.getElementById\('swShowStatusText'\)\.checked/.test(html), 'gather 未回传');
  assert.ok(/getElementById\('swShowStatusText'\)\.checked = cfg\.showStatusText !== false/.test(html), '回填缺省逻辑缺失');
  assert.ok(/lbShowStatusText: 'sw\.showStatusText'/.test(html) && /descShowStatusText: 'sw\.showStatusTextDesc'/.test(html), 'applyStaticTexts 未接 i18n key');
});

// ---------------------------------------------------------------------------
// F. 版本档案
// ---------------------------------------------------------------------------

test('F1 版本三处一致：package.json / main.js APP_VERSION / VERSIONS.md 均为 1.7.0', () => {
  assert.strictEqual(JSON.parse(read('package.json')).version, '1.7.0');
  assert.ok(/const APP_VERSION = '1\.7\.0';/.test(read('main/main.js')), 'APP_VERSION 未升 1.7.0');
  const versions = read('versions/VERSIONS.md');
  assert.ok(versions.includes('## v1.6.3'), 'VERSIONS.md 缺 v1.6.3 条目');
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
