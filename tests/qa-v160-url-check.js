'use strict';
/**
 * tests/qa-v160-url-check.js — v1.6.0 预选库 32 条官网 URL 真实可达性检查（QA 独立工具）。
 * 逐条 GET（HEAD 被许多站点拒绝），跟随重定向，记录：HTTP 状态、最终落点域名、耗时。
 * 判定：2xx/301/302/307/308 = 可达；403 = 反爬但域名活着（人工复核）；其他 = 疑似死链。
 * 运行：node tests/qa-v160-url-check.js  （输出写 tests/qa-v160-url-results.txt）
 */
const fs = require('fs');
const path = require('path');
const { PRESET_GROUPS } = require('../main/ai-presets');

const items = [];
for (const g of PRESET_GROUPS) for (const it of g.items) items.push(it);

async function check(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,*/*;q=0.8',
      },
    });
    const finalUrl = res.url;
    return { status: res.status, finalUrl, finalHost: new URL(finalUrl).hostname };
  } catch (err) {
    return { status: 0, error: String((err && err.cause && err.cause.code) || (err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const lines = [];
  const t0 = Date.now();
  for (const it of items) {
    const r = await check(it.url);
    const origHost = new URL(it.url).hostname;
    const hop = r.finalHost && r.finalHost !== origHost ? ` -> ${r.finalHost}` : '';
    const verdict =
      r.status >= 200 && r.status < 400 ? 'OK' : r.status === 403 ? 'REVIEW(403)' : r.status === 0 ? 'FAIL' : 'REVIEW';
    const line = `${verdict}\t${it.id}\t${it.url}\t${r.status}${r.error ? ' ' + r.error : ''}${hop}`;
    lines.push(line);
    console.log(line);
  }
  lines.push(`\nchecked ${items.length} URLs in ${Date.now() - t0}ms`);
  fs.writeFileSync(path.join(__dirname, 'qa-v160-url-results.txt'), lines.join('\n'), 'utf8');
})();
