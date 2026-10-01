import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import {
  exampleExecuteDelivery,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  HOST_CREDENTIAL_PREVIOUS_TOKEN_GRACE_MS,
  serverEventSchema
} from "@planweave-ai/agent-host-protocol";
import { handleHostCredentialRenewalRequest } from "../src/hostCredentialRenewalHttp.js";
import { AgentHostRepository } from "../src/hosts.js";
import { startPlanweaveServer } from "../src/lifecycle.js";
import { authenticateAgentHostRequest } from "../src/hostTransportAuth.js";
import { createTransportAdmissionPolicyForMode } from "../src/insecureTransport.js";
import {
  AgentHostClient,
  AgentHostCredentialRenewal,
  FileHostCredentialStore,
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

it("aligns restarted artifacts with real committed credentials when the next ordinary poll returns undefined", async () => {
  if (
    exampleExecuteDelivery.type !== "mailbox.message" ||
    exampleExecuteDelivery.command.type !== "execute_block"
  ) {
    throw new Error("expected_execute_fixture");
  }
  const executeCommand = exampleExecuteDelivery.command;
  const directory = await mkdtemp(join(tmpdir(), "planweave-authority-restart-"));
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  const state = await openAgentHostState(join(directory, "host.sqlite"));
  let now = new Date();
  const hosts = new AgentHostRepository(server.database, () => now);
  const initialToken = `pw_host_${randomBytes(32).toString("base64url")}`;
  const policy = { lifetimeDays: 30, renewal: "automatic" } as const;
  const expiresAt = new Date(now.getTime() + 30 * 86400000).toISOString();
  const hostId = hosts.registerWithCredential(
    "Restart authority",
    initialToken,
    ["test"],
    1,
    expiresAt,
    policy
  ).host.id;
  const credentialDirectory = join(directory, "credentials");
  await mkdir(credentialDirectory, { mode: 0o700 });
  const credentialPath = join(credentialDirectory, "host.json");
  await writeFile(
    credentialPath,
    JSON.stringify({
      version: "agent-host-credentials/v1",
      active: {
        hostId,
        credentialToken: initialToken,
        issuedAt: now.toISOString(),
        expiresAt,
        credentialPolicy: policy
      }
    }),
    { mode: 0o600 }
  );
  const credentials = new FileHostCredentialStore(credentialPath);
  const admission = createTransportAdmissionPolicyForMode("loopback_http");
  const rotationResponse = deferred<void>();
  const releaseResponse = deferred<void>();
  const ordinaryPoll = deferred<void>();
  const firstExecution = deferred<AgentHostExecutionContext>();
  const restartedExecution = deferred<AgentHostExecutionContext>();
  const finish = deferred<void>();
  const welcomes = [deferred<void>(), deferred<void>()];
  const connections: Array<string | undefined> = [];
  const pollResults: Array<ActiveHostCredential | undefined> = [];
  const logs: unknown[] = [];
  let executions = 0;
  let client: AgentHostClient | undefined;
  const input = Buffer.from("restart input");
  const report = Buffer.from("restart report");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const artifactAuthorization: Array<string | undefined> = [];
  const http = createServer(async (request, response) => {
    if (request.url?.includes("credential-renewal")) {
      await handleHostCredentialRenewalRequest(request, response, {
        hosts,
        transportAdmission: admission,
        clock: () => now
      });
      return;
    }
    const auth = authenticateAgentHostRequest(request, hosts, hostId, admission);
    if (!auth.ok) {
      response.writeHead(auth.status);
      response.end();
      return;
    }
    artifactAuthorization.push(request.headers.authorization);
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/plain", "content-length": input.length });
      response.end(input);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ref: `artifact:sha256:${digest(Buffer.concat(chunks))}` }));
    }
  });
  const sockets = new WebSocketServer({ server: http });
  sockets.on("connection", (socket, request) => {
    const auth = authenticateAgentHostRequest(request, hosts, hostId, admission);
    if (!auth.ok) {
      socket.close(4003);
      return;
    }
    const index = connections.length;
    connections.push(request.headers.authorization);
    socket.on("message", (data) => {
      const raw = JSON.parse(data.toString());
      if (raw.type === "host.hello") {
        socket.send(
          JSON.stringify({
            type: "host.welcome",
            protocolVersion: 1,
            exactPermissionOptionsVersion: 1,
            serverTime: new Date().toISOString(),
            heartbeatIntervalMs: 100,
            leaseDurationMs: 3600000
          })
        );
        if (index < 2) {
          const envelope = executionEnvelopeSchema.parse({
            ...executeCommand.envelope,
            execution: {
              dispatchId: `dispatch-restart-${index}`,
              attemptId: `attempt-restart-${index}`
            }
          });
          socket.send(
            JSON.stringify(
              serverEventSchema.parse({
                ...exampleExecuteDelivery,
                sequence: index + 1,
                previousSequence: index,
                messageId: `restart-message-${index}`,
                command: {
                  ...executeCommand,
                  dispatchId: envelope.execution.dispatchId,
                  executionAttemptId: envelope.execution.attemptId,
                  leaseId: `lease-restart-${index}`,
                  leaseExpiresAt: new Date(Date.now() + 3600000).toISOString(),
                  envelope,
                  envelopeDigest: hashExecutionEnvelope(envelope)
                }
              })
            )
          );
        }
        welcomes[index]?.resolve();
      } else if (raw.messageId)
        socket.send(
          JSON.stringify({ type: "host.event_ack", protocolVersion: 1, messageId: raw.messageId })
        );
    });
  });
  try {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("expected_port");
    const origin = `http://127.0.0.1:${address.port}`;
    const renewal = new AgentHostCredentialRenewal(origin, credentials, {
      clock: () => now,
      request: async (url, init) => {
        const response = await fetch(url, init);
        if (init?.method === "POST") {
          rotationResponse.resolve();
          await releaseResponse.promise;
        }
        return response;
      }
    });
    hosts.requestCredentialRenewal(hostId);
    client = new AgentHostClient({
      serverUrl: origin,
      hostId,
      token: initialToken,
      capabilities: ["test"],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      state,
      request: remoteRunnerEventV2Request,
      allowInsecureTransport: true,
      reconnect: { initialDelayMs: 1, maxDelayMs: 1 },
      logger: { log: (event) => logs.push(event) },
      credentialRenewal: {
        readActiveCredential: () => renewal.readActiveCredential(),
        poll: async () => {
          const result = await renewal.poll();
          pollResults.push(result);
          if (pollResults.length > 1) ordinaryPoll.resolve();
          return result;
        }
      },
      executor: {
        execute: async (_command, context) => {
          const index = executions++;
          (index === 0 ? firstExecution : restartedExecution).resolve(context);
          if (index === 0) {
            await new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => resolve(), { once: true })
            );
            throw new Error("old_execution_aborted");
          }
          await finish.promise;
          return {
            summary: "restart complete",
            reportArtifactRef: `artifact:sha256:${digest(report)}`,
            artifactRefs: []
          };
        }
      }
    });
    client.start();
    const oldContext = await firstExecution.promise;
    await rotationResponse.promise;
    await client.stop();
    expect(oldContext.signal.aborted).toBe(true);
    client.start();
    await welcomes[1]!.promise;
    const context = await restartedExecution.promise;
    now = new Date(now.getTime() + 30001);
    releaseResponse.resolve();
    await vi.waitFor(async () => expect((await credentials.read())?.rotation).toBeUndefined());
    const current = await credentials.requireUsable(now);
    await ordinaryPoll.promise;
    expect(pollResults[1]).toBeUndefined();
    now = new Date(now.getTime() + HOST_CREDENTIAL_PREVIOUS_TOKEN_GRACE_MS + 1);
    expect(hosts.authenticateCredential(hostId, initialToken)).toBeUndefined();
    await vi.waitFor(() =>
      expect(connections.at(-1) === `Bearer ${current.credentialToken}`).toBe(true)
    );
    await expect(
      context.artifacts.download({
        artifactRef: `artifact:sha256:${digest(input)}`,
        logicalName: "restart"
      })
    ).resolves.toEqual({ bytes: input, mediaType: "text/plain" });
    await expect(
      context.artifacts.upload({
        bytes: report,
        mediaType: "text/markdown",
        purpose: "report",
        operationKey: "restart-report"
      })
    ).resolves.toBe(`artifact:sha256:${digest(report)}`);
    expect(artifactAuthorization).toEqual(Array(2).fill(`Bearer ${current.credentialToken}`));
    await expect(
      oldContext.artifacts.download({
        artifactRef: `artifact:sha256:${digest(input)}`,
        logicalName: "old-aborted"
      })
    ).rejects.toThrow();
    expect(executions).toBe(2);
    expect(JSON.stringify(logs)).not.toContain(initialToken);
    expect(JSON.stringify(logs)).not.toContain(current.credentialToken);
  } finally {
    releaseResponse.resolve();
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
