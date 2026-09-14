import { describe, expect, it, vi } from "vitest";
import {
  exampleExecutionEnvelopeInput,
  executeBlockCommandSchema,
  executionEnvelopeSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import {
  executeAcp,
  DEFAULT_ACP_SHUTDOWN_POLICY,
  type AcpEngineTerminal
} from "@planweave-ai/runtime";
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";

vi.mock("@planweave-ai/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@planweave-ai/runtime")>();
  return { ...actual, executeAcp: vi.fn() };
});

describe("remote ACP cleanup evidence", () => {
  const terminals: AcpEngineTerminal[] = [
    { state: "cancelled", message: "Cancelled by caller." },
    { state: "failed", reason: "protocol_error", message: "Session load failed." },
    { state: "succeeded", stopReason: "end_turn" }
  ];

  it.each(
    terminals
  )("preserves cleanup failure for $state, including session load", async (terminal) => {
    vi.mocked(executeAcp).mockResolvedValue({
      terminal,
      cleanup: { attempted: true, completed: false },
      sessionId: null,
      output: "",
      stderr: [],
      capabilities: null,
      capabilitySnapshot: null,
      authentication: null,
      usage: null
    });
    const envelope = executionEnvelopeSchema.parse({
      ...exampleExecutionEnvelopeInput,
      session: {},
      requiredCapabilities: [],
      inputArtifacts: []
    });
    const command = executeBlockCommandSchema.parse({
      type: "execute_block",
      protocolVersion: 1,
      dispatchId: envelope.execution.dispatchId,
      leaseId: "lease-cleanup-test",
      executionAttemptId: envelope.execution.attemptId,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      envelopeDigest: hashExecutionEnvelope(envelope),
      envelope
    });
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      runtimeWorkspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: {
        resolve: () => ({
          agentId: envelope.agentId,
          capabilityPolicy: { required: [], optional: [] },
          launch: { command: process.execPath, args: [] },
          env: {},
          shutdown: DEFAULT_ACP_SHUTDOWN_POLICY
        })
      },
      outbox: { append: vi.fn() },
      hostCapabilities: []
    });
    const upload = vi.fn(async () => {
      throw new Error("unexpected_report_upload");
    });
    await expect(
      executor.execute(command, {
        signal: new AbortController().signal,
        executionKey: `${command.dispatchId}:${command.leaseId}:${command.executionAttemptId}`,
        sessionStart: { kind: "load", sessionId: "cleanup-session" },
        artifacts: { upload, download: vi.fn() }
      })
    ).rejects.toMatchObject({ failure: { code: "acp_cleanup_failed" } });
    expect(upload).not.toHaveBeenCalled();
  });
});
