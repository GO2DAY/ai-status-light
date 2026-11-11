'use strict';

/**
 * main/mqtt-bridge.js — 云端状态上报桥（路线 A：公共 MQTT broker 做中转）
 *
 * 解决的问题：云电脑（Ubuntu Linux）上的 AI 与本地红绿灯隔着互联网，
 * 本地 HTTP 服务只听 127.0.0.1，云 AI 够不着。公共 MQTT broker
 * （broker.emqx.io）充当现成的"云端中转站"：
 *
 *   云AI(Ubuntu) --mosquitto_pub--> broker.emqx.io --订阅--> 本模块 --> applyReport
 *
 * 设计要点：
 *   - 出站连接（MQTT over TLS），家用无公网 IP 也能用，无需端口映射
 *   - 消息体验证后直接喂给 main.js 的 applyReport —— sticky 保护、状态机、
 *     灯色规则与本机 HTTP 上报完全一致，一份逻辑两处复用
 *   - QoS0 无留存：灯离线期间的消息直接丢弃（状态类消息本来就没有补发价值，
 *     云 AI 下一次心跳自然会把状态刷正）
 *   - 断线指数退避重连（5s -> 5min 封顶），连续失败写 error.log（不刷屏）
 *   - 总开关：config.json "cloudRelay": false 可整条关闭
 *
 * 安全说明：broker 是公共服务，主题名即凭据（每台机器随机生成，见
 * config.json 的 mqttTopic，设置面板可重新生成）。主题泄露的后果 =
 * 别人能伪造灯的状态显示，不能触碰本机任何文件。换自托管 broker 时改
 * BROKER_URL 即可，消息格式不变。
 */

const mqtt = require('mqtt');

// v1.5.0 脱敏：主题前缀不再硬编码，改为每台机器随机生成、存 config.json
// （顶层 mqttTopic，形如 asl/<12 位随机字符>），由 main.js 经 getTopicBase
// 回调传入；本模块负责三个派生主题："<base>/status"（订阅上报）、
// "<base>/state"（发布快照，QoS0 + retain）、"<base>/cmd"（订阅远程指令，
// v1.7.0 rev5：手机端「灯管理」的 remove-agent 指令；add-agent 直接走
// status 报文即可建档，无需专用指令）。
// 主题名即凭据：泄露的后果 = 别人能伪造灯的状态显示，不能触碰本机任何文件。
const BROKER_URL = 'mqtts://broker.emqx.io:8883';

/** getTopicBase 缺省/异常时的兜底前缀（独立测试、demo 场景用）。 */
const DEFAULT_TOPIC_BASE = 'asl/demo00000000';

/**
 * 规范化 broker 地址（v1.6.0 功能四：broker 可配置）。
 * 空/非法值回退公共默认；接受 mqtt:// mqtts:// ws:// wss://
 * 四族前缀（mqtt 库都支持）。设置面板可换自托管 broker。
 * @param {*} url 配置值（configExtra.mqttBroker）
 * @returns {string} 可直连的 broker URL
 */
function normalizeBrokerUrl(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  return /^(mqtts?|wss?):\/\//i.test(s) ? s : BROKER_URL;
}

/**
 * 由主题前缀派生两个业务主题。
 * @param {string} base 形如 "asl/abcdef123456"；非法值回退 DEFAULT_TOPIC_BASE
 * @returns {{statusTopic: string, stateTopic: string}}
 */
function buildTopics(base) {
  const cleaned = typeof base === 'string' ? base.trim().replace(/\/+$/, '') : '';
  const b = /^[a-z0-9]+\/[a-z0-9_-]+$/i.test(cleaned) ? cleaned : DEFAULT_TOPIC_BASE;
  return { statusTopic: `${b}/status`, stateTopic: `${b}/state`, cmdTopic: `${b}/cmd` };
}

const STATE_PUBLISH_THROTTLE_MS = 500; // 高频变化（多 agent 同秒上报）合并发一次

const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const FAIL_LOG_EVERY = 12; // 每 12 次连接失败写一次日志（约 1~10 分钟一条，看退避进度）

/**
 * 启动云端上报桥。
 * @param {(body: object) => void} onReport 收到合法状态消息时回调（main.js 传 applyReport）
 * @param {(msg: string) => void} log 错误日志（main.js 传 logError）
 * @param {() => boolean} isEnabled 总开关（读 config.json 的 cloudRelay 字段）
 * @param {() => string} [getTopicBase] 主题前缀回调（v1.5.0，读 config.json
 *   的 mqttTopic；每次 connect/publish 时现取，配置变更随重连/下次发布生效。
 *   缺省用 DEFAULT_TOPIC_BASE）
 * @param {() => string} [getBrokerUrl] broker 地址回调（v1.6.0，读
 *   config.json 的 mqttBroker；connect 时现取，改配置随重连生效。
 *   缺省/非法用 BROKER_URL 公共默认）
 * @param {(action: string, agentId: string) => void} [onCommand] 远程指令回调
 *   （v1.7.0 rev5，收到 "<base>/cmd" 主题消息时触发，main.js 传灯管理处理）
 */
function startMqttBridge(onReport, log, isEnabled, getTopicBase, getBrokerUrl, onCommand) {
  let client = null;
  let reconnectMs = RECONNECT_MIN_MS;
  let failCount = 0;
  let stopped = false;

  /** 当前生效的主题对（每次现算：设置面板重新生成主题后无缝跟上）。 */
  function currentTopics() {
    let base;
    try {
      base = typeof getTopicBase === 'function' ? getTopicBase() : undefined;
    } catch {
      base = undefined;
    }
    return buildTopics(base);
  }

  /** 当前生效的 broker 地址（每次 connect 现取：面板改配置随重连生效）。 */
  function currentBrokerUrl() {
    let url;
    try {
      url = typeof getBrokerUrl === 'function' ? getBrokerUrl() : undefined;
    } catch {
      url = undefined;
    }
    return normalizeBrokerUrl(url);
  }

  // ---- 状态快照发布（publishState）的运行时状态 ----
  let lastSnapshotJson = null; // 最近一次 publishState 收到的快照（无论是否已发出）
  let lastPublishedJson = null; // 最近一次真正发出的快照（去重依据）
  let lastPublishAt = 0;
  let throttleTimer = null;

  function doPublish(json) {
    if (stopped) return false;
    if (isEnabled && !isEnabled()) return false; // cloudRelay 关闭时发布一并停止
    if (!client || !client.connected) return false; // 未连上：等重连后的补发
    client.publish(currentTopics().stateTopic, json, { qos: 0, retain: true }, (err) => {
      if (err) log(`mqtt state publish failed: ${err.message}`);
    });
    lastPublishedJson = json;
    lastPublishAt = Date.now();
    return true;
  }

  function connect() {
    if (stopped) return;
    if (isEnabled && !isEnabled()) {
      // 开关关闭：每 30 秒复查一次（配置热生效，不用重启灯）
      setTimeout(connect, 30000);
      return;
    }
    try {
      client = mqtt.connect(currentBrokerUrl(), {
        clientId: `asl-light-${Math.random().toString(16).slice(2, 10)}`,
        clean: true,
        connectTimeout: 10000,
        reconnectPeriod: 0, // 自己管退避，不用库自带的固定间隔
      });
    } catch (err) {
      scheduleRetry(`connect threw: ${err && err.message}`);
      return;
    }

    client.on('connect', () => {
      reconnectMs = RECONNECT_MIN_MS;
      failCount = 0;
      const { statusTopic, cmdTopic } = currentTopics();
      console.log(`[status-light] mqtt bridge connected, subscribing ${statusTopic} + ${cmdTopic}`);
      client.subscribe(statusTopic, { qos: 0 }, (err) => {
        if (err) log(`mqtt subscribe failed: ${err.message}`);
      });
      // v1.7.0 rev5：手机端「灯管理」远程指令主题（remove-agent）
      client.subscribe(cmdTopic, { qos: 0 }, (err) => {
        if (err) log(`mqtt cmd subscribe failed: ${err.message}`);
      });
      // 断线重连成功：补发一次最新快照（retain 兜底冷启动订阅者，
      // 主动补发让当前在线的订阅者立刻对齐到最新灯态）。
      if (lastSnapshotJson) doPublish(lastSnapshotJson);
    });

    client.on('message', (topic, payload) => {
      // cloudRelay 是整条云端中继通道的 kill-switch：发布侧在 doPublish 里
      // 拦截，接收侧必须在这里对称拦截 —— 开关关掉后云 AI 的消息绝不允许
      // 再进 applyReport 改变灯状态（cmd 指令同样拦截）。
      if (isEnabled && !isEnabled()) return;
      let body;
      try {
        body = JSON.parse(payload.toString('utf-8'));
      } catch {
        return; // 垃圾消息直接丢
      }
      // v1.7.0 rev5：远程指令主题（手机端灯管理）。目前仅支持 remove-agent；
      // add-agent 不需要指令——直接向 status 主题发一条 offline 报文即可建档。
      const { cmdTopic } = currentTopics();
      if (topic === cmdTopic) {
        if (typeof onCommand !== 'function') return;
        const agentId = typeof body.agent === 'string' ? body.agent.trim() : '';
        if (body.action === 'remove-agent' && agentId) {
          try {
            onCommand('remove-agent', agentId);
          } catch (err) {
            log(`mqtt cmd apply failed: ${err && err.message}`);
          }
        }
        return;
      }
      try {
        onReport(body); // applyReport 内部有完整字段校验
      } catch (err) {
        log(`mqtt report apply failed: ${err && err.message}`);
      }
    });

    client.on('error', (err) => {
      // error 之后必跟 close，重连逻辑统一放 close 里
      failCount += 1;
      if (failCount === 1 || failCount % FAIL_LOG_EVERY === 0) {
        log(`mqtt bridge error x${failCount}: ${err && err.message}`);
      }
    });

    client.on('close', () => {
      if (client) {
        try { client.end(true); } catch { /* ignore */ }
        client = null;
      }
      scheduleRetry('connection closed');
    });
  }

  function scheduleRetry(reason) {
    if (stopped) return;
    console.warn(`[status-light] mqtt bridge retry in ${Math.round(reconnectMs / 1000)}s (${reason})`);
    setTimeout(() => {
      reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
      connect();
    }, reconnectMs);
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      if (client) {
        try { client.end(true); } catch { /* ignore */ }
        client = null;
      }
    },

    /**
     * 发布全量状态快照到 STATE_TOPIC（QoS0 + retain）。
     * main.js 在任何灯态变化后调用（broadcastState 是唯一收口点）。
     * @param {Array<object>} snapshot serializeAgents() 的输出
     *   [{id, name, status, auto, task, lastHeartbeat}]
     *
     * 行为：
     *  - 去重：与上次真正发出的快照 JSON 相同则跳过（5s 心跳 tick 会反复
     *    调进来，灯没变就一条都不发）
     *  - 节流：距上次发出 <500ms 时挂一个 trailing 定时器，合并发最新一份
     *  - 未连接/开关关闭时不发，但记住最新快照，重连成功后补发
     */
    publishState(snapshot) {
      if (stopped) return;
      let json;
      try {
        json = JSON.stringify(snapshot);
      } catch {
        return; // 循环引用等极端情况：灯本身照常，只是这次不上云
      }
      lastSnapshotJson = json;
      if (json === lastPublishedJson) return;
      const elapsed = Date.now() - lastPublishAt;
      if (elapsed >= STATE_PUBLISH_THROTTLE_MS) {
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        doPublish(json);
      } else if (!throttleTimer) {
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          if (lastSnapshotJson && lastSnapshotJson !== lastPublishedJson) {
            doPublish(lastSnapshotJson);
          }
        }, STATE_PUBLISH_THROTTLE_MS - elapsed);
      }
    },
  };
}

module.exports = { startMqttBridge, BROKER_URL, buildTopics, normalizeBrokerUrl, DEFAULT_TOPIC_BASE, STATE_PUBLISH_THROTTLE_MS };
