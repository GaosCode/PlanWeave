import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostHelloSchema, serverEventSchema } from "@planweave-ai/agent-host-protocol";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { composeAgentHost } from "../composition/agentHostComposition.js";
import { openAgentHostState } from "../state/agentHostState.js";
import {
  FakeLeaseClock,
  leaseDelivery,
  leaseHarness
} from "./support/agentHostLeaseExpiryHarness.js";
import { deferred, HostTransportSocketHarness } from "./support/hostTransportSocketHarness.js";
import { remoteRunnerEventV2Capability } from "./support/remoteRunnerEventCapabilityTestValues.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function success() {
  return Response.json({ remoteRunnerEvents: remoteRunnerEventV2Capability });
}

async function setup(
  request: typeof fetch,
  options: { welcome?: boolean; random?: () => number } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-host-startup-"));
  const state = await openAgentHostState(join(directory, "host.sqlite"));
  const server = await HostTransportSocketHarness.open();
  const clock = new FakeLeaseClock();
  const canvasRuntime = {
    enabled: () => true,
    disconnect: vi.fn(),
    handle: vi.fn(),
    recover: vi.fn(),
    synchronizeServerTime: vi.fn(),
    updateCredentialToken: vi.fn()
  };
  const conversations = {
    handle: vi.fn(),
    recover: vi.fn(),
    stop: vi.fn(async () => {}),
    isSessionActive: () => false
  };
  const recover = vi.spyOn(state, "recoverInterruptedExecutions");
  const setVersion = vi.spyOn(state, "setRemoteRunnerEventProtocolVersion");
  const connection = vi.fn();
  const sendWelcome = () => {
    for (const socket of server.sockets)
      socket.send(
        JSON.stringify(
          serverEventSchema.parse({
            type: "host.welcome",
            protocolVersion: 1,
            exactPermissionOptionsVersion: 1,
            serverTime: clock.now().toISOString(),
            heartbeatIntervalMs: 60_000,
            leaseDurationMs: 60_000
          })
        )
      );
  };
  server.webSocketServer.on("connection", (socket) => {
    connection();
    socket.on("message", (data) => {
      if (
        hostHelloSchema.safeParse(JSON.parse(data.toString())).success &&
        options.welcome !== false
      )
        sendWelcome();
    });
  });
  const client = new AgentHostClient({
    serverUrl: server.serverUrl,
    hostId: "host-startup-test",
    token: "test-token",
    allowInsecureTransport: true,
    capabilities: ["test"],
    capacity: 1,
    readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
    state,
    executor: { execute: vi.fn() },
    canvasRuntime,
    conversations,
    request,
    clock,
    random: options.random ?? (() => 0.5)
  });
  cleanups.push(async () => {
    await client.stop();
    await server.close();
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    state,
    server,
    clock,
    client,
    canvasRuntime,
    conversations,
    recover,
    setVersion,
    connection,
    sendWelcome
  };
}

describe("Agent Host startup discovery lifecycle", () => {
  it("recovers from 503 through one composition start and defers execution recovery until exact welcome", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () => success());
    const h = await setup(request, { welcome: false });
    const composition = composeAgentHost({ state: { close() {} }, transport: h.client });
    await composition.start();
    await composition.start();
    await vi.waitFor(() => expect(h.client.status().state).toBe("backing-off"));
    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.canvasRuntime.recover).not.toHaveBeenCalled();
    expect(h.conversations.recover).not.toHaveBeenCalled();
    expect(h.clock.pendingTimerCount()).toBe(1);
    h.clock.advanceBy(187);
    await vi.waitFor(() => expect(h.connection).toHaveBeenCalledOnce());
    expect(h.conversations.recover).not.toHaveBeenCalled();
    h.sendWelcome();
    await vi.waitFor(() => expect(h.client.status().state).toBe("connected"));
    h.sendWelcome();
    await vi.waitFor(() => expect(h.canvasRuntime.synchronizeServerTime).toHaveBeenCalledTimes(2));
    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.canvasRuntime.recover).toHaveBeenCalledOnce();
    expect(h.conversations.recover).toHaveBeenCalledOnce();
    expect(h.setVersion).toHaveBeenCalledExactlyOnceWith(2);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps repeated network failures serial with equal jitter and a 30 second ceiling", async () => {
    let remainingFailures = 12;
    let inFlight = 0;
    let highWater = 0;
    const request = vi.fn<typeof fetch>(async () => {
      inFlight++;
      highWater = Math.max(highWater, inFlight);
      await Promise.resolve();
      inFlight--;
      if (remainingFailures-- > 0)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("network"), { code: "ECONNRESET" })
        });
      return success();
    });
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.999).mockReturnValue(0.5);
    const h = await setup(request, { random });
    h.client.start();
    for (let attempt = 1; attempt <= 12; attempt++) {
      await vi.waitFor(() =>
        expect(h.client.status()).toMatchObject({ state: "backing-off", attempt })
      );
      const status = h.client.status();
      if (status.state !== "backing-off") throw new Error("expected_backoff");
      const cap = Math.min(30_000, 250 * 2 ** (attempt - 1));
      expect(status.delayMs).toBeGreaterThanOrEqual(Math.floor(cap / 2));
      expect(status.delayMs).toBeLessThanOrEqual(cap);
      expect(status.delayMs).toBe(
        attempt === 1 ? 125 : attempt === 2 ? 499 : Math.floor(cap * 0.75)
      );
      expect(h.clock.pendingTimerCount()).toBe(1);
      h.clock.advanceBy(status.delayMs);
    }
    await vi.waitFor(() => expect(h.client.status().state).toBe("connected"));
    expect(highWater).toBe(1);
    expect(h.connection).toHaveBeenCalledOnce();
    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.conversations.recover).toHaveBeenCalledOnce();
  });

  it.each([
    "30",
    "999999",
    "invalid"
  ])("bounds Retry-After %s before automatic recovery", async (retryAfter) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "retry-after": retryAfter } })
      )
      .mockImplementation(async () => success());
    const h = await setup(request);
    h.client.start();
    await vi.waitFor(() => expect(h.client.status().state).toBe("backing-off"));
    const delayMs = retryAfter === "invalid" ? 187 : 30_000;
    expect(h.client.status()).toMatchObject({ delayMs });
    h.clock.advanceBy(delayMs);
    await vi.waitFor(() => expect(h.client.status().state).toBe("connected"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    401, 403, 404, 501
  ])("terminates HTTP %s without retry or socket creation", async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status }));
    const h = await setup(request);
    h.client.start();
    await vi.waitFor(() =>
      expect(h.client.status().state).toBe(
        status === 401 || status === 403 ? "auth-failed" : "degraded"
      )
    );
    h.clock.advanceBy(60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(h.connection).not.toHaveBeenCalled();
    expect(h.clock.pendingTimerCount()).toBe(0);
  });

  it.each([
    "{",
    "null",
    "[]",
    "{}",
    '{"remoteRunnerEvents":{"available":false}}'
  ])("terminates invalid protocol body %s", async (body) => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body));
    const h = await setup(request);
    h.client.start();
    await vi.waitFor(() => expect(h.client.status().state).toBe("degraded"));
    h.clock.advanceBy(60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(h.connection).not.toHaveBeenCalled();
    expect(h.setVersion).not.toHaveBeenCalled();
  });

  it("exposes local state write failure without HTTP retry or reporting a Server failure", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => success());
    const h = await setup(request);
    h.setVersion.mockImplementation(() => {
      throw new Error("local_database_write_failed");
    });
    h.client.start();
    await vi.waitFor(() =>
      expect(h.client.status()).toEqual({
        state: "reconciliation-required",
        reason: "startup_local_state_failed"
      })
    );
    h.clock.advanceBy(60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(h.connection).not.toHaveBeenCalled();
  });

  it("cancels a queued retry and ignores its callback after stop", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 503 }));
    const h = await setup(request);
    h.client.start();
    await vi.waitFor(() => expect(h.client.status().state).toBe("backing-off"));
    const callbacks = h.clock.callbacks();
    await h.client.stop();
    for (const callback of callbacks) callback();
    h.clock.advanceBy(60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(h.clock.pendingTimerCount()).toBe(0);
    expect(h.client.status()).toEqual({ state: "stopped" });
  });

  it.each([
    "connecting",
    "backing-off"
  ])("honors stop called by a %s status listener before creating resources", async (phase) => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        phase === "connecting" ? success() : new Response(null, { status: 503 })
      );
    const h = await setup(request);
    let stopped: Promise<void> | undefined;
    h.client.subscribe((status) => {
      if (status.state === phase) stopped = h.client.stop();
    });
    h.client.start();
    await vi.waitFor(() => expect(stopped).toBeDefined());
    await stopped;
    expect(h.clock.pendingTimerCount()).toBe(0);
    expect(h.client.status()).toEqual({ state: "stopped" });
    expect(h.connection).not.toHaveBeenCalled();
  });

  it("ignores an old retry callback while a new generation owns its retry timer", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 503 }));
    const h = await setup(request);
    h.client.start();
    await vi.waitFor(() => expect(h.client.status().state).toBe("backing-off"));
    const oldCallbacks = h.clock.callbacks();
    await h.client.stop();
    h.client.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.client.status().state).toBe("backing-off"));
    for (const callback of oldCallbacks) callback();
    expect(h.clock.pendingTimerCount()).toBe(1);
    await h.client.stop();
    expect(h.clock.pendingTimerCount()).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("serializes rapid start-stop-start and fences late responses from the cancelled generation", async () => {
    const oldResponse = deferred<Response>();
    const aborted = vi.fn();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((resolve, reject) => {
            const onAbort = () => {
              init?.signal?.removeEventListener("abort", onAbort);
              aborted();
              reject(new DOMException("cancelled", "AbortError"));
            };
            init?.signal?.addEventListener("abort", onAbort);
            oldResponse.promise.then(resolve, reject);
          })
      )
      .mockImplementation(async () => success());
    const h = await setup(request);
    h.client.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const stopped = h.client.stop();
    h.client.start();
    await stopped;
    await vi.waitFor(() => expect(h.client.status().state).toBe("connected"));
    oldResponse.resolve(new Response("null"));
    await Promise.resolve();
    expect(aborted).toHaveBeenCalledOnce();
    expect(h.connection).toHaveBeenCalledOnce();
    expect(h.setVersion).toHaveBeenCalledExactlyOnceWith(2);
    expect(h.recover).toHaveBeenCalledTimes(2);
    expect(h.conversations.recover).toHaveBeenCalledOnce();
    expect(h.client.status().state).toBe("connected");
  });

  it.each([
    "timeout",
    "stop"
  ])("cancels a real HTTP response body on %s and releases it before any retry", async (action) => {
    const h = await setup(fetch);
    let hang = true;
    const headersSent = vi.fn();
    const responseClosed = vi.fn();
    h.server.httpServer.on("request", (_request, response) => {
      if (hang) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"remoteRunnerEvents":');
        response.once("close", responseClosed);
        headersSent();
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ remoteRunnerEvents: remoteRunnerEventV2Capability }));
      }
    });
    h.client.start();
    await vi.waitFor(() => expect(headersSent).toHaveBeenCalledOnce());
    if (action === "timeout") {
      h.clock.advanceBy(10_000);
      await vi.waitFor(() => expect(h.client.status().state).toBe("backing-off"));
      await vi.waitFor(() => expect(responseClosed).toHaveBeenCalledOnce());
      expect(h.clock.pendingTimerCount()).toBe(1);
      hang = false;
      h.clock.advanceBy(187);
      await vi.waitFor(() => expect(h.client.status().state).toBe("connected"));
      expect(h.connection).toHaveBeenCalledOnce();
    } else {
      await h.client.stop();
      await vi.waitFor(() => expect(responseClosed).toHaveBeenCalledOnce());
      expect(h.clock.pendingTimerCount()).toBe(0);
      expect(h.connection).not.toHaveBeenCalled();
    }
  });

  it("preserves restart recovery of persisted executions while startup is backing off", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(null, { status: 503, headers: { "retry-after": "30" } })
      );
    const h = await setup(request);
    h.state.receive(leaseDelivery());
    h.client.start();
    await vi.waitFor(() => expect(h.client.status().state).toBe("backing-off"));
    h.clock.advanceBy(1_000);
    expect(h.state.executionEvidence(1)?.status).toBe("interrupted");
    expect(
      h.state.pendingEvents().filter((event) => event.type === "dispatch.interrupted")
    ).toEqual([expect.objectContaining({ reason: "host_restart" })]);
    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.connection).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it("checks a running lease after wall-clock jump during socket reconnect backoff", async () => {
    const h = await leaseHarness({ reconnectDelayMs: 5_000 });
    cleanups.push(() => h.close());
    const run = await h.startExecution();
    await h.disconnect();
    h.clock.jumpBy(1_001);
    expect(run.context.signal.aborted).toBe(false);
    h.clock.advanceBy(0);
    await vi.waitFor(() => expect(run.context.signal.aborted).toBe(true));
    expect(h.state.executionEvidence(1)).toMatchObject({
      status: "interrupted",
      recoveryIntent: { kind: "lease_lost" }
    });
    expect(h.client.status().state).toBe("backing-off");
    expect(h.execute).toHaveBeenCalledOnce();
  });
});
