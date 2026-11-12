'use strict';
/**
 * tests/v170-rev8-screen-guard.test.js — v1.7.0 rev8 WGC 画面通道泄漏止血。
 *
 * 实证根因（2026-11-12）：desktopCapturer 每 tick 对全部窗口重建 WGC capture
 * session，不可捕获窗口（资源管理器/受保护窗口）失败重试持续泄漏 Chromium
 * 资源 —— 两次 E_OUTOFMEMORY(0x8007000E) 崩溃（16.5h / 14min）。
 *
 * 防御三层（本闸口逐条锁死）：
 *   1. agent-watcher 画面通道 tick 降频 2s → 30s（SCREEN_TICK_MS，泄漏 -15x）；
 *   2. 目标窗口缩略图连续全空熔断（SCREEN_EMPTY_FUSE + 10min 试探恢复）；
 *   3. main.js 每日 04:05 自愈重启（app.relaunch + app.exit(0)）兜底。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('R1 画面通道 tick 周期降频为 30s（不再是 POLL_MS=2s）', () => {
  const aw = read('main/agent-watcher.js');
  assert.ok(/const SCREEN_TICK_MS = 30_000;/.test(aw), '缺 SCREEN_TICK_MS = 30_000 常量');
  assert.ok(/screenTimer = setInterval\(\(\) => \{[\s\S]*?}, SCREEN_TICK_MS\);/.test(aw),
    'screenTimer 未使用 SCREEN_TICK_MS（仍为 POLL_MS 每 2s 抓图，泄漏路径未封堵）');
});

test('R2 缩略图全空熔断：连续 N 次全空 → 停抓 10 分钟', () => {
  const aw = read('main/agent-watcher.js');
  assert.ok(/const SCREEN_EMPTY_FUSE = \d+;/.test(aw), '缺 SCREEN_EMPTY_FUSE 常量');
  const fuse = Number(aw.match(/const SCREEN_EMPTY_FUSE = (\d+);/)[1]);
  assert.ok(fuse >= 10 && fuse <= 120, `SCREEN_EMPTY_FUSE=${fuse} 不在合理区间 [10,120]`);
  assert.ok(/const SCREEN_FUSE_RETRY_MS = 10 \* 60_000;/.test(aw),
    '缺 SCREEN_FUSE_RETRY_MS（熔断后 10 分钟试探恢复）');
  // tickScreen 开头熔断短路
  assert.ok(/if \(screenFusedAt && Date\.now\(\) - screenFusedAt < SCREEN_FUSE_RETRY_MS\) return;/.test(aw),
    'tickScreen 缺熔断短路检查');
  // 熔断判定：matchedTotal>0 且 emptyTotal>=matchedTotal 时 streak++
  assert.ok(/if \(emptyTotal >= matchedTotal\) \{\s*\n\s*screenEmptyStreak\+\+;/.test(aw),
    '缺「全空 → streak++」熔断统计');
  assert.ok(/screenFusedAt = Date\.now\(\);/.test(aw), '缺熔断触发赋值');
  // 有正常帧时清零
  assert.ok(/else \{\s*\n\s*screenEmptyStreak = 0;\s*\n\s*\}/.test(aw),
    '缺正常帧 streak 清零');
  // 熔断/恢复走 console.log 显式留痕（排障可观测）
  assert.ok(/screen-watcher fuse:/.test(aw), '熔断缺日志留痕');
});

test('R3 main.js 每日 04:05 自愈重启兜底', () => {
  const main = read('main/main.js');
  assert.ok(/const DAILY_RESTART_AT = \{ h: 4, m: 5 \};/.test(main),
    '缺 DAILY_RESTART_AT 04:05 定义');
  assert.ok(/function scheduleDailySelfRestart\(\)/.test(main), '缺 scheduleDailySelfRestart');
  assert.ok(/app\.relaunch\(\);\s*\n\s*app\.exit\(0\);/.test(main),
    '自愈重启必须 app.relaunch + app.exit(0)（先排新进程再退，不留无灯空窗）');
  assert.ok(/scheduleDailySelfRestart\(\); \/\/ rev8/.test(main),
    'whenReady 未调用 scheduleDailySelfRestart');
  // 已过当日 04:05 排明天（防立即重启循环）
  assert.ok(/if \(at <= now\) at\.setDate\(at\.getDate\(\) \+ 1\);/.test(main),
    '缺「已过 04:05 排明天」守卫（立即重启循环风险）');
  // setTimeout 上限钳制（>24.8 天会溢出立即触发）
  assert.ok(/Math\.min\(at - now, 2 \*\* 31 - 1\)/.test(main), '缺 setTimeout 延迟上限钳制');
});

test('R4 止血不破坏既有画面通道语义（基线重置 / 重入保护仍在）', () => {
  const aw = read('main/agent-watcher.js');
  assert.ok(/if \(screenBusy || !screenWatchEnabled\) return;/.test(aw),
    '重入保护/配置开关被破坏');
  assert.ok(/首帧只建基线，不会误亮灯/.test(aw), '首帧建基线注释丢失（语义回归）');
  assert.ok(/screenBusy = false;\s*\n\s*\}\s*\n\}/.test(aw), 'finally 释放 screenBusy 被破坏');
});
