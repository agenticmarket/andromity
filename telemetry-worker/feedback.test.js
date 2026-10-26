import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './worker.js';
import { ANNOYANCES, cleanFeedback, MAX_MESSAGE_LENGTH } from './feedback.js';

const SECRET = 'admin-secret-for-tests';

function d1({ checkIn = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./feedback.sql', import.meta.url), 'utf8'));
  if (checkIn) sqlite.exec(readFileSync(new URL('./feedback-checkin.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  return { sqlite, prepare: (sql) => statement(sql) };
}

function client(options) {
  const env = { DB: d1(options), ADMIN_SECRET: SECRET };
  const call = async (path, { method = 'GET', body, admin = false } = {}) => {
    const response = await worker.fetch(new Request(`https://telemetry.test${path}`, {
      method,
      headers: admin ? { 'x-stats-key': SECRET } : {},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }), env, {});
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  return { env, call };
}

test('a submitted note is stored without any user or session id', async () => {
  const { env, call } = client();
  const sent = await call('/feedback', {
    method: 'POST',
    body: { message: '  The waterfall view is great\r\nbut slow on big repos  ', client: 'vscode', os: 'windows', version: '0.2.23', user_id: 'abcdef1234567890' },
  });
  assert.equal(sent.status, 201);
  const rows = env.DB.sqlite.prepare('SELECT * FROM feedback').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, 'The waterfall view is great\nbut slow on big repos');
  assert.equal(rows[0].client, 'vscode');
  assert.equal(rows[0].country, 'XX');
  assert.ok(!('user_id' in rows[0]));
});

test('empty, oversized and malformed notes are rejected', async () => {
  const { env, call } = client();
  assert.equal((await call('/feedback', { method: 'POST', body: { message: '   ' } })).status, 400);
  assert.equal((await call('/feedback', { method: 'POST', body: { message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) } })).status, 400);
  assert.equal((await call('/feedback', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await call('/feedback', { method: 'POST', body: { message: 'x'.repeat(20000) } })).status, 413);
  assert.equal((await call('/feedback')).status, 405);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 0);
});

test('key-shaped strings are removed and unknown fields fall back', () => {
  const { values } = cleanFeedback({ message: 'my key sk-abcdefghijklmnopqrstuv broke', client: 'emacs', os: 'beos', version: '<script>' }, 'in');
  assert.equal(values.message, 'my key [removed] broke');
  assert.equal(values.client, 'unknown');
  assert.equal(values.os, 'unknown');
  assert.equal(values.version, 'script');
  assert.equal(values.country, 'IN');
});

test('reading and deleting notes needs the admin secret', async () => {
  const { call } = client();
  await call('/feedback', { method: 'POST', body: { message: 'first' } });
  await call('/feedback', { method: 'POST', body: { message: 'second' } });
  assert.equal((await call('/api/admin/feedback')).status, 401);
  const listed = await call('/api/admin/feedback', { admin: true });
  assert.deepEqual(listed.data.feedback.map((f) => f.message), ['second', 'first']);
  const id = listed.data.feedback[0].id;
  assert.equal((await call(`/api/admin/feedback/${id}/delete`, { method: 'POST' })).status, 401);
  assert.equal((await call(`/api/admin/feedback/${id}/delete`, { method: 'POST', admin: true })).status, 200);
  assert.equal((await call(`/api/admin/feedback/${id}/delete`, { method: 'POST', admin: true })).status, 404);
  assert.deepEqual((await call('/api/admin/feedback', { admin: true })).data.feedback.map((f) => f.message), ['first']);
});

test('a check-in stores the sentiment and annoyances, and may skip the note', async () => {
  const { env, call } = client();
  const love = await call('/feedback', { method: 'POST', body: { sentiment: 'love', client: 'vscode', os: 'linux', version: '0.2.25' } });
  assert.equal(love.status, 201);
  const bad = await call('/feedback', {
    method: 'POST',
    body: { sentiment: 'bad', annoyances: ['errors_limits', 'slow', 'slow'], message: 'limits hit daily, key ghp_abcdefghijklmnop1234 leaked', client: 'vscode' },
  });
  assert.equal(bad.status, 201);
  const rows = env.DB.sqlite.prepare('SELECT message, sentiment, annoyances FROM feedback ORDER BY id').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { message: '', sentiment: 'love', annoyances: null },
    { message: 'limits hit daily, key [removed] leaked', sentiment: 'bad', annoyances: 'slow,errors_limits' },
  ]);
  const listed = await call('/api/admin/feedback', { admin: true });
  assert.deepEqual(listed.data.feedback.map((f) => [f.sentiment, f.annoyances]), [['bad', 'slow,errors_limits'], ['love', null]]);
});

test('check-in answers outside the known choices are refused', async () => {
  const { env, call } = client();
  for (const body of [
    { sentiment: 'meh' },
    { sentiment: 'LOVE' },
    { sentiment: 1 },
    { sentiment: 'ok', annoyances: 'slow' },
    { sentiment: 'ok', annoyances: ['slow', 'drop table feedback'] },
    { sentiment: 'ok', annoyances: [...ANNOYANCES, 'slow'] },
    { sentiment: 'ok', annoyances: [{ id: 'slow' }] },
    { sentiment: 'ok', message: 42 },
    { annoyances: ['slow'] },
  ]) {
    assert.equal((await call('/feedback', { method: 'POST', body })).status, 400, JSON.stringify(body));
  }
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 0);
});

test('before the check-in migration runs, answers are kept inside the note', async () => {
  const { env, call } = client({ checkIn: false });
  assert.equal((await call('/feedback', { method: 'POST', body: { sentiment: 'bad', annoyances: ['slow', 'errors_limits'], message: 'too slow' } })).status, 201);
  assert.equal((await call('/feedback', { method: 'POST', body: { sentiment: 'love' } })).status, 201);
  assert.equal((await call('/feedback', { method: 'POST', body: { message: 'plain note' } })).status, 201);
  const rows = env.DB.sqlite.prepare('SELECT message FROM feedback ORDER BY id').all().map((r) => r.message);
  assert.deepEqual(rows, ['[check-in: bad; slow, errors_limits]\ntoo slow', '[check-in: love]', 'plain note']);
  const listed = await call('/api/admin/feedback', { admin: true });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.feedback.length, 3);
});
