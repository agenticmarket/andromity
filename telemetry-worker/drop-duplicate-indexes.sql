-- Each index below is a prefix of a composite index that remains, so queries keep
-- an index while every insert writes fewer index rows.
DROP INDEX IF EXISTS idx_feature_events_session_id;
DROP INDEX IF EXISTS idx_feature_events_user_id;
DROP INDEX IF EXISTS idx_events_session_id;
DROP INDEX IF EXISTS idx_events_sess_event;
DROP INDEX IF EXISTS idx_sessions_user;
DROP INDEX IF EXISTS idx_task_runs_session;
