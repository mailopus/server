-- Settings lists passkeys and signed-in devices (server/api/passkeys, server/api/sessions).
-- All nullable: rows from before this keep working and fill in as they're used.
ALTER TABLE passkeys ADD COLUMN name TEXT;
-- 1 when the passkey syncs between devices, 0 when it lives on one. NULL until it next signs in.
ALTER TABLE passkeys ADD COLUMN backed_up INTEGER;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
-- When this session last did a passkey ceremony. NULL counts as created_at: signing in is one.
ALTER TABLE sessions ADD COLUMN verified_at INTEGER;
