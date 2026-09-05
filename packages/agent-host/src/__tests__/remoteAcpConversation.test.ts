import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acpConversationPromptCommandSchema,
  exampleExecutionEnvelopeInput,
  type AcpConversationCommand
} from "@planweave-ai/agent-host-protocol";
import { DEFAULT_ACP_SHUTDOWN_POLICY } from "@planweave-ai/runtime";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import { RemoteAcpConversationService } from "../execution/remoteAcpConversationService.js";
const fixtures: { directory: string; state: AgentHostState }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.state.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "acp-conversation-test-"));
  const state = await openAgentHostState(join(directory, "state.sqlite"));
  fixtures.push({ directory, state });
  const command = acpConversationPromptCommandSchema.parse({
    type: "acp_conversation.prompt",
    protocolVersion: 1,
    operationId: "op-one",
    turnId: "turn-one",
    executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
    sessionId: "original-session",
    text: "A follow-up",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
  });
  let sequence = 0;
  const receive = (command: AcpConversationCommand) => {
    state.receive({
      type: "mailbox.message",
      protocolVersion: 1,
      messageId: `message-${sequence + 1}`,
      previousSequence: sequence,
      sequence: ++sequence,
      command
    });
  };
  return { directory, state, command, receive };
}
describe("Host remote ACP continuation", () => {
  it("loads the exact session for two real ACP prompts and suppresses session/load history", async () => {
    const f = await setup();
    const upload = vi.fn();
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: f.directory }) },
      runtimeWorkspaceResolver: { resolve: () => ({ cwd: f.directory }) },
      profileResolver: {
        resolve: () => ({
          agentId: exampleExecutionEnvelopeInput.agentId,
          capabilityPolicy: { required: [], optional: [] },
          shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
          launch: {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
              ),
              "load-capable",
              "--control-dir",
              f.directory
            ]
          },
          env: {}
        })
      },
      outbox: { append: upload },
      hostCapabilities: []
    });
    const service = new RemoteAcpConversationService(f.state.conversations, executor);
    const waitDone = async (turnId: string) => {
      await vi.waitFor(
        () =>
          expect(
            f.state
              .pendingEvents()
              .some(
                (e) =>
                  e.type === "acp_conversation.event" &&
                  e.turnId === turnId &&
                  e.payload.kind === "status" &&
                  e.payload.status === "completed"
              )
          ).toBe(true),
        { timeout: 10000 }
      );
    };
    f.receive(f.command);
    service.handle(f.command);
    expect(service.isSessionActive("original-session")).toBe(true);
    expect(service.isSessionActive("unrelated-session")).toBe(false);
    service.handle(f.command);
    await waitDone(f.command.turnId);
    const second = { ...f.command, turnId: "turn-two", text: "One more message" };
    f.receive(second);
    service.handle(second);
    await waitDone(second.turnId);
    await service.stop();
    expect(service.isSessionActive("original-session")).toBe(false);
    const log = await readFile(join(f.directory, "lifecycle.log"), "utf8");
    expect(log.match(/session\/load/g)).toHaveLength(2);
    expect(log).not.toContain("session/new");
    const events = f.state.pendingEvents().filter((e) => e.type === "acp_conversation.event");
    expect(JSON.stringify(events)).not.toContain("historical replay");
    expect(JSON.stringify(events)).toContain("One more message");
    expect(events.every((e) => e.sessionId === "original-session")).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });
  it("persists interruption instead of replaying an uncertain prompt", async () => {
    const f = await setup();
    f.receive(f.command);
    f.state.conversations.start(f.command.turnId);
    const execute = vi.fn();
    const service = new RemoteAcpConversationService(f.state.conversations, { converse: execute });
    service.recover();
    await service.stop();
    expect(execute).not.toHaveBeenCalled();
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        type: "acp_conversation.event",
        payload: { kind: "status", status: "failed", error: "acp_conversation_host_interrupted" }
      })
    );
  });
  it("cancels a waiting turn and permits a subsequent turn without replaying the cancelled prompt", async () => {
    const f = await setup();
    const execute = vi.fn(
      async (_command, _broker, _sink, signal: AbortSignal) =>
        new Promise<{ state: "cancelled"; reason: "cancelled" }>((resolve) =>
          signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", reason: "cancelled" }),
            { once: true }
          )
        )
    );
    const service = new RemoteAcpConversationService(f.state.conversations, { converse: execute });
    f.receive(f.command);
    service.handle(f.command);
    const { sourceEnvelope: _source, text: _text, expiresAt: _expiry, ...identity } = f.command;
    const cancel = { ...identity, type: "acp_conversation.cancel" as const };
    f.receive(cancel);
    service.handle(cancel);
    await service.stop();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        type: "acp_conversation.event",
        payload: { kind: "status", status: "cancelled", error: null }
      })
    );
  });
});
