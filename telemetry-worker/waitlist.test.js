import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './worker.js';
import { cleanFeedback } from './feedback.js';
import { HEARD_FROM, MAX_HEARD_NOTE, MAX_WANTS_NOTE, WANTS } from './waitlist.js';

const SECRET = 'admin-secret-for-waitlist-tests';
const STATS_KEY = 'stats-only-key-for-waitlist-tests';
const ALL_TABLES = ['schema.sql', 'feedback.sql', 'feedback-checkin.sql', 'waitlist.sql'];
const ENTRY_KEYS = ['id', 'wants', 'wants_note', 'heard_from', 'heard_note', 'client', 'os', 'version', 'country', 'created_at'];
const VALID = { wants: ['higher_limit'], heard_from: 'marketplace', client: 'vscode', os: 'windows', version: '0.2.25' };
const NOT_READY = { error: 'Waitlist is not available yet' };

function d1(files) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of files) sqlite.exec(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  return { sqlite, prepare: (sql) => statement(sql) };
}

function client({ tables = ALL_TABLES, env: extra = {} } = {}) {
  const env = { DB: d1(tables), ADMIN_SECRET: SECRET, STATS_SECRET: STATS_KEY, ...extra };
  const call = async (path, { method = 'GET', body, headers = {}, admin = false, cf } = {}) => {
    const stream = body instanceof ReadableStream;
    const request = new Request(`https://telemetry.test${path}`, {
      method,
      headers: { ...(admin ? { 'x-stats-key': SECRET } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' || stream ? body : JSON.stringify(body),
      ...(stream ? { duplex: 'half' } : {}),
    });
    if (cf) Object.defineProperty(request, 'cf', { value: cf });
    const response = await worker.fetch(request, env, {});
    const text = await response.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, data, headers: response.headers };
  };
  const rows = () => env.DB.sqlite.prepare('SELECT * FROM waitlist ORDER BY id').all().map((row) => ({ ...row }));
  return { env, call, rows };
}

function insertEntry(sqlite, { wants = 'higher_limit', heard = 'marketplace', note = null, daysAgo = 0 } = {}) {
  sqlite.prepare(`INSERT INTO waitlist (wants, wants_note, heard_from, heard_note, client, os, version, country, created_at)
    VALUES (?, ?, ?, NULL, 'vscode', 'linux', '0.2.25', 'GB', datetime('now', ?))`).run(wants, note, heard, `-${daysAgo} days`);
}

/** A valid entry padded with an ignored field to exactly `bytes` UTF-8 bytes. */
function bodyOfBytes(bytes, padChar = 'x') {
  const base = JSON.stringify({ ...VALID, pad: '' });
  const charBytes = Buffer.byteLength(padChar);
  const room = bytes - Buffer.byteLength(base);
  const pad = padChar.repeat(Math.floor(room / charBytes)) + 'x'.repeat(room % charBytes);
  const text = JSON.stringify({ ...VALID, pad });
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}

// Built at run time so this file never looks like it holds a credential.
const fakeKeys = {
  openai: 'sk-' + 'proj-' + 'B'.repeat(40),
  anthropic: 'sk-' + 'ant-api03-' + 'z'.repeat(40),
  google: 'AI' + 'za' + 'S'.repeat(35),
  groq: 'gs' + 'k_' + 'g'.repeat(40),
  github: 'gh' + 'p_' + 'A1b2C3d4E5'.repeat(4),
  githubPat: 'github' + '_pat_' + 'x1'.repeat(30),
  xai: 'xa' + 'i-' + 'q'.repeat(30),
  nvidia: 'nva' + 'pi-' + 'n'.repeat(30),
};

const otherCredentials = {
  'AWS access key': 'AK' + 'IA' + 'QWERTYUIOPASDFGH',
  'Hugging Face token': 'hf' + '_' + 'h'.repeat(34),
  'Slack token': 'xo' + 'xb-' + '1234567890-abcdefghij',
  'Stripe live key': 'sk' + '_live_' + '9'.repeat(24),
  'GitHub OAuth token': 'gh' + 'o_' + 'A1b2C3d4E5'.repeat(4),
  'npm token': 'np' + 'm_' + 'N'.repeat(36),
};

test('an entry keeps deduplicated wants in a fixed order, trimmed notes and the Cloudflare country', async () => {
  const { call, rows } = client();
  const sent = await call('/waitlist', {
    method: 'POST',
    cf: { country: 'gb' },
    body: {
      wants: ['faster', 'higher_limit', 'faster'],
      wants_note: '  more requests\r\nper day  ',
      heard_from: 'friend',
      heard_note: '\r\n a colleague \r\n',
      client: 'VSCode', os: 'Darwin', version: '0.2.25', country: 'US',
    },
  });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.data, { received: true });
  const [row] = rows();
  assert.equal(row.wants, 'higher_limit,faster');
  assert.equal(row.wants_note, 'more requests\nper day');
  assert.equal(row.heard_from, 'friend');
  assert.equal(row.heard_note, 'a colleague');
  assert.equal(row.client, 'vscode');
  assert.equal(row.os, 'darwin');
  assert.equal(row.version, '0.2.25');
  assert.equal(row.country, 'GB', 'the country comes from Cloudflare, never from the body');
  assert.ok(row.created_at);
});

test('client, os, version and country fall back exactly like feedback', async () => {
  const { call, rows } = client();
  await call('/waitlist', { method: 'POST', body: { ...VALID, client: 'emacs', os: 'beos', version: '<script>alert(1)</script>', country: 'GB' } });
  await call('/waitlist', { method: 'POST', cf: { country: 'Great Britain' }, body: { ...VALID, version: '1.2.3-beta+build.4567890123' } });
  await call('/waitlist', { method: 'POST', body: { wants: ['other'], heard_from: 'other' } });
  const stored = rows().map(({ client: c, os, version, country }) => ({ client: c, os, version, country }));
  assert.deepEqual(stored, [
    { client: 'unknown', os: 'unknown', version: 'scriptalert1sc', country: 'XX' },
    { client: 'vscode', os: 'windows', version: '1.2.3-betabuild.456', country: 'XX' },
    { client: 'unknown', os: 'unknown', version: 'unknown', country: 'XX' },
  ]);
  const feedback = cleanFeedback({ message: 'x', client: 'emacs', os: 'beos', version: '<script>alert(1)</script>' }, 'Great Britain').values;
  assert.deepEqual({ client: feedback.client, os: feedback.os, version: feedback.version, country: feedback.country }, stored[0]);
});

test('an entry stores no email, telemetry id, session id or IP address and touches no usage table', async () => {
  const { env, call, rows } = client();
  const identifying = {
    email: 'person@example.com', user_id: 'user-1234567890abcdef', telemetry_id: 'tid-feedfacecafebeef',
    machine_id: 'mid-0123456789abcdef', session_id: 'sess-0123456789', ip: '198.51.100.23',
  };
  const sent = await call('/waitlist', {
    method: 'POST',
    cf: { country: 'DE', city: 'Berlin', asn: 3320 },
    headers: { 'CF-Connecting-IP': '203.0.113.77', 'X-Forwarded-For': '203.0.113.78', 'User-Agent': 'Mozilla/5.0 probe-agent' },
    body: { ...VALID, ...identifying },
  });
  assert.equal(sent.status, 201);

  const columns = env.DB.sqlite.prepare('PRAGMA table_info(waitlist)').all().map((c) => c.name);
  assert.deepEqual(columns, ENTRY_KEYS);
  const stored = JSON.stringify(rows());
  for (const value of [...Object.values(identifying), '203.0.113.77', '203.0.113.78', 'probe-agent', 'Berlin', '3320']) {
    assert.ok(!stored.includes(value), `${value} must not be stored`);
  }

  const tables = env.DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('waitlist', 'sqlite_sequence')").all();
  assert.ok(tables.length > 5, 'the full telemetry schema is loaded');
  for (const { name } of tables) {
    assert.equal(env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n, 0, `${name} stays empty`);
  }

  const listed = await call('/api/admin/waitlist', { admin: true });
  assert.deepEqual(Object.keys(listed.data.waitlist[0]).sort(), [...ENTRY_KEYS].sort());
  for (const value of [...Object.values(identifying), '203.0.113.77']) {
    assert.ok(!JSON.stringify(listed.data).includes(value), `${value} must not be listed`);
  }
});

test('answers outside the known choices are refused and nothing is stored', async () => {
  const { call, rows } = client();
  const bad = [
    {},
    { heard_from: 'friend' },
    { wants: [], heard_from: 'friend' },
    { wants: 'faster', heard_from: 'friend' },
    { wants: { 0: 'faster', length: 1 }, heard_from: 'friend' },
    { wants: ['faster', 'cheaper'], heard_from: 'friend' },
    { wants: ['FASTER'], heard_from: 'friend' },
    { wants: [' faster'], heard_from: 'friend' },
    { wants: [['faster']], heard_from: 'friend' },
    { wants: [{ id: 'faster' }], heard_from: 'friend' },
    { wants: [null], heard_from: 'friend' },
    { wants: [1], heard_from: 'friend' },
    { wants: ['__proto__'], heard_from: 'friend' },
    { wants: ['constructor'], heard_from: 'friend' },
    { wants: ['toString'], heard_from: 'friend' },
    { wants: ['faster'] },
    { wants: ['faster'], heard_from: '' },
    { wants: ['faster'], heard_from: 'tiktok' },
    { wants: ['faster'], heard_from: 'Reddit' },
    { wants: ['faster'], heard_from: ['friend'] },
    { wants: ['faster'], heard_from: 1 },
    { wants: ['faster'], heard_from: '__proto__' },
    { wants: ['faster'], heard_from: 'constructor' },
    { wants: ['faster'], heard_from: 'hasOwnProperty' },
    { wants: ['faster'], heard_from: 'friend', wants_note: 42 },
    { wants: ['faster'], heard_from: 'friend', wants_note: ['note'] },
    { wants: ['faster'], heard_from: 'friend', heard_note: { text: 'note' } },
    { wants: ['faster'], heard_from: 'friend', heard_note: true },
  ];
  for (const body of bad) {
    const result = await call('/waitlist', { method: 'POST', body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(typeof result.data.error, 'string');
  }
  assert.deepEqual(rows(), []);
});

test('notes at the limits are kept and longer notes are refused', async () => {
  const { call, rows } = client();
  const post = (extra) => call('/waitlist', { method: 'POST', body: { ...VALID, ...extra } });
  assert.equal((await post({ wants_note: 'w'.repeat(MAX_WANTS_NOTE) })).status, 201);
  assert.equal((await post({ heard_note: 'h'.repeat(MAX_HEARD_NOTE) })).status, 201);
  assert.equal((await post({ wants_note: '   ' + 'w'.repeat(MAX_WANTS_NOTE) + '\r\n  ' })).status, 201, 'surrounding whitespace does not count');
  assert.equal((await post({ wants_note: '  \r\n ', heard_note: '' })).status, 201);
  assert.equal((await post({ wants_note: null, heard_note: null })).status, 201);
  const tooLongWants = await post({ wants_note: 'w'.repeat(MAX_WANTS_NOTE + 1) });
  assert.equal(tooLongWants.status, 400);
  assert.match(tooLongWants.data.error, /wants_note/);
  const tooLongHeard = await post({ heard_note: 'h'.repeat(MAX_HEARD_NOTE + 1) });
  assert.equal(tooLongHeard.status, 400);
  assert.match(tooLongHeard.data.error, /heard_note/);
  const stored = rows();
  assert.equal(stored.length, 5);
  assert.equal(stored[2].wants_note.length, MAX_WANTS_NOTE);
  assert.equal(stored[3].wants_note, null, 'a blank note is stored as no note');
  assert.equal(stored[3].heard_note, null);
});

test('provider-key-shaped strings are removed from both notes before storage', async () => {
  const { call, rows } = client();
  for (const key of Object.values(fakeKeys)) {
    const sent = await call('/waitlist', {
      method: 'POST',
      body: { ...VALID, wants_note: `my key ${key} hit the limit`, heard_note: `${key}` },
    });
    assert.equal(sent.status, 201);
  }
  const stored = rows();
  for (const [i, key] of Object.values(fakeKeys).entries()) {
    assert.equal(stored[i].wants_note, 'my key [removed] hit the limit');
    assert.equal(stored[i].heard_note, '[removed]');
    assert.ok(!JSON.stringify(stored[i]).includes(key.slice(-12)));
  }
  await call('/waitlist', { method: 'POST', body: { ...VALID, wants_note: 'sk-learn upgrade and a key-value store please' } });
  assert.equal(rows().at(-1).wants_note, 'sk-learn upgrade and a key-value store please', 'ordinary words survive');
});

test('other credential shapes the extension already recognises are removed from waitlist notes too', async () => {
  const { call, rows } = client();
  for (const value of Object.values(otherCredentials)) {
    assert.equal((await call('/waitlist', { method: 'POST', body: { ...VALID, wants_note: `token ${value} here` } })).status, 201);
  }
  const leaked = rows()
    .map((row, i) => [Object.keys(otherCredentials)[i], row.wants_note])
    .filter(([label, note]) => note.includes(otherCredentials[label]))
    .map(([label]) => label);
  assert.deepEqual(leaked, [], `stored unredacted: ${leaked.join(', ')}`);
});

test('oversized bodies are refused by bytes, whatever Content-Length says', async () => {
  const { call, rows } = client();
  const atLimit = await call('/waitlist', { method: 'POST', body: bodyOfBytes(8 * 1024) });
  assert.equal(atLimit.status, 201);
  const overLimit = await call('/waitlist', { method: 'POST', body: bodyOfBytes(8 * 1024 + 1) });
  assert.equal(overLimit.status, 413);
  assert.deepEqual(overLimit.data, { error: 'Payload too large' });

  const multiByte = bodyOfBytes(9000, '€');
  assert.ok(multiByte.length < 8 * 1024, 'fewer characters than the limit');
  assert.equal((await call('/waitlist', { method: 'POST', body: multiByte })).status, 413);

  const declaredHuge = await call('/waitlist', { method: 'POST', headers: { 'content-length': '100000' }, body: JSON.stringify(VALID) });
  assert.equal(declaredHuge.status, 413);
  const lyingSmall = await call('/waitlist', { method: 'POST', headers: { 'content-length': '20' }, body: bodyOfBytes(20000) });
  assert.equal(lyingSmall.status, 413);
  assert.equal(rows().length, 1);
});

test('an endless request body is cut off soon after the limit and cancelled', async () => {
  const { call, rows } = client();
  let pulls = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode('{"wants":["faster"],"heard_from":"friend","pad":"' + 'x'.repeat(1024));
  const endless = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const result = await call('/waitlist', { method: 'POST', body: endless });
  assert.equal(result.status, 413);
  assert.ok(pulls < 20, `read ${pulls} chunks`);
  assert.equal(cancelled, true);
  assert.deepEqual(rows(), []);
});

test('malformed and prototype-polluting JSON is refused or neutralised', async () => {
  const { call, rows } = client();
  for (const body of ['not json', '', '[]', 'null', '42', '"wants"', 'true', '{"wants":["faster"],"heard_from":"friend"', '\u0000']) {
    assert.equal((await call('/waitlist', { method: 'POST', body })).status, 400, JSON.stringify(body));
  }
  const nested = '{"__proto__":{"wants":["faster"],"heard_from":"friend"}}';
  assert.equal((await call('/waitlist', { method: 'POST', body: nested })).status, 400);

  const smuggled = '{"wants":["faster"],"heard_from":"friend","__proto__":{"client":"vscode","os":"linux","polluted":"yes"},'
    + '"constructor":{"prototype":{"polluted":"yes"}}}';
  assert.equal((await call('/waitlist', { method: 'POST', body: smuggled })).status, 201);
  const [row] = rows();
  assert.equal(row.client, 'unknown');
  assert.equal(row.os, 'unknown');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.wants, undefined);
});

test('object-shaped client, os or version fields are bad input, not a server error', async () => {
  const { call } = client();
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    for (const extra of [
      { client: { toString: 1 } },
      { os: { toString: null, valueOf: null } },
      { version: { toString: 'x', valueOf: 'y' } },
    ]) {
      const result = await call('/waitlist', { method: 'POST', body: { ...VALID, ...extra } });
      assert.ok([400, 201].includes(result.status), `${JSON.stringify(extra)} answered ${result.status} ${JSON.stringify(result.data)}`);
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, [], 'bad input is not logged as a server failure');
});

test('SQL in notes is stored as text and cannot touch the table', async () => {
  const { env, call, rows } = client();
  const note = "x'); DROP TABLE waitlist; --";
  assert.equal((await call('/waitlist', { method: 'POST', body: { ...VALID, wants_note: note, heard_note: "' OR 1=1 --", version: "1'; DROP TABLE waitlist;--" } })).status, 201);
  assert.ok(env.DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'waitlist'").get());
  const [row] = rows();
  assert.equal(row.wants_note, note);
  assert.equal(row.heard_note, "' OR 1=1 --");
  assert.match(row.version, /^[0-9a-zA-Z.-]+$/);
  const removed = await call("/api/admin/waitlist/1%20OR%201=1/delete", { method: 'POST', admin: true });
  assert.equal(removed.status, 404);
  assert.equal(rows().length, 1);
});

test('notes with markup come back verbatim as JSON that browsers will not sniff as HTML', async () => {
  const { call } = client();
  const markup = '<img src=x onerror="alert(document.cookie)"><script>alert(1)</script>';
  const sent = await call('/waitlist', { method: 'POST', body: { ...VALID, wants_note: markup, heard_note: '</textarea><svg onload=alert(1)>' } });
  const listed = await call('/api/admin/waitlist', { admin: true });
  assert.equal(listed.data.waitlist[0].wants_note, markup);
  const refused = await call('/waitlist', { method: 'POST', body: { wants: ['<b>'] } });
  for (const response of [sent, listed, refused]) {
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.ok(!JSON.stringify(refused.data).includes('<b>'), 'refusals do not echo the input');
});

test('only POST is accepted on the public route', async () => {
  const { call, rows } = client();
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const result = await call('/waitlist', { method, body: method === 'GET' ? undefined : JSON.stringify(VALID) });
    assert.equal(result.status, 405, method);
  }
  assert.deepEqual(rows(), []);
});

test('the IP rate limiter turns joiners away before anything is stored', async () => {
  const keys = [];
  const { call, rows } = client({ env: { RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } } });
  const result = await call('/waitlist', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.9' }, body: VALID });
  assert.equal(result.status, 429);
  assert.deepEqual(keys, ['203.0.113.9']);
  assert.deepEqual(rows(), []);
});

test('the admin routes refuse a missing, wrong, partial or stats-only key', async () => {
  const { call, rows } = client();
  await call('/waitlist', { method: 'POST', body: VALID });
  const refusedWith = async (headers) => {
    const list = await call('/api/admin/waitlist', { headers });
    const remove = await call('/api/admin/waitlist/1/delete', { method: 'POST', headers });
    return [list, remove];
  };
  for (const headers of [
    {},
    { 'x-stats-key': '' },
    { 'x-stats-key': SECRET.slice(0, -1) },
    { 'x-stats-key': SECRET + 'x' },
    { 'x-stats-key': SECRET.toUpperCase() },
    { 'x-stats-key': STATS_KEY },
    { Authorization: `Basic ${Buffer.from(`admin:${SECRET}`).toString('base64')}` },
    { Authorization: SECRET.slice(1) },
  ]) {
    for (const response of await refusedWith(headers)) {
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.deepEqual(response.data, { error: 'Unauthorized' });
    }
  }
  assert.equal(rows().length, 1, 'nothing was deleted');
  assert.equal((await call('/api/admin/waitlist', { headers: { Authorization: `Bearer ${SECRET}` } })).status, 200);
  assert.equal((await call('/api/admin/waitlist', { headers: { Authorization: `bearer ${SECRET}` } })).status, 200);
});

test('without an admin secret configured, no key opens the admin routes', async () => {
  const { call } = client({ env: { ADMIN_SECRET: undefined } });
  for (const headers of [{}, { 'x-stats-key': '' }, { 'x-stats-key': 'undefined' }, { Authorization: 'Bearer ' }, { 'x-stats-key': STATS_KEY }]) {
    assert.equal((await call('/api/admin/waitlist', { headers })).status, 401, JSON.stringify(headers));
  }
  const { call: emptySecret } = client({ env: { ADMIN_SECRET: '' } });
  assert.equal((await emptySecret('/api/admin/waitlist', { headers: { 'x-stats-key': '' } })).status, 401);
});

test('odd admin paths neither reach the data nor delete anything', async () => {
  const { call, rows } = client();
  await call('/waitlist', { method: 'POST', body: VALID });
  for (const [path, method] of [
    ['/api/admin/waitlist/', 'GET'],
    ['/api/admin/waitlist', 'POST'],
    ['/api/admin/waitlist/1/delete', 'GET'],
    ['/api/admin/waitlist/1/delete/', 'POST'],
    ['/api/admin/waitlist/abc/delete', 'POST'],
    ['/api/admin/waitlist/-1/delete', 'POST'],
    ['/api/admin/waitlist/1e0/delete', 'POST'],
    ['/api/admin/waitlist/0x1/delete', 'POST'],
    ['/api/admin/waitlist/1234567890123/delete', 'POST'],
    ['/api/admin/waitlist/1/remove', 'POST'],
  ]) {
    const result = await call(path, { method, admin: true });
    assert.equal(result.status, 404, `${method} ${path}`);
    assert.ok(!('waitlist' in (result.data || {})), `${method} ${path} must not list entries`);
  }
  for (const path of ['/api/admin/waitlist/1/delete', '/api/admin/waitlist/anything']) {
    assert.equal((await call(path, { method: 'POST' })).status, 401, path);
  }
  for (const path of ['/api/admin/%77aitlist', '/API/ADMIN/WAITLIST', '//api/admin/waitlist', '/api/admin/waitlist%2F1%2Fdelete']) {
    const result = await call(path, { method: 'GET' });
    assert.notEqual(result.status, 200, path);
    assert.ok(!JSON.stringify(result.data ?? '').includes('higher_limit'), `${path} leaked entries`);
  }
  assert.equal(rows().length, 1);
});

test('the admin list returns the newest 500 entries while the summary counts all of them', async () => {
  const { env, call } = client();
  for (let i = 0; i < 505; i++) insertEntry(env.DB.sqlite, { note: `entry ${i + 1}` });
  const listed = await call('/api/admin/waitlist', { admin: true });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.waitlist.length, 500);
  assert.equal(listed.data.waitlist[0].id, 505);
  assert.equal(listed.data.waitlist.at(-1).id, 6);
  assert.equal(listed.data.summary.total, 505);
  assert.equal(listed.data.summary.wants.higher_limit, 505);
  assert.equal(listed.data.not_ready, undefined);
});

test('the summary counts 7 and 30 day windows and tallies only known answers', async () => {
  const { env, call } = client();
  const db = env.DB.sqlite;
  insertEntry(db, { wants: 'higher_limit,faster', heard: 'reddit', daysAgo: 0 });
  insertEntry(db, { wants: 'faster', heard: 'reddit', daysAgo: 2 });
  insertEntry(db, { wants: 'team_features,other', heard: 'x', daysAgo: 10 });
  insertEntry(db, { wants: 'stronger_models', heard: 'blog', daysAgo: 40 });
  insertEntry(db, { wants: '__proto__,constructor,toString,hasOwnProperty,faster', heard: '__proto__', daysAgo: 50 });
  insertEntry(db, { wants: 'cheaper', heard: 'constructor', daysAgo: 1 });
  const { data } = await call('/api/admin/waitlist', { admin: true });
  const { summary } = data;
  assert.equal(summary.total, 6);
  assert.equal(summary.last_7_days, 3);
  assert.equal(summary.last_30_days, 4);
  assert.deepEqual(Object.keys(summary.wants), WANTS);
  assert.deepEqual(Object.keys(summary.heard_from), HEARD_FROM);
  assert.deepEqual(summary.wants, { higher_limit: 1, stronger_models: 1, faster: 3, team_features: 1, other: 1 });
  assert.deepEqual(summary.heard_from, { marketplace: 0, search: 0, friend: 0, reddit: 2, x: 1, youtube: 0, blog: 1, other: 0 });
  assert.equal({}.faster, undefined, 'tallying never writes to Object.prototype');
  assert.equal(typeof {}.toString, 'function');
});

test('an empty waitlist answers zero totals rather than nulls', async () => {
  const { call } = client();
  const { status, data } = await call('/api/admin/waitlist', { admin: true });
  assert.equal(status, 200);
  assert.deepEqual(data.waitlist, []);
  assert.equal(data.summary.total, 0);
  assert.equal(data.summary.last_7_days, 0);
  assert.equal(data.summary.last_30_days, 0);
  assert.ok(Object.values(data.summary.wants).every((n) => n === 0));
});

test('deleting removes exactly one entry and leaves a feedback note with the same id alone', async () => {
  const { env, call, rows } = client();
  await call('/feedback', { method: 'POST', body: { message: 'a note' } });
  await call('/waitlist', { method: 'POST', body: VALID });
  await call('/waitlist', { method: 'POST', body: { ...VALID, heard_from: 'friend' } });
  const removed = await call('/api/admin/waitlist/1/delete', { method: 'POST', admin: true });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data, { deleted: 1 });
  assert.deepEqual(rows().map((r) => r.heard_from), ['friend']);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM feedback WHERE id = 1').get().n, 1);
  const again = await call('/api/admin/waitlist/1/delete', { method: 'POST', admin: true });
  assert.equal(again.status, 404);
  assert.deepEqual(again.data, { error: 'Entry not found' });
  assert.equal((await call('/api/admin/waitlist/0/delete', { method: 'POST', admin: true })).status, 404);
  assert.equal((await call('/api/admin/waitlist/000002/delete', { method: 'POST', admin: true })).status, 200);
  assert.deepEqual(rows(), []);
});

test('before waitlist.sql runs, joining answers 503 and the admin list reports not_ready while feedback works', async () => {
  const { call } = client({ tables: ['schema.sql', 'feedback.sql', 'feedback-checkin.sql'] });
  const join = await call('/waitlist', { method: 'POST', body: VALID });
  assert.equal(join.status, 503);
  assert.deepEqual(join.data, NOT_READY);
  assert.equal((await call('/waitlist', { method: 'POST', body: { wants: [] } })).status, 400);
  assert.equal((await call('/api/admin/waitlist')).status, 401, 'auth is still checked first');
  const listed = await call('/api/admin/waitlist', { admin: true });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data, { waitlist: [], not_ready: true });
  const removed = await call('/api/admin/waitlist/1/delete', { method: 'POST', admin: true });
  assert.equal(removed.status, 503);
  assert.deepEqual(removed.data, NOT_READY);
  assert.equal((await call('/feedback', { method: 'POST', body: { message: 'still works' } })).status, 201);
  assert.equal((await call('/api/admin/feedback', { admin: true })).data.feedback.length, 1);
});

test('other database failures answer a plain 500 without the database message', async () => {
  const failing = {
    prepare: () => ({
      bind() { return this; },
      run: async () => { throw new Error('D1_ERROR: disk I/O error at /var/lib/d1/secret-path'); },
      all: async () => { throw new Error('D1_ERROR: disk I/O error at /var/lib/d1/secret-path'); },
      first: async () => { throw new Error('D1_ERROR: disk I/O error at /var/lib/d1/secret-path'); },
    }),
  };
  const env = { DB: failing, ADMIN_SECRET: SECRET };
  const original = console.error;
  console.error = () => {};
  try {
    for (const [path, init] of [
      ['/waitlist', { method: 'POST', body: JSON.stringify(VALID) }],
      ['/api/admin/waitlist', { headers: { 'x-stats-key': SECRET } }],
      ['/api/admin/waitlist/3/delete', { method: 'POST', headers: { 'x-stats-key': SECRET } }],
    ]) {
      const response = await worker.fetch(new Request(`https://telemetry.test${path}`, init), env, {});
      assert.equal(response.status, 500, path);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { error: 'Waitlist request failed' });
      assert.ok(!text.includes('secret-path'));
    }
  } finally {
    console.error = original;
  }
  const unbound = await worker.fetch(new Request('https://telemetry.test/waitlist', { method: 'POST', body: JSON.stringify(VALID) }), { ADMIN_SECRET: SECRET }, {});
  assert.equal(unbound.status, 500);
});

test('feedback keeps its own body limit and validation after the helpers were shared', async () => {
  const { env, call } = client();
  const padded = JSON.stringify({ message: 'a note with padding', pad: 'p'.repeat(12 * 1024) });
  assert.equal((await call('/feedback', { method: 'POST', body: padded })).status, 201, 'feedback still allows bodies above 8 KB');
  assert.equal((await call('/feedback', { method: 'POST', body: JSON.stringify({ message: 'x', pad: 'p'.repeat(17 * 1024) }) })).status, 413);
  assert.equal((await call('/feedback', { method: 'POST', body: VALID })).status, 400, 'a waitlist body is not a note');
  assert.equal((await call('/feedback', { method: 'POST', cf: { country: 'fr' }, body: { message: ` key ${fakeKeys.openai} \r\n`, client: 'TUI', os: 'LINUX', version: 'v1.2.3' } })).status, 201);
  const last = env.DB.sqlite.prepare('SELECT message, client, os, version, country FROM feedback ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual({ ...last }, { message: 'key [removed]', client: 'tui', os: 'linux', version: 'v1.2.3', country: 'FR' });
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n, 0, 'feedback never writes to the waitlist');
});
