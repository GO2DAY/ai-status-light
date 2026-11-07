'use strict';

/**
 * tests/gear-menu.test.js — v1.6.0 功能二：齿轮下拉菜单契约单测（纯 node）。
 *
 * 运行：node tests/gear-menu.test.js
 *
 * 契约：
 *  1. 菜单恰好 4 项：agents/settings/refresh/quit（与右键菜单一致 + 直达灯源管理）
 *  2. 每项的 i18n key 在两个语言包都存在且非空
 *  3. 白名单：isGearAction 只放这 4 个动作串（主进程 IPC 防线）
 *  4. 不裁灯契约：菜单是灯条内浮层，不触发 setWidth——panelWindowWidth 的
 *     max 语义保证窗口宽永不低于灯条全宽（v1.5.0 教训的回归锁）
 */

const assert = require('assert');
const gear = require('../main/gear-menu');
const i18n = require('../main/i18n');
const layout = require('../main/layout');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('菜单恰好 4 项且顺序固定：agents/settings/refresh/quit', () => {
  assert.deepStrictEqual(gear.GEAR_MENU_IDS, ['agents', 'settings', 'refresh', 'quit']);
  assert.strictEqual(gear.GEAR_MENU_ITEMS.length, 4);
});

test('每项 i18n key 双语存在且非空；gearMenuLabels 出文案不出 key', () => {
  for (const lang of ['zh-CN', 'en-US']) {
    const labels = gear.gearMenuLabels((key) => i18n.t(lang, key));
    for (const item of labels) {
      assert.ok(item.label && item.label.length > 0, `${lang} ${item.id} 文案为空`);
      assert.ok(!item.label.startsWith('menu.'), `${lang} ${item.id} 缺翻译（回退成了 key）`);
    }
  }
});

test('白名单：只放 4 个动作，任意串/空值/原型链污染全拒', () => {
  for (const ok of ['agents', 'settings', 'refresh', 'quit']) {
    assert.ok(gear.isGearAction(ok));
  }
  for (const bad of ['', 'quit ', 'Quit', 'constructor', '__proto__', null, undefined, 0, {}]) {
    assert.ok(!gear.isGearAction(bad), `坏动作串被放行：${String(bad)}`);
  }
});

test('不裁灯契约：菜单宽度请求（浮层不缩灯条）panelWindowWidth max 语义', () => {
  // 菜单是 overlay：即便渲染层误传一个比灯条小的宽度，窗口也不许缩
  assert.strictEqual(layout.panelWindowWidth(160, 600), 600);
  assert.strictEqual(layout.panelWindowWidth(0, 600), 600); // 收起 = 回灯条全宽
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
