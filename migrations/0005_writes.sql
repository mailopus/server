-- Destroyed emails keep their row as a tombstone so Email/changes can report them.
ALTER TABLE emails ADD COLUMN destroyed_modseq INTEGER;

-- Addresses an account may send as. Submission refuses any other From.
CREATE TABLE identities (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id),
	name TEXT NOT NULL,
	email TEXT NOT NULL
);
