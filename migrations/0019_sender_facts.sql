-- Cache for the two lookups the delivery path makes about a sender: how old its domain is
-- (RDAP) and whether its IP has reverse DNS (PTR). Both are slow, both are external, and
-- both were being asked on every single message.
--
-- value is NULL when the lookup gave no usable answer. The row is still written so one
-- unanswerable sender cannot cause a lookup per message, and checked_at is what lets an
-- unknown be retried later instead of being wrong forever.
CREATE TABLE IF NOT EXISTS sender_facts (
  key        TEXT PRIMARY KEY,  -- "domain:<registrable domain>" | "ptr:<ipv4>"
  value      INTEGER,           -- domain: registration unix ms. ptr: 1 has PTR, 0 does not.
  checked_at INTEGER NOT NULL
);
