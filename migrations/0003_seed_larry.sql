-- No-op. This migration used to seed the first account; users now come from scripts/create-user.mjs
-- with random ids. The file stays so the applied-migration history still lines up.
SELECT 1;
