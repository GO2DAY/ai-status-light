'use strict';

/**
 * main/settings-ops.js — 设置面板的纯逻辑层（不依赖 electron，可被 node 单测直接 require）。
 *
 * 为什么独立成模块：main.js 顶层 require('electron')，普通 node 进程无法加载，
 * 校验/生成逻辑就测不到。设置面板面对的是非程序员用户，输入容错是硬需求，
 * 所以「id 校验 / 重名检测 / watcher 归属校验 / 配置合并保留未知字段」全部
 * 收进这个纯函数模块，main.js 的 IPC 处理器和 tests/settings-ops.test.js
 * 共用同一份实现 —— 不存在"面板一套规则、主进程另一套规则"的漂移空间。
 */

/** 与 main.js / HTTP /status 完全一致：1-24 字符 a-z 0-9 _ -（大小写不敏感）。 */
const AGENT_ID_PATTERN = /^[a-z0-9_-]{1,24}$/i;

/** 与 main.js 的运行时上限一致，面板保存时同样设防。 */
const MAX_AGENTS = 32;

/** config.json 顶层由主进程结构化管理的键；其余键原样保留（前向兼容）。 */
const KNOWN_TOP_KEYS = new Set(['agents', 'settings', 'window', 'watchers']);

const MAX_NAME_LEN = 40;
const MAX_PROCESS_LEN = 128;
const MAX_WINDOW_KEYWORDS = 12;
const MAX_KEYWORD_LEN = 64;

/** 提示音音量档位（v1.4.0）。渲染层 App.jsx 有同名映射，改这里要同步改那边。 */
const SOUND_VOLUMES = ['low', 'medium', 'high'];

/** 界面语言设置值（v1.5.0）：auto=跟随系统；zh/en 为 zh-CN/en-US 的短别名。 */
const LANGUAGES = ['auto', 'zh-CN', 'en-US', 'zh', 'en'];

/** 规范化语言值：zh->zh-CN，en->en-US；非法返回 null。 */
function normalizeLanguage(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === 'auto' || s === 'zh-CN' || s === 'en-US') return s;
  if (s === 'zh') return 'zh-CN';
  if (s === 'en') return 'en-US';
  return null;
}

/**
 * 从名称生成候选 id：小写、空白转 '-'、剥掉非法字符。
 * 中文等非 ASCII 字符会被剥掉（无拼音库可用），剥空时返回 ''，
 * 由 uniqueAgentId 兜底成 agent-N。
 */
function slugifyName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 24);
}

/**
 * 在 taken（已有 id 集合）内为 base 找一个不冲突的 id：
 * base 为空 -> agent-N；base 冲突 -> base-2 / base-3 …（总长仍 ≤24）。
 */
function uniqueAgentId(base, taken) {
  const stem = (base || 'agent').slice(0, 24);
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${stem.slice(0, 24 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null; // 理论不可达，防御性返回
}

/**
 * 校验并规范化设置面板的整包提交。
 *
 * @param {object} payload 面板提交的原始数据：
 *   {
 *     agents:   [{ id?, name }],              // id 可空 -> 从名称生成
 *     watchers: [{ agent, process, task?, window? }],  // process 空串 = 未配置
 *     soundOn, cloudRelay, screenWatch, openAtLogin    // 布尔，缺省 true/true/true/true
 *   }
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 *   value = {
 *     agents:   [{ id, name }],               // id 已规范化、唯一
 *     watchers: [{ agent, process, task, window? }],   // 已按 agent 去重、剔除空 process
 *     soundOn, cloudRelay, screenWatch, openAtLogin
 *   }
 */
function validateSettingsPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: '提交内容为空', key: 'err.payloadEmpty' };
  }

  // ---- agents ----
  if (!Array.isArray(payload.agents)) {
    return { ok: false, error: 'agents 必须是数组', key: 'err.agentsNotArray' };
  }
  if (payload.agents.length > MAX_AGENTS) {
    return { ok: false, error: `AI 数量超过上限 ${MAX_AGENTS}`, key: 'err.tooManyAgents', params: { n: MAX_AGENTS } };
  }
  const agents = [];
  const taken = new Set();
  for (const entry of payload.agents) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: '存在无效的 AI 条目', key: 'err.invalidAgentEntry' };
    }
    const name = String(entry.name || '').trim();
    if (!name) {
      return { ok: false, error: 'AI 名称不能为空', key: 'err.nameEmpty' };
    }
    if (name.length > MAX_NAME_LEN) {
      return { ok: false, error: `名称「${name.slice(0, 12)}…」超过 ${MAX_NAME_LEN} 字符`, key: 'err.nameTooLong', params: { name: name.slice(0, 12), n: MAX_NAME_LEN } };
    }
    let id = String(entry.id || '').trim().toLowerCase();
    if (id) {
      if (!AGENT_ID_PATTERN.test(id)) {
        return { ok: false, error: `id「${id}」不合法（1-24 字符：a-z 0-9 _ -）`, key: 'err.idInvalid', params: { id } };
      }
      if (taken.has(id)) {
        return { ok: false, error: `id「${id}」重复`, key: 'err.idDup', params: { id } };
      }
    } else {
      // 面板允许留空：从名称生成，保证唯一。
      id = uniqueAgentId(slugifyName(name), taken);
      if (!id) {
        return { ok: false, error: `无法为「${name}」生成唯一 id`, key: 'err.idGenFail', params: { name } };
      }
    }
    taken.add(id);
    agents.push({ id, name });
  }

  // ---- watchers ----
  const rawWatchers = Array.isArray(payload.watchers) ? payload.watchers : [];
  const agentIds = new Set(agents.map((a) => a.id));
  const watchers = [];
  const watchedAgents = new Set();
  for (const w of rawWatchers) {
    if (!w || typeof w !== 'object') continue;
    let agent = String(w.agent || '').trim().toLowerCase();
    const proc = String(w.process || '').trim();
    if (!proc) continue; // 空进程名 = 未配置（仅接收上报），不落盘
    // 新增行 id 留空时面板传 agentName：id 已在上面生成，按名称解析回来。
    if (!agent && typeof w.agentName === 'string' && w.agentName.trim()) {
      const byName = agents.find((a) => a.name === w.agentName.trim());
      if (byName) agent = byName.id;
    }
    if (!agentIds.has(agent)) {
      return { ok: false, error: `监视配置的进程「${proc}」指向不存在的 AI「${agent || w.agentName || '?'}」`, key: 'err.watcherDangling', params: { proc, agent: agent || w.agentName || '?' } };
    }
    if (watchedAgents.has(agent)) continue; // 每个 agent 一条，首条优先
    if (proc.length > MAX_PROCESS_LEN) {
      return { ok: false, error: `进程名「${proc.slice(0, 16)}…」过长`, key: 'err.procTooLong', params: { proc: proc.slice(0, 16) } };
    }
    const entry = {
      agent,
      process: proc,
      task: typeof w.task === 'string' && w.task.trim() ? w.task.trim().slice(0, 60) : '桌面端在线',
    };
    // 窗口关键词：数组或逗号分隔字符串都接受，规范化成字符串数组。
    let kws = [];
    if (Array.isArray(w.window)) {
      kws = w.window;
    } else if (typeof w.window === 'string') {
      kws = w.window.split(/[,，]/);
    }
    kws = kws
      .map((k) => String(k).trim())
      .filter(Boolean)
      .slice(0, MAX_WINDOW_KEYWORDS)
      .map((k) => k.slice(0, MAX_KEYWORD_LEN));
    if (kws.length > 0) entry.window = kws;
    watchedAgents.add(agent);
    watchers.push(entry);
  }

  // ---- 开关 ----
  const boolOr = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  if (payload.soundVolume !== undefined && !SOUND_VOLUMES.includes(payload.soundVolume)) {
    return { ok: false, error: `音量档位「${payload.soundVolume}」不合法（low/medium/high）`, key: 'err.volumeInvalid', params: { v: payload.soundVolume } };
  }
  // v1.5.0 界面语言：auto/zh/en/zh-CN/en-US；显式传入非法值拒绝（防面板 bug 写坏配置）
  let language = 'auto';
  if (payload.language !== undefined) {
    const norm = normalizeLanguage(payload.language);
    if (!norm) {
      return { ok: false, error: `语言设置「${payload.language}」不合法（auto/zh/en）`, key: 'err.languageInvalid', params: { v: payload.language } };
    }
    language = norm;
  }
  // v1.5.1 电话告警 webhook：出厂关闭、URL/key 为空；URL 只允许 http(s)://
  let alertWebhook;
  if (payload.alertWebhook !== undefined) {
    const aw = payload.alertWebhook;
    if (!aw || typeof aw !== 'object') {
      return { ok: false, error: 'alertWebhook 必须是对象', key: 'err.alertWebhookInvalid' };
    }
    const url = typeof aw.url === 'string' ? aw.url.trim() : '';
    if (url && (!/^https?:\/\//i.test(url) || url.length > 500)) {
      return { ok: false, error: '告警 URL 不合法（须以 http:// 或 https:// 开头）', key: 'err.alertUrlInvalid' };
    }
    const key = typeof aw.key === 'string' ? aw.key : '';
    if (key.length > 200) {
      return { ok: false, error: '告警 Key 过长（≤200 字符）', key: 'err.alertKeyTooLong' };
    }
    alertWebhook = {
      enabled: typeof aw.enabled === 'boolean' ? aw.enabled : false,
      url,
      key,
      onAssist: typeof aw.onAssist === 'boolean' ? aw.onAssist : true,
      onStuck: typeof aw.onStuck === 'boolean' ? aw.onStuck : true,
    };
  }
  // v1.6.0 功能四：broker 可配置。空串 = 恢复默认（公共 emqx）；
  // 否则必须 mqtt(s):// 或 ws(s):// 前缀（mqtt 库四族都支持）。
  const BROKER_PREFIX = /^(mqtts?|wss?):\/\//i;
  let mqttBroker;
  if (payload.mqttBroker !== undefined) {
    const v = typeof payload.mqttBroker === 'string' ? payload.mqttBroker.trim() : '';
    if (v && (!BROKER_PREFIX.test(v) || v.length > 200)) {
      return { ok: false, error: 'Broker（TCP）地址不合法（须以 mqtt://、mqtts://、ws:// 或 wss:// 开头）', key: 'err.mqttBrokerInvalid' };
    }
    mqttBroker = v;
  }
  let mqttBrokerWss;
  if (payload.mqttBrokerWss !== undefined) {
    const v = typeof payload.mqttBrokerWss === 'string' ? payload.mqttBrokerWss.trim() : '';
    if (v && (!BROKER_PREFIX.test(v) || v.length > 200)) {
      return { ok: false, error: 'Broker（WebSocket）地址不合法（须以 mqtt://、mqtts://、ws:// 或 wss:// 开头）', key: 'err.mqttBrokerWssInvalid' };
    }
    mqttBrokerWss = v;
  }
  return {
    ok: true,
    value: {
      agents,
      watchers,
      soundOn: boolOr(payload.soundOn, true),
      soundVolume: SOUND_VOLUMES.includes(payload.soundVolume) ? payload.soundVolume : 'high',
      repeatAlert: boolOr(payload.repeatAlert, true),
      autoDiscover: boolOr(payload.autoDiscover, true),
      // v1.5.0 脱敏：云端中转出厂默认关闭（公共 broker 不应默认连）；
      // 面板始终显式传值，这里的缺省只兜老调用方/手动构造的 payload。
      cloudRelay: boolOr(payload.cloudRelay, false),
      screenWatch: boolOr(payload.screenWatch, true),
      openAtLogin: boolOr(payload.openAtLogin, true),
      language,
      // 面板总是显式回传；老调用方/手动构造的 payload 不带时保持 undefined，
      // main.js 据此跳过覆盖（configExtra 里的现存值不动）
      ...(alertWebhook ? { alertWebhook } : {}),
      // v1.6.0 broker 地址：面板总是显式回传；缺省保持 undefined 不覆盖
      ...(mqttBroker !== undefined ? { mqttBroker } : {}),
      ...(mqttBrokerWss !== undefined ? { mqttBrokerWss } : {}),
    },
  };
}

/**
 * 提取 config.json 顶层「非结构化」键（cloudRelay / screenWatch / fgWatch /
 * dbPoll / openAtLogin 及未来新增的任何开关），供写回时原样保留。
 *
 * 背景：writeConfigNow() 此前只写 agents/settings/window/watchers 四个键，
 * 每次拖动窗口触发的落盘都会把顶层开关悄悄冲掉。这里显式提取 + 显式合并，
 * 未知键永远不丢。
 */
function extractConfigExtras(raw) {
  const extras = {};
  if (!raw || typeof raw !== 'object') return extras;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_KEYS.has(key)) extras[key] = raw[key];
  }
  return extras;
}

/**
 * 组装写回 config.json 的完整 payload：extras 在前（保留未知顶层键），
 * 四个结构化键在后（永远以主进程内存状态为准，覆盖 extras 里的同名片段——
 * 虽然 extractConfigExtras 已排除它们，双保险）。
 */
function buildConfigPayload({ extras, agents, settings, window, watchers }) {
  return {
    ...(extras && typeof extras === 'object' ? extras : {}),
    agents: Array.isArray(agents) ? agents : [],
    settings: settings && typeof settings === 'object' ? settings : {},
    window: window && typeof window === 'object' ? window : { x: null, y: null },
    watchers: Array.isArray(watchers) ? watchers : [],
  };
}

/**
 * 设置面板保存时的删除豁免判定（v1.4.1 P1 修复）。
 * 场景：面板打开后（快照之后）自动发现新加了 agent，用户点保存时 payload
 * 里没有它 —— 这不是用户要删，而是"面板没看见"。豁免条件：该 agent 是
 * 自动发现的（origin==='auto'）且发现时间晚于面板快照时间。
 * snapshotAt 缺省/非法（老路径、手动构造的保存）按 0 处理 = 不豁免，
 * 行为与修复前完全一致。
 *
 * @param {object} agent 内存中的 agent 条目（可能含 origin/discoveredAt）
 * @param {number} snapshotAt 面板快照时间戳（ms）
 * @returns {boolean} true = 跳过删除（保留且不拉黑）
 */
function shouldSkipDeletion(agent, snapshotAt) {
  if (!agent || agent.origin !== 'auto') return false;
  if (!Number.isFinite(agent.discoveredAt)) return false;
  // snapshotAt 缺省/非法/0（老路径、手动构造的保存）= 不豁免，行为与修复前一致。
  // 注意不能拿 0 当比较基准——任何 discoveredAt>0 都会被误判成"快照后新增"。
  const snap = Number.isFinite(snapshotAt) ? snapshotAt : 0;
  if (snap <= 0) return false;
  return agent.discoveredAt > snap;
}

/** 拉黑（幂等）：返回新数组，不改动原数组。 */
function addToBlacklist(list, id) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (id && !arr.includes(id)) arr.push(id);
  return arr;
}

/** 解除拉黑：返回新数组，不改动原数组。 */
function removeFromBlacklist(list, id) {
  return (Array.isArray(list) ? list : []).filter((x) => x !== id);
}

/**
 * 豁免 agent 的 watcher 成对补回（v1.4.2 Bug 2 修复）。
 * settingsPanel:save 的 watchers 整体覆盖来自面板旧快照，不含「面板打开后
 * 自动发现并被豁免删除」的 agent 的 watcher —— 直接覆盖会让 agent 活着、
 * watcher 消失（死灯：进程不再被监测，灯永远停在 idle）。
 * 这里把内存中现存的、属于被豁免 agent 的 watcher 条目并入保存结果，
 * 保证「豁免 agent 与其 watcher 成对存活」。payload 里已有的同 agent
 * 条目不重复并入（以面板提交为准）。
 *
 * @param {Array} payloadWatchers 面板提交校验后的 watchers
 * @param {Array} currentWatchers 内存中现存的 watchersConfig
 * @param {Set<string>} sparedIds 本次保存被豁免删除的 agent id 集合
 * @returns {Array} 合并后的 watchers（新数组）
 */
function mergeSparedWatchers(payloadWatchers, currentWatchers, sparedIds) {
  const merged = Array.isArray(payloadWatchers) ? payloadWatchers.slice() : [];
  if (!(sparedIds instanceof Set) || sparedIds.size === 0) return merged;
  const payloadAgents = new Set(merged.map((w) => w && w.agent));
  for (const w of Array.isArray(currentWatchers) ? currentWatchers : []) {
    if (w && sparedIds.has(w.agent) && !payloadAgents.has(w.agent)) {
      merged.push(w);
      payloadAgents.add(w.agent);
    }
  }
  return merged;
}

module.exports = {
  AGENT_ID_PATTERN,
  MAX_AGENTS,
  KNOWN_TOP_KEYS,
  SOUND_VOLUMES,
  LANGUAGES,
  normalizeLanguage,
  shouldSkipDeletion,
  addToBlacklist,
  removeFromBlacklist,
  mergeSparedWatchers,
  slugifyName,
  uniqueAgentId,
  validateSettingsPayload,
  extractConfigExtras,
  buildConfigPayload,
};
