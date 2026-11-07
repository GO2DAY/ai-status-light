'use strict';

/**
 * tests/v150-features.test.js — v1.5.0 三个功能的纯逻辑契约（无 electron）。
 *
 * 运行：node tests/v150-features.test.js
 *
 * 覆盖：
 *  1. 面板展开不裁灯（layout.panelWindowWidth）：窗口宽 = max(灯条全宽, 面板请求宽)
 *  2. 灯名两行全称（strip-name.stripDisplayName）：不再截 2 字符，全称 +
 *     12 字符硬上限兜底（视觉换行/省略由 CSS line-clamp 完成）
 *  3. 全球特征库扩充：每条新签名至少一个命中样例（进程或可信窗口通道）
 */

const assert = require('assert');
const { panelWindowWidth } = require('../main/layout');
const { stripDisplayName, STRIP_NAME_MAX } = require('../main/strip-name');
const { AI_SIGNATURES, signatureMatches } = require('../main/ai-signatures');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. 面板展开不裁灯（Bug：打开面板窗口收缩到 380，右侧的灯被切）
// ---------------------------------------------------------------------------

test('面板请求宽 > 灯条全宽：用面板宽（少灯时正常放大）', () => {
  assert.strictEqual(panelWindowWidth(380, 224), 380);
});

test('面板请求宽 < 灯条全宽：保持灯条全宽（多灯时不裁灯，核心契约）', () => {
  assert.strictEqual(panelWindowWidth(380, 516), 516);
  assert.strictEqual(panelWindowWidth(380, 1000), 1000);
});

test('面板收起（0/非法值）：回退灯条全宽', () => {
  assert.strictEqual(panelWindowWidth(0, 224), 224);
  assert.strictEqual(panelWindowWidth(-5, 224), 224);
  assert.strictEqual(panelWindowWidth(NaN, 224), 224);
  assert.strictEqual(panelWindowWidth(undefined, 224), 224);
});

test('面板请求宽 == 灯条全宽：不变（幂等，不触发多余 setBounds）', () => {
  assert.strictEqual(panelWindowWidth(516, 516), 516);
});

// ---------------------------------------------------------------------------
// 2. 灯名两行全称
// ---------------------------------------------------------------------------

test('灯名不再截 2 字符：全称返回（CSS 两行换行显示）', () => {
  assert.strictEqual(stripDisplayName('豆包工作伙伴'), '豆包工作伙伴'); // 6 字全称
  assert.strictEqual(stripDisplayName('WorkBuddy'), 'WorkBuddy'); // 不再变 "WO"
  assert.strictEqual(stripDisplayName('豆包'), '豆包');
});

test('灯名硬上限：超过 12 字符截断加省略号（数据层保险丝）', () => {
  const long = 'ABCDEFGHIJKLMNOP'; // 16 chars
  const out = stripDisplayName(long);
  assert.strictEqual(out, `${'ABCDEFGHIJKL'.slice(0, STRIP_NAME_MAX)}…`);
  assert.strictEqual(Array.from(out).length, STRIP_NAME_MAX + 1);
  // 恰好 12 不截
  assert.strictEqual(stripDisplayName('ABCDEFGHIJKL'), 'ABCDEFGHIJKL');
});

test('灯名空白回退：name 空用 id，都空用 ?', () => {
  assert.strictEqual(stripDisplayName('', 'chatgpt'), 'chatgpt');
  assert.strictEqual(stripDisplayName('  ', 'kimi'), 'kimi');
  assert.strictEqual(stripDisplayName(null, null), '?');
  assert.strictEqual(stripDisplayName(undefined, undefined), '?');
});

// ---------------------------------------------------------------------------
// 3. 全球特征库（每条新签名 ≥1 命中样例；短拉丁词窗口通道不可信）
// ---------------------------------------------------------------------------

const sigById = new Map(AI_SIGNATURES.map((s) => [s.id, s]));

/** 进程命中样例集：id -> 命中的 exe 名 */
const PROC_HIT_SAMPLES = {
  chatgpt: 'ChatGPT.exe',
  gemini: 'Gemini.exe',
  copilot: 'Copilot.exe',
  grok: 'Grok.exe',
  cursor: 'Cursor.exe',
  perplexity: 'Perplexity.exe',
  poe: 'Poe.exe',
  'le-chat': 'Le Chat.exe',
  'meta-ai': 'MetaAI.exe',
  'notion-ai': 'Notion.exe',
  windsurf: 'Windsurf.exe',
  trae: 'Trae.exe',
  zed: 'Zed.exe',
  aider: 'aider.exe',
  cline: 'cline.exe',
  xfspark: 'xfspark.exe',
  chatglm: 'chatglm.exe',
  tiangong: 'tiangong.exe',
  hailuo: 'hailuo.exe',
  kling: 'kling.exe',
  jimeng: 'jimeng.exe',
  suno: 'suno.exe',
};

/** 可信窗口命中样例集：id -> 命中的窗口标题（短拉丁词不在此列） */
const WINDOW_HIT_SAMPLES = {
  chatgpt: 'ChatGPT',
  claude: 'Claude Desktop - 新对话', // v1.5.0 claude 条目扩展的长词
  gemini: 'Google Gemini',
  copilot: 'Microsoft Copilot - 主页',
  perplexity: 'Perplexity AI',
  'le-chat': 'Le Chat - Mistral',
  'meta-ai': 'Meta AI',
  windsurf: 'Windsurf - 项目',
  xfspark: '讯飞星火',
  chatglm: '智谱清言',
  tiangong: '天工 - AI 助手',
  hailuo: '海螺AI',
  kling: '可灵 AI',
  jimeng: '即梦',
};

test('新签名全部存在且结构合法（id/name/processes/windowKeywords）', () => {
  const expectedIds = new Set([
    ...Object.keys(PROC_HIT_SAMPLES),
    ...Object.keys(WINDOW_HIT_SAMPLES),
  ]);
  for (const id of expectedIds) {
    const sig = sigById.get(id);
    assert.ok(sig, `特征库缺条目: ${id}`);
    assert.ok(sig.name && typeof sig.name === 'string', `${id} 缺 name`);
    assert.ok(Array.isArray(sig.processes) && sig.processes.length > 0, `${id} 缺 processes`);
  }
  // id 唯一（防双灯）
  const ids = AI_SIGNATURES.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, '特征库 id 有重复');
});

test('每条新签名：进程通道命中（主通道，最可靠）', () => {
  for (const [id, exe] of Object.entries(PROC_HIT_SAMPLES)) {
    const sig = sigById.get(id);
    assert.ok(sig, `缺条目 ${id}`);
    const hit = signatureMatches(sig, new Set([exe.toLowerCase()]), []);
    assert.ok(hit, `${id} 进程样例 ${exe} 未命中`);
  }
});

test('长词/中文窗口关键词：窗口通道命中（第二通道）', () => {
  for (const [id, title] of Object.entries(WINDOW_HIT_SAMPLES)) {
    const sig = sigById.get(id);
    assert.ok(sig, `缺条目 ${id}`);
    const hit = signatureMatches(sig, new Set(), [title]);
    assert.ok(hit, `${id} 窗口样例「${title}」未命中`);
  }
});

test('短拉丁词签名（Grok/Poe/Trae/Zed/Cursor/Cline/Suno/Aider）：窗口标题单独不命中（防误报收紧不回归）', () => {
  const shortLatin = {
    grok: 'Grok - 新对话',
    poe: 'Poe - Chat',
    trae: 'Trae IDE',
    zed: 'Zed Editor',
    cursor: 'main.ts - Cursor',
    cline: 'Cline 任务',
    suno: 'Suno - Create',
    aider: 'aider chat',
  };
  for (const [id, title] of Object.entries(shortLatin)) {
    const sig = sigById.get(id);
    const hit = signatureMatches(sig, new Set(), [title]);
    assert.strictEqual(hit, false, `${id} 仅靠短拉丁窗口词命中了「${title}」（应只信进程）`);
  }
});

test('同一 exe 不产生两盏灯：claude.exe 只命中 claude 一条', () => {
  const hits = AI_SIGNATURES.filter((s) =>
    signatureMatches(s, new Set(['claude.exe']), [])
  );
  assert.deepStrictEqual(hits.map((s) => s.id), ['claude']);
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
