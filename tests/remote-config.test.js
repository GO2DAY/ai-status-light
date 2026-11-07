'use strict';

/**
 * tests/remote-config.test.js — v1.6.0 功能三：作者配置中心单测（纯 node，假 fetch）。
 *
 * 运行：node tests/remote-config.test.js
 *
 * 契约：
 *  1. 多 URL 回退：按序尝试，第一个拿到合法 JSON 的胜出
 *  2. 全部失败 → {ok:false} 静默；坏 JSON / 非对象 → 尝试下一个
 *  3. 缓存降级：成功写缓存；无网时读缓存；无缓存用内置默认
 *  4. 字段白名单清洗：坏字段丢回默认，url 只收 https
 *  5. 引流位判定：alertWebhook.url 空才显示；兜底 kofiUrl 永远可用
 *  6. 常量契约：首拉 10s、轮询 6h、超时 8s
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rc = require('../main/remote-config');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** 假 fetch 工厂：按 URL 路由到响应/错误，记录调用顺序。 */
function makeFetch(routes, calls) {
  return async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error('ECONNREFUSED');
    if (r.throw) throw new Error(r.throw);
    return { ok: r.ok !== false, text: async () => r.text };
  };
}

const GOOD = JSON.stringify({
  version: 2,
  presetsUpdatedAt: '2026-12-01',
  contactEmail: 'real@example.org',
  kofiUrl: 'https://ko-fi.com/go2day',
  promo: { enabled: true, text: '宣传语', textEn: 'Promo', url: 'https://example.com/p' },
  notice: null,
});

test('多 URL 回退：首选失败 → 次选胜出，按序尝试', async () => {
  const calls = [];
  const fetchImpl = makeFetch({
    [rc.AUTHOR_CONFIG_URLS[0]]: { throw: 'timeout' },
    [rc.AUTHOR_CONFIG_URLS[1]]: { text: GOOD },
  }, calls);
  const res = await rc.fetchWithFallback(rc.AUTHOR_CONFIG_URLS, fetchImpl);
  assert.ok(res.ok);
  assert.strictEqual(res.source, rc.AUTHOR_CONFIG_URLS[1]);
  assert.strictEqual(res.data.contactEmail, 'real@example.org');
  assert.deepStrictEqual(calls, rc.AUTHOR_CONFIG_URLS); // 两个都试过，顺序一致
});

test('首选成功则不打次选（省流量）', async () => {
  const calls = [];
  const fetchImpl = makeFetch({ [rc.AUTHOR_CONFIG_URLS[0]]: { text: GOOD } }, calls);
  const res = await rc.fetchWithFallback(rc.AUTHOR_CONFIG_URLS, fetchImpl);
  assert.ok(res.ok);
  assert.deepStrictEqual(calls, [rc.AUTHOR_CONFIG_URLS[0]]);
});

test('坏 JSON / 非对象 / HTTP 500 都静默跳过，全挂 → {ok:false} 不抛', async () => {
  const calls = [];
  const fetchImpl = makeFetch({
    [rc.AUTHOR_CONFIG_URLS[0]]: { text: '{broken json' },
    [rc.AUTHOR_CONFIG_URLS[1]]: { ok: false, text: 'not found' },
  }, calls);
  const res = await rc.fetchWithFallback(rc.AUTHOR_CONFIG_URLS, fetchImpl);
  assert.strictEqual(res.ok, false);
  // 非对象 JSON（数组/字符串）也不算合法
  const res2 = await rc.fetchWithFallback(['https://x.test/a'], makeFetch({ 'https://x.test/a': { text: '[1,2]' } }, []));
  assert.strictEqual(res2.ok, false);
});

test('缓存降级：成功写缓存 → 无网读缓存 → 无缓存用内置默认', async () => {
  const cachePath = path.join(os.tmpdir(), `asl-rc-${Date.now()}.json`);
  // 写→读 roundtrip
  const cleaned = rc.validateAuthorConfig(JSON.parse(GOOD));
  assert.ok(rc.saveCache(cachePath, cleaned));
  const fromDisk = rc.loadCache(cachePath);
  assert.strictEqual(fromDisk.contactEmail, 'real@example.org');
  // 取舍优先级
  assert.strictEqual(rc.resolveEffective(cleaned, null), cleaned);
  assert.strictEqual(rc.resolveEffective(null, fromDisk), fromDisk);
  const builtin = rc.resolveEffective(null, null);
  assert.strictEqual(builtin.contactEmail, rc.DEFAULT_AUTHOR_CONFIG.contactEmail);
  assert.strictEqual(builtin.kofiUrl, 'https://ko-fi.com/go2day');
  // 坏缓存文件 = 无缓存
  fs.writeFileSync(cachePath, '{broken', 'utf-8');
  assert.strictEqual(rc.loadCache(cachePath), null);
  try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
});

test('字段白名单清洗：坏 url/超长/非法类型丢回默认', () => {
  const out = rc.validateAuthorConfig({
    version: 'x', // 非数字 → 默认
    contactEmail: 123, // 非字符串 → 默认
    kofiUrl: 'http://insecure.example.com', // 非 https → 默认
    promo: { enabled: 'yes', text: 'x'.repeat(500), url: 'javascript:alert(1)' },
    notice: { text: '公告', url: 'https://ok.example.com' },
  });
  assert.strictEqual(out.version, rc.DEFAULT_AUTHOR_CONFIG.version);
  assert.strictEqual(out.contactEmail, rc.DEFAULT_AUTHOR_CONFIG.contactEmail);
  assert.strictEqual(out.kofiUrl, rc.DEFAULT_AUTHOR_CONFIG.kofiUrl);
  assert.strictEqual(out.promo.enabled, false); // 非 true 一律关
  assert.strictEqual(out.promo.url, ''); // javascript: 被拒
  assert.ok(out.promo.text.length <= 200);
  assert.strictEqual(out.notice.url, 'https://ok.example.com');
  assert.strictEqual(rc.validateAuthorConfig(null), null);
  assert.strictEqual(rc.validateAuthorConfig([1]), null);
});

test('引流位判定：URL 空/缺省才显示，已填不显示', () => {
  assert.ok(rc.shouldShowAlertPromo(''));
  assert.ok(rc.shouldShowAlertPromo('  '));
  assert.ok(rc.shouldShowAlertPromo(undefined));
  assert.ok(!rc.shouldShowAlertPromo('http://127.0.0.1:3001/alert'));
});

test('常量契约：首拉 10s、轮询 6h、超时 8s；URLs 含 TODO-GITHUB-OWNER 占位', () => {
  assert.strictEqual(rc.FIRST_FETCH_DELAY_MS, 10_000);
  assert.strictEqual(rc.POLL_INTERVAL_MS, 6 * 60 * 60 * 1_000);
  assert.strictEqual(rc.FETCH_TIMEOUT_MS, 8_000);
  assert.strictEqual(rc.AUTHOR_CONFIG_URLS.length, 2);
  assert.ok(rc.AUTHOR_CONFIG_URLS[0].includes('cdn.jsdelivr.net'));
  assert.ok(rc.AUTHOR_CONFIG_URLS[1].includes('raw.githubusercontent.com'));
  for (const u of rc.AUTHOR_CONFIG_URLS) {
    assert.ok(u.includes('TODO-GITHUB-OWNER'), `URL 缺 owner 占位：${u}`);
  }
});

test('仓库根 author-config.json 与内置默认一致（发布物漂移锁）', () => {
  const repoFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'author-config.json'), 'utf-8'));
  const cleaned = rc.validateAuthorConfig(repoFile);
  assert.deepStrictEqual(cleaned, rc.resolveEffective(null, null));
  // 邮箱漂移锁（v1.6.3 起仓库即真实邮箱）：仓库文件邮箱必须与内置默认一致，
  // 改一边必红 —— 不再断言具体占位值，仍保持「两边同步」的锁定语义。
  assert.strictEqual(repoFile.contactEmail, rc.DEFAULT_AUTHOR_CONFIG.contactEmail);
  assert.strictEqual(repoFile.promo.enabled, false);
});

// ---------------------------------------------------------------------------
// v1.6.1 确认项：发布后作者改远程 JSON（邮箱/Ko-fi/引流文案），用户下次启动
// 经缓存穿透到设置面板「关于」角——此处证明数据通路无硬编码。
// ---------------------------------------------------------------------------

test('缓存穿透：离线启动读到缓存里的新邮箱（get() 快照 = 设置面板关于角数据源）', async () => {
  const cachePath = path.join(os.tmpdir(), `asl-rc-pen-${Date.now()}.json`);
  const cached = rc.validateAuthorConfig({
    version: 3,
    contactEmail: 'new-author@example.net',
    kofiUrl: 'https://ko-fi.com/go2day',
    promo: { enabled: false },
    notice: null,
  });
  assert.ok(rc.saveCache(cachePath, cached));
  // 离线：所有 URL 全挂 → 必须落到缓存而非内置占位邮箱
  const mgr = rc.createRemoteConfig({
    cachePath,
    fetchImpl: async () => { throw new Error('offline'); },
    logImpl: () => {},
  });
  assert.strictEqual(mgr.get().contactEmail, 'new-author@example.net');
  // 显式 refresh 一次（模拟首拉失败）：effective 保持缓存，不回退默认
  const eff = await mgr.refresh();
  assert.strictEqual(eff.contactEmail, 'new-author@example.net');
  mgr.stop();
  try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
});

test('设置面板关于角无硬编码邮箱：settings.html 从 authorConfig.contactEmail 取值', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'main', 'settings.html'), 'utf-8');
  assert.ok(html.includes('authorCfg.contactEmail') && html.includes('cfg.authorConfig'),
    'settings.html 关于角必须读远程配置快照 contactEmail（穿透链路），不许硬编码');
  assert.ok(!html.includes('author@example.com'),
    'settings.html 不得硬编码占位邮箱字面量');
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
