import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { computeD1Stats, getD1Stats } from './worker.js';
import { usageQueries, usageResults } from './usageStats.js';
import { ingestTelemetry } from './ingest.js';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const DAY = 86400000;
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const mondayOf = date => shift(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const zero = { total: 0, new: 0, week: 0, older: 0 };
const base = { client: 'vscode', os: 'windows', version: '0.2.24', country: 'US', provider: 'ollama', model: 'qwen', provider_type: 'local', profile: 'builder' };

// D1 stand-in over real SQLite. A pinned `now` replaces SQLite's clock so day and week edges are deterministic.
function database(now) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  const pin = sql => (now ? sql.replaceAll("'now'", `'${now}'`) : sql);
  const statements = [];
  return {
    sqlite, statements,
    prepare(sql) { return { bind: (...args) => ({ sql: pin(sql), args }) }; },
    async batch(list) {
      statements.push(...list);
      return list.map(statement => ({ results: sqlite.prepare(statement.sql).all(...statement.args) }));
    },
  };
}

function builder() {
  const world = { users: [], activity: [], sessions: [], tasks: [] };
  let serial = 0;
  const api = {
    world,
    user(id, firstSeen) { world.users.push({ id, firstSeen }); return api; },
    open(id, date, { session = `${id}-${date}`, ...dims } = {}) {
      world.activity.push({ ...base, ...dims, id, session, date }); return api;
    },
    session(id, date, { session = `${id}-${date}`, ...dims } = {}) {
      world.sessions.push({ ...base, ...dims, id, session, date }); return api;
    },
    turn(id, date, outcome, { session = `${id}-${date}`, at = '12:00:00', ...dims } = {}) {
      serial += 1;
      world.tasks.push({ ...base, ...dims, id, session, date, outcome,
        run: `run-${String(serial).padStart(4, '0')}-${id}`, startedAt: `${date}T${at}.${String(serial).padStart(3, '0')}Z` });
      return api;
    },
  };
  return api;
}

function load(db, world) {
  const insert = (sql, rows, values) => { const statement = db.sqlite.prepare(sql); for (const row of rows) statement.run(...values(row)); };
  insert('INSERT INTO users(user_id,first_seen,last_seen,country,session_count) VALUES (?,?,?,?,0)',
    world.users, u => [u.id, u.firstSeen, u.firstSeen, 'US']);
  insert(`INSERT OR IGNORE INTO activity_facts(user_id,session_id,date,client,os,version,country,provider,model,provider_type,profile,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, world.activity, row => {
    const a = { ...base, ...row };
    return [a.id, a.session, a.date, a.client, a.os, a.version, a.country, a.provider, a.model, a.provider_type, a.profile, `${a.date}T12:00:00.000Z`];
  });
  insert(`INSERT INTO sessions(session_id,user_id,client,country,os,version,provider,model,provider_type,created_at,date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, world.sessions, row => {
    const s = { ...base, ...row };
    return [s.session, s.id, s.client, s.country, s.os, s.version, s.provider, s.model, s.provider_type, `${s.date}T12:00:00.000Z`, s.date];
  });
  insert(`INSERT INTO task_runs(run_id,user_id,session_id,client,version,provider,model,started_at,finished_at,outcome,active_seconds,date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, world.tasks, row => {
    const t = { ...base, ...row };
    return [t.run, t.id, t.session, t.client, t.version, t.provider, t.model, t.startedAt, t.outcome ? t.startedAt : null,
      t.outcome ?? null, t.outcome ? 4 : null, t.date];
  });
}

function seeded(now, build) {
  const db = database(now);
  const b = builder();
  build(b);
  load(db, b.world);
  return db;
}

const stats = (db, query = '') => computeD1Stats({ DB: db }, new URLSearchParams(query));

test('usage_daily covers the last 30 UTC days, newest first, with empty days as zeros', async () => {
  const db = seeded('2026-11-01 12:00:00', b => b
    .user('user-mid', '2026-10-20T09:00:00.000Z').open('user-mid', '2026-10-20')
    .user('user-edge', '2026-09-01T00:00:00.000Z')
    .open('user-edge', '2026-10-02').open('user-edge', '2026-10-03').open('user-edge', '2026-11-02'));
  const { usage_daily } = await stats(db);
  assert.deepEqual(usage_daily.map(day => day.date), Array.from({ length: 30 }, (_, i) => shift('2026-11-01', -i)));
  for (const day of usage_daily) {
    if (day.date === '2026-10-20') assert.deepEqual(day.opened, { total: 1, new: 1, week: 0, older: 0 });
    else if (day.date === '2026-10-03') assert.deepEqual(day.opened, { total: 1, new: 0, week: 0, older: 1 });
    else assert.deepEqual(day.opened, zero, day.date);
    assert.deepEqual(day.used, zero, day.date);
  }
});

test('opened and used split users by install age at the 0, 1, 6 and 7 day edges', async () => {
  const today = '2026-11-01';
  const db = seeded(`${today} 12:00:00`, b => b
    .user('new-midnight', '2026-11-01T00:00:00.000Z').open('new-midnight', today).turn('new-midnight', today, 'completed')
    .user('new-late', '2026-11-01T23:59:59.999Z').open('new-late', today)
    .user('week-1', '2026-10-31T23:59:59.999Z').open('week-1', today).session('week-1', today)
    .user('week-6-legacy', '2026-10-26 00:00:00').open('week-6-legacy', today)
    .user('older-7', '2026-10-25T23:59:59.999Z').open('older-7', today).turn('older-7', today, null)
    .user('older-busy', '2020-01-01T00:00:00.000Z')
    .open('older-busy', today, { session: 'busy-a' }).open('older-busy', today, { session: 'busy-a', client: 'cli' })
    .open('older-busy', today, { session: 'busy-b' })
    .session('older-busy', today, { session: 'busy-a' }).session('older-busy', today, { session: 'busy-b' })
    .turn('older-busy', today, 'failed', { session: 'busy-a' }).turn('older-busy', today, 'completed', { session: 'busy-b' })
    .user('ghost', '2026-10-01T00:00:00.000Z').open('ghost', '2026-10-31')
    .session('ghost', today).turn('ghost', today, 'completed'));
  const { usage_daily: [current, previous] } = await stats(db);
  assert.equal(current.date, today);
  assert.deepEqual(current.opened, { total: 6, new: 2, week: 2, older: 2 });
  assert.deepEqual(current.used, { total: 4, new: 1, week: 1, older: 2 });
  assert.equal(previous.date, '2026-10-31');
  assert.deepEqual(previous.opened, { total: 1, new: 0, week: 0, older: 1 });
  assert.deepEqual(previous.used, zero);
});

test('opened counts a user who has activity but no users row, matching summary.today.dau', async () => {
  const today = '2026-11-01';
  const db = seeded(`${today} 12:00:00`, b => b
    .user('known-user', '2026-10-01T00:00:00.000Z').open('known-user', today)
    .open('orphan-user', today).turn('orphan-user', today, 'completed'));
  const result = await stats(db);
  assert.equal(result.summary.today.dau, 2);
  const [row] = result.usage_daily;
  assert.equal(row.opened.total, result.summary.today.dau);
  assert.equal(row.used.total, 1);
  assert.equal(row.opened.new + row.opened.week + row.opened.older, row.opened.total);
});

test('timeRange trims usage_daily to 30, 7 or 1 days and leaves cohorts and turn reliability alone', async () => {
  const today = '2026-11-01';
  const db = seeded(`${today} 12:00:00`, b => b
    .user('early-user', '2026-10-12T10:00:00.000Z').open('early-user', '2026-10-12').turn('early-user', '2026-10-12', 'failed')
    .user('week-user', '2026-10-27T10:00:00.000Z').open('week-user', '2026-10-27').open('week-user', today).session('week-user', today)
    .user('fresh-user', '2026-11-01T10:00:00.000Z').open('fresh-user', today).turn('fresh-user', today, 'completed'));
  const all = await stats(db);
  assert.equal(all.usage_daily.length, 30);
  assert.equal(all.turn_reliability.last_30d.failed_turns, 1);
  assert.equal(all.cohorts.find(c => c.week_start === '2026-10-12').installs, 1);
  for (const [range, length, oldest] of [['30d', 30, '2026-10-03'], ['7d', 7, '2026-10-26'], ['today', 1, today]]) {
    const ranged = await stats(db, `timeRange=${range}`);
    assert.equal(ranged.usage_daily.length, length, range);
    assert.equal(ranged.usage_daily[0].date, today, range);
    assert.equal(ranged.usage_daily.at(-1).date, oldest, range);
    assert.deepEqual(ranged.usage_daily, all.usage_daily.slice(0, length), range);
    assert.deepEqual(ranged.cohorts, all.cohorts, range);
    assert.deepEqual(ranged.turn_reliability, all.turn_reliability, range);
  }
});

test('an unknown timeRange is rejected before any query runs', async () => {
  const db = database();
  await assert.rejects(getD1Stats({ DB: db }, new URLSearchParams('timeRange=yesterday')), /Invalid time range/);
  assert.equal(db.statements.length, 0);
  const response = await worker.fetch(new Request('https://telemetry.test/api/stats?timeRange=90d', {
    headers: { 'x-stats-key': 'read-secret' },
  }), { DB: db, STATS_SECRET: 'read-secret' }, { waitUntil() {} });
  assert.ok(response.status >= 400);
  assert.equal((await response.json()).usage_daily, undefined);
});

test('timeRange values named after Object.prototype members are rejected like any other unknown range', async () => {
  for (const range of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await assert.rejects(getD1Stats({ DB: database() }, new URLSearchParams({ timeRange: range })), /Invalid time range/, range);
  }
});

test('dimension and exclusion filters scope opened, used, cohorts and turn reliability', async () => {
  const today = '2026-11-01';
  const db = seeded(`${today} 12:00:00`, b => b
    .user('vs-user', '2026-11-01T08:00:00.000Z').open('vs-user', today, { country: 'IN' }).turn('vs-user', today, 'completed')
    .user('cli-user', '2026-11-01T08:00:00.000Z').open('cli-user', today, { client: 'cli' }).turn('cli-user', today, 'failed', { client: 'cli' })
    .user('both-user', '2026-10-01T08:00:00.000Z')
    .open('both-user', '2026-10-01', { session: 'both-vs' }).open('both-user', today, { session: 'both-vs' })
    .open('both-user', today, { session: 'both-cli', client: 'cli' })
    .session('both-user', today, { session: 'both-cli', client: 'cli' })
    .turn('both-user', today, 'completed', { session: 'both-cli', client: 'cli' }));
  const usage = async query => { const result = await stats(db, query); return [result.usage_daily[0].opened, result.usage_daily[0].used]; };
  const one = { total: 1, new: 1, week: 0, older: 0 };
  const two = { total: 2, new: 1, week: 0, older: 1 };
  assert.deepEqual(await usage(''), [{ total: 3, new: 2, week: 0, older: 1 }, { total: 3, new: 2, week: 0, older: 1 }]);
  assert.deepEqual(await usage('client=vscode'), [two, one]);
  assert.deepEqual(await usage('excludeClient=vscode'), [two, two]);
  assert.deepEqual(await usage('client=cli&country=US'), [two, two]);
  assert.deepEqual(await usage('country=IN'), [one, one]);
  assert.deepEqual(await usage('excludeCountry=US'), [one, one]);

  const vscode = await stats(db, 'client=vscode');
  assert.deepEqual(vscode.turn_reliability.last_7d, { turns: 1, finished_turns: 1, failed_turns: 0, failure_rate: 0,
    sessions: 1, last_turn_failed_sessions: 0, last_turn_failure_rate: 0 });
  assert.deepEqual(vscode.cohorts.find(c => c.week_start === '2026-10-26'),
    { week_start: '2026-10-26', installs: 1, used: 1, came_back: 0, used_after_7d: null, used_after_14d: null });
  assert.deepEqual(vscode.cohorts.find(c => c.week_start === '2026-09-28'),
    { week_start: '2026-09-28', installs: 1, used: 0, came_back: 0, used_after_7d: 0, used_after_14d: 0 });

  const cli = await stats(db, 'client=cli');
  assert.deepEqual(cli.turn_reliability.last_7d, { turns: 2, finished_turns: 2, failed_turns: 1, failure_rate: 50,
    sessions: 2, last_turn_failed_sessions: 1, last_turn_failure_rate: 50 });
  assert.deepEqual(cli.cohorts.find(c => c.week_start === '2026-10-26'),
    { week_start: '2026-10-26', installs: 1, used: 1, came_back: 0, used_after_7d: null, used_after_14d: null });
  assert.deepEqual(cli.cohorts.find(c => c.week_start === '2026-09-28'),
    { week_start: '2026-09-28', installs: 1, used: 1, came_back: 1, used_after_7d: 1, used_after_14d: 1 });

  const ranged = await stats(db, 'client=cli&timeRange=today');
  assert.deepEqual(ranged.cohorts, cli.cohorts);
  assert.deepEqual(ranged.turn_reliability, cli.turn_reliability);
});

test('hostile filter values are bound as data, match nothing and leave the schema intact', async () => {
  const today = '2026-11-01';
  const db = seeded(`${today} 12:00:00`, b => b
    .user('vs-user', '2026-11-01T08:00:00.000Z').open('vs-user', today).turn('vs-user', today, 'failed'));
  const hostile = [['client', "vscode' OR '1'='1"], ['country', "US'); DROP TABLE users; --"], ['model', '?'], ['provider', '%'],
    ['version', '0.2.24" OR ""="'], ['os', 'windows\u0000']];
  for (const [key, value] of hostile) {
    db.statements.length = 0;
    const result = await stats(db, new URLSearchParams({ [key]: value }).toString());
    assert.deepEqual(result.usage_daily[0].opened, zero, key);
    assert.equal(result.cohorts.reduce((n, c) => n + c.installs, 0), 0, key);
    assert.equal(result.turn_reliability.last_30d.turns, 0, key);
    const usageStatements = db.statements.filter(s => /prompt_days|last_prompt|ROW_NUMBER\(\) OVER \(PARTITION BY user_id/.test(s.sql));
    assert.equal(usageStatements.length, 3, key);
    for (const statement of usageStatements) {
      if (value.length > 3) assert.ok(!statement.sql.includes(value), `${key} reached SQL text`);
      assert.ok(statement.args.includes(value), `${key} was not bound`);
    }
  }
  const excluded = await stats(db, new URLSearchParams({ excludeOS: "windows' OR 1=1 --" }).toString());
  assert.equal(excluded.usage_daily[0].opened.total, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  await assert.rejects(stats(db, `client=${'x'.repeat(97)}`), /Invalid filter/);
  assert.deepEqual((await stats(db, `client=${'x'.repeat(96)}`)).usage_daily[0].opened, zero);
});

test('cohorts are eight Monday-start UTC weeks with install, return and after-N-day counts', async () => {
  const db = seeded('2026-11-01 12:00:00', b => b
    .user('sunday-install', '2026-10-25T23:59:59.999Z').open('sunday-install', '2026-10-25')
    .user('monday-install', '2026-10-26T00:00:00.000Z').open('monday-install', '2026-10-26')
    .user('legacy-format', '2026-10-26 08:00:00').open('legacy-format', '2026-10-26')
    .user('oldest-week', '2026-09-07T00:00:00.000Z').open('oldest-week', '2026-09-07')
    .user('too-old', '2026-09-06T23:59:59.999Z').open('too-old', '2026-09-06').open('too-old', '2026-10-30').turn('too-old', '2026-10-30', 'completed')
    .user('never-used', '2026-10-05T09:00:00.000Z').open('never-used', '2026-10-05')
    .user('same-day', '2026-10-05T09:00:00.000Z').open('same-day', '2026-10-05').turn('same-day', '2026-10-05', 'completed')
    .user('next-day', '2026-10-05T23:00:00.000Z').open('next-day', '2026-10-05').open('next-day', '2026-10-06').turn('next-day', '2026-10-06', 'failed')
    .user('day-seven', '2026-10-05T09:00:00.000Z').open('day-seven', '2026-10-05').open('day-seven', '2026-10-12').session('day-seven', '2026-10-12')
    .user('day-fourteen', '2026-10-11T22:00:00.000Z').open('day-fourteen', '2026-10-11').open('day-fourteen', '2026-10-25').turn('day-fourteen', '2026-10-25', null)
    .user('day-six', '2026-10-11T22:00:00.000Z').open('day-six', '2026-10-11').open('day-six', '2026-10-17').turn('day-six', '2026-10-17', 'completed')
    .user('opened-only', '2026-10-05T09:00:00.000Z').open('opened-only', '2026-10-05').open('opened-only', '2026-10-20'));
  const { cohorts } = await stats(db);
  const row = (week_start, installs, used, came_back, used_after_7d, used_after_14d) =>
    ({ week_start, installs, used, came_back, used_after_7d, used_after_14d });
  assert.deepEqual(cohorts, [
    row('2026-10-26', 2, 0, 0, null, null),
    row('2026-10-19', 1, 0, 0, null, null),
    row('2026-10-12', 0, 0, 0, 0, null),
    row('2026-10-05', 7, 5, 4, 2, 1),
    row('2026-09-28', 0, 0, 0, 0, 0),
    row('2026-09-21', 0, 0, 0, 0, 0),
    row('2026-09-14', 0, 0, 0, 0, 0),
    row('2026-09-07', 1, 0, 0, 0, 0),
  ]);
});

test('after-7 and after-14 day counts stay null until the last possible install day of the week is that old', async () => {
  const build = b => b
    .user('sunday-install', '2026-10-25T23:59:59.999Z').open('sunday-install', '2026-10-25')
    .open('sunday-install', '2026-11-01').turn('sunday-install', '2026-11-01', 'completed')
    .user('mid-october', '2026-10-12T10:00:00.000Z').open('mid-october', '2026-10-12')
    .open('mid-october', '2026-10-26').turn('mid-october', '2026-10-26', 'completed');
  const sunday = (await stats(seeded('2026-11-01 23:59:59', build))).cohorts;
  const monday = (await stats(seeded('2026-11-02 00:00:00', build))).cohorts;
  const week = (cohorts, start) => cohorts.find(c => c.week_start === start);
  assert.deepEqual(sunday.map(c => c.week_start), Array.from({ length: 8 }, (_, i) => shift('2026-10-26', -7 * i)));
  assert.deepEqual(monday.map(c => c.week_start), Array.from({ length: 8 }, (_, i) => shift('2026-11-02', -7 * i)));
  assert.deepEqual([week(sunday, '2026-10-19').used_after_7d, week(monday, '2026-10-19').used_after_7d], [null, 1]);
  assert.deepEqual([week(sunday, '2026-10-12').used_after_14d, week(monday, '2026-10-12').used_after_14d], [null, 1]);
  assert.equal(week(monday, '2026-10-19').used_after_14d, null);
  assert.equal(week(monday, '2026-10-26').used_after_7d, null);
  assert.equal(week(monday, '2026-11-02').used_after_7d, null);
});

test('install-age buckets and install weeks stay correct across a year boundary', async () => {
  const db = seeded('2027-01-01 00:30:00', b => b
    .user('dec-31', '2026-12-31T23:59:59.999Z').open('dec-31', '2027-01-01')
    .user('dec-26', '2026-12-26T00:00:00.000Z').open('dec-26', '2027-01-01')
    .user('dec-25', '2026-12-25T23:59:59.999Z').open('dec-25', '2027-01-01')
    .user('jan-1', '2027-01-01T00:10:00.000Z').open('jan-1', '2027-01-01').turn('jan-1', '2027-01-01', 'completed'));
  const result = await stats(db);
  assert.deepEqual(result.usage_daily[0], { date: '2027-01-01',
    opened: { total: 4, new: 1, week: 2, older: 1 }, used: { total: 1, new: 1, week: 0, older: 0 } });
  assert.equal(result.usage_daily.at(-1).date, '2026-12-03');
  assert.deepEqual(result.cohorts.slice(0, 2).map(c => [c.week_start, c.installs]), [['2026-12-28', 2], ['2026-12-21', 2]]);
});

test('turn reliability counts turns, failures and sessions whose latest finished turn failed', async () => {
  const db = seeded('2026-11-01 12:00:00', b => {
    const turn = (user, session, date, at, outcome) => b.turn(user, date, outcome, { session, at });
    turn('user-a', 's1', '2026-11-01', '09:00:00', 'completed'); turn('user-a', 's1', '2026-11-01', '10:00:00', 'failed');
    turn('user-a', 's2', '2026-10-31', '09:00:00', 'failed'); turn('user-a', 's2', '2026-10-31', '10:00:00', 'completed');
    turn('user-b', 's3', '2026-10-30', '09:00:00', 'failed'); turn('user-b', 's3', '2026-10-30', '11:00:00', null);
    turn('user-b', 's4', '2026-10-26', '09:00:00', 'cancelled'); turn('user-b', 's4', '2026-10-26', '10:00:00', 'completed');
    turn('user-c', 's5', '2026-10-25', '09:00:00', 'failed');
    turn('user-c', 's6', '2026-10-03', '09:00:00', 'completed'); turn('user-c', 's6', '2026-10-03', '10:00:00', 'completed');
    turn('user-c', 's7', '2026-10-02', '09:00:00', 'failed');
    turn('user-d', 's8', '2026-10-20', '09:00:00', 'failed'); turn('user-d', 's8', '2026-10-28', '09:00:00', 'completed');
    turn('user-d', 's9', '2026-10-24', '09:00:00', 'completed'); turn('user-d', 's9', '2026-10-27', '09:00:00', 'failed');
    turn('user-e', 'shared', '2026-11-01', '08:00:00', 'failed');
    turn('user-f', 'shared', '2026-11-01', '08:00:00', 'completed');
    turn('user-g', 's11', '2026-10-10', '12:00:00', null);
    turn('user-i', 's13', '2026-10-15', '12:00:00', 'failed');
  });
  const { turn_reliability: reliability } = await stats(db);
  assert.deepEqual(reliability.last_7d, { turns: 12, finished_turns: 11, failed_turns: 5, failure_rate: 45.5,
    sessions: 8, last_turn_failed_sessions: 4, last_turn_failure_rate: 50 });
  assert.deepEqual(reliability.last_30d, { turns: 19, finished_turns: 17, failed_turns: 8, failure_rate: 47.1,
    sessions: 11, last_turn_failed_sessions: 6, last_turn_failure_rate: 54.5 });
  assert.deepEqual(reliability.daily.map(day => day.date), Array.from({ length: 30 }, (_, i) => shift('2026-11-01', -i)));
  const day = date => reliability.daily.find(d => d.date === date);
  assert.deepEqual(day('2026-11-01'), { date: '2026-11-01', turns: 4, finished_turns: 4, failed_turns: 2, failure_rate: 50 });
  assert.deepEqual(day('2026-10-30'), { date: '2026-10-30', turns: 2, finished_turns: 1, failed_turns: 1, failure_rate: 100 });
  assert.deepEqual(day('2026-10-10'), { date: '2026-10-10', turns: 1, finished_turns: 0, failed_turns: 0, failure_rate: null });
  assert.deepEqual(day('2026-10-03'), { date: '2026-10-03', turns: 2, finished_turns: 2, failed_turns: 0, failure_rate: 0 });
  assert.deepEqual(day('2026-10-29'), { date: '2026-10-29', turns: 0, finished_turns: 0, failed_turns: 0, failure_rate: null });
});

test('an empty database yields zero-filled series and null rates instead of errors', async () => {
  const result = await stats(database('2026-11-01 12:00:00'));
  assert.equal(result.usage_daily.length, 30);
  assert.ok(result.usage_daily.every(day => day.opened.total === 0 && day.used.total === 0));
  assert.equal(result.cohorts.length, 8);
  assert.ok(result.cohorts.every(c => c.installs === 0 && c.used === 0 && c.came_back === 0));
  const empty = { turns: 0, finished_turns: 0, failed_turns: 0, failure_rate: null, sessions: 0, last_turn_failed_sessions: 0, last_turn_failure_rate: null };
  assert.deepEqual(result.turn_reliability.last_7d, empty);
  assert.deepEqual(result.turn_reliability.last_30d, empty);
  assert.equal(result.turn_reliability.daily.length, 30);
  assert.ok(result.turn_reliability.daily.every(day => day.failure_rate === null));
});

test('recent sessions report turns, failed turns and whether the latest finished turn failed, also from cache', async () => {
  const db = database();
  const date = new Date().toISOString().slice(0, 10);
  const fields = (userId, sessionId, time) => ({ userId, sessionId, client: 'vscode', os: 'windows', version: '0.2.24',
    country: 'US', provider: 'ollama', model: 'qwen', providerType: 'local', profile: 'builder', reasoningEffort: 'off',
    mcpToolsCount: 0, now: `${date}T${time}.000Z`, date });
  const start = (userId, sessionId, time) => ingestTelemetry(db, { event: 'session_start' }, fields(userId, sessionId, time));
  const turn = async (userId, sessionId, runId, started, finished, outcome) => {
    await ingestTelemetry(db, { event: 'task_started', run_id: runId }, fields(userId, sessionId, started));
    if (outcome) await ingestTelemetry(db, { event: 'task_finished', run_id: runId, outcome, active_seconds: 3 }, fields(userId, sessionId, finished));
  };
  await start('user-quiet-01', 'session-clean', '00:00:01');
  await start('user-quiet-01', 'session-open', '00:00:02');
  await turn('user-quiet-01', 'session-open', 'run-open-0000000001', '00:00:03', null, null);
  await start('user-recov-01', 'session-recovered', '00:00:04');
  await turn('user-recov-01', 'session-recovered', 'run-recovered-00001', '00:00:05', '00:00:06', 'failed');
  await turn('user-recov-01', 'session-recovered', 'run-recovered-00002', '00:00:07', '00:00:08', 'completed');
  await start('user-broke-01', 'session-broken', '00:00:09');
  await turn('user-broke-01', 'session-broken', 'run-broken-00000001', '00:00:10', '00:00:11', 'completed');
  await turn('user-broke-01', 'session-broken', 'run-broken-00000002', '00:00:12', '00:00:13', 'failed');
  await turn('user-broke-01', 'session-broken', 'run-broken-00000003', '00:00:14', null, null);
  await start('user-cancel-1', 'session-cancelled', '00:00:15');
  await turn('user-cancel-1', 'session-cancelled', 'run-cancel-00000001', '00:00:16', '00:00:17', 'failed');
  await turn('user-cancel-1', 'session-cancelled', 'run-cancel-00000002', '00:00:18', '00:00:19', 'cancelled');
  await start('user-owner-01', 'session-shared', '00:00:31');
  await turn('user-other-01', 'session-shared', 'run-other-00000001', '00:00:32', '00:00:33', 'failed');
  const fresh = await getD1Stats({ DB: db });
  const cached = await getD1Stats({ DB: db });
  assert.equal(fresh.cache.hit, false);
  assert.equal(cached.cache.hit, true);
  for (const result of [fresh, cached]) {
    const view = id => {
      const session = result.recent_sessions.find(s => s.session_id === id);
      return { turns: session.turns, failed_turns: session.failed_turns, last_turn_failed: session.last_turn_failed, had_error: session.had_error };
    };
    assert.deepEqual(view('session-clean'), { turns: 0, failed_turns: 0, last_turn_failed: null, had_error: 0 });
    assert.deepEqual(view('session-open'), { turns: 1, failed_turns: 0, last_turn_failed: null, had_error: 0 });
    assert.deepEqual(view('session-recovered'), { turns: 2, failed_turns: 1, last_turn_failed: false, had_error: 1 });
    assert.deepEqual(view('session-broken'), { turns: 3, failed_turns: 1, last_turn_failed: true, had_error: 1 });
    assert.deepEqual(view('session-cancelled'), { turns: 2, failed_turns: 1, last_turn_failed: false, had_error: 1 });
    assert.deepEqual(view('session-shared'), { turns: 0, failed_turns: 0, last_turn_failed: null, had_error: 0 });
  }
});

test('snapshots cached under older stats versions are not served', async () => {
  const db = database();
  const day = new Date().toISOString().slice(0, 10);
  for (const version of ['stats-v10', 'stats-v11']) {
    db.sqlite.prepare('INSERT INTO telemetry_stats_cache(cache_key,payload,expires_at) VALUES (?,?,?)')
      .run(`${version}:${day}:`, JSON.stringify({ summary: { total_users: 999 } }), Math.floor(Date.now() / 1000) + 3600);
  }
  const result = await getD1Stats({ DB: db });
  assert.equal(result.cache.hit, false);
  assert.equal(result.summary.total_users, 0);
  assert.ok(Array.isArray(result.usage_daily));
  assert.ok(Array.isArray(result.cohorts));
  assert.ok(result.turn_reliability.last_7d);
});

test('the stats endpoint keeps every field the previous API returned', async () => {
  const db = database();
  const date = new Date().toISOString().slice(0, 10);
  const fields = { userId: 'user-compat-01', sessionId: 'session-compat', client: 'vscode', os: 'windows', version: '0.2.24',
    country: 'US', provider: 'ollama', model: 'qwen', providerType: 'local', profile: 'builder', reasoningEffort: 'off',
    mcpToolsCount: 0, now: new Date().toISOString(), date };
  await ingestTelemetry(db, { event: 'session_start' }, fields);
  await ingestTelemetry(db, { event: 'task_started', run_id: 'run-compat-00000001' }, fields);
  await ingestTelemetry(db, { event: 'task_finished', run_id: 'run-compat-00000001', outcome: 'failed' }, fields);
  await ingestTelemetry(db, { event: 'session_end', had_error: true }, fields);
  const response = await worker.fetch(new Request('https://telemetry.test/api/stats', { headers: { 'x-stats-key': 'read-secret' } }),
    { DB: db, STATS_SECRET: 'read-secret' }, { waitUntil() {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  for (const key of ['window_activity', 'adoption', 'cohort_health', 'retention', 'task_outcomes', 'measurement_version', 'coverage',
    'filters', 'summary', 'daily', 'clients', 'countries', 'os', 'versions', 'hourly', 'recent_sessions', 'user_distribution',
    'providers', 'models', 'provider_types', 'reasoning_efforts', 'duration_buckets', 'profiles', 'features', 'turn_distribution',
    'onboarding_funnel', 'error_stats', 'cron_stats', 'mascot_stats', 'wallpaper_stats', 'settings_tabs', 'waterfall_stats',
    'work_intent', 'updated_at', 'query_cost', 'cache', 'usage_daily', 'cohorts', 'turn_reliability']) {
    assert.ok(key in body, key);
  }
  assert.deepEqual(Object.keys(body.summary.today).sort(), ['dau', 'new_users', 'returning_users', 'session_users', 'sessions']);
  assert.equal(body.daily[0].dau, 1);
  const [session] = body.recent_sessions;
  for (const key of ['session_id', 'user_prefix', 'user_id', 'client', 'os', 'version', 'country', 'provider', 'model',
    'provider_type', 'reasoning_effort', 'mcp_tools_count', 'profile', 'duration_seconds', 'turn_count', 'had_error',
    'error_categories', 'duration_bucket', 'tool_bash_count', 'tool_file_count', 'tool_web_count', 'total_tools_count',
    'session_waterfall_count', 'user_waterfall_total', 'created_at']) {
    assert.ok(key in session, key);
  }
  assert.equal(session.had_error, 1);
  assert.equal(session.last_turn_failed, true);
  assert.equal(body.task_outcomes.failed, 1);
  assert.equal(body.error_stats.error_sessions, 1);
});

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWorld(today, seed) {
  const rand = prng(seed);
  const int = (low, high) => low + Math.floor(rand() * (high - low + 1));
  const pad = value => String(value).padStart(2, '0');
  const world = { users: [], activity: [], sessions: [], tasks: [] };
  let serial = 0;
  for (let index = 0; index < 60; index++) {
    const id = `user-${seed}-${index}`;
    const firstDay = shift(today, -int(0, 75));
    world.users.push({ id, firstSeen: `${firstDay}T${pad(int(0, 23))}:${pad(int(0, 59))}:${pad(int(0, 59))}.000Z` });
    for (const offset of [0, ...Array.from({ length: int(0, 6) }, () => int(0, 45))]) {
      const date = shift(firstDay, offset);
      if (date > today) continue;
      const session = `session-${seed}-${serial++}`;
      const client = rand() < 0.5 ? 'vscode' : 'cli';
      world.activity.push({ id, session, date, client });
      if (rand() < 0.3) world.sessions.push({ id, session, date, client });
      for (let turns = int(0, 3); turns > 0; turns--) {
        const day = rand() < 0.25 ? shift(date, 1) : date;
        if (day > today) continue;
        if (day !== date && rand() < 0.5) world.activity.push({ id, session, date: day, client });
        world.tasks.push({ id, session, date: day, client, run: `run-${seed}-${serial++}`,
          startedAt: `${day}T${pad(int(0, 23))}:${pad(int(0, 59))}:${pad(int(0, 59))}.${String(serial % 1000).padStart(3, '0')}Z`,
          outcome: [null, 'completed', 'completed', 'failed', 'cancelled'][int(0, 4)] });
      }
    }
  }
  return world;
}

function reference(world, today, client) {
  const finishedOutcomes = new Set(['completed', 'failed', 'cancelled']);
  const rate = (part, whole) => (whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : null);
  const activity = world.activity.filter(a => !client || a.client === client);
  const activityKeys = new Set(activity.map(a => `${a.id}|${a.session}|${a.date}`));
  const activitySessions = new Set(activity.map(a => a.session));
  const tasks = world.tasks.filter(t => !client || activityKeys.has(`${t.id}|${t.session}|${t.date}`));
  const sessions = world.sessions.filter(s => !client || activitySessions.has(s.session));
  const firstDay = new Map(world.users.map(u => [u.id, u.firstSeen.slice(0, 10)]));

  const promptDays = new Set([...tasks, ...sessions].map(p => `${p.date}|${p.id}`));
  const split = (ids, date) => {
    const parts = { total: ids.length, new: 0, week: 0, older: 0 };
    for (const id of ids) {
      const first = firstDay.get(id);
      parts[first >= date ? 'new' : first >= shift(date, -6) ? 'week' : 'older'] += 1;
    }
    return parts;
  };
  const usage_daily = Array.from({ length: 30 }, (_, i) => {
    const date = shift(today, -i);
    const opened = [...new Set(activity.filter(a => a.date === date).map(a => a.id))];
    return { date, opened: split(opened, date), used: split(opened.filter(id => promptDays.has(`${date}|${id}`)), date) };
  });

  const monday = mondayOf(today);
  const activeUsers = new Set(activity.map(a => a.id));
  const lastPrompt = new Map();
  for (const p of [...tasks, ...sessions]) if (!(lastPrompt.get(p.id) >= p.date)) lastPrompt.set(p.id, p.date);
  const cohorts = Array.from({ length: 8 }, (_, k) => {
    const week = shift(monday, -7 * k);
    const installs = world.users.filter(u => mondayOf(u.firstSeen.slice(0, 10)) === week && (!client || activeUsers.has(u.id)));
    const count = check => installs.filter(u => lastPrompt.has(u.id) && check(lastPrompt.get(u.id), u.firstSeen.slice(0, 10))).length;
    return {
      week_start: week,
      installs: installs.length,
      used: count(() => true),
      came_back: count((last, first) => last > first),
      used_after_7d: shift(week, 13) < today ? count((last, first) => last >= shift(first, 7)) : null,
      used_after_14d: shift(week, 20) < today ? count((last, first) => last >= shift(first, 14)) : null,
    };
  });

  const recent = tasks.filter(t => t.date >= shift(today, -29) && t.date <= today);
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = shift(today, -i);
    const day = recent.filter(t => t.date === date);
    const finished = day.filter(t => finishedOutcomes.has(t.outcome)).length;
    const failed = day.filter(t => t.outcome === 'failed').length;
    return { date, turns: day.length, finished_turns: finished, failed_turns: failed, failure_rate: rate(failed, finished) };
  });
  const latest = new Map();
  const order = t => `${t.date}|${t.startedAt}|${t.run}`;
  for (const t of recent.filter(t => finishedOutcomes.has(t.outcome))) {
    const key = `${t.id}|${t.session}`;
    if (!latest.has(key) || order(t) > order(latest.get(key))) latest.set(key, t);
  }
  const summary = days => {
    const dates = new Set(days.map(d => d.date));
    const sum = key => days.reduce((n, d) => n + d[key], 0);
    const ended = [...latest.values()].filter(t => dates.has(t.date));
    const failedEnds = ended.filter(t => t.outcome === 'failed').length;
    return { turns: sum('turns'), finished_turns: sum('finished_turns'), failed_turns: sum('failed_turns'),
      failure_rate: rate(sum('failed_turns'), sum('finished_turns')), sessions: ended.length,
      last_turn_failed_sessions: failedEnds, last_turn_failure_rate: rate(failedEnds, ended.length) };
  };
  return { usage_daily, cohorts, turn_reliability: { last_7d: summary(daily.slice(0, 7)), last_30d: summary(daily), daily } };
}

test('usage, cohorts and turn reliability match a reference model on random data around week, month and leap-year edges', async () => {
  const clocks = ['2026-11-01 12:00:00', '2026-11-02 00:00:00', '2026-11-08 23:59:59', '2027-01-01 00:30:00',
    '2028-02-29 18:00:00', '2028-03-01 06:00:00'];
  let seed = 1;
  for (const now of clocks) {
    for (let round = 0; round < 3; round++, seed++) {
      const today = now.slice(0, 10);
      const world = randomWorld(today, seed);
      const db = database(now);
      load(db, world);
      for (const client of [null, 'vscode']) {
        const params = new URLSearchParams(client ? { client } : {});
        const actual = usageResults(await db.batch(usageQueries(params, db)));
        const expected = reference(world, today, client);
        const label = `${now} seed ${seed} client ${client ?? 'all'}`;
        assert.deepEqual(actual.usage_daily, expected.usage_daily, `usage_daily ${label}`);
        assert.deepEqual(actual.cohorts, expected.cohorts, `cohorts ${label}`);
        assert.deepEqual(actual.turn_reliability, expected.turn_reliability, `turn_reliability ${label}`);
        for (const day of actual.usage_daily) {
          for (const part of ['total', 'new', 'week', 'older']) assert.ok(day.used[part] <= day.opened[part], `${label} ${day.date} ${part}`);
        }
      }
    }
  }
});
