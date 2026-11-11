-- Gmail's own count for the mailbox (users.getProfile messagesTotal), refreshed each run, so status
-- can show how far an import has got.
ALTER TABLE import_jobs ADD COLUMN messages_total INTEGER;
