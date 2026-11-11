-- The admin adds and removes addresses, turns each domain's catch-all on or off, and invites people.
-- The claimer is admin (server/lib/claim.ts). On an instance that predates this, the earliest user is:
-- ids are random, so rowid is the only order users have.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
UPDATE users SET is_admin = 1 WHERE rowid = (SELECT min(rowid) FROM users);
