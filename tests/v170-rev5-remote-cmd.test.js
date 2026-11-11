'use strict';
/**
 * tests/v170-rev5-remote-cmd.test.js — v1.7.0 rev5 锚点锁
 * 手机端「灯管理」远程指令通道（AI哨兵 ↔ 电脑红绿灯）：
 *   - buildTopics 派生 <base>/cmd 主题
 *   - 桥连接时同时订阅 status + cmd
 *   - main.js 把指令回调接到 removeAgent（仅 remove-agent 放行）
 *   - cloudRelay 关闭时 cmd 指令同样被拦（kill-switch 对称性）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const bridge = read('main/mqtt-bridge.js');
const mainjs = read('main/main.js');

// buildTopics 必须派生 cmdTopic
assert.ok(/cmdTopic: `\$\{b\}\/cmd`/.test(bridge), 'buildTopics 缺 cmdTopic 派生');

// startMqttBridge 必须接收 onCommand 参数并转发
assert.ok(/function startMqttBridge\([^)]*onCommand\)/.test(bridge), 'startMqttBridge 缺 onCommand 形参');
assert.ok(/topic === cmdTopic/.test(bridge), '桥接收侧缺 cmd 主题路由');

// 指令只认 remove-agent，且必须带非空 agent id
assert.ok(/body\.action === 'remove-agent' && agentId/.test(bridge), 'cmd 指令缺 remove-agent 校验');
assert.ok(!/body\.action === 'add-agent'/.test(bridge), 'add-agent 必须走 status 报文，不得走 cmd 主题');

// cloudRelay kill-switch 必须在 cmd 路由之前拦截（对称性）
const msgHandler = bridge.slice(bridge.indexOf("client.on('message'"), bridge.indexOf('client.on(\'error\''));
assert.ok(/if \(isEnabled && !isEnabled\(\)\) return;/.test(msgHandler), 'cmd 路由缺 cloudRelay 拦截');
assert.ok(msgHandler.indexOf('isEnabled && !isEnabled()') < msgHandler.indexOf('topic === cmdTopic'), 'kill-switch 必须先于 cmd 路由执行');

// main.js：指令回调接到 removeAgent
assert.ok(/action === 'remove-agent'\) \{\s*\n\s*removeAgent\(agentId\)/.test(mainjs), 'main.js 未把 remove-agent 接到 removeAgent');

console.log('v170-rev5-remote-cmd: all anchors OK');
