'use strict';

/**
 * tests/privacy-scan.test.js — v1.5.0 脱敏扫描（全球发布版守门员）。
 *
 * 运行：node tests/privacy-scan.test.js
 *
 * 扫描「会进安装包的内容」中是否残留任何可关联到原作者个人环境的信息：
 *   - 旧的硬编码 MQTT 主题命名空间（主题名即凭据，泄露 = 任何人可伪造灯态）
 *   - 作者本名（中文）
 *   - 作者本机用户目录路径
 *
 * 扫描范围（与 electron-builder.yml 的 files 清单对齐）：
 *   - main/    主进程全部源码（含 settings.html / tooltip.html / i18n.js）
 *   - src/     渲染层源码（编译进 dist/）
 *   - dist/    Vite 构建产物（存在才查 —— 打包前请先 npm run build）
 *   - package.json / index.html / electron-builder.yml
 *   - release-<版本>/win-unpacked/resources/app/{main,dist,package.json}（最新构建产物，存在才查）
 *
 * 不扫 tests/ docs/ README（不进安装包）；node_modules 里的第三方包不扫
 * （不含我们的字符串，且体积大）。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 违禁串（全部子串匹配，大小写不敏感处单独列出小写形式） */
const FORBIDDEN = [
  { needle: 'qrzcfsywp3gmlvi0', why: '旧硬编码 MQTT 主题命名空间（主题名即凭据）' },
  { needle: '吴建明', why: '作者本名' },
  { needle: 'C:\\Users\\吴建明', why: '作者本机用户目录' },
  { needle: 'c:\\users\\吴建明', why: '作者本机用户目录（小写变体）' },
];

const TEXT_EXTS = new Set(['.js', '.jsx', '.html', '.json', '.yml', '.css', '.txt', '.md', '.cjs', '.mjs']);

/** 递归收集目录下所有文本文件。 */
function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在（如 dist 未构建）：跳过
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      collectFiles(p, out);
    } else if (TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

/** 当前要扫的文件清单。 */
function scanTargets() {
  const files = [];
  collectFiles(path.join(ROOT, 'main'), files);
  collectFiles(path.join(ROOT, 'src'), files);
  collectFiles(path.join(ROOT, 'dist'), files); // 不存在时 collectFiles 返回空
  for (const f of ['package.json', 'index.html', 'electron-builder.yml']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) files.push(p);
  }
  // 当前版本的打包产物（存在才查）：release-v<版本号去掉点>，如 1.5.0 ->
  // release-v150。历史 release 目录是旧版本的归档（里面当然有旧字符串），
  // 不属于本次发布产物，不扫。也可用 ASL_RELEASE_DIR 覆盖。
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
  const releaseDir =
    process.env.ASL_RELEASE_DIR || `release-v${String(pkgVersion).replace(/\./g, '')}`;
  const appDir = path.join(ROOT, releaseDir, 'win-unpacked', 'resources', 'app');
  if (fs.existsSync(appDir)) {
    collectFiles(path.join(appDir, 'main'), files);
    collectFiles(path.join(appDir, 'dist'), files);
    const pkg = path.join(appDir, 'package.json');
    if (fs.existsSync(pkg)) files.push(pkg);
  }
  return files;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('发布内容零隐私残留（主题命名空间 / 本名 / 本机路径）', () => {
  const files = scanTargets();
  assert.ok(files.length > 10, `扫描目标太少（${files.length} 个），扫描范围可能配错`);
  const hits = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // 二进制/编码异常跳过（TEXT_EXTS 已过滤绝大部分）
    }
    for (const { needle, why } of FORBIDDEN) {
      let idx = content.indexOf(needle);
      while (idx !== -1) {
        const line = content.slice(0, idx).split('\n').length;
        hits.push(`${path.relative(ROOT, file)}:${line} 命中「${needle}」（${why}）`);
        idx = content.indexOf(needle, idx + needle.length);
      }
    }
  }
  assert.deepStrictEqual(hits, [], `隐私残留：\n${hits.join('\n')}`);
});

test('MQTT 主题改为配置驱动：mqtt-bridge 不再导出硬编码主题常量', () => {
  const bridge = require('../main/mqtt-bridge');
  assert.strictEqual(typeof bridge.buildTopics, 'function');
  assert.strictEqual(bridge.STATUS_TOPIC, undefined, '仍在导出硬编码 STATUS_TOPIC');
  assert.strictEqual(bridge.STATE_TOPIC, undefined, '仍在导出硬编码 STATE_TOPIC');
  // 派生主题形态校验
  const { statusTopic, stateTopic } = bridge.buildTopics('asl/abcdef012345');
  assert.ok(/^asl\/[a-z0-9]{12}\/status$/.test(statusTopic));
  assert.ok(/^asl\/[a-z0-9]{12}\/state$/.test(stateTopic));
});

test('package.json 作者信息已脱敏', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.strictEqual(pkg.author, 'ai-status-light contributors');
  assert.ok(!JSON.stringify(pkg).includes('吴建明'));
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
