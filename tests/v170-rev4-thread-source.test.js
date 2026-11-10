'use strict';
/**
 * tests/v170-rev4-thread-source.test.js — v1.7.0 rev4 对话溯源（老吴需求）。
 *
 * 需求：上报状态时把「是哪个对话出的问题」讲清楚——
 *   1. POST /status / MQTT 上报接受可选 thread 字段（出问题的对话名）；
 *   2. serializeAgents 快照透传 thread（详情面板 / 电话告警 / 手机端共用）；
 *   3. 电话告警 webhook 消息附带对话名（thread 不在 task 里才附加，防重复）；
 *   4. 详情面板红/紫灯时高亮「出问题的对话」（thread > 活跃对话 > task）；
 *   5. i18n 双语 detail.problemDialog。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('R1 applyReport 接受 thread 字段并落库（500 上限内，200 上限）', () => {
  const main = read('main/main.js');
  assert.ok(/typeof body\.thread === 'string'\) agent\.thread = body\.thread\.slice\(0, 200\)/.test(main),
    'applyReport 缺 thread 字段接收（v1.7.0 rev4）');
});

test('R2 serializeAgents 快照透传 thread（条件展开，不带空值）', () => {
  const main = read('main/main.js');
  assert.ok(/\.\.\.\(a\.thread \? \{ thread: a\.thread \} : \{\}\),/.test(main),
    'serializeAgents 缺 thread 透传');
  assert.ok(/thread: a\.thread \} : \{\}\),\s*\n\s*lastHeartbeat: a\.lastHeartbeat,/.test(main),
    'thread 必须排在 task 与 lastHeartbeat 之间且不吞掉 lastHeartbeat');
});

test('R3 电话告警 webhook：thread 附带进消息且防重复', () => {
  const main = read('main/main.js');
  assert.ok(/const webhookTask =/.test(main), 'webhook 缺对话名合并逻辑');
  assert.ok(/!\(agent\.task \|\| ''\)\.includes\(agent\.thread\)/.test(main),
    'webhook 未做「thread 已在 task 中则不重复附加」防重');
  assert.ok(/（对话：\$\{agent\.thread\}）/.test(main), 'webhook 消息缺「（对话：…）」后缀');
});

test('R4 DetailPanel：红/紫灯高亮出问题的对话（thread > 活跃对话 > task）', () => {
  const src = read('src/components/DetailPanel.jsx');
  assert.ok(/data-testid="problem-dialog"/.test(src), '详情面板缺 problem-dialog 高亮锚点');
  assert.ok(/agent\.thread \|\| \(activeDialog && activeDialog\.title\) \|\| agent\.task \|\| ''/.test(src),
    '问题对话取值优先级必须是 thread > 活跃对话 > task');
  assert.ok(/agent\.status === 'assist'\s*\? 'bg-purple-500\/20 text-purple-200'\s*: 'bg-red-500\/20 text-red-200'/.test(src),
    '高亮条缺紫/红双配色');
  assert.ok(/const isAttention = agent\.status === 'stuck' \|\| agent\.status === 'assist';/.test(src),
    '高亮条必须只在 stuck/assist 出现');
});

test('R5 i18n：detail.problemDialog 中英双语齐备', () => {
  const i18n = read('main/i18n.js');
  assert.ok(/'detail\.problemDialog': '出问题的对话'/.test(i18n), '缺中文 problemDialog');
  assert.ok(/'detail\.problemDialog': 'Problem conversation'/.test(i18n), '缺英文 problemDialog');
});
