'use strict';

/**
 * tests/v170-mini-mode.test.js — v1.7.0「三档显示模式 + 自动收起」（纯 node，离线）。
 *
 * 运行：node tests/v170-mini-mode.test.js
 *
 * 覆盖面：
 *   A. displayMode 三值持久化链路（缺省 classic / 显式 compact·mini 保留 /
 *      非法值兜底 / 写回不丢键）+ autoCollapse 布尔链路
 *   B. 迷你聚合优先级纯函数（assist>stuck>running>idle>offline + 常量 + UMD 双通道）
 *   C. i18n 中英双语新 key（模式名/按钮 tooltip/设置项/自动收起）
 *   D. 三档行高与主进程分支锚点（classic=72 / compact=56 / mini=40<56）
 *      + main.js / 渲染层 / preload / settings.html 链路锚点
 *   E. 版本三处一致（1.7.0）
 *
 * 约束同 strict-running.test.js：不 require main.js（顶层 require('electron')），
 * 用纯函数 + 静态源码锚点；不发起任何网络/HTTP 请求。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const i18n = require('../main/i18n');
const settingsOps = require('../main/settings-ops');
const miniMode = require('../main/mini-mode');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// A. displayMode 三值 + autoCollapse 配置链路（settings-ops 纯函数）
// ---------------------------------------------------------------------------

test('A1 缺省 payload → displayMode === "classic"、autoCollapse === false（缺省行为与 v1.6.3 一致）', () => {
  const r = settingsOps.validateSettingsPayload({ agents: [{ name: '豆包' }], watchers: [] });
  assert.ok(r.ok);
  assert.strictEqual(r.value.displayMode, 'classic');
  assert.strictEqual(r.value.autoCollapse, false);
});

test('A2 显式 compact / mini 保留（三档都合法，不被吞成 classic）', () => {
  const compact = settingsOps.validateSettingsPayload({ agents: [{ name: 'a' }], watchers: [], displayMode: 'compact' });
  assert.strictEqual(compact.value.displayMode, 'compact');
  const mini = settingsOps.validateSettingsPayload({ agents: [{ name: 'a' }], watchers: [], displayMode: 'mini' });
  assert.strictEqual(mini.value.displayMode, 'mini');
  const classic = settingsOps.validateSettingsPayload({ agents: [{ name: 'a' }], watchers: [], displayMode: 'classic' });
  assert.strictEqual(classic.value.displayMode, 'classic');
});

test('A3 非法值兜底 classic（大小写敏感、未知值、数字、空串一律回 classic）', () => {
  for (const junk of ['big', 'MINI', 1, null, '', 'classic ']) {
    const r = settingsOps.validateSettingsPayload({ agents: [{ name: 'a' }], watchers: [], displayMode: junk });
    assert.strictEqual(r.value.displayMode, 'classic', `非法值 ${JSON.stringify(junk)} 未兜底`);
  }
  assert.strictEqual(settingsOps.normalizeDisplayMode('compact'), 'compact');
  assert.strictEqual(settingsOps.normalizeDisplayMode('nonsense'), null);
  assert.deepStrictEqual(settingsOps.DISPLAY_MODES, ['classic', 'compact', 'mini']);
});

test('A4 autoCollapse 布尔链路：显式 true/false 保留、非布尔兜底 false', () => {
  const on = settingsOps.validateSettingsPayload({ agents: [{ name: 'a' }], watchers: [], autoCollapse: true });
  assert.strictEqual(on.value.autoCollapse, true);
  const off = settingsOps.validateSettingsPayload({ agents: [{ name: 'a' }], watchers: [], autoCollapse: false });
  assert.strictEqual(off.value.autoCollapse, false);
  const junk = settingsOps.validateSettingsPayload({ agents: [{ name: 'a' }], watchers: [], autoCollapse: 'yes' });
  assert.strictEqual(junk.value.autoCollapse, false);
});

test('A5 配置写回不丢新键：buildConfigPayload 原样带走 displayMode / autoCollapse（老键不受影响）', () => {
  const payload = settingsOps.buildConfigPayload({
    extras: {},
    agents: [{ id: 'a', name: 'A' }],
    settings: { soundOn: true, showStatusText: true, displayMode: 'mini', autoCollapse: true, language: 'auto' },
    window: { x: null, y: null },
    watchers: [],
  });
  assert.strictEqual(payload.settings.displayMode, 'mini', '写回丢 displayMode');
  assert.strictEqual(payload.settings.autoCollapse, true, '写回丢 autoCollapse');
  assert.strictEqual(payload.settings.showStatusText, true, 'v1.6.3 老键被波及');
});

// ---------------------------------------------------------------------------
// B. 迷你聚合优先级（main/mini-mode.js 纯函数）
// ---------------------------------------------------------------------------

test('B1 聚合优先级：assist > stuck > running > idle > offline（全组合）', () => {
  const agg = miniMode.aggregateStatus;
  assert.strictEqual(agg(['assist', 'stuck', 'running', 'idle', 'offline']), 'assist');
  assert.strictEqual(agg(['stuck', 'running', 'idle', 'offline']), 'stuck');
  assert.strictEqual(agg(['running', 'idle', 'offline']), 'running');
  assert.strictEqual(agg(['idle', 'offline']), 'idle');
  assert.strictEqual(agg(['offline']), 'offline');
  // 顺序无关
  assert.strictEqual(agg(['offline', 'assist']), 'assist');
  assert.strictEqual(agg(['running', 'stuck']), 'stuck');
  assert.strictEqual(agg(['idle', 'running']), 'running');
  assert.strictEqual(agg(['offline', 'idle']), 'idle');
});

test('B2 空清单/未知值/非法入参兜底 offline（全离线 = 灰色灯，不单独做黄色）', () => {
  assert.strictEqual(miniMode.aggregateStatus([]), 'offline');
  assert.strictEqual(miniMode.aggregateStatus(['weird']), 'offline');
  assert.strictEqual(miniMode.aggregateStatus(['weird', 'running']), 'running');
  assert.strictEqual(miniMode.aggregateStatus(null), 'offline');
  assert.strictEqual(miniMode.aggregateStatus(undefined), 'offline');
});

test('B3 常量锚点：MINI_PRIORITY 顺序即实现；MINI_WINDOW=40、MINI_LIGHT_SIZE 在 20~24 区间', () => {
  assert.deepStrictEqual(miniMode.MINI_PRIORITY, ['assist', 'stuck', 'running', 'idle', 'offline']);
  assert.strictEqual(miniMode.MINI_WINDOW, 40);
  assert.ok(miniMode.MINI_LIGHT_SIZE >= 20 && miniMode.MINI_LIGHT_SIZE <= 24, '圆灯直径须在 20~24px');
});

test('B4 UMD 双通道：module+window 并存时 window.ASL_MINI_MODE 也被赋值（rollup 垫片坑）', () => {
  const code = read('main/mini-mode.js');
  const sandbox = { module: { exports: {} }, window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'mini-mode.js' });
  assert.ok(sandbox.window.ASL_MINI_MODE, 'window.ASL_MINI_MODE 未赋值（UMD 双通道被 else 分支破坏）');
  assert.strictEqual(sandbox.window.ASL_MINI_MODE.aggregateStatus(['stuck']), 'stuck');
  assert.ok(sandbox.module.exports && typeof sandbox.module.exports.aggregateStatus === 'function', 'module.exports 通道丢失');
});

// ---------------------------------------------------------------------------
// C. i18n 中英双语新 key
// ---------------------------------------------------------------------------

const MODE_KEYS = ['strip.mode.classic', 'strip.mode.compact', 'strip.mode.mini', 'strip.modeAria', 'strip.miniAria'];
const SW_KEYS = ['sw.displayMode', 'sw.displayModeDesc', 'sw.modeClassic', 'sw.modeCompact', 'sw.modeMini', 'sw.autoCollapse', 'sw.autoCollapseDesc'];

test('C1 模式名/按钮 tooltip 双语齐全：zh/en 非空、逐 key 不同文案', () => {
  for (const key of [...MODE_KEYS, ...SW_KEYS]) {
    const zh = i18n.t('zh-CN', key);
    const en = i18n.t('en-US', key);
    assert.ok(zh && zh.length > 0, `zh-CN 缺 ${key}`);
    assert.ok(en && en.length > 0, `en-US 缺 ${key}`);
    assert.notStrictEqual(zh, en, `${key} 中英撞文案`);
  }
  assert.strictEqual(i18n.t('zh-CN', 'strip.mode.compact'), '精简模式');
  assert.strictEqual(i18n.t('zh-CN', 'strip.mode.mini'), '迷你模式');
  assert.strictEqual(i18n.t('en-US', 'strip.mode.compact'), 'Compact mode');
  assert.strictEqual(i18n.t('en-US', 'strip.mode.mini'), 'Mini mode');
});

test('C2 自动收起文案点题：zh 提 60 秒与卡住/求助，en 提 60 seconds 与 stuck/assist', () => {
  assert.ok(i18n.t('zh-CN', 'sw.autoCollapseDesc').includes('60'));
  assert.ok(i18n.t('zh-CN', 'sw.autoCollapseDesc').includes('卡住'));
  assert.ok(i18n.t('en-US', 'sw.autoCollapseDesc').includes('60'));
  assert.ok(/stuck|assist/i.test(i18n.t('en-US', 'sw.autoCollapseDesc')));
});

// ---------------------------------------------------------------------------
// D. 三档行高与链路锚点
// ---------------------------------------------------------------------------

test('D1 三档行高常量：ROW_HEIGHT=72 / ROW_HEIGHT_COMPACT=56 / MINI_WINDOW=40（40<56<72）', () => {
  const src = read('main/main.js');
  assert.ok(/const ROW_HEIGHT = 72;/.test(src), 'classic 行高不是 72');
  assert.ok(/const ROW_HEIGHT_COMPACT = 56;/.test(src), 'compact 行高常量缺失');
  assert.ok(miniMode.MINI_WINDOW < 56, 'mini 窗口必须比 compact 行高还小');
  assert.ok(/const AUTO_COLLAPSE_DELAY_MS = 60_000;/.test(src), '自动收起 60s 常量缺失');
  assert.ok(!/const ROW_HEIGHT_COMPACT = 72;/.test(src), 'compact 行高被误写成 72');
});

test('D2 main.js 链路锚点：默认 settings / loadConfig 读盘 / settings:set / 面板 get·save / 广播', () => {
  const src = read('main/main.js');
  assert.ok(/let settings = \{[^}]*displayMode: 'classic'[^}]*autoCollapse: false[^}]*\};/.test(src), '默认 settings 缺 displayMode/autoCollapse');
  assert.ok(/raw\.settings\.displayMode === 'string'/.test(src), 'loadConfig 未读 displayMode');
  assert.ok(/settingsOps\.normalizeDisplayMode\(raw\.settings\.displayMode\) \|\| 'classic'/.test(src), 'loadConfig 非法 displayMode 未兜底 classic');
  assert.ok(/raw\.settings\.autoCollapse === 'boolean'/.test(src), 'loadConfig 未读 autoCollapse');
  assert.ok(/ipcMain\.handle\('settingsPanel:get'[\s\S]{0,2000}displayMode: currentDisplayMode\(\)/.test(src), 'settingsPanel:get 未回传 displayMode');
  assert.ok(/ipcMain\.handle\('settingsPanel:get'[\s\S]{0,2000}autoCollapse: settings\.autoCollapse === true/.test(src), 'settingsPanel:get 未回传 autoCollapse');
  assert.ok(/settings\.displayMode = value\.displayMode;/.test(src), 'settingsPanel:save 未应用 displayMode');
  assert.ok(/settings\.autoCollapse = value\.autoCollapse;/.test(src), 'settingsPanel:save 未应用 autoCollapse');
  assert.ok(/settings\.displayMode = mode;[\s\S]{0,200}applyDisplayModeSize\(\);/.test(src), "settings:set 未在 displayMode 变化时应用尺寸");
  assert.ok(/function applyDisplayModeSize\(\)/.test(src), '缺 applyDisplayModeSize');
  assert.ok(/function maybeAutoCollapse\(snapshot\)/.test(src), '缺 maybeAutoCollapse');
  assert.ok(/maybeAutoCollapse\(snapshot\);/.test(src), 'maybeAutoCollapse 未挂进 broadcastState');
  assert.ok(/function isMiniMode\(\)/.test(src), '缺 isMiniMode');
  assert.ok(/baseWindowSizeForMode\(currentDisplayMode\(\)\)/.test(src), '窗口尺寸未按三档模式换算');
  assert.ok(/'displayMode:change'/.test(src), '主进程未广播 displayMode:change');
});

test('D3 渲染层锚点：App.jsx 三分支行高 + 迷你灯点击展开 + 循环切换', () => {
  const app = read('src/App.jsx');
  // classic 72px 字面量原样保留（v1.6.3 布局锚点延续）
  assert.ok(/className="flex h-\[72px\] items-stretch bg-\[#111827\]"/.test(app), 'classic 行高字面量丢失');
  assert.ok(/className="flex h-\[56px\] items-stretch bg-\[#111827\]"/.test(app), 'compact 56px 行分支缺失');
  assert.ok(/<MiniLight agents=\{agents\}/.test(app), 'mini 分支未渲染 MiniLight');
  assert.ok(/'asl-mini'/.test(app), '迷你灯单击识别缺失');
  assert.ok(/lastExpandedRef/.test(app), '迷你展开缺「收起前模式」记忆');
  // v1.7.0 rev2：双入口并存——灯条 ◐ 循环按钮保留（老吴拍板），设置窗口
  // 顶部冻结栏下拉为第二入口（与检查更新同栏）。
  assert.ok(/MODE_CYCLE = \['classic', 'compact', 'mini'\]/.test(app), '模式循环顺序锚点缺失');
  assert.ok(/strip\.mode\.\$\{nextDisplayMode\}/.test(app), '灯条 ◐ 按钮 tooltip 缺失');
  assert.ok(/onDisplayModeChange/.test(app), '渲染层未订阅 displayMode:change');
  assert.ok(/compact=\{displayMode === 'compact'\}/.test(app), 'App 未向 StatusLight 传 compact');
});

test('D4 StatusLight compact 支持：56px 高分支 + 去状态词行 + 72px 字面量保留', () => {
  const light = read('src/components/StatusLight.jsx');
  assert.ok(/compact = false/.test(light), 'compact prop 缺省值必须为 false（classic 行为不变）');
  assert.ok(/w-14 h-\[56px\]/.test(light), 'compact 56px 高度类缺失');
  assert.ok(/w-14 h-\[72px\]/.test(light), 'classic 72px 高度类丢失');
  assert.ok(/showStatusText && !compact \? \(/.test(light), 'compact 未隐藏状态词行');
});

test('D5 MiniLight 聚合灯：running 绿闪 / idle 黄不闪（rev3 对齐展开视图）/ 紫·红闪 / 灰兜底，尺寸走 MINI 常量', () => {
  const src = read('src/components/MiniLight.jsx');
  assert.ok(/data-agent-id="asl-mini"/.test(src), '迷你灯缺 asl-mini 标识（App 点击判定依赖它）');
  assert.ok(!/asl-no-drag/.test(src), '迷你灯必须可拖动（不得加 asl-no-drag）');
  const running = src.slice(src.indexOf('running: {'), src.indexOf('running: {') + 200);
  const idle = src.slice(src.indexOf('idle: {'), src.indexOf('idle: {') + 200);
  assert.ok(/bg-green-500 animate-blink/.test(running), '迷你 running 必须绿闪');
  // v1.7.0 rev3：idle 必须黄色不闪（与 classic 展开视图 idle=黄 一致），
  // 否则「迷你绿、展开满屏黄」自相矛盾（老吴实测反馈）。
  assert.ok(/bg-yellow-400/.test(idle), '迷你 idle 必须黄色（对齐展开视图）');
  assert.ok(!/bg-green/.test(idle), '迷你 idle 不得再归绿色（rev3 漂移锁）');
  assert.ok(!/animate-blink/.test(idle), '迷你 idle 必须不闪');
  assert.ok(/bg-purple-500 animate-blink/.test(src), '迷你 assist 必须紫闪');
  assert.ok(/bg-red-500 animate-blink/.test(src), '迷你 stuck 必须红闪');
  assert.ok(/bg-gray-500/.test(src), '迷你 offline 必须灰色');
  assert.ok(/aggregateStatus\(/.test(src), 'MiniLight 未调用聚合函数');
  assert.ok(/w-10 h-10/.test(src) && /w-5 h-5/.test(src), '迷你灯 40px 容器 + 20px 圆灯锚点缺失');
});

test('D6 preload + settings.html：displayMode 三选一与 autoCollapse 开关齐四件套', () => {
  const preload = read('main/preload.js');
  assert.ok(/onDisplayModeChange/.test(preload), 'preload 缺 onDisplayModeChange 订阅');
  assert.ok(/'displayMode:change'/.test(preload), "preload 未桥接 displayMode:change");

  const html = read('main/settings.html');
  // v1.7.0 rev2：显示模式开关必须冻结在顶部操作栏（与「检查更新」同栏，
  // stickybar 先于 selDisplayMode 出现且在同一冻结块内）。
  assert.ok(/id="stickybar"[\s\S]{0,600}id="selDisplayMode"/.test(html), '显示模式开关未冻结在顶部操作栏（检查更新同栏）');
  assert.ok(/dsel\.title = L\('sw\.displayModeDesc'\)/.test(html), '显示模式 desc 未挂为下拉悬浮提示');
  assert.ok(html.includes('id="selDisplayMode"'), '缺显示模式下拉');
  assert.ok(/<option value="classic">/.test(html) && /<option value="compact">/.test(html) && /<option value="mini">/.test(html), '显示模式下拉缺三档 option');
  assert.ok(/displayMode: document\.getElementById\('selDisplayMode'\)\.value/.test(html), 'gather 未回传 displayMode');
  assert.ok(/getElementById\('selDisplayMode'\)\.value =[\s\S]{0,120}'classic'/.test(html), '回填缺 classic 兜底');
  assert.ok(html.includes('id="swAutoCollapse"'), '缺自动收起 checkbox');
  assert.ok(/autoCollapse: document\.getElementById\('swAutoCollapse'\)\.checked/.test(html), 'gather 未回传 autoCollapse');
  assert.ok(/getElementById\('swAutoCollapse'\)\.checked = cfg\.autoCollapse === true/.test(html), '回填缺省逻辑缺失（缺省关）');
  assert.ok(/lbDisplayMode: 'sw\.displayMode'/.test(html) && /dsel\.title = L\('sw\.displayModeDesc'\)/.test(html), '显示模式未接 i18n key（rev2：desc 挂 title）');
  assert.ok(/lbAutoCollapse: 'sw\.autoCollapse'/.test(html) && /descAutoCollapse: 'sw\.autoCollapseDesc'/.test(html), '自动收起未接 i18n key');
  assert.ok(/dsel\.options\[1\]\.textContent = L\('sw\.modeCompact'\)/.test(html), 'compact 选项文案未接 i18n');
});

// ---------------------------------------------------------------------------
// E. 版本档案
// ---------------------------------------------------------------------------

test('E1 版本三处一致：package.json / main.js APP_VERSION / VERSIONS.md 均为 1.7.0', () => {
  assert.strictEqual(JSON.parse(read('package.json')).version, '1.7.0');
  assert.ok(/const APP_VERSION = '1\.7\.0';/.test(read('main/main.js')), 'APP_VERSION 未升 1.7.0');
  const versions = read('versions/VERSIONS.md');
  assert.ok(versions.includes('## v1.7.0'), 'VERSIONS.md 缺 v1.7.0 条目');
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
