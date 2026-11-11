#!/usr/bin/env node
import { main } from "./cli.mjs";

// `mailopus address list | head` closes the pipe early. That is not an error.
process.stdout.on("error", (e) => e.code === "EPIPE" && process.exit(0));
process.exitCode = await main(process.argv.slice(2));
