import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import {
  exampleExecuteDelivery,
  HOST_CREDENTIAL_PREVIOUS_TOKEN_GRACE_MS,
  hostEventSchema,
  serverEventSchema
} from "@planweave-ai/agent-host-protocol";
import { AgentHostRepository } from "../src/hosts.js";
import { startPlanweaveServer } from "../src/lifecycle.js";
import { authenticateAgentHostRequest } from "../src/hostTransportAuth.js";
import { createTransportAdmissionPolicyForMode } from "../src/insecureTransport.js";
import {
  AgentHostClient,
  openAgentHostState,
  type ActiveHostCredential,
  type AgentHostExecutionContext
} from "../../agent-host/src/index.js";

const remoteRunnerEventV2Request: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname !== "/version") return fetch(input, init);
  return new Response(
    JSON.stringify({
      remoteRunnerEvents: {
        available: true,
        acceptedVersions: [2],
        preferredVersion: 2,
        v1Accepted: 0,
        v2Accepted: 0,
        v1Degraded: 0,
        usageSnapshotsAccepted: 0,
        usageSnapshotRegressions: 0
      }
    }),
    { headers: { "content-type": "application/json" } }
  );
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("delivers the original execution report after two real credential rotations, including a lost PUT response", async () => {
  if (
    exampleExecuteDelivery.type !== "mailbox.message" ||
    exampleExecuteDelivery.command.type !== "execute_block"
  ) {
    throw new Error("expected_execute_fixture");
  }
  const executeCommand = exampleExecuteDelivery.command;
  const directory = await mkdtemp(join(tmpdir(), "planweave-artifact-rotation-"));
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  const state = await openAgentHostState(join(directory, "host.sqlite"));
  let credentialNow = new Date();
  const hosts = new AgentHostRepository(server.database, () => credentialNow);
  const tokens = Array.from(
    { length: 3 },
    () => `pw_host_${randomBytes(32).toString("base64url")}`
  );
  const registration = hosts.registerWithCredential(
    "Rotation test",
    tokens[0]!,
    ["test"],
    1,
    new Date(credentialNow.getTime() + 86400000).toISOString(),
    { lifetimeDays: 30, renewal: "automatic" }
  );
  const hostId = registration.host.id;
  const admission = createTransportAdmissionPolicyForMode("loopback_http");
  const rotations = [deferred<ActiveHostCredential>(), deferred<ActiveHostCredential>()];
  const connected = [deferred<void>(), deferred<void>(), deferred<void>()];
  const executing = deferred<AgentHostExecutionContext>();
  const finish = deferred<void>();
  const completed = deferred<unknown>();
  const input = Buffer.from("verified execution input");
  const report = Buffer.from("# Completed after rotation");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const inputRef = `artifact:sha256:${digest(input)}` as const;
  const reportRef = `artifact:sha256:${digest(report)}` as const;
  const delivery = serverEventSchema.parse({
    ...exampleExecuteDelivery,
    command: {
      ...executeCommand,
      leaseExpiresAt: new Date(Date.now() + 3600000).toISOString()
    }
  });
  const requests: Array<{
    method: string;
    operationId?: string;
    authorization?: string;
    path?: string;
  }> = [];
  const stored = new Map<string, Buffer>();
  let puts = 0;
  let pollIndex = 0;
  let currentToken = tokens[0]!;
  const logs: unknown[] = [];
  let client: AgentHostClient | undefined;
  const rotate = (index: number) => {
    hosts.requestCredentialRenewal(hostId);
    const result = hosts.registerCredentialRotation(hostId, `rotation-${index}`, tokens[index]!);
    currentToken = tokens[index]!;
    rotations[index - 1]!.resolve({
      hostId,
      credentialToken: tokens[index]!,
      issuedAt: credentialNow.toISOString(),
      expiresAt: result.credentialExpiresAt
    });
  };
  const http = createServer(async (request, response) => {
    const auth = authenticateAgentHostRequest(request, hosts, hostId, admission);
    if (!auth.ok) {
      response.writeHead(auth.status);
      response.end();
      return;
    }
    requests.push({
      method: request.method!,
      operationId:
        typeof request.headers["x-planweave-artifact-operation-id"] === "string"
          ? request.headers["x-planweave-artifact-operation-id"]
          : undefined,
      authorization: request.headers.authorization,
      path: request.url
    });
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/plain", "content-length": input.length });
      response.end(input);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const operationId = String(request.headers["x-planweave-artifact-operation-id"]);
    stored.set(operationId, bytes);
    puts += 1;
    if (puts === 1) {
      rotate(2);
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ref: `artifact:sha256:${digest(bytes)}` }));
  });
  const sockets = new WebSocketServer({ server: http });
  sockets.on("connection", (socket, request) => {
    const auth = authenticateAgentHostRequest(request, hosts, hostId, admission);
    if (!auth.ok) {
      socket.close(4003);
      return;
    }
    const index = tokens.findIndex((token) => request.headers.authorization === `Bearer ${token}`);
    if (index > 0)
      credentialNow = new Date(
        credentialNow.getTime() + HOST_CREDENTIAL_PREVIOUS_TOKEN_GRACE_MS + 1
      );
    socket.on("message", (data) => {
      const raw = JSON.parse(data.toString());
      if (raw.type === "host.hello") {
        socket.send(
          JSON.stringify(
            serverEventSchema.parse({
              type: "host.welcome",
              protocolVersion: 1,
              exactPermissionOptionsVersion: 1,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: 60000,
              leaseDurationMs: 3600000
            })
          )
        );
        if (index === 0) socket.send(JSON.stringify(delivery));
        connected[index]!.resolve();
        return;
      }
      const event = hostEventSchema.parse(raw);
      if ("messageId" in event)
        socket.send(
          JSON.stringify({ type: "host.event_ack", protocolVersion: 1, messageId: event.messageId })
        );
      if (event.type === "dispatch.completed" || event.type === "dispatch.failed")
        completed.resolve(event);
    });
  });
  try {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("expected_port");
    const origin = `http://127.0.0.1:${address.port}`;
    const request: typeof fetch = async (url, init) => {
      try {
        return await remoteRunnerEventV2Request(url, init);
      } catch (error) {
        if (init?.method === "PUT" && puts === 1) await connected[2]!.promise;
        throw error;
      }
    };
    client = new AgentHostClient({
      serverUrl: origin,
      hostId,
      token: tokens[0]!,
      capabilities: ["test"],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      state,
      request,
      allowInsecureTransport: true,
      reconnect: { initialDelayMs: 1, maxDelayMs: 1 },
      logger: {
        log: (event) => {
          logs.push(event);
        }
      },
      credentialRenewal: {
        readActiveCredential: async () => ({
          hostId,
          credentialToken: currentToken,
          issuedAt: credentialNow.toISOString(),
          expiresAt: new Date(credentialNow.getTime() + 86400000).toISOString()
        }),
        poll: () => {
          const index = pollIndex++;
          if (index === 2) return Promise.reject(new Error(`renewal failed with ${tokens[2]}`));
          return rotations[index]?.promise ?? Promise.resolve(undefined);
        }
      },
      executor: {
        execute: async (_command, context) => {
          executing.resolve(context);
          await finish.promise;
          const reportArtifactRef = await context.artifacts.upload({
            bytes: report,
            mediaType: "text/markdown",
            purpose: "report",
            operationKey: "primary-report"
          });
          await expect(
            context.artifacts.download({
              artifactRef: inputRef,
              logicalName: "after-second-rotation"
            })
          ).resolves.toEqual({ bytes: input, mediaType: "text/plain" });
          return { summary: "Rotation completed", reportArtifactRef, artifactRefs: [] };
        }
      }
    });
    client.start();
    const context = await executing.promise;
    rotate(1);
    await connected[1]!.promise;
    expect(hosts.authenticateCredential(hostId, tokens[0]!)).toBeUndefined();
    const old = await fetch(
      `${origin}/agent-hosts/${hostId}/dispatches/x/leases/x/attempts/x/artifacts/${digest(input)}`,
      { headers: { authorization: `Bearer ${tokens[0]}` } }
    );
    expect(old.status).toBe(401);
    await expect(
      context.artifacts.download({
        artifactRef: inputRef,
        logicalName: "requirements",
        mediaType: "text/plain"
      })
    ).resolves.toEqual({ bytes: input, mediaType: "text/plain" });
    finish.resolve();
    expect(await completed.promise).toMatchObject({
      type: "dispatch.completed",
      result: { reportArtifactRef: reportRef }
    });
    expect(hosts.authenticateCredential(hostId, tokens[1]!)).toBeUndefined();
    expect(requests.map((entry) => entry.authorization)).toEqual([
      `Bearer ${tokens[1]}`,
      `Bearer ${tokens[1]}`,
      `Bearer ${tokens[2]}`,
      `Bearer ${tokens[2]}`
    ]);
    expect(requests[1]!.operationId).toBe(requests[2]!.operationId);
    expect(requests[1]!.path).toBe(requests[2]!.path);
    expect(stored.size).toBe(1);
    expect([...stored.values()]).toEqual([report]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "host_credential_renewal_failed",
        reason: "credential_renewal_failed"
      })
    );
    for (const token of tokens) expect(JSON.stringify(logs)).not.toContain(token);
    await client.stop();
    const count = requests.length;
    await expect(
      context.artifacts.download({ artifactRef: inputRef, logicalName: "stopped" })
    ).rejects.toThrow();
    await expect(
      context.artifacts.upload({
        bytes: report,
        mediaType: "text/markdown",
        purpose: "report",
        operationKey: "stopped"
      })
    ).rejects.toThrow();
    expect(requests).toHaveLength(count);
  } finally {
    finish.resolve();
    await client?.stop();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    state.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
