import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AcpOperationTimeoutError,
  createAcpConnection,
  type AcpConnection
} from "../autoRun/acpConnection.js";
import { AcpEventReadModelRegistry } from "../autoRun/acpEventReadModel.js";
import { AcpEventStore, AcpEventStoreLimitError } from "../autoRun/acpEventStore.js";
import { createDefaultAcpEventRetentionPolicy } from "../autoRun/acpEventRetentionPolicy.js";
import { RUNNER_EVENT_MAX_ENCODED_BYTES } from "../autoRun/normalizedEventContract.js";
import { AcpSessionController, type AcpSessionRun } from "../autoRun/acpSessionController.js";
import { ActiveAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const retentionEvidenceBucketCount = 3;
const retentionReserveBytes = RUNNER_EVENT_MAX_ENCODED_BYTES * retentionEvidenceBucketCount;

function run(root: string, scenario: string): AcpSessionRun {
  return {
    kind: "implementation",
    identity: { scope: root, executorRunId: "RUN-001", claimRef: "T-001#B-001" },
    runDir: root,
    metadataPath: join(root, "metadata.json"),
    prompt: scenario,
    cwd: root,
    launch: { command: process.execPath, args: [fixture, scenario] },
    executorName: "mock-acp",
    agentId: "codex",
    taskId: "T-001",
    metadataIdentity: { blockId: "B-001" },
    projectId: "project-1",
    canvasId: "default"
  };
}

function connectWithCleanupFailure(
  options: Parameters<typeof createAcpConnection>[0],
  failureMessage = "cleanup failed after artifact verification",
  afterDispose: () => void = () => undefined
): AcpConnection {
  const connection = createAcpConnection(options);
  return new Proxy(connection, {
    get(target, property) {
      if (property === "dispose") {
        return async () => {
          await target.dispose();
          afterDispose();
          throw new Error(failureMessage);
        };
      }
      const value = Reflect.get(target, property);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    }
  });
}

function nestedErrorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(nestedErrorMessages);
  }
  return [error instanceof Error ? error.message : String(error)];
}

function retentionPolicyForArtifactLog(calibrationLines: string[]) {
  const calibrationEvents = calibrationLines.map(
    (line) => JSON.parse(line) as { sequence: number; body: { kind: string } }
  );
  const artifactIndex = calibrationEvents.findIndex((event) => event.body.kind === "artifact");
  const calibrationArtifact = calibrationEvents[artifactIndex];
  if (!calibrationArtifact) {
    throw new Error("Calibration run did not persist an artifact event.");
  }
  const bytesBeforeArtifact = Buffer.byteLength(
    `${calibrationLines.slice(0, artifactIndex).join("\n")}\n`
  );
  const bytesThroughArtifact = Buffer.byteLength(
    `${calibrationLines.slice(0, artifactIndex + 1).join("\n")}\n`
  );
  const evidenceBytes = retentionReserveBytes / retentionEvidenceBucketCount;
  return createDefaultAcpEventRetentionPolicy({
    maxEvents: calibrationArtifact.sequence + retentionEvidenceBucketCount - 1,
    reserveEvents: retentionEvidenceBucketCount,
    maxBytes: Math.max(
      bytesBeforeArtifact + retentionReserveBytes,
      bytesThroughArtifact + evidenceBytes * (retentionEvidenceBucketCount - 1)
    ),
    reserveBytes: retentionReserveBytes
  });
}

describe("ACP event controller durability and producers", () => {
  it("records only the selected authentication method without spawn secrets or protocol metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-auth-events-"));
    const variable = "PLANWEAVE_T002_TEST_API_KEY";
    const secret = "must-not-appear-in-run-records";
    const previous = process.env[variable];
    process.env[variable] = secret;
    try {
      const controller = new AcpSessionController(
        new ActiveAgentRunRegistry(),
        createAcpConnection,
        new AcpEventReadModelRegistry()
      );

      await expect(
        controller.execute(run(root, "env-auth"), { timeoutMs: 1_000 })
      ).resolves.toMatchObject({
        kind: "block",
        exitCode: 0
      });
      const persisted = await Promise.all(
        ["events.ndjson", "protocol.ndjson", "metadata.json", "heartbeat.json"].map((name) =>
          readFile(join(root, name), "utf8")
        )
      );
      const combined = persisted.join("\n");
      expect(combined).toContain("ACP authentication method selected: env-login");
      expect(combined).toContain("ACP authentication completed.");
      expect(combined).not.toContain(secret);
      expect(combined).not.toContain("mock-auth-meta-secret");
      expect(combined).not.toContain("opaque-terminal-auth-material");
      expect(combined).not.toContain("opaque-private-auth-metadata");
      expect(combined).not.toContain("CUSTOM_AUTH_MATERIAL");
      expect(combined).not.toContain('"_meta"');
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  it("applies explicitly supplied Desktop ACP defaults before the first prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-session-config-"));
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      new AcpEventReadModelRegistry()
    );

    await expect(
      controller.execute(run(root, "artifact-session-config"), {
        timeoutMs: 1_000,
        sessionDefaults: {
          modeId: "agent-full-access",
          configOptions: { model: "gpt-5.2-codex", "fast-mode": true }
        }
      })
    ).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    const events = (await readFile(join(root, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { body: Record<string, unknown> });
    const snapshots = events
      .map((event) => event.body)
      .filter((body) => body.kind === "session_configuration_snapshot");
    expect(snapshots.map((body) => body.phase)).toEqual(["initial", "defaults_applied"]);
    expect(snapshots[1]).toMatchObject({
      configuration: {
        modes: { currentModeId: "agent-full-access" },
        configOptions: [
          { id: "model", currentValue: "gpt-5.2-codex" },
          { id: "fast-mode", currentValue: true }
        ]
      }
    });
  });

  it("records only the initial snapshot when Desktop defaults are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-session-initial-"));
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      new AcpEventReadModelRegistry()
    );

    await expect(
      controller.execute(run(root, "artifact-session-config-live"), { timeoutMs: 1_000 })
    ).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).toContain('"kind":"session_configuration_snapshot","phase":"initial"');
    expect(events).not.toContain('"phase":"defaults_applied"');
  });

  it("persists live mode and full configuration-option updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-session-live-config-"));
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      new AcpEventReadModelRegistry()
    );

    await expect(
      controller.execute(run(root, "artifact-session-config-live"), { timeoutMs: 1_000 })
    ).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).toContain('"kind":"session_mode_update","currentModeId":"agent-full-access"');
    expect(events).toContain('"kind":"session_config_options_update"');
    expect(events).toContain('"id":"reasoning_effort"');
  });

  it("does not write a defaults-applied snapshot when a configured setter fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-session-config-failure-"));
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      new AcpEventReadModelRegistry()
    );

    await expect(
      controller.execute(run(root, "artifact-session-config"), {
        timeoutMs: 1_000,
        sessionDefaults: { modeId: null, configOptions: { missing: "value" } }
      })
    ).rejects.toThrow("did not advertise configured option 'missing'");
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).toContain('"kind":"session_configuration_snapshot","phase":"initial"');
    expect(events).not.toContain('"phase":"defaults_applied"');
  });

  it("does not read Desktop settings for a generic controller execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-generic-settings-"));
    const settingsFile = join(root, "desktop-settings.json");
    await writeFile(settingsFile, "invalid desktop settings");
    const previous = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = settingsFile;
    try {
      const controller = new AcpSessionController(
        new ActiveAgentRunRegistry(),
        createAcpConnection,
        new AcpEventReadModelRegistry()
      );
      await expect(
        controller.execute(run(root, "artifact-implementation"), { timeoutMs: 1_000 })
      ).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    } finally {
      if (previous === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
      else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = previous;
    }
  });

  it("drains delayed raw writes and fails the run before success metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-raw-barrier-"));
    const readModels = new AcpEventReadModelRegistry(
      (options) =>
        new AcpEventStore({
          ...options,
          appendText: async (path, data, encoding) => {
            if (String(path).endsWith("protocol.ndjson")) {
              await new Promise((resolve) => setTimeout(resolve, 25));
              throw new Error("delayed raw persistence failed");
            }
            await appendFile(path, data, encoding);
          }
        })
    );
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      readModels
    );
    const promise = controller.execute(run(root, "artifact-implementation"), { timeoutMs: 500 });
    await expect(promise).rejects.toThrow("delayed raw persistence failed");
    const metadata = await readFile(join(root, "metadata.json"), "utf8");
    expect(metadata).toContain('"status": "failed"');
    expect(metadata).not.toContain('"status": "completed"');
  });

  it("persists permission and preview elicitation history as non-actionable", async () => {
    for (const scenario of ["permission", "elicitation"]) {
      const root = await mkdtemp(join(tmpdir(), `planweave-acp-${scenario}-`));
      const controller = new AcpSessionController(
        new ActiveAgentRunRegistry(),
        createAcpConnection,
        new AcpEventReadModelRegistry()
      );
      await expect(controller.execute(run(root, scenario), { timeoutMs: 500 })).rejects.toThrow(
        scenario === "permission" ? "timed out" : "Final artifact marker was not found"
      );
      const events = await readFile(join(root, "events.ndjson"), "utf8");
      expect(events).toContain('"kind":"interaction"');
      expect(events).toContain('"actionable":false');
      expect(events).toContain(
        `"kind":"${scenario === "permission" ? "permission" : "elicitation"}"`
      );
    }
  });

  it("persists output returned through the official terminalOutput client callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-terminal-output-"));
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      new AcpEventReadModelRegistry()
    );
    const input = run(root, "terminal-output");
    input.terminalOutputHandler = () => ({ output: "terminal bytes", truncated: false });
    await expect(controller.execute(input, { timeoutMs: 500 })).resolves.toMatchObject({
      kind: "block"
    });
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).toContain('"kind":"terminal_output"');
    expect(events).toContain("terminal bytes");
  });

  it("publishes the verified artifact before terminal in the real controller stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-artifact-event-"));
    const readModels = new AcpEventReadModelRegistry();
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      readModels
    );

    await expect(
      controller.execute(run(root, "artifact-implementation"), { timeoutMs: 1_000 })
    ).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    const snapshot = readModels.get(root)?.replay(0);
    const kinds = snapshot?.events.map((event) => event.body.kind) ?? [];
    expect(kinds).toContain("artifact");
    expect(kinds.indexOf("artifact")).toBeLessThan(kinds.indexOf("terminal"));
    expect(snapshot?.events.find((event) => event.body.kind === "artifact")).toMatchObject({
      body: {
        kind: "artifact",
        artifact: { kind: "implementation", relativePath: "report.md" }
      }
    });
  });

  it("keeps a verified artifact event when later cleanup fails and marks partial success", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-artifact-cleanup-"));
    const readModels = new AcpEventReadModelRegistry();
    const registry = new ActiveAgentRunRegistry();
    const controller = new AcpSessionController(registry, connectWithCleanupFailure, readModels);

    await expect(
      controller.execute(run(root, "artifact-implementation"), { timeoutMs: 1_000 })
    ).rejects.toThrow("Runner terminal cleanup did not complete cleanly");
    const events = readModels.get(root)?.replay(0).events ?? [];
    expect(events.map((event) => event.body.kind)).toEqual(
      expect.arrayContaining(["artifact", "diagnostic", "terminal"])
    );
    const artifactIndex = events.findIndex((event) => event.body.kind === "artifact");
    const terminalIndex = events.findIndex((event) => event.body.kind === "terminal");
    expect(artifactIndex).toBeGreaterThanOrEqual(0);
    expect(artifactIndex).toBeLessThan(terminalIndex);
    expect(events[terminalIndex]).toMatchObject({
      body: {
        kind: "terminal",
        outcome: { reason: "failed", cleanup: { status: "failed" } }
      }
    });
    const metadata = await readFile(join(root, "metadata.json"), "utf8");
    expect(metadata).toContain('"status": "failed"');
    expect(metadata).toContain('"executionOutcome": "succeeded"');
    expect(metadata).toContain('"artifactReference"');
    expect(metadata).toContain("cleanup failed after artifact verification");
    expect(registry.size).toBe(0);
  });

  it("aggregates primary, cleanup, and drain failures without losing finalization causes", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-aggregate-failures-"));
    let cleanupStarted = false;
    let drainAttempts = 0;
    const readModels = new AcpEventReadModelRegistry((options) => {
      const store = new AcpEventStore(options);
      const drain = store.drain.bind(store);
      store.drain = async () => {
        await drain();
        if (cleanupStarted) {
          drainAttempts += 1;
          throw new Error("DRAIN_MARKER");
        }
      };
      return store;
    });
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      (options) =>
        connectWithCleanupFailure(options, "CLEANUP_MARKER", () => {
          cleanupStarted = true;
        }),
      readModels
    );

    const failure = await controller
      .execute(run(root, "protocol-error"), { timeoutMs: 1000 })
      .catch((error: unknown) => error);
    const messages = nestedErrorMessages(failure);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError && failure.errors).toHaveLength(3);
    expect(failure instanceof AggregateError && failure.errors[0]).toBeInstanceOf(Error);
    expect(messages).toContain("CLEANUP_MARKER");
    expect(messages).toContain("DRAIN_MARKER");
    expect(drainAttempts).toBe(1);
  });

  it("still persists terminal when retention rejects a late diagnostic after artifact", async () => {
    const calibrationRoot = await mkdtemp(join(tmpdir(), "planweave-acp-retention-calibration-"));
    const calibrationController = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      connectWithCleanupFailure,
      new AcpEventReadModelRegistry()
    );
    await expect(
      calibrationController.execute(run(calibrationRoot, "artifact-implementation"), {
        timeoutMs: 1000
      })
    ).rejects.toThrow("Runner terminal cleanup did not complete cleanly");
    const calibrationLines = (await readFile(join(calibrationRoot, "events.ndjson"), "utf8"))
      .trim()
      .split("\n");
    const policy = retentionPolicyForArtifactLog(calibrationLines);
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-retention-terminal-"));
    const readModels = new AcpEventReadModelRegistry(
      (options) => new AcpEventStore({ ...options, retentionPolicy: policy })
    );
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      connectWithCleanupFailure,
      readModels
    );

    const failure = await controller
      .execute(run(root, "artifact-implementation"), { timeoutMs: 1000 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      failure instanceof AggregateError &&
        failure.errors.some((error) => error instanceof AcpEventStoreLimitError)
    ).toBe(true);
    const events = readModels.get(root)?.replay(0).events ?? [];
    const boundedArtifactIndex = events.findIndex((event) => event.body.kind === "artifact");
    expect(events.slice(boundedArtifactIndex + 1).map((event) => event.body.kind)).toEqual([
      "terminal"
    ]);
    expect(events.at(-1)).toMatchObject({
      body: { kind: "terminal", outcome: { reason: "failed", artifactValidated: true } }
    });
  });

  it("persists a structured timeout reason only after the ACP session reaches running", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-timeout-event-"));
    const readModels = new AcpEventReadModelRegistry();
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    let rejectPrompt!: (reason: unknown) => void;
    const blockedPrompt = new Promise<Awaited<ReturnType<AcpConnection["prompt"]>>>((_, reject) => {
      rejectPrompt = reject;
    });
    const connection: AcpConnection = {
      processId: 42,
      pendingOperationCount: 0,
      pendingOperations: new Map(),
      stderr: [],
      closed: Promise.resolve(),
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "deterministic-timeout-agent", version: "1.0.0" }
      })),
      newSession: vi.fn(async () => ({ sessionId: "timeout-session" })),
      loadSession: vi.fn(async () => ({})),
      prompt: vi.fn(() => {
        markPromptStarted();
        return blockedPrompt;
      }),
      cancel: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => ({})),
      setSessionMode: vi.fn(async () => ({})),
      setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
      dispose: vi.fn(async () => undefined)
    };
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      () => connection,
      readModels
    );

    const execution = controller.execute(run(root, "long-prompt"), { timeoutMs: 200 });
    await promptStarted;
    rejectPrompt(new AcpOperationTimeoutError("prompt", 200));
    await expect(execution).rejects.toThrow("timed out");
    const events = readModels.get(root)?.replay(0).events ?? [];
    const runningIndex = events.findIndex(
      (event) => event.body.kind === "lifecycle" && event.body.state === "running"
    );
    const terminalIndex = events.findIndex((event) => event.body.kind === "terminal");
    expect(runningIndex).toBeGreaterThanOrEqual(0);
    expect(runningIndex).toBeLessThan(terminalIndex);
    expect(events[terminalIndex]).toMatchObject({
      body: {
        kind: "terminal",
        outcome: { reason: "timed_out", cleanup: { status: "succeeded" } }
      }
    });
    const terminal = events[terminalIndex];
    expect(
      terminal?.body.kind === "terminal" ? terminal.body.outcome.nextActions?.actions : []
    ).toEqual([
      {
        kind: "retry_new_session",
        sourceRecordId: "T-001#B-001::RUN-001",
        sourceRunId: "RUN-001"
      }
    ]);
  });

  it("loads the exact recovery session and never falls back to a new session", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-recovery-load-"));
    const loadFailure = new Error("scripted session/load failure");
    const connection: AcpConnection = {
      processId: 42,
      pendingOperationCount: 0,
      pendingOperations: new Map(),
      stderr: [],
      closed: Promise.resolve(),
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "recovery-agent", version: "1.0.0" }
      })),
      newSession: vi.fn(async () => ({ sessionId: "unexpected-new-session" })),
      loadSession: vi.fn(async () => {
        throw loadFailure;
      }),
      prompt: vi.fn(),
      cancel: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => ({})),
      setSessionMode: vi.fn(async () => ({})),
      setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
      dispose: vi.fn(async () => undefined)
    };
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      () => connection,
      new AcpEventReadModelRegistry()
    );
    const recoveryRun = run(root, "recovery");
    recoveryRun.sessionStart = {
      kind: "load",
      sessionId: "source-session",
      recovery: {
        version: "planweave.acp-recovery/v1",
        kind: "session_load",
        sourceRecordId: "T-001#B-001::RUN-000",
        sourceRunId: "RUN-000",
        sourceSessionId: "source-session",
        sourceTerminalEventSequence: 8,
        requestedAt: "2026-07-17T00:00:00.000Z",
        requestedBy: "planweave-test"
      }
    };

    await expect(controller.execute(recoveryRun, { timeoutMs: 1000 })).rejects.toThrow(
      "scripted session/load failure"
    );
    expect(connection.loadSession).toHaveBeenCalledWith(
      { sessionId: "source-session", cwd: root, mcpServers: [] },
      expect.objectContaining({ timeoutMs: 1000 })
    );
    expect(connection.newSession).not.toHaveBeenCalled();
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it("does not publish artifacts when execution fails before validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-no-artifact-"));
    const readModels = new AcpEventReadModelRegistry();
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      readModels
    );

    await expect(
      controller.execute(run(root, "protocol-error"), { timeoutMs: 1_000 })
    ).rejects.toThrow();
    expect(
      readModels
        .get(root)
        ?.replay(0)
        .events.some((event) => event.body.kind === "artifact")
    ).toBe(false);
    const terminal = readModels
      .get(root)
      ?.replay(0)
      .events.find((event) => event.body.kind === "terminal");
    expect(terminal?.body.kind === "terminal" ? terminal.body.outcome.nextActions?.actions : []).toEqual([
      {
        kind: "retry_new_session",
        sourceRecordId: "T-001#B-001::RUN-001",
        sourceRunId: "RUN-001"
      }
    ]);
    const metadata = await readFile(join(root, "metadata.json"), "utf8");
    expect(metadata).not.toContain('"executionOutcome": "succeeded"');
  });

  it("does not publish artifacts when execution is cancelled before validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-cancel-no-artifact-"));
    const readModels = new AcpEventReadModelRegistry();
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      readModels
    );
    const abort = new AbortController();
    const execution = controller.execute(run(root, "long-prompt"), {
      timeoutMs: 1_000,
      signal: abort.signal
    });
    setTimeout(() => abort.abort(new Error("cancel before artifact validation")), 25);

    await expect(execution).rejects.toThrow("cancel before artifact validation");
    expect(
      readModels
        .get(root)
        ?.replay(0)
        .events.some((event) => event.body.kind === "artifact")
    ).toBe(false);
    const metadata = await readFile(join(root, "metadata.json"), "utf8");
    expect(metadata).toContain('"status": "cancelled"');
    expect(metadata).not.toContain('"executionOutcome": "succeeded"');
  });
});
