import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const smokeScript = join(process.cwd(), "scripts/acp-live-smoke.mjs");
const windows = process.platform === "win32";
const fixtureRoots: string[] = [];
const sensitiveMarker = "smoke-fixture-secret-489";

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "planweave-acp-live-smoke-"));
  fixtureRoots.push(root);
  return root;
}

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(path, 0o755);
}

async function fixture(failure?: string) {
  const root = await fixtureRoot();
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  const agent = join(root, "codex-acp");
  const piAgent = join(root, "pi-acp");
  const planweave = join(root, "planweave-test");
  if (failure !== "missing-agent") {
    await executable(
      agent,
      `require("node:fs").appendFileSync("calls.log", "agent version\\n");
if (process.env.SMOKE_FAILURE === "trust-exit") {
  console.log("codex-acp test-version ANTHROPIC_AUTH_TOKEN = '${sensitiveMarker} trailing-secret' ready");
} else if (process.env.SMOKE_FAILURE !== "silent-agent-version") {
  console.log("codex-acp test-version");
}\n`
    );
  }
  await executable(piAgent, "process.exit(93);\n");
  await executable(
    planweave,
    `
const { createHash } = require("node:crypto");
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const timeout = args[args.indexOf("--timeout") + 1];
const cancellation = timeout !== "120000";
const failedScenario = process.env.SMOKE_FAILURE;
const logEntry = args[0] === "run" ? (cancellation ? "cancel run" : "artifact run") : args[0];
appendFileSync("calls.log", logEntry + "\\n");
if (args[0] === "--version") {
  if (failedScenario === "signal") process.kill(process.pid, "SIGTERM");
  if (failedScenario === "output-budget") {
    writeFileSync(2, "TOKEN=${sensitiveMarker} " + "x".repeat(4 * 1024 * 1024));
  }
  if (failedScenario === "trust-exit") {
    console.log('planweave test-version OPENAI_API_KEY=${sensitiveMarker} "AWS_SECRET_ACCESS_KEY": "${sensitiveMarker} trailing-secret"\\n${sensitiveMarker}');
  } else if (failedScenario !== "silent-planweave-version") {
    console.log("planweave test-version");
  }
}
else if (args[0] === "trust") {
  if (failedScenario === "trust-exit") {
    console.error("TOKEN=${sensitiveMarker}");
    process.exit(7);
  }
  const executorName = args[2];
  const agentId = executorName === "pi-acp" ? "pi" : "codex";
  const command = join(process.cwd(), executorName);
  const profileFingerprint = "a".repeat(64);
  const receipt = {
    executorName,
    agentId,
    runnerKind: "acp",
    entry: {
      id: createHash("sha256").update(JSON.stringify([command, profileFingerprint])).digest("hex"),
      command,
      args: [],
      profileFingerprint,
      approvedAt: new Date().toISOString()
    }
  };
  const invalidReceipts = {
    "trust-rejected": { ...receipt, ok: false, message: "${sensitiveMarker}" },
    "trust-missing-entry": { executorName, agentId, runnerKind: "acp" },
    "trust-wrong-profile": { ...receipt, executorName: "opencode-acp" },
    "trust-wrong-agent": { ...receipt, agentId: "opencode" },
    "trust-wrong-runner": { ...receipt, runnerKind: "cli" },
    "trust-invalid-entry": { ...receipt, entry: { ...receipt.entry, args: [42] } },
    "trust-missing-fingerprint": { ...receipt, entry: { ...receipt.entry, profileFingerprint: undefined } }
  };
  console.log(JSON.stringify(invalidReceipts[failedScenario] ?? receipt));
}
else if (args[0] === "executors" && args[1] === "test") {
  if (failedScenario === "bad-preflight-json") {
    console.error("TOKEN=${sensitiveMarker}");
    console.log("invalid JSON TOKEN=${sensitiveMarker}");
    process.exit(0);
  }
  if (failedScenario === "preflight-rejected") {
    console.log(JSON.stringify({ ok: false, message: "TOKEN=${sensitiveMarker}" }));
    process.exit(0);
  }
  const invalidAgentInfo = failedScenario === "missing-preflight-agent-info" ||
    failedScenario === "empty-preflight-agent-version";
  console.log(JSON.stringify({
  ok: !invalidAgentInfo || failedScenario === "missing-preflight-agent-info",
  message: invalidAgentInfo
    ? "ACP initialize returned invalid agentInfo; name and version must be non-empty strings."
    : "ACP runner preflight passed.",
  ...(failedScenario === "missing-preflight-agent-info" ? { agentInfo: null } : {
    agentInfo: {
      name: "fixture-acp-agent",
      version: failedScenario === "empty-preflight-agent-version" ? "" : "0.0.31"
    }
  })
  }));
  if (failedScenario === "empty-preflight-agent-version") process.exit(1);
}
else if (args[0] === "run" && cancellation && failedScenario === "bad-cancellation-json") {
  console.log("invalid JSON TOKEN=${sensitiveMarker}");
  process.exit(1);
}
else if (args[0] === "run" && !cancellation) console.log(JSON.stringify({
  session: { sessionId: "SESSION-SUCCESS" }, steps: [{ kind: "submitted" }]
}));
else if (args[0] === "run") {
  const result = JSON.stringify({
    ok: false,
    terminalReason: failedScenario === "not-cancelled" ? "completed" : "blocked",
    session: { sessionId: failedScenario === "same-session" ? "SESSION-SUCCESS" : "SESSION-CANCEL" }
  });
  writeFileSync(1, result + "\\n");
  if (failedScenario === "cancellation-signal") process.kill(process.pid, "SIGTERM");
  process.exit(failedScenario === "not-cancelled" ? 0 : 1);
}
else if (args[0] === "run-session") {
  const cancellationSession = args[1] === "SESSION-CANCEL";
  const expectedSessionId = cancellationSession ? "SESSION-CANCEL" : "SESSION-SUCCESS";
  const identitySessionId = failedScenario === "stale-identity" && cancellationSession
    ? "SESSION-STALE"
    : expectedSessionId;
  const identity = { runSessionId: identitySessionId };
  const lifecycle = failedScenario === "preflight-only" ? "initializing" : "running";
  const terminal = true;
  const replayMarker = join(process.cwd(), ".replay-read");
  const replaySequence = failedScenario === "replay" && cancellationSession && existsSync(replayMarker)
    ? 99
    : 3;
  if (failedScenario === "replay" && cancellationSession) writeFileSync(replayMarker, "read");
  console.log(JSON.stringify({ runnerReadModel: {
    events: cancellationSession ? [
      { sequence: 1, identity, body: { kind: "lifecycle", state: lifecycle } },
      ...(failedScenario === "duplicate-running"
        ? [{ sequence: 2, identity, body: { kind: "lifecycle", state: "running" } }]
        : []),
      { sequence: replaySequence, identity, body: { kind: "terminal", outcome: {
        state: "failed",
        reason: failedScenario === "not-cancelled" ? "failed" : "timed_out",
        cleanup: { status: failedScenario === "cleanup" ? "failed" : "succeeded" }
      } } },
      ...(failedScenario === "trailing-event"
        ? [{ sequence: 4, identity, body: { kind: "message" } }]
        : [])
    ] : [
      { sequence: 1, identity, body: { kind: "message" } },
      { sequence: 2, identity, body: { kind: "artifact" } },
      { sequence: 3, identity, body: { kind: "terminal", outcome: {
        state: "succeeded",
        reason: "completed",
        ...(failedScenario === "success-cleanup-missing" ? {} : { cleanup: { status: "succeeded" } })
      } } }
    ],
    diagnostics: failedScenario === "diagnostics" ? [{ code: "sequence_gap" }] : [],
    terminal,
    cursor: {
      runId: args[1],
      afterSequence: replaySequence,
      terminal,
      canonicalIdentity: { identity }
    }
  } }));
}
else process.exit(2);
`
  );
  if (failure === "non-executable-planweave") await chmod(planweave, 0o644);
  return { root, planweave };
}

async function invoke(
  root: string,
  planweave: string,
  evidencePath: string,
  failure?: string,
  profile = "codex-acp"
) {
  return execFileAsync(
    process.execPath,
    [smokeScript, "--profile", profile, "--evidence", evidencePath, "--cancellation-timeout", "25"],
    {
      cwd: root,
      env: {
        ...(windows ? { SystemRoot: process.env.SystemRoot } : {}),
        PATH: [root, join(root, "bin")].join(delimiter),
        PLANWEAVE_HOME: join(root, "planweave-home"),
        PLANWEAVE_BIN: planweave,
        ...(failure ? { SMOKE_FAILURE: failure } : {})
      }
    }
  );
}

async function assertFailedEvidence(
  invocation: ReturnType<typeof invoke>,
  evidencePath: string,
  diagnostic: RegExp,
  checks: Record<string, boolean>
) {
  const result = await invocation.catch((error: unknown) => error);
  expect(result).toMatchObject({
    code: 1,
    stdout: expect.stringContaining("failed"),
    stderr: ""
  });
  expect(result).toHaveProperty("stdout", expect.not.stringContaining(sensitiveMarker));
  const content = await readFile(evidencePath, "utf8");
  expect(content).not.toContain(sensitiveMarker);
  expect(content).not.toContain("trailing-secret");
  const evidence: unknown = JSON.parse(content);
  expect(evidence).toMatchObject({
    version: "planweave.acp-live-smoke/v2",
    result: "failed",
    diagnostic: expect.stringMatching(diagnostic),
    checks
  });
  return evidence;
}

const skippedRunChecks = {
  session: false,
  streaming: false,
  cancellation: false,
  artifact: false,
  cleanup: false,
  replay: false
};

async function calls(root: string) {
  return (await readFile(join(root, "calls.log"), "utf8")).trim().split("\n");
}

describe("ACP live smoke evidence program", () => {
  it("records a failed gate when the PlanWeave executable is missing", async () => {
    const root = await fixtureRoot();
    const evidencePath = join(root, "evidence.json");

    const evidence = await assertFailedEvidence(
      invoke(root, join(root, "missing-planweave"), evidencePath),
      evidencePath,
      /PlanWeave version command.*ENOENT/,
      { trusted: false, preflight: false, ...skippedRunChecks }
    );
    expect(evidence).toMatchObject({
      planweaveVersion: "unavailable",
      agentVersion: "unavailable",
      stages: {
        artifact: { sessionId: null, reason: null, cleanupStatus: null },
        cancellation: { sessionId: null, reason: null, cleanupStatus: null }
      }
    });
  });

  it("reports the original failure and evidence write failure for a directory target", async () => {
    const root = await fixtureRoot();
    const evidencePath = join(root, "evidence.json");
    await mkdir(evidencePath);

    await expect(invoke(root, join(root, "missing-planweave"), evidencePath)).rejects.toMatchObject(
      {
        code: 1,
        stdout: "",
        stderr: expect.stringMatching(
          /PlanWeave version command.*ENOENT[\s\S]*could not write evidence.*(EISDIR|EPERM|EACCES)/
        )
      }
    );
    expect((await stat(evidencePath)).isDirectory()).toBe(true);
  });
});

describe.skipIf(windows)("ACP live smoke with POSIX executable fixtures", () => {
  it("proves a strict artifact and an independent runner-level cancellation with replay", async () => {
    const { root, planweave } = await fixture();
    const evidencePath = join(root, "evidence.json");
    await writeFile(evidencePath, "stale\n", { encoding: "utf8", mode: 0o644 });

    const result = await invoke(root, planweave, evidencePath);

    expect(result.stdout).toContain("ACP-GATE codex-acp: passed");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      result: string;
      diagnostic: string | null;
      checks: Record<string, boolean>;
    };
    expect(evidence).toMatchObject({
      result: "passed",
      diagnostic: null,
      planweaveVersion: "planweave test-version",
      agentVersion: "codex-acp test-version",
      stages: {
        artifact: {
          sessionId: "SESSION-SUCCESS",
          reason: "completed",
          cleanupStatus: "succeeded"
        },
        cancellation: {
          sessionId: "SESSION-CANCEL",
          reason: "timed_out",
          cleanupStatus: "succeeded"
        }
      }
    });
    expect(Object.values(evidence.checks).every(Boolean)).toBe(true);
    expect((await stat(evidencePath)).mode & 0o777).toBe(0o600);
    expect(await calls(root)).toEqual([
      "--version",
      "agent version",
      "trust",
      "executors",
      "artifact run",
      "run-session",
      "cancel run",
      "run-session",
      "run-session"
    ]);

    expect(evidence).toMatchObject({ version: "planweave.acp-live-smoke/v2" });
  });

  it("records the Pi ACP version reported by authoritative preflight agentInfo", async () => {
    const { root, planweave } = await fixture();
    const evidencePath = join(root, "pi-evidence.json");

    const result = await invoke(root, planweave, evidencePath, undefined, "pi-acp");

    expect(result.stdout).toContain("ACP-GATE pi-acp: passed");
    expect(JSON.parse(await readFile(evidencePath, "utf8"))).toMatchObject({
      profile: "pi-acp",
      agentVersion: "0.0.31",
      result: "passed"
    });
    expect(await calls(root)).toEqual([
      "--version",
      "trust",
      "executors",
      "artifact run",
      "run-session",
      "cancel run",
      "run-session",
      "run-session"
    ]);
  });

  it.each([
    "missing-preflight-agent-info",
    "empty-preflight-agent-version"
  ])("fails closed when Pi preflight returns %s", async (failure) => {
    const { root, planweave } = await fixture();
    const evidencePath = join(root, `${failure}.json`);

    const evidence = await assertFailedEvidence(
      invoke(root, planweave, evidencePath, failure, "pi-acp"),
      evidencePath,
      /[Pp]reflight.*invalid agentInfo/,
      { trusted: true, preflight: false, ...skippedRunChecks }
    );
    expect(evidence).toMatchObject({
      profile: "pi-acp",
      agentVersion: "unavailable"
    });
    expect(await calls(root)).toEqual(["--version", "trust", "executors"]);
  });

  it.each([
    "trust-rejected",
    "trust-missing-entry",
    "trust-wrong-profile",
    "trust-wrong-agent",
    "trust-wrong-runner",
    "trust-invalid-entry",
    "trust-missing-fingerprint"
  ])("stops before preflight or run when trust exits zero with %s", async (failure) => {
    const { root, planweave } = await fixture();
    const evidencePath = join(root, "evidence.json");

    await assertFailedEvidence(
      invoke(root, planweave, evidencePath, failure),
      evidencePath,
      /^Trust returned an invalid ACP approval receipt\.$/,
      { trusted: false, preflight: false, ...skippedRunChecks }
    );
    expect(await calls(root)).toEqual(["--version", "agent version", "trust"]);
  });

  it.each([
    {
      failure: "missing-agent",
      diagnostic: /codex-acp.*version command.*ENOENT/,
      called: ["--version"]
    },
    {
      failure: "non-executable-planweave",
      diagnostic: /PlanWeave version command.*EACCES/,
      called: []
    },
    { failure: "signal", diagnostic: /PlanWeave version command.*SIGTERM/, called: ["--version"] },
    {
      failure: "output-budget",
      diagnostic: /PlanWeave version command.*ENOBUFS/,
      called: ["--version"]
    },
    {
      failure: "silent-planweave-version",
      diagnostic: /PlanWeave version command returned no output/,
      called: ["--version"]
    },
    {
      failure: "silent-agent-version",
      diagnostic: /codex-acp.*version command returned no output/,
      called: ["--version", "agent version"]
    },
    {
      failure: "trust-exit",
      diagnostic: /Trust.*exited 7/,
      called: ["--version", "agent version", "trust"]
    },
    {
      failure: "bad-preflight-json",
      diagnostic: /Preflight.*invalid JSON/,
      called: ["--version", "agent version", "trust", "executors"]
    },
    {
      failure: "preflight-rejected",
      diagnostic: /Preflight reported failure/,
      called: ["--version", "agent version", "trust", "executors"]
    }
  ])("stops at $failure and preserves a bounded diagnostic", async ({
    failure,
    diagnostic,
    called
  }) => {
    const { root, planweave } = await fixture(failure);
    const evidencePath = join(root, `${failure}.json`);

    const evidence = await assertFailedEvidence(
      invoke(root, planweave, evidencePath, failure),
      evidencePath,
      diagnostic,
      {
        trusted: called.includes("executors"),
        preflight: false,
        ...skippedRunChecks
      }
    );
    if (failure.startsWith("silent-")) {
      const key = failure === "silent-agent-version" ? "agentVersion" : "planweaveVersion";
      expect(evidence).toMatchObject({ [key]: "unavailable" });
    }
    if (failure === "trust-exit") {
      expect(evidence).toMatchObject({
        planweaveVersion:
          'planweave test-version OPENAI_API_KEY=[REDACTED] "AWS_SECRET_ACCESS_KEY": [REDACTED]',
        agentVersion: "codex-acp test-version ANTHROPIC_AUTH_TOKEN = [REDACTED] ready"
      });
    }
    if (called.length > 0) {
      expect(await calls(root)).toEqual(called);
    } else {
      await expect(calls(root)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect((await stat(evidencePath)).size).toBeLessThan(4096);
  });

  it.each([
    ["bad-cancellation-json", /Cancellation run.*invalid JSON/],
    ["cancellation-signal", /Cancellation run.*SIGTERM/]
  ])("distinguishes %s from an expected cancellation exit", async (failure, diagnostic) => {
    const { root, planweave } = await fixture();
    const evidencePath = join(root, "evidence.json");

    await assertFailedEvidence(
      invoke(root, planweave, evidencePath, failure),
      evidencePath,
      diagnostic,
      { trusted: true, preflight: true, artifact: true, cancellation: false, replay: false }
    );
    expect((await calls(root)).slice(-3)).toEqual(["artifact run", "run-session", "cancel run"]);
  });

  it.each([
    ["not-cancelled", "cancellation"],
    ["preflight-only", "cancellation"],
    ["cleanup", "cleanup"],
    ["replay", "replay"],
    ["diagnostics", "replay"],
    ["duplicate-running", "cancellation"],
    ["trailing-event", "cancellation"],
    ["stale-identity", "session"],
    ["same-session", "session"],
    ["success-cleanup-missing", "cleanup"]
  ])("rejects %s evidence", async (failure, failedCheck) => {
    const { root, planweave } = await fixture();
    const evidencePath = join(root, `${failure}.json`);

    await expect(invoke(root, planweave, evidencePath, failure)).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse(await readFile(evidencePath, "utf8"))).toMatchObject({
      result: "failed",
      checks: { [failedCheck]: false }
    });
  });
});
