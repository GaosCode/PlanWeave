import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostCredentialRenewal } from "../credentials/credentialRenewal.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { remoteRunnerEventV2Capability } from "./support/remoteRunnerEventCapabilityTestValues.js";
import { FakeHostTransportClock } from "./support/hostTransportTestClock.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(heldMethod: "GET" | "POST", clock?: FakeHostTransportClock) {
  const root = await mkdtemp(join(tmpdir(), "pw-host-renewal-stop-"));
  const directory = join(root, "credentials");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "host.json");
  const active = {
    hostId: "host-renewal-shutdown",
    credentialToken: `pw_host_${"a".repeat(43)}`,
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-06-30T00:00:00.000Z",
    credentialPolicy: { lifetimeDays: 180, renewal: "automatic" as const }
  };
  await writeFile(path, JSON.stringify({ version: "agent-host-credentials/v1", active }), {
    mode: 0o600
  });
  const store = new FileHostCredentialStore(path);
  const state = await openAgentHostState(join(root, "state.sqlite"));
  const held = deferred<void>();
  const responses: ServerResponse[] = [];
  let complete = false;
  let peerClosed = 0;
  let now = new Date("2030-01-02T00:00:00.000Z");
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    if (request.url === "/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ remoteRunnerEvents: remoteRunnerEventV2Capability }));
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", async () => {
      response.writeHead(200, { "content-type": "application/json" });
      if (!complete && request.method === heldMethod) {
        responses.push(response);
        response.on("close", () => {
          peerClosed += 1;
        });
        response.flushHeaders();
        held.resolve();
        return;
      }
      const current = await store.requireUsable(now);
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? {
                hostId: active.hostId,
                serverTime: now.toISOString(),
                credentialExpiresAt: current.expiresAt,
                policy: active.credentialPolicy,
                ...(current.credentialToken === active.credentialToken
                  ? { renewalRequestedAt: now.toISOString() }
                  : {})
              }
            : {
                hostId: active.hostId,
                rotationId: JSON.parse(body).rotationId,
                credentialExpiresAt: "2030-07-01T00:00:00.000Z"
              }
        )
      );
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    authorizations.push(request.headers.authorization);
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "host.hello")
        socket.send(
          JSON.stringify({
            type: "host.welcome",
            protocolVersion: 1,
            exactPermissionOptionsVersion: 1,
            serverTime: new Date().toISOString(),
            heartbeatIntervalMs: 60000,
            leaseDurationMs: 60000
          })
        );
      else if (event.messageId)
        socket.send(
          JSON.stringify({ type: "host.event_ack", protocolVersion: 1, messageId: event.messageId })
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const renewal = new AgentHostCredentialRenewal(origin, store, { clock: () => now });
  const client = new AgentHostClient({
    serverUrl: origin,
    hostId: active.hostId,
    token: active.credentialToken,
    capabilities: ["test"],
    readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
    capacity: 1,
    state,
    allowInsecureTransport: true,
    request: fetch,
    credentialRenewal: renewal,
    clock,
    limits: { shutdownTimeoutMs: 100 },
    reconnect: { initialDelayMs: 1, maxDelayMs: 1 },
    executor: {
      execute: async () => {
        throw new Error("Unexpected execution.");
      }
    }
  });
  cleanups.push(async () => {
    for (const response of responses) response.destroy();
    await client.stop();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    client,
    store,
    active,
    held,
    authorizations,
    peerClosed: () => peerClosed,
    resume: () => {
      complete = true;
    },
    nextPoll: () => {
      now = new Date(now.getTime() + 30001);
    }
  };
}

describe("Host credential HTTP cancellation and shutdown authority", () => {
  it.each([
    "GET",
    "POST"
  ] as const)("drains the %s body and allows repeated start/stop and a fresh token on restart", async (method) => {
    const f = await fixture(method);
    f.client.start();
    f.client.start();
    await f.held.promise;
    expect(f.authorizations).toEqual([`Bearer ${f.active.credentialToken}`]);
    await Promise.all([f.client.stop(), f.client.stop()]);
    await vi.waitFor(() => expect(f.peerClosed()).toBe(1));
    expect(f.client.status().state).toBe("stopped");
    expect((await f.store.read())?.active).toEqual(f.active);
    f.resume();
    f.client.start();
    f.client.start();
    await vi.waitFor(async () => {
      const current = await f.store.requireUsable(new Date("2030-01-02T00:00:00.000Z"));
      expect(current.credentialToken).not.toBe(f.active.credentialToken);
      expect(f.authorizations.at(-1)).toBe(`Bearer ${current.credentialToken}`);
      expect(f.client.status().state).toBe("connected");
    });
    const count = f.authorizations.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.authorizations).toHaveLength(count);
    await f.client.stop();
  });

  it("waits for an entered credential commit and queues restart behind its durable authority", async () => {
    const f = await fixture("POST");
    f.resume();
    const committed = deferred<void>();
    const release = deferred<void>();
    releases.push(() => release.resolve());
    const original = f.store.commitRotation.bind(f.store);
    vi.spyOn(f.store, "commitRotation").mockImplementationOnce(async (response, now) => {
      const current = await original(response, now);
      committed.resolve();
      await release.promise;
      return current;
    });
    f.client.start();
    await committed.promise;
    const authority = (await f.store.read())!.active!;
    expect(authority.credentialToken).not.toBe(f.active.credentialToken);
    let stopped = false;
    const stopping = f.client.stop().then(() => {
      stopped = true;
    });
    f.client.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(f.authorizations).toHaveLength(1);
    release.resolve();
    await stopping;
    await vi.waitFor(() =>
      expect(f.authorizations.at(-1)).toBe(`Bearer ${authority.credentialToken}`)
    );
    await vi.waitFor(() => expect(f.client.status().state).toBe("connected"));
    expect(await f.store.requireUsable(new Date("2030-01-02T00:00:00.000Z"))).toEqual(authority);
    expect(f.authorizations).toHaveLength(2);
  });
  it("rejects shutdown on an entered credential persistence failure rather than swallowing it as cancellation", async () => {
    const f = await fixture("POST");
    f.resume();
    const entered = deferred<void>();
    const release = deferred<void>();
    releases.push(() => release.resolve());
    vi.spyOn(f.store, "commitRotation").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("agent_host_credential_commit_durability_failed");
    });
    f.client.start();
    await entered.promise;
    const stopping = f.client.stop();
    const rejected = expect(stopping).rejects.toThrow(
      "agent_host_credential_commit_durability_failed"
    );
    release.resolve();
    await rejected;
    expect((await f.store.read())?.active).toEqual(f.active);
    expect(f.client.status().state).toBe("reconciliation-required");
    await f.client.stop();
  });

  it("reports the bounded stop deadline without acknowledging a still-pending credential commit", async () => {
    const clock = new FakeHostTransportClock();
    const f = await fixture("POST", clock);
    f.resume();
    const entered = deferred<void>();
    const release = deferred<void>();
    releases.push(() => release.resolve());
    const original = f.store.commitRotation.bind(f.store);
    vi.spyOn(f.store, "commitRotation").mockImplementationOnce(async (response, now) => {
      entered.resolve();
      await release.promise;
      return original(response, now);
    });
    f.client.start();
    await entered.promise;
    const stopping = f.client.stop();
    const rejected = expect(stopping).rejects.toThrow("agent_host_transport_shutdown_timeout");
    await vi.waitFor(() => expect(clock.nextDelay()).toBe(100));
    clock.advanceBy(100);
    await rejected;
    expect((await f.store.read())?.active).toEqual(f.active);
    release.resolve();
    await vi.waitFor(async () => expect((await f.store.read())?.rotation).toBeUndefined());
    await f.client.stop();
  });
  it("drains an entered rotation preparation and never sends its POST after cancellation", async () => {
    const f = await fixture("POST");
    f.resume();
    const prepared = deferred<void>();
    const release = deferred<void>();
    releases.push(() => release.resolve());
    const original = f.store.beginRotation.bind(f.store);
    vi.spyOn(f.store, "beginRotation").mockImplementationOnce(async (rotation) => {
      await original(rotation);
      prepared.resolve();
      await release.promise;
    });
    f.client.start();
    await prepared.promise;
    const pending = (await f.store.read())!.rotation!;
    let stopped = false;
    const stopping = f.client.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    expect(f.peerClosed()).toBe(0);
    expect((await f.store.read())?.rotation).toEqual(pending);
    f.client.start();
    await vi.waitFor(async () =>
      expect((await f.store.read())?.active?.credentialToken).toBe(pending.credentialToken)
    );
    await vi.waitFor(() =>
      expect(f.authorizations.at(-1)).toBe(`Bearer ${pending.credentialToken}`)
    );
  });
});
