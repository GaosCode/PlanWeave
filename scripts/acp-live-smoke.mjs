import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";

const profiles = {
  "codex-acp": { command: "codex-acp", versionArgs: ["--version"] },
  "claude-code-acp": { command: "claude-agent-acp", versionArgs: ["--version"] },
  "opencode-acp": { command: "opencode", versionArgs: ["--version"] },
  "pi-acp": { command: "pi-acp", versionArgs: ["--version"] }
};

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    diagnostic: result.status === 0
      ? null
      : `${command} ${args.join(" ")} exited ${result.status ?? "without status"}`
  };
}

function json(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

const profile = option("--profile");
const evidencePath = option("--evidence");
if (!profile || !(profile in profiles) || !evidencePath) {
  console.error("Usage: node scripts/acp-live-smoke.mjs --profile <explicit-*-acp-name> --evidence <path>");
  process.exit(2);
}

const startedAt = new Date().toISOString();
const planweave = process.env.PLANWEAVE_BIN ?? "planweave";
const definition = profiles[profile];
const agentVersion = run(definition.command, definition.versionArgs);
const planweaveVersion = run(planweave, ["--version"]);
const trust = run(planweave, ["trust", "executor", profile, "--json"]);
const preflight = run(planweave, ["executors", "test", profile, "--json"]);
const execution = run(planweave, [
  "run", "--once", "--executor", profile, "--timeout", "120000", "--json"
]);
const executionValue = json(execution.stdout);
const sessionId = executionValue?.session?.sessionId ?? executionValue?.sessionId ?? null;
const session = sessionId
  ? run(planweave, ["run-session", sessionId, "--json"])
  : { ok: false, stdout: "", diagnostic: "Run output did not contain a session id." };
const sessionValue = json(session.stdout);
const runner = sessionValue?.runnerReadModel ?? null;
const runnerEvents = Array.isArray(runner?.events) ? runner.events : [];
const permissionRequestIds = new Set(
  runnerEvents.flatMap((event) =>
    event?.body?.kind === "interaction" &&
    event.body.interaction?.kind === "permission" &&
    typeof event.body.interaction.requestId === "string"
      ? [event.body.interaction.requestId]
      : []
  )
);
const permissionBoundary = runnerEvents.some((event) =>
  event?.body?.kind === "interaction_result" &&
  event.body.interactionKind === "permission" &&
  permissionRequestIds.has(event.body.requestId) &&
  ["approved", "denied", "cancelled"].includes(event.body.outcome)
);
const checks = {
  trusted: trust.ok,
  preflight: preflight.ok && json(preflight.stdout)?.ok === true,
  session: execution.ok && session.ok,
  streaming: runnerEvents.some((event) =>
    event?.body?.kind === "message" || event?.body?.kind === "tool_call"
  ),
  intervention: permissionBoundary,
  artifact: executionValue?.steps?.some((step) => step?.kind === "submitted") === true,
  cleanup: runner?.terminal === true,
  replay: runner?.cursor?.terminal === true && runnerEvents.length > 0
};
const passed = agentVersion.ok && planweaveVersion.ok && Object.values(checks).every(Boolean);
const diagnostic = [agentVersion, planweaveVersion, trust, preflight, execution, session]
  .find((result) => !result.ok)?.diagnostic ?? (passed ? null : "One or more required ACP-GATE checks did not pass.");
const evidence = {
  version: "planweave.acp-live-smoke/v1",
  profile,
  agentVersion: agentVersion.stdout || "unavailable",
  planweaveVersion: planweaveVersion.stdout || "unavailable",
  startedAt,
  finishedAt: new Date().toISOString(),
  checks,
  result: passed ? "passed" : "failed",
  diagnostic
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
chmodSync(evidencePath, 0o600);
console.log(`ACP-GATE ${profile}: ${evidence.result}; evidence=${evidencePath}`);
process.exit(passed ? 0 : 1);
