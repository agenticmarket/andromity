-- Additive migration. Run before deploying the measurement-aware Worker.
CREATE TABLE IF NOT EXISTS activity_days (
  user_id TEXT NOT NULL, session_id TEXT NOT NULL, date TEXT NOT NULL,
  client TEXT NOT NULL, os TEXT NOT NULL, version TEXT NOT NULL,
  country TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  provider_type TEXT NOT NULL, profile TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY(user_id, session_id, date)
);
CREATE INDEX IF NOT EXISTS idx_activity_date_user ON activity_days(date, user_id);
CREATE TABLE IF NOT EXISTS task_runs (
  run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
  client TEXT NOT NULL, version TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT,
  active_seconds REAL, first_response_ms INTEGER, date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_date ON task_runs(date);
CREATE TABLE IF NOT EXISTS telemetry_receipts (
  event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_received ON telemetry_receipts(received_at);

CREATE TABLE IF NOT EXISTS telemetry_stats_cache (
  cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stats_cache_expiry ON telemetry_stats_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_events_session_event_id ON events(session_id,event,id);
CREATE INDEX IF NOT EXISTS idx_features_session_date ON feature_events(session_id,date);
CREATE INDEX IF NOT EXISTS idx_activity_session_date_user ON activity_days(session_id,date,user_id);
CREATE INDEX IF NOT EXISTS idx_task_session_date ON task_runs(session_id,date);

CREATE TABLE IF NOT EXISTS activity_facts (
  user_id TEXT NOT NULL, session_id TEXT NOT NULL, date TEXT NOT NULL,
  client TEXT NOT NULL, os TEXT NOT NULL, version TEXT NOT NULL,
  country TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  provider_type TEXT NOT NULL, profile TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY(user_id,session_id,date,client,os,version,country,provider,model,provider_type,profile)
);

CREATE INDEX IF NOT EXISTS idx_facts_date_user ON activity_facts(date,user_id);
CREATE INDEX IF NOT EXISTS idx_facts_session_date_user ON activity_facts(session_id,date,user_id);
