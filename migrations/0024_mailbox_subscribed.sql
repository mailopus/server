-- JMAP isSubscribed (RFC 8621 §2): the web app hides unsubscribed labels in its sidebar, and IMAP
-- clients get the same flag through LSUB. Everything starts subscribed.
ALTER TABLE mailboxes ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 1;
