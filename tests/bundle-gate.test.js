'use strict';

/**
 * tests/bundle-gate.test.js — v1.5.2 P0 闸口二：打包产物渲染 bundle 体检。
 *
 * 运行：node tests/bundle-gate.test.js
 * 前置：必须先完成 vite build + electron-builder 打包（闸口守在打包后）。
 *
 * 事故背景：v1.5.0/v1.5.1 的 UMD else 分支 bug 让 window.ASL_I18N 从未被
 * 赋值，Node 单测全绿抓不到，只有打包产物里的渲染 bundle 才是真相。
 * 本闸口直接 grep win-unpacked 内的渲染 bundle：
 *   1. 必须含 window.ASL_I18N / window.ASL_STRIP_NAME 赋值代码模式
 *   2. dist/assets 下必须有且仅有一个 index-*.js（旧哈希残留 = dist 没清干净）
 *   3. dist/index.html 引用的 bundle 真实存在于 assets/
 *
 * 发布目录定位：ASL_RELEASE_DIR 环境变量优先；缺省 release-v<版本号去点>
 * （与 tests/privacy-scan.test.js 同约定）。目录不存在 = 没打包 =  FAIL，
 * 不许带着没体检的产物发版。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function releaseDir() {
  if (process.env.ASL_RELEASE_DIR) return path.resolve(process.env.ASL_RELEASE_DIR);
  return path.join(ROOT, `release-v${pkg.version.replace(/\./g, '')}`);
}

function distDir() {
  return path.join(releaseDir(), 'win-unpacked', 'resources', 'app', 'dist');
}

test('打包产物存在（未打包 = 不许过闸）', () => {
  const dir = distDir();
  assert.ok(
    fs.existsSync(path.join(dir, 'index.html')),
    `渲染产物不存在：${dir} —— 先 vite build + electron-builder 再跑本闸口`
  );
});

test('dist 卫生：assets 下有且仅有一个 index-*.js（无旧哈希残留）', () => {
  const assets = path.join(distDir(), 'assets');
  const bundles = fs.readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f));
  assert.strictEqual(
    bundles.length,
    1,
    `assets 下应有唯一 index-*.js，实际 ${bundles.length} 个：${bundles.join(', ')} —— 构建前清空 dist`
  );
});

test('index.html 引用的 bundle 真实存在', () => {
  const html = fs.readFileSync(path.join(distDir(), 'index.html'), 'utf8');
  const m = html.match(/assets\/(index-[^"]+\.js)/);
  assert.ok(m, 'index.html 未引用 index-*.js bundle');
  assert.ok(
    fs.existsSync(path.join(distDir(), 'assets', m[1])),
    `index.html 引用 ${m[1]} 但文件不存在`
  );
});

test('渲染 bundle 含 window.ASL_I18N / window.ASL_STRIP_NAME 双通道赋值', () => {
  const assets = path.join(distDir(), 'assets');
  const bundle = fs.readdirSync(assets).find((f) => /^index-.*\.js$/.test(f));
  const code = fs.readFileSync(path.join(assets, bundle), 'utf8');
  assert.ok(
    /window\.ASL_I18N\s*=/.test(code),
    'bundle 缺 window.ASL_I18N 赋值 —— UMD else 分支 bug 回归？跑 tests/umd-dual-env.test.js'
  );
  assert.ok(
    /window\.ASL_STRIP_NAME\s*=/.test(code),
    'bundle 缺 window.ASL_STRIP_NAME 赋值 —— UMD else 分支 bug 回归？'
  );
  // 反向守卫：语言包真的进了 bundle（防 import 被意外 tree-shake 掉）
  assert.ok(code.includes('zh-CN'), 'bundle 缺语言包内容');
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
      console.error(err && err.message);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed${process.exitCode ? ' (with failures)' : ''}`);
})();
