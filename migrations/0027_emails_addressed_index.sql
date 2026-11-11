-- For app passwords limited to some addresses (0026): their folder counts and lists filter live mail
-- by addressed_to. Without this the count scans every email row, deleted ones included.
CREATE INDEX emails_account_addressed ON emails (account_id, addressed_to) WHERE destroyed_modseq IS NULL;
