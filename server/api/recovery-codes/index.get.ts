import { recoveryStatus } from "../../lib/recovery";

// How many recovery codes are left, for Settings. Never the codes: only their hashes are stored.
export default defineEventHandler(async (event) => recoveryStatus(cfEnv(event).DB, await requireSessionUser(event)));
