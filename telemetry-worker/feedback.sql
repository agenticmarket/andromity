-- Notes users write and send themselves from a client's feedback box.
-- Stored without the telemetry ID or IP address, so a note is not linked to usage data.
CREATE TABLE IF NOT EXISTS feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message     TEXT    NOT NULL,
    client      TEXT    NOT NULL,
    os          TEXT    NOT NULL,
    version     TEXT    NOT NULL,
    country     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
