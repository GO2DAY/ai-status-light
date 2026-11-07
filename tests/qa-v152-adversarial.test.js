'use strict';

/**
 * tests/qa-v152-adversarial.test.js — v1.5.2 UMD 崩溃热修复对抗复审（QA 严过关 R6）。
 *
 * 核心怀疑对象：闸口一（umd-dual-env.test.js）的 vm 沙箱是否忠实——
 * 若沙箱不等价 rollup-cjs-wrapper 环境，闸口就是摆设。本文件独立证明：
 *   A. 沙箱忠实性：手工把当前源码还原成旧 else 分支形态放进同款 vm 沙箱，
 *      必须变红（不许只看 red-evidence 留档文本）
 *   B. 导出形状：修复后 module.exports 的 keys 与 v1.5.1 包内版本完全一致
 *   C. window-only 沙箱（<script src> 裸加载环境：window===self===globalThis，
 *      无 module/exports）回归不崩
 *   D. 闸口二有效性：bundle-gate 指向不存在目录必须 FAIL（子进程实测 exit code），
 *      且它读的是 release 产物而非源码
 *   E. 源码锚定：四个 UMD 文件均为双通道无 else 形态；src/ 消费点 import 在前
 *
 * 运行：node tests/qa-v152-adversarial.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN_DIR = path.join(ROOT, 'main');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const UMD_FILES = [
  ['i18n.js', 'ASL_I18N'],
  ['strip-name.js', 'ASL_STRIP_NAME'],
  ['layout.js', 'ASL_LAYOUT'],
  ['integration-prompt.js', 'ASL_PROMPT'],
];

/** 与 tests/umd-dual-env.test.js 相同的双环境沙箱（module+exports+window 并存）。 */
function runInDualEnv(code, fileName) {
  const sandbox = { module: { exports: {} }, exports: {}, window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: fileName });
  return sandbox;
}

/**
 * 把 v1.5.2 双通道包装还原成 v1.5.1 的旧 else 形态（事故代码）：
 *   if (module) { module.exports = factory(); } else { root.<GLOBAL> = factory(); }
 * 用正则手术替换包装体，失败即测试数据构造失败（不是源码问题）。
 */
function toLegacyElseForm(code, globalName) {
  // 当前形态（v1.5.2）：const api = factory(); if (module...) module.exports = api;
  //   if (window...) window.X = api; else if (root...) root.X = api;
  const legacyBody =
    `  if (typeof module === 'object' && module.exports) {\n` +
    `    module.exports = factory();\n` +
    `  } else {\n` +
    `    root.${globalName} = factory();\n` +
    `  }`;
  const fixedBodyRe =
    /const api = factory\(\);\s*if \(typeof module === 'object' && module\.exports\) module\.exports = api;\s*if \(typeof window !== 'undefined'\) window\.[A-Z0-9_]+ = api;\s*else if \(root && typeof root === 'object'\) root\.[A-Z0-9_]+ = api;/;
  if (!fixedBodyRe.test(code)) return null; // 形态不匹配 = 包装被改了，测试要跟着改
  return code.replace(fixedBodyRe, legacyBody);
}

// ===========================================================================
// A. 沙箱忠实性：旧 else 形态进沙箱必须红
// ===========================================================================

test('闸口一不是摆设：手工还原的 else 分支副本进 vm 双环境沙箱，四个文件全部变红', () => {
  for (const [file, globalName] of UMD_FILES) {
    const fixed = fs.readFileSync(path.join(MAIN_DIR, file), 'utf8');
    const legacy = toLegacyElseForm(fixed, globalName);
    assert.ok(legacy, `${file} 包装形态已变，还原手术失配——QA 测试需要跟随更新`);
    const s = runInDualEnv(legacy, file);
    assert.ok(
      !s.window[globalName],
      `${file} 旧 else 形态在双环境沙箱里竟然挂上了 window.${globalName} —— 沙箱不忠实，闸口一是摆设`
    );
    // 同时确认 module 通道确实吃掉了赋值（事故机理复现完整）
    assert.ok(
      s.module.exports && Object.keys(s.module.exports).length > 0,
      `${file} 旧形态连 module.exports 都没吃到——沙箱构造本身有问题`
    );
  }
});

test('沙箱忠实性反证：修复后的源码进同款沙箱，四个文件全部变绿（对照组）', () => {
  for (const [file, globalName] of UMD_FILES) {
    const code = fs.readFileSync(path.join(MAIN_DIR, file), 'utf8');
    const s = runInDualEnv(code, file);
    assert.ok(s.window[globalName], `${file} 修复后 window.${globalName} 未赋值`);
    assert.ok(Object.keys(s.module.exports).length > 0, `${file} module.exports 通道丢`);
    // 双通道挂的是同一个 api 对象（防止两处各自 factory() 出两份语言包）
    assert.strictEqual(s.window[globalName], s.module.exports,
      `${file} 双通道不是同一对象（内存翻倍/状态分裂风险）`);
  }
});

// ===========================================================================
// B. 导出形状：与 v1.5.1 包内版本 keys 一致（main.js 消费点不破）
// ===========================================================================

test('导出形状：修复后 module.exports keys 与 v1.5.1 完全一致', () => {
  const v151Main = path.join(ROOT, 'release-v151', 'win-unpacked', 'resources', 'app', 'main');
  for (const [file] of UMD_FILES) {
    const oldPath = path.join(v151Main, file);
    if (!fs.existsSync(oldPath)) continue; // v1.5.1 没有的文件跳过（防御）
    // 用 vm 在纯 node 形态沙箱里分别加载两版，比 keys（避免 require 缓存串扰）
    const load = (p) => {
      const sandbox = { module: { exports: {} }, exports: {}, console };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
      return Object.keys(sandbox.module.exports).sort();
    };
    assert.deepStrictEqual(load(path.join(MAIN_DIR, file)), load(oldPath),
      `${file} 导出 keys 与 v1.5.1 不一致——main.js 的 require 消费点会破`);
  }
});

// ===========================================================================
// C. window-only 沙箱（<script src> 裸加载 = settings.html/tooltip.html 环境）
// ===========================================================================

test('window-only 沙箱：无 module/exports 环境下四个文件不崩且全局赋值成功', () => {
  for (const [file, globalName] of UMD_FILES) {
    const code = fs.readFileSync(path.join(MAIN_DIR, file), 'utf8');
    // 真实浏览器：window === self === globalThis，没有 module/exports/require
    const win = {};
    const sandbox = { window: win, self: win, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    assert.doesNotThrow(() => vm.runInContext(code, sandbox, { filename: file }),
      `${file} 在 window-only 环境抛异常（settings.html 会白屏）`);
    // root 解析到 self(=win)：双通道的 window 分支或 root 兜底都必须挂上
    assert.ok(win[globalName], `${file} 在裸 <script src> 环境未挂上 window.${globalName}`);
  }
});

// ===========================================================================
// D. 闸口二有效性：bundle-gate 必须是硬闸
// ===========================================================================

test('bundle-gate 硬闸：指向不存在目录必须非零退出（没体检不许发版）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'bundle-gate.test.js')], {
    env: { ...process.env, ASL_RELEASE_DIR: path.join(ROOT, 'no-such-release-dir-qa') },
    encoding: 'utf8',
  });
  assert.notStrictEqual(r.status, 0, 'bundle-gate 对不存在的产物目录放行了（闸口是假的）');
  assert.ok((r.stdout + r.stderr).includes('渲染产物不存在'),
    '失败原因不是「产物不存在」——闸口可能因别的原因假红');
});

test('bundle-gate 默认读 release 产物而非源码：缺省路径公式与版本号联动', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'bundle-gate.test.js'), 'utf8');
  // 缺省目录 = release-v<version 去点>，且指向 win-unpacked/resources/app/dist
  assert.ok(/release-v\$\{pkg\.version\.replace/.test(src), '缺省 release 目录公式变了');
  assert.ok(/win-unpacked/.test(src) && /resources.*app.*dist/.test(src.replace(/'/g, '')),
    '闸口读的不是打包产物 dist');
  // 且 grep 的是 bundle 里的赋值模式而非源码文件
  assert.ok(!/readFileSync\(path\.join\([^)]*'main'/.test(src), '闸口在读源码而不是产物');
  // 单 bundle 断言数 index-*.js 个数（多残留会被抓）
  assert.ok(/bundles\.length,\s*1/.test(src.replace(/\n/g, '\n')),
    '单 bundle 断言被弱化');
});

test('bundle-gate 对真实 release-v152 产物 PASS（对照组）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'bundle-gate.test.js')], {
    env: { ...process.env, ASL_RELEASE_DIR: path.join(ROOT, 'release-v152') },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `bundle-gate 对真实产物红了:\n${r.stdout}\n${r.stderr}`);
});

// ===========================================================================
// E. 源码锚定
// ===========================================================================

test('源码锚定：四个 UMD 文件均为「双通道、无 else 截断」形态', () => {
  for (const [file, globalName] of UMD_FILES) {
    const src = fs.readFileSync(path.join(MAIN_DIR, file), 'utf8');
    assert.ok(new RegExp(`window\\.${globalName} = api`).test(src),
      `${file} 缺 window 通道`);
    assert.ok(/module\.exports = api/.test(src), `${file} 缺 module 通道`);
    // 禁止回到 else 形态：module 分支与 window 分支之间不得有 else
    assert.ok(!/module\.exports = (api|factory\(\));?\s*\}\s*else/.test(src),
      `${file} 仍是 else 形态（事故代码回归）`);
  }
});

test('源码锚定：src/ 消费点 import 副作用在 window.ASL_* 读取之前', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'statusMeta.js'), 'utf8');
  const importIdx = src.indexOf("import '../main/i18n'");
  const useIdx = src.indexOf('window.ASL_I18N');
  assert.ok(importIdx > -1 && useIdx > importIdx,
    'statusMeta.js 的 import 顺序变了——模块顶层读取可能先于赋值');
  // 全 src/ 不得有其他裸消费点（本次 grep 结论固化）
  const { execSync } = require('child_process');
  void execSync;
  const srcDir = path.join(ROOT, 'src');
  const consumers = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(js|jsx|ts|tsx)$/.test(f)) {
        const content = fs.readFileSync(p, 'utf8');
        if (content.includes('window.ASL_')) consumers.push(p);
      }
    }
  };
  walk(srcDir);
  assert.deepStrictEqual(consumers.map((p) => path.basename(p)), ['statusMeta.js'],
    `src/ 出现新的 window.ASL_* 消费点: ${consumers.join(',')}`);
});

// ===========================================================================

(async () => {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.error(`FAIL - ${name}: ${err.message}`);
    }
  }
  console.log(`\n${passed}/${passed + failures.length} tests passed`);
  if (failures.length > 0) process.exit(1);
})();
