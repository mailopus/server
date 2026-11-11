-- Two full scans D1 reported as "overloaded" errors on 2026-11-08.
--
-- 1. emails_account_addressed (0027) only required destroyed_modseq IS NULL, which nearly every mail
--    query has, so the planner picked it for unrelated lookups and walked the whole account (~57k rows
--    per thread or id lookup). With addressed_to IS NOT NULL it's only usable when a query filters on
--    addressed_to and says so (=, IN imply NOT NULL; LIKE doesn't, so server/lib/addressed.ts adds IS NOT NULL).
DROP INDEX IF EXISTS emails_account_addressed;
CREATE INDEX emails_account_addressed ON emails (account_id, addressed_to) WHERE destroyed_modseq IS NULL AND addressed_to IS NOT NULL;

-- 2. Destroying a message ran DELETE FROM emails_fts WHERE email_id = ?, a scan of every indexed message
--    (~211k rows, 1.5s each) because FTS5 can't index an UNINDEXED column. c0 of the content table is
--    email_id; with this index the delete finds the row by rowid (server/lib/jmap/write.ts).
CREATE INDEX IF NOT EXISTS emails_fts_content_email ON emails_fts_content (c0);
