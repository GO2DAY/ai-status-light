'use strict';

/**
 * main/remote-config.js — 作者配置中心（v1.6.0 功能三，本单核心）。
 *
 * 远程下发「作者联系方式 / 支持链接 / 宣传位 / 公告 / 预选库更新」，
 * 日后改联系邮箱、换宣传文案只改仓库里的 author-config.json，
 * 不用发新版——这正是本功能的意义。
 *
 * 拉取策略：
 *   - 启动 10 秒后首拉 + 每 6 小时轮询
 *   - 多 URL 候选按序尝试：① jsDelivr CDN（部分地区可达性好）② GitHub raw
 *   - 成功 → 缓存到 userData/author-config-cache.json
 *   - 失败 → 用缓存；无缓存 → 内置默认值。离线静默降级，永不弹错
 *   - 超时 8 秒；只 GET，不带任何用户数据
 *
 * 本模块纯 Node、electron-free（主进程专用，渲染端不 import，
 * 所以不需要 UMD 双通道；设置面板经 settingsPanel:get 间接读有效值）。
 * fetch/cache/log 全部可注入，node 直接单测。
 */

const fs = require('fs');
const path = require('path');

/** 拉取候选 URL（按序尝试）。GO2DAY 发布前统一替换。 */
const AUTHOR_CONFIG_URLS = [
  'https://cdn.jsdelivr.net/gh/GO2DAY/ai-status-light@main/author-config.json',
  'https://raw.githubusercontent.com/GO2DAY/ai-status-light/main/author-config.json',
];

/** 内置默认值：无网/无缓存时的兜底（与仓库根 author-config.json 一致）。 */
const DEFAULT_AUTHOR_CONFIG = {
  version: 1,
  presetsUpdatedAt: '2026-10-20',
  contactEmail: 'author@example.com', // 占位：真实邮箱日后只改远程 JSON
  kofiUrl: 'https://ko-fi.com/go2day',
  afdianUrl: '',
  promo: { enabled: false, text: '', textEn: '', url: '' },
  notice: null,
};

const FETCH_TIMEOUT_MS = 8_000;
const FIRST_FETCH_DELAY_MS = 10_000;
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/**
 * 校验并清洗一份远程配置：只认白名单字段，坏字段丢回默认。
 * @param {*} raw JSON.parse 出来的任意值
 * @returns {object|null} 合法配置对象；不是对象直接 null
 */
function validateAuthorConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = DEFAULT_AUTHOR_CONFIG;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max || 300) : '');
  const promoRaw = raw.promo && typeof raw.promo === 'object' ? raw.promo : {};
  const out = {
    version: Number.isFinite(raw.version) ? raw.version : d.version,
    presetsUpdatedAt: str(raw.presetsUpdatedAt, 40) || d.presetsUpdatedAt,
    contactEmail: str(raw.contactEmail, 120) || d.contactEmail,
    kofiUrl: /^https:\/\//i.test(str(raw.kofiUrl)) ? str(raw.kofiUrl) : d.kofiUrl,
    afdianUrl: /^https:\/\//i.test(str(raw.afdianUrl)) ? str(raw.afdianUrl) : '',
    promo: {
      enabled: promoRaw.enabled === true,
      text: str(promoRaw.text, 200),
      textEn: str(promoRaw.textEn, 200),
      url: /^https:\/\//i.test(str(promoRaw.url)) ? str(promoRaw.url) : '',
    },
    notice: null,
  };
  if (raw.notice && typeof raw.notice === 'object') {
    out.notice = {
      text: str(raw.notice.text, 200),
      textEn: str(raw.notice.textEn, 200),
      url: /^https:\/\//i.test(str(raw.notice.url)) ? str(raw.notice.url) : '',
    };
  }
  // 远程预选库：原样透传（结构校验归 ai-presets.validatePresets，
  // 这边不越权；坏数据在 pickPresets 处自然回退内置）
  if (Array.isArray(raw.presets)) out.presets = raw.presets;
  return out;
}

/**
 * 按候选顺序拉取：第一个拿到合法 JSON 的 URL 胜出。
 * @param {string[]} urls
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ok: true, data: object, source: string} | {ok: false}>}
 *   永不 reject —— 失败/超时/坏 JSON 一律 {ok:false}
 */
async function fetchWithFallback(urls, fetchImpl) {
  const list = Array.isArray(urls) && urls.length ? urls : AUTHOR_CONFIG_URLS;
  for (const url of list) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res || !res.ok) continue;
      const text = await res.text();
      const parsed = JSON.parse(text);
      const cleaned = validateAuthorConfig(parsed);
      if (cleaned) return { ok: true, data: cleaned, source: url };
      // 合法 JSON 但不是对象 → 尝试下一个
    } catch {
      // 网络失败/超时/坏 JSON：静默，尝试下一个候选
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false };
}

/** 读缓存（坏文件 = 无缓存）。 */
function loadCache(cachePath) {
  try {
    const cleaned = validateAuthorConfig(JSON.parse(fs.readFileSync(cachePath, 'utf-8')));
    return cleaned;
  } catch {
    return null;
  }
}

/** 写缓存（失败静默：缓存只是优化，不是正确性依赖）。 */
function saveCache(cachePath, data) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 有效配置取舍：新鲜拉取 > 磁盘缓存 > 内置默认。
 * @returns {object} 永远返回一份可用配置
 */
function resolveEffective(fresh, cached) {
  if (fresh) return fresh;
  if (cached) return cached;
  return validateAuthorConfig(DEFAULT_AUTHOR_CONFIG);
}

/**
 * 电话告警引流位显示判定（功能六）：webhook URL 为空才显示。
 * @param {string} url alertWebhook.url
 */
function shouldShowAlertPromo(url) {
  return typeof url !== 'string' || url.trim() === '';
}

/**
 * 构造远程配置管理器（主进程用）。
 * @param {object} deps
 * @param {string} deps.cachePath userData/author-config-cache.json
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(msg: string) => void} [deps.logImpl]
 * @param {string[]} [deps.urls]
 */
function createRemoteConfig({ cachePath, fetchImpl, logImpl, urls } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const log = logImpl || ((m) => console.warn(`[status-light] ${m}`));
  let effective = resolveEffective(null, cachePath ? loadCache(cachePath) : null);
  let firstTimer = null;
  let pollTimer = null;

  async function refresh() {
    const res = await fetchWithFallback(urls, fetchFn);
    if (res.ok) {
      effective = res.data;
      if (cachePath) saveCache(cachePath, res.data);
      log(`author config refreshed from ${res.source} (version=${res.data.version})`);
    } else {
      // 静默降级：保持 effective（首拉失败时它已是缓存或内置默认）
      log('author config fetch failed on all URLs; using cache/builtin fallback');
    }
    return effective;
  }

  return {
    /** 启动首拉 + 轮询（幂等）。 */
    start() {
      if (firstTimer || pollTimer) return;
      firstTimer = setTimeout(() => {
        refresh().catch(() => {});
        pollTimer = setInterval(() => refresh().catch(() => {}), POLL_INTERVAL_MS);
        if (pollTimer.unref) pollTimer.unref();
      }, FIRST_FETCH_DELAY_MS);
      if (firstTimer.unref) firstTimer.unref();
    },
    stop() {
      if (firstTimer) clearTimeout(firstTimer);
      if (pollTimer) clearInterval(pollTimer);
      firstTimer = null;
      pollTimer = null;
    },
    /** 当前有效配置（同步读，渲染层经 settingsPanel:get 拿快照）。 */
    get() {
      return effective;
    },
    /** 立即拉一次（测试/调试用）。 */
    refresh,
  };
}

module.exports = {
  AUTHOR_CONFIG_URLS,
  DEFAULT_AUTHOR_CONFIG,
  FETCH_TIMEOUT_MS,
  FIRST_FETCH_DELAY_MS,
  POLL_INTERVAL_MS,
  validateAuthorConfig,
  fetchWithFallback,
  loadCache,
  saveCache,
  resolveEffective,
  shouldShowAlertPromo,
  createRemoteConfig,
};
