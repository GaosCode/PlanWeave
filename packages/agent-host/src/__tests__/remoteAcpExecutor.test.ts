import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exampleExecutionEnvelopeInput,
  executeBlockCommandSchema,
  executionEnvelopeSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { DEFAULT_ACP_SHUTDOWN_POLICY, type AcpEngineTerminal } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AcpAdapterConformanceObservation,
  type AcpAdapterConformanceScenario,
  defineAcpExecutionAdapterConformance
} from "../../../runtime/src/__tests__/support/acpExecutionAdapterConformance.js";
import type {
  AgentHostAcpProfileResolver,
  AgentHostRemoteExecutionIdentity,
  AgentHostRemoteInteractionResponder
} from "../execution/remoteAcpPorts.js";
import {
  AgentHostExecutionError,
  AgentHostSessionLoadError
} from "../execution/agentHostExecutor.js";
import { AGENT_HOST_RESUME_PROMPT, RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import {
  openAgentHostRemoteExecutionOutbox,
  type AgentHostSqliteRemoteExecutionOutbox
} from "../state/remoteExecutionOutbox.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";

const mockAgentPath = fileURLToPath(
  new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);
const finalArtifactPrompt = `${exampleExecutionEnvelopeInput.renderedPrompt}

PLANWEAVE RUNNER-ONLY FINAL ARTIFACT CONTRACT
Return PLANWEAVE_FINAL_ARTIFACT {}`;
const directories: string[] = [];
const outboxes: AgentHostSqliteRemoteExecutionOutbox[] = [];

afterEach(async () => {
  for (const outbox of outboxes.splice(0)) outbox.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function openOutbox() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-acp-"));
  directories.push(directory);
  const path = join(directory, "remote.sqlite");
  const outbox = await openAgentHostRemoteExecutionOutbox(path);
  outboxes.push(outbox);
  return { outbox, path };
}

function command(
  options: {
    prompt?: string;
    session?: typeof exampleExecutionEnvelopeInput.session | Record<string, never>;
    reportRequired?: boolean;
    maxArtifactBytes?: number;
    maxArtifactCount?: number;
    requiredCapabilities?: string[];
  } = {}
) {
  const envelope = executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    renderedPrompt: options.prompt ?? "Execute the remote ACP adapter test.",
    session: options.session ?? {},
    requiredCapabilities: options.requiredCapabilities ?? ["linux", "acp.test"],
    output: {
      reportRequired: options.reportRequired ?? true,
      maxArtifactBytes: options.maxArtifactBytes ?? 1_048_576,
      maxArtifactCount: options.maxArtifactCount ?? 1
    }
  });
  return executeBlockCommandSchema.parse({
    type: "execute_block",
    protocolVersion: 1,
    dispatchId: envelope.execution.dispatchId,
    leaseId: "lease-remote-001",
    executionAttemptId: envelope.execution.attemptId,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    envelopeDigest: hashExecutionEnvelope(envelope),
    envelope
  });
}

function identity(input: ReturnType<typeof command>): AgentHostRemoteExecutionIdentity {
  return {
    dispatchId: input.dispatchId,
    leaseId: input.leaseId,
    executionAttemptId: input.executionAttemptId
  };
}

function executionKey(input: ReturnType<typeof command>): string {
  return `${input.dispatchId}:${input.leaseId}:${input.executionAttemptId}`;
}

function profileResolver(
  scenario: string,
  shutdown = DEFAULT_ACP_SHUTDOWN_POLICY,
  capabilityPolicy = { required: [] as const, optional: [] as const }
): AgentHostAcpProfileResolver {
  return {
    resolve: () => ({
      agentId: exampleExecutionEnvelopeInput.agentId,
      capabilityPolicy,
      launch: { command: process.execPath, args: [mockAgentPath, scenario] },
      env: {},
      shutdown,
      session: {
        modes: { default: "agent-full-access" },
        configOptions: {
          model: {
            configId: "model",
            values: { default: "gpt-5.2-codex" }
          },
          fast: { configId: "fast-mode", values: { enabled: true } }
        }
      }
    })
  };
}

function artifactContext(input: ReturnType<typeof command>) {
  const download = vi.fn(async (artifact: { mediaType?: string }) => ({
    bytes: new Uint8Array(),
    mediaType: artifact.mediaType ?? "application/octet-stream"
  }));
  const upload = vi.fn(
    async ({ bytes }: { bytes: Uint8Array }) =>
      `artifact:sha256:${createHash("sha256").update(bytes).digest("hex")}` as const
  );
  return {
    download,
    upload,
    context: {
      signal: new AbortController().signal,
      executionKey: executionKey(input),
      artifacts: { download, upload },
      sessionStart: { kind: "new" as const }
    }
  };
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected_agent_host_execution_failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentHostExecutionError);
    expect((error as AgentHostExecutionError).failure.code).toBe(code);
  }
}

function conformanceTerminal(terminal: AcpEngineTerminal) {
  if (terminal.state === "succeeded") return terminal;
  if (terminal.state === "cancelled") {
    return { state: "cancelled", failureCategory: "cancelled" } as const;
  }
  return { state: "failed", failureCategory: terminal.reason } as const;
}

async function runRemoteConformance(
  scenario: AcpAdapterConformanceScenario
): Promise<AcpAdapterConformanceObservation> {
  const { outbox } = await openOutbox();
  const input = command();
  const controller = new AbortController();
  const executor = new RemoteAcpExecutor({
    workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
    profileResolver: profileResolver(scenario),
    outbox,
    hostCapabilities: ["linux", "acp.test"]
  });
  const { context, upload } = artifactContext(input);
  let publicFailure: AgentHostExecutionError["failure"] | undefined;
  const execution = executor.execute(input, { ...context, signal: controller.signal });
  if (scenario === "long-prompt") setTimeout(() => controller.abort(), 20);
  try {
    await execution;
  } catch (error) {
    if (!(error instanceof AgentHostExecutionError)) throw error;
    publicFailure = error.failure;
  }

  const events = outbox
    .records(identity(input))
    .filter((record) => record.kind === "engine_event")
    .map((record) => record.event);
  const terminalEvent = events.filter((event) => event.kind === "terminal").at(-1);
  if (!terminalEvent || terminalEvent.kind !== "terminal") {
    throw new Error("Remote ACP adapter persisted no terminal event.");
  }
  return {
    terminal: conformanceTerminal(terminalEvent.terminal),
    productTexts: upload.mock.calls.map((call) => Buffer.from(call[0].bytes).toString("utf8")),
    events: events.map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      ...(event.kind === "lifecycle" ? { state: event.state } : {})
    })),
    ...(publicFailure ? { publicFailure } : {})
  };
}

defineAcpExecutionAdapterConformance("Agent Host remote", {
  exposesRemotePublicFailure: true,
  run: runRemoteConformance
});

describe("RemoteAcpExecutor", () => {
  it("durably retains a missing required capability snapshot before session creation", async () => {
    const { outbox } = await openOutbox();
    const input = command();
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("success", DEFAULT_ACP_SHUTDOWN_POLICY, {
        required: ["history-load"],
        optional: []
      }),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });

    await expect(executor.execute(input, artifactContext(input).context)).rejects.toMatchObject({
      failure: { code: "acp_capability_missing" }
    });
    const records = outbox.records(identity(input));
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: "engine_event",
        event: expect.objectContaining({
          kind: "capability_snapshot",
          snapshot: expect.objectContaining({ missing: ["history-load"] })
        })
      })
    );
    expect(
      records.some(
        (record) => record.kind === "engine_event" && record.event.kind === "session_started"
      )
    ).toBe(false);
  });

  it("probes a usable session when an Agent advertises authentication despite an existing login", async () => {
    const { outbox } = await openOutbox();
    const input = command();
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("session-ready-with-agent-auth"),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });

    const result = await executor.execute(input, artifactContext(input).context);

    expect(result.reportArtifactRef).toMatch(/^artifact:sha256:/);
    expect(outbox.records(identity(input))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "engine_event",
          event: expect.objectContaining({ kind: "session_started", loaded: false })
        })
      ])
    );
  });

  it("replays only identical durable records and rejects conflicting or invalid persisted payloads", async () => {
    const { outbox, path } = await openOutbox();
    const input = command();
    const record = {
      kind: "engine_event" as const,
      identity: identity(input),
      event: {
        kind: "lifecycle" as const,
        state: "connecting" as const,
        sequence: 1,
        timestamp: new Date().toISOString()
      }
    };
    outbox.append(record);
    outbox.append(record);
    expect(outbox.records(identity(input))).toHaveLength(1);
    expect(() =>
      outbox.append({ ...record, event: { ...record.event, state: "running" } })
    ).toThrow("remote_execution_outbox_conflict");

    outbox.close();
    outboxes.pop();
    const database = await openAgentHostDatabase(path, 5_000);
    database
      .prepare("UPDATE agent_host_remote_execution_outbox SET record_json = ? WHERE sequence = 1")
      .run(JSON.stringify({ ...record, unexpected: true }));
    database.close();
    const reopened = await openAgentHostRemoteExecutionOutbox(path);
    outboxes.push(reopened);
    expect(() => reopened.records(identity(input))).toThrow();
  });

  it("runs the real Runtime ACP engine, applies mapped session config, uploads output, and persists events", async () => {
    const { outbox, path } = await openOutbox();
    const input = command({
      prompt: finalArtifactPrompt,
      session: {
        modeId: "default",
        configOptions: [
          { optionId: "model", valueId: "default" },
          { optionId: "fast", valueId: "enabled" }
        ]
      }
    });
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("artifact-session-config"),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });
    const { context, upload } = artifactContext(input);

    const result = await executor.execute(input, context);

    expect(result.reportArtifactRef).toMatch(/^artifact:sha256:/);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "report", operationKey: "remote-acp-report" })
    );
    expect(outbox.records(identity(input))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "engine_event",
          event: expect.objectContaining({
            kind: "terminal",
            terminal: { state: "succeeded", stopReason: "end_turn" }
          })
        })
      ])
    );

    outbox.close();
    outboxes.pop();
    const reopened = await openAgentHostRemoteExecutionOutbox(path);
    outboxes.push(reopened);
    expect(reopened.records(identity(input)).length).toBeGreaterThan(3);
  });

  it("loads the exact recovery session without redownloading inputs or replaying the original prompt", async () => {
    const { outbox } = await openOutbox();
    const input = command({ session: {} });
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("load-capable"),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });
    const { context, download, upload } = artifactContext(input);

    const result = await executor.execute(input, {
      ...context,
      sessionStart: { kind: "load", sessionId: "existing-session-42" }
    });

    expect(download).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledOnce();
    expect(result.summary).toContain("existing-session-42");
    expect(AGENT_HOST_RESUME_PROMPT).not.toBe(input.envelope.renderedPrompt);
    expect(AGENT_HOST_RESUME_PROMPT).toContain("Do not assume");
    expect(AGENT_HOST_RESUME_PROMPT).toContain("do not repeat side effects without evidence");
    expect(outbox.records(identity(input))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "engine_event",
          event: expect.objectContaining({
            kind: "session_started",
            sessionId: "existing-session-42",
            loaded: true
          })
        })
      ])
    );
  });

  it("reports session/load failure without falling back to session/new", async () => {
    const { outbox } = await openOutbox();
    const input = command({ session: {} });
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("success"),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });
    const { context, download, upload } = artifactContext(input);

    await expect(
      executor.execute(input, {
        ...context,
        sessionStart: { kind: "load", sessionId: "missing-session" }
      })
    ).rejects.toBeInstanceOf(AgentHostSessionLoadError);
    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(
      outbox
        .records(identity(input))
        .filter(
          (record) => record.kind === "engine_event" && record.event.kind === "session_started"
        )
    ).toEqual([]);
  });

  it("revalidates strict envelope, digest, and exact dispatch/lease/attempt context before resolving or spawning", async () => {
    const { outbox } = await openOutbox();
    const resolveWorkspace = vi.fn(() => ({ cwd: process.cwd() }));
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: resolveWorkspace },
      profileResolver: profileResolver("success"),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });
    const input = command();
    const { context } = artifactContext(input);

    await expectFailure(
      executor.execute(
        { ...input, envelope: { ...input.envelope, command: process.execPath } },
        context
      ),
      "execution_envelope_invalid"
    );
    await expectFailure(
      executor.execute({ ...input, envelopeDigest: `envelope:sha256:${"0".repeat(64)}` }, context),
      "execution_envelope_invalid"
    );
    await expectFailure(
      executor.execute(input, {
        ...context,
        executionKey: `${input.dispatchId}:${input.leaseId}:stale`
      }),
      "execution_attempt_mismatch"
    );
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it("rejects unsupported report contracts and missing host capability before local resolution", async () => {
    const { outbox } = await openOutbox();
    const resolveWorkspace = vi.fn(() => ({ cwd: process.cwd() }));
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: resolveWorkspace },
      profileResolver: profileResolver("success"),
      outbox,
      hostCapabilities: ["linux"]
    });
    const noReport = command({ reportRequired: false, requiredCapabilities: ["linux"] });
    await expectFailure(
      executor.execute(noReport, artifactContext(noReport).context),
      "report_contract_unsupported"
    );
    const missingCapability = command();
    await expectFailure(
      executor.execute(missingCapability, artifactContext(missingCapability).context),
      "host_capability_missing"
    );
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it("does not start ACP or publish terminal success when an input artifact fails verification", async () => {
    const { outbox } = await openOutbox();
    const input = command({ prompt: finalArtifactPrompt });
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("success"),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });
    const { context, download, upload } = artifactContext(input);
    download.mockRejectedValueOnce(new Error("artifact_download_hash_mismatch"));

    await expect(executor.execute(input, context)).rejects.toThrow(
      "artifact_download_hash_mismatch"
    );
    expect(upload).not.toHaveBeenCalled();
    expect(outbox.records(identity(input))).toEqual([]);
  });

  it("persists complete normalized interactions and fails closed at the bounded deadline", async () => {
    const { outbox } = await openOutbox();
    const input = command({ prompt: finalArtifactPrompt });
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("permission-secret"),
      outbox,
      hostCapabilities: ["linux", "acp.test"],
      limits: { interactionTimeoutMs: 30 }
    });

    await expectFailure(
      executor.execute(input, artifactContext(input).context),
      "acp_interaction_timeout"
    );
    const records = outbox.records(identity(input));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "permission_request",
          request: expect.objectContaining({ options: expect.any(Array) }),
          deadline: expect.any(String)
        })
      ])
    );
    expect(JSON.stringify(records)).not.toContain("super-secret");
    expect(JSON.stringify(records)).toContain("[REDACTED:CREDENTIAL]");
  });

  it("relays an interaction response without narrowing ACP option identity", async () => {
    const { outbox } = await openOutbox();
    const responder: AgentHostRemoteInteractionResponder = {
      requestPermission: (_identity, request) => ({
        kind: "select",
        optionId: request.options[0]?.optionId ?? ""
      }),
      requestElicitation: () => ({ action: "cancel" })
    };
    const input = command({ prompt: finalArtifactPrompt });
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("permission"),
      outbox,
      interactionResponder: responder,
      hostCapabilities: ["linux", "acp.test"]
    });

    await expect(executor.execute(input, artifactContext(input).context)).resolves.toMatchObject({
      reportArtifactRef: expect.stringMatching(/^artifact:sha256:/)
    });
    expect(outbox.records(identity(input))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "permission_request",
          request: expect.objectContaining({
            options: [{ optionId: "allow", label: "Allow once", decision: "approve" }]
          })
        })
      ])
    );
  });

  it("maps dynamic session config failures to a bounded typed failure", async () => {
    const { outbox } = await openOutbox();
    const configured = command({
      prompt: finalArtifactPrompt,
      session: { modeId: "default", configOptions: [] }
    });
    const unsupported = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("success"),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });
    await expectFailure(
      unsupported.execute(configured, artifactContext(configured).context),
      "acp_session_config_failed"
    );
  });

  it("bounds output through the Runtime engine", async () => {
    const { outbox } = await openOutbox();
    const limited = command({ maxArtifactBytes: 8 });
    const limitedExecutor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: profileResolver("success"),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });
    await expectFailure(
      limitedExecutor.execute(limited, artifactContext(limited).context),
      "acp_limit_exceeded"
    );
  });

  it("masks resolver diagnostics so trusted paths and secrets do not cross the boundary", async () => {
    const { outbox } = await openOutbox();
    const input = command();
    const executor = new RemoteAcpExecutor({
      workspaceResolver: {
        resolve: () => {
          throw new Error("/Users/private-worktree token=raw-secret");
        }
      },
      profileResolver: profileResolver("success"),
      outbox,
      hostCapabilities: ["linux", "acp.test"]
    });
    try {
      await executor.execute(input, artifactContext(input).context);
      throw new Error("expected_agent_host_execution_failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentHostExecutionError);
      expect((error as AgentHostExecutionError).message).not.toContain("private-worktree");
      expect((error as AgentHostExecutionError).message).not.toContain("raw-secret");
    }
  });

  it("threads shared-project connection mode and workspace pool identity into executeAcp", async () => {
    let received:
      | {
          connectionMode?: string;
          poolIdentity?: { projectRoot?: string; profileFingerprint?: string; host?: unknown };
        }
      | undefined;
    vi.resetModules();
    vi.doMock("@planweave-ai/runtime", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@planweave-ai/runtime")>()),
      executeAcp: vi.fn(async (options) => {
        received = {
          connectionMode: options.connectionMode,
          poolIdentity: options.poolIdentity
        };
        return {
          sessionId: "session-shared",
          output: "shared-project report",
          terminal: { state: "succeeded", stopReason: "end_turn" },
          cleanup: { attempted: true, completed: true }
        };
      })
    }));
    vi.doMock("../execution/inputArtifactWorkspace.js", () => ({
      prepareInputArtifacts: vi.fn(async () => ({
        prompt: "prepared prompt",
        cleanup: vi.fn(async () => undefined)
      }))
    }));

    try {
      const { RemoteAcpExecutor: IsolatedRemoteAcpExecutor } = await import(
        "../execution/remoteAcpExecutor.js"
      );
      const { outbox } = await openOutbox();
      const input = command();
      const cwd = process.cwd();
      const executor = new IsolatedRemoteAcpExecutor({
        workspaceResolver: { resolve: () => ({ cwd }) },
        profileResolver: {
          resolve: () => ({
            agentId: exampleExecutionEnvelopeInput.agentId,
            capabilityPolicy: { required: [], optional: [] },
            launch: { command: process.execPath, args: [mockAgentPath, "success"] },
            env: {},
            shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
            connection: { mode: "shared-project" as const },
            fingerprint: "host-shared-fingerprint",
            host: { kind: "native" as const }
          })
        },
        outbox,
        hostCapabilities: ["linux", "acp.test"]
      });
      await executor.execute(input, artifactContext(input).context);
      expect(received).toEqual({
        connectionMode: "shared-project",
        poolIdentity: {
          projectRoot: cwd,
          profileFingerprint: "host-shared-fingerprint",
          host: { kind: "native" }
        }
      });
    } finally {
      vi.doUnmock("@planweave-ai/runtime");
      vi.doUnmock("../execution/inputArtifactWorkspace.js");
      vi.resetModules();
    }
  });

  it("preserves both failures when ACP execution and input cleanup fail", async () => {
    const executionError = new Error("execution failed");
    const cleanupError = new Error("cleanup failed");
    const shutdown = { eofDrainMs: 90, terminateGraceMs: 160, cleanupDeadlineMs: 760 };
    let receivedShutdown: unknown;
    vi.resetModules();
    vi.doMock("@planweave-ai/runtime", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@planweave-ai/runtime")>()),
      executeAcp: vi.fn(async (options) => {
        receivedShutdown = options.shutdown;
        throw executionError;
      })
    }));
    vi.doMock("../execution/inputArtifactWorkspace.js", () => ({
      prepareInputArtifacts: vi.fn(async () => ({
        prompt: "prepared prompt",
        cleanup: vi.fn(async () => {
          throw cleanupError;
        })
      }))
    }));

    try {
      const { RemoteAcpExecutor: IsolatedRemoteAcpExecutor } = await import(
        "../execution/remoteAcpExecutor.js"
      );
      const { outbox } = await openOutbox();
      const input = command();
      const executor = new IsolatedRemoteAcpExecutor({
        workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
        profileResolver: profileResolver("success", shutdown),
        outbox,
        hostCapabilities: ["linux", "acp.test"]
      });

      try {
        await executor.execute(input, artifactContext(input).context);
        throw new Error("expected_combined_execution_cleanup_failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toBe(
          "remote_acp_execution_and_input_cleanup_failed"
        );
        expect((error as AggregateError).errors).toEqual([executionError, cleanupError]);
        expect((error as AggregateError).cause).toBe(executionError);
        expect(receivedShutdown).toEqual(shutdown);
      }
    } finally {
      vi.doUnmock("@planweave-ai/runtime");
      vi.doUnmock("../execution/inputArtifactWorkspace.js");
      vi.resetModules();
    }
  });

  it("includes ACP engine diagnostic text in acp_unknown_error failures", async () => {
    vi.resetModules();
    vi.doMock("@planweave-ai/runtime", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@planweave-ai/runtime")>()),
      executeAcp: vi.fn(async () => ({
        sessionId: "session-diagnostic",
        output: "",
        terminal: {
          state: "failed",
          reason: "unknown_error",
          message: "spawn EACCES /opt/grok/bin/grok"
        },
        cleanup: { attempted: true, completed: true }
      }))
    }));
    vi.doMock("../execution/inputArtifactWorkspace.js", () => ({
      prepareInputArtifacts: vi.fn(async () => ({
        prompt: "prepared prompt",
        cleanup: vi.fn(async () => undefined)
      }))
    }));

    try {
      const { RemoteAcpExecutor: IsolatedRemoteAcpExecutor } = await import(
        "../execution/remoteAcpExecutor.js"
      );
      const { AgentHostExecutionError: IsolatedAgentHostExecutionError } = await import(
        "../execution/agentHostExecutor.js"
      );
      const { outbox } = await openOutbox();
      const input = command();
      const executor = new IsolatedRemoteAcpExecutor({
        workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
        profileResolver: profileResolver("success"),
        outbox,
        hostCapabilities: ["linux", "acp.test"]
      });
      try {
        await executor.execute(input, artifactContext(input).context);
        throw new Error("expected_agent_host_execution_failure");
      } catch (error) {
        expect(error).toBeInstanceOf(IsolatedAgentHostExecutionError);
        expect((error as InstanceType<typeof IsolatedAgentHostExecutionError>).failure.code).toBe(
          "acp_unknown_error"
        );
        expect((error as Error).message).toContain("spawn EACCES /opt/grok/bin/grok");
      }
    } finally {
      vi.doUnmock("@planweave-ai/runtime");
      vi.doUnmock("../execution/inputArtifactWorkspace.js");
      vi.resetModules();
    }
  });
});
