-- Which spam rule filed a message in Junk, so false positives can be audited.
-- NULL means no rule fired: either it went to Inbox, or it reached Junk on dmarc=fail.
ALTER TABLE emails ADD COLUMN spam_rule TEXT;
