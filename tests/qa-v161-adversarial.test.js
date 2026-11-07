'use strict';

/**
 * tests/qa-v161-adversarial.test.js — QA 严过关 v1.6.1 对抗复审（R8）。
 *
 * 专打派单点 1/3/5 的边角：
 *   A. 呼吸灯失败路径（保存失败必须继续闪）——源码锚定 doSave 三分支
 *   B. 程序化添加的 dirty 漏洞（addBtn / drop-partial / addPreset 三条非 input 路径）
 *   C. update:checkNow 三态行为 + 三态 i18n 双语不回退
 *   D. settings-preload 白名单纪律（只多开 checkUpdate 一个无参通道）
 *   E. 关于角邮箱链路（无硬编码、主进程恒给值、首拉未成不空白/undefined）
 *   F. 去国度视角独立断言（含提示词模板双语）
 *   G. sticky 栏层级与不透明锚定
 *
 * 纪律：源码锚定 + 行为复制，不用工程师的测试证明工程师的代码。
 */

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'main', 'settings.html'), 'utf8');
const au = require('../main/auto-updater');
const rc = require('../main/remote-config');
const i18n = require('../main/i18n');
const presets = require('../main/ai-presets');
const prompt = require('../main/integration-prompt');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------------------
// A. 呼吸灯：保存失败必须继续闪（改动未落盘）
// ---------------------------------------------------------------------------

test('doSave 三条失败路径都不熄灯：唯一 setDirty(false) 只活在 res.ok 成功分支', () => {
  // 全文件只允许一处 setDirty(false)
  const off = [...html.matchAll(/setDirty\(false\)/g)];
  assert.strictEqual(off.length, 1, `setDirty(false) 出现 ${off.length} 次，只许 1 次（成功分支）`);
  const offIdx = off[0].index;

  // 它必须在 res.ok 成功分支内部：向前找最近的 if (res && res.ok)，且中间没有 else
  const before = html.slice(0, offIdx);
  const okBranch = before.lastIndexOf('if (res && res.ok)');
  assert.ok(okBranch > -1, '找不到 res.ok 成功分支');
  const between = html.slice(okBranch, offIdx);
  assert.ok(!/else|catch/.test(between), `setDirty(false) 不在成功分支直属路径: ${between.slice(-120)}`);

  // 校验失败早退：validateLocal 报错路径在 doSave 前部 return，不得碰 setDirty
  const m = html.match(/function doSave\(afterOk\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'doSave 函数体找不到');
  const body = m[0];
  const vIdx = body.indexOf('validateLocal');
  assert.ok(vIdx > -1 && /if \(err\) \{ setStatus\(err, 'err'\); return false; \}/.test(body),
    '校验失败早退路径形态变了');
  // 失败 else 分支与 catch 分支文本内不得有 setDirty
  const elseIdx = body.indexOf('} else {', body.indexOf('if (res && res.ok)'));
  assert.ok(elseIdx > -1, 'doSave 缺 res.ok 的 else 失败分支');
  assert.ok(!body.slice(elseIdx).includes('setDirty'), '失败/catch 分支里出现 setDirty——保存失败会熄灯！');
});

// ---------------------------------------------------------------------------
// B. 程序化添加的 dirty 漏洞：rows.push 不触发 input/change 事件
// ---------------------------------------------------------------------------

test('程序化添加的 dirty 漏洞：addBtn 空行与 drop-partial 预填行既不置 dirty 也不自保存', () => {
  // 工程师在 VERSIONS.md 声称「拖放添加/预选添加全覆盖」——但这两条路径
  // 通过 rows.push 程序化改动表单，不触发 input/change 事件：
  //   1) addBtn（手动加行）：push 空行后只 render()+focus，无 setDirty/doSave
  //   2) drop partial（lnk 解析不出 exe）：push 预填名称行后 return 等人工补进程名，
  //      无 setDirty/doSave —— 未落盘的预填行存在，呼吸灯却不亮
  // 对照组（必须成立，证明走查没找错地方）：
  //   addPreset 与 drop 完整识别路径 push 后必须紧跟 doSave 自保存
  const addBtn = html.match(/getElementById\('addBtn'\)[\s\S]{0,300}?rows\.push[\s\S]{0,300}?\}\);/);
  assert.ok(addBtn, 'addBtn 处理器找不到（结构变了需重走查）');
  assert.ok(/setDirty\(true\)|doSave\(/.test(addBtn[0]),
    'addBtn 加行后既不置 dirty 也不自保存——空行可接受，但契约声称全覆盖');

  const partial = html.match(/if \(res\.partial\) \{([\s\S]*?)return;\s*\n\s*\}/);
  assert.ok(partial, 'drop partial 分支找不到（结构变了需重走查）');
  assert.ok(/setDirty\(true\)|doSave\(/.test(partial[1]),
    'drop-partial 预填行未落盘却呼吸灯不亮——用户取消即静默丢弃');

  // 对照组：addPreset 必须自保存（否则预选添加也是漏的）
  const ap = html.match(/function addPreset\(it\) \{[\s\S]*?\n  \}/);
  assert.ok(ap && /doSave\(/.test(ap[0]), 'addPreset 不再自保存——预选添加 dirty 链路断了');
});

test('取消语义锚定（v1.6.1 R8 顺手项，team-lead 拍板）：dirty 时取消/× 二次确认，clean 直关', () => {
  // 新语义（本测试由工程师按派单更新锚点，QA R9 复核）：guardClose 契约——
  // dirty=false 直关；dirty=true 按钮原位变「确认放弃修改？」（armed 态），
  // 3 秒超时复原，armed 态再点才真正关窗。两条路径都必须能走到 close()。
  const g = html.match(/function guardClose\(btn\) \{[\s\S]*?\n  \}/);
  assert.ok(g, 'guardClose 找不到——取消防误丢被移除，需重新走查');
  assert.ok(/if \(!dirty\)/.test(g[0]), 'guardClose 缺 dirty=false 直关分支');
  assert.ok(/armed/.test(g[0]) && /confirmDiscard/.test(g[0]) && /3000/.test(g[0]),
    'guardClose 缺 armed 二次确认 / confirmDiscard 文案 / 3s 超时复原');
  assert.ok((g[0].match(/close\(\)/g) || []).length >= 2, 'guardClose 两条路径都要能关窗');
  // cancelBtn 与 closeX 都必须经 guardClose（不得静默吞点击，也不得绕过守卫）
  assert.ok(/getElementById\('cancelBtn'\)[\s\S]{0,150}?guardClose/.test(html), '取消按钮未接 guardClose');
  assert.ok(/getElementById\('closeX'\)[\s\S]{0,150}?guardClose/.test(html), '×按钮未接 guardClose');
  // 确认文案双语独立
  for (const lang of ['zh-CN', 'en-US']) {
    const s = i18n.PACKS[lang]['sw.confirmDiscard'];
    assert.ok(typeof s === 'string' && s.length > 0, `${lang} 缺 sw.confirmDiscard`);
  }
  assert.notStrictEqual(i18n.PACKS['zh-CN']['sw.confirmDiscard'], i18n.PACKS['en-US']['sw.confirmDiscard'],
    'sw.confirmDiscard 双语同文（疑似复制粘贴）');
});

// ---------------------------------------------------------------------------
// C. update:checkNow 三态
// ---------------------------------------------------------------------------

test('manualCheck 三态全分支：dev/无checkFn/抛错/无Release/同版/新版', async () => {
  assert.deepStrictEqual(await au.manualCheck({ isPackaged: false, checkFn: async () => ({ version: '9.9.9' }) }),
    { state: 'not-ready' }, 'dev 环境必须 not-ready');
  assert.deepStrictEqual(await au.manualCheck({ isPackaged: true }),
    { state: 'not-ready' }, '无 checkFn 必须 not-ready');
  assert.deepStrictEqual(await au.manualCheck({ isPackaged: true, checkFn: async () => { throw new Error('net down'); } }),
    { state: 'not-ready' }, '拉取失败必须 not-ready 且不 reject');
  assert.deepStrictEqual(await au.manualCheck({ isPackaged: true, checkFn: async () => null }),
    { state: 'not-ready' }, '仓库无 Release 必须 not-ready');
  assert.deepStrictEqual(await au.manualCheck({ isPackaged: true, checkFn: async () => ({ version: '1.6.1' }), currentVersion: '1.6.1' }),
    { state: 'latest' }, '同版必须 latest');
  const newer = await au.manualCheck({ isPackaged: true, checkFn: async () => ({ version: '1.7.0' }), currentVersion: '1.6.1' });
  assert.strictEqual(newer.state, 'new');
  assert.strictEqual(newer.version, '1.7.0');
  assert.ok(/^https:\/\//.test(newer.url), 'new 态 url 必须 https');
});

test('三态 i18n 双语独立文案不回退：5 个 key 双语都在且互不相同', () => {
  const keys = ['sw.checkUpdate', 'sw.updateChecking', 'sw.updateNew', 'sw.updateLatest', 'sw.updateNotReady'];
  for (const k of keys) {
    const zh = i18n.PACKS['zh-CN'][k];
    const en = i18n.PACKS['en-US'][k];
    assert.ok(typeof zh === 'string' && zh, `zh-CN 缺 ${k}`);
    assert.ok(typeof en === 'string' && en, `en-US 缺 ${k}`);
    assert.notStrictEqual(zh, en, `${k} 双语同文（疑似回退/复制粘贴）: ${zh}`);
  }
  // {version} 占位双语都在（t() 插值契约）
  assert.ok(i18n.PACKS['zh-CN']['sw.updateNew'].includes('{version}'));
  assert.ok(i18n.PACKS['en-US']['sw.updateNew'].includes('{version}'));
  // settings.html 三态分支都走 L()，无硬编码中文（先剥注释再扫字符串字面量）
  const block = html.match(/getElementById\('checkUpdateBtn'\)[\s\S]{0,1500}/);
  assert.ok(block, 'checkUpdateBtn 处理器找不到');
  const noComments = block[0].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/['"][^'"]*[\u4e00-\u9fff][^'"]*['"]/.test(noComments.replace(/L\('[^']*'/g, "L(''")),
    '检查更新处理器里出现硬编码中文文案');
});

// ---------------------------------------------------------------------------
// D. preload 白名单纪律
// ---------------------------------------------------------------------------

test('settings-preload 只多开 checkUpdate 一个无参通道：update: 通道唯一且无参数注入面', () => {
  const pl = fs.readFileSync(path.join(ROOT, 'main', 'settings-preload.js'), 'utf8');
  const channels = [...pl.matchAll(/'(update:[^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(channels, ['update:checkNow'], `preload 出现额外 update 通道: ${channels.join(',')}`);
  // checkUpdate 必须是无参箭头（渲染层不能往 IPC 塞任何参数）
  assert.ok(/checkUpdate:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('update:checkNow'\)/.test(pl),
    'checkUpdate 形态变了——可能开了参数注入面');
  // main.js 侧 handler 不收参
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  assert.ok(/ipcMain\.handle\('update:checkNow',\s*async\s*\(\)\s*=>/.test(mainSrc),
    'update:checkNow handler 开始收参数了——注入面出现');
});

// ---------------------------------------------------------------------------
// E. 关于角邮箱链路
// ---------------------------------------------------------------------------

test('关于角无硬编码占位邮箱；首拉未成（无缓存+全挂）时不空白不 undefined', async () => {
  assert.ok(!html.includes('author@example.com'), 'settings.html 硬编码占位邮箱回魂');
  assert.ok(/authorCfg\s*&&\s*authorCfg\.contactEmail/.test(html), 'renderAbout 不读 authorCfg.contactEmail');
  // 主进程恒给值：settingsPanel:get 组装处 authorConfig 两行兜底（get() 或 DEFAULT）
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  assert.ok(/authorConfig:\s*remoteConfig\s*\?\s*remoteConfig\.get\(\)\s*:\s*remoteConfigModule\.DEFAULT_AUTHOR_CONFIG/.test(mainSrc),
    'settingsPanel:get 不再恒给 authorConfig');
  // 行为：无缓存 + 全 URL 挂 → get() 快照的 contactEmail 必须是非空字符串（显示占位邮箱，不是空白/undefined）
  const mgr = rc.createRemoteConfig({
    cachePath: path.join(require('os').tmpdir(), 'asl-qa-v161-nocache-' + Date.now() + '.json'),
    fetchImpl: async () => { throw new Error('offline'); },
    logImpl: () => {},
  });
  const snap = mgr.get();
  mgr.stop();
  assert.ok(snap && typeof snap === 'object', '首拉未成时 get() 返回空');
  assert.ok(typeof snap.contactEmail === 'string' && snap.contactEmail.length > 0,
    `首拉未成时 contactEmail 为空/undefined: ${JSON.stringify(snap.contactEmail)}`);
});

// ---------------------------------------------------------------------------
// F. 去国度视角独立断言
// ---------------------------------------------------------------------------

test('去国度视角：i18n 双包 + 预设库 + 提示词模板双语无「国内/国外/domestic/overseas」', () => {
  const bad = /国内|国外|domestic|overseas/i;
  for (const [lang, pack] of Object.entries(i18n.PACKS)) {
    for (const [k, v] of Object.entries(pack)) {
      assert.ok(!bad.test(v), `i18n ${lang} ${k} 含国度视角词: ${v}`);
    }
  }
  for (const g of presets.PRESET_GROUPS) {
    assert.ok(!bad.test(g.group) && !bad.test(g.groupEn), `预设分组名含国度视角词: ${g.group}/${g.groupEn}`);
    for (const it of g.items) {
      assert.ok(!bad.test(it.name), `预设条目名含国度视角词: ${it.name}`);
    }
  }
  // 提示词模板：双语生成器产出全文扫描
  for (const lang of ['zh-CN', 'en-US']) {
    const txt = prompt.buildMqttPrompt(lang, 'mqtt://broker.emqx.io:1883', 'test/topic');
    assert.ok(!bad.test(txt), `MQTT 提示词(${lang})含国度视角词`);
  }
  // 分组锚点：第一组是「中国」视角而非「国内」
  assert.strictEqual(presets.PRESET_GROUPS[0].group, '中国常用');
  assert.strictEqual(presets.PRESET_GROUPS[0].groupEn, 'China');
});

// ---------------------------------------------------------------------------
// G. sticky 栏
// ---------------------------------------------------------------------------

test('sticky 栏：不透明底 + 层级唯一 + 呼吸动画存在；面板内无更高 z-index 浮层', () => {
  const bar = html.match(/\.stickybar\s*\{([\s\S]*?)\}/);
  assert.ok(bar, '.stickybar 规则找不到');
  assert.ok(/position:\s*sticky/.test(bar[1]) && /top:\s*0/.test(bar[1]), 'sticky 定位缺失');
  assert.ok(/background:\s*var\(--bg\)/.test(bar[1]), '背景不是不透明变量——滚动内容会透上来');
  assert.ok(/z-index:\s*\d+/.test(bar[1]), '缺 z-index');
  // 层级冲突面：全文件 z-index 出现次数（stickybar 本体 + 注释提及不算）
  const zDecl = [...html.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  const barZ = Number(bar[1].match(/z-index:\s*(\d+)/)[1]);
  for (const z of zDecl) {
    assert.ok(z <= barZ, `存在比 stickybar(${barZ}) 更高的浮层 z-index=${z}——会压栏或互相穿透`);
  }
  // 呼吸动画
  assert.ok(/@keyframes breathe/.test(html) && /\.btn\.breathing/.test(html), '呼吸灯 CSS 缺失');
  assert.ok(/classList\.toggle\('breathing'/.test(html), 'setDirty 未接线 breathing class');
});

// ---------------------------------------------------------------------------
(async () => {
  let passed = 0;
  const failed = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      failed.push(name);
      console.log(`FAIL - ${name}`);
      console.log(String(err && err.message).split('\n').slice(0, 4).join('\n'));
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed${failed.length ? ' (with failures)' : ''}`);
  process.exit(failed.length ? 1 : 0);
})();
