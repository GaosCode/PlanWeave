#!/usr/bin/env node
import { runAgentHostCli } from "./operator/cli.js";

process.exitCode = await runAgentHostCli(process.argv.slice(2), {
  onShutdownRequiresProcessExit: process.exit
});
