-- Senders you never want to hear from again. Matched on delivery in spamRuleFor; a hit lands
-- the message in Junk under the rule name "blocked-sender", reusing the existing junk routing.
--
-- Two shapes of pattern, both lowercase:
--   "editor@members.wayfair.com"  one address
--   "@members.wayfair.com"        that host and any subdomain of it
-- The host form is deliberately the sending host, not the registrable domain, so blocking
-- Wayfair's marketing (members.wayfair.com) leaves their order mail (service.wayfair.com) alone.
CREATE TABLE blocked_senders (
	account_id TEXT NOT NULL REFERENCES accounts (id),
	pattern    TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, pattern)
);
