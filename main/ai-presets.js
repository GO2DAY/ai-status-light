/**
 * main/ai-presets.js — 全球 AI 预选库（v1.6.0 功能一）。
 *
 * 设置面板「快捷添加」区的数据源：分组列表，每条带官网链接与可选的桌面
 * 检测特征。点「添加」写入 agents+watchers（走 settingsPanel:save 既有
 * 链路），保存后灯条立即出现。
 *
 * 关键设计：
 *   - 有桌面客户端的条目带 exe/windowKeywords —— 添加后走现有 watcher
 *     自动检测（进程 + 画面双通道，双闸门规则不受影响）
 *   - cloudOnly 条目【不编造检测特征】——只能 HTTP/MQTT 上报接入，面板
 *     里标「云端上报」徽标，点击展开接入提示词（复用 integration-prompt.js）
 *   - 远程作者配置（remote-config.js）可下发更新的 presets：本地内置为底，
 *     远程为准（presetsUpdatedAt 更新才覆盖），见 pickPresets()
 *
 * UMD 双通道赋值（v1.5.2 P0 修复模式）：module.exports 与 window 全局
 * **同时**挂，绝不用 else。tests/umd-dual-env.test.js 加载清单含本模块。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ASL_PRESETS = api;
  else if (root && typeof root === 'object') root.ASL_PRESETS = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** 内置预选库的修订日期；远程 presetsUpdatedAt 比它新才覆盖显示。 */
  const PRESETS_UPDATED_AT = '2026-10-20';

  /**
   * 内置预选库。id 全小写英文（符合 AGENT_ID_PATTERN），url 一律 https
   * 官网首页。宁缺毋滥：不确定官网的一律不收。
   *
   * 注意：马维斯用 id 'mavis' —— 与 main/ai-signatures.js 特征库、存量
   * 配置的 agent id 保持一致（进程名本身是 marvis.exe）。
   */
  const PRESET_GROUPS = [
    {
      group: '中国常用',
      groupEn: 'China',
      items: [
        { id: 'doubao', name: '豆包', url: 'https://www.doubao.com', exe: 'Doubao.exe', windowKeywords: ['豆包', 'Doubao'] },
        { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com', cloudOnly: true },
        { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com' },
        { id: 'qwen', name: '通义千问', url: 'https://www.qianwen.com' },
        { id: 'ernie', name: '文心一言', url: 'https://wenxin.baidu.com', cloudOnly: true },
        { id: 'yuanbao', name: '腾讯元宝', url: 'https://yuanbao.tencent.com' },
        { id: 'mavis', name: '马维斯', url: 'https://marvis.qq.com', exe: 'Marvis.exe', windowKeywords: ['Marvis', '马维斯'] },
        { id: 'workbuddy', name: 'WorkBuddy', url: 'https://www.workbuddy.cn', exe: 'workbuddy.exe', windowKeywords: ['WorkBuddy'] },
        { id: 'feishu', name: '飞书', url: 'https://www.feishu.cn', exe: 'Feishu.exe', windowKeywords: ['飞书', 'Feishu'] },
      ],
    },
    {
      group: '国际常用',
      groupEn: 'International',
      items: [
        { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' },
        { id: 'claude', name: 'Claude', url: 'https://claude.ai', cloudOnly: true },
        { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com', cloudOnly: true },
        { id: 'grok', name: 'Grok', url: 'https://grok.com', cloudOnly: true },
        { id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com' },
        { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai', cloudOnly: true },
      ],
    },
    {
      group: '开发工具',
      groupEn: 'Dev Tools',
      items: [
        { id: 'cursor', name: 'Cursor', url: 'https://cursor.com', exe: 'Cursor.exe', windowKeywords: ['Cursor'] },
        { id: 'windsurf', name: 'Windsurf', url: 'https://devin.ai', exe: 'Windsurf.exe', windowKeywords: ['Windsurf'] },
        { id: 'bolt', name: 'Bolt', url: 'https://bolt.new', cloudOnly: true },
        { id: 'v0', name: 'v0', url: 'https://v0.app', cloudOnly: true },
        { id: 'replit', name: 'Replit', url: 'https://replit.com', cloudOnly: true },
        { id: 'base44', name: 'Base44', url: 'https://base44.com', cloudOnly: true },
        { id: 'lovable', name: 'Lovable', url: 'https://lovable.dev', cloudOnly: true },
        { id: 'codebuddy', name: 'CodeBuddy', url: 'https://www.codebuddy.cn' },
      ],
    },
    {
      group: '更多（地区主流 / 行业垂直）',
      groupEn: 'More (Regional / Vertical)',
      items: [
        // 日本（rinna 条目已删：服务 2023 年停运，rinna.jp/rinna.co.jp 均 NXDOMAIN，QA R2 拍板）
        { id: 'line-ai', name: 'LINE AI（日本）', url: 'https://line.me', cloudOnly: true },
        // 印度
        { id: 'krutrim', name: 'Krutrim（印度）', url: 'https://olakrutrim.com', cloudOnly: true },
        { id: 'sarvam', name: 'Sarvam AI（印度）', url: 'https://www.sarvam.ai', cloudOnly: true },
        // 欧洲
        { id: 'mistral', name: 'Mistral（欧洲）', url: 'https://mistral.ai', cloudOnly: true },
        { id: 'deepl', name: 'DeepL（欧洲）', url: 'https://www.deepl.com' },
        // 行业垂直：设计 / 视频 / 法律
        { id: 'canva', name: 'Canva（设计）', url: 'https://www.canva.com' },
        { id: 'runway', name: 'Runway（视频）', url: 'https://runway.com', cloudOnly: true },
        { id: 'harvey', name: 'Harvey（法律）', url: 'https://www.harvey.ai', cloudOnly: true },
      ],
    },
  ];

  /** 与 settings-ops.js 的 AGENT_ID_PATTERN 同规则（这里独立一份防循环依赖）。 */
  const ID_PATTERN = /^[a-z0-9_-]{1,24}$/i;

  /**
   * 校验一份预设分组数据（内置出库前自检 + 远程下发准入，同一套规则）。
   * @param {*} groups 候选分组数组
   * @returns {{ok: boolean, errors: string[]}}
   */
  function validatePresets(groups) {
    const errors = [];
    if (!Array.isArray(groups) || groups.length === 0) {
      return { ok: false, errors: ['presets 必须是非空分组数组'] };
    }
    const seen = new Set();
    groups.forEach(function (g, gi) {
      const where = 'group[' + gi + ']';
      if (!g || typeof g !== 'object') { errors.push(where + ' 不是对象'); return; }
      if (typeof g.group !== 'string' || !g.group.trim()) errors.push(where + '.group 为空');
      if (typeof g.groupEn !== 'string' || !g.groupEn.trim()) errors.push(where + '.groupEn 为空');
      if (!Array.isArray(g.items) || g.items.length === 0) {
        errors.push(where + '.items 为空');
        return;
      }
      g.items.forEach(function (it, ii) {
        const w = where + '.items[' + ii + ']';
        if (!it || typeof it !== 'object') { errors.push(w + ' 不是对象'); return; }
        if (typeof it.id !== 'string' || !ID_PATTERN.test(it.id)) {
          errors.push(w + '.id「' + it.id + '」不合法');
        } else if (seen.has(it.id)) {
          errors.push(w + '.id「' + it.id + '」重复');
        } else {
          seen.add(it.id);
        }
        if (typeof it.name !== 'string' || !it.name.trim()) errors.push(w + '.name 为空');
        if (typeof it.url !== 'string' || !/^https:\/\//i.test(it.url)) {
          errors.push(w + '.url 必须 https：' + it.url);
        }
        if (it.exe !== undefined && (typeof it.exe !== 'string' || !/\.exe$/i.test(it.exe))) {
          errors.push(w + '.exe 须以 .exe 结尾：' + it.exe);
        }
        if (it.windowKeywords !== undefined && !Array.isArray(it.windowKeywords)) {
          errors.push(w + '.windowKeywords 须为数组');
        }
        // cloudOnly 条目不编造检测特征：exe/windowKeywords 必须缺席
        if (it.cloudOnly === true && (it.exe || it.windowKeywords)) {
          errors.push(w + ' 标了 cloudOnly 却带检测特征');
        }
      });
    });
    return { ok: errors.length === 0, errors };
  }

  /**
   * 合并显示用预选库：本地内置为底，远程为准。
   * @param {Array} localGroups 内置库
   * @param {*} remoteGroups 远程下发的 groups（可为空/坏数据）
   * @returns {Array} 实际展示的分组数组
   */
  function mergePresets(localGroups, remoteGroups) {
    if (remoteGroups && validatePresets(remoteGroups).ok) return remoteGroups;
    return localGroups;
  }

  /**
   * 按修订日期决定展示哪份库：远程 presetsUpdatedAt 严格更新才覆盖内置。
   * @param {Array} localGroups 内置库
   * @param {string} localStamp 内置库修订日期（PRESETS_UPDATED_AT）
   * @param {*} authorConfig remote-config 的有效配置（可为 null）
   * @returns {Array}
   */
  function pickPresets(localGroups, localStamp, authorConfig) {
    if (!authorConfig || typeof authorConfig !== 'object') return localGroups;
    const remote = authorConfig.presets;
    if (!remote || !validatePresets(remote).ok) return localGroups;
    const remoteStamp = Date.parse(authorConfig.presetsUpdatedAt || '');
    const localTime = Date.parse(localStamp || '');
    if (Number.isFinite(remoteStamp) && Number.isFinite(localTime) && remoteStamp <= localTime) {
      return localGroups; // 远程不比内置新：不覆盖
    }
    return remote;
  }

  /** 按 id 查条目（面板「已添加」判定用）。 */
  function findPreset(groups, id) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const it of g.items || []) {
        if (it.id === id) return it;
      }
    }
    return null;
  }

  return { PRESETS_UPDATED_AT, PRESET_GROUPS, validatePresets, mergePresets, pickPresets, findPreset };
});
