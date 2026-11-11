-- A search needs each match's email id. FTS5 keeps it in the content table beside the message text, so
-- reading it loaded the text's row: 150 to 200 ms for a thousand matches on a cold database, and the whole
-- cost of a first search. This index holds (search rowid, email id) on its own, so the lookup never touches
-- the text. SQLite keeps it up to date as FTS5 writes the content table.
CREATE INDEX IF NOT EXISTS emails_fts_content_id ON emails_fts_content (id, c0);
