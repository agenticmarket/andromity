const allowedEvents = new Set(['session_start', 'session_end', 'weekly_summary', 'compact_triggered', 'feature_use', 'session_update', 'task_started', 'task_finished']);
const number = value => Math.min(86400000, Math.max(0, Number(value) || 0));
const bucketRank = value => `CASE ${value} WHEN '30min+' THEN 3 WHEN '15-30min' THEN 2 WHEN '5-15min' THEN 1 ELSE 0 END`;
const MODEL_FILE = /\.(?:gguf|ggml|bin|safetensors|pt|pth|onnx|llamafile|mlmodel)$/i;
const API_KEY = /(?:sk-[a-zA-Z0-9_\-]{16,}|nvapi-[a-zA-Z0-9_\-]{16,}|gsk_[a-zA-Z0-9_\-]{16,}|AIza[a-zA-Z0-9_\-]{16,}|xai-[a-zA-Z0-9_\-]{16,}|key-[a-zA-Z0-9_\-]{16,}|pplx-[a-zA-Z0-9_\-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const USER_INFO = /[^\s/@]*:[^\s/@]*@/;
const HOSTNAME = /\..*\.|\.(?:com|net|org|io|ai|dev|app|cloud|co|internal|local|lan)$/i;
const PATH_ROOTS = new Set(['home', 'users', 'mnt', 'opt', 'srv', 'tmp', 'var', 'root']);
const ID_FORMAT = /^[a-zA-Z0-9_-]{16,64}$/;
const NAME_MAX_INPUT = 512;

function withoutTrailingSeparators(text) {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '/' || text[end - 1] === '\\')) end--;
  return text.slice(0, end);
}

function looksLikePath(text) {
  if (/^(?:\/|~|\.\.?(?:[\\/]|$)|file:)/i.test(text) || text.includes('\\') || text.includes('//')) return true;
  if (/(?:^|\/)[A-Za-z]:\//.test(text)) return true;
  return text.split('/').slice(0, -1).some(part => PATH_ROOTS.has(part.toLowerCase()) || part === '.' || part === '..' || part.startsWith('~'));
}

function looksLikeKey(text) {
  if (API_KEY.test(text)) return true;
  if (text.split(/[^A-Za-z0-9/+]+/).some(run => run.length === 40 && /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run))) return true;
  return text.split(/[^A-Za-z0-9]+/).some(token =>
    token.length >= 32 || (token.length >= 24 && /[0-9]/.test(token) && /[A-Za-z]/.test(token)));
}

export function modelName(value) {
  let text = String(value || '').trim();
  if (text.length > NAME_MAX_INPUT) return 'unknown';
  if (/\barn:/i.test(text)) {
    if (!text.includes('/')) return 'unknown';
    text = text.slice(text.lastIndexOf('/') + 1);
  } else if ((URL_SCHEME.test(text) && !/^file:/i.test(text)) || USER_INFO.test(text)) return 'url';
  // Older clients removed backslashes, so a drive or relative path arrives as one run of folder names.
  else if (/^[A-Za-z]:[^\\/]/.test(text) || /^\.[^\\/]*$/.test(text)) return 'local-path';
  else if (looksLikePath(text) || MODEL_FILE.test(text)) {
    const file = withoutTrailingSeparators(text).split(/[\\/]/).pop();
    text = MODEL_FILE.test(file) ? file.replace(MODEL_FILE, '') : '';
    if (!text) return 'local-path';
  }
  const cleaned = text.replace(/[^a-zA-Z0-9._:/-]/g, '');
  if (looksLikeKey(text) || looksLikeKey(cleaned)) return 'scrubbed_api_key';
  return cleaned.slice(0, 64) || 'unknown';
}

export function providerName(value) {
  const text = String(value || '').trim();
  if (!text || text.length > NAME_MAX_INPUT || HOSTNAME.test(text) || looksLikePath(text) || /^[A-Za-z]:/.test(text)
      || URL_SCHEME.test(text) || USER_INFO.test(text) || /\barn:/i.test(text)) return 'unknown';
  const cleaned = text.replace(/[^a-zA-Z0-9._-]/g, '');
  if (looksLikeKey(text) || looksLikeKey(cleaned)) return 'scrubbed_api_key';
  return cleaned.slice(0, 32) || 'unknown';
}

const flag = value => value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !ID_FORMAT.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

export async function ingestTelemetry(db, data, fields) {
  const { userId, sessionId, client, os, version, country, provider, model, providerType, profile, reasoningEffort, mcpToolsCount, now, date } = fields;
  const event = data.event || 'session_start';
  if (!allowedEvents.has(event)) throw new TypeError('Unknown event type');
  const eventId = optionalId(data.event_id, 'event ID');
  const statements = [];
  const add = (sql, args) => {
    if (eventId) {
      const guard = 'NOT EXISTS (SELECT 1 FROM telemetry_receipts WHERE event_id=?)';
      if (/\bVALUES\s*\(/i.test(sql)) sql = sql.replace(/VALUES\s*\(([^)]*)\)/i, (_, values) => `SELECT ${values} WHERE ${guard}`);
      else sql += ` AND ${guard}`;
      args.push(eventId);
    }
    statements.push(db.prepare(sql).bind(...args));
  };
  add(`INSERT INTO users(user_id,first_seen,last_seen,country,session_count) VALUES (?,?,?,?,0)
    ON CONFLICT(user_id) DO UPDATE SET first_seen=MIN(users.first_seen,excluded.first_seen),
    last_seen=MAX(users.last_seen,excluded.last_seen)`, [userId, now, now, country]);
  add(`INSERT INTO activity_facts(user_id,session_id,date,client,os,version,country,provider,model,provider_type,profile,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,session_id,date,client,os,version,country,provider,model,provider_type,profile)
    DO UPDATE SET last_seen=MAX(activity_facts.last_seen,excluded.last_seen)`,
    [userId, sessionId, date, client, os, version, country, provider, model, providerType, profile, now]);
  const turns = Math.min(number(data.turn_count), 9999);
  const duration = number(data.duration_seconds ?? data.duration_sec);
  if (event === 'session_start' || event === 'session_update' || event === 'session_end') {
    add(`INSERT INTO sessions(session_id,user_id,client,country,os,version,provider,model,provider_type,reasoning_effort,mcp_tools_count,profile,duration_seconds,turn_count,created_at,date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      duration_seconds=MAX(sessions.duration_seconds,excluded.duration_seconds),turn_count=MAX(sessions.turn_count,excluded.turn_count)
      WHERE sessions.user_id=excluded.user_id`,
      [sessionId,userId,client,country,os,version,provider,model,providerType,reasoningEffort,mcpToolsCount,profile,duration,turns,now,date]);
  }
  if (event === 'feature_use') {
    const feature = String(data.feature || data.feature_name || 'unknown').toLowerCase().slice(0,64).replace(/[^a-z0-9_-]/g,'');
    add(`INSERT INTO feature_events(feature_name,user_id,session_id,client,os,version,created_at,date) VALUES (?,?,?,?,?,?,?,?)`,
      [feature,userId,sessionId,client,os,version,now,date]);
  }
  const bucket = ['0-5min','5-15min','15-30min','30min+'].includes(data.duration_bucket) ? data.duration_bucket : '0-5min';
  const hadError = flag(data.had_error);
  const tools = [number(data.tool_bash_count), number(data.tool_file_count), number(data.tool_web_count)];
  if (event === 'session_end') {
    const sameSession = `event='session_end' AND session_id=? AND user_id=?`;
    const labels = { client, os, version, provider, model, provider_type: providerType };
    const latestLabels = Object.keys(labels).map(column => `${column}=CASE WHEN ?>=created_at THEN ? ELSE ${column} END`).join(',');
    add(`UPDATE events SET ${latestLabels},
      turn_count=MAX(COALESCE(turn_count,0),?),had_error=MAX(COALESCE(had_error,0),?),
      duration_bucket=CASE WHEN ${bucketRank('?')}>${bucketRank('duration_bucket')} THEN ? ELSE duration_bucket END,
      tool_bash_count=MAX(COALESCE(tool_bash_count,0),?),tool_file_count=MAX(COALESCE(tool_file_count,0),?),
      tool_web_count=MAX(COALESCE(tool_web_count,0),?),created_at=MAX(created_at,?),date=MAX(date,?)
      WHERE ${sameSession}`,
      [...Object.values(labels).flatMap(value => [now, value]),turns,hadError,bucket,bucket,...tools,now,date,sessionId,userId]);
    add(`INSERT INTO events(event,user_id,session_id,client,os,version,provider,model,provider_type,turn_count,had_error,duration_bucket,tool_bash_count,tool_file_count,tool_web_count,created_at,date)
      SELECT 'session_end',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM events WHERE ${sameSession})`,
      [userId,sessionId,client,os,version,provider,model,providerType,turns,hadError,bucket,...tools,now,date,sessionId,userId]);
  }
  if (event === 'compact_triggered') {
    add(`INSERT INTO events(event,user_id,session_id,client,os,version,provider,model,provider_type,turn_count,had_error,duration_bucket,tool_bash_count,tool_file_count,tool_web_count,created_at,date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [event,userId,sessionId,client,os,version,provider,model,providerType,turns,hadError,bucket,...tools,now,date]);
  }
  if (event === 'weekly_summary') {
    add(`INSERT INTO events(event,user_id,client,os,version,created_at,date) VALUES (?,?,?,?,?,?,?)`,
      [event,userId,client,os,version,now,date]);
  }
  if (event === 'task_started' || event === 'task_finished') {
    if (!optionalId(data.run_id, 'run ID')) throw new TypeError('Invalid run ID');
    const outcome = event === 'task_finished' ? data.outcome : null;
    if (event === 'task_finished' && !['completed','failed','cancelled'].includes(outcome)) throw new TypeError('Invalid outcome');
    add(`INSERT INTO task_runs(run_id,user_id,session_id,client,version,provider,model,started_at,finished_at,outcome,active_seconds,first_response_ms,date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      finished_at=COALESCE(excluded.finished_at,task_runs.finished_at),outcome=COALESCE(excluded.outcome,task_runs.outcome),
      active_seconds=COALESCE(excluded.active_seconds,task_runs.active_seconds),first_response_ms=COALESCE(excluded.first_response_ms,task_runs.first_response_ms),
      started_at=MIN(task_runs.started_at,excluded.started_at)
      WHERE task_runs.user_id=excluded.user_id`,
      [data.run_id,userId,sessionId,client,version,provider,model,now,event==='task_finished'?now:null,outcome,
        event==='task_finished'?number(data.active_seconds):null,data.first_response_ms == null ? null : number(data.first_response_ms),date]);
  }
  if (eventId) statements.push(db.prepare('INSERT OR IGNORE INTO telemetry_receipts(event_id,user_id,received_at) VALUES (?,?,?)').bind(eventId,userId,now));
  await db.batch(statements);
}
