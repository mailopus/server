-- Which of your addresses each email reached, lowercased: the same rule as the row postmark
-- (app/utils/postmark.ts deliveredTo). The writer fills it for new mail; existing rows are filled in
-- batches by ADDRESSED_BACKFILL (server/lib/addressed.ts). Read through Email/query's addressedTo filter.
ALTER TABLE emails ADD COLUMN addressed_to TEXT;

-- Named sets of your addresses ("Work", "Personal") that narrow the mail views. A pattern is an
-- address or "@domain".
CREATE TABLE address_groups (
	user_id TEXT NOT NULL REFERENCES users (id),
	id TEXT NOT NULL,
	name TEXT NOT NULL,
	patterns_json TEXT NOT NULL,
	position INTEGER NOT NULL,
	PRIMARY KEY (user_id, id)
);
