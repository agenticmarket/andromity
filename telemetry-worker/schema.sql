-- =====================================================================
-- Andromity Telemetry Schema  (Cloudflare D1)  — v2
-- Privacy-safe: no IPs stored, no content, no paths, no prompts.
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
    user_id       TEXT    PRIMARY KEY,
    first_seen    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen     TEXT    NOT NULL DEFAULT (datetime('now')),
    country       TEXT,
    session_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_users_first_seen ON users(first_seen);

-- -----------------------------------------------------------------------
-- sessions: one row per session start
-- v2 adds: provider, model, provider_type, reasoning_effort, mcp_tools_count
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT    NOT NULL UNIQUE,
    user_id          TEXT    NOT NULL,
    client           TEXT    NOT NULL,
    country          TEXT,
    os               TEXT,
    version          TEXT,
    -- v2 model/provider fields --
    provider         TEXT,
    model            TEXT,
    provider_type    TEXT,
    reasoning_effort TEXT,
    mcp_tools_count  INTEGER,
    -- v3 profile & session progress --
    profile          TEXT DEFAULT 'builder',
    duration_seconds INTEGER DEFAULT 0,
    turn_count       INTEGER DEFAULT 1,
    -- timestamps --
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    date             TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_date        ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_user_date   ON sessions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_client      ON sessions(client);
CREATE INDEX IF NOT EXISTS idx_sessions_country     ON sessions(country);
CREATE INDEX IF NOT EXISTS idx_sessions_provider    ON sessions(provider);
CREATE INDEX IF NOT EXISTS idx_sessions_model       ON sessions(model);
CREATE INDEX IF NOT EXISTS idx_sessions_ptype       ON sessions(provider_type);
CREATE INDEX IF NOT EXISTS idx_sessions_profile     ON sessions(profile);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at  ON sessions(created_at DESC);


-- -----------------------------------------------------------------------
-- events: lifecycle events (session_end, compact_triggered)
-- Aggregate, non-content data only.
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    event            TEXT    NOT NULL,
    user_id          TEXT    NOT NULL,
    session_id       TEXT,
    client           TEXT,
    os               TEXT,
    version          TEXT,
    provider         TEXT,
    model            TEXT,
    provider_type    TEXT,
    turn_count       INTEGER,
    had_error        INTEGER,
    duration_bucket  TEXT,
    tool_bash_count  INTEGER DEFAULT 0,
    tool_file_count  INTEGER DEFAULT 0,
    tool_web_count   INTEGER DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    date             TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_date       ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_event      ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_provider   ON events(provider);
CREATE INDEX IF NOT EXISTS idx_events_model      ON events(model);

-- -----------------------------------------------------------------------
-- feature_events: user interaction with key features (waterfall, side_by_side, etc.)
-- Zero PII: only aggregate counts & features
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_name TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    session_id   TEXT,
    client       TEXT,
    os           TEXT,
    version      TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    date         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_events_name       ON feature_events(feature_name);
CREATE INDEX IF NOT EXISTS idx_feature_events_date       ON feature_events(date);
CREATE INDEX IF NOT EXISTS idx_feature_events_session_id ON feature_events(session_id);
CREATE INDEX IF NOT EXISTS idx_feature_events_user_id    ON feature_events(user_id);
CREATE INDEX IF NOT EXISTS idx_fe_user_feat              ON feature_events(user_id, feature_name);
CREATE INDEX IF NOT EXISTS idx_fe_sess_feat              ON feature_events(session_id, feature_name);
CREATE INDEX IF NOT EXISTS idx_events_sess_event         ON events(session_id, event);


-- -----------------------------------------------------------------------
-- Migration (run on existing D1 databases):
-- ALTER TABLE sessions ADD COLUMN provider         TEXT;
-- ALTER TABLE sessions ADD COLUMN model            TEXT;
-- ALTER TABLE sessions ADD COLUMN provider_type    TEXT;
-- ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;
-- ALTER TABLE sessions ADD COLUMN mcp_tools_count  INTEGER;
-- ALTER TABLE sessions ADD COLUMN profile          TEXT DEFAULT 'builder';
-- ALTER TABLE sessions ADD COLUMN duration_seconds INTEGER DEFAULT 0;
-- ALTER TABLE sessions ADD COLUMN turn_count       INTEGER DEFAULT 1;
-- -----------------------------------------------------------------------

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
