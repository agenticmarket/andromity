-- Answers people send from a client's waitlist form: what they would want and where they heard about Andromity.
-- Stored without an email address, the telemetry ID or the IP address, and with the UTC day only, not the time,
-- so an entry cannot be matched to usage data.
CREATE TABLE IF NOT EXISTS waitlist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    wants       TEXT    NOT NULL,
    wants_note  TEXT,
    heard_from  TEXT    NOT NULL,
    heard_note  TEXT,
    client      TEXT    NOT NULL,
    os          TEXT    NOT NULL,
    version     TEXT    NOT NULL,
    country     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (date('now'))
);

CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist(created_at);
