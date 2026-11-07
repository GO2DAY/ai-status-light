'use strict';

/**
 * tests/v162-fixes.test.js — v1.6.2 两项真机小修的行为级验证（纯 node）。
 *
 * 运行：node tests/v162-fixes.test.js
 *
 * 修 1：WorkBuddy 会话标题 custom_title（用户手动命名）优先
 *   A. buildWorkingTitlesSql 纯函数：有列/无列两种 schema 的 SQL 形状
 *   B. 真 winsqlite3 集成：两种 schema 临时库 —— 手动命名优先、空串/NULL 回退、
 *      老库（无 custom_title 列）不报错走旧 SQL
 *
 * 修 2：tooltip 语言链路（根因排查结论的固化）
 *   C. 链路锚点：main.js tooltip:data 载荷必带 lang: currentLanguage()；
 *      tooltip.html 全部可见文案经 t()，无英文硬编码残留
 *   D. 行为级：vm 沙箱跑 tooltip.html 内联脚本 + 假 DOM，喂 lang=zh-CN
 *      全中文、lang=en-US 全英文；resolveLanguage('auto', 'zh-CN') → 中文
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const aw = require('../main/agent-watcher');
const i18n = require('../main/i18n');

const { buildWorkingTitlesSql, tableHasColumn, queryWorkingTitlesFromDb, sqlite } = aw.__test;

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// A. SQL 形状（纯函数）
// ---------------------------------------------------------------------------

test('buildWorkingTitlesSql：无 custom_title 列 → 旧 SQL 逐字节不变（兼容性铁律）', () => {
  const legacy = buildWorkingTitlesSql(false);
  assert.strictEqual(
    legacy,
    "SELECT COALESCE(title,'未命名线程') FROM sessions WHERE deleted_at IS NULL AND status='working'"
  );
  assert.ok(!legacy.includes('custom_title'), '无列 schema 的 SQL 不得引用 custom_title');
});

test('buildWorkingTitlesSql：有列 → NULLIF(custom_title,\'\') 优先于 title，空串也回退', () => {
  const sql = buildWorkingTitlesSql(true);
  assert.ok(sql.includes("COALESCE(NULLIF(custom_title,''), title, '未命名线程')"), `形状不对: ${sql}`);
  assert.ok(sql.includes("status='working'") && sql.includes('deleted_at IS NULL'));
});

// ---------------------------------------------------------------------------
// B. 真 winsqlite3 集成：两种 schema 的临时库
// ---------------------------------------------------------------------------

/** 在已打开句柄上执行 DDL/DML（prepare+step 到 DONE）。 */
function execSql(api, db, sql) {
  const stmtRef = [0];
  const rc = api.prepare(db, sql, -1, stmtRef, 0);
  assert.strictEqual(rc, 0, `prepare 失败: ${sql}`);
  const stmt = stmtRef[0];
  try {
    let stepRc;
    do {
      stepRc = api.step(stmt);
    } while (stepRc === 100); // ROW
    assert.strictEqual(stepRc, 101, `step 未到 DONE: ${sql} rc=${stepRc}`);
  } finally {
    api.finalize(stmt);
  }
}

/** 造一个临时 sessions 库（有/无 custom_title 列），返回文件路径。 */
function makeTempDb(api, withCustomTitle) {
  const file = path.join(os.tmpdir(), `asl-v162-${Date.now()}-${withCustomTitle ? 'c' : 'l'}.db`);
  const dbRef = [0];
  const openRc = api.open(file, dbRef, 0x00000002 | 0x00000004, null); // READWRITE|CREATE
  assert.strictEqual(openRc, 0, '临时库打开失败');
  const db = dbRef[0];
  try {
    const cols = withCustomTitle
      ? 'title TEXT, custom_title TEXT, deleted_at TEXT, status TEXT'
      : 'title TEXT, deleted_at TEXT, status TEXT';
    execSql(api, db, `CREATE TABLE sessions (${cols})`);
    if (withCustomTitle) {
      // 手动命名优先；空串回退 title；全 NULL 回退「未命名线程」；非 working 不出现
      execSql(api, db, "INSERT INTO sessions VALUES ('自动标题A', 'AI状态灯项目', NULL, 'working')");
      execSql(api, db, "INSERT INTO sessions VALUES ('自动标题B', '', NULL, 'working')");
      execSql(api, db, 'INSERT INTO sessions VALUES (NULL, NULL, NULL, \'working\')');
      execSql(api, db, "INSERT INTO sessions VALUES ('已删除', '删了', '2026-01-01', 'working')");
      execSql(api, db, "INSERT INTO sessions VALUES ('不在工作', '闲着', NULL, 'idle')");
    } else {
      execSql(api, db, "INSERT INTO sessions VALUES ('老库标题', NULL, 'working')");
      execSql(api, db, 'INSERT INTO sessions VALUES (NULL, NULL, \'working\')');
    }
  } finally {
    api.close(db);
  }
  return file;
}

/** 以只读方式打开临时库并跑 queryWorkingTitlesFromDb。 */
function queryTitles(api, file) {
  const dbRef = [0];
  const openRc = api.open(file, dbRef, 0x00000001 | 0x00000040, null); // READONLY|URI
  assert.strictEqual(openRc, 0, '只读打开失败');
  const db = dbRef[0];
  try {
    api.busyTimeout(db, 500);
    return queryWorkingTitlesFromDb(api, db);
  } finally {
    api.close(db);
  }
}

test('custom_title 优先：手动命名 > 空串回退 title > 全空回退未命名；deleted/非 working 排除', () => {
  const api = sqlite();
  assert.ok(api, 'winsqlite3 不可用（本机 Windows 应自带）');
  const file = makeTempDb(api, true);
  try {
    const dbRef = [0];
    assert.strictEqual(api.open(file, dbRef, 1, null), 0);
    try {
      assert.strictEqual(tableHasColumn(api, dbRef[0], 'sessions', 'custom_title'), true);
    } finally {
      api.close(dbRef[0]);
    }
    const titles = queryTitles(api, file);
    assert.deepStrictEqual(titles, ['AI状态灯项目', '自动标题B', '未命名线程']);
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
});

test('老库无 custom_title 列：查询不报错，走旧 SQL 取 title', () => {
  const api = sqlite();
  const file = makeTempDb(api, false);
  try {
    const dbRef = [0];
    assert.strictEqual(api.open(file, dbRef, 1, null), 0);
    const db = dbRef[0];
    try {
      assert.strictEqual(tableHasColumn(api, db, 'sessions', 'custom_title'), false);
      assert.strictEqual(tableHasColumn(api, db, 'sessions', 'title'), true);
    } finally {
      api.close(db);
    }
    const titles = queryTitles(api, file);
    assert.deepStrictEqual(titles, ['老库标题', '未命名线程']);
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// C. tooltip 语言链路锚点
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
const tipHtml = fs.readFileSync(path.join(ROOT, 'main', 'tooltip.html'), 'utf8');

test('链路锚点：tooltip:data 载荷必带 lang: currentLanguage()（每次悬停现取）', () => {
  assert.ok(
    /send\('tooltip:data',\s*\{\s*agent:\s*payload\.agent,\s*lang:\s*currentLanguage\(\)\s*\}\)/.test(mainSrc),
    'main.js tooltip:data 不再携带 lang——tooltip 语言链路断了'
  );
  // 语言解析唯一入口：resolveLanguage(settings.language, app.getLocale())
  assert.ok(/i18n\.resolveLanguage\(settings\.language, locale\)/.test(mainSrc), 'currentLanguage 解析路径变了');
});

test('tooltip.html 无英文硬编码标签：可见文案全部经 t()（静态默认是中文占位）', () => {
  const ids = ['statusLabel', 'taskLabel', 'heartbeatLabel', 'status', 'heartbeat'];
  for (const id of ids) {
    const m = tipHtml.match(new RegExp(`getElementById\\('${id}'\\)[\\s\\S]{0,120}`));
    assert.ok(m, `${id} 渲染点找不到`);
  }
  // 三个行标签 + 状态值 + 心跳值都必须走 t()/relTime()
  assert.ok(/getElementById\('statusLabel'\)\.textContent = t\('tip\.status'\)/.test(tipHtml));
  assert.ok(/getElementById\('taskLabel'\)\.textContent = t\('tip\.task'\)/.test(tipHtml));
  assert.ok(/getElementById\('heartbeatLabel'\)\.textContent = t\('tip\.heartbeat'\)/.test(tipHtml));
  assert.ok(/getElementById\('status'\)\.textContent = t\('status\.'/.test(tipHtml));
  assert.ok(/getElementById\('heartbeat'\)\.textContent = relTime\(/.test(tipHtml));
  // 静态 HTML 默认文案是中文（i18n.js 加载失败时也不会裸奔英文）
  assert.ok(tipHtml.includes('状态：') && tipHtml.includes('最后心跳：'));
});

// ---------------------------------------------------------------------------
// D. tooltip 行为级：vm 沙箱 + 假 DOM 跑真实内联脚本
// ---------------------------------------------------------------------------

/** 从 tooltip.html 抽内联脚本（跳过 <script src="i18n.js"> 空壳）。 */
function extractInlineScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'tooltip.html 内联脚本找不到');
  return m[1];
}

/** 假 DOM：按 id 缓存元素桩（textContent/className/style）。 */
function makeFakeDom() {
  const els = new Map();
  return {
    getElementById(id) {
      if (!els.has(id)) els.set(id, { textContent: '', className: '', style: {} });
      return els.get(id);
    },
    _els: els,
  };
}

/** 在沙箱里加载 tooltip 脚本，返回 render 触发器与元素表。 */
function bootTooltip() {
  const document = makeFakeDom();
  let onData = null;
  const sandbox = {
    document,
    window: {
      ASL_I18N: i18n,
      tooltipApi: { onData: (fn) => { onData = fn; } },
    },
    setInterval: () => 0,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractInlineScript(tipHtml), sandbox);
  assert.ok(typeof onData === 'function', 'tooltip 脚本未注册 onData');
  return { fire: (payload) => onData(payload), els: document._els };
}

const AGENT = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  status: 'running',
  task: '2 线程: 甲 | 乙',
  lastHeartbeat: Date.now(),
  auto: false,
};

test('lang=zh-CN：tooltip 文案全中文（标签/状态/心跳）', () => {
  const { fire, els } = bootTooltip();
  fire({ agent: AGENT, lang: 'zh-CN' });
  const zh = (id) => els.get(id).textContent;
  assert.strictEqual(zh('statusLabel'), '状态：');
  assert.strictEqual(zh('taskLabel'), '任务：');
  assert.strictEqual(zh('heartbeatLabel'), '最后心跳：');
  assert.strictEqual(zh('status'), '运行中');
  assert.strictEqual(zh('heartbeat'), '刚刚');
  assert.strictEqual(zh('task'), AGENT.task); // 任务文本是数据，原样展示
});

test('lang=en-US：tooltip 文案全英文', () => {
  const { fire, els } = bootTooltip();
  fire({ agent: AGENT, lang: 'en-US' });
  const en = (id) => els.get(id).textContent;
  assert.strictEqual(en('statusLabel'), i18n.t('en-US', 'tip.status'));
  assert.strictEqual(en('heartbeatLabel'), i18n.t('en-US', 'tip.heartbeat'));
  assert.strictEqual(en('status'), 'Running');
  assert.strictEqual(en('heartbeat'), 'just now');
  // 双语互不相同（防复制粘贴回退）
  assert.notStrictEqual(en('statusLabel'), i18n.t('zh-CN', 'tip.status'));
});

test('auto 跟随系统：zh-CN / zh-Hans-CN locale 都解析成中文包', () => {
  assert.strictEqual(i18n.resolveLanguage('auto', 'zh-CN'), 'zh-CN');
  assert.strictEqual(i18n.resolveLanguage('auto', 'zh-Hans-CN'), 'zh-CN');
  assert.strictEqual(i18n.resolveLanguage('auto', 'en-US'), 'en-US');
  // 链路闭环：resolveLanguage 的产出喂给 tooltip render，文案必须是中文
  const { fire, els } = bootTooltip();
  const lang = i18n.resolveLanguage('auto', 'zh-CN');
  fire({ agent: AGENT, lang });
  assert.strictEqual(els.get('status').textContent, '运行中');
  assert.strictEqual(els.get('statusLabel').textContent, '状态：');
});

// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err && err.stack);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed${process.exitCode ? ' (with failures)' : ''}`);
})();
