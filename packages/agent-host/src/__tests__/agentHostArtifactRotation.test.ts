import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import type { ActiveHostCredential } from "../credentials/credentialContract.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  false,
  true
])("aligns a restarted connection with committed authority after a stale renewal completion (remainStopped=%s)", async (remainStopped) => {
  const directory = await mkdtemp(join(tmpdir(), "planweave-renewal-stop-"));
  const state = await openAgentHostState(join(directory, "host.sqlite"));
  const pending = deferred<ActiveHostCredential>();
  const welcomes = [deferred<void>(), deferred<void>(), deferred<void>()];
  const initialToken = `pw_host_${randomBytes(32).toString("base64url")}`;
  const nextToken = `pw_host_${randomBytes(32).toString("base64url")}`;
  const authorization: Array<string | undefined> = [];
  let pollCount = 0;
  let authority = initialToken;
  const http = createServer();
  const sockets = new WebSocketServer({ server: http });
  sockets.on("connection", (socket, request) => {
    const index = authorization.length;
    authorization.push(request.headers.authorization);
    socket.on("message", (data) => {
      const raw = JSON.parse(data.toString());
      if (raw.type === "host.hello") {
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
        welcomes[index]?.resolve();
      } else if (raw.messageId) {
        socket.send(
          JSON.stringify({ type: "host.event_ack", protocolVersion: 1, messageId: raw.messageId })
        );
      }
    });
  });
  let client: AgentHostClient | undefined;
  try {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("expected_port");
    client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: "host-stop-test",
      token: initialToken,
      capabilities: ["test"],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      state,
      request: remoteRunnerEventV2Request,
      allowInsecureTransport: true,
      executor: {
        execute: async () => {
          throw new Error("unexpected_execution");
        }
      },
      credentialRenewal: {
        poll: () => (pollCount++ === 0 ? pending.promise : Promise.resolve(undefined)),
        readActiveCredential: async () => ({
          hostId: "host-stop-test",
          credentialToken: authority,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString()
        })
      }
    });
    client.start();
    await welcomes[0]!.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    let stopped = false;
    const stopping = client.stop().then(() => {
      stopped = true;
    });
    if (!remainStopped) client.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    authority = nextToken;
    pending.resolve({
      hostId: "host-stop-test",
      credentialToken: initialToken,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    });
    await pending.promise;
    await stopping;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (remainStopped) {
      expect(authorization).toHaveLength(1);
      client.start();
      await welcomes[1]!.promise;
    } else await welcomes[1]!.promise;
    expect(authorization).toEqual([`Bearer ${initialToken}`, `Bearer ${nextToken}`]);
  } finally {
    pending.resolve({
      hostId: "host-stop-test",
      credentialToken: authority,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    });
    await client?.stop();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
