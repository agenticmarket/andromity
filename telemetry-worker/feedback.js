export const MAX_MESSAGE_LENGTH = 2000;
const MAX_BODY = 16 * 1024;
const LIST_LIMIT = 500;
const CLIENTS = ['vscode', 'tui', 'cli'];
const SYSTEMS = ['windows', 'darwin', 'linux'];
const SECRET_PATTERN = /(?:sk-|nvapi-|gsk_|AIza|xai-|key-|ghp_|github_pat_)[a-zA-Z0-9_-]{16,}/g;
/** Answers to the in-chat check-in. Clients send these ids; the admin panel labels them. */
export const SENTIMENTS = ['love', 'ok', 'bad'];
export const ANNOYANCES = ['slow', 'wrong_edits', 'too_many_prompts', 'errors_limits', 'hard_to_use', 'missing_feature'];
const MISSING_COLUMN = /no such column|has no column/i;

export function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Normalises line endings, trims, and replaces API-key-shaped strings before storage. */
export function cleanText(raw) {
  return raw.replace(/\r\n?/g, '\n').trim().replace(SECRET_PATTERN, '[removed]');
}

/** The client, OS family, version and Cloudflare country stored with a submission. Unknown values fall back. */
export function clientFields(input, cfCountry) {
  const client = String(input.client || '').toLowerCase();
  const os = String(input.os || '').toLowerCase();
  const country = String(cfCountry || '').toUpperCase();
  return {
    client: CLIENTS.includes(client) ? client : 'unknown',
    os: SYSTEMS.includes(os) ? os : 'unknown',
    version: String(input.version || '').slice(0, 20).replace(/[^0-9a-zA-Z.-]/g, '') || 'unknown',
    country: /^[A-Z]{2}$/.test(country) ? country : 'XX',
  };
}

/**
 * Validates a submitted note or check-in. A check-in carries a sentiment and may leave the note
 * empty; a plain note needs text. API-key-shaped strings are replaced before storage.
 */
export function cleanFeedback(input, cfCountry) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected a JSON object' };
  const hasSentiment = input.sentiment !== undefined && input.sentiment !== null;
  if (hasSentiment && !SENTIMENTS.includes(input.sentiment)) return { error: 'sentiment must be one of love, ok, bad' };
  let annoyances = [];
  if (input.annoyances !== undefined && input.annoyances !== null) {
    if (!Array.isArray(input.annoyances) || input.annoyances.length > ANNOYANCES.length || input.annoyances.some((a) => !ANNOYANCES.includes(a))) {
      return { error: 'annoyances must be a list of known choices' };
    }
    annoyances = ANNOYANCES.filter((a) => input.annoyances.includes(a));
  }
  const rawMessage = hasSentiment && (input.message === undefined || input.message === null) ? '' : input.message;
  if (typeof rawMessage !== 'string') return { error: 'message must be a string' };
  const message = cleanText(rawMessage);
  if (!message && !hasSentiment) return { error: 'message is required' };
  if (message.length > MAX_MESSAGE_LENGTH) return { error: `message is longer than ${MAX_MESSAGE_LENGTH} characters` };
  return {
    values: {
      message,
      ...clientFields(input, cfCountry),
      sentiment: hasSentiment ? input.sentiment : null,
      annoyances: annoyances.length ? annoyances.join(',') : null,
    },
  };
}

/** Before feedback-checkin.sql runs, the answer is kept inside the note rather than lost. */
function legacyMessage(values) {
  if (!values.sentiment && !values.annoyances) return values.message;
  const answer = `[check-in: ${values.sentiment || 'none'}${values.annoyances ? '; ' + values.annoyances.replace(/,/g, ', ') : ''}]`;
  return values.message ? `${answer}\n${values.message}` : answer;
}

async function insertFeedback(env, values) {
  try {
    await env.DB.prepare('INSERT INTO feedback (message, client, os, version, country, sentiment, annoyances) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(values.message, values.client, values.os, values.version, values.country, values.sentiment, values.annoyances).run();
  } catch (err) {
    if (!MISSING_COLUMN.test(String(err?.message || err))) throw err;
    await env.DB.prepare('INSERT INTO feedback (message, client, os, version, country) VALUES (?, ?, ?, ?, ?)')
      .bind(legacyMessage(values), values.client, values.os, values.version, values.country).run();
  }
}

async function submit(request, env, headers) {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Payload too large' }, 413, headers);
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const { values, error } = cleanFeedback(data, request.cf?.country);
  if (error) return json({ error }, 400, headers);
  await insertFeedback(env, values);
  return json({ received: true }, 201, headers);
}

async function handleAdmin(request, env, path, headers) {
  if (path === '/api/admin/feedback' && request.method === 'GET') {
    const columns = 'id, message, client, os, version, country, created_at';
    let results;
    try {
      ({ results } = await env.DB.prepare(`SELECT ${columns}, sentiment, annoyances FROM feedback ORDER BY id DESC LIMIT ${LIST_LIMIT}`).all());
    } catch (err) {
      if (!MISSING_COLUMN.test(String(err?.message || err))) throw err;
      ({ results } = await env.DB.prepare(`SELECT ${columns} FROM feedback ORDER BY id DESC LIMIT ${LIST_LIMIT}`).all());
    }
    return json({ feedback: results }, 200, headers);
  }
  const match = /^\/api\/admin\/feedback\/(\d{1,12})\/delete$/.exec(path);
  if (match && request.method === 'POST') {
    const result = await env.DB.prepare('DELETE FROM feedback WHERE id = ?').bind(Number(match[1])).run();
    if (!result.meta?.changes) return json({ error: 'Feedback not found' }, 404, headers);
    return json({ deleted: Number(match[1]) }, 200, headers);
  }
  return json({ error: 'Not Found' }, 404, headers);
}

/**
 * Feedback routes. Public: `POST /feedback` stores a note. Admin (`isAdmin` required):
 * the latest notes and deleting one. Returns null for paths that are not feedback routes.
 */
export async function handleFeedbackRequest(request, env, { url, headers, isAdmin }) {
  const path = url.pathname;
  const admin = path === '/api/admin/feedback' || path.startsWith('/api/admin/feedback/');
  if (!admin && path !== '/feedback') return null;
  if (!env.DB) return json({ error: 'Database not bound' }, 500, headers);
  if (admin && !isAdmin) return json({ error: 'Unauthorized' }, 401, headers);
  if (!admin && request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, headers);
  try {
    return admin ? await handleAdmin(request, env, path, headers) : await submit(request, env, headers);
  } catch (err) {
    console.error('Feedback request failed:', err);
    return json({ error: 'Feedback request failed' }, 500, headers);
  }
}
