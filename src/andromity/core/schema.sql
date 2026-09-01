-- Andromity Core SQLite Schema
-- Version 1

CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    project_hash    TEXT NOT NULL,
    project_path    TEXT NOT NULL,
    name            TEXT NOT NULL DEFAULT 'new-session',
    status          TEXT NOT NULL DEFAULT 'idle',
    provider        TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    token_total     INTEGER NOT NULL DEFAULT 0,
    context_tokens  INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0.0,
    cost_source     TEXT NOT NULL DEFAULT 'unpriced',
    usage_breakdown TEXT NOT NULL DEFAULT '{}',
    plan            TEXT,
    compacted_history TEXT NOT NULL DEFAULT '[]',
    parent_session  TEXT,
    branch_point    TEXT,
    allowed_commands TEXT NOT NULL DEFAULT '[]',
    allowed_domains  TEXT NOT NULL DEFAULT '[]',
    sync_dirty      INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project 
    ON sessions(project_hash, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_status 
    ON sessions(status);

CREATE TABLE IF NOT EXISTS session_messages (
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT,
    tool_calls      TEXT,
    thinking        TEXT,
    name            TEXT,
    tool_call_id    TEXT,
    ts              TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq 
    ON session_messages(session_id, seq ASC);

CREATE TABLE IF NOT EXISTS session_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    type            TEXT NOT NULL,
    payload         TEXT NOT NULL,
    ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_events_session 
    ON session_events(session_id, seq ASC);

CREATE TABLE IF NOT EXISTS cron_jobs (
    id                  TEXT PRIMARY KEY,
    project_path        TEXT NOT NULL,
    name                TEXT NOT NULL,
    prompt              TEXT NOT NULL,
    schedule            TEXT NOT NULL DEFAULT 'every 1h',
    interval_seconds    INTEGER NOT NULL DEFAULT 3600,
    provider            TEXT NOT NULL DEFAULT 'anthropic',
    model               TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    mode                TEXT NOT NULL DEFAULT 'trust',
    allowed_commands    TEXT NOT NULL DEFAULT '[]',
    on_failure          TEXT NOT NULL DEFAULT 'retry',
    retry_delay_seconds INTEGER NOT NULL DEFAULT 0,
    timeout_seconds     INTEGER NOT NULL DEFAULT 600,
    enabled             INTEGER NOT NULL DEFAULT 1,
    last_run            TEXT,
    last_status         TEXT NOT NULL DEFAULT 'never',
    last_error          TEXT,
    run_count           INTEGER NOT NULL DEFAULT 0,
    fail_count          INTEGER NOT NULL DEFAULT 0,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_project 
    ON cron_jobs(project_path);

CREATE TABLE IF NOT EXISTS cron_runs (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
    job_name        TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'running',
    prompt          TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT '',
    session_id      TEXT,
    output          TEXT NOT NULL DEFAULT '',
    output_preview  TEXT NOT NULL DEFAULT '',
    tools_used      TEXT NOT NULL DEFAULT '[]',
    files_modified  TEXT NOT NULL DEFAULT '[]',
    tool_executions TEXT NOT NULL DEFAULT '[]',
    error           TEXT,
    error_traceback TEXT,
    cost_usd        REAL NOT NULL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job 
    ON cron_runs(job_id, started_at DESC);

CREATE TABLE IF NOT EXISTS mcp_server_status (
    name            TEXT NOT NULL,
    project_path    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'unknown',
    tools_count     INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    error_detail    TEXT,
    updated_at      TEXT NOT NULL,
    started_at      TEXT,
    PRIMARY KEY (name, project_path)
);

CREATE TABLE IF NOT EXISTS schema_version (
    version         INTEGER PRIMARY KEY,
    applied_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO schema_version(version) VALUES (1);
