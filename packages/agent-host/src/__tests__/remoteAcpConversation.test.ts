import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
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
import {
  AcpSharedConnectionCleanupError,
  DEFAULT_ACP_SHUTDOWN_POLICY,
  executeAcp
} from "@planweave-ai/runtime";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import { RemoteAcpConversationService } from "../execution/remoteAcpConversationService.js";
import { CalibratedServerClock } from "../transport/calibratedServerClock.js";
import type { HostTransportClock } from "../transport/hostTransport.js";
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
    protocolVersion: agentHostProtocolVersion,
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
      protocolVersion: agentHostProtocolVersion,
      messageId: `message-${sequence + 1}`,
      previousSequence: sequence,
      sequence: ++sequence,
      command
    });
  };
  return { directory, state, command, receive };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function controlledClock(start: number) {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const clock: HostTransportClock = {
    now: () => new Date(now),
    setTimeout: (callback, delayMs) => {
      const id = ++nextId;
      timers.set(id, { due: now + delayMs, callback });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(Number(id));
    }
  };
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    }
  };
}

const success = {
  terminal: { state: "succeeded" as const, stopReason: "end_turn" },
  cleanup: { attempted: true, completed: true }
};

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
describe("Host remote ACP continuation", () => {
  it("keeps the session excluded when acquisition disposal fails before a lease exists", async () => {
    const f = await setup();
    const result = await executeAcp({
      launch: { trusted: true, command: process.execPath, args: [] },
      workspace: { cwd: f.directory },
      env: {},
      clientInfo: { name: "PlanWeave cleanup test", version: "1" },
      shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
      capabilityPolicy: { required: [], optional: [] },
      prompt: "Continue",
      sessionStart: { kind: "load", sessionId: f.command.sessionId },
      connectionMode: "shared",
      provider: {
        acquire: async () => {
          throw new AcpSharedConnectionCleanupError(new Error("scripted_start_dispose_failure"));
        },
        shutdown: async () => undefined
      }
    });
    expect(result.cleanup).toEqual({ attempted: true, completed: false });
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(async () => ({
      terminal: result.terminal,
      cleanup: result.cleanup
    }));
    const service = new RemoteAcpConversationService(f.state.conversations, { converse });
    f.receive(f.command);
    service.handle(f.command);
    await service.stop();
    expect(service.isSessionActive(f.command.sessionId)).toBe(true);
    const stored = await openAgentHostDatabase(join(f.directory, "state.sqlite"), 5_000);
    expect(
      stored
        .prepare("SELECT cleanup_safe FROM agent_host_conversation_turns WHERE turn_id=?")
        .get(f.command.turnId)?.cleanup_safe
    ).toBe(0);
    stored.close();
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: f.command.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_cleanup_failed" }
      })
    );
    const next = { ...f.command, turnId: "turn-after-acquisition-dispose-failure" };
    f.receive(next);
    const resumed = new RemoteAcpConversationService(f.state.conversations, { converse });
    resumed.handle(next);
    expect(converse).toHaveBeenCalledTimes(1);
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: next.turnId,
        payload: {
          kind: "status",
          status: "failed",
          error: "acp_conversation_session_cleanup_unverified"
        }
      })
    );
    await resumed.stop();
  });

  it("keeps v10 sessions closed after upgrade while a newly created session can execute and continue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-conversation-v10-upgrade-"));
    const path = join(directory, "state.sqlite");
    const initial = await openAgentHostState(path);
    initial.close();
    const old = await openAgentHostDatabase(path, 5_000);
    old.exec("ALTER TABLE agent_host_conversation_turns DROP COLUMN cleanup_safe");
    const legacy = acpConversationPromptCommandSchema.parse({
      type: "acp_conversation.prompt",
      protocolVersion: agentHostProtocolVersion,
      operationId: "legacy-operation",
      turnId: "legacy-turn",
      executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
      sessionId: "legacy-session",
      text: "Legacy turn",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
    });
    old
      .prepare(
        "INSERT INTO agent_host_conversation_turns(turn_id,command_json,command_digest,status) VALUES(?,?,?,'completed')"
      )
      .run(legacy.turnId, JSON.stringify(legacy), "legacy-digest");
    const interrupted = {
      ...legacy,
      turnId: "legacy-running",
      sessionId: "legacy-running-session"
    };
    old
      .prepare(
        "INSERT INTO agent_host_conversation_turns(turn_id,command_json,command_digest,status) VALUES(?,?,?,'running')"
      )
      .run(interrupted.turnId, JSON.stringify(interrupted), "legacy-running-digest");
    old.prepare("UPDATE agent_host_state_schema SET version=10 WHERE singleton=1").run();
    old.close();
    const state = await openAgentHostState(path);
    fixtures.push({ directory, state });
    const mockAgent = fileURLToPath(
      new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
    );
    const launch = {
      trusted: true as const,
      command: process.execPath,
      args: [mockAgent, "load-capable"]
    };
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: directory }) },
      runtimeWorkspaceResolver: { resolve: () => ({ cwd: directory }) },
      profileResolver: {
        resolve: () => ({
          agentId: exampleExecutionEnvelopeInput.agentId,
          capabilityPolicy: { required: [], optional: [] },
          shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
          launch,
          env: {}
        })
      },
      outbox: { append: vi.fn() },
      hostCapabilities: []
    });
    const service = new RemoteAcpConversationService(state.conversations, executor);
    service.recover();
    expect(state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: interrupted.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_host_interrupted" }
      })
    );
    const blocked = { ...legacy, turnId: "legacy-next" };
    state.receive({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      messageId: "legacy-message",
      previousSequence: 0,
      sequence: 1,
      command: blocked
    });
    service.handle(blocked);
    expect(state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: blocked.turnId,
        payload: {
          kind: "status",
          status: "failed",
          error: "acp_conversation_session_cleanup_unverified"
        }
      })
    );
    const blockedInterrupted = { ...interrupted, turnId: "legacy-running-next" };
    state.receive({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      messageId: "legacy-running-message",
      previousSequence: 1,
      sequence: 2,
      command: blockedInterrupted
    });
    service.handle(blockedInterrupted);
    expect(state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: blockedInterrupted.turnId,
        payload: {
          kind: "status",
          status: "failed",
          error: "acp_conversation_session_cleanup_unverified"
        }
      })
    );

    const fresh = await executeAcp({
      launch,
      workspace: { cwd: directory },
      env: {},
      clientInfo: { name: "PlanWeave upgrade test", version: "1.0.0" },
      shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
      capabilityPolicy: { required: [], optional: [] },
      prompt: "Create a fresh session",
      sessionStart: { kind: "new" }
    });
    expect(fresh.terminal.state).toBe("succeeded");
    expect(fresh.cleanup.completed).toBe(true);
    expect(fresh.sessionId).toBeTruthy();
    const next = { ...legacy, turnId: "fresh-followup", sessionId: fresh.sessionId! };
    state.receive({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      messageId: "fresh-message",
      previousSequence: 2,
      sequence: 3,
      command: next
    });
    service.handle(next);
    await vi.waitFor(
      () => {
        expect(state.pendingEvents()).toContainEqual(
          expect.objectContaining({
            turnId: next.turnId,
            payload: { kind: "status", status: "completed", error: null }
          })
        );
      },
      { timeout: 10_000 }
    );
    await service.stop();
  }, 20_000);

  it.each([
    -60_000, 60_000
  ])("completes a real ACP load and prompt with a %i ms Host clock skew", async (skewMs) => {
    const f = await setup();
    const mockAgent = fileURLToPath(
      new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
    );
    const profile = {
      agentId: exampleExecutionEnvelopeInput.agentId,
      capabilityPolicy: { required: [], optional: [] },
      shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
      launch: {
        trusted: true as const,
        command: process.execPath,
        args: [mockAgent, "load-capable"]
      },
      env: {}
    };
    const fresh = await executeAcp({
      launch: profile.launch,
      workspace: { cwd: f.directory },
      env: {},
      clientInfo: { name: "PlanWeave skew test", version: "1.0.0" },
      shutdown: profile.shutdown,
      capabilityPolicy: profile.capabilityPolicy,
      prompt: "Create a fresh session",
      sessionStart: { kind: "new" }
    });
    expect(fresh.terminal.state).toBe("succeeded");
    expect(fresh.cleanup.completed).toBe(true);
    const actualNow = Date.now.bind(Date);
    const serverClock = new CalibratedServerClock({ now: () => new Date(actualNow() + skewMs) });
    serverClock.synchronize(new Date(actualNow()).toISOString());
    const executor = new RemoteAcpExecutor({
      workspaceResolver: { resolve: () => ({ cwd: f.directory }) },
      runtimeWorkspaceResolver: { resolve: () => ({ cwd: f.directory }) },
      profileResolver: { resolve: () => profile },
      outbox: { append: vi.fn() },
      hostCapabilities: [],
      serverClock
    });
    const command = {
      ...f.command,
      sessionId: fresh.sessionId!,
      expiresAt: new Date(actualNow() + 10_000).toISOString()
    };
    const service = new RemoteAcpConversationService(
      f.state.conversations,
      executor,
      undefined,
      serverClock
    );
    f.receive(command);
    service.handle(command);
    const localDateNow = vi.spyOn(Date, "now").mockImplementation(() => actualNow() + skewMs);
    try {
      await vi.waitFor(
        () => {
          expect(f.state.pendingEvents()).toContainEqual(
            expect.objectContaining({
              turnId: command.turnId,
              payload: { kind: "status", status: "completed", error: null }
            })
          );
        },
        { timeout: 10_000 }
      );
      await service.stop();
    } finally {
      localDateNow.mockRestore();
    }
  }, 20_000);

  it("expires before startup and stops a running turn at the absolute deadline", async () => {
    const f = await setup();
    const now = Date.now();
    const time = controlledClock(now);
    const observed = deferred<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>();
    let signal: AbortSignal | undefined;
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(
      async (_command, _broker, _sink, value) => {
        signal = value;
        return observed.promise;
      }
    );
    const service = new RemoteAcpConversationService(
      f.state.conversations,
      { converse },
      time.clock
    );
    const expired = { ...f.command, expiresAt: new Date(now).toISOString() };
    f.receive(expired);
    service.handle(expired);
    await flush();
    expect(converse).not.toHaveBeenCalled();
    expect(time.pending()).toBe(0);
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: expired.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_deadline_exceeded" }
      })
    );

    const running = {
      ...f.command,
      turnId: "turn-deadline",
      expiresAt: new Date(now + 2_000).toISOString()
    };
    f.receive(running);
    service.handle(running);
    await flush();
    expect(converse).toHaveBeenCalledTimes(1);
    time.advance(2_000);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("acp_conversation_deadline_exceeded");
    expect(service.isSessionActive(running.sessionId)).toBe(true);
    observed.resolve(success);
    await service.stop();
    expect(time.pending()).toBe(0);
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: running.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_deadline_exceeded" }
      })
    );
  });

  it.each([
    -60_000, 60_000
  ])("uses the Server deadline when the Host clock is offset by %i ms", async (skewMs) => {
    const f = await setup();
    const serverNow = Date.now();
    const time = controlledClock(serverNow + skewMs);
    const serverClock = new CalibratedServerClock(time.clock);
    serverClock.synchronize(new Date(serverNow).toISOString());
    const observed = deferred<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>();
    let signal: AbortSignal | undefined;
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(
      async (_command, _broker, _sink, value) => {
        signal = value;
        return observed.promise;
      }
    );
    const service = new RemoteAcpConversationService(
      f.state.conversations,
      { converse },
      time.clock,
      serverClock
    );
    const command = { ...f.command, expiresAt: new Date(serverNow + 1_000).toISOString() };
    f.receive(command);
    service.handle(command);
    await flush();
    expect(converse).toHaveBeenCalledTimes(1);
    time.advance(999);
    expect(signal?.aborted).toBe(false);
    time.advance(1);
    expect(signal?.reason).toBe("acp_conversation_deadline_exceeded");
    observed.resolve(success);
    await service.stop();
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: command.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_deadline_exceeded" }
      })
    );
  });

  it("rechecks a running turn on Server clock recalibration and retains the last offset offline", async () => {
    const f = await setup();
    const serverNow = Date.now();
    const time = controlledClock(serverNow - 60_000);
    const serverClock = new CalibratedServerClock(time.clock);
    serverClock.synchronize(new Date(serverNow).toISOString());
    const observed = deferred<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>();
    let signal: AbortSignal | undefined;
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(
      async (_command, _broker, _sink, value) => {
        signal = value;
        return observed.promise;
      }
    );
    const service = new RemoteAcpConversationService(
      f.state.conversations,
      { converse },
      time.clock,
      serverClock
    );
    const command = { ...f.command, expiresAt: new Date(serverNow + 2_000).toISOString() };
    f.receive(command);
    service.handle(command);
    await flush();
    time.advance(500);
    serverClock.synchronize(new Date(serverNow + 1_500).toISOString());
    expect(signal?.aborted).toBe(false);
    time.advance(499);
    expect(signal?.aborted).toBe(false);
    time.advance(1);
    expect(signal?.reason).toBe("acp_conversation_deadline_exceeded");
    observed.resolve(success);
    await service.stop();
  });

  it.each([
    { kind: "permission" as const, skewMs: -60_000 },
    { kind: "elicitation" as const, skewMs: 60_000 }
  ])("bounds a waiting $kind interaction by Server time", async ({ kind, skewMs }) => {
    const f = await setup();
    const serverNow = Date.now();
    const time = controlledClock(serverNow + skewMs);
    const serverClock = new CalibratedServerClock(time.clock);
    serverClock.synchronize(new Date(serverNow).toISOString());
    const command = { ...f.command, expiresAt: new Date(serverNow + 1_000).toISOString() };
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(
      async (_command, broker, _sink, signal) => {
        try {
          if (kind === "permission") {
            await broker.requestPermission(
              {
                requestId: "waiting-permission",
                sessionId: command.sessionId,
                toolCallId: "tool",
                summary: "Allow tool",
                options: [{ optionId: "allow", label: "Allow", kind: "allow_once" }]
              },
              { signal, deadline: new Date(time.clock.now().getTime() + 1_000) }
            );
          } else {
            await broker.requestElicitation(
              {
                requestId: "waiting-elicitation",
                sessionId: command.sessionId,
                message: "Provide input",
                requestedSchema: {}
              },
              { signal, deadline: new Date(time.clock.now().getTime() + 1_000) }
            );
          }
        } catch (error) {
          expect(error).toEqual(expect.objectContaining({ message: "acp_conversation_cancelled" }));
        }
        return success;
      }
    );
    const service = new RemoteAcpConversationService(
      f.state.conversations,
      { converse },
      time.clock,
      serverClock
    );
    f.receive(command);
    service.handle(command);
    await flush();
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: command.turnId,
        payload: {
          kind: "interaction",
          request: expect.objectContaining({ kind, deadline: command.expiresAt })
        }
      })
    );
    time.advance(999);
    expect(f.state.pendingEvents()).not.toContainEqual(
      expect.objectContaining({
        turnId: command.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_deadline_exceeded" }
      })
    );
    time.advance(1);
    await service.stop();
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: command.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_deadline_exceeded" }
      })
    );
  });

  it("checks a same-session queued turn against its original Server deadline", async () => {
    const f = await setup();
    const serverNow = Date.now();
    const time = controlledClock(serverNow - 60_000);
    const serverClock = new CalibratedServerClock(time.clock);
    serverClock.synchronize(new Date(serverNow).toISOString());
    const first = deferred<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>();
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(async (command) =>
      command.turnId === f.command.turnId ? first.promise : success
    );
    const service = new RemoteAcpConversationService(
      f.state.conversations,
      { converse },
      time.clock,
      serverClock
    );
    const running = { ...f.command, expiresAt: new Date(serverNow + 10_000).toISOString() };
    const queued = {
      ...f.command,
      turnId: "turn-queued-expiry",
      expiresAt: new Date(serverNow + 1_000).toISOString()
    };
    f.receive(running);
    service.handle(running);
    f.receive(queued);
    service.handle(queued);
    await flush();
    expect(converse).toHaveBeenCalledTimes(1);
    time.advance(1_000);
    first.resolve(success);
    await flush();
    expect(converse).toHaveBeenCalledTimes(1);
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: queued.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_deadline_exceeded" }
      })
    );
    await service.stop();
  });

  it("holds a same-session turn until cleanup finishes while another session proceeds", async () => {
    const f = await setup();
    const firstCleanup = deferred<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>();
    const started: string[] = [];
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(async (command) => {
      started.push(command.turnId);
      return command.turnId === "turn-one" ? firstCleanup.promise : success;
    });
    const service = new RemoteAcpConversationService(f.state.conversations, { converse });
    const same = { ...f.command, turnId: "turn-two" };
    const other = { ...f.command, turnId: "turn-other", sessionId: "other-session" };
    f.receive(f.command);
    service.handle(f.command);
    f.receive(same);
    service.handle(same);
    service.handle(same);
    f.receive(other);
    service.handle(other);
    await flush();
    expect(started).toEqual(["turn-one", "turn-other"]);
    expect(service.isSessionActive(f.command.sessionId)).toBe(true);
    firstCleanup.resolve(success);
    await flush();
    await service.stop();
    expect(started).toEqual(["turn-one", "turn-other", "turn-two"]);
    expect(converse).toHaveBeenCalledTimes(3);
  });

  it("does not classify an active turn as interrupted on transport recovery", async () => {
    const f = await setup();
    const completion = deferred<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>();
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(async () => completion.promise);
    const service = new RemoteAcpConversationService(f.state.conversations, { converse });
    f.receive(f.command);
    service.handle(f.command);
    service.recover();
    expect(converse).toHaveBeenCalledTimes(1);
    expect(
      f.state
        .pendingEvents()
        .some(
          (event) =>
            event.type === "acp_conversation.event" &&
            event.payload.kind === "status" &&
            event.payload.error === "acp_conversation_host_interrupted"
        )
    ).toBe(false);
    completion.resolve(success);
    await service.stop();
  });

  it("retains failed cleanup as durable session exclusion after restart", async () => {
    const f = await setup();
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(async () => ({
      terminal: { state: "cancelled", message: "Cancelled by caller." },
      cleanup: { attempted: true, completed: false }
    }));
    const service = new RemoteAcpConversationService(f.state.conversations, { converse });
    f.receive(f.command);
    service.handle(f.command);
    await service.stop();
    expect(service.isSessionActive(f.command.sessionId)).toBe(true);
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: f.command.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_cleanup_failed" }
      })
    );
    f.state.close();
    const reopened = await openAgentHostState(join(f.directory, "state.sqlite"));
    fixtures.find((fixture) => fixture.directory === f.directory)!.state = reopened;
    const restored = new RemoteAcpConversationService(reopened.conversations, { converse });
    const next = { ...f.command, turnId: "turn-after-unsafe" };
    reopened.receive({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      messageId: "message-2",
      previousSequence: 1,
      sequence: 2,
      command: next
    });
    restored.handle(next);
    expect(() => restored.handle(f.command)).not.toThrow();
    expect(() => restored.handle(next)).not.toThrow();
    expect(converse).toHaveBeenCalledTimes(1);
    expect(reopened.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: next.turnId,
        payload: {
          kind: "status",
          status: "failed",
          error: "acp_conversation_session_cleanup_unverified"
        }
      })
    );
    await restored.stop();
  });

  it("keeps ownership during stop and treats a throwing executor as unverified cleanup", async () => {
    const f = await setup();
    const pending = deferred<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>();
    let rejectExecution!: (error: Error) => void;
    const completion = new Promise<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>(
      (resolve, reject) => {
        pending.promise.then(resolve);
        rejectExecution = reject;
      }
    );
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(async () => completion);
    const service = new RemoteAcpConversationService(f.state.conversations, { converse });
    f.receive(f.command);
    service.handle(f.command);
    await flush();
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(service.isSessionActive(f.command.sessionId)).toBe(true);
    rejectExecution(new Error("cleanup_transport_broke"));
    await stopping;
    expect(service.isSessionActive(f.command.sessionId)).toBe(true);
    expect(f.state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        turnId: f.command.turnId,
        payload: { kind: "status", status: "failed", error: "acp_conversation_cleanup_failed" }
      })
    );
  });

  it("surfaces terminal persistence failure and does not start queued work", async () => {
    const f = await setup();
    const first = deferred<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>();
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(async (command) =>
      command.turnId === f.command.turnId ? first.promise : success
    );
    const repository = f.state.conversations;
    const append = repository.append.bind(repository);
    vi.spyOn(repository, "append").mockImplementation((turnId, payload) => {
      if (
        turnId === f.command.turnId &&
        payload.kind === "status" &&
        payload.status === "completed"
      )
        throw new Error("disk_write_failed");
      append(turnId, payload);
    });
    const service = new RemoteAcpConversationService(repository, { converse });
    const next = { ...f.command, turnId: "turn-after-write-failure" };
    f.receive(f.command);
    service.handle(f.command);
    f.receive(next);
    service.handle(next);
    first.resolve(success);
    await flush();
    await expect(service.stop()).rejects.toThrow("disk_write_failed");
    expect(converse).toHaveBeenCalledTimes(1);
  });

  it("projects exact permission kinds and returns the selected original option ID", async () => {
    const f = await setup();
    const options = [
      { optionId: "first-once", label: "Once", kind: "allow_once" as const },
      { optionId: "other-once", label: "Once too", kind: "allow_once" as const },
      { optionId: "always", label: "Always", kind: "allow_always" as const },
      { optionId: "reject", label: "Reject", kind: "reject_once" as const },
      { optionId: "reject-always", label: "Always reject", kind: "reject_always" as const }
    ];
    const selected = vi.fn();
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(
      async (_command, broker, _sink, signal) => {
        selected(
          await broker.requestPermission(
            {
              requestId: "follow-up-permission",
              sessionId: f.command.sessionId,
              toolCallId: "tool",
              summary: "Allow follow-up tool",
              options
            },
            { signal, deadline: new Date(f.command.expiresAt) }
          )
        );
        return {
          terminal: { state: "succeeded", stopReason: "end_turn" },
          cleanup: { attempted: true, completed: true }
        };
      }
    );
    const service = new RemoteAcpConversationService(f.state.conversations, { converse });
    f.receive(f.command);
    service.handle(f.command);
    try {
      expect(f.state.pendingEvents()).toContainEqual(
        expect.objectContaining({
          type: "acp_conversation.event",
          payload: {
            kind: "interaction",
            request: {
              kind: "permission",
              requestId: "follow-up-permission",
              summary: "Allow follow-up tool",
              deadline: f.command.expiresAt,
              options: [
                { optionId: "first-once", label: "Once", decision: "approve" },
                { optionId: "other-once", label: "Once too", decision: "approve" },
                { optionId: "always", label: "Always", decision: "approve" },
                { optionId: "reject", label: "Reject", decision: "deny" },
                { optionId: "reject-always", label: "Always reject", decision: "deny" }
              ]
            }
          }
        })
      );
      const { sourceEnvelope: _source, text: _text, expiresAt: _expiry, ...identity } = f.command;
      const response = {
        ...identity,
        type: "acp_conversation.respond" as const,
        requestId: "follow-up-permission",
        decision: { kind: "permission" as const, optionId: "other-once" }
      };
      f.receive(response);
      service.handle(response);
      await vi.waitFor(() =>
        expect(selected).toHaveBeenCalledWith({ kind: "select", optionId: "other-once" })
      );
      expect(f.state.pendingEvents()).toContainEqual(
        expect.objectContaining({
          type: "acp_conversation.event",
          payload: { kind: "status", status: "completed", error: null }
        })
      );
    } finally {
      await service.stop();
    }
  });
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
        new Promise<Awaited<ReturnType<RemoteAcpExecutor["converse"]>>>((resolve) =>
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                terminal: { state: "cancelled", message: "Cancelled by caller." },
                cleanup: { attempted: true, completed: true }
              }),
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
