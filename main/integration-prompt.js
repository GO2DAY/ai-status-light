/**
 * main/integration-prompt.js — AI 接入提示词生成器（v1.5.1）。
 *
 * 用户在设置面板一键复制提示词，发给任意 AI（写入其永久记忆/系统提示），
 * 之后该 AI 就会按协议主动上报灯状态 —— 不再需要人工配进程监视。
 *
 * 协议事实与 main.js / mqtt-bridge.js 源码严格对齐：
 *   - HTTP：POST 127.0.0.1:17890/status，VALID_STATUSES 五枚举，
 *     assist/stuck 粘住、解除需 force:true（main.js applyReport）
 *   - MQTT：broker.emqx.io，主题 <base>/status（buildTopics 派生），
 *     QoS0，消息体与 HTTP 版完全相同
 *
 * UMD 双通道赋值（v1.5.2 P0 修复，与 i18n.js 同模式）：module.exports 与
 * window 全局**同时**挂，绝不用 else —— 防 rollup commonjs 垫片环境漏挂
 * window.ASL_PROMPT。tests/umd-dual-env.test.js 专守此坑。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ASL_PROMPT = api;
  else if (root && typeof root === 'object') root.ASL_PROMPT = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const HTTP_ENDPOINT = 'http://127.0.0.1:17890/status';
  const MQTT_BROKER = 'mqtts://broker.emqx.io:8883';
  const MQTT_BROKER_WS = 'wss://broker.emqx.io:8084/mqtt'; // 网页端（WebSocket）

  /**
   * 本机 HTTP 上报提示词。
   * @param {string} lang 'zh-CN' | 'en-US'（其他值按 zh-CN）
   * @returns {string} 完整提示词正文（纯文本，可直接粘给 AI）
   */
  function buildHttpPrompt(lang) {
    if (lang === 'en-US') {
      return `[PERMANENT MEMORY: AI Status Light reporting protocol]
I run an "AI Status Light" app on this machine. Please proactively report your working status to it at the right moments:

1. How: POST ${HTTP_ENDPOINT} with header Content-Type: application/json
2. JSON body:
   {"agent":"your-english-id (1-24 chars, only a-z 0-9 _ -)","name":"your display name","status":"...","task":"one-line summary of what you are doing"}
3. "status" must be ONE of these 5 values:
   - running: you are generating a reply / executing a task (report when you start working)
   - idle: task finished, waiting for my input (report when done)
   - stuck: you are blocked and cannot proceed (e.g. repeated failures, errors)
   - assist: you need ME to do something manually (e.g. scan a QR code, confirm an action, provide info) — this triggers a purple light AND a phone alert, use sparingly!
   - offline: you are shutting down
4. Important rules:
   - assist and stuck are STICKY: when you recover and report running/idle again, you MUST add "force":true to clear them
   - If the connection is refused, the light app is not running — ignore it silently, do NOT retry, do NOT report an error
   - Keep "task" as a short one-line summary (it shows up in my detail panel)
Please write all of the above into your permanent memory and proactively report your status in every conversation from now on.`;
    }
    return `【永久记忆：AI 状态灯上报协议】
我在本机运行了一个「AI 状态灯」程序，请你（AI）在合适时机主动向它上报你的工作状态：

1. 上报方式：POST ${HTTP_ENDPOINT}，请求头 Content-Type: application/json
2. 请求体 JSON：
   {"agent":"你的英文ID（1-24位，仅限 a-z 0-9 _ -）","name":"你的显示名（可中文）","status":"状态","task":"一句话描述你正在做的事"}
3. status 只能是这 5 个值之一：
   - running：你正在生成回答/执行任务（开始干活时上报）
   - idle：任务完成，等待我输入（干完活时上报）
   - stuck：你卡住了、无法继续（如反复失败、遇到错误）
   - assist：你需要我人工处理（如扫码登录、确认操作、补充信息）——这会触发紫灯和电话告警，慎用！
   - offline：你要退出了
4. 重要规则：
   - assist 和 stuck 是「粘住」状态：恢复后再次上报 running/idle 时必须额外带 "force":true 才能解除
   - 连接被拒绝说明状态灯没开，直接忽略，不要重试、不要报错
   - task 写你当前任务的一句话摘要（会显示在我的详情面板里）
请把以上内容写入你的永久记忆，之后每次对话都按此协议主动上报。`;
  }

  /**
   * 云端 MQTT 上报提示词（云电脑/服务器上的 AI 用）。
   * @param {string} topicBase 每台机器随机主题前缀（config.json mqttTopic，
   *   形如 asl/<12位>）；非法/空值时正文里留 "<你的主题码>" 占位提示
   * @param {string} lang 'zh-CN' | 'en-US'
   * @param {{tcp?: string, wss?: string}} [broker] 当前配置的 broker 地址
   *   （v1.6.0 功能四：broker 可配置，提示词必须写用户实际配的地址，
   *   缺省/非法回退公共默认 emqx）
   * @returns {string}
   */
  function buildMqttPrompt(topicBase, lang, broker) {
    const base = typeof topicBase === 'string' && /^asl\/[a-z0-9_-]{1,48}$/i.test(topicBase.trim())
      ? topicBase.trim()
      : null;
    const topic = base ? `${base}/status` : '<你的主题码>/status';
    const pick = (v, dflt) =>
      typeof v === 'string' && /^(mqtts?|wss?):\/\//i.test(v.trim()) ? v.trim() : dflt;
    const tcp = broker ? pick(broker.tcp, MQTT_BROKER) : MQTT_BROKER;
    const wss = broker ? pick(broker.wss, MQTT_BROKER_WS) : MQTT_BROKER_WS;
    if (lang === 'en-US') {
      return `[PERMANENT MEMORY: AI Status Light cloud reporting protocol (MQTT)]
I run an "AI Status Light" app on my own machine. Since you (AI) run on a cloud machine/server and cannot reach my localhost, report your status through the public MQTT broker instead:

1. Broker: ${tcp} (use ${wss} for web/JavaScript environments)
2. Publish topic: ${topic}   (QoS 0, no retain)
3. JSON message body — identical to the HTTP protocol:
   {"agent":"your-english-id (1-24 chars, only a-z 0-9 _ -)","name":"your display name","status":"...","task":"one-line summary"}
4. "status" must be ONE of: running (working) / idle (done, waiting) / stuck (blocked) / assist (need my manual action — triggers purple light AND phone alert, use sparingly!) / offline (shutting down)
5. Important rules:
   - assist and stuck are STICKY: to clear them when recovered, report running/idle with "force":true
   - If the broker is unreachable, ignore it silently — never block your own work on reporting
   - The topic code IS the credential: do NOT share it with anyone or paste it into public places
Please write all of the above into your permanent memory and proactively report your status in every conversation from now on.`;
    }
    return `【永久记忆：AI 状态灯云端上报协议（MQTT）】
我在自己的电脑上运行了一个「AI 状态灯」程序。你（AI）跑在云电脑/服务器上，够不到我的本机端口，请改用公共 MQTT 中转上报状态：

1. Broker 地址：${tcp}（网页/JS 环境用 ${wss}）
2. 发布主题：${topic}（QoS 0，不 retain）
3. 消息体 JSON —— 与本机 HTTP 协议完全相同：
   {"agent":"你的英文ID（1-24位，仅限 a-z 0-9 _ -）","name":"你的显示名（可中文）","status":"状态","task":"一句话任务描述"}
4. status 只能是这 5 个值之一：running（正在干活）/ idle（干完待命）/ stuck（卡住无法继续）/ assist（需要我人工处理——触发紫灯和电话告警，慎用！）/ offline（退出）
5. 重要规则：
   - assist 和 stuck 是「粘住」状态：恢复后再次上报 running/idle 时必须额外带 "force":true 才能解除
   - broker 连不上就直接忽略，不要因为上报阻塞你自己的工作
   - 主题码就是凭据：不要外传，不要贴到公共场合
请把以上内容写入你的永久记忆，之后每次对话都按此协议主动上报。`;
  }

  return { HTTP_ENDPOINT, MQTT_BROKER, MQTT_BROKER_WS, buildHttpPrompt, buildMqttPrompt };
});
