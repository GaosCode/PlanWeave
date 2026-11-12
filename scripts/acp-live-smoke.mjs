import { spawnSync } from "node:child_process";
import { closeSync, fchmodSync, openSync, writeFileSync } from "node:fs";
import { redactCiText } from "./redact-ci-test-artifacts.mjs";

const maxCommandOutputBytes = 1024 * 1024;
const maxEvidenceFieldLength = 256;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const credentialAssignment =
  /((?<![\w-])(?:[A-Z0-9]+_)*(?:API_?KEY|ACCESS_KEY(?:_ID)?|TOKEN|SECRET(?:_KEY)?|PASSWORD|PASSPHRASE|PRIVATE_KEY|CREDENTIALS?)(?:\\?["'])?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|\\["'].*|(?:\\.|[^\s\\])+\\?)/gi;

const profiles = {
  "codex-acp": {
    agentId: "codex",
    versionCommand: { command: "codex-acp", args: ["--version"] }
  },
  "claude-code-acp": {
    agentId: "claude-code",
    versionCommand: { command: "claude-agent-acp", args: ["--version"] }
  },
  "opencode-acp": {
    agentId: "opencode",
    versionCommand: { command: "opencode", args: ["--version"] }
  },
  "codebuddy-acp": {
    agentId: "codebuddy",
    versionCommand: { command: "codebuddy-code", args: ["--version"] }
  },
  "pi-acp": { agentId: "pi", versionCommand: null }
};

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function run(label, command, args) {
  let result;
  try {
    result = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: maxCommandOutputBytes
    });
  } catch (error) {
    result = { error };
  }
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const status = result.error || result.signal ? null : result.status;
  let diagnostic = null;
  if (result.error) {
    diagnostic = `${label} spawn failed (${result.error.code ?? "unknown error"}).`;
  } else if (result.signal) {
    diagnostic = `${label} terminated by ${result.signal}.`;
  } else if (status !== 0) {
    diagnostic = `${label} exited ${status ?? "without status"}.`;
  } else if (!stdout) {
    diagnostic = `${label} returned no output.`;
  }
  return {
    ok: diagnostic === null,
    status,
    stdout,
    diagnostic
  };
}

function runJson(label, command, args) {
  const { stdout, ...result } = run(label, command, args);
  if (result.status === null || !stdout) return { ...result, value: null };

  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    value = null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...result, value };

  return {
    ...result,
    ok: false,
    value: null,
    diagnostic: [result.diagnostic, `${label} returned invalid JSON object output.`]
      .filter(Boolean)
      .join(" ")
  };
}

function evidenceText(text) {
  if (typeof text !== "string") return null;
  const firstLine = text.trim().split(/[\r\n]/, 1)[0];
  return firstLine
    ? redactCiText(firstLine.replace(credentialAssignment, "$1[REDACTED]")).slice(
        0,
        maxEvidenceFieldLength
      )
    : null;
}

function isAcpTrustReceipt(receipt, profile, agentId) {
  const entry = receipt?.entry;
  return (
    receipt?.executorName === profile &&
    receipt.agentId === agentId &&
    receipt.runnerKind === "acp" &&
    (receipt.ok === undefined || receipt.ok === true) &&
    typeof entry?.id === "string" &&
    fingerprintPattern.test(entry.id) &&
    typeof entry.command === "string" &&
    Boolean(entry.command.trim()) &&
    Array.isArray(entry.args) &&
    entry.args.every((arg) => typeof arg === "string") &&
    typeof entry.profileFingerprint === "string" &&
    fingerprintPattern.test(entry.profileFingerprint) &&
    typeof entry.approvedAt === "string" &&
    Boolean(entry.approvedAt.trim())
  );
}

function checkPrerequisites(planweave, profile, { agentId, versionCommand }) {
  const readiness = {
    planweaveVersion: "unavailable",
    agentVersion: "unavailable",
    trusted: false,
    preflight: false
  };
  const planweaveVersion = run("PlanWeave version command", planweave, ["--version"]);
  if (!planweaveVersion.ok) return { ...readiness, diagnostic: planweaveVersion.diagnostic };
  readiness.planweaveVersion = evidenceText(planweaveVersion.stdout);

  if (versionCommand) {
    const { command, args } = versionCommand;
    const version = run(`${command} version command`, command, args);
    if (!version.ok) return { ...readiness, diagnostic: version.diagnostic };
    readiness.agentVersion = evidenceText(version.stdout);
  }

  const trust = runJson("Trust", planweave, ["trust", "executor", profile, "--json"]);
  if (!trust.ok) return { ...readiness, diagnostic: trust.diagnostic };
  if (!isAcpTrustReceipt(trust.value, profile, agentId)) {
    return { ...readiness, diagnostic: "Trust returned an invalid ACP approval receipt." };
  }
  readiness.trusted = true;

  const preflight = runJson("Preflight", planweave, ["executors", "test", profile, "--json"]);
  if (!versionCommand && preflight.value) {
    const { name, version } = preflight.value.agentInfo ?? {};
    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof version !== "string" ||
      !version.trim()
    ) {
      const invalidAgentInfo =
        "Preflight returned invalid agentInfo. The name and version must be non-empty strings.";
      return {
        ...readiness,
        diagnostic: [preflight.diagnostic, invalidAgentInfo].filter(Boolean).join(" ")
      };
    }
    if (preflight.ok && preflight.value.ok === true) readiness.agentVersion = evidenceText(version);
  }
  if (!preflight.ok || preflight.value.ok !== true) {
    return { ...readiness, diagnostic: preflight.diagnostic ?? "Preflight reported failure." };
  }
  return { ...readiness, preflight: true, diagnostic: null };
}

function readSession(label, planweave, id) {
  return runJson(label, planweave, ["run-session", id, "--json"]);
}

function runStage(label, planweave, profile, timeout) {
  const execution = runJson(label, planweave, [
    "run",
    "--once",
    "--executor",
    profile,
    "--timeout",
    timeout,
    "--json"
  ]);
  const id = execution.value?.session?.sessionId ?? execution.value?.sessionId;
  const sessionId = typeof id === "string" && id.trim() ? id : null;
  const session = sessionId ? readSession(`${label} session`, planweave, sessionId) : null;
  const runner = session?.value?.runnerReadModel ?? null;
  return {
    execution,
    sessionId,
    session,
    runner,
    terminal: terminalOutcome(runner),
    diagnostic:
      session?.diagnostic ?? (sessionId ? null : `${label} output did not contain a session id.`)
  };
}

function events(runner) {
  return Array.isArray(runner?.events) ? runner.events : [];
}

function stableReplay(first, second) {
  if (!first?.cursor?.terminal || !second?.cursor?.terminal) return false;
  if (first.diagnostics?.length !== 0 || second.diagnostics?.length !== 0) return false;
  return (
    JSON.stringify(first.cursor) === JSON.stringify(second.cursor) &&
    JSON.stringify(first.events) === JSON.stringify(second.events) &&
    events(first).length > 0
  );
}

function boundedLifecycle(runner) {
  const runnerEvents = events(runner);
  const runningIndexes = runnerEvents.flatMap((event, index) =>
    event?.body?.kind === "lifecycle" && event.body.state === "running" ? [index] : []
  );
  const terminalIndexes = runnerEvents.flatMap((event, index) =>
    event?.body?.kind === "terminal" ? [index] : []
  );
  return (
    runningIndexes.length === 1 &&
    terminalIndexes.length === 1 &&
    runningIndexes[0] < terminalIndexes[0] &&
    terminalIndexes[0] === runnerEvents.length - 1
  );
}

function stageIdentityMatches(runner, sessionId) {
  if (typeof sessionId !== "string") return false;
  const runnerEvents = events(runner);
  return (
    runner?.cursor?.canonicalIdentity?.identity?.runSessionId === sessionId &&
    runnerEvents.length > 0 &&
    runnerEvents.every((event) => event?.identity?.runSessionId === sessionId)
  );
}

function terminalOutcome(runner) {
  const runnerEvents = events(runner);
  const terminalEvents = runnerEvents.filter((event) => event?.body?.kind === "terminal");
  return terminalEvents.length === 1 && runnerEvents.at(-1) === terminalEvents[0]
    ? terminalEvents[0].body.outcome
    : null;
}

function stageEvidence(stage) {
  return {
    sessionId: evidenceText(stage?.sessionId),
    reason: evidenceText(stage?.terminal?.reason),
    cleanupStatus: evidenceText(stage?.terminal?.cleanup?.status)
  };
}

function writeEvidence(path, evidence) {
  const fd = openSync(path, "w", 0o600);
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

const profile = option("--profile");
const evidencePath = option("--evidence");
const cancellationTimeout = option("--cancellation-timeout") ?? "3000";
if (
  !profile ||
  !Object.hasOwn(profiles, profile) ||
  !evidencePath ||
  !/^\d+$/.test(cancellationTimeout) ||
  Number(cancellationTimeout) < 1
) {
  console.error(
    "Usage: node scripts/acp-live-smoke.mjs --profile <explicit-*-acp-name> " +
      "--evidence <path> [--cancellation-timeout <positive-ms>]"
  );
  process.exit(2);
}

const startedAt = new Date().toISOString();
const planweave = process.env.PLANWEAVE_BIN ?? "planweave";
const readiness = checkPrerequisites(planweave, profile, profiles[profile]);
const artifact = readiness.preflight
  ? runStage("Artifact run", planweave, profile, "120000")
  : null;
const cancellation = readiness.preflight
  ? runStage("Cancellation run", planweave, profile, cancellationTimeout)
  : null;
const replay = cancellation?.sessionId
  ? readSession("Cancellation replay", planweave, cancellation.sessionId)
  : null;
const artifactEvents = events(artifact?.runner);
const artifactSteps = artifact?.execution.value?.steps;
const cancelledValue = cancellation?.execution.value;
const expectedCancellationExit =
  cancellation?.execution.status > 0 &&
  cancelledValue?.ok === false &&
  ["blocked", "cancelled"].includes(cancelledValue.terminalReason);

const checks = {
  trusted: readiness.trusted,
  preflight: readiness.preflight,
  session:
    artifact?.execution.ok === true &&
    artifact.session?.ok === true &&
    cancellation?.session?.ok === true &&
    artifact.sessionId !== cancellation.sessionId &&
    stageIdentityMatches(artifact.runner, artifact.sessionId) &&
    stageIdentityMatches(cancellation.runner, cancellation.sessionId),
  streaming: artifactEvents.some(
    (event) => event?.body?.kind === "message" || event?.body?.kind === "tool_call"
  ),
  cancellation:
    expectedCancellationExit &&
    boundedLifecycle(cancellation.runner) &&
    ["timed_out", "cancelled"].includes(cancellation.terminal?.reason),
  artifact:
    Array.isArray(artifactSteps) &&
    artifactSteps.some((step) => step?.kind === "submitted") &&
    artifactEvents.some((event) => event?.body?.kind === "artifact") &&
    artifact.terminal?.state === "succeeded" &&
    artifact.terminal.reason === "completed" &&
    artifact.terminal.cleanup?.status === "succeeded",
  cleanup:
    artifact?.runner?.terminal === true &&
    cancellation?.runner?.terminal === true &&
    artifact.terminal?.cleanup?.status === "succeeded" &&
    cancellation.terminal?.cleanup?.status === "succeeded",
  replay: replay?.ok === true && stableReplay(cancellation.runner, replay.value?.runnerReadModel)
};
const passed = Object.values(checks).every(Boolean);
const diagnostic =
  readiness.diagnostic ??
  artifact?.execution.diagnostic ??
  artifact?.diagnostic ??
  (expectedCancellationExit ? null : cancellation?.execution.diagnostic) ??
  cancellation?.diagnostic ??
  replay?.diagnostic ??
  (passed ? null : "One or more required two-stage ACP-GATE checks did not pass.");
const evidence = {
  version: "planweave.acp-live-smoke/v2",
  profile,
  agentVersion: readiness.agentVersion,
  planweaveVersion: readiness.planweaveVersion,
  startedAt,
  finishedAt: new Date().toISOString(),
  stages: {
    artifact: stageEvidence(artifact),
    cancellation: stageEvidence(cancellation)
  },
  checks,
  result: passed ? "passed" : "failed",
  diagnostic
};
try {
  writeEvidence(evidencePath, evidence);
} catch (error) {
  if (diagnostic) console.error(`ACP-GATE ${profile}: ${diagnostic}`);
  console.error(
    `ACP-GATE ${profile}: could not write evidence (${error.code ?? "unknown error"}).`
  );
  process.exit(1);
}
console.log(`ACP-GATE ${profile}: ${evidence.result}; evidence=${evidencePath}`);
process.exit(passed ? 0 : 1);
