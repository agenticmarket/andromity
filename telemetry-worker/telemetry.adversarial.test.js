import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';

const base = process.env.TELEMETRY_WORKER_DIR
  ? pathToFileURL(resolve(process.env.TELEMETRY_WORKER_DIR) + sep)
  : new URL('./', import.meta.url);
const { ingestTelemetry } = await import(new URL('ingest.js', base));
const workerModule = await import(new URL('worker.js', base));
const worker = workerModule.default;
const { computeD1Stats } = workerModule;
const migrations = ['schema.sql', 'measurement.sql', 'read-optimization.sql'].map(name => readFileSync(new URL(name, base), 'utf8'));

function d1Value(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${value}'`);
}

function database({ failOn } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) sqlite.exec(migration);
  const db = {
    sqlite, batches: 0, failOn,
    prepare(text) { return { bind(...args) { return { sql: text, args }; } }; },
    async batch(statements) {
      db.batches++;
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => {
          if (db.failOn && db.failOn(statement.sql)) throw new Error('injected statement failure');
          return { results: sqlite.prepare(statement.sql).all(...statement.args.map(d1Value)) };
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return db;
}

const T0 = Date.now() - 3600000;
const at = minutes => new Date(T0 + minutes * 60000).toISOString();
const USER_A = 'user-aaaaaaaa';
const USER_B = 'user-bbbbbbbb';
const SESSION = 'session-shared-1';
const fields = (overrides = {}) => {
  const now = overrides.now ?? at(0);
  return { userId: USER_A, sessionId: SESSION, client: 'vscode', os: 'linux', version: '0.3.0', country: 'GB',
    provider: 'ollama', model: 'llama3:8b', providerType: 'local', profile: 'builder', reasoningEffort: 'off',
    mcpToolsCount: 0, now, date: now.slice(0, 10), ...overrides };
};
const rows = (db, query, ...args) => db.sqlite.prepare(query).all(...args).map(row => ({ ...row }));
const endRows = (db, sessionId = SESSION, userId = USER_A) =>
  rows(db, `SELECT * FROM events WHERE event='session_end' AND session_id=? AND user_id=? ORDER BY id`, sessionId, userId);
const snapshot = db => {
  const tables = rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'telemetry_stats_cache' ORDER BY name`)
    .map(row => row.name);
  return Object.fromEntries(tables.map(table => [table, rows(db, `SELECT * FROM "${table}" ORDER BY rowid`)]));
};
const stats = db => computeD1Stats({ DB: db }, new URLSearchParams('timeRange=all'));
const sum = (list, key) => list.reduce((total, row) => total + Number(row[key] || 0), 0);

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}

async function post(db, path, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(`https://telemetry.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: text,
  }), { DB: db }, { waitUntil() {} });
}

async function storedColumn(column, extra, path = '/event') {
  const db = database();
  const first = await post(db, path, { event: 'session_start', user_id: USER_A, session_id: 'session-model-1', client: 'vscode', ...extra });
  const statuses = [first.status];
  if (path === '/event') {
    statuses.push((await post(db, '/event', { event: 'session_end', user_id: USER_A, session_id: 'session-model-1', client: 'vscode', ...extra })).status);
    statuses.push((await post(db, '/event', { event: 'task_started', user_id: USER_A, session_id: 'session-model-1', client: 'vscode',
      run_id: 'run-model-000000000001', ...extra })).status);
  }
  const values = ['sessions', 'activity_facts', 'events', 'task_runs']
    .flatMap(table => rows(db, `SELECT ${column} AS value FROM ${table}`)).map(row => row.value);
  db.sqlite.close();
  return { statuses, values: [...new Set(values)] };
}
const storedModels = (model, path) => storedColumn('model', { model }, path);
const storedProviders = (provider, path) => storedColumn('provider', { provider }, path);

const PRIVATE = ['bobsecret', 'privfolder'];
const leaksPrivate = value => PRIVATE.some(token => String(value).toLowerCase().includes(token));
const containsSecret = (value, secret, window = 8) => {
  for (let index = 0; index + window <= secret.length; index++) if (String(value).includes(secret.slice(index, index + window))) return true;
  return false;
};
const MODEL_SHAPE = /^[a-zA-Z0-9._:/-]{1,64}$/;

async function leaksFor(inputs, isLeak) {
  const leaks = [];
  for (const input of inputs) {
    const { statuses, values } = await storedModels(input);
    if (statuses.some(status => status !== 202)) leaks.push({ input, statuses });
    for (const value of values) if (isLeak(value, input)) leaks.push({ input, stored: value });
  }
  return leaks;
}

// ── [1] session_end: one row per (session_id, user_id), monotonic merge ──────────────────────

const END_EVENTS = [
  { data: { turn_count: 5, had_error: true, duration_bucket: '15-30min', tool_bash_count: 3, tool_file_count: 4, tool_web_count: 0 }, now: at(30) },
  { data: { turn_count: 2, had_error: false, duration_bucket: '30min+', tool_bash_count: 9, tool_file_count: 0, tool_web_count: 0 }, now: at(10) },
  { data: { turn_count: 7, had_error: false, duration_bucket: '0-5min', tool_bash_count: 0, tool_file_count: 1, tool_web_count: 6 }, now: at(20) },
  { data: { turn_count: 1, had_error: false, duration_bucket: '5-15min', tool_bash_count: 1, tool_file_count: 1, tool_web_count: 1 }, now: at(40) },
];

test('[1] session_end in every arrival order leaves exactly one row holding the maximum of every field', async () => {
  const failures = [];
  for (const order of permutations(END_EVENTS)) {
    const db = database();
    for (const { data, now } of order) await ingestTelemetry(db, { event: 'session_end', ...data }, fields({ now }));
    const stored = endRows(db);
    const actual = stored.length === 1 ? {
      turn_count: stored[0].turn_count, had_error: stored[0].had_error, duration_bucket: stored[0].duration_bucket,
      tools: [stored[0].tool_bash_count, stored[0].tool_file_count, stored[0].tool_web_count], created_at: stored[0].created_at,
    } : { rows: stored.length };
    const expected = { turn_count: 7, had_error: 1, duration_bucket: '30min+', tools: [9, 4, 6], created_at: at(40) };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({ order: order.map(event => event.now), actual });
    db.sqlite.close();
  }
  assert.deepEqual(failures, []);
});

test('[1] a later session_end with missing, invalid or hostile fields never lowers stored values', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_end', turn_count: 12, had_error: true, duration_bucket: '30min+',
    tool_bash_count: 4, tool_file_count: 5, tool_web_count: 6 }, fields({ now: at(50) }));
  const later = [
    {},
    { turn_count: -5, had_error: false, duration_bucket: 'bogus', tool_bash_count: -1, tool_file_count: 'abc', tool_web_count: null },
    { turn_count: '3', had_error: 0, duration_bucket: '0-5min', tool_bash_count: {}, tool_file_count: [], tool_web_count: 'NaN' },
    { turn_count: null, had_error: null, duration_bucket: null, tool_bash_count: false, tool_file_count: '', tool_web_count: '-1e9' },
    { duration_bucket: "30min+' OR '1'='1", turn_count: 1e-9 },
  ];
  for (const data of later) await ingestTelemetry(db, { event: 'session_end', ...data }, fields({ now: at(55) }));
  const stored = endRows(db);
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].turn_count, stored[0].had_error, stored[0].duration_bucket, stored[0].tool_bash_count, stored[0].tool_file_count, stored[0].tool_web_count],
    [12, 1, '30min+', 4, 5, 6]);
  db.sqlite.close();
});

test('[1] created_at and date move forward across midnight and never move back', async () => {
  const db = database();
  const dayTwo = new Date(T0 + 86400000).toISOString();
  await ingestTelemetry(db, { event: 'session_end' }, fields({ now: at(0) }));
  await ingestTelemetry(db, { event: 'session_end' }, fields({ now: dayTwo }));
  await ingestTelemetry(db, { event: 'session_end' }, fields({ now: at(5) }));
  const stored = endRows(db);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].created_at, dayTwo);
  assert.equal(stored[0].date, dayTwo.slice(0, 10));
  db.sqlite.close();
});

test('[1] a stale session_end arriving last does not overwrite the model, version and client of the newer event (inferred: the row is labelled with the newer created_at)', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_end' }, fields({ now: at(30), model: 'newer-model', version: '0.3.1', client: 'tui' }));
  await ingestTelemetry(db, { event: 'session_end' }, fields({ now: at(10), model: 'stale-model', version: '0.3.0', client: 'vscode' }));
  const newest = rows(db, `SELECT model,version,client FROM events WHERE event='session_end' AND created_at=?`, at(30));
  assert.ok(newest.length >= 1);
  for (const row of newest) assert.deepEqual(row, { model: 'newer-model', version: '0.3.1', client: 'tui' });
  db.sqlite.close();
});

// ── [2] another user with the same session_id ────────────────────────────────────────────────

async function collidingSessions() {
  const db = database();
  await ingestTelemetry(db, { event: 'session_start' }, fields());
  await ingestTelemetry(db, { event: 'session_end', turn_count: 1, duration_seconds: 30, duration_bucket: '0-5min' }, fields({ now: at(1) }));
  await ingestTelemetry(db, { event: 'session_end', turn_count: 99, had_error: true, duration_seconds: 5000, duration_bucket: '30min+',
    tool_bash_count: 50, tool_file_count: 50, tool_web_count: 50 }, fields({ userId: USER_B, now: at(2), model: 'other-model' }));
  return db;
}

test('[2] another user\'s session_end with the same session_id leaves the first user\'s events row untouched', async () => {
  const db = await collidingSessions();
  const first = endRows(db, SESSION, USER_A);
  assert.equal(first.length, 1);
  assert.deepEqual([first[0].turn_count, first[0].had_error, first[0].duration_bucket, first[0].tool_bash_count, first[0].model, first[0].created_at],
    [1, 0, '0-5min', 0, 'llama3:8b', at(1)]);
  const second = endRows(db, SESSION, USER_B);
  assert.equal(second.length, 1);
  assert.deepEqual([second[0].turn_count, second[0].had_error, second[0].tool_bash_count], [99, 1, 50]);
  db.sqlite.close();
});

test('[2] another user\'s session_end with the same session_id does not merge into the first user\'s sessions row', async () => {
  const db = await collidingSessions();
  const [row] = rows(db, 'SELECT user_id,turn_count,duration_seconds FROM sessions WHERE session_id=?', SESSION);
  assert.deepEqual(row, { user_id: USER_A, turn_count: 1, duration_seconds: 30 });
  db.sqlite.close();
});

test('[2][5] the panel shows the first user\'s own session_end values, not the colliding user\'s', async () => {
  const db = await collidingSessions();
  const result = await stats(db);
  const session = result.recent_sessions.find(entry => entry.session_id === SESSION && entry.user_id === USER_A);
  assert.ok(session);
  assert.deepEqual([session.turn_count, session.duration_bucket, session.tool_bash_count, session.had_error], [1, '0-5min', 0, 0]);
  const categories = Object.fromEntries(result.work_intent.map(entry => [entry.category, entry.sessions]));
  assert.equal(categories['Real Work (Tool Calling)'] ?? 0, 0);
  db.sqlite.close();
});

// ── [3] duplicate delivery and atomicity ─────────────────────────────────────────────────────

const EVENT_CASES = [
  ['session_start', {}, {}],
  ['session_update', { turn_count: 2, duration_seconds: 60 }, { turn_count: 40, duration_seconds: 6000 }],
  ['session_end', { turn_count: 3, had_error: false, duration_bucket: '0-5min', tool_bash_count: 1 },
    { turn_count: 30, had_error: true, duration_bucket: '30min+', tool_bash_count: 90 }],
  ['compact_triggered', { turn_count: 4 }, { turn_count: 44 }],
  ['feature_use', { feature_name: 'waterfall_manual' }, { feature_name: 'error_generic' }],
  ['weekly_summary', {}, {}],
  ['task_started', { run_id: 'run-aaaaaaaaaaaaaaaa' }, { run_id: 'run-aaaaaaaaaaaaaaaa' }],
  ['task_finished', { run_id: 'run-aaaaaaaaaaaaaaaa', outcome: 'completed', active_seconds: 5 },
    { run_id: 'run-aaaaaaaaaaaaaaaa', outcome: 'failed', active_seconds: 500 }],
];

test('[3] redelivering the same event_id, even with a changed payload or a later clock, changes nothing for every event type', async () => {
  const changed = [];
  for (const [event, data, mutated] of EVENT_CASES) {
    const db = database();
    await ingestTelemetry(db, { event: 'session_start' }, fields({ now: at(0) }));
    const eventId = `evt-${event.replace(/_/g, '-')}-0000000000`;
    await ingestTelemetry(db, { event, event_id: eventId, ...data }, fields({ now: at(5) }));
    const before = snapshot(db);
    await ingestTelemetry(db, { event, event_id: eventId, ...data }, fields({ now: at(6) }));
    await ingestTelemetry(db, { event, event_id: eventId, ...mutated }, fields({ now: at(7), model: 'other-model', client: 'tui' }));
    if (JSON.stringify(snapshot(db)) !== JSON.stringify(before)) changed.push(event);
    db.sqlite.close();
  }
  assert.deepEqual(changed, []);
});

test('[3] a session_end batch that fails part-way leaves nothing written and does not burn the event_id', async () => {
  const db = database({ failOn: text => /^\s*INSERT INTO events/.test(text) });
  const data = { event: 'session_end', event_id: 'evt-atomic-000000000001', turn_count: 3, had_error: true };
  await assert.rejects(ingestTelemetry(db, data, fields()));
  const empty = Object.values(snapshot(db)).every(table => table.length === 0);
  assert.equal(empty, true);
  db.failOn = null;
  await ingestTelemetry(db, data, fields());
  await ingestTelemetry(db, data, fields());
  assert.equal(endRows(db).length, 1);
  assert.equal(rows(db, 'SELECT COUNT(*) n FROM telemetry_receipts')[0].n, 1);
  db.sqlite.close();
});

test('[3] a failed update of an existing session_end row is rolled back completely', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_end', turn_count: 2, duration_bucket: '0-5min' }, fields({ now: at(1) }));
  const before = snapshot(db);
  db.failOn = text => /^\s*INSERT INTO events/.test(text);
  await assert.rejects(ingestTelemetry(db, { event: 'session_end', event_id: 'evt-atomic-000000000002', turn_count: 50, had_error: true,
    duration_bucket: '30min+', tool_bash_count: 7 }, fields({ now: at(9) })));
  assert.deepEqual(snapshot(db), before);
  db.sqlite.close();
});

test('[3] ingestTelemetry writes each event in exactly one batch', async () => {
  for (const [event, data] of EVENT_CASES) {
    const db = database();
    await ingestTelemetry(db, { event, event_id: 'evt-onebatch-00000001', ...data }, fields());
    assert.equal(db.batches, 1, event);
    db.sqlite.close();
  }
});

test('[3][7] an event_id or run_id sent as a JSON array is rejected as a bad request, not retried as a server error', async () => {
  const outcomes = [];
  for (const body of [
    { event: 'session_end', event_id: ['evt-array-0000000000001'] },
    { event: 'task_started', event_id: 'evt-array-0000000000002', run_id: ['run-aaaaaaaaaaaaaaaa'] },
  ]) {
    const db = database();
    const response = await post(db, '/event', { user_id: USER_A, session_id: SESSION, client: 'vscode', ...body });
    outcomes.push({ body: JSON.stringify(body), status: response.status, rows: rows(db, 'SELECT COUNT(*) n FROM users')[0].n });
    db.sqlite.close();
  }
  assert.deepEqual(outcomes.filter(outcome => outcome.status !== 400 || outcome.rows !== 0), []);
});

// ── [4] compact_triggered and weekly_summary ─────────────────────────────────────────────────

test('[4] compact_triggered keeps one row per distinct event and does not disturb the single session_end row', async () => {
  const db = database();
  for (let index = 0; index < 3; index++) {
    const data = { event: 'compact_triggered', event_id: `evt-compact-00000000000${index}`, turn_count: index };
    await ingestTelemetry(db, data, fields({ now: at(index) }));
    await ingestTelemetry(db, data, fields({ now: at(index) }));
  }
  await ingestTelemetry(db, { event: 'compact_triggered', turn_count: 9 }, fields({ now: at(4) }));
  await ingestTelemetry(db, { event: 'compact_triggered', turn_count: 9 }, fields({ now: at(4) }));
  await ingestTelemetry(db, { event: 'session_end', turn_count: 3 }, fields({ now: at(5) }));
  await ingestTelemetry(db, { event: 'session_end', turn_count: 4 }, fields({ now: at(6) }));
  assert.equal(rows(db, `SELECT COUNT(*) n FROM events WHERE event='compact_triggered'`)[0].n, 5);
  assert.equal(endRows(db).length, 1);
  assert.equal(endRows(db)[0].turn_count, 4);
  db.sqlite.close();
});

test('[4] weekly_summary from an older client is still accepted end to end', async () => {
  const db = database();
  const response = await post(db, '/event', { event: 'weekly_summary', user_id: USER_A, client: 'cli', version: '0.1.0' });
  assert.equal(response.status, 202);
  assert.equal(rows(db, `SELECT COUNT(*) n FROM events WHERE event='weekly_summary'`)[0].n, 1);
  const again = await post(db, '/event', { event: 'weekly_summary', user_id: USER_A, client: 'cli', event_id: 'evt-weekly-0000000001' });
  assert.equal(again.status, 202);
  db.sqlite.close();
});

// ── [5] panel numbers ───────────────────────────────────────────────────────────────────────

test('[5] twenty session_end deliveries for one session count as one session everywhere in the panel', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_start' }, fields());
  for (let index = 0; index < 20; index++) {
    await ingestTelemetry(db, { event: 'session_end', event_id: `evt-many-end-${String(index).padStart(6, '0')}`, turn_count: index,
      had_error: index === 7, duration_bucket: index > 15 ? '15-30min' : '5-15min', tool_bash_count: index % 3 }, fields({ now: at(index) }));
  }
  await ingestTelemetry(db, { event: 'session_start' }, fields({ userId: USER_B, sessionId: 'session-other-1' }));
  await ingestTelemetry(db, { event: 'session_end', turn_count: 1 }, fields({ userId: USER_B, sessionId: 'session-other-1' }));
  const result = await stats(db);
  assert.equal(result.summary.total_sessions, 2);
  assert.equal(sum(result.duration_buckets, 'sessions'), 2);
  assert.deepEqual(result.duration_buckets.map(row => [row.duration_bucket, row.sessions]), [['0-5min', 1], ['15-30min', 1]]);
  assert.deepEqual([result.error_stats.total_errors, result.error_stats.error_sessions, result.error_stats.affected_users], [1, 1, 1]);
  assert.equal(sum(result.work_intent, 'sessions'), 2);
  const mine = result.recent_sessions.find(entry => entry.session_id === SESSION);
  assert.deepEqual([mine.turn_count, mine.had_error, mine.duration_bucket, mine.tool_bash_count], [19, 1, '15-30min', 2]);
  db.sqlite.close();
});

function seedLegacyDuplicates(db, sessionId = SESSION, userId = USER_A) {
  db.sqlite.prepare(`INSERT INTO sessions(session_id,user_id,client,created_at,date) VALUES (?,?,?,?,?)`).run(sessionId, userId, 'vscode', at(0), at(0).slice(0, 10));
  db.sqlite.prepare(`INSERT INTO users(user_id,first_seen,last_seen,country,session_count) VALUES (?,?,?,?,0) ON CONFLICT DO NOTHING`).run(userId, at(0), at(0), 'GB');
  db.sqlite.prepare(`INSERT INTO activity_facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .run(userId, sessionId, at(0).slice(0, 10), 'vscode', 'linux', '0.2.0', 'GB', 'ollama', 'llama3:8b', 'local', 'builder', at(0));
  for (let index = 0; index < 3; index++) {
    db.sqlite.prepare(`INSERT INTO events(event,user_id,session_id,client,turn_count,had_error,duration_bucket,tool_bash_count,created_at,date)
      VALUES ('session_end',?,?,?,?,?,?,?,?,?)`).run(userId, sessionId, 'vscode', index + 1, 1, '5-15min', index, at(index), at(index).slice(0, 10));
  }
}

const collapse = db => db.sqlite.exec(readFileSync(new URL('collapse-session-end.sql', base), 'utf8'));

test('[5] legacy duplicate session_end rows collapse to one row after collapse-session-end.sql, and later session_end events keep it at one', async () => {
  const db = database();
  seedLegacyDuplicates(db);
  collapse(db);
  assert.equal(endRows(db).length, 1);
  await ingestTelemetry(db, { event: 'session_end', turn_count: 1 }, fields({ now: at(10) }));
  const stored = endRows(db);
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].turn_count, stored[0].had_error, stored[0].duration_bucket, stored[0].tool_bash_count], [3, 1, '5-15min', 2]);
  db.sqlite.close();
});

test('[5] the duration histogram counts a session with legacy duplicate rows once after collapse-session-end.sql', async () => {
  const db = database();
  seedLegacyDuplicates(db);
  collapse(db);
  const result = await stats(db);
  assert.deepEqual(result.duration_buckets.map(row => [row.duration_bucket, row.sessions]), [['5-15min', 1]]);
  db.sqlite.close();
});

test('[5] error totals weigh a legacy-duplicated error session the same as a new one after collapse-session-end.sql', async () => {
  const db = database();
  seedLegacyDuplicates(db);
  collapse(db);
  await ingestTelemetry(db, { event: 'session_start' }, fields({ sessionId: 'session-new-1' }));
  for (let index = 0; index < 3; index++) {
    await ingestTelemetry(db, { event: 'session_end', had_error: true }, fields({ sessionId: 'session-new-1', now: at(index) }));
  }
  const result = await stats(db);
  assert.equal(result.error_stats.error_sessions, 2);
  assert.equal(result.error_stats.total_errors, 2);
  db.sqlite.close();
});

// ── [6] modelName, end to end through POST /event and /ping ─────────────────────────────────

test('[6] model paths: model files keep the file name, other paths store local-path, URLs store url, over-long values store unknown', async () => {
  const expected = {
    'C:\\Users\\bobsecret\\privfolder\\x.gguf': 'x', 'c:\\users\\bobsecret\\privfolder\\x.safetensors': 'x', 'C:/Users/bobsecret/privfolder/x.gguf': 'x',
    'D:\\privfolder\\bobsecret\\x.bin': 'x', '/home/bobsecret/privfolder/x.gguf': 'x', '/Users/bobsecret/privfolder/x.onnx': 'x',
    'file:///home/bobsecret/privfolder/x.gguf': 'x', 'file:///C:/Users/bobsecret/privfolder/x.gguf': 'x', 'FILE://privfolder/bobsecret/x.pth': 'x',
    'file:C:\\Users\\bobsecret\\x.gguf': 'x', '\\\\privfolder\\bobsecret\\x.gguf': 'x', 'privfolder/bobsecret/x.gguf': 'x',
    '  /home/bobsecret/privfolder/x.GGUF  ': 'x', '/home/bobsecret/privfolder/x.pt': 'x', '/home/bobsecret/privfolder/x.ggml': 'x',
    '/home/bobsecret/privfolder/x.llamafile': 'x', '/home/bobsecret/privfolder/x.mlmodel': 'x', '~/privfolder/x.gguf': 'x',
    './privfolder/x.bin': 'x', '..\\privfolder\\x.safetensors': 'x', 'ollama/C:\\Users\\bobsecret\\x.gguf': 'x', '/home/bobsecret/privfolder/x.gguf/': 'x',
    '/opt/privfolder/bobsecret/x': 'local-path', '~/privfolder/x': 'local-path', '~bobsecret/privfolder/x': 'local-path', './privfolder/x': 'local-path',
    '.\\privfolder\\x': 'local-path', '../privfolder/x': 'local-path', '..\\privfolder\\x': 'local-path', 'ollama/C:\\Users\\bobsecret\\x': 'local-path',
    '/home/bobsecret/privfolder/x/': 'local-path', 'C:\\Users\\bobsecret\\privfolder\\x\\': 'local-path', 'C:Usersbobsecretprivfolderx.gguf': 'local-path',
    'c:usersbobsecretprivfolderx.safetensors': 'local-path', 'file:///home/bobsecret/privfolder/': 'local-path',
    '/home/bobsecret/privfolder/x.txt': 'local-path', '/home/bobsecret/privfolder/x.gguf.part': 'local-path', 'Users/bobsecret/privfolder/x': 'local-path',
    'https://bobsecret:pw@llm.example.com/privfolder/x.gguf': 'url', 'http://localhost:1234/v1/models/x': 'url', 'HTTPS://llm.example.com/x': 'url',
    'smb://privfolder/bobsecret/x.gguf': 'url',
    ['/home/bobsecret/' + 'a'.repeat(600) + '.gguf']: 'unknown', ['gpt-4o-' + 'x'.repeat(520)]: 'unknown',
  };
  const wrong = [];
  for (const [input, want] of Object.entries(expected)) {
    const { statuses, values } = await storedModels(input);
    if (statuses.some(status => status !== 202) || values.some(value => value !== want)) wrong.push({ input: input.slice(0, 80), want, statuses, values });
  }
  for (const input of Object.keys(expected).slice(0, 6)) {
    const { statuses, values } = await storedModels(input, '/ping');
    if (statuses[0] !== 202 || values.some(value => value !== 'x')) wrong.push({ input, path: '/ping', values });
  }
  assert.deepEqual(wrong, []);
});

test('[6] path-shaped fuzz: any mix of roots and separators stores the file name for model files and local-path otherwise', async () => {
  let seed = 0x5eed;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = list => list[Math.floor(random() * list.length)];
  const roots = ['C:\\', 'c:/', 'Z:\\', '/', '~/', '~bobsecret/', './', '.\\', '../', '..\\', 'file:///', 'file:///C:/', '\\\\', 'file:'];
  const folders = ['bobsecret', 'privfolder', 'Users', 'home', 'my models', 'a.b', '2024', 'x y'];
  const extensions = ['', '.gguf', '.GGUF', '.safetensors', '.bin', '.pt', '.pth', '.onnx', '.ggml', '.llamafile', '.mlmodel'];
  const wrong = [];
  for (let index = 0; index < 120; index++) {
    let input = pick(roots);
    const depth = 1 + Math.floor(random() * 4);
    for (let level = 0; level < depth; level++) input += pick(folders) + pick(['/', '\\']);
    if (input.startsWith('file:') && !input.startsWith('file:/')) input = input.replace(/^file:/, 'file:C:\\');
    const extension = pick(extensions);
    input += 'x' + extension;
    const want = extension ? 'x' : 'local-path';
    const { values } = await storedModels(input);
    if (values.some(value => value !== want)) wrong.push({ input, want, values });
  }
  assert.deepEqual(wrong, []);
});

test('[6] ordinary model IDs are stored unchanged, slashes included', async () => {
  const ids = [
    'openrouter/anthropic/claude-sonnet-4', 'llama3:8b', 'hf.co/org/repo:Q4_K_M', 'gpt-4o', 'ollama/llama3.2:3b',
    'meta-llama/Llama-3.1-8B-Instruct', 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'gemini/gemini-2.5-pro',
    'deepseek/deepseek-chat-v3.1', 'qwen2.5-coder:7b', 'openrouter/openai/gpt-oss-120b:free', 'x-ai/grok-4',
    'groq/meta-llama/llama-4-scout-17b-16e-instruct', 'phi3:3.8b-mini-128k-instruct-q4_K_M', 'TheBloke/Mistral-7B-Instruct-v0.2-GGUF',
    'claude-sonnet-4-20250514', 'NousResearch/Hermes-3-Llama-3.1-405B', 'cognitivecomputations/dolphin-2.9.4-llama3.1-8b',
    'mlx-community/Meta-Llama-3.1-8B-Instruct-4bit', 'meta-llama/Llama-3.2-11B-Vision-Instruct', 'gemini-2.0-flash-thinking-exp-01-21',
    'models/gemini-1.5-pro-002', 'tunedModels/mymodel-abc123xyz', 'o3-mini-2025-01-31', 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    'together_ai/meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', 'accounts/fireworks/models/llama-v3p1-405b-instruct',
    'ft:gpt-4o-mini-2024-07-18:my-org::A1b2C3d4', 'jumpstart-dft-meta-textgeneration-llama-2-7b-f', 'huggingface/TheBloke/Llama-2-7B-Chat-GGUF',
    'openrouter/meta-llama/llama-3.1-405b-instruct:free', 'MetaLlama31_8BInstruct_Q4_K_M_imatrix_v2',
  ];
  const changed = [];
  for (const id of ids) {
    const { values } = await storedModels(id);
    if (values.length !== 1 || values[0] !== id) changed.push({ id, values });
  }
  assert.deepEqual(changed, []);
});

test('[6] a one-letter name followed by a colon is treated as a drive-relative path (accepted trade-off)', async () => {
  const { values } = await storedModels('a:7b');
  assert.deepEqual(values, ['local-path']);
});

test('[6] long hyphenated model IDs without a slash or dot are kept, not mistaken for an API key', async () => {
  const ids = ['llama-4-maverick-17b-128e-instruct', 'deepseek-r1-distill-llama-70b-specdec'];
  const changed = [];
  for (const id of ids) {
    const { values } = await storedModels(id);
    if (values.length !== 1 || values[0] !== id) changed.push({ id, values });
  }
  assert.deepEqual(changed, []);
});

test('[6] bare API keys and keys at the end of a path are scrubbed', async () => {
  const secrets = [
    'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8t', 'gsk_Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2', 'AIzaSyA1b2C3d4E5f6G7h8I9j0K', 'nvapi-Qq1Ww2Ee3Rr4Tt5Yy6Uu7',
    'xai-Mm1Nn2Bb3Vv4Cc5Xx6Zz7Ll8', 'sk-ant-api03-Pp9Oo8Ii7Uu6Yy5Tt4Rr3Ee2Ww1Qq0', 'Gh7Jk2Lm9Np4Qr6St1Uv8Wx3Yz5Ab0Cd2Ef',
  ];
  const leaks = [];
  for (const secret of secrets) {
    for (const input of [secret, `/home/bobsecret/models/${secret}.gguf`, `  ${secret}  `]) {
      const { values } = await storedModels(input);
      for (const value of values) if (containsSecret(value, secret, 12) || leaksPrivate(value)) leaks.push({ input, stored: value });
    }
  }
  assert.deepEqual(leaks, []);
});

test('[6] API keys behind a provider prefix are scrubbed (slashes are now kept, so the 32-character rule no longer fires)', async () => {
  const cases = [
    ['openrouter/', 'Zq8xP2mK9vL4nR7tY1wB3cF6hJ0dS5gA'],
    ['huggingface/', 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567'],
    ['together_ai/', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
    ['openai/', 'ghp_R2d2C3poL1ke5kyW4lkerHan5oloChewie'],
    ['azure/', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56'],
  ];
  const leaks = await leaksFor(cases.map(([prefix, secret]) => prefix + secret),
    (value, input) => containsSecret(value, cases.find(([prefix, secret]) => prefix + secret === input)[1], 12));
  assert.deepEqual(leaks, []);
});

test('[6] a key cut short by the 64-character limit is not stored in part', async () => {
  const secret = 'sk-AbCdEfGhIjKlMnOpQrStUvWx';
  const input = 'openrouter/some-long-organisation/a-long-model-name/' + secret;
  const leaks = await leaksFor([input, 'x'.repeat(50) + '/' + secret], value => containsSecret(value, secret.slice(3), 8));
  assert.deepEqual(leaks, []);
});

test('[6] Windows paths that older clients sent without backslashes never store a folder name (folder starting with a digit)', async () => {
  const leaks = await leaksFor([
    'C:1bobsecretprivfolderx.gguf',
    'D:2024privfolderbobsecretx.gguf',
    'C:0bobsecretx',
  ], leaksPrivate);
  assert.deepEqual(leaks, []);
});

test('[6] relative Windows paths that older clients sent without backslashes never store a folder name', async () => {
  const leaks = await leaksFor([
    '..bobsecretprivfolderx.gguf',
    '.privfolderbobsecretx.safetensors',
  ], leaksPrivate);
  assert.deepEqual(leaks, []);
});

test('[6] UNC paths that older clients sent without backslashes never store a folder name', { todo: 'older clients strip separators; not recoverable server-side' }, async () => {
  const leaks = await leaksFor(['fileserverbobsecretprivfolderx.gguf'], leaksPrivate);
  assert.deepEqual(leaks, []);
});

test('[6] a model path that names a folder never stores the user\'s folder name', async () => {
  const leaks = await leaksFor(['/home/bobsecret', '/home/bobsecret/', '~bobsecret', 'C:\\Users\\bobsecret', 'C:\\Users\\bobsecret\\', 'file:///Users/bobsecret'], leaksPrivate);
  assert.deepEqual(leaks, []);
});

test('[6] an absolute path behind a provider prefix (e.g. a vLLM or llama.cpp model served under its path) never stores folder names', async () => {
  const leaks = await leaksFor([
    'openai//home/bobsecret/privfolder/Llama-3-8B',
    'hosted_vllm//Users/bobsecret/privfolder/Qwen2.5-7B',
    'openai/C:/Users/bobsecret/privfolder/x',
    'lm_studio//home/bobsecret/privfolder/x',
  ], leaksPrivate);
  assert.deepEqual(leaks, []);
});

test('[6] credentials embedded in the model value (JWT, URL password) are not stored', async () => {
  const jwtSignature = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const cases = [
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + jwtSignature, jwtSignature],
    ['https://bob:hunter2hunter2@llm.example.com/v1/m', 'hunter2hunter2'],
  ];
  const leaks = await leaksFor(cases.map(([input]) => input),
    (value, input) => containsSecret(value, cases.find(([candidate]) => candidate === input)[1], 10));
  assert.deepEqual(leaks, []);
});

test('[6] cloud account identifiers inside the model value are not stored', async () => {
  const leaks = await leaksFor([
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-7',
    'bedrock/arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/x',
  ], value => value.includes('123456789012'));
  assert.deepEqual(leaks, []);
});

test('[6] every stored model is 1-64 characters from [a-zA-Z0-9._:/-] for random hostile input', async () => {
  let seed = 0xbad5eed;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const alphabet = ['a', 'Z', '9', '.', '_', ':', '/', '\\', '-', '~', ' ', '\t', '\n', '"', "'", ';', '%', '@', '?', '#', '\u0000', '\u200b',
    '\uff0f', '\uff3c', 'é', '😀', 'C:', 'file:', '..', '.gguf', 'sk-', '\ud800'];
  const db = database();
  const bad = [];
  for (let index = 0; index < 300; index++) {
    let input = '';
    const length = Math.floor(random() * 90);
    for (let position = 0; position < length; position++) input += alphabet[Math.floor(random() * alphabet.length)];
    const response = await post(db, '/event', { event: 'session_start', user_id: USER_A, session_id: `session-fuzz-${index}`, client: 'cli', model: input });
    if (response.status !== 202) bad.push({ input, status: response.status });
  }
  for (const { session_id, model } of rows(db, 'SELECT session_id, model FROM sessions')) {
    if (!MODEL_SHAPE.test(model)) bad.push({ session_id, model });
  }
  assert.deepEqual(bad, []);
  db.sqlite.close();
});

test('[6][7] non-string model values never crash ingestion', async () => {
  const db = database();
  const statuses = [];
  for (const [index, model] of [null, 0, 1e308, true, false, [], ['/home/bobsecret/x.gguf'], {}, { path: '/home/bobsecret' }, '', ' '].entries()) {
    const response = await post(db, '/event', { event: 'session_end', user_id: USER_A, session_id: `session-type-${index}`, client: 'cli', model });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.filter(status => status !== 202), []);
  const stored = rows(db, 'SELECT model FROM sessions').map(row => row.model);
  assert.deepEqual(stored.filter(value => !MODEL_SHAPE.test(value) || leaksPrivate(value)), []);
  db.sqlite.close();
});

test('[6][7] a model made of a long run of slashes inside the 16 KB limit is processed in linear time', async () => {
  const db = database();
  await post(db, '/event', { event: 'session_start', user_id: USER_A, session_id: 'session-warm-1', client: 'cli', model: '/home/x/y.gguf' });
  const timings = [];
  for (const [index, model] of ['/'.repeat(16200) + 'a', 'C:' + '/'.repeat(16200) + 'a'].entries()) {
    const body = JSON.stringify({ event: 'session_start', user_id: USER_A, session_id: `session-redos-${index}`, client: 'cli', model });
    assert.ok(body.length < 16384);
    const started = performance.now();
    const response = await post(db, '/event', body, { 'Content-Length': String(body.length) });
    timings.push({ status: response.status, ms: Math.round(performance.now() - started) });
  }
  assert.deepEqual(timings.filter(timing => timing.status >= 500 || timing.ms > 50), []);
  db.sqlite.close();
});

test('[6][7] the 16 KB payload limit also applies when no Content-Length header is sent', async () => {
  const db = database();
  const body = JSON.stringify({ event: 'session_start', user_id: USER_A, session_id: 'session-big-1', client: 'cli', model: '/'.repeat(40000) + 'a' });
  const started = performance.now();
  const response = await post(db, '/event', body);
  const ms = Math.round(performance.now() - started);
  assert.deepEqual({ status: response.status, slow: ms > 50 }, { status: 413, slow: false });
  db.sqlite.close();
});

// ── [7] injection and hostile types ─────────────────────────────────────────────────────────

test('[7] SQL-shaped strings in every field are rejected or stored inert, and the schema survives', async () => {
  const db = database();
  const tablesBefore = rows(db, `SELECT name FROM sqlite_master ORDER BY name`);
  const payload = "x'); DROP TABLE events; --";
  const statuses = [];
  for (const body of [
    { session_id: payload },
    { user_id: payload },
    { model: payload, provider: payload, version: payload, client: payload, os: payload, profile: payload, provider_type: payload,
      reasoning_effort: payload, duration_bucket: payload, feature_name: payload, run_id: payload, outcome: payload },
    { event: 'session_end', duration_bucket: "30min+' OR 1=1 --", model: "llama3'||(SELECT group_concat(user_id) FROM users)||'" },
    { event: "session_end' OR '1'='1" },
  ]) {
    const response = await post(db, '/event', { event: 'session_end', user_id: USER_A, session_id: 'session-inject-1', client: 'cli', ...body });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [400, 400, 202, 202, 400]);
  assert.deepEqual(rows(db, `SELECT name FROM sqlite_master ORDER BY name`), tablesBefore);
  const stored = endRows(db, 'session-inject-1');
  assert.equal(stored.length, 1);
  assert.ok(['0-5min', '5-15min', '15-30min', '30min+'].includes(stored[0].duration_bucket));
  assert.match(stored[0].model, MODEL_SHAPE);
  assert.ok(!stored[0].model.includes(USER_A));
  assert.doesNotMatch(JSON.stringify(snapshot(db)), /DROP TABLE/);
  db.sqlite.close();
});

test('[7] hostile number types are stored as bounded, finite, non-negative counts', async () => {
  const db = database();
  const values = ['5', '1e400', 1e308, -1, '-7', {}, [], [12], [1, 2], true, '0x10', 'Infinity', '  9  ', 2.5, null, 9007199254740993];
  const statuses = [];
  for (const [index, value] of values.entries()) {
    const response = await post(db, '/event', { event: 'session_end', user_id: USER_A, session_id: `session-num-${index}`, client: 'cli',
      turn_count: value, tool_bash_count: value, tool_file_count: value, tool_web_count: value, duration_seconds: value, duration_bucket: value });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.filter(status => status !== 202), []);
  const bad = rows(db, `SELECT session_id,turn_count,tool_bash_count,tool_file_count,tool_web_count,duration_bucket FROM events WHERE event='session_end'`)
    .filter(row => !(Number.isFinite(row.turn_count) && row.turn_count >= 0 && row.turn_count <= 9999
      && [row.tool_bash_count, row.tool_file_count, row.tool_web_count].every(count => Number.isFinite(count) && count >= 0 && count <= 86400000)
      && ['0-5min', '5-15min', '15-30min', '30min+'].includes(row.duration_bucket)));
  assert.deepEqual(bad, []);
  db.sqlite.close();
});

test('[7] had_error sent as the strings "false" or "0" is not recorded as an error', async () => {
  const db = database();
  const recorded = [];
  for (const [index, value] of ['false', '0', 'False', '', 0, false, null].entries()) {
    const sessionId = `session-err-${index}`;
    const response = await post(db, '/event', { event: 'session_end', user_id: USER_A, session_id: sessionId, client: 'cli', had_error: value });
    assert.equal(response.status, 202);
    const [row] = endRows(db, sessionId);
    if (row.had_error !== 0) recorded.push({ had_error: value, stored: row.had_error });
  }
  assert.deepEqual(recorded, []);
  db.sqlite.close();
});

// ── Round 2: streamed body limit (readCappedText) ──────────────────────────────────────────

const encoder = new TextEncoder();
const LIMIT = 16384;

function streamRequest(path, source, headers = {}) {
  return new Request(`https://telemetry.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: new ReadableStream(source), duplex: 'half',
  });
}
const chunkSource = chunks => {
  let index = 0;
  return { pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); } };
};
async function settle(promise, ms = 4000) {
  let timer;
  try {
    return await Promise.race([
      promise.then(response => response.status, error => `threw: ${error.message}`),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
const paddedBody = (bytes, padChar = ' ') => {
  const head = { event: 'session_start', user_id: USER_A, session_id: 'session-pad-1', client: 'cli', pad: '' };
  const base = Buffer.byteLength(JSON.stringify(head));
  const unit = Buffer.byteLength(padChar);
  const count = Math.floor((bytes - base) / unit);
  const body = JSON.stringify({ ...head, pad: padChar.repeat(count) }) + ' '.repeat(bytes - base - count * unit);
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
};

test('[R] a chunked body with no Content-Length is cut off at 16 KB and the rest of the stream is cancelled', async () => {
  const db = database();
  let pulls = 0;
  let cancelled = false;
  const chunk = encoder.encode(' '.repeat(1024));
  const source = {
    async pull(controller) {
      pulls++;
      if (pulls > 2048) { controller.close(); return; }
      await new Promise(resolve => setImmediate(resolve));
      controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  };
  const status = await settle(worker.fetch(streamRequest('/event', source), { DB: db }, { waitUntil() {} }));
  assert.deepEqual({ status, cancelled, readAtMostLimit: pulls <= 20 }, { status: 413, cancelled: true, readAtMostLimit: true });
  db.sqlite.close();
});

test('[R] a Content-Length that understates the body does not let a larger body through', async () => {
  const db = database();
  const body = paddedBody(40000);
  const outcomes = [];
  for (const header of ['100', '0', '16384']) {
    outcomes.push(await settle(worker.fetch(streamRequest('/event', chunkSource([encoder.encode(body)]), { 'Content-Length': header }), { DB: db }, { waitUntil() {} })));
  }
  assert.deepEqual(outcomes, [413, 413, 413]);
  assert.equal(rows(db, 'SELECT COUNT(*) n FROM users')[0].n, 0);
  db.sqlite.close();
});

test('[R] negative or garbage Content-Length values fall back to the streamed limit', async () => {
  const outcomes = {};
  for (const header of ['-1', 'abc', '1e9', ' 12', '0x10']) {
    const db = database();
    const small = await settle(worker.fetch(streamRequest('/event', chunkSource([encoder.encode(paddedBody(500))]), { 'Content-Length': header }), { DB: db }, { waitUntil() {} }));
    const large = await settle(worker.fetch(streamRequest('/event', chunkSource([encoder.encode(paddedBody(LIMIT + 1))]), { 'Content-Length': header }), { DB: db }, { waitUntil() {} }));
    outcomes[header] = [small, large];
    db.sqlite.close();
  }
  assert.deepEqual(outcomes, { '-1': [202, 413], abc: [202, 413], '1e9': [202, 413], ' 12': [202, 413], '0x10': [202, 413] });
});

test('[R] the limit counts UTF-8 bytes: exactly 16384 bytes is accepted, 16385 bytes is rejected even when under 16384 characters', async () => {
  const outcomes = [];
  for (const [bytes, padChar] of [[LIMIT, ' '], [LIMIT, 'é'], [LIMIT + 1, ' '], [LIMIT + 1, 'é'], [LIMIT + 2, '😀']]) {
    const db = database();
    const body = paddedBody(bytes, padChar);
    const status = await settle(post(db, '/event', body));
    outcomes.push({ bytes, padChar, characters: body.length < LIMIT, status });
    db.sqlite.close();
  }
  assert.deepEqual(outcomes.map(outcome => outcome.status), [202, 202, 413, 413, 413]);
});

test('[R] a multi-byte character split across chunks is decoded correctly at every split point', async () => {
  const wrong = [];
  const body = encoder.encode(JSON.stringify({ event: 'feature_use', user_id: USER_A, session_id: 'session-split-1', client: 'cli', feature_name: '\u212Afoo\u00e9' }));
  const start = body.indexOf(0xe2);
  for (let split = start + 1; split < start + 3; split++) {
    for (const pieces of [[body.slice(0, split), body.slice(split)], Array.from(body, byte => Uint8Array.of(byte))]) {
      const db = database();
      const status = await settle(worker.fetch(streamRequest('/event', chunkSource(pieces)), { DB: db }, { waitUntil() {} }));
      const feature = rows(db, 'SELECT feature_name FROM feature_events').map(row => row.feature_name);
      if (status !== 202 || feature[0] !== 'kfoo') wrong.push({ split, chunks: pieces.length, status, feature });
      db.sqlite.close();
    }
  }
  assert.deepEqual(wrong, []);
});

test('[R] 16 KB delivered one byte per chunk is accepted', async () => {
  const db = database();
  const bytes = encoder.encode(paddedBody(LIMIT));
  const status = await settle(worker.fetch(streamRequest('/event', chunkSource(Array.from(bytes, byte => Uint8Array.of(byte)))), { DB: db }, { waitUntil() {} }), 10000);
  assert.equal(status, 202);
  db.sqlite.close();
});

test('[R] empty and missing bodies are rejected with 400', async () => {
  const db = database();
  const outcomes = [
    await settle(post(db, '/event', '')),
    await settle(worker.fetch(new Request('https://telemetry.test/event', { method: 'POST' }), { DB: db }, { waitUntil() {} })),
    await settle(worker.fetch(streamRequest('/event', chunkSource([])), { DB: db }, { waitUntil() {} })),
    await settle(post(db, '/ping', '   ')),
  ];
  assert.deepEqual(outcomes, [400, 400, 400, 400]);
  db.sqlite.close();
});

test('[R] non-object JSON (array, null, number, string, boolean) is rejected with 400 and stores nothing', async () => {
  const db = database();
  const outcomes = {};
  for (const body of ['[]', `[${JSON.stringify({ user_id: USER_A })}]`, 'null', '0', '1', '-1e309', '"user-aaaaaaaa"', 'true', 'false', '{}', '[[[[[[[[]]]]]]]]', 'NaN', '{"user_id":"user-aaaaaaaa"']) {
    outcomes[body] = await settle(post(db, '/event', body));
  }
  assert.deepEqual(Object.entries(outcomes).filter(([, status]) => status !== 400), []);
  assert.equal(rows(db, 'SELECT COUNT(*) n FROM users')[0].n, 0);
  db.sqlite.close();
});

test('[R] a body stream that fails part-way returns a 400 response instead of throwing', async () => {
  const db = database();
  const source = { start(controller) { controller.enqueue(encoder.encode('{"user_id":"user-aaaa')); controller.error(new Error('client went away')); } };
  const status = await settle(worker.fetch(streamRequest('/event', source), { DB: db }, { waitUntil() {} }));
  assert.equal(status, 400);
  db.sqlite.close();
});

test('[R] JSON preceded by a UTF-8 byte order mark is still accepted', async () => {
  const db = database();
  const body = '\ufeff' + JSON.stringify({ event: 'session_start', user_id: USER_A, session_id: 'session-bom-1', client: 'cli' });
  assert.equal(await settle(post(db, '/event', body)), 202);
  db.sqlite.close();
});

// ── Round 2: provider names ─────────────────────────────────────────────────────────────────

test('[P] ordinary provider names are stored unchanged', async () => {
  const changed = [];
  for (const name of ['openai', 'anthropic', 'ollama', 'lm_studio', 'lmstudio', 'hosted_vllm', 'together_ai', 'openai-compatible', 'vertex_ai',
    'github_copilot', 'azure_ai', 'bedrock', 'openrouter', 'groq', 'cerebras', 'xai', 'deepseek', 'gemini', 'mistral', 'nvidia_nim', 'andromity', 'llama.cpp']) {
    const { values } = await storedProviders(name);
    if (values.length !== 1 || values[0] !== name) changed.push({ name, values });
  }
  assert.deepEqual(changed, []);
});

test('[P] paths and URLs given as the provider store unknown', async () => {
  const wrong = [];
  for (const input of ['/home/bobsecret', 'C:\\Users\\bobsecret', 'C:Usersbobsecret', 'Users/bobsecret/privfolder', 'home/bobsecret/x', '~bobsecret',
    './privfolder', '..\\privfolder', 'file:///home/bobsecret', '\\\\fileserver\\bobsecret', 'https://bobsecret.openai.azure.com', 'http://localhost:11434/v1',
    'HTTPS://llm.example.com', 'ws://privfolder:8080', 'x/C:/bobsecret']) {
    const { values } = await storedProviders(input);
    if (values.some(value => value !== 'unknown')) wrong.push({ input, values });
  }
  assert.deepEqual(wrong, []);
});

test('[P] every stored provider is 1-32 characters from [a-zA-Z0-9._-] for random hostile input', async () => {
  let seed = 0x9e3779b9 & 0x7fffffff;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const alphabet = ['a', 'Z', '9', '.', '_', ':', '/', '\\', '-', '~', ' ', '@', '%', '"', 'é', '😀', 'C:', 'http://', 'bobsecret', '\u200b'];
  const db = database();
  const bad = [];
  for (let index = 0; index < 200; index++) {
    let input = '';
    const length = Math.floor(random() * 30);
    for (let position = 0; position < length; position++) input += alphabet[Math.floor(random() * alphabet.length)];
    const response = await post(db, '/event', { event: 'session_start', user_id: USER_A, session_id: `session-prov-${index}`, client: 'cli', provider: input });
    if (response.status !== 202) bad.push({ input, status: response.status });
  }
  for (const { provider } of rows(db, 'SELECT provider FROM sessions')) if (!/^[a-zA-Z0-9._-]{1,32}$/.test(provider)) bad.push({ provider });
  assert.deepEqual(bad, []);
  db.sqlite.close();
});

// ── Round 2: key detection ──────────────────────────────────────────────────────────────────

test('[K] keys under the revised rules are scrubbed from model and provider, including keys split by stripped characters', async () => {
  const keys = {
    'pplx-AbCdEfGhIjKlMnOp1234': 'pplx-AbCdEfGhIjKlMnOp1234',
    'Zq8xP2mK9vL4nR7tY1wB3cF6': 'Zq8xP2mK9vL4nR7tY1wB3cF6',
    'abcdefghijklmnopqrstuvwxyzabcdef': 'abcdefghijklmnopqrstuvwxyzabcdef',
    'sk-abc def ghi jkl mno pqr': 'abcdefghijklmnopqr',
    'sk-abc\u200bdefghijklmnopqrstu': 'defghijklmnopqrstu',
    'Ab12Cd34+Ef56Gh78+Ij90Kl12=': 'Ef56Gh78Ij90',
    'groq/gsk_Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2': 'Zz9Yy8Xx7Ww6Vv5Uu4',
    'r8_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789a': 'AbCdEfGhIjKlMnOpQrSt',
    'csk-abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx': 'abcd1234efgh5678ijkl',
  };
  const leaks = [];
  for (const [input, secret] of Object.entries(keys)) {
    for (const [field, read] of [['model', storedModels], ['provider', storedProviders]]) {
      const { values } = await read(input);
      for (const value of values) if (containsSecret(value, secret, 10)) leaks.push({ field, input, stored: value });
    }
  }
  assert.deepEqual(leaks, []);
});

test('[K] an AWS secret access key containing "/" is scrubbed from model', async () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const leaks = [];
  for (const [field, read] of [['model', storedModels], ['provider', storedProviders]]) {
    const { values } = await read(secret);
    for (const value of values) if (containsSecret(value.replace(/\//g, ''), secret.replace(/\//g, ''), 10)) leaks.push({ field, stored: value });
  }
  assert.deepEqual(leaks, []);
});

test('[K] an AWS access key ID (AKIA...) is scrubbed from model and provider', async () => {
  const leaks = [];
  for (const input of ['AKIAIOSFODNN7EXAMPLE', 'bedrock/AKIAIOSFODNN7EXAMPLE']) {
    for (const [field, read] of [['model', storedModels], ['provider', storedProviders]]) {
      const { values } = await read(input);
      for (const value of values) if (value.includes('IOSFODNN7EXAMPLE')) leaks.push({ field, input, stored: value });
    }
  }
  assert.deepEqual(leaks, []);
});

test('[K] Replicate version IDs (owner/model:<64 hex>) are kept as model IDs', { todo: 'spec trade-off: any token of 32 or more characters is treated as a key' }, async () => {
  const id = 'replicate/meta/llama-2-70b-chat:02e509c789964a7ea8736978a43525956ef40397be9033abf9fd2badfe68c9e3';
  const { values } = await storedModels(id);
  assert.deepEqual(values, [id.slice(0, 64)]);
});

test('[6] a value containing arn: anywhere stores only what follows the last / or :', async () => {
  const expected = {
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-7': 'us.anthropic.claude-3-7',
    'bedrock/arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/x': 'x',
    'sagemaker_chat/arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-endpoint': 'my-endpoint',
    'ARN:aws:bedrock:us-east-1:123456789012:custom-model/x': 'x',
    'bedrock:arn:aws:bedrock:us-east-1:123456789012:custom-model/x': 'x',
  };
  const wrong = [];
  for (const [input, want] of Object.entries(expected)) {
    const { values } = await storedModels(input);
    if (values.some(value => value !== want)) wrong.push({ input, want, values });
  }
  assert.deepEqual(wrong, []);
});

// ── Round 2: user scoping ───────────────────────────────────────────────────────────────────

test('[U] another user\'s task events with the same run_id leave the first user\'s task row untouched', async () => {
  const db = database();
  const run = 'run-shared-0000000001';
  await ingestTelemetry(db, { event: 'session_start' }, fields());
  await ingestTelemetry(db, { event: 'task_started', run_id: run }, fields({ now: at(1) }));
  await ingestTelemetry(db, { event: 'task_finished', run_id: run, outcome: 'completed', active_seconds: 5, first_response_ms: 100 }, fields({ now: at(2) }));
  const before = rows(db, 'SELECT * FROM task_runs');
  await ingestTelemetry(db, { event: 'task_started', run_id: run }, fields({ userId: USER_B, sessionId: 'session-b-1', now: at(0) }));
  await ingestTelemetry(db, { event: 'task_finished', run_id: run, outcome: 'failed', active_seconds: 500, first_response_ms: 9 },
    fields({ userId: USER_B, sessionId: 'session-b-1', now: at(3) }));
  assert.deepEqual(rows(db, 'SELECT * FROM task_runs'), before);
  const result = await stats(db);
  assert.equal(result.error_stats.total_errors, 0);
  db.sqlite.close();
});

test('[U][5] session-keyed panel lookups (error totals, waterfall counts) ignore another user\'s events in the same session_id', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_start' }, fields());
  await ingestTelemetry(db, { event: 'session_end', had_error: true }, fields({ now: at(1) }));
  await ingestTelemetry(db, { event: 'task_finished', run_id: 'run-other-user-000001', outcome: 'completed', active_seconds: 1 }, fields({ userId: USER_B, now: at(2) }));
  await ingestTelemetry(db, { event: 'feature_use', feature_name: 'waterfall_manual' }, fields({ userId: USER_B, now: at(3) }));
  const result = await stats(db);
  const mine = result.recent_sessions.find(entry => entry.session_id === SESSION && entry.user_id === USER_A);
  assert.deepEqual({ error_sessions: result.error_stats.error_sessions, total_errors: result.error_stats.total_errors, waterfall: mine.session_waterfall_count },
    { error_sessions: 1, total_errors: 1, waterfall: 0 });
  db.sqlite.close();
});

// ── Round 2: newest-wins labels ─────────────────────────────────────────────────────────────

test('[N] an event exactly as new as the row replaces its labels', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_end' }, fields({ now: at(10), model: 'first-model', client: 'vscode' }));
  await ingestTelemetry(db, { event: 'session_end' }, fields({ now: at(10), model: 'second-model', client: 'tui' }));
  const [row] = endRows(db);
  assert.deepEqual([row.model, row.client], ['second-model', 'tui']);
  db.sqlite.close();
});

test('[N] an older event still raises the counts but leaves the newer labels and timestamp', async () => {
  const db = database();
  await ingestTelemetry(db, { event: 'session_end', turn_count: 1 }, fields({ now: at(30), model: 'newer-model', provider: 'openai', providerType: 'cloud', os: 'darwin' }));
  await ingestTelemetry(db, { event: 'session_end', turn_count: 9, had_error: true, duration_bucket: '30min+', tool_web_count: 4 },
    fields({ now: at(10), model: 'older-model', provider: 'ollama', providerType: 'local', os: 'linux' }));
  const [row] = endRows(db);
  assert.deepEqual([row.model, row.provider, row.provider_type, row.os, row.created_at, row.turn_count, row.had_error, row.duration_bucket, row.tool_web_count],
    ['newer-model', 'openai', 'cloud', 'darwin', at(30), 9, 1, '30min+', 4]);
  db.sqlite.close();
});

// ── Round 2: strict types ───────────────────────────────────────────────────────────────────

test('[T] a non-string event_id or run_id is rejected with 400 and stores nothing', async () => {
  const outcomes = [];
  for (const body of [
    { event: 'session_end', event_id: 1234567890123456789 }, { event: 'session_end', event_id: true }, { event: 'session_end', event_id: { id: 'evt-object-0000000001' } },
    { event: 'session_end', event_id: ['evt-array-0000000000001'] }, { event: 'feature_use', event_id: 12345678901234567 },
    { event: 'task_started', run_id: 1234567890123456 }, { event: 'task_started', run_id: true }, { event: 'task_finished', run_id: ['run-aaaaaaaaaaaaaaaa'], outcome: 'completed' },
    { event: 'task_started', run_id: { toString: 'run-aaaaaaaaaaaaaaaa' } },
  ]) {
    const db = database();
    const response = await post(db, '/event', { user_id: USER_A, session_id: SESSION, client: 'cli', ...body });
    outcomes.push({ body: JSON.stringify(body), status: response.status, users: rows(db, 'SELECT COUNT(*) n FROM users')[0].n });
    db.sqlite.close();
  }
  assert.deepEqual(outcomes.filter(outcome => outcome.status !== 400 || outcome.users !== 0), []);
});

test('[T] an empty or null event_id is treated as absent', async () => {
  const statuses = [];
  for (const event_id of ['', null]) {
    const db = database();
    statuses.push((await post(db, '/event', { event: 'session_end', user_id: USER_A, session_id: SESSION, client: 'cli', event_id })).status);
    statuses.push(endRows(db).length);
    db.sqlite.close();
  }
  assert.deepEqual(statuses, [202, 1, 202, 1]);
});

test('[T] had_error counts only for true, 1, "1" and "true"', async () => {
  const db = database();
  const cases = [[true, 1], [1, 1], ['1', 1], ['true', 1], ['TRUE', 0], ['True', 0], ['yes', 0], [2, 0], ['2', 0], ['false', 0], ['0', 0], [0, 0],
    [false, 0], [null, 0], [{}, 0], [[], 0], [[1], 0], [' true', 0], [-1, 0], [1.5, 0]];
  const wrong = [];
  for (const [index, [value, want]] of cases.entries()) {
    const sessionId = `session-flag-${index}`;
    await post(db, '/event', { event: 'session_end', user_id: USER_A, session_id: sessionId, client: 'cli', had_error: value });
    const [row] = endRows(db, sessionId);
    if (!row || row.had_error !== want) wrong.push({ had_error: value, want, stored: row?.had_error });
  }
  assert.deepEqual(wrong, []);
  db.sqlite.close();
});

// ── Round 2: collapse-session-end.sql ───────────────────────────────────────────────────────

function insertEnd(db, overrides = {}) {
  const row = { event: 'session_end', user_id: USER_A, session_id: SESSION, client: 'vscode', model: 'llama3:8b', turn_count: 0, had_error: 0,
    duration_bucket: '0-5min', tool_bash_count: 0, tool_file_count: 0, tool_web_count: 0, created_at: at(0), ...overrides };
  db.sqlite.prepare(`INSERT INTO events(event,user_id,session_id,client,os,version,provider,model,provider_type,turn_count,had_error,duration_bucket,
    tool_bash_count,tool_file_count,tool_web_count,created_at,date) VALUES (?,?,?,?,'linux','0.2.0','ollama',?,'local',?,?,?,?,?,?,?,?)`)
    .run(row.event, row.user_id, row.session_id, row.client, row.model, row.turn_count, row.had_error, row.duration_bucket,
      row.tool_bash_count, row.tool_file_count, row.tool_web_count, row.created_at, row.created_at.slice(0, 10));
}
const MERGE_ROWS = [
  { turn_count: 9, had_error: 1, duration_bucket: '30min+', tool_bash_count: 5, created_at: at(30), model: 'newest-model', client: 'tui' },
  { turn_count: 2, had_error: 0, duration_bucket: '5-15min', tool_file_count: 7, created_at: at(10), model: 'oldest-model' },
  { turn_count: 4, had_error: 0, duration_bucket: null, tool_web_count: 3, created_at: at(20), model: 'middle-model' },
];

test('[M] collapse-session-end.sql merges the maximum counts, keeps the error and the longest bucket', async () => {
  const db = database();
  for (const row of MERGE_ROWS) insertEnd(db, row);
  collapse(db);
  const stored = endRows(db);
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].turn_count, stored[0].had_error, stored[0].duration_bucket, stored[0].tool_bash_count, stored[0].tool_file_count, stored[0].tool_web_count],
    [9, 1, '30min+', 5, 7, 3]);
  db.sqlite.close();
});

test('[M] the row collapse-session-end.sql keeps carries the latest created_at and date and the newest event\'s labels, as live merging does', async () => {
  const db = database();
  for (const row of MERGE_ROWS) insertEnd(db, row);
  collapse(db);
  const [row] = endRows(db);
  assert.deepEqual([row.created_at, row.date, row.model, row.client], [at(30), at(30).slice(0, 10), 'newest-model', 'tui']);
  db.sqlite.close();
});

test('[M] collapse-session-end.sql leaves other users, other event types and single-row sessions untouched', async () => {
  const db = database();
  insertEnd(db, { turn_count: 1 });
  insertEnd(db, { turn_count: 2 });
  insertEnd(db, { user_id: USER_B, turn_count: 50, had_error: 1, duration_bucket: '30min+' });
  insertEnd(db, { user_id: USER_B, session_id: 'session-b-2', turn_count: 3 });
  insertEnd(db, { user_id: USER_B, session_id: 'session-b-2', turn_count: 4 });
  insertEnd(db, { event: 'compact_triggered', turn_count: 7 });
  insertEnd(db, { event: 'compact_triggered', turn_count: 8 });
  insertEnd(db, { session_id: 'session-single-1', turn_count: 6, duration_bucket: '15-30min' });
  db.sqlite.prepare(`INSERT INTO events(event,user_id,client,os,version,created_at,date) VALUES ('weekly_summary',?,'cli','linux','0.1.0',?,?)`).run(USER_A, at(0), at(0).slice(0, 10));
  db.sqlite.prepare(`INSERT INTO events(event,user_id,client,os,version,created_at,date) VALUES ('weekly_summary',?,'cli','linux','0.1.0',?,?)`).run(USER_A, at(1), at(1).slice(0, 10));
  const untouched = () => rows(db, `SELECT * FROM events WHERE event<>'session_end' OR (session_id=? AND user_id=?) OR session_id='session-single-1' ORDER BY id`, SESSION, USER_B);
  const before = untouched();
  collapse(db);
  assert.deepEqual(untouched(), before);
  assert.equal(endRows(db).length, 1);
  assert.equal(endRows(db)[0].turn_count, 2);
  assert.equal(endRows(db, 'session-b-2', USER_B).length, 1);
  assert.equal(endRows(db, 'session-b-2', USER_B)[0].turn_count, 4);
  db.sqlite.close();
});

test('[M] running collapse-session-end.sql twice changes nothing the second time', async () => {
  const db = database();
  for (const row of MERGE_ROWS) insertEnd(db, row);
  for (const row of MERGE_ROWS) insertEnd(db, { ...row, user_id: USER_B });
  insertEnd(db, { session_id: 'session-single-1' });
  collapse(db);
  const once = snapshot(db);
  collapse(db);
  assert.deepEqual(snapshot(db), once);
  db.sqlite.close();
});

test('[M] session_end rows with a NULL session_id are not merged into one', async () => {
  const db = database();
  insertEnd(db, { session_id: null, turn_count: 3, created_at: at(1) });
  insertEnd(db, { session_id: null, turn_count: 8, had_error: 1, created_at: at(2) });
  const before = rows(db, `SELECT * FROM events WHERE session_id IS NULL ORDER BY id`);
  collapse(db);
  assert.deepEqual(rows(db, `SELECT * FROM events WHERE session_id IS NULL ORDER BY id`), before);
  db.sqlite.close();
});

test('[M] collapse-session-end.sql finishes 10 000 duplicate rows across 2 000 sessions within 2 seconds', async () => {
  const db = database();
  db.sqlite.exec('BEGIN');
  for (let session = 0; session < 2000; session++) {
    for (let copy = 0; copy < 5; copy++) insertEnd(db, { session_id: `session-bulk-${session}`, turn_count: copy, created_at: at(copy) });
  }
  db.sqlite.exec('COMMIT');
  const started = performance.now();
  collapse(db);
  const ms = performance.now() - started;
  assert.equal(rows(db, `SELECT COUNT(*) n FROM events WHERE event='session_end'`)[0].n, 2000);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  db.sqlite.close();
});
