-- Compact daily facts retain cohort dimensions without scanning raw events.
CREATE TABLE IF NOT EXISTS activity_facts (
  user_id TEXT NOT NULL, session_id TEXT NOT NULL, date TEXT NOT NULL,
  client TEXT NOT NULL, os TEXT NOT NULL, version TEXT NOT NULL,
  country TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  provider_type TEXT NOT NULL, profile TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY(user_id,session_id,date,client,os,version,country,provider,model,provider_type,profile)
);
INSERT OR IGNORE INTO activity_facts SELECT * FROM activity_days;
INSERT OR IGNORE INTO activity_facts
SELECT user_id, session_id, date, client, COALESCE(os,'unknown'), COALESCE(version,'unknown'),
  COALESCE(country,'XX'), COALESCE(provider,'unknown'), COALESCE(model,'unknown'),
  COALESCE(provider_type,'cloud'), COALESCE(profile,'builder'), created_at FROM sessions;
INSERT OR IGNORE INTO activity_facts
SELECT e.user_id, COALESCE(e.session_id,''), e.date, COALESCE(e.client,'unknown'),
  COALESCE(e.os,'unknown'), COALESCE(e.version,'unknown'), COALESCE(s.country,'XX'),
  COALESCE(e.provider,s.provider,'unknown'), COALESCE(e.model,s.model,'unknown'),
  COALESCE(e.provider_type,s.provider_type,'cloud'), COALESCE(s.profile,'builder'), e.created_at
FROM events e LEFT JOIN sessions s ON s.session_id=e.session_id;
INSERT OR IGNORE INTO activity_facts
SELECT f.user_id, COALESCE(f.session_id,''), f.date, COALESCE(f.client,'unknown'),
  COALESCE(f.os,'unknown'), COALESCE(f.version,'unknown'), COALESCE(s.country,'XX'),
  COALESCE(s.provider,'unknown'), COALESCE(s.model,'unknown'), COALESCE(s.provider_type,'cloud'),
  COALESCE(s.profile,'builder'), f.created_at
FROM feature_events f LEFT JOIN sessions s ON s.session_id=f.session_id;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_events_session_event_id ON events(session_id,event,id);
CREATE INDEX IF NOT EXISTS idx_features_session_date ON feature_events(session_id,date);
CREATE INDEX IF NOT EXISTS idx_activity_session_date_user ON activity_days(session_id,date,user_id);
CREATE INDEX IF NOT EXISTS idx_facts_date_user ON activity_facts(date,user_id);
CREATE INDEX IF NOT EXISTS idx_facts_session_date_user ON activity_facts(session_id,date,user_id);
CREATE INDEX IF NOT EXISTS idx_task_session_date ON task_runs(session_id,date);
CREATE TABLE IF NOT EXISTS telemetry_stats_cache (
  cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stats_cache_expiry ON telemetry_stats_cache(expires_at);
