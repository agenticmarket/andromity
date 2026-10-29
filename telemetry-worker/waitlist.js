import { cleanText, clientFields, json } from './feedback.js';

const MAX_BODY = 8 * 1024;
const LIST_LIMIT = 500;
/** Answers to the in-client waitlist form. Clients send these ids; the admin panel labels them. */
export const WANTS = ['higher_limit', 'stronger_models', 'faster', 'team_features', 'other'];
export const HEARD_FROM = ['marketplace', 'search', 'friend', 'reddit', 'x', 'youtube', 'blog', 'other'];
export const MAX_WANTS_NOTE = 300;
export const MAX_HEARD_NOTE = 200;
const NOT_READY = 'Waitlist is not available yet';
const MISSING_TABLE = /no such table/i;
const ENTRY_COLUMNS = 'id, wants, wants_note, heard_from, heard_note, client, os, version, country, created_at';

function isMissingTable(err) {
  return MISSING_TABLE.test(String(err?.message || err));
}

function optionalNote(value, name, max) {
  if (value === undefined || value === null) return { note: null };
  if (typeof value !== 'string') return { error: `${name} must be a string` };
  const note = cleanText(value);
  if (note.length > max) return { error: `${name} is longer than ${max} characters` };
  return { note: note || null };
}

/** Validates a waitlist entry against the known choices. Notes are optional; key-shaped strings are replaced. */
export function cleanWaitlist(input, cfCountry) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected a JSON object' };
  const wants = input.wants;
  if (!Array.isArray(wants) || wants.length === 0 || wants.length > WANTS.length || wants.some((id) => !WANTS.includes(id))) {
    return { error: `wants must list at least one of ${WANTS.join(', ')}` };
  }
  if (typeof input.heard_from !== 'string' || !HEARD_FROM.includes(input.heard_from)) {
    return { error: `heard_from must be one of ${HEARD_FROM.join(', ')}` };
  }
  const wantsNote = optionalNote(input.wants_note, 'wants_note', MAX_WANTS_NOTE);
  if (wantsNote.error) return { error: wantsNote.error };
  const heardNote = optionalNote(input.heard_note, 'heard_note', MAX_HEARD_NOTE);
  if (heardNote.error) return { error: heardNote.error };
  return {
    values: {
      wants: WANTS.filter((id) => wants.includes(id)).join(','),
      wants_note: wantsNote.note,
      heard_from: input.heard_from,
      heard_note: heardNote.note,
      ...clientFields(input, cfCountry),
    },
  };
}

/** Reads at most MAX_BODY bytes; null when the body is larger. */
async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

async function submit(request, env, headers) {
  const text = await readBody(request);
  if (text === null) return json({ error: 'Payload too large' }, 413, headers);
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const { values, error } = cleanWaitlist(data, request.cf?.country);
  if (error) return json({ error }, 400, headers);
  await env.DB.prepare('INSERT INTO waitlist (wants, wants_note, heard_from, heard_note, client, os, version, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(values.wants, values.wants_note, values.heard_from, values.heard_note, values.client, values.os, values.version, values.country).run();
  return json({ received: true }, 201, headers);
}

function tally(rows, known, combined) {
  const counts = Object.fromEntries(known.map((id) => [id, 0]));
  for (const row of rows) {
    for (const id of combined ? String(row.choice).split(',') : [row.choice]) {
      if (Object.hasOwn(counts, id)) counts[id] += Number(row.n) || 0;
    }
  }
  return counts;
}

/** Counts over every entry, so totals stay right when the list itself is capped at LIST_LIMIT rows. */
async function summarize(env) {
  const [totals, wants, heard] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(created_at >= datetime('now', '-7 days')), 0) AS last_7_days,
        COALESCE(SUM(created_at >= datetime('now', '-30 days')), 0) AS last_30_days
      FROM waitlist`).first(),
    env.DB.prepare('SELECT wants AS choice, COUNT(*) AS n FROM waitlist GROUP BY wants').all(),
    env.DB.prepare('SELECT heard_from AS choice, COUNT(*) AS n FROM waitlist GROUP BY heard_from').all(),
  ]);
  return {
    total: Number(totals?.total) || 0,
    last_7_days: Number(totals?.last_7_days) || 0,
    last_30_days: Number(totals?.last_30_days) || 0,
    wants: tally(wants.results, WANTS, true),
    heard_from: tally(heard.results, HEARD_FROM, false),
  };
}

async function handleAdmin(request, env, path, headers) {
  if (path === '/api/admin/waitlist' && request.method === 'GET') {
    const [{ results }, summary] = await Promise.all([
      env.DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM waitlist ORDER BY id DESC LIMIT ${LIST_LIMIT}`).all(),
      summarize(env),
    ]);
    return json({ waitlist: results, summary }, 200, headers);
  }
  const match = /^\/api\/admin\/waitlist\/(\d{1,12})\/delete$/.exec(path);
  if (match && request.method === 'POST') {
    const result = await env.DB.prepare('DELETE FROM waitlist WHERE id = ?').bind(Number(match[1])).run();
    if (!result.meta?.changes) return json({ error: 'Entry not found' }, 404, headers);
    return json({ deleted: Number(match[1]) }, 200, headers);
  }
  return json({ error: 'Not Found' }, 404, headers);
}

/**
 * Waitlist routes. Public: `POST /waitlist` stores an entry. Admin (`isAdmin` required): the latest
 * entries with totals, and deleting one. Until waitlist.sql has run, nothing throws: the public route
 * answers 503 and the admin list reports `not_ready`. Returns null for paths that are not waitlist routes.
 */
export async function handleWaitlistRequest(request, env, { url, headers, isAdmin }) {
  const path = url.pathname;
  const admin = path === '/api/admin/waitlist' || path.startsWith('/api/admin/waitlist/');
  if (!admin && path !== '/waitlist') return null;
  if (!env.DB) return json({ error: 'Database not bound' }, 500, headers);
  if (admin && !isAdmin) return json({ error: 'Unauthorized' }, 401, headers);
  if (!admin && request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, headers);
  try {
    return admin ? await handleAdmin(request, env, path, headers) : await submit(request, env, headers);
  } catch (err) {
    if (isMissingTable(err)) {
      return admin && request.method === 'GET'
        ? json({ waitlist: [], not_ready: true }, 200, headers)
        : json({ error: NOT_READY }, 503, headers);
    }
    console.error('Waitlist request failed:', err);
    return json({ error: 'Waitlist request failed' }, 500, headers);
  }
}
