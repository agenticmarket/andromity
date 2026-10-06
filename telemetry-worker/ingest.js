const allowedEvents = new Set(['session_start', 'session_end', 'weekly_summary', 'compact_triggered', 'feature_use', 'session_update', 'task_started', 'task_finished']);
const number = value => Math.min(86400000, Math.max(0, Number(value) || 0));

export async function ingestTelemetry(db, data, fields) {
  const { userId, sessionId, client, os, version, country, provider, model, providerType, profile, reasoningEffort, mcpToolsCount, now, date } = fields;
  const event = data.event || 'session_start';
  if (!allowedEvents.has(event)) throw new TypeError('Unknown event type');
  const eventId = data.event_id || '';
  if (eventId && !/^[a-zA-Z0-9_-]{16,64}$/.test(eventId)) throw new TypeError('Invalid event ID');
  const statements = [];
  const add = (sql, args) => {
    if (eventId) {
      const guard = 'NOT EXISTS (SELECT 1 FROM telemetry_receipts WHERE event_id=?)';
      sql = sql.replace(/VALUES\s*\(([^)]*)\)/i, (_, values) => `SELECT ${values} WHERE ${guard}`);
      if (/^\s*UPDATE/i.test(sql)) sql += ` AND ${guard}`;
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
      duration_seconds=MAX(sessions.duration_seconds,excluded.duration_seconds),turn_count=MAX(sessions.turn_count,excluded.turn_count)`,
      [sessionId,userId,client,country,os,version,provider,model,providerType,reasoningEffort,mcpToolsCount,profile,duration,turns,now,date]);
  }
  if (event === 'feature_use') {
    const feature = String(data.feature || data.feature_name || 'unknown').toLowerCase().slice(0,64).replace(/[^a-z0-9_-]/g,'');
    add(`INSERT INTO feature_events(feature_name,user_id,session_id,client,os,version,created_at,date) VALUES (?,?,?,?,?,?,?,?)`,
      [feature,userId,sessionId,client,os,version,now,date]);
  }
  if (event === 'session_end' || event === 'compact_triggered') {
    const bucket = ['0-5min','5-15min','15-30min','30min+'].includes(data.duration_bucket) ? data.duration_bucket : '0-5min';
    add(`INSERT INTO events(event,user_id,session_id,client,os,version,provider,model,provider_type,turn_count,had_error,duration_bucket,tool_bash_count,tool_file_count,tool_web_count,created_at,date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [event,userId,sessionId,client,os,version,provider,model,providerType,turns,data.had_error ? 1 : 0,bucket,
        number(data.tool_bash_count),number(data.tool_file_count),number(data.tool_web_count),now,date]);
  }
  if (event === 'weekly_summary') {
    add(`INSERT INTO events(event,user_id,client,os,version,created_at,date) VALUES (?,?,?,?,?,?,?)`,
      [event,userId,client,os,version,now,date]);
  }
  if (event === 'task_started' || event === 'task_finished') {
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(data.run_id || '')) throw new TypeError('Invalid run ID');
    const outcome = event === 'task_finished' ? data.outcome : null;
    if (event === 'task_finished' && !['completed','failed','cancelled'].includes(outcome)) throw new TypeError('Invalid outcome');
    add(`INSERT INTO task_runs(run_id,user_id,session_id,client,version,provider,model,started_at,finished_at,outcome,active_seconds,first_response_ms,date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      finished_at=COALESCE(excluded.finished_at,task_runs.finished_at),outcome=COALESCE(excluded.outcome,task_runs.outcome),
      active_seconds=COALESCE(excluded.active_seconds,task_runs.active_seconds),first_response_ms=COALESCE(excluded.first_response_ms,task_runs.first_response_ms),
      started_at=MIN(task_runs.started_at,excluded.started_at)`,
      [data.run_id,userId,sessionId,client,version,provider,model,now,event==='task_finished'?now:null,outcome,
        event==='task_finished'?number(data.active_seconds):null,data.first_response_ms == null ? null : number(data.first_response_ms),date]);
  }
  if (eventId) statements.push(db.prepare('INSERT OR IGNORE INTO telemetry_receipts(event_id,user_id,received_at) VALUES (?,?,?)').bind(eventId,userId,now));
  await db.batch(statements);
}
