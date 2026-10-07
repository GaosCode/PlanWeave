import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore.js";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault.js";
import { gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
  OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER
} from "@planweave-ai/agent-host-protocol";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
const metadata = {
  operationId: "operation-owner-1",
  projectId: "project-owner-1",
  canvasId: "canvas-owner-1",
  blockRef: "T-001#B-001",
  controlPlane: "owner",
  sourceRevision: "source-revision-1",
  graphFingerprint: `pkg-${"a".repeat(64)}`,
  dispatchId: "dispatch-owner-1",
  executionAttemptId: "attempt-owner-1",
  reportArtifactRef: `artifact:sha256:${"b".repeat(64)}`
};
const terminalHeaders = {
  "content-type": OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
  [OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER]: Buffer.from(JSON.stringify(metadata)).toString(
    "base64url"
  )
};
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void, timeout = 50) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })
  );
  const client = new OperatorControlClient({
    profile: {
      profileId: "body-test",
      displayName: "Test",
      serverBaseUrl: `http://127.0.0.1:${address.port}/`,
      allowInsecureTransport: true
    },
    credential: { getOperatorToken: () => "operator_test_abcdefghijklmnopqrstuvwxyz_1234" },
    requestTimeoutMs: timeout
  });
  cleanup.push(() => client.dispose());
  return client;
}
const hosts = { items: [], nextCursor: null };
describe("Operator HTTP response ownership", () => {
  it.each([
    "json",
    "error",
    "terminal"
  ] as const)("expires %s body after headers without replay", async (mode) => {
    let calls = 0;
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const client = await fixture((req, res) => {
      calls++;
      req.resume();
      res.on("close", closed);
      res.writeHead(
        mode === "error" ? 403 : 200,
        mode === "terminal" ? terminalHeaders : { "content-type": "application/json" }
      );
      res.write(mode === "terminal" ? "a" : "{");
    });
    await expect(
      mode === "terminal"
        ? client.readOwnerRemoteOperationTerminalResult(metadata.operationId)
        : client.listHosts()
    ).rejects.toMatchObject({ kind: "timeout", code: "operator_timeout" });
    await socketClosed;
    expect(calls).toBe(1);
  }, 600);
  it.each([
    "revoke",
    "renew"
  ] as const)("does not replay %s on an unknown write outcome", async (action) => {
    let calls = 0;
    const client = await fixture((req, res) => {
      expect(req.method).toBe("POST");
      calls++;
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    });
    await expect(
      action === "revoke"
        ? client.revokeHost("host-1")
        : client.requestHostCredentialRenewal("host-1")
    ).rejects.toMatchObject({ kind: "timeout", code: "operator_timeout" });
    expect(calls).toBe(1);
  }, 1000);

  it.each([
    "json",
    "terminal"
  ] as const)("dispose aborts the actual %s body and closes its socket", async (mode) => {
    let started!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const client = await fixture((_req, res) => {
      res.on("close", closed);
      res.writeHead(
        200,
        mode === "terminal" ? terminalHeaders : { "content-type": "application/json" }
      );
      res.write(mode === "terminal" ? "a" : "{");
      started();
    }, 1000);
    const pending =
      mode === "terminal"
        ? client.readOwnerRemoteOperationTerminalResult(metadata.operationId)
        : client.listHosts();
    const rejected = expect(pending).rejects.toMatchObject({
      kind: "offline",
      code: "operator_client_closed"
    });
    await bodyStarted;
    client.dispose();
    await rejected;
    await socketClosed;
  }, 1500);

  it.each([
    "declared",
    "chunked",
    "gzip"
  ] as const)("rejects %s JSON over budget and allows the next request", async (mode) => {
    let calls = 0;
    const client = await fixture((_req, res) => {
      if (++calls > 1) {
        res.end(JSON.stringify(hosts));
        return;
      }
      const bytes = Buffer.alloc(65537, 0x61);
      if (mode === "declared") {
        res.writeHead(200, { "content-length": "65537" });
        res.flushHeaders();
      } else if (mode === "gzip") {
        const compressed = gzipSync(bytes);
        res.writeHead(200, {
          "content-encoding": "gzip",
          "content-length": String(compressed.length)
        });
        res.end(compressed);
      } else {
        res.write(bytes);
      }
    }, 1000);
    await expect(client.listHosts()).rejects.toMatchObject({
      kind: "payload_too_large",
      code: "operator_response_too_large"
    });
    await expect(client.listHosts()).resolves.toEqual(hosts);
    expect(calls).toBe(2);
  });

  it.each([401, 403, 409, 503])("preserves HTTP %s domain mapping", async (status) => {
    const client = await fixture((_req, res) => {
      res.writeHead(status);
      res.end(JSON.stringify({ error: "server_code" }));
    }, 1000);
    await expect(client.listHosts()).rejects.toMatchObject({
      kind:
        status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : status === 409
              ? "conflict"
              : "server",
      code: "server_code",
      httpStatus: status
    });
  });

  it.each(["{", "{}"])("preserves malformed/schema JSON failure for %s", async (body) => {
    const client = await fixture((_req, res) => {
      res.end(body);
    }, 1000);
    await expect(client.listHosts()).rejects.toMatchObject({
      kind: "protocol",
      code: body === "{" ? "operator_malformed_json" : "operator_response_invalid"
    });
  });

  it.each([
    "media",
    "metadata"
  ] as const)("cancels an invalid terminal %s without waiting for cancel to settle", async (invalid) => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
        return new Promise<void>(() => {});
      }
    });
    const client = new OperatorControlClient({
      profile: {
        profileId: "test",
        displayName: "Test",
        serverBaseUrl: "https://operator.example.test/",
        allowInsecureTransport: false
      },
      credential: { getOperatorToken: () => "operator_test_abcdefghijklmnopqrstuvwxyz_1234" },
      request: async () =>
        new Response(body, {
          headers:
            invalid === "media" ? {} : { "content-type": OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE }
        })
    });
    cleanup.push(() => client.dispose());
    await expect(
      client.readOwnerRemoteOperationTerminalResult(metadata.operationId)
    ).rejects.toMatchObject({ kind: "protocol", code: "operator_response_invalid" });
    expect(cancellations).toBe(1);
    expect(body.locked).toBe(false);
  }, 600);

  it("releases a failed reader and clears its deadline", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("broken stream"));
      }
    });
    const clearTimeoutSpy = vi.fn();
    const client = new OperatorControlClient({
      profile: {
        profileId: "test",
        displayName: "Test",
        serverBaseUrl: "https://operator.example.test/",
        allowInsecureTransport: false
      },
      credential: { getOperatorToken: () => "operator_test_abcdefghijklmnopqrstuvwxyz_1234" },
      clock: { setTimeout: () => 1, clearTimeout: clearTimeoutSpy },
      request: async () => new Response(body)
    });
    cleanup.push(() => client.dispose());
    await expect(client.listHosts()).rejects.toMatchObject({
      kind: "offline",
      code: "operator_offline"
    });
    expect(body.locked).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
  it.each([
    "deadline",
    "profile"
  ] as const)("service %s interruption releases its client and permits the next generation", async (interruption) => {
    let started!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    let requests = 0;
    const endpoint = await fixture((_req, res) => {
      if (++requests > 1) {
        res.end(JSON.stringify(hosts));
        return;
      }
      res.on("close", closed);
      res.write("{");
      started();
    }, 1000);
    const directory = await mkdtemp(join(tmpdir(), "operator-body-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const released: ReturnType<typeof vi.spyOn>[] = [];
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (value) => Buffer.from(value),
          decryptString: (value) => value.toString("utf8")
        }
      }),
      createClient: (options) => {
        const client = new OperatorControlClient({
          ...options,
          requestTimeoutMs: interruption === "deadline" ? 50 : 1000
        });
        released.push(vi.spyOn(client, "dispose"));
        return client;
      }
    });
    cleanup.push(() => service.shutdown());
    await service.upsertProfile(endpoint.connectionProfile);
    await service.importCredential({
      profileId: "body-test",
      operatorToken: "operator_test_abcdefghijklmnopqrstuvwxyz_1234"
    });
    const pending = service.listHosts({ profileId: "body-test" });
    const rejected = expect(pending).rejects.toMatchObject({
      code: interruption === "deadline" ? "operator_timeout" : "operator_operation_invalidated"
    });
    await bodyStarted;
    if (interruption === "profile")
      await service.upsertProfile({ ...endpoint.connectionProfile, displayName: "New generation" });
    await rejected;
    await socketClosed;
    expect(released.some((spy) => spy.mock.calls.length > 0)).toBe(true);
    await expect(service.listHosts({ profileId: "body-test" })).resolves.toEqual(hosts);
    expect((await service.getStatus()).lastErrorCode).toBeNull();
  }, 2000);
  it("rejects chunked terminal bytes before retaining an over-budget response", async () => {
    const client = await fixture((_req, res) => {
      res.writeHead(200, terminalHeaders);
      res.write(Buffer.alloc(OUTPUT_MAX_ARTIFACT_BYTES + 1));
    }, 1000);
    await expect(
      client.readOwnerRemoteOperationTerminalResult(metadata.operationId)
    ).rejects.toMatchObject({
      kind: "payload_too_large",
      code: "operator_terminal_result_too_large"
    });
  });

  it("accepts JSON exactly at the byte budget", async () => {
    const value = JSON.stringify(hosts);
    const client = await fixture((_req, res) => {
      res.end(value + " ".repeat(65536 - Buffer.byteLength(value)));
    }, 1000);
    await expect(client.listHosts()).resolves.toEqual(hosts);
  });
});
