-- Values an instance makes for itself on first use, so a fresh deploy needs no secrets.
-- 'vapid': the web push key pair, JSON {publicKey, privateJWK}.
CREATE TABLE instance_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
