-- Where a message was actually delivered, from its Delivered-To headers, first hop first:
-- ["admin@client.example", "sam@acme.example"] for a forward. NULL until parsed (the backfill
-- fills old rows), [] when the message has none.
ALTER TABLE emails ADD COLUMN delivered_json TEXT;
CREATE INDEX emails_delivered_pending ON emails (id) WHERE delivered_json IS NULL;
