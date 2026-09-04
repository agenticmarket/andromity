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

CREATE INDEX IF NOT EXISTS idx_events_date     ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_event    ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider);
CREATE INDEX IF NOT EXISTS idx_events_model    ON events(model);

-- -----------------------------------------------------------------------
-- Migration (run on existing D1 databases):
-- ALTER TABLE sessions ADD COLUMN provider         TEXT;
-- ALTER TABLE sessions ADD COLUMN model            TEXT;
-- ALTER TABLE sessions ADD COLUMN provider_type    TEXT;
-- ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;
-- ALTER TABLE sessions ADD COLUMN mcp_tools_count  INTEGER;
-- -----------------------------------------------------------------------
