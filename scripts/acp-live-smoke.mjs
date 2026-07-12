import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";

const profiles = {
  "codex-acp": { versionCommand: { command: "codex-acp", args: ["--version"] } },
  "claude-code-acp": {
    versionCommand: { command: "claude-agent-acp", args: ["--version"] }
  },
  "opencode-acp": { versionCommand: { command: "opencode", args: ["--version"] } },
  "pi-acp": { versionCommand: null }
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

function versionFromPreflight(profile, preflight) {
  const value = json(preflight.stdout);
  const name = value?.agentInfo?.name;
  const version = value?.agentInfo?.version;
  const preflightMessage =
    typeof value?.message === "string" && value.message.trim().length > 0
      ? value.message.trim()
      : null;
  const valid = typeof name === "string" && name.trim().length > 0 &&
    typeof version === "string" && version.trim().length > 0;
  return {
    ok: preflight.ok && valid,
    stdout: valid ? version.trim() : "",
    diagnostic:
      !preflight.ok
        ? preflightMessage ?? preflight.diagnostic
        : !valid
          ? `${profile} preflight returned invalid agentInfo; name and version must be non-empty strings.`
          : null
  };
}

function sessionId(value) {
  return value?.session?.sessionId ?? value?.sessionId ?? null;
}

function readSession(planweave, id) {
  return id
    ? run(planweave, ["run-session", id, "--json"])
    : { ok: false, stdout: "", diagnostic: "Run output did not contain a session id." };
}

function runnerFrom(result) {
  return json(result.stdout)?.runnerReadModel ?? null;
}

function events(runner) {
  return Array.isArray(runner?.events) ? runner.events : [];
}

function stableReplay(first, second) {
  if (!first?.cursor?.terminal || !second?.cursor?.terminal) return false;
  if (first.diagnostics?.length !== 0 || second.diagnostics?.length !== 0) return false;
  return JSON.stringify(first.cursor) === JSON.stringify(second.cursor) &&
    JSON.stringify(first.events) === JSON.stringify(second.events) &&
    events(first).length > 0;
}

function boundedLifecycle(runner) {
  const runnerEvents = events(runner);
  const runningIndexes = runnerEvents.flatMap((event, index) =>
    event?.body?.kind === "lifecycle" && event.body.state === "running" ? [index] : []
  );
  const terminalIndexes = runnerEvents.flatMap((event, index) =>
    event?.body?.kind === "terminal" ? [index] : []
  );
  return runningIndexes.length === 1 && terminalIndexes.length === 1 &&
    runningIndexes[0] < terminalIndexes[0] && terminalIndexes[0] === runnerEvents.length - 1;
}

function stageIdentityMatches(runner, sessionId) {
  if (typeof sessionId !== "string") return false;
  const runnerEvents = events(runner);
  return runner?.cursor?.canonicalIdentity?.identity?.runSessionId === sessionId &&
    runnerEvents.length > 0 &&
    runnerEvents.every((event) => event?.identity?.runSessionId === sessionId);
}

function terminalOutcome(runner) {
  const runnerEvents = events(runner);
  const terminalEvents = runnerEvents.filter((event) => event?.body?.kind === "terminal");
  return terminalEvents.length === 1 && runnerEvents.at(-1) === terminalEvents[0]
    ? terminalEvents[0].body.outcome
    : null;
}

const profile = option("--profile");
const evidencePath = option("--evidence");
const cancellationTimeout = option("--cancellation-timeout") ?? "3000";
if (
  !profile || !(profile in profiles) || !evidencePath ||
  !/^\d+$/.test(cancellationTimeout) || Number(cancellationTimeout) < 1
) {
  console.error(
    "Usage: node scripts/acp-live-smoke.mjs --profile <explicit-*-acp-name> " +
    "--evidence <path> [--cancellation-timeout <positive-ms>]"
  );
  process.exit(2);
}

const startedAt = new Date().toISOString();
const planweave = process.env.PLANWEAVE_BIN ?? "planweave";
const definition = profiles[profile];
const planweaveVersion = run(planweave, ["--version"]);
const trust = run(planweave, ["trust", "executor", profile, "--json"]);
const preflight = run(planweave, ["executors", "test", profile, "--json"]);
const agentVersion = definition.versionCommand
  ? run(definition.versionCommand.command, definition.versionCommand.args)
  : versionFromPreflight(profile, preflight);

const successfulExecution = run(planweave, [
  "run", "--once", "--executor", profile, "--timeout", "120000", "--json"
]);
const successfulValue = json(successfulExecution.stdout);
const successfulSessionId = sessionId(successfulValue);
const successfulSession = readSession(planweave, successfulSessionId);
const successfulRunner = runnerFrom(successfulSession);
const successfulEvents = events(successfulRunner);
const successfulTerminal = terminalOutcome(successfulRunner);

const cancelledExecution = run(planweave, [
  "run", "--once", "--executor", profile, "--timeout", cancellationTimeout, "--json"
]);
const cancelledValue = json(cancelledExecution.stdout);
const cancelledSessionId = sessionId(cancelledValue);
const cancelledSession = readSession(planweave, cancelledSessionId);
const cancelledReplay = readSession(planweave, cancelledSessionId);
const cancelledRunner = runnerFrom(cancelledSession);
const replayedCancelledRunner = runnerFrom(cancelledReplay);
const cancelledEvents = events(cancelledRunner);
const cancellationTerminal = terminalOutcome(cancelledRunner);
const cancelledRunTerminal =
  cancelledValue?.ok === false &&
  ["blocked", "cancelled"].includes(cancelledValue?.terminalReason);
const hasAgentVersion = agentVersion.ok && agentVersion.stdout.length > 0;
const hasPlanweaveVersion = planweaveVersion.ok && planweaveVersion.stdout.length > 0;

const checks = {
  trusted: trust.ok,
  preflight: preflight.ok && json(preflight.stdout)?.ok === true,
  session:
    successfulExecution.ok && successfulSession.ok && cancelledSession.ok &&
    typeof successfulSessionId === "string" && typeof cancelledSessionId === "string" &&
    successfulSessionId !== cancelledSessionId &&
    stageIdentityMatches(successfulRunner, successfulSessionId) &&
    stageIdentityMatches(cancelledRunner, cancelledSessionId),
  streaming: successfulEvents.some((event) =>
    event?.body?.kind === "message" || event?.body?.kind === "tool_call"
  ),
  cancellation:
    !cancelledExecution.ok && cancelledRunTerminal && boundedLifecycle(cancelledRunner) &&
    ["timed_out", "cancelled"].includes(cancellationTerminal?.reason),
  artifact:
    successfulValue?.steps?.some((step) => step?.kind === "submitted") === true &&
    successfulEvents.some((event) => event?.body?.kind === "artifact") &&
    successfulTerminal?.state === "succeeded" &&
    successfulTerminal?.reason === "completed" &&
    successfulTerminal?.cleanup?.status === "succeeded",
  cleanup:
    successfulRunner?.terminal === true && cancelledRunner?.terminal === true &&
    successfulTerminal?.cleanup?.status === "succeeded" &&
    cancellationTerminal?.cleanup?.status === "succeeded",
  replay: cancelledReplay.ok && stableReplay(cancelledRunner, replayedCancelledRunner)
};
const passed = hasAgentVersion && hasPlanweaveVersion && Object.values(checks).every(Boolean);
const diagnostic = [
  agentVersion,
  planweaveVersion,
  trust,
  preflight,
  successfulExecution,
  successfulSession,
  cancelledSession,
  cancelledReplay
].find((result) => !result.ok && result !== cancelledExecution)?.diagnostic ??
  (!hasAgentVersion && definition.versionCommand
    ? `${definition.versionCommand.command} version command returned no output.`
    : null) ??
  (!hasPlanweaveVersion ? "PlanWeave version command returned no output." : null) ??
  (passed ? null : "One or more required two-stage ACP-GATE checks did not pass.");
const evidence = {
  version: "planweave.acp-live-smoke/v2",
  profile,
  agentVersion: agentVersion.stdout || "unavailable",
  planweaveVersion: planweaveVersion.stdout || "unavailable",
  startedAt,
  finishedAt: new Date().toISOString(),
  stages: {
    artifact: {
      sessionId: successfulSessionId,
      reason: successfulTerminal?.reason ?? null,
      cleanupStatus: successfulTerminal?.cleanup?.status ?? null
    },
    cancellation: {
      sessionId: cancelledSessionId,
      reason: cancellationTerminal?.reason ?? null,
      cleanupStatus: cancellationTerminal?.cleanup?.status ?? null
    }
  },
  checks,
  result: passed ? "passed" : "failed",
  diagnostic
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
chmodSync(evidencePath, 0o600);
console.log(`ACP-GATE ${profile}: ${evidence.result}; evidence=${evidencePath}`);
process.exit(passed ? 0 : 1);
