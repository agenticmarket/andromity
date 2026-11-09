-- Merges each session's session_end rows into its newest row, then removes the rest.
-- Run once after deploying the worker that keeps one session_end row per session.
UPDATE events SET
  turn_count = (SELECT MAX(COALESCE(o.turn_count, 0)) FROM events o
    WHERE o.event = 'session_end' AND o.session_id = events.session_id AND o.user_id = events.user_id),
  had_error = (SELECT MAX(COALESCE(o.had_error, 0)) FROM events o
    WHERE o.event = 'session_end' AND o.session_id = events.session_id AND o.user_id = events.user_id),
  tool_bash_count = (SELECT MAX(COALESCE(o.tool_bash_count, 0)) FROM events o
    WHERE o.event = 'session_end' AND o.session_id = events.session_id AND o.user_id = events.user_id),
  tool_file_count = (SELECT MAX(COALESCE(o.tool_file_count, 0)) FROM events o
    WHERE o.event = 'session_end' AND o.session_id = events.session_id AND o.user_id = events.user_id),
  tool_web_count = (SELECT MAX(COALESCE(o.tool_web_count, 0)) FROM events o
    WHERE o.event = 'session_end' AND o.session_id = events.session_id AND o.user_id = events.user_id),
  duration_bucket = (SELECT o.duration_bucket FROM events o
    WHERE o.event = 'session_end' AND o.session_id = events.session_id AND o.user_id = events.user_id
    ORDER BY CASE o.duration_bucket WHEN '30min+' THEN 3 WHEN '15-30min' THEN 2 WHEN '5-15min' THEN 1 ELSE 0 END DESC
    LIMIT 1)
WHERE event = 'session_end' AND session_id IS NOT NULL
  AND id = (SELECT k.id FROM events k
    WHERE k.event = 'session_end' AND k.session_id = events.session_id AND k.user_id = events.user_id
    ORDER BY k.created_at DESC, k.id DESC LIMIT 1)
  AND (SELECT COUNT(*) FROM events c
    WHERE c.event = 'session_end' AND c.session_id = events.session_id AND c.user_id = events.user_id) > 1;

DELETE FROM events WHERE event = 'session_end' AND session_id IS NOT NULL
  AND id <> (SELECT k.id FROM events k
    WHERE k.event = 'session_end' AND k.session_id = events.session_id AND k.user_id = events.user_id
    ORDER BY k.created_at DESC, k.id DESC LIMIT 1);
