-- App passwords: the networks one has been used from (JSON array of /24 and /48 prefixes, newest last), so a
-- push can say when a new one appears, and when the last such push went, so it's at most one a day.
ALTER TABLE app_passwords ADD COLUMN seen_networks TEXT;
ALTER TABLE app_passwords ADD COLUMN alerted_at INTEGER;

-- /api/ingest: signatures already accepted. A signed request is good for five minutes, and without this
-- a captured one could be replayed in that window and stored again.
CREATE TABLE ingest_seen (
	sig TEXT PRIMARY KEY,
	at INTEGER NOT NULL
);

-- Purging tombstones (server/lib/purge.ts, off unless PURGE_TOMBSTONES_DAYS is set). A destroyed email keeps
-- its row so Email/changes can report it. destroyed_at is when, so a purge can leave recent ones; rows
-- destroyed before this have NULL and count as old. purged_modseq is the newest state a purge has removed
-- a tombstone for: a client asking for changes since before it gets cannotCalculateChanges and resyncs.
-- purge_cursor is how far the purge has walked the account, in updated_modseq order.
ALTER TABLE emails ADD COLUMN destroyed_at INTEGER;
ALTER TABLE accounts ADD COLUMN purged_modseq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN purge_cursor INTEGER NOT NULL DEFAULT 0;
