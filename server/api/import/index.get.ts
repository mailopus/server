// Admin: the Gmail import jobs on this server and the workspaces it holds a key for, for Settings.
// See server/lib/import-jobs.ts.
import { importOverview } from "../../lib/import-jobs";

export default defineEventHandler((event) => importApi(event, importOverview));
