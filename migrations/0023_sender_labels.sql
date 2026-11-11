-- Keep/delete/review decisions per sender address, from cleanup reviews.
-- Training data for sorting future mail: join to emails on the From address. source is 'user' when
-- the user chose it, 'rule' when they left the suggestion. Destroyed emails keep their rows (destroyed_modseq),
-- so the examples survive the delete.
CREATE TABLE sender_labels (
	account_id TEXT NOT NULL REFERENCES accounts (id),
	address TEXT NOT NULL,
	verdict TEXT NOT NULL CHECK (verdict IN ('keep', 'delete', 'review')),
	source TEXT NOT NULL CHECK (source IN ('user', 'rule')),
	reason TEXT,
	decided_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, address)
);
