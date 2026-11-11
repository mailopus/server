import { cliPluginCall } from "../../lib/plugin-hooks";

// `mailopus with <plugin>` and `mailopus plugin test`, passed on to a plugin over its binding.
// No session: the gate lets this path through, and the one-time token the CLI wrote to D1 is the credential.
export default defineEventHandler(async (event) => cliPluginCall(cfEnv(event), await readBody(event).catch(() => null)));
