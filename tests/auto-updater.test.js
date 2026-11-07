'use strict';

/**
 * tests/auto-updater.test.js — v1.6.0 功能五：自动更新封装单测（纯 node，注入 checkFn）。
 *
 * 运行：node tests/auto-updater.test.js
 *
 * 契约：
 *  1. 开发模式（未打包）直接跳过，checkFn 都不会被碰
 *  2. 安装版：checkFn（=checkForUpdatesAndNotify）被调，有新版本走系统通知流，
 *     不发灯条横幅
 *  3. 绿色版：有新版本 → onBanner({version, url})；同版本/无 Release → 静默
 *  4. checkFn 抛错（断网/无 Release）→ 只记日志，永不向上抛
 *  5. 横幅文案 i18n 双语含版本号；Releases URL 含 TODO-GITHUB-OWNER 占位
 */

const assert = require('assert');
const au = require('../main/auto-updater');
const i18n = require('../main/i18n');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('开发模式跳过：isPackaged=false 时不碰 checkFn', async () => {
  let called = 0;
  const r = await au.evaluateUpdate({
    isPackaged: false,
    checkFn: async () => { called += 1; return { version: '9.9.9' }; },
    currentVersion: '1.6.0',
  });
  assert.strictEqual(r, 'skipped');
  assert.strictEqual(called, 0);
});

test('安装版：有新版本走 installed-flow（系统通知由 checkForUpdatesAndNotify 完成），不发横幅', async () => {
  let banner = 0;
  const r = await au.evaluateUpdate({
    isPackaged: true,
    isPortable: false,
    checkFn: async () => ({ version: '9.9.9' }),
    currentVersion: '1.6.0',
    onBanner: () => { banner += 1; },
  });
  assert.strictEqual(r, 'installed-flow');
  assert.strictEqual(banner, 0);
});

test('绿色版：有新版本 → 横幅带 version + Releases URL', async () => {
  const banners = [];
  const r = await au.evaluateUpdate({
    isPackaged: true,
    isPortable: true,
    checkFn: async () => ({ version: '1.7.0' }),
    currentVersion: '1.6.0',
    onBanner: (info) => banners.push(info),
  });
  assert.strictEqual(r, 'banner');
  assert.strictEqual(banners.length, 1);
  assert.strictEqual(banners[0].version, '1.7.0');
  assert.strictEqual(banners[0].url, au.RELEASES_URL);
});

test('同版本 / 无 Release（null）/ 坏返回值：静默 none', async () => {
  for (const ret of [{ version: '1.6.0' }, null, { noVersion: 1 }, { version: 123 }]) {
    let banner = 0;
    const r = await au.evaluateUpdate({
      isPackaged: true,
      isPortable: true,
      checkFn: async () => ret,
      currentVersion: '1.6.0',
      onBanner: () => { banner += 1; },
    });
    assert.strictEqual(r, 'none', `返回值 ${JSON.stringify(ret)} 应静默`);
    assert.strictEqual(banner, 0);
  }
});

test('checkFn 抛错：只记日志返回 failed，永不向上抛', async () => {
  const logs = [];
  const r = await au.evaluateUpdate({
    isPackaged: true,
    isPortable: true,
    checkFn: async () => { throw new Error('net down'); },
    currentVersion: '1.6.0',
    logImpl: (m) => logs.push(m),
  });
  assert.strictEqual(r, 'failed');
  assert.strictEqual(logs.length, 1);
  assert.ok(logs[0].includes('net down'));
});

test('横幅文案双语含版本号（i18n update.banner）', () => {
  for (const lang of ['zh-CN', 'en-US']) {
    const s = i18n.t(lang, 'update.banner', { version: '1.7.0' });
    assert.ok(s.includes('1.7.0'), `${lang} 横幅文案缺版本号：${s}`);
    assert.ok(!s.startsWith('update.'), `${lang} 缺翻译`);
  }
});

test('常量契约：首查 30s；Releases URL 指向占位 owner 的仓库 releases 页', () => {
  assert.strictEqual(au.FIRST_CHECK_DELAY_MS, 30_000);
  assert.ok(au.RELEASES_URL.includes('TODO-GITHUB-OWNER'));
  assert.ok(/\/ai-status-light\/releases$/.test(au.RELEASES_URL));
});

test('startAutoUpdate：未打包不装定时器；打包时装（stop 可清）', () => {
  const dev = au.startAutoUpdate({ isPackaged: false, currentVersion: '1.6.0' });
  assert.strictEqual(typeof dev.checkNow, 'function');
  dev.stop();
  const prod = au.startAutoUpdate({
    isPackaged: true,
    isPortable: true,
    currentVersion: '1.6.0',
    logImpl: () => {},
  });
  prod.stop(); // 不抛即过（真实 checkFn 在沙箱不会跑——30s 延迟内已 stop）
});

// ---------------------------------------------------------------------------
// v1.6.1 功能三：手动「检查更新」三态（manualCheck）——用户点了按钮必须有回响，
// GitHub 仓库未发布前恒走 not-ready，不许静默无反馈。
// ---------------------------------------------------------------------------

test('manualCheck：dev 模式（未打包）→ not-ready，不碰 checkFn', async () => {
  let called = 0;
  const r = await au.manualCheck({
    isPackaged: false,
    checkFn: async () => { called += 1; return { version: '9.9.9' }; },
    currentVersion: '1.6.1',
  });
  assert.deepStrictEqual(r, { state: 'not-ready' });
  assert.strictEqual(called, 0);
});

test('manualCheck：checkFn 抛错 / 返回 null / 无 version 字段 → not-ready（源未开放）', async () => {
  for (const checkFn of [
    async () => { throw new Error('net down'); },
    async () => null,
    async () => ({ noVersion: 1 }),
    async () => ({ version: 123 }),
    undefined, // 依赖缺失（electron-updater require 失败 → checkFn 为 null/undefined）
  ]) {
    const r = await au.manualCheck({ isPackaged: true, checkFn, currentVersion: '1.6.1', logImpl: () => {} });
    assert.strictEqual(r.state, 'not-ready', `checkFn=${String(checkFn)} 应 not-ready`);
  }
});

test('manualCheck：同版本 → latest；更新版本 → new 带 version + Releases URL', async () => {
  const same = await au.manualCheck({
    isPackaged: true,
    checkFn: async () => ({ version: '1.6.1' }),
    currentVersion: '1.6.1',
  });
  assert.deepStrictEqual(same, { state: 'latest' });
  const newer = await au.manualCheck({
    isPackaged: true,
    checkFn: async () => ({ version: '1.7.0' }),
    currentVersion: '1.6.1',
  });
  assert.strictEqual(newer.state, 'new');
  assert.strictEqual(newer.version, '1.7.0');
  assert.strictEqual(newer.url, au.RELEASES_URL);
});

test('三态反馈文案双语（sw.updateNew/updateLatest/updateNotReady + sw.checkUpdate）', () => {
  for (const lang of ['zh-CN', 'en-US']) {
    for (const key of ['sw.checkUpdate', 'sw.updateChecking', 'sw.updateLatest', 'sw.updateNotReady']) {
      const s = i18n.t(lang, key);
      assert.ok(s && !s.startsWith('sw.'), `${lang} 缺翻译 ${key}`);
    }
    const s = i18n.t(lang, 'sw.updateNew', { version: '1.7.0' });
    assert.ok(s.includes('1.7.0'), `${lang} updateNew 缺版本号：${s}`);
  }
});

test('startAutoUpdate 返回 checkDetailed（手动入口挂在同一 handle 上）', () => {
  const dev = au.startAutoUpdate({ isPackaged: false, currentVersion: '1.6.1' });
  assert.strictEqual(typeof dev.checkDetailed, 'function');
  dev.stop();
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
