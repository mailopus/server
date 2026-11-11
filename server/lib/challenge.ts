// Plain module so tests can import it.
import { randomToken } from "./auth.ts";

export const CHALLENGE_TAG = "mailopus1";

/**
 * A WebAuthn challenge that names the server that issued it: "mailopus1 <origin> <random>". Every server
 * shares RP ID mailopus.net, so a passkey signs for any of them. The sign-in pages at app.mailopus.net
 * refuse a challenge naming a server other than the one they resolved (checkChallenge in
 * public/auth/backend.js), which stops a hostile server relaying another server's challenge.
 */
export const boundChallenge = (origin: string) => `${CHALLENGE_TAG} ${origin} ${randomToken()}`;
