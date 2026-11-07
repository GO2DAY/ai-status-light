'use strict';
/**
 * Round-2 Bug 2 regression: window width must shrink back after agent removal.
 * Uses the debug endpoint GET /window (bounds in DIP).
 */
const BASE = 'http://127.0.0.1:17890';

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + path, opts);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function width() {
  const { json } = await req('GET', '/window');
  return json && json.bounds ? json.bounds.width : null;
}

(async () => {
  const expected = (n) => 24 + Math.max(n, 1) * 56 + 32;

  const w0 = await width();
  const agents0 = (await req('GET', '/api/state')).json.agents.length;
  console.log(`initial: agents=${agents0} width=${w0} expected=${expected(agents0)}`,
    w0 === expected(agents0) ? 'OK' : 'MISMATCH');

  for (let i = 1; i <= 8; i++) await req('POST', '/agents', { id: 'qa-w' + i });
  await sleep(800);
  const w1 = await width();
  const n1 = (await req('GET', '/api/state')).json.agents.length;
  console.log(`after add x8: agents=${n1} width=${w1} expected=${expected(n1)}`,
    w1 === expected(n1) ? 'OK' : 'MISMATCH');

  for (let i = 1; i <= 8; i++) await req('DELETE', '/agents/qa-w' + i);
  await sleep(800);
  const w2 = await width();
  const n2 = (await req('GET', '/api/state')).json.agents.length;
  const pass = w2 === expected(n2) && n2 === agents0;
  console.log(`after delete all: agents=${n2} width=${w2} expected=${expected(n2)}`,
    pass ? 'OK' : 'STALE_WIDTH');
  console.log(pass ? 'BUG2_FIXED' : 'BUG2_STILL_PRESENT');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
