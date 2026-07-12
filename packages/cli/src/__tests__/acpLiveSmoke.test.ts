import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const smokeScript = join(process.cwd(), "scripts/acp-live-smoke.mjs");

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(path, 0o755);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planweave-acp-live-smoke-"));
  const agent = join(root, "codex-acp");
  const piAgent = join(root, "pi-acp");
  const planweave = join(root, "planweave-test");
  await executable(
    agent,
    'if (process.env.SMOKE_FAILURE !== "silent-agent-version") console.log("codex-acp test-version");\n'
  );
  await executable(piAgent, 'process.exit(93);\n');
  await executable(planweave, `
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const timeout = args[args.indexOf("--timeout") + 1];
const cancellation = timeout !== "120000";
const failedScenario = process.env.SMOKE_FAILURE;
if (args[0] === "--version") {
  if (failedScenario !== "silent-planweave-version") console.log("planweave test-version");
}
else if (args[0] === "trust") console.log(JSON.stringify({ ok: true }));
else if (args[0] === "executors" && args[1] === "test") {
  const invalidAgentInfo = failedScenario === "missing-preflight-agent-info" ||
    failedScenario === "empty-preflight-agent-version";
  console.log(JSON.stringify({
  ok: !invalidAgentInfo,
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
  if (invalidAgentInfo) process.exit(1);
}
else if (args[0] === "run" && !cancellation) console.log(JSON.stringify({
  session: { sessionId: "SESSION-SUCCESS" }, steps: [{ kind: "submitted" }]
}));
else if (args[0] === "run") {
  console.log(JSON.stringify({
    ok: false,
    terminalReason: failedScenario === "not-cancelled" ? "completed" : "blocked",
    session: { sessionId: failedScenario === "same-session" ? "SESSION-SUCCESS" : "SESSION-CANCEL" }
  }));
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
`);
  return { root, planweave };
}

async function invoke(
  root: string,
  planweave: string,
  evidencePath: string,
  failure?: string,
  profile = "codex-acp"
) {
  return execFileAsync(process.execPath, [
    smokeScript,
    "--profile", profile,
    "--evidence", evidencePath,
    "--cancellation-timeout", "25"
  ], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ""}`,
      PLANWEAVE_BIN: planweave,
      ...(failure ? { SMOKE_FAILURE: failure } : {})
    }
  });
}

describe("ACP live smoke evidence program", () => {
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
  });

  it.each(["missing-preflight-agent-info", "empty-preflight-agent-version"])(
    "fails closed when Pi preflight returns %s",
    async (failure) => {
      const { root, planweave } = await fixture();
      const evidencePath = join(root, `${failure}.json`);

      await expect(invoke(root, planweave, evidencePath, failure, "pi-acp")).rejects.toMatchObject({
        code: 1
      });
      expect(JSON.parse(await readFile(evidencePath, "utf8"))).toMatchObject({
        profile: "pi-acp",
        agentVersion: "unavailable",
        result: "failed",
        diagnostic:
          "ACP initialize returned invalid agentInfo; name and version must be non-empty strings."
      });
    }
  );

  it("fails closed when an agent version command exits successfully without output", async () => {
    const { root, planweave } = await fixture();
    const evidencePath = join(root, "silent-agent-version.json");

    await expect(invoke(root, planweave, evidencePath, "silent-agent-version")).rejects.toMatchObject({
      code: 1
    });
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      checks: Record<string, boolean>;
    };
    expect(evidence).toMatchObject({
      agentVersion: "unavailable",
      result: "failed",
      diagnostic: "codex-acp version command returned no output."
    });
    expect(Object.values(evidence.checks).every(Boolean)).toBe(true);
  });

  it("fails closed when the PlanWeave version command exits successfully without output", async () => {
    const { root, planweave } = await fixture();
    const evidencePath = join(root, "silent-planweave-version.json");

    await expect(
      invoke(root, planweave, evidencePath, "silent-planweave-version")
    ).rejects.toMatchObject({ code: 1 });
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      checks: Record<string, boolean>;
    };
    expect(evidence).toMatchObject({
      planweaveVersion: "unavailable",
      result: "failed",
      diagnostic: "PlanWeave version command returned no output."
    });
    expect(Object.values(evidence.checks).every(Boolean)).toBe(true);
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
