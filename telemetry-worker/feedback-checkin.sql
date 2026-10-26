-- The in-chat check-in: how a user feels about Andromity and what annoys them most.
-- Run once after feedback.sql. Like the note itself, neither column is linked to a telemetry ID.
ALTER TABLE feedback ADD COLUMN sentiment TEXT;
ALTER TABLE feedback ADD COLUMN annoyances TEXT;
