'use strict';

/**
 * tests/ai-presets.test.js — v1.6.0 功能一：全球 AI 预选库单测（纯 node）。
 *
 * 运行：node tests/ai-presets.test.js
 *
 * 契约：
 *  1. 内置库结构合法：id 符合 AGENT_ID_PATTERN、url 全 https、分组非空、
 *     id 全局唯一（validatePresets 自检必须 0 错误）
 *  2. cloudOnly 条目绝不带检测特征（exe/windowKeywords）——不编造
 *  3. mergePresets：远程合法 → 远程为准；远程坏数据 → 本地内置兜底
 *  4. pickPresets：presetsUpdatedAt 严格更新才覆盖内置
 *  5. 派单锚点条目必须存在（doubao/chatgpt/cursor/workbuddy 等）
 */

const assert = require('assert');
const presets = require('../main/ai-presets');
const { AGENT_ID_PATTERN } = require('../main/settings-ops');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('内置库自检零错误（结构/id/url/唯一性/cloudOnly 无特征）', () => {
  const res = presets.validatePresets(presets.PRESET_GROUPS);
  assert.deepStrictEqual(res.errors, []);
  assert.ok(res.ok);
});

test('id 全部符合 AGENT_ID_PATTERN（与 settings-ops 同一规则）', () => {
  for (const g of presets.PRESET_GROUPS) {
    for (const it of g.items) {
      assert.ok(AGENT_ID_PATTERN.test(it.id), `id「${it.id}」不符 AGENT_ID_PATTERN`);
      assert.ok(/^https:\/\//i.test(it.url), `url 非 https：${it.url}`);
    }
    assert.ok(g.group && g.groupEn, `分组缺双语名：${JSON.stringify(g)}`);
    assert.ok(g.items.length > 0, '分组为空');
  }
});

test('cloudOnly 条目不编造检测特征；带 exe 的条目必须有窗口关键词', () => {
  for (const g of presets.PRESET_GROUPS) {
    for (const it of g.items) {
      if (it.cloudOnly) {
        assert.ok(!it.exe && !it.windowKeywords, `${it.id} 标 cloudOnly 却带检测特征`);
      }
      if (it.exe) {
        assert.ok(Array.isArray(it.windowKeywords) && it.windowKeywords.length > 0,
          `${it.id} 带 exe 缺窗口关键词（画面检测开箱即用约定）`);
      }
    }
  }
});

test('派单锚点条目存在（四组齐全）', () => {
  const must = ['doubao', 'deepseek', 'kimi', 'qwen', 'ernie', 'yuanbao', 'mavis', 'workbuddy', 'feishu',
    'chatgpt', 'claude', 'gemini', 'grok', 'copilot', 'perplexity',
    'cursor', 'windsurf', 'bolt', 'v0', 'replit', 'base44', 'lovable', 'codebuddy'];
  for (const id of must) {
    assert.ok(presets.findPreset(presets.PRESET_GROUPS, id), `缺派单锚点条目 ${id}`);
  }
  // more 组：日/印/欧 + 设计/视频/法律，宁缺毋滥但必须有内容
  const more = presets.PRESET_GROUPS.find((g) => g.groupEn === 'More (Regional / Vertical)');
  assert.ok(more && more.items.length >= 6, 'more 组条目不足');
});

test('马维斯 id 与特征库一致（mavis 对齐 ai-signatures，进程 marvis.exe）', () => {
  const it = presets.findPreset(presets.PRESET_GROUPS, 'mavis');
  assert.ok(it, '缺 mavis 条目');
  const sig = require('../main/ai-signatures').AI_SIGNATURES.find((s) => s.id === 'mavis');
  assert.ok(sig, '特征库缺 mavis（预设 id 必须与特征库 id 对齐）');
  assert.ok(
    sig.processes.map((p) => p.toLowerCase()).includes(it.exe.toLowerCase()),
    '预设 exe 与特征库 processes 不一致'
  );
});

// ---------------------------------------------------------------------------
// URL 域名白名单（v1.6.0 修复单修 3，收编 qa-v160-url-check.js 的思路为
// 离线断言）：每条 url 的 host 必须在人工核准清单内；新增/改条目必须连
// 清单一起改（双向精确匹配）——防未来幻觉 URL 混入。核准依据：
// tests/qa-v160-url-results.txt（QA 实测 32 条）+ team-lead WebSearch 交叉证实。
// ---------------------------------------------------------------------------
const APPROVED_DOMAINS = [
  // 中国区
  'www.doubao.com', 'chat.deepseek.com', 'www.kimi.com', 'www.qianwen.com',
  'wenxin.baidu.com', 'yuanbao.tencent.com', 'marvis.qq.com', 'www.workbuddy.cn',
  'www.feishu.cn',
  // 国际
  'chatgpt.com', 'claude.ai', 'gemini.google.com', 'grok.com',
  'copilot.microsoft.com', 'www.perplexity.ai',
  // 开发工具
  'cursor.com', 'devin.ai', 'bolt.new', 'v0.app', 'replit.com', 'base44.com',
  'lovable.dev', 'www.codebuddy.cn',
  // 地区主流 / 行业垂直
  'line.me', 'olakrutrim.com', 'www.sarvam.ai', 'mistral.ai',
  'www.deepl.com', 'www.canva.com', 'runway.com', 'www.harvey.ai',
];

test('URL 域名白名单：每条 url 的 host 都在核准清单内（双向精确匹配）', () => {
  const used = new Set();
  for (const g of presets.PRESET_GROUPS) {
    for (const it of g.items) {
      const host = new URL(it.url).hostname.toLowerCase();
      used.add(host);
      assert.ok(
        APPROVED_DOMAINS.includes(host),
        `${it.id} 的域名 ${host} 不在核准清单 —— 新增/改 URL 必须先人工核准再连清单一起改`
      );
    }
  }
  // 反向：清单里不得有僵尸条目（改 URL 不删旧域名 = 防线漏风）
  const stale = APPROVED_DOMAINS.filter((d) => !used.has(d));
  assert.deepStrictEqual(stale, [], `核准清单有僵尸域名：${stale.join(', ')}`);
});

test('mergePresets：远程合法 → 远程为准；坏数据 → 本地兜底', () => {
  const local = presets.PRESET_GROUPS;
  const remote = [{
    group: '远程组', groupEn: 'Remote',
    items: [{ id: 'remote-ai', name: 'RemoteAI', url: 'https://example.com', cloudOnly: true }],
  }];
  assert.strictEqual(presets.mergePresets(local, remote), remote);
  assert.strictEqual(presets.mergePresets(local, [{ group: '', items: [] }]), local);
  assert.strictEqual(presets.mergePresets(local, null), local);
  assert.strictEqual(presets.mergePresets(local, 'garbage'), local);
});

test('pickPresets：presetsUpdatedAt 严格更新才覆盖内置', () => {
  const local = presets.PRESET_GROUPS;
  const newer = {
    presetsUpdatedAt: '2099-01-01',
    presets: [{ group: '新', groupEn: 'New', items: [{ id: 'new-ai', name: 'N', url: 'https://x.com', cloudOnly: true }] }],
  };
  assert.strictEqual(presets.pickPresets(local, presets.PRESETS_UPDATED_AT, newer), newer.presets);
  const older = {
    presetsUpdatedAt: '2020-01-01',
    presets: [{ group: '旧', groupEn: 'Old', items: [{ id: 'old-ai', name: 'O', url: 'https://x.com', cloudOnly: true }] }],
  };
  assert.strictEqual(presets.pickPresets(local, presets.PRESETS_UPDATED_AT, older), local);
  assert.strictEqual(presets.pickPresets(local, presets.PRESETS_UPDATED_AT, null), local);
  // 远程 presets 坏数据：即使日期新也不覆盖
  const bad = { presetsUpdatedAt: '2099-01-01', presets: [{ group: '', items: [] }] };
  assert.strictEqual(presets.pickPresets(local, presets.PRESETS_UPDATED_AT, bad), local);
});

test('隐私：内置库零违禁串（旧主题/本名/本机路径）', () => {
  const json = JSON.stringify(presets.PRESET_GROUPS);
  for (const bad of ['qrzcfsywp3gmlvi0', '吴建明', 'C:\\Users\\']) {
    assert.ok(!json.includes(bad), `预选库含违禁串 ${bad}`);
  }
});

test('去国度视角（v1.6.1）：i18n 全量语言包 + 预设库 + 接入提示词无「国内/国外」', () => {
  const i18n = require('../main/i18n');
  const prompt = require('../main/integration-prompt');
  const blobs = [
    ['i18n 语言包', JSON.stringify(i18n.PACKS)],
    ['预设库', JSON.stringify(presets.PRESET_GROUPS)],
    ['HTTP 提示词 zh', prompt.buildHttpPrompt('zh-CN')],
    ['HTTP 提示词 en', prompt.buildHttpPrompt('en-US')],
    ['MQTT 提示词 zh', prompt.buildMqttPrompt('demo/base', 'zh-CN')],
    ['MQTT 提示词 en', prompt.buildMqttPrompt('demo/base', 'en-US')],
  ];
  for (const [label, text] of blobs) {
    for (const bad of ['国内', '国外']) {
      assert.ok(!text.includes(bad), `${label} 含国度视角词「${bad}」（神秘作者纪律：一律中性表述）`);
    }
  }
  // 分组名显式锚点：第一组必须是「中国」视角而非「国内」
  const g0 = presets.PRESET_GROUPS[0];
  assert.strictEqual(g0.group, '中国常用');
  assert.ok(/china/i.test(g0.groupEn), `第一组英文名应含 China：${g0.groupEn}`);
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
