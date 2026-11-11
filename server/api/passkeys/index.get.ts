import { listPasskeys } from "../../lib/sessions";

// The signed-in user's passkeys, for Settings. Never the public keys.
export default defineEventHandler(async (event) => ({ passkeys: await listPasskeys(cfEnv(event).DB, await requireSessionUser(event)) }));
