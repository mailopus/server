-- Mailbox counts kept by the writer instead of scanning every email on each Mailbox/get.
ALTER TABLE mailboxes ADD COLUMN total_emails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mailboxes ADD COLUMN unread_emails INTEGER NOT NULL DEFAULT 0;

-- The email's received_at, copied onto each mailbox placement, so "newest in this mailbox" reads an
-- index instead of sorting the whole mailbox. Existing rows were backfilled by a one-off script; new rows get dates on insert.
ALTER TABLE email_mailboxes ADD COLUMN received_at INTEGER;
CREATE INDEX email_mailboxes_newest ON email_mailboxes (mailbox_id, received_at DESC);
