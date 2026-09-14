import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleExecuteDelivery,
  historicalHostEventSchema,
  hostHelloSchema,
  serverEventSchema,
  type DispatchResult,
  type HistoricalHostEvent,
  type ServerEvent
} from "@planweave-ai/agent-host-protocol";
import { expect, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgentHostExecuteCommand,
  AgentHostExecutionContext
} from "../../execution/agentHostExecutor.js";
import { openAgentHostState } from "../../state/agentHostState.js";
import { openAgentHostDatabase } from "../../state/sqliteDatabase.js";
import { AgentHostClient } from "../../transport/agentHostClient.js";
import type { HostTransportClock } from "../../transport/hostTransport.js";
import { remoteRunnerEventV2Request } from "./remoteRunnerEventCapabilityTestValues.js";

export const LEASE_START = Date.parse("2030-01-01T00:00:00.000Z");
export const completedResult: DispatchResult = {
  summary: "Lease execution completed.",
  reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
  artifactRefs: []
};

export class FakeLeaseClock implements HostTransportClock {
  private time = LEASE_START;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): Date {
    return new Date(this.time);
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(timer: unknown): void {
    if (typeof timer === "number") this.timers.delete(timer);
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  callbacks(): Array<() => void> {
    return [...this.timers.values()].map(({ callback }) => callback);
  }

  jumpBy(milliseconds: number): void {
    this.time += milliseconds;
  }

  advanceBy(milliseconds: number): void {
    const target = this.time + milliseconds;
    for (let count = 0; count < 10_000; count += 1) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) {
        this.time = target;
        return;
      }
      this.time = Math.max(this.time, next[1].at);
      this.timers.delete(next[0]);
      next[1].callback();
    }
    throw new Error("lease_test_clock_runaway");
  }
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function leaseDelivery(expiresAfterMs = 1_000): typeof exampleExecuteDelivery {
  return {
    ...exampleExecuteDelivery,
    command: {
      ...exampleExecuteDelivery.command,
      leaseExpiresAt: new Date(LEASE_START + expiresAfterMs).toISOString()
    }
  };
}

export function renewal(
  expiresAfterMs: number,
  identity: Partial<{
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
  }> = {}
): ServerEvent {
  const { dispatchId, leaseId, executionAttemptId } = exampleExecuteDelivery.command;
  return serverEventSchema.parse({
    type: "lease.renewed",
    protocolVersion: 1,
    dispatchId,
    leaseId,
    executionAttemptId,
    ...identity,
    leaseExpiresAt: new Date(LEASE_START + expiresAfterMs).toISOString()
  });
}

export function resumeDelivery(expiresAfterMs = 5_000): ServerEvent {
  return serverEventSchema.parse({
    type: "mailbox.message",
    protocolVersion: 1,
    sequence: 2,
    previousSequence: 1,
    messageId: "mailbox-lease-resume-2",
    command: {
      type: "resume_execution",
      protocolVersion: 1,
      dispatchId: exampleExecuteDelivery.command.dispatchId,
      leaseId: "lease-resumed-2",
      executionAttemptId: exampleExecuteDelivery.command.executionAttemptId,
      priorRecovery: { acpSessionId: "lease-session-1", recoveryId: "lease-recovery-1" },
      leaseExpiresAt: new Date(LEASE_START + expiresAfterMs).toISOString()
    }
  });
}

export async function leaseHarness(
  options: { abortSettles?: boolean; reconnectDelayMs?: number; expectStopFailure?: string } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-host-lease-"));
  const path = join(directory, "host.sqlite");
  const state = await openAgentHostState(path);
  const database = await openAgentHostDatabase(path, 1_000);
  const server = createServer();
  const websocketServer = new WebSocketServer({ server });
  const sockets: WebSocket[] = [];
  const events: HistoricalHostEvent[] = [];
  const protocolErrors: unknown[] = [];
  const clock = new FakeLeaseClock();
  const runs: Array<{
    context: AgentHostExecutionContext;
    result: ReturnType<typeof deferred<DispatchResult>>;
    abortCount: number;
  }> = [];
  let serverOffsetMs = 0;
  const send = (event: ServerEvent) => {
    const socket = sockets.at(-1);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("lease_socket_not_open");
    socket.send(JSON.stringify(serverEventSchema.parse(event)));
  };
  websocketServer.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      try {
        const raw: unknown = JSON.parse(data.toString());
        const hello = hostHelloSchema.safeParse(raw);
        if (hello.success) {
          send(
            serverEventSchema.parse({
              type: "host.welcome",
              protocolVersion: 1,
              exactPermissionOptionsVersion: 1,
              serverTime: new Date(clock.now().getTime() + serverOffsetMs).toISOString(),
              heartbeatIntervalMs: 60_000,
              leaseDurationMs: 60_000
            })
          );
        } else {
          events.push(historicalHostEventSchema.parse(raw));
        }
      } catch (error) {
        protocolErrors.push(error);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("lease_http_port_required");
  const execute = vi.fn((_command: AgentHostExecuteCommand, context: AgentHostExecutionContext) => {
    const result = deferred<DispatchResult>();
    const run = { context, result, abortCount: 0 };
    runs.push(run);
    context.signal.addEventListener(
      "abort",
      () => {
        run.abortCount += 1;
        if (options.abortSettles !== false) result.reject(new Error("lease_executor_aborted"));
      },
      { once: true }
    );
    return result.promise;
  });
  const client = new AgentHostClient({
    serverUrl: `http://127.0.0.1:${address.port}`,
    hostId: "host-lease-test",
    token: "host-lease-test-token",
    capabilities: ["test"],
    capacity: 1,
    readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
    state,
    executor: { execute },
    request: remoteRunnerEventV2Request,
    allowInsecureTransport: true,
    clock,
    reconnect: { initialDelayMs: options.reconnectDelayMs ?? 60_000, maxDelayMs: 60_000 },
    random: () => 0.5,
    limits: { shutdownTimeoutMs: 100 }
  });
  client.start();
  await vi.waitFor(() => expect(client.status().state).toBe("connected"));
  clock.advanceBy(0);
  return {
    state,
    database,
    clock,
    client,
    runs,
    execute,
    events,
    send,
    setServerOffset(milliseconds: number) {
      serverOffsetMs = milliseconds;
    },
    async disconnect(code = 1012) {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("lease_socket_missing");
      socket.close(code, "lease transport test");
      await vi.waitFor(() => expect(client.status().state).not.toBe("connected"));
    },
    async startExecution(expiresAfterMs = 1_000) {
      send(leaseDelivery(expiresAfterMs));
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      return runs[0]!;
    },
    async close() {
      for (const run of runs) run.result.resolve(completedResult);
      if (options.expectStopFailure) {
        await expect(client.stop()).rejects.toThrow(options.expectStopFailure);
      } else {
        await client.stop();
      }
      database.close();
      state.close();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        websocketServer.close((error) => (error ? reject(error) : resolve()))
      );
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(directory, { recursive: true, force: true });
      expect(protocolErrors).toEqual([]);
    }
  };
}

export type LeaseHarness = Awaited<ReturnType<typeof leaseHarness>>;
