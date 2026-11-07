'use strict';

/**
 * QA acceptance tests for the AI Status Light HTTP status service.
 *
 * Usage:
 *   node tests/qa_acceptance.js [baseUrl] [--heartbeat]
 *
 *   baseUrl      default http://127.0.0.1:17890
 *   --heartbeat  also run the live heartbeat-degradation test (~75s wait)
 *
 * The suite is self-contained: every agent it creates is removed again in a
 * cleanup step, so re-running it is idempotent.
 */

const BASE = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'http://127.0.0.1:17890';
const RUN_HEARTBEAT = process.argv.includes('--heartbeat');

const results = [];
let currentSuite = '';

function suite(name) { currentSuite = name; }

function record(name, ok, detail) {
  results.push({ suite: currentSuite, name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${currentSuite}] ${name}${detail ? '  -- ' + detail : ''}`);
}

async function req(method, path, body, rawBody) {
  const opts = { method, headers: {} };
  if (rawBody !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = rawBody;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body (e.g. html page) */ }
  return { status: res.status, json, text };
}

async function getAgent(id) {
  const { json } = await req('GET', '/api/state');
  return (json && json.agents ? json.agents : []).find((a) => a.id === id) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Target: ${BASE}\n`);

  // ---------------------------------------------------------------- sanity
  suite('connectivity');
  try {
    const root = await req('GET', '/nope-' + Date.now());
    record('service reachable (unknown route returns JSON 404)', root.status === 404 && root.json && root.json.ok === false,
      `status=${root.status}`);
  } catch (err) {
    record('service reachable', false, err.message);
    return report();
  }

  // ------------------------------------------------------- POST /status x4
  suite('POST /status - valid statuses');
  for (const status of ['running', 'idle', 'stuck', 'offline']) {
    const id = 'qa-st-' + status;
    const r = await req('POST', '/status', { agent: id, status, task: 'qa ' + status });
    const agent = await getAgent(id);
    record(`status "${status}" accepted and reflected in /api/state`,
      r.status === 200 && r.json.ok === true && agent && agent.status === status && agent.task === 'qa ' + status,
      agent ? `effective=${agent.status}` : 'agent missing');
  }

  suite('POST /status - heartbeat semantics');
  {
    await req('POST', '/status', { agent: 'qa-hb-off', status: 'offline' });
    const off = await getAgent('qa-hb-off');
    record('explicit offline clears lastHeartbeat', off && off.lastHeartbeat === 0, `lastHeartbeat=${off && off.lastHeartbeat}`);

    await req('POST', '/status', { agent: 'qa-hb-run', status: 'running' });
    const run = await getAgent('qa-hb-run');
    record('running sets a fresh lastHeartbeat', run && run.lastHeartbeat > Date.now() - 5000);

    const longTask = 'x'.repeat(900);
    await req('POST', '/status', { agent: 'qa-hb-run', status: 'running', task: longTask });
    const trunc = await getAgent('qa-hb-run');
    record('task text truncated to 500 chars', trunc && trunc.task.length === 500, `len=${trunc && trunc.task.length}`);
  }

  suite('POST /status - error handling');
  {
    const badJson = await req('POST', '/status', undefined, '{"agent": broken');
    record('malformed JSON body -> 400', badJson.status === 400 && badJson.json.ok === false, `status=${badJson.status} err=${badJson.json && badJson.json.error}`);

    const noAgent = await req('POST', '/status', { status: 'running' });
    record('missing "agent" field -> 400', noAgent.status === 400 && /agent/i.test(noAgent.json.error || ''));

    const emptyAgent = await req('POST', '/status', { agent: '   ', status: 'running' });
    record('blank "agent" -> 400', emptyAgent.status === 400);

    const badStatus = await req('POST', '/status', { agent: 'qa-bad', status: 'flying' });
    record('unknown status value -> 400', badStatus.status === 400 && badStatus.json.ok === false);

    const noStatus = await req('POST', '/status', { agent: 'qa-bad' });
    record('missing status -> 400', noStatus.status === 400);

    const badId = await req('POST', '/status', { agent: 'bad id!!', status: 'running' });
    record('illegal agent id chars -> 400', badId.status === 400);

    const longId = await req('POST', '/status', { agent: 'a'.repeat(25), status: 'running' });
    record('agent id >24 chars -> 400', longId.status === 400);
  }

  suite('POST /status - unknown agent auto-register');
  {
    const autoId = 'qa-auto-' + Date.now().toString(36);
    const before = await getAgent(autoId);
    const r = await req('POST', '/status', { agent: autoId, status: 'running', name: 'QA Auto' });
    const after = await getAgent(autoId);
    record('unknown agent is auto-registered on first report',
      before === null && r.status === 200 && after && after.name === 'QA Auto' && after.status === 'running');
    await req('DELETE', '/agents/' + autoId);
  }

  // ------------------------------------------------------------ /agents CRUD
  suite('/agents add & remove');
  {
    const add = await req('POST', '/agents', { id: 'qa-crud', name: 'QA Crud' });
    const added = await getAgent('qa-crud');
    record('POST /agents creates agent (offline, no heartbeat)',
      add.status === 200 && added && added.name === 'QA Crud' && added.status === 'offline');

    const rename = await req('POST', '/agents', { id: 'qa-crud', name: 'QA Crud v2' });
    const renamed = await getAgent('qa-crud');
    record('POST /agents with same id renames (upsert)',
      rename.status === 200 && renamed && renamed.name === 'QA Crud v2');

    const badAdd = await req('POST', '/agents', { id: 'no way!' });
    record('POST /agents invalid id -> 400', badAdd.status === 400);

    const missingId = await req('POST', '/agents', { name: 'no id' });
    record('POST /agents missing id -> 400', missingId.status === 400);

    const del = await req('DELETE', '/agents/qa-crud');
    const gone = await getAgent('qa-crud');
    record('DELETE /agents/:id removes agent', del.status === 200 && gone === null);

    const delAgain = await req('DELETE', '/agents/qa-crud');
    record('DELETE of missing agent -> 404', delAgain.status === 404);
  }

  suite('misc endpoints');
  {
    const stateAlias = await req('GET', '/agents');
    record('GET /agents alias returns same shape as /api/state',
      stateAlias.status === 200 && Array.isArray(stateAlias.json.agents));

    const opt = await req('OPTIONS', '/status');
    record('OPTIONS preflight -> 204', opt.status === 204, `status=${opt.status}`);
  }

  // ------------------------------------------------------------- concurrency
  suite('concurrency');
  {
    const N = 20;
    const fired = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        req('POST', '/status', { agent: 'qa-conc', status: i % 2 ? 'running' : 'idle', task: 'burst ' + i }))
    );
    const allOk = fired.every((r) => r.status === 200 && r.json.ok === true);
    const finalAgent = await getAgent('qa-conc');
    record(`${N} parallel reports all accepted, state consistent`,
      allOk && finalAgent && (finalAgent.status === 'running' || finalAgent.status === 'idle'),
      finalAgent ? `final=${finalAgent.status}` : 'agent missing');
  }

  // -------------------------------------------------- live heartbeat (slow)
  if (RUN_HEARTBEAT) {
    suite('heartbeat degradation (live, ~75s)');
    await req('POST', '/status', { agent: 'qa-hb-run', status: 'running' });
    await req('POST', '/status', { agent: 'qa-st-stuck', status: 'stuck' });
    console.log('...waiting 70s for idle-timeout (60s) to elapse...');
    await sleep(70_000);
    const run = await getAgent('qa-hb-run');
    const stuck = await getAgent('qa-st-stuck');
    record('running downgrades to idle after 60s silence',
      run && run.status === 'idle' && run.auto === true, run ? `status=${run.status} auto=${run.auto}` : 'missing');
    record('stuck is NOT auto-downgraded after 60s+',
      stuck && stuck.status === 'stuck' && stuck.auto === false, stuck ? `status=${stuck.status} auto=${stuck.auto}` : 'missing');
  }

  // --------------------------------------------------------------- cleanup
  suite('cleanup');
  {
    const ids = ['qa-st-running', 'qa-st-idle', 'qa-st-stuck', 'qa-st-offline',
      'qa-hb-off', 'qa-hb-run', 'qa-conc'];
    for (const id of ids) await req('DELETE', '/agents/' + id);
    const { json } = await req('GET', '/api/state');
    const leftovers = json.agents.filter((a) => a.id.startsWith('qa-'));
    record('all qa-* test agents removed', leftovers.length === 0,
      leftovers.map((a) => a.id).join(',') || 'clean');
  }

  report();
}

function report() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n===== QA ACCEPTANCE: ${passed}/${results.length} passed, ${failed} failed =====`);
  if (failed) {
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  FAILED: [${r.suite}] ${r.name} -- ${r.detail}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
