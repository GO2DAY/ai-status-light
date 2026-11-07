'use strict';

/**
 * tests/lnk-parser.test.js — .lnk 解析器单测（纯 node，无 electron 依赖）。
 *
 * 运行：node tests/lnk-parser.test.js
 *
 * 样本：tests/fixtures/ 下 4 个真实桌面快捷方式（豆包/Marvis/Abu/Cherry Studio），
 * 覆盖中文名、拉丁名、短名、带空格名、GBK ANSI 路径、LocalBasePath+Suffix 拼接、
 * Unicode 字段有无两种形态。另造：exe 直拖、截断坏 lnk、非 exe 目标（合成）、
 * 非 lnk/exe 扩展名、文件不存在。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseLnkBuffer, resolveDroppedFile, baseName, stripExt } = require('../main/lnk-parser');

const FIXTURES = path.join(__dirname, 'fixtures');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 真实样本（tests/fixtures/）
// ---------------------------------------------------------------------------

test('真实样本：豆包.lnk -> Doubao.exe / 豆包', () => {
  const r = resolveDroppedFile(path.join(FIXTURES, '豆包.lnk'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.displayName, '豆包');
  assert.strictEqual(r.processName, 'Doubao.exe');
});

test('真实样本：Marvis.lnk -> MarvisLauncher.exe（全拉丁路径，Unicode 字段）', () => {
  const r = resolveDroppedFile(path.join(FIXTURES, 'Marvis.lnk'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.displayName, 'Marvis');
  assert.strictEqual(r.processName, 'MarvisLauncher.exe');
});

test('真实样本：Abu.lnk -> Abu.exe（LocalBasePath+CommonPathSuffix 拼接形态）', () => {
  // 这个 lnk 的 LocalBasePath 只有 "C:\Users\"，后缀段才含 exe 名——
  // 不拼接就拿到半截路径（本功能的头号坑，QA 对抗必打点）。
  const r = resolveDroppedFile(path.join(FIXTURES, 'Abu.lnk'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.displayName, 'Abu');
  assert.strictEqual(r.processName, 'Abu.exe');
});

test('真实样本：Cherry Studio.lnk -> Cherry Studio.exe（带空格名称）', () => {
  const r = resolveDroppedFile(path.join(FIXTURES, 'Cherry Studio.lnk'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.displayName, 'Cherry Studio');
  assert.strictEqual(r.processName, 'Cherry Studio.exe');
});

// ---------------------------------------------------------------------------
// exe 直拖
// ---------------------------------------------------------------------------

test('exe 直拖：跳过解析，名称去扩展名 + 进程名带扩展名', () => {
  const r = resolveDroppedFile('C:\\Apps\\Kimi\\Kimi.exe');
  assert.deepStrictEqual(r, {
    ok: true,
    displayName: 'Kimi',
    processName: 'Kimi.exe',
    targetPath: 'C:\\Apps\\Kimi\\Kimi.exe',
  });
});

test('exe 直拖：正斜杠路径 + 大写扩展名也认', () => {
  const r = resolveDroppedFile('D:/Tools/MyAI.EXE');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.processName, 'MyAI.EXE');
  assert.strictEqual(r.displayName, 'MyAI');
});

// ---------------------------------------------------------------------------
// 异常输入
// ---------------------------------------------------------------------------

test('坏 lnk（截断到 100 字节）：解析返回 null 字段，不抛异常', () => {
  const full = fs.readFileSync(path.join(FIXTURES, '豆包.lnk'));
  const truncated = full.slice(0, 100);
  const r = parseLnkBuffer(truncated);
  assert.deepStrictEqual(r, { targetPath: null, nameString: null });
});

test('坏 lnk（随机器字节）：不抛异常', () => {
  const junk = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotThrow(() => parseLnkBuffer(junk));
  assert.deepStrictEqual(parseLnkBuffer(junk), { targetPath: null, nameString: null });
});

test('截断 lnk 文件走 resolveDroppedFile：partial + 黄字提示语义', () => {
  // 临时文件放系统临时目录，不清除（OS 自洁）——项目目录的 unlink 会触发
  // 宿主 safe-delete shim 拦截，踩过一次。
  const tmp = path.join(os.tmpdir(), `asl-test-truncated-${process.pid}.lnk`);
  fs.writeFileSync(tmp, fs.readFileSync(path.join(FIXTURES, '豆包.lnk')).slice(0, 100));
  const r = resolveDroppedFile(tmp);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.displayName, path.basename(tmp, '.lnk'));
  assert.strictEqual(r.processName, '');
  assert.ok(r.error.includes('未能识别'));
});

/** 合成一个最小合法 lnk：header + LinkInfo（LocalBasePath 指向文件夹）。 */
function buildSyntheticLnk(localBasePathAnsi) {
  const target = Buffer.from(localBasePathAnsi + '\0', 'latin1');
  const liHeaderSize = 0x1c;
  const offLBP = liHeaderSize; // 紧接着头
  const liSize = liHeaderSize + target.length;
  const buf = Buffer.alloc(0x4c + liSize);
  buf.writeUInt32LE(0x4c, 0); // HeaderSize
  // CLSID 16B 跳过（全 0 不影响本解析器）
  buf.writeUInt32LE(0x02, 0x14); // LinkFlags = HasLinkInfo（无 IDList、无 StringData）
  let off = 0x4c;
  buf.writeUInt32LE(liSize, off);
  buf.writeUInt32LE(liHeaderSize, off + 4);
  buf.writeUInt32LE(0x1, off + 8); // LinkInfoFlags = VolumeIDAndLocalBasePath
  buf.writeUInt32LE(0, off + 12); // offVol（不读）
  buf.writeUInt32LE(offLBP, off + 16);
  buf.writeUInt32LE(0, off + 20); // offCNRL
  buf.writeUInt32LE(0, off + 24); // offCPS = 0（无后缀段）
  target.copy(buf, off + offLBP);
  return buf;
}

test('非 exe 目标（lnk 指向文件夹）：partial，不当作成功', () => {
  const buf = buildSyntheticLnk('C:\\Users\\Documents\\');
  assert.strictEqual(baseName('C:\\Users\\Documents\\'), '');
  const r = parseLnkBuffer(buf);
  assert.strictEqual(r.targetPath, 'C:\\Users\\Documents\\');
  // 走 resolveDroppedFile 全链路：写临时文件验证
  const tmp = path.join(os.tmpdir(), `asl-test-folder-${process.pid}.lnk`);
  fs.writeFileSync(tmp, buf);
  const rr = resolveDroppedFile(tmp);
  assert.strictEqual(rr.ok, false);
  assert.strictEqual(rr.partial, true);
  assert.strictEqual(rr.processName, '');
});

test('合成 lnk 目标为 exe：正常提取（验证合成器与解析器闭环）', () => {
  const tmp = path.join(os.tmpdir(), `asl-test-good-${process.pid}.lnk`);
  fs.writeFileSync(tmp, buildSyntheticLnk('C:\\Apps\\TestAI\\TestAI.exe'));
  const r = resolveDroppedFile(tmp);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.processName, 'TestAI.exe');
});

test('非 lnk/exe 扩展名：拒绝并提示只支持两种', () => {
  for (const p of ['C:\\a\\b.txt', 'C:\\a\\b.bat', 'C:\\a\\b.url', 'C:\\a\\b']) {
    const r = resolveDroppedFile(p);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.partial, false);
    assert.ok(r.error.includes('只支持'), p);
  }
});

test('文件不存在 / 空路径：明确报错不抛异常', () => {
  const r = resolveDroppedFile(path.join(FIXTURES, '不存在的文件.lnk'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('读取失败'));
  assert.deepStrictEqual(resolveDroppedFile(''), { ok: false, partial: false, error: '未获取到文件路径' });
});

test('工具函数：baseName 兼容两种分隔符；stripExt 保留点号前缀文件', () => {
  assert.strictEqual(baseName('C:\\a\\b\\c.exe'), 'c.exe');
  assert.strictEqual(baseName('C:/a/b/c.exe'), 'c.exe');
  assert.strictEqual(baseName('c.exe'), 'c.exe');
  assert.strictEqual(stripExt('豆包.lnk'), '豆包');
  assert.strictEqual(stripExt('Cherry Studio.lnk'), 'Cherry Studio');
  assert.strictEqual(stripExt('noext'), 'noext');
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
