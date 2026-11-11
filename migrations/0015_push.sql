-- Web Push subscriptions, one per browser or installed app. Pushes go to every subscription of the
-- user who owns the account that got the mail.
CREATE TABLE push_subscriptions (
	endpoint TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id),
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
