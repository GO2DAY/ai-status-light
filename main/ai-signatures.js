'use strict';

/**
 * main/ai-signatures.js — 桌面 AI 软件特征库（数据驱动，可扩）。
 *
 * 每条特征 = { id, name, processes, windowKeywords }：
 *   id            建议的 agent id（符合 1-24 字符 a-z0-9_-）
 *   name          灯的显示名
 *   processes     进程 exe 名数组（匹配时不区分大小写）
 *   windowKeywords 窗口标题关键词数组（画面检测通道顺手用）
 *
 * 自动发现链路：agent-watcher 每 30s 把进程表 + 窗口标题清单交给 main.js，
 * main.js 用 findNewDiscoveries 过滤（已存在/blacklist/总开关）后自动入灯。
 *
 * 维护说明：新 AI 软件上市 = 往 AI_SIGNATURES 加一行，不改任何逻辑。
 * 进程名猜错了也没关系 —— 窗口关键词是第二通道；两条都错的条目只是
 * 永远发现不了，不会误伤（误加由用户删除 + blacklist 兜底）。
 */

const AI_SIGNATURES = [
  { id: 'doubao', name: '豆包', processes: ['doubao.exe'], windowKeywords: ['豆包', 'Doubao'] },
  { id: 'mavis', name: '马维斯', processes: ['marvis.exe'], windowKeywords: ['Marvis', '马维斯'] },
  { id: 'autoclaw', name: '澳龙', processes: ['autoclaw.exe'], windowKeywords: ['AutoClaw', '澳龙'] },
  { id: 'openclaw', name: 'OpenClaw', processes: ['openclaw.exe'], windowKeywords: ['OpenClaw'] },
  { id: 'abu', name: '阿布', processes: ['abu.exe'], windowKeywords: ['阿布'] },
  { id: 'cherry-studio', name: 'Cherry Studio', processes: ['cherry studio.exe', 'cherry-studio.exe', 'cherrystudio.exe'], windowKeywords: ['Cherry Studio'] },
  { id: 'deepseek', name: 'DeepSeek', processes: ['deepseek.exe'], windowKeywords: ['DeepSeek'] },
  { id: 'codex', name: 'Codex++', processes: ['codex++.exe', 'codex.exe'], windowKeywords: ['Codex'] },
  { id: 'cumora', name: 'Cumora', processes: ['cumora.exe'], windowKeywords: ['Cumora'] },
  { id: 'kimi', name: 'Kimi', processes: ['kimi.exe'], windowKeywords: ['Kimi'] },
  { id: 'qwen', name: '通义千问', processes: ['qwen.exe', 'tongyi.exe'], windowKeywords: ['通义千问', 'Qwen'] },
  { id: 'yuanbao', name: '腾讯元宝', processes: ['yuanbao.exe'], windowKeywords: ['腾讯元宝'] },
  { id: 'wenxin', name: '文心一言', processes: ['wenxin.exe', 'yiyan.exe'], windowKeywords: ['文心一言'] },
  { id: 'kimi-cli', name: 'Kimi CLI', processes: ['kimi-cli.exe', 'kimicli.exe'], windowKeywords: ['Kimi CLI'] },
  // Claude Desktop（v1.5.0）：与 claude 同一 exe，合并在同一条目避免一盏灯变两盏；
  // 'Claude Desktop' 14 字符走可信窗口通道，短词 'Claude' 仅进程通道。
  { id: 'claude', name: 'Claude', processes: ['claude.exe'], windowKeywords: ['Claude Desktop', 'Claude'] },

  // ------------------------------------------------------------------
  // 国际区（v1.5.0 全球发布版）。短拉丁词（≤6 字符：Grok/Poe/Trae/Zed/
  // Cursor/Cline/Suno）窗口通道不可信，仅靠进程命中 —— 见 isWindowKeywordTrusted。
  // ------------------------------------------------------------------
  { id: 'chatgpt', name: 'ChatGPT', processes: ['chatgpt.exe'], windowKeywords: ['ChatGPT'] },
  { id: 'gemini', name: 'Gemini', processes: ['gemini.exe'], windowKeywords: ['Google Gemini', 'Gemini'] },
  { id: 'copilot', name: 'Copilot', processes: ['copilot.exe'], windowKeywords: ['Microsoft Copilot', 'Copilot'] },
  { id: 'grok', name: 'Grok', processes: ['grok.exe'], windowKeywords: ['Grok'] },
  { id: 'cursor', name: 'Cursor', processes: ['cursor.exe'], windowKeywords: ['Cursor'] },
  { id: 'perplexity', name: 'Perplexity', processes: ['perplexity.exe'], windowKeywords: ['Perplexity'] },
  { id: 'poe', name: 'Poe', processes: ['poe.exe'], windowKeywords: ['Poe'] },
  { id: 'le-chat', name: 'Le Chat', processes: ['le chat.exe', 'lechat.exe'], windowKeywords: ['Le Chat'] },
  { id: 'meta-ai', name: 'Meta AI', processes: ['meta ai.exe', 'metaai.exe'], windowKeywords: ['Meta AI'] },
  // Notion 桌面端（Notion AI 内嵌其中，无独立 exe）
  { id: 'notion-ai', name: 'Notion AI', processes: ['notion.exe'], windowKeywords: ['Notion'] },
  { id: 'windsurf', name: 'Windsurf', processes: ['windsurf.exe'], windowKeywords: ['Windsurf'] },
  { id: 'trae', name: 'Trae', processes: ['trae.exe'], windowKeywords: ['Trae'] },
  { id: 'zed', name: 'Zed', processes: ['zed.exe'], windowKeywords: ['Zed'] },
  // Aider 是 CLI（跑在终端里，通常无独立 exe）：进程名猜错只是永远不发现，不误伤
  { id: 'aider', name: 'Aider', processes: ['aider.exe'], windowKeywords: ['Aider'] },
  // Cline 是 VS Code 扩展（无独立进程/窗口）：占位条目，进程猜错同上
  { id: 'cline', name: 'Cline', processes: ['cline.exe'], windowKeywords: ['Cline'] },

  // ------------------------------------------------------------------
  // 中国区补充（v1.5.0）
  // ------------------------------------------------------------------
  { id: 'xfspark', name: '讯飞星火', processes: ['xfspark.exe', 'spark.exe', 'iflytek-spark.exe'], windowKeywords: ['讯飞星火', 'iFLYTEK Spark'] },
  { id: 'chatglm', name: '智谱清言', processes: ['chatglm.exe', 'zhipu.exe', 'qingyan.exe'], windowKeywords: ['智谱清言', 'ChatGLM'] },
  { id: 'tiangong', name: '天工', processes: ['tiangong.exe'], windowKeywords: ['天工'] },
  { id: 'hailuo', name: '海螺AI', processes: ['hailuo.exe'], windowKeywords: ['海螺AI', 'Hailuo'] },
  { id: 'kling', name: '可灵', processes: ['kling.exe'], windowKeywords: ['可灵', 'Kling'] },
  { id: 'jimeng', name: '即梦', processes: ['jimeng.exe'], windowKeywords: ['即梦', 'Jimeng'] },
  { id: 'suno', name: 'Suno', processes: ['suno.exe'], windowKeywords: ['Suno'] },
];

/**
 * 窗口标题排除后缀（v1.4.1 误报收紧，常量数组可扩）：
 * 标题带这些后缀说明窗口属于编辑器/浏览器，里面的 "Codex"/"Claude" 只是
 * 文件名或网页标签，不是 AI 软件本体 —— 窗口通道整条不算命中。
 * 全部小写比较，匹配子串（不限定在结尾，覆盖 "xxx - Visual Studio Code" 这类）。
 */
const EXCLUDE_SUFFIXES = [
  'visual studio code',
  'google chrome', // 真实 Chrome 标题后缀是 " - Google Chrome"
  'microsoft edge',
  'mozilla firefox',
  ' - chrome',
  ' - edge',
  ' - firefox',
  ' - opera',
  ' - brave',
];

/**
 * 窗口关键词可信度（v1.4.1 误报收紧）：
 * 短拉丁词（≤6 字符，如 Codex/Claude/Kimi/abu）在窗口标题里误报面太大
 * （编辑器文件名、浏览器标签页都可能含），只允许走进程通道；
 * 窗口通道只信 >6 字符的拉丁词或含中文的词（中文误报率天然低）。
 */
function isWindowKeywordTrusted(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return false;
  if (/[\u4e00-\u9fff]/.test(kw)) return true; // 含中文：可信
  return kw.length > 6; // 纯拉丁：>6 字符才可信
}

/**
 * 单条特征是否命中。
 * 进程命中 = 任一 exe 名在进程表里（主通道，可靠）。
 * 窗口命中 = 任一【可信】关键词出现在任一【非排除】窗口标题里（第二通道）。
 *
 * @param {object} sig 特征条目
 * @param {Set<string>} procNames 小写 exe 名集合
 * @param {string[]} windowTitles 窗口标题数组（原样，匹配时统一转小写）
 */
function signatureMatches(sig, procNames, windowTitles) {
  if (Array.isArray(sig.processes)) {
    for (const p of sig.processes) {
      if (procNames.has(String(p).toLowerCase())) return true;
    }
  }
  if (Array.isArray(sig.windowKeywords) && Array.isArray(windowTitles)) {
    const kws = sig.windowKeywords
      .filter(isWindowKeywordTrusted)
      .map((k) => String(k).toLowerCase());
    if (kws.length > 0) {
      for (const title of windowTitles) {
        const t = String(title || '').toLowerCase();
        if (!t) continue;
        // 编辑器/浏览器窗口整条排除：里面的关键词只是文件名/网页标签
        if (EXCLUDE_SUFFIXES.some((suf) => t.includes(suf))) continue;
        for (const k of kws) {
          if (t.includes(k)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * 从特征库里挑出「命中环境但还没上灯」的新发现。
 *
 * @param {object} input
 * @param {Set<string>} input.procNames 当前进程表（小写 exe 名）
 * @param {string[]} input.windowTitles 当前窗口标题清单
 * @param {Set<string>} input.existingIds 已有 agent id + 已配 watcher 的 agent id
 * @param {string[]} input.blacklist 被用户删除过、永不自动加回的 id
 * @param {Array} [input.signatures] 特征库（测试可注入，默认出厂库）
 * @returns {Array<{id, name, process, windowKeywords}>} 可直接入灯的候选
 *   （process 取第一个命中的进程名，无进程命中时取 processes[0] 占位——
 *   纯窗口命中的条目多数也猜得到 exe；猜错则由用户删除 + blacklist 兜底）
 */
function findNewDiscoveries({ procNames, windowTitles, existingIds, blacklist, signatures }) {
  const sigs = Array.isArray(signatures) ? signatures : AI_SIGNATURES;
  const procs = procNames instanceof Set ? procNames : new Set();
  const titles = Array.isArray(windowTitles) ? windowTitles : [];
  const existing = existingIds instanceof Set ? existingIds : new Set();
  const banned = new Set(Array.isArray(blacklist) ? blacklist : []);
  const out = [];
  for (const sig of sigs) {
    if (!sig || !sig.id) continue;
    if (existing.has(sig.id) || banned.has(sig.id)) continue;
    if (!signatureMatches(sig, procs, titles)) continue;
    const procsArr = Array.isArray(sig.processes) ? sig.processes : [];
    const hitProc =
      procsArr.find((p) => procs.has(String(p).toLowerCase())) || procsArr[0] || '';
    out.push({
      id: sig.id,
      name: sig.name || sig.id,
      process: String(hitProc),
      windowKeywords: Array.isArray(sig.windowKeywords) ? sig.windowKeywords.slice() : [],
    });
    // 同一次扫描里不重复产出（特征库理论上 id 唯一，防御性）
    existing.add(sig.id);
  }
  return out;
}

module.exports = {
  AI_SIGNATURES,
  EXCLUDE_SUFFIXES,
  isWindowKeywordTrusted,
  signatureMatches,
  findNewDiscoveries,
};
