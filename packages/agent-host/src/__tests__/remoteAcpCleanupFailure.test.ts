import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  exampleExecutionEnvelopeInput,
  acpConversationPromptCommandSchema,
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
      protocolVersion: agentHostProtocolVersion,
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

  it.each(terminals)("passes $state cleanup evidence through converse", async (terminal) => {
    vi.mocked(executeAcp).mockResolvedValue({
      terminal,
      cleanup: { attempted: true, completed: false },
      sessionId: "cleanup-session",
      output: "",
      stderr: [],
      capabilities: null,
      capabilitySnapshot: null,
      authentication: null,
      usage: null
    });
    const command = acpConversationPromptCommandSchema.parse({
      type: "acp_conversation.prompt",
      protocolVersion: agentHostProtocolVersion,
      operationId: "op-cleanup",
      turnId: "turn-cleanup",
      executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
      sessionId: "cleanup-session",
      text: "Continue",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
    });
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      runtimeWorkspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: {
        resolve: () => ({
          agentId: command.sourceEnvelope.agentId,
          capabilityPolicy: { required: [], optional: [] },
          launch: { command: process.execPath, args: [] },
          env: {},
          shutdown: DEFAULT_ACP_SHUTDOWN_POLICY
        })
      },
      outbox: { append: vi.fn() },
      hostCapabilities: []
    });
    const outcome = await executor.converse(
      command,
      { requestPermission: vi.fn(), requestElicitation: vi.fn() },
      vi.fn(),
      new AbortController().signal
    );
    expect(outcome).toEqual({ terminal, cleanup: { attempted: true, completed: false } });
  });

  it("does not launch ACP when context resolution returns after cancellation", async () => {
    vi.mocked(executeAcp).mockClear();
    let resolveWorkspace!: (value: { cwd: string }) => void;
    const workspace = new Promise<{ cwd: string }>((resolve) => {
      resolveWorkspace = resolve;
    });
    const command = acpConversationPromptCommandSchema.parse({
      type: "acp_conversation.prompt",
      protocolVersion: agentHostProtocolVersion,
      operationId: "op-resolve",
      turnId: "turn-resolve",
      executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
      sessionId: "resolve-session",
      text: "Continue",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
    });
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => workspace },
      runtimeWorkspaceResolver: { resolve: () => ({ cwd: process.cwd() }) },
      profileResolver: {
        resolve: () => ({
          agentId: command.sourceEnvelope.agentId,
          capabilityPolicy: { required: [], optional: [] },
          launch: { command: process.execPath, args: [] },
          env: {},
          shutdown: DEFAULT_ACP_SHUTDOWN_POLICY
        })
      },
      outbox: { append: vi.fn() },
      hostCapabilities: []
    });
    const controller = new AbortController();
    const running = executor.converse(
      command,
      { requestPermission: vi.fn(), requestElicitation: vi.fn() },
      vi.fn(),
      controller.signal
    );
    controller.abort("acp_conversation_deadline_exceeded");
    await expect(running).rejects.toMatchObject({ message: "acp_conversation_setup_failed" });
    resolveWorkspace({ cwd: process.cwd() });
    await Promise.resolve();
    expect(executeAcp).not.toHaveBeenCalled();
  });
});
