-- Authenticator codes (RFC 6238) as a second step after the passkey at sign-in (server/lib/totp.ts). Optional, per
-- user. totp_secret: base32, set once enrolment is confirmed. totp_pending: the secret shown in Settings until a
-- code from it is entered. totp_last_step: the newest 30-second step used, so a code works once.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
