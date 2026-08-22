#!/usr/bin/env node
import { runCli } from "@hermes/skill-lint/cli.js";

process.exit(await runCli(process.argv.slice(2)));
