-- Planner statistics. Without them SQLite rated "account_id = ?" as selective as a primary-key match,
-- so fetching a few emails by id scanned the whole account (205k rows) and D1 reported "overloaded".
-- Rerun (PRAGMA optimize) after adding indexes or a large import.
PRAGMA optimize;
