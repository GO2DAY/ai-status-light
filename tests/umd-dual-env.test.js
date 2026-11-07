'use strict';

/**
 * tests/umd-dual-env.test.js — v1.5.2 P0 闸口一：UMD 双环境赋值守卫。
 *
 * 运行：node tests/umd-dual-env.test.js
 *
 * 事故背景（v1.5.0/v1.5.1 渲染层空黑条）：Vite 构建经 rollup commonjs
 * 垫片处理 UMD 文件时，module/exports 与 window **同时存在**。旧写法
 * `if (module) module.exports = api; else window.X = api;` 走了 module
 * 分支，window.ASL_* 永远没被赋值 → 渲染层 I18N.t() 崩 TypeError。
 * Node 单测里 module 天然存在、走同一分支，所以 178 条单测全绿也抓不到。
 *
 * 本测试用 Node vm 构造 module/exports/window 同时存在的沙箱（精确模拟
 * rollup-cjs-wrapper 环境），加载所有会被渲染端消费的 UMD 模块，断言：
 *   1. window.ASL_* 全局被赋值（浏览器通道）
 *   2. module.exports 同样被赋值（Node 通道不丢）
 *   3. 关键函数在 window 全局上可调用
 *
 * 此测试在 v1.5.1 旧代码上必须红，在 v1.5.2 修复后必须绿。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const MAIN_DIR = path.join(__dirname, '..', 'main');

/**
 * 在「module + window 同时存在」的沙箱里加载一个 UMD 文件。
 * 精确模拟 rollup @rollup/plugin-commonjs 的包装环境：
 * 浏览器全局 window 存在，同时垫片注入了 module/exports。
 */
function loadInDualEnv(fileName) {
  const code = fs.readFileSync(path.join(MAIN_DIR, fileName), 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    window: {},
    console,
  };
  // self 不存在 → UMD 的 root 参数会落到 globalThis（即 sandbox 本身），
  // 与 rollup 包装后 root 解析行为一致；window 独立于 root，防止
  // 「root 恰好是 window 所以误绿」。
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: fileName });
  return sandbox;
}

test('i18n.js：module+window 双存在时 window.ASL_I18N 被赋值且 t() 可调', () => {
  const s = loadInDualEnv('i18n.js');
  assert.ok(s.window.ASL_I18N, 'window.ASL_I18N 未赋值（旧 else 分支 bug）');
  assert.strictEqual(typeof s.window.ASL_I18N.t, 'function');
  assert.ok(s.window.ASL_I18N.t('zh-CN', 'status.running').length > 0);
  // Node 通道不丢
  assert.ok(s.module.exports && typeof s.module.exports.t === 'function', 'module.exports 通道丢失');
});

test('strip-name.js：window.ASL_STRIP_NAME 被赋值且 stripDisplayName() 可调', () => {
  const s = loadInDualEnv('strip-name.js');
  assert.ok(s.window.ASL_STRIP_NAME, 'window.ASL_STRIP_NAME 未赋值（旧 else 分支 bug）');
  assert.strictEqual(typeof s.window.ASL_STRIP_NAME.stripDisplayName, 'function');
  assert.strictEqual(s.window.ASL_STRIP_NAME.stripDisplayName('WorkBuddy', 'wb'), 'WorkBuddy');
  assert.ok(s.module.exports && typeof s.module.exports.stripDisplayName === 'function', 'module.exports 通道丢失');
});

test('layout.js：window.ASL_LAYOUT 被赋值且 panelWindowWidth() 可调', () => {
  const s = loadInDualEnv('layout.js');
  assert.ok(s.window.ASL_LAYOUT, 'window.ASL_LAYOUT 未赋值');
  assert.strictEqual(typeof s.window.ASL_LAYOUT.panelWindowWidth, 'function');
  assert.strictEqual(s.window.ASL_LAYOUT.panelWindowWidth(380, 600), 600);
  assert.ok(s.module.exports && typeof s.module.exports.panelWindowWidth === 'function', 'module.exports 通道丢失');
});

test('integration-prompt.js：window.ASL_PROMPT 被赋值且双语言生成器可调', () => {
  const s = loadInDualEnv('integration-prompt.js');
  assert.ok(s.window.ASL_PROMPT, 'window.ASL_PROMPT 未赋值');
  assert.strictEqual(typeof s.window.ASL_PROMPT.buildHttpPrompt, 'function');
  assert.ok(s.window.ASL_PROMPT.buildHttpPrompt('zh-CN').includes('17890'));
  assert.ok(s.module.exports && typeof s.module.exports.buildMqttPrompt === 'function', 'module.exports 通道丢失');
});

test('ai-presets.js：window.ASL_PRESETS 被赋值且结构自检通过', () => {
  const s = loadInDualEnv('ai-presets.js');
  assert.ok(s.window.ASL_PRESETS, 'window.ASL_PRESETS 未赋值');
  assert.ok(Array.isArray(s.window.ASL_PRESETS.PRESET_GROUPS));
  assert.ok(s.window.ASL_PRESETS.validatePresets(s.window.ASL_PRESETS.PRESET_GROUPS).ok);
  assert.ok(s.module.exports && typeof s.module.exports.pickPresets === 'function', 'module.exports 通道丢失');
});

test('gear-menu.js：window.ASL_GEAR_MENU 被赋值且 4 项白名单可用', () => {
  const s = loadInDualEnv('gear-menu.js');
  assert.ok(s.window.ASL_GEAR_MENU, 'window.ASL_GEAR_MENU 未赋值');
  // vm 沙箱跨 realm：数组原型不同，deepStrictEqual 会误判——按 JSON 内容比
  assert.strictEqual(
    JSON.stringify(s.window.ASL_GEAR_MENU.GEAR_MENU_IDS),
    JSON.stringify(['agents', 'settings', 'refresh', 'quit'])
  );
  assert.ok(s.module.exports && typeof s.module.exports.isGearAction === 'function', 'module.exports 通道丢失');
});

test('纯 Node 环境（无 window）不受影响：module.exports 正常', () => {
  // 直接 require 走 Node 通道，验证双通道改动不破坏现有主进程/单测消费方式
  const i18n = require('../main/i18n');
  const strip = require('../main/strip-name');
  const layout = require('../main/layout');
  const prompt = require('../main/integration-prompt');
  const presets = require('../main/ai-presets');
  const gear = require('../main/gear-menu');
  assert.strictEqual(typeof i18n.t, 'function');
  assert.strictEqual(typeof strip.stripDisplayName, 'function');
  assert.strictEqual(typeof layout.panelWindowWidth, 'function');
  assert.strictEqual(typeof prompt.buildHttpPrompt, 'function');
  assert.strictEqual(typeof presets.pickPresets, 'function');
  assert.strictEqual(typeof gear.isGearAction, 'function');
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
