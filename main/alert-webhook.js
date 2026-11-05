'use strict';

/**
 * main/alert-webhook.js — assist/stuck 自动 webhook 电话告警（v1.5.1）。
 *
 * 场景：灯检测到某 AI 变紫（assist，需要人工）或变红（stuck，卡死）时，
 * 自动 POST 到用户配置的 webhook（老吴的本机「AI来电提醒」服务
 * 127.0.0.1:3001/alert → 微信留底 + 电话通知）。开源默认关闭，URL/key
 * 出厂为空，不配 = 完全无动作。
 *
 * 触发规则（边沿触发，不是电平触发）：
 *   - 仅当 prev 不是 assist/stuck 且 next 是 assist/stuck 时触发 ——
 *     持续 assist 不刷屏；ack 后再 assist 算新边沿，会再报一次
 *   - 同 agent + 同 status 60 秒冷却（防抖：上报脚本抖动/网络重试）
 *
 * payload 字段与 D:\AI来电提醒\server\index.js 的 POST /alert 端点逐字段
 * 对齐（key / notifyType / title / message / project / source），
 * 老吴的 3001 服务零改动可用。title 和 message 的第一位都是
 * 【agent显示名】—— 铁律：接电话时一眼分清哪个 AI 在呼叫。
 *
 * 本模块 electron-free：fetch/now/log 全部可注入，node 直接单测。
 * main.js 用默认实例（全局 cooldown 表）；测试用 createAlerter 起独立实例。
 */

/** 同 agent+status 冷却窗口。 */
const COOLDOWN_MS = 60_000;

/** POST 超时（ AbortController ）。webhook 是本机服务，5 秒绰绰有余。 */
const FIRE_TIMEOUT_MS = 5_000;

/**
 * 构造一个告警器实例。
 * @param {object} deps
 * @param {typeof fetch} [deps.fetchImpl] 默认全局 fetch（Node 18+）
 * @param {() => number} [deps.nowImpl] 默认 Date.now
 * @param {(msg: string) => void} [deps.logImpl] 默认 console.warn
 */
function createAlerter({ fetchImpl, nowImpl, logImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const now = nowImpl || (() => Date.now());
  const log = logImpl || ((m) => console.warn(`[status-light] ${m}`));
  /** @type {Map<string, number>} agentId:status -> 上次触发时间戳 */
  const lastFired = new Map();

  /**
   * 组装与 /alert 端点对齐的 payload。
   * @param {string} name agent 显示名
   * @param {'assist'|'stuck'} status
   * @param {string} task 当前任务（可空）
   * @param {object} cfg {url, key}
   */
  function buildPayload(name, status, task, cfg) {
    const kind = status === 'assist' ? 'AI 求助' : 'AI 卡死';
    const summary = typeof task === 'string' && task.trim() ? task.trim().slice(0, 200) : kind;
    return {
      key: typeof cfg.key === 'string' ? cfg.key : '',
      notifyType: 'assist', // 对端枚举：assist=微信+电话兜底（business 是生意提醒，不用）
      title: `【${name}】${kind}`,
      message: `【${name}】${summary}`,
      project: name,
      source: 'AI状态灯',
    };
  }

  /**
   * 边沿触发判定 + 触发。
   * @param {string} agentId
   * @param {string} prevStatus 变化前状态
   * @param {string} nextStatus 变化后状态
   * @param {string} task 当前任务描述
   * @param {object} cfg config.alertWebhook：{enabled,url,key,onAssist,onStuck}
   * @param {string} [agentName] 显示名（缺省用 id）
   * @returns {boolean} true = 本次触发了 webhook（异步发出，不代表对端收到）
   */
  function maybeAlert(agentId, prevStatus, nextStatus, task, cfg, agentName) {
    if (!cfg || cfg.enabled !== true) return false;
    if (typeof cfg.url !== 'string' || !/^https?:\/\//i.test(cfg.url)) return false;
    if (nextStatus !== 'assist' && nextStatus !== 'stuck') return false;
    // 类别开关：assist/stuck 可各自关闭
    if (nextStatus === 'assist' && cfg.onAssist === false) return false;
    if (nextStatus === 'stuck' && cfg.onStuck === false) return false;
    // 边沿：prev 已是 assist/stuck = 持续状态，不是新事件
    if (prevStatus === 'assist' || prevStatus === 'stuck') return false;
    const coolKey = `${agentId}:${nextStatus}`;
    const t = now();
    const last = lastFired.get(coolKey);
    if (Number.isFinite(last) && t - last < COOLDOWN_MS) return false;
    // 先记时间戳再发：即使发送失败也进冷却，绝不对电话通道刷屏重试
    lastFired.set(coolKey, t);
    fireAlert(agentName || agentId, nextStatus, task, cfg);
    return true;
  }

  /**
   * 发 POST（fire-and-forget）：5 秒超时，永不抛异常，失败只记日志。
   * @returns {Promise<void>}
   */
  function fireAlert(name, status, task, cfg) {
    const payload = buildPayload(name, status, task, cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FIRE_TIMEOUT_MS);
    // 同步调用 fetchImpl：调用方（测试 mock / 真实 fetch）的入参副作用
    // 立即发生；同步抛错也统一收进 catch，永不外抛。
    let sent;
    try {
      sent = Promise.resolve(
        fetchFn(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
      );
    } catch (err) {
      sent = Promise.reject(err);
    }
    return sent
      .then((res) => {
        if (!res || !res.ok) {
          log(`alert webhook responded ${res ? res.status : '?'} for ${name}/${status}`);
        }
      })
      .catch((err) => {
        log(`alert webhook failed for ${name}/${status}: ${err && err.message}`);
      })
      .finally(() => clearTimeout(timer));
  }

  /** 清空冷却表（测试用；生产不调用）。 */
  function resetCooldowns() {
    lastFired.clear();
  }

  return { maybeAlert, fireAlert, buildPayload, resetCooldowns };
}

// 默认实例：main.js 直接用（全局冷却表跨调用共享，正是防抖所需）。
const defaultAlerter = createAlerter();

module.exports = {
  COOLDOWN_MS,
  FIRE_TIMEOUT_MS,
  createAlerter,
  maybeAlert: defaultAlerter.maybeAlert,
  fireAlert: defaultAlerter.fireAlert,
  buildPayload: defaultAlerter.buildPayload,
};
