-- Signature providers sync into the stored signature (Swiftly's write-head contract) instead of being
-- fetched at compose time. These record how the last sync went.
-- signature_status: null when the last sync worked, else the sentence the provider gave (or our error).
ALTER TABLE identities ADD COLUMN signature_status TEXT;
ALTER TABLE identities ADD COLUMN signature_synced_at INTEGER;
