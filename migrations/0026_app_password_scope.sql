-- An app password limited to some of your addresses: a JSON array of address patterns ("me@x.com",
-- "@x.com"), matched against emails.addressed_to (migration 0025). NULL means all mail.
ALTER TABLE app_passwords ADD COLUMN scope_json TEXT;
