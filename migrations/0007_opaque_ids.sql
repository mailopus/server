-- Replace readable ids (the first account was seeded as "sam", "sam-inbox", ...) with random ones.
-- Copy each parent row under its new id, repoint children, then delete the old parents, so no
-- statement ever leaves a dangling reference (no reliance on deferred foreign keys).
-- On a fresh database every table here is empty and this does nothing.

CREATE TABLE _id_map (kind TEXT NOT NULL, old TEXT NOT NULL, new TEXT NOT NULL, PRIMARY KEY (kind, old));
INSERT INTO _id_map SELECT 'user', id, lower(hex(randomblob(16))) FROM users;
INSERT INTO _id_map SELECT 'account', id, lower(hex(randomblob(16))) FROM accounts;
INSERT INTO _id_map SELECT 'mailbox', id, lower(hex(randomblob(16))) FROM mailboxes;
INSERT INTO _id_map SELECT 'identity', id, lower(hex(randomblob(16))) FROM identities;

-- 1. New parent rows.
INSERT INTO users (id, name)
	SELECT m.new, u.name FROM users u JOIN _id_map m ON m.kind = 'user' AND m.old = u.id;
INSERT INTO accounts (id, name, modseq, user_id)
	SELECT m.new, a.name, a.modseq, (SELECT new FROM _id_map WHERE kind = 'user' AND old = a.user_id)
	FROM accounts a JOIN _id_map m ON m.kind = 'account' AND m.old = a.id;
INSERT INTO mailboxes (id, account_id, name, role, uidvalidity, uidnext)
	SELECT m.new, (SELECT new FROM _id_map WHERE kind = 'account' AND old = b.account_id), b.name, b.role, b.uidvalidity, b.uidnext
	FROM mailboxes b JOIN _id_map m ON m.kind = 'mailbox' AND m.old = b.id;
INSERT INTO identities (id, account_id, name, email)
	SELECT m.new, (SELECT new FROM _id_map WHERE kind = 'account' AND old = i.account_id), i.name, i.email
	FROM identities i JOIN _id_map m ON m.kind = 'identity' AND m.old = i.id;

-- 2. Repoint children.
UPDATE passkeys SET user_id = (SELECT new FROM _id_map WHERE kind = 'user' AND old = passkeys.user_id)
	WHERE user_id IN (SELECT old FROM _id_map WHERE kind = 'user');
UPDATE sessions SET user_id = (SELECT new FROM _id_map WHERE kind = 'user' AND old = sessions.user_id)
	WHERE user_id IN (SELECT old FROM _id_map WHERE kind = 'user');
UPDATE invites SET user_id = (SELECT new FROM _id_map WHERE kind = 'user' AND old = invites.user_id)
	WHERE user_id IN (SELECT old FROM _id_map WHERE kind = 'user');
UPDATE challenges SET user_id = (SELECT new FROM _id_map WHERE kind = 'user' AND old = challenges.user_id)
	WHERE user_id IN (SELECT old FROM _id_map WHERE kind = 'user');
UPDATE addresses SET account_id = (SELECT new FROM _id_map WHERE kind = 'account' AND old = addresses.account_id)
	WHERE account_id IN (SELECT old FROM _id_map WHERE kind = 'account');
UPDATE emails SET account_id = (SELECT new FROM _id_map WHERE kind = 'account' AND old = emails.account_id)
	WHERE account_id IN (SELECT old FROM _id_map WHERE kind = 'account');
UPDATE sent_message_ids SET account_id = (SELECT new FROM _id_map WHERE kind = 'account' AND old = sent_message_ids.account_id)
	WHERE account_id IN (SELECT old FROM _id_map WHERE kind = 'account');
UPDATE email_mailboxes SET mailbox_id = (SELECT new FROM _id_map WHERE kind = 'mailbox' AND old = email_mailboxes.mailbox_id)
	WHERE mailbox_id IN (SELECT old FROM _id_map WHERE kind = 'mailbox');

-- 3. Old parents, children first.
DELETE FROM identities WHERE id IN (SELECT old FROM _id_map WHERE kind = 'identity');
DELETE FROM mailboxes WHERE id IN (SELECT old FROM _id_map WHERE kind = 'mailbox');
DELETE FROM accounts WHERE id IN (SELECT old FROM _id_map WHERE kind = 'account');
DELETE FROM users WHERE id IN (SELECT old FROM _id_map WHERE kind = 'user');

DROP TABLE _id_map;
