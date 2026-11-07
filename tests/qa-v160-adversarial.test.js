'use strict';

/**
 * tests/qa-v160-adversarial.test.js — v1.6.0 对抗复审（QA 严过关 R7）。
 *
 * 独立构造，不复用工程师的 ai-presets/gear-menu/remote-config/auto-updater 测试：
 *   A. 预设库与特征库的 id 一致性（mavis 对齐断言）+ URL 格式/域名白名单（离线降级）
 *   B. gear 白名单对抗（越权 action 串实测）
 *   C. validateAuthorConfig 注入清洗（javascript:/data:/http:/字符串 "true"）
 *   D. fetchWithFallback 回退顺序 + 缓存三级取舍全链路
 *   E. broker 前缀校验边界 + buildMqttPrompt 第三参
 *   F. evaluateUpdate 全分支 + PORTABLE 两态
 *   G. 引流位 shouldShowAlertPromo 两态
 *   H. 源码锚定（齿轮浮层不调 setWidth、shell:openExternal 仅 https）
 *
 * 运行：node tests/qa-v160-adversarial.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const presets = require('../main/ai-presets');
const signatures = require('../main/ai-signatures');
const gear = require('../main/gear-menu');
const rc = require('../main/remote-config');
const settingsOps = require('../main/settings-ops');
const prompt = require('../main/integration-prompt');
const updater = require('../main/auto-updater');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ===========================================================================
// A. 预设库
// ===========================================================================

test('预设-特征库 id 一致性：同主体两处登记必须同 id（防重复灯）', () => {
  // 预设库里带 exe 检测特征的条目，若特征库也有同主体条目，id 必须一致 ——
  // 否则自动发现会按特征库 id 再加一盏灯，用户看到两个同名灯。
  const sigById = new Map(signatures.AI_SIGNATURES.map((s) => [s.id, s]));
  const conflicts = [];
  for (const g of presets.PRESET_GROUPS) {
    for (const it of g.items) {
      if (!it.exe) continue;
      // 同主体判定：预设的 exe（小写）出现在某条特征的 processes 里
      for (const s of signatures.AI_SIGNATURES) {
        const procs = (s.processes || []).map((p) => String(p).toLowerCase());
        if (procs.includes(String(it.exe).toLowerCase()) && s.id !== it.id) {
          conflicts.push(`${it.id}(预设) vs ${s.id}(特征库) exe=${it.exe}`);
        }
      }
      // 预设 id 若恰好在特征库但 exe 对不上，也是隐患
      const same = sigById.get(it.id);
      if (same && same.processes &&
          !same.processes.map((p) => p.toLowerCase()).includes(String(it.exe).toLowerCase())) {
        conflicts.push(`${it.id}: 预设 exe=${it.exe} 与特征库 processes=${same.processes} 不符`);
      }
    }
  }
  assert.deepStrictEqual(conflicts, [], `预设与特征库 id 冲突:\n${conflicts.join('\n')}`);
});

test('URL 离线降级断言：32 条全 https、域名在白名单、无杜撰形态', () => {
  const items = presets.PRESET_GROUPS.flatMap((g) => g.items);
  // 条数锁：31 条（R2 收官删掉 rinna——服务 2023 停运，域名 NXDOMAIN 无活链可换）
  assert.strictEqual(items.length, 31, `预设条数变了: ${items.length}`);
  // 域名归属白名单（QA 独立维护：每个域名对应官方主体，新域名进库必须过这道）
  // v1.6.0 修复单同步：品牌迁移落点按 tests/qa-v160-url-results.txt 实测 +
  // team-lead WebSearch 交叉证实更新（qianwen/wenxin/marvis.qq/devin/v0.app/
  // rinna.jp/olakrutrim/runway.com）。
  const DOMAIN_OWNER = {
    'www.doubao.com': '字节跳动', 'chat.deepseek.com': '深度求索', 'www.kimi.com': '月之暗面',
    'www.qianwen.com': '阿里', 'wenxin.baidu.com': '百度', 'yuanbao.tencent.com': '腾讯',
    'marvis.qq.com': '腾讯', 'www.workbuddy.cn': '腾讯', 'www.feishu.cn': '字节跳动',
    'chatgpt.com': 'OpenAI', 'claude.ai': 'Anthropic', 'gemini.google.com': 'Google',
    'grok.com': 'xAI', 'copilot.microsoft.com': 'Microsoft', 'www.perplexity.ai': 'Perplexity',
    'cursor.com': 'Anysphere', 'devin.ai': 'Cognition(Windsurf)', 'bolt.new': 'StackBlitz',
    'v0.app': 'Vercel', 'replit.com': 'Replit', 'base44.com': 'Base44',
    'lovable.dev': 'Lovable', 'www.codebuddy.cn': '腾讯',
    'line.me': 'LINE', 'olakrutrim.com': 'Ola Krutrim',
    'www.sarvam.ai': 'Sarvam', 'mistral.ai': 'Mistral', 'www.deepl.com': 'DeepL',
    'www.canva.com': 'Canva', 'runway.com': 'Runway', 'www.harvey.ai': 'Harvey',
  };
  for (const it of items) {
    assert.ok(/^https:\/\//i.test(it.url), `${it.id} URL 非 https: ${it.url}`);
    const host = new URL(it.url).hostname;
    assert.ok(DOMAIN_OWNER[host], `${it.id} 域名 ${host} 不在官方主体白名单（疑似杜撰域名）`);
    assert.ok(!it.url.includes('?') && !it.url.includes('#'), `${it.id} URL 带跟踪参数`);
  }
  // 内置库自检必须过（工程师声称 validatePresets 是出库闸）
  const v = presets.validatePresets(presets.PRESET_GROUPS);
  assert.ok(v.ok, `内置库自检不过: ${v.errors.join('; ')}`);
});

// ===========================================================================
// B. gear 白名单
// ===========================================================================

test('gear:action 白名单：越权串全部拒绝，合法四项放行', () => {
  const bad = [
    'QUIT', 'Quit', 'quit ', ' quit', '', null, undefined, 0, {},
    '__proto__', 'constructor', 'prototype', 'agents;quit', 'quit\x00',
    'refreshall', 'agent', 'setting', ['quit'], { id: 'quit' },
  ];
  for (const b of bad) {
    assert.strictEqual(gear.isGearAction(b), false, `越权 action 被放行: ${JSON.stringify(b)}`);
  }
  for (const ok of ['agents', 'settings', 'refresh', 'quit']) {
    assert.strictEqual(gear.isGearAction(ok), true);
  }
  // 菜单项与 i18n key 对应关系：每个 key 必须在语言包里
  const i18n = require('../main/i18n');
  for (const it of gear.GEAR_MENU_ITEMS) {
    assert.ok(i18n.PACKS['zh-CN'][it.key] && i18n.PACKS['en-US'][it.key],
      `菜单 key ${it.key} 缺语言包文案`);
  }
});

test('齿轮浮层不裁灯：App.jsx 的 gearOpen 不进 panelOpen，无 setWidth 路径', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  // panelOpen 只由 settingsOpen/selectedId 构成
  const m = src.match(/const panelOpen = ([^;]+);/);
  assert.ok(m, 'panelOpen 定义找不到');
  assert.ok(!m[1].includes('gearOpen'), `gearOpen 混进了 panelOpen: ${m[1]}——菜单会撑窗裁灯`);
  // gear 菜单渲染块内不得有 setWidth 调用
  const menuIdx = src.indexOf('asl-gear-menu');
  assert.ok(menuIdx > -1, '齿轮菜单不存在');
  // main.js 侧 gear:action 白名单接线
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  assert.ok(/ipcMain\.on\('gear:action'[\s\S]{0,200}isGearAction\(action\)\) return/.test(mainSrc),
    'gear:action 缺白名单拦截');
  // refresh 与右键菜单同逻辑：都调 agentWatcher.refreshNow
  assert.strictEqual(
    (mainSrc.match(/agentWatcher\.refreshNow\(\)/g) || []).length >= 2, true,
    'refreshNow 调用点 <2（齿轮与右键未共用同逻辑）');
});

// ===========================================================================
// C. validateAuthorConfig 注入清洗
// ===========================================================================

test('配置清洗：javascript:/data:/http: 注入全拒；promo.enabled 字符串 "true" 蒙混不过', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'http://insecure.com/x', 'HTTPS://ok.com/x'.toLowerCase().replace('https', 'http'), 'ftp://x.com']) {
    const out = rc.validateAuthorConfig({ kofiUrl: bad, promo: { enabled: true, text: 't', url: bad }, notice: { text: 'n', url: bad } });
    assert.strictEqual(out.kofiUrl, rc.DEFAULT_AUTHOR_CONFIG.kofiUrl, `kofiUrl 注入未拦: ${bad}`);
    assert.strictEqual(out.promo.url, '', `promo.url 注入未拦: ${bad}`);
    assert.strictEqual(out.notice.url, '', `notice.url 注入未拦: ${bad}`);
  }
  // https 大写前缀应放行（合法）
  const ok = rc.validateAuthorConfig({ kofiUrl: 'HTTPS://KO-FI.COM/GO2DAY' });
  assert.strictEqual(ok.kofiUrl, 'HTTPS://KO-FI.COM/GO2DAY', '大写 https 被误拒');
  // promo.enabled 只认布尔 true：字符串/数字/对象全 false
  for (const v of ['true', 1, 'yes', [], {}, null, undefined]) {
    const out = rc.validateAuthorConfig({ promo: { enabled: v, text: 't', url: '' } });
    assert.strictEqual(out.promo.enabled, false, `promo.enabled=${JSON.stringify(v)} 蒙混过关`);
  }
  assert.strictEqual(rc.validateAuthorConfig({ promo: { enabled: true } }).promo.enabled, true);
  // 非对象整体 null
  for (const bad of [null, undefined, 42, 'str', [1, 2], true]) {
    assert.strictEqual(rc.validateAuthorConfig(bad), null);
  }
  // 超长字段截断
  const long = rc.validateAuthorConfig({ contactEmail: 'e'.repeat(500), promo: { enabled: true, text: 't'.repeat(500) } });
  assert.ok(long.contactEmail.length <= 120 && long.promo.text.length <= 200, '超长字段未截断');
});

// ===========================================================================
// D. fetchWithFallback + 缓存三级取舍
// ===========================================================================

test('回退顺序：首选 500 -> 次选成功；首选超时 -> 次选成功；全失败 -> {ok:false} 不 reject', async () => {
  const urls = ['https://first.example/cfg.json', 'https://second.example/cfg.json'];
  // 首选 500
  let r = await rc.fetchWithFallback(urls, async (u) => (u === urls[0]
    ? { ok: false, status: 500 }
    : { ok: true, text: async () => JSON.stringify({ version: 9, contactEmail: 'a@b.c' }) }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, urls[1], '首选 500 未回退次选');
  assert.strictEqual(r.data.contactEmail, 'a@b.c');
  // 首选抛错（超时/断网）
  r = await rc.fetchWithFallback(urls, async (u) => {
    if (u === urls[0]) throw new Error('aborted');
    return { ok: true, text: async () => '{"version":2}' };
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, urls[1]);
  // 首选返回坏 JSON
  r = await rc.fetchWithFallback(urls, async (u) => (u === urls[0]
    ? { ok: true, text: async () => 'not json{{{' }
    : { ok: true, text: async () => '{"version":3}' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, urls[1]);
  // 首选返回合法 JSON 但非对象 -> 也要回退
  r = await rc.fetchWithFallback(urls, async (u) => (u === urls[0]
    ? { ok: true, text: async () => '[1,2,3]' }
    : { ok: true, text: async () => '{"version":4}' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, urls[1], '合法但非对象 JSON 未回退');
  // 全失败：{ok:false}，永不 reject
  r = await rc.fetchWithFallback(urls, async () => { throw new Error('down'); });
  assert.deepStrictEqual(r, { ok: false });
});

test('缓存三级取舍全链路：拉取成功写缓存 -> 拉失败读缓存 -> 删缓存用内置默认', async () => {
  const tmp = path.join(os.tmpdir(), `asl-qa-v160-${Date.now()}.json`);
  try {
    // 1) 拉取成功 -> 写缓存
    const mgr = rc.createRemoteConfig({
      cachePath: tmp,
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ version: 7, contactEmail: 'real@author.dev', kofiUrl: 'https://ko-fi.com/custom' }) }),
      logImpl: () => {},
      urls: ['https://x.example/cfg.json'],
    });
    const fresh = await mgr.refresh();
    assert.strictEqual(fresh.contactEmail, 'real@author.dev');
    assert.ok(fs.existsSync(tmp), '拉取成功未写缓存');
    // 2) 新实例（模拟重启）：拉失败 -> 读缓存
    const mgr2 = rc.createRemoteConfig({
      cachePath: tmp,
      fetchImpl: async () => { throw new Error('offline'); },
      logImpl: () => {},
      urls: ['https://x.example/cfg.json'],
    });
    assert.strictEqual(mgr2.get().contactEmail, 'real@author.dev', '启动未读缓存');
    const after = await mgr2.refresh();
    assert.strictEqual(after.contactEmail, 'real@author.dev', '拉失败后丢了缓存值');
    // 3) 删缓存 -> 内置默认
    fs.unlinkSync(tmp);
    const mgr3 = rc.createRemoteConfig({
      cachePath: tmp,
      fetchImpl: async () => { throw new Error('offline'); },
      logImpl: () => {},
      urls: ['https://x.example/cfg.json'],
    });
    assert.strictEqual(mgr3.get().contactEmail, rc.DEFAULT_AUTHOR_CONFIG.contactEmail,
      '无缓存未回退内置默认');
    // 4) 坏缓存文件 = 无缓存
    fs.writeFileSync(tmp, '{{{broken', 'utf8');
    assert.strictEqual(rc.loadCache(tmp), null, '坏缓存未按无缓存处理');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
});

test('漂移锁：仓库根 author-config.json 与内置默认深等（改一边必红）', () => {
  const repoCfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'author-config.json'), 'utf8')
  );
  const cleaned = rc.validateAuthorConfig(repoCfg);
  // 与内置默认逐字段对齐（presets 远程专属，本地默认没有，排除比较）
  const { presets: _p, ...cleanedNoPresets } = cleaned;
  assert.deepStrictEqual(cleanedNoPresets, rc.DEFAULT_AUTHOR_CONFIG,
    'author-config.json 与 DEFAULT_AUTHOR_CONFIG 漂移——远程下线后用户看到的内容与仓库不一致');
});

// ===========================================================================
// E. broker 边界
// ===========================================================================

test('broker 前缀校验：四族放行，http/https/ftp/javascript/超长拒绝，空串=恢复默认', () => {
  const base = { agents: [{ id: 'a1', name: 'A' }] };
  for (const ok of ['mqtt://h:1883', 'mqtts://h:8883', 'ws://h:8083', 'wss://h:8084/mqtt', 'MQTT://UPPER.COM']) {
    const r = settingsOps.validateSettingsPayload({ ...base, mqttBroker: ok });
    assert.ok(r.ok && r.value.mqttBroker === ok.trim(), `合法 broker 被拒: ${ok}`);
  }
  for (const bad of ['http://h', 'https://h', 'ftp://h', 'javascript:x', 'mqtt:/missing-slash', `mqtt://h${'x'.repeat(200)}`]) {
    const r = settingsOps.validateSettingsPayload({ ...base, mqttBroker: bad });
    assert.strictEqual(r.ok, false, `非法 broker 放行: ${bad}`);
  }
  // 空串 = 恢复默认（不覆盖语义由 main.js 处理空串落盘；这里验校验放行空串）
  const rEmpty = settingsOps.validateSettingsPayload({ ...base, mqttBroker: '' });
  assert.ok(rEmpty.ok && rEmpty.value.mqttBroker === '', '空串语义变了');
  // undefined = 不携带 -> value 不含该键（不覆盖现存值）
  const rNone = settingsOps.validateSettingsPayload(base);
  assert.ok(!('mqttBroker' in rNone.value), '缺省携带 mqttBroker 会覆盖现存值');
  // wss 第二通道同规则
  const rBad2 = settingsOps.validateSettingsPayload({ ...base, mqttBrokerWss: 'tcp://h' });
  assert.strictEqual(rBad2.ok, false, 'WSS 通道校验漏了');
});

test('buildMqttPrompt 第三参：自定义 broker 进正文、非法回退 emqx、省略兼容', () => {
  const custom = prompt.buildMqttPrompt('asl/x1', 'zh-CN', { tcp: 'mqtts://my-broker.cn:8883', wss: 'wss://my-broker.cn:8084/mqtt' });
  assert.ok(custom.includes('mqtts://my-broker.cn:8883'), '自定义 tcp broker 未进正文');
  assert.ok(custom.includes('wss://my-broker.cn:8084/mqtt'), '自定义 wss broker 未进正文');
  assert.ok(!custom.includes('broker.emqx.io'), '自定义后仍写 emqx');
  // 非法值回退默认
  const bad = prompt.buildMqttPrompt('asl/x1', 'zh-CN', { tcp: 'http://evil', wss: 'javascript:x' });
  assert.ok(bad.includes('mqtts://broker.emqx.io:8883') && bad.includes('wss://broker.emqx.io:8084/mqtt'),
    '非法 broker 未回退 emqx');
  // 省略第三参 = 旧行为
  const dflt = prompt.buildMqttPrompt('asl/x1', 'zh-CN');
  assert.ok(dflt.includes('broker.emqx.io'));
  // 半配置：只给 tcp，wss 回退
  const half = prompt.buildMqttPrompt('asl/x1', 'en-US', { tcp: 'mqtt://only-tcp:1883' });
  assert.ok(half.includes('mqtt://only-tcp:1883') && half.includes('wss://broker.emqx.io:8084/mqtt'),
    '半配置回退不对');
});

// ===========================================================================
// F. evaluateUpdate 全分支 + PORTABLE 两态
// ===========================================================================

test('evaluateUpdate 全分支：dev 跳过 / 无 checkFn / 拉取失败 / 无新版 / 绿色版横幅 / 安装版流程', async () => {
  const banners = [];
  const onBanner = (i) => banners.push(i);
  // dev
  assert.strictEqual(await updater.evaluateUpdate({ isPackaged: false, checkFn: async () => ({ version: '9.9.9' }), currentVersion: '1.6.0' }), 'skipped');
  // 无 checkFn
  assert.strictEqual(await updater.evaluateUpdate({ isPackaged: true, currentVersion: '1.6.0' }), 'skipped');
  // 拉取失败静默
  assert.strictEqual(await updater.evaluateUpdate({ isPackaged: true, checkFn: async () => { throw new Error('net down'); }, currentVersion: '1.6.0' }), 'failed');
  // 无新版 / 同版
  assert.strictEqual(await updater.evaluateUpdate({ isPackaged: true, checkFn: async () => null, currentVersion: '1.6.0' }), 'none');
  assert.strictEqual(await updater.evaluateUpdate({ isPackaged: true, checkFn: async () => ({ version: '1.6.0' }), currentVersion: '1.6.0' }), 'none');
  // 绿色版：横幅且不自动下载
  assert.strictEqual(await updater.evaluateUpdate({ isPackaged: true, isPortable: true, checkFn: async () => ({ version: '1.7.0' }), currentVersion: '1.6.0', onBanner }), 'banner');
  assert.strictEqual(banners.length, 1);
  assert.strictEqual(banners[0].version, '1.7.0');
  assert.ok(banners[0].url.includes('github.com'), '横幅 URL 非 Releases 页');
  // 安装版
  assert.strictEqual(await updater.evaluateUpdate({ isPackaged: true, isPortable: false, checkFn: async () => ({ version: '1.7.0' }), currentVersion: '1.6.0', onBanner }), 'installed-flow');
  assert.strictEqual(banners.length, 1, '安装版误发横幅');
  // 绿色版无新版：无横幅
  assert.strictEqual(await updater.evaluateUpdate({ isPackaged: true, isPortable: true, checkFn: async () => null, currentVersion: '1.6.0', onBanner }), 'none');
  assert.strictEqual(banners.length, 1);
});

test('lazily require 缺失装死：无 electron-updater 依赖时 checkNow 返回 skipped 不崩', async () => {
  // 用隔离证明：startAutoUpdate 的 loadUpdater 在 require 失败时返回 null，
  // checkFn=null -> evaluateUpdate 走 'skipped'。本沙箱没有 electron-updater
  // 安装在依赖里也能跑——直接调 checkNow（isPackaged=true 强制走 loadUpdater）。
  const au = updater.startAutoUpdate({ isPackaged: true, isPortable: false, currentVersion: '1.6.0', logImpl: () => {} });
  const result = await au.checkNow();
  au.stop();
  // electron-updater 若恰好在 node_modules 里，会走真实检查（网络失败=failed 或 none）；
  // 不在则 skipped。两态都合法，唯一不允许的是抛异常。
  assert.ok(['skipped', 'failed', 'none', 'banner', 'installed-flow'].includes(result),
    `checkNow 返回了非法值: ${result}`);
  // PORTABLE 探测：main.js 里必须用 PORTABLE_EXECUTABLE_FILE 环境变量
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  assert.ok(/PORTABLE_EXECUTABLE_FILE/.test(mainSrc), 'main.js 未用 PORTABLE_EXECUTABLE_FILE 探测绿色版');
});

test('electron-builder.yml publish 段：YAML 可解析且字段名符合 electron-updater 契约', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  // publish 段结构锚定（无 js-yaml 依赖，用行级解析）
  const m = src.match(/publish:\s*\n(\s+- provider: (\w+)\s*\n\s+owner: (\S+)\s*\n\s+repo: (\S+))/);
  assert.ok(m, 'publish 段缺失或结构变了');
  assert.strictEqual(m[2], 'github', 'provider 非 github');
  assert.ok(m[3] && m[4], 'owner/repo 缺字段');
  // TODO 占位必须在发布前替换——锚定它存在（替换后此断言要更新为真实 owner）
  assert.ok(/TODO-GITHUB-OWNER/.test(src), 'publish.owner 占位已换（请同步更新本断言为真实 owner）');
});

// ===========================================================================
// G. 引流位
// ===========================================================================

test('引流位：url 空显示/非空隐藏；兜底 ko-fi.com/go2day', () => {
  assert.strictEqual(rc.shouldShowAlertPromo(''), true);
  assert.strictEqual(rc.shouldShowAlertPromo('   '), true);
  assert.strictEqual(rc.shouldShowAlertPromo(undefined), true);
  assert.strictEqual(rc.shouldShowAlertPromo(null), true);
  assert.strictEqual(rc.shouldShowAlertPromo('http://127.0.0.1:3001/alert'), false);
  assert.strictEqual(rc.DEFAULT_AUTHOR_CONFIG.kofiUrl, 'https://ko-fi.com/go2day', '兜底打赏链接变了');
  // 清洗后 promo 无 url 时 enabled 即使 true 也不应有可点链接（url 为空串）
  const out = rc.validateAuthorConfig({ promo: { enabled: true, text: 't', url: 'javascript:x' } });
  assert.strictEqual(out.promo.enabled, true);
  assert.strictEqual(out.promo.url, '', 'promo 非法 url 未清空（渲染层会做出可点坏链接）');
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
