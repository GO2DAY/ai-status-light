'use strict';

/**
 * report-status.js - example status reporter for AI Status Light.
 *
 * Usage (Node 18+):
 *   node report-status.js <agent> <status> [task...]
 *   node report-status.js kimi running 正在生成周报
 *   node report-status.js kimi stuck 需要人工确认 API key
 *   node report-status.js kimi assist 已打电话通知老吴，等人工处理
 *   node report-status.js kimi idle
 *   node report-status.js kimi offline
 *
 * status: running | idle | stuck | assist | offline
 */

const ENDPOINT = 'http://127.0.0.1:17890/status';
const VALID = ['running', 'idle', 'stuck', 'assist', 'offline'];

async function main() {
  const [agent, status, ...taskParts] = process.argv.slice(2);
  if (!agent || !VALID.includes(status)) {
    console.error('Usage: node report-status.js <agent> <running|idle|stuck|assist|offline> [task...]');
    process.exit(1);
  }
  const task = taskParts.join(' ');

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, status, task }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      console.error(`Report rejected (${res.status}):`, body.error || body);
      process.exit(1);
    }
    console.log(`OK: ${agent} -> ${status}${task ? ` (${task})` : ''}`);
  } catch (err) {
    console.error(`Cannot reach AI Status Light at ${ENDPOINT}: ${err.message}`);
    process.exit(1);
  }
}

main();
