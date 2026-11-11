import { isClaimable } from "../../../lib/claim";

// Whether this instance still waits for its owner. Pre-auth (server/lib/gate.ts) and rate limited.
export default defineEventHandler(async (event) => ({ open: await isClaimable(cfEnv(event).DB) }));
