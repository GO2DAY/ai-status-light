'use strict';

/**
 * tests/i18n.test.js — v1.5.0 双语语言包守卫（无 electron，纯 node）。
 *
 * 运行：node tests/i18n.test.js
 *
 * 核心契约：
 *  1. zh-CN / en-US 两个语言包 key 集合完全一致（防漏翻 —— 漏一个 key，
 *     英文用户就会看到原生 key 串在 UI 上）
 *  2. normalizeLanguage 只收 auto/zh/en/zh-CN/en-US（zh/en 补全），其余 null
 *  3. resolveLanguage：显式值优先；auto 跟随系统 locale（zh* -> 中文，其余英文）
 *  4. t()：插值、未知 key 回退 key 本身、语言包缺 key 回退中文包
 *  5. settings-ops 的 language 校验与语言包取值域一致（两处实现不漂移）
 */

const assert = require('assert');
const i18n = require('../main/i18n');
const settingsOps = require('../main/settings-ops');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('两语言包 key 集合完全一致（防漏翻）', () => {
  const zh = Object.keys(i18n.PACKS['zh-CN']).sort();
  const en = Object.keys(i18n.PACKS['en-US']).sort();
  const onlyZh = zh.filter((k) => !en.includes(k));
  const onlyEn = en.filter((k) => !zh.includes(k));
  assert.deepStrictEqual(onlyZh, [], `en-US 缺 key: ${onlyZh.join(', ')}`);
  assert.deepStrictEqual(onlyEn, [], `zh-CN 缺 key: ${onlyEn.join(', ')}`);
  assert.ok(zh.length >= 80, `语言包条目异常缩水：${zh.length}`);
});

test('两语言包均无空串文案', () => {
  for (const [lang, pack] of Object.entries(i18n.PACKS)) {
    for (const [k, v] of Object.entries(pack)) {
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${lang}.${k} 文案为空`);
    }
  }
});

test('normalizeLanguage：auto/zh/en/zh-CN/en-US 收，zh/en 补全，其余 null', () => {
  assert.strictEqual(i18n.normalizeLanguage('auto'), 'auto');
  assert.strictEqual(i18n.normalizeLanguage('zh'), 'zh-CN');
  assert.strictEqual(i18n.normalizeLanguage('en'), 'en-US');
  assert.strictEqual(i18n.normalizeLanguage('zh-CN'), 'zh-CN');
  assert.strictEqual(i18n.normalizeLanguage('en-US'), 'en-US');
  assert.strictEqual(i18n.normalizeLanguage('ZH'), 'zh-CN'); // 大小写容忍
  assert.strictEqual(i18n.normalizeLanguage('zh-TW'), 'zh-CN'); // 语系前缀归并
  assert.strictEqual(i18n.normalizeLanguage('fr'), null);
  assert.strictEqual(i18n.normalizeLanguage(''), null);
  assert.strictEqual(i18n.normalizeLanguage(123), null);
  assert.strictEqual(i18n.normalizeLanguage(undefined), null);
});

test('resolveLanguage：显式优先；auto 跟随系统；非法值兜底 auto', () => {
  assert.strictEqual(i18n.resolveLanguage('zh-CN', 'en-US'), 'zh-CN');
  assert.strictEqual(i18n.resolveLanguage('en', 'zh-CN'), 'en-US');
  assert.strictEqual(i18n.resolveLanguage('auto', 'zh-CN'), 'zh-CN');
  assert.strictEqual(i18n.resolveLanguage('auto', 'zh-Hans-CN'), 'zh-CN');
  assert.strictEqual(i18n.resolveLanguage('auto', 'en-US'), 'en-US');
  assert.strictEqual(i18n.resolveLanguage('auto', 'ja-JP'), 'en-US'); // 其他语言统一英文
  assert.strictEqual(i18n.resolveLanguage('auto', ''), 'en-US');
  assert.strictEqual(i18n.resolveLanguage('fr', 'zh-CN'), 'zh-CN'); // 非法值 -> auto -> 系统中文
});

test('t()：取词 / 插值 / 回退链', () => {
  assert.strictEqual(i18n.t('zh-CN', 'menu.quit'), '退出 AI 状态灯');
  assert.strictEqual(i18n.t('en-US', 'menu.quit'), 'Quit AI Status Light');
  assert.strictEqual(i18n.t('en-US', 'time.minAgo', { n: 5 }), '5m ago');
  assert.strictEqual(i18n.t('zh-CN', 'time.minAgo', { n: 5 }), '5 分钟前');
  // 插值参数多处出现全部替换
  assert.ok(i18n.t('zh-CN', 'sw.valIdInvalid', { n: 2, id: 'X' }).includes('第 2 行'));
  // 未知 key 回退 key 本身（开发期防呆）
  assert.strictEqual(i18n.t('zh-CN', 'no.such.key'), 'no.such.key');
  // 非法语言值回退默认中文包
  assert.strictEqual(i18n.t('klingon', 'menu.quit'), '退出 AI 状态灯');
});

test('settings-ops 的 language 校验与语言包取值域一致', () => {
  // 两边各自实现一份 normalize（settings-ops 是校验层，i18n 是渲染层）——
  // 这个测试锁死它们对同一输入的判定不漂移
  for (const v of ['auto', 'zh', 'en', 'zh-CN', 'en-US']) {
    const a = settingsOps.normalizeLanguage(v);
    const b = i18n.normalizeLanguage(v);
    assert.strictEqual(a, b, `normalizeLanguage("${v}") 两处实现不一致: ${a} vs ${b}`);
  }
  for (const v of ['fr', '', null, 42, 'zh-hans']) {
    const a = settingsOps.normalizeLanguage(v);
    const b = i18n.normalizeLanguage(v);
    // i18n 侧容忍 zh 语系前缀（zh-hans -> zh-CN）；settings-ops 校验层严格。
    // 漂移只允许这一种方向：i18n 收、校验层拒（校验层是写盘守门员）。
    if (b === null) assert.strictEqual(a, null, `校验层误收 "${v}"`);
  }
  // 语言包只支持这两种解析结果
  for (const lang of ['zh-CN', 'en-US']) {
    assert.ok(i18n.PACKS[lang], `PACKS 缺 ${lang}`);
  }
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
