import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CollaborationConnectionProfile } from "@planweave-ai/collaboration-protocol/connection";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationSessionLifecycle } from "../main/collaboration/CollaborationSessionLifecycle.js";
import { CollaborationHttpTransport } from "../main/collaboration/collaborationHttpTransport.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return `http://127.0.0.1:${address.port}/`;
}

describe("Collaboration HTTP error bodies", () => {
  it.each([
    { status: 401, kind: "auth" },
    { status: 403, kind: "forbidden" },
    { status: 429, kind: "rate_limited" }
  ])("preserves HTTP $status and retry-after across JSON and nullable consumers", async ({
    status,
    kind
  }) => {
    const origin = await endpoint((req, res) => {
      req.resume();
      res.writeHead(status, { "retry-after": "2" });
      res.end(Buffer.from([0xff]));
    });
    const transport = new CollaborationHttpTransport({
      serverBaseUrl: origin,
      credential: { getDeviceToken: () => "test-only" },
      limits: { requestTimeoutMs: 500, jsonBodyMaxBytes: 512 }
    });
    cleanup.push(() => transport.dispose());
    const schema = z.object({ ok: z.boolean() });
    for (const pending of [
      () => transport.json("GET", "/status", schema),
      () => transport.jsonNullable("GET", "/status", schema)
    ]) {
      await expect(pending()).rejects.toMatchObject({
        kind,
        code: `http_${status}`,
        httpStatus: status,
        retryAfterMs: 2_000
      });
    }
  });

  it.each([
    401, 403
  ])("preserves preflight HTTP %s and credential rejection through the real Client", async (status) => {
    const origin = await endpoint((req, res) => {
      req.resume();
      res.writeHead(status);
      res.end(Buffer.from([0xff]));
    });
    const profile: CollaborationConnectionProfile = {
      profileId: "preflight-test",
      displayName: "Test",
      serverBaseUrl: origin,
      projectId: "project-demo-001",
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "not_applicable"
      }
    };
    const client = new CollaborationClient({
      profile,
      credential: { getDeviceToken: () => "test-only" },
      limits: { requestTimeoutMs: 500 }
    });
    cleanup.push(() => client.dispose());
    type Dependencies = ConstructorParameters<typeof CollaborationSessionLifecycle>[0];
    let current: CollaborationClient | null = null;
    let profileId: string | null = null;
    const rejected = vi.fn();
    const setSession = vi.fn();
    // Only persistence/session support ports are replaced; preflight fetch and error mapping are real.
    const lifecycle = new CollaborationSessionLifecycle({
      verifyClient: vi.fn(),
      profiles: { setActiveProfileId: vi.fn(async () => {}) } as Dependencies["profiles"],
      vault: { getDeviceToken: vi.fn(async () => "test-only") } as Dependencies["vault"],
      presenceSession: { reset: vi.fn() } as Dependencies["presenceSession"],
      canvasCommands: {
        flushSnapshotCache: vi.fn(async () => {}),
        clearAllSessions: vi.fn()
      } as Dependencies["canvasCommands"],
      enqueue: async (operation) => operation(),
      assertOpen: vi.fn(),
      getClient: () => current,
      getClientProfileId: () => profileId,
      setClient: (next, nextId) => {
        current = next;
        profileId = nextId;
      },
      getSessionPhase: () => "idle",
      setSession,
      clientForProfile: async () => ({ client, profile }),
      publishStatus: vi.fn(),
      publishObserverSignal: vi.fn(),
      onWorkspaceCredentialRejected: rejected
    });
    cleanup.push(() => lifecycle.dispose("test_cleanup"));
    const code = status === 401 ? "WORKSPACE_UNAUTHORIZED" : "WORKSPACE_FORBIDDEN";
    await expect(lifecycle.connectWithinQueue(profile.profileId)).rejects.toMatchObject({
      kind: status === 401 ? "auth" : "forbidden",
      code,
      httpStatus: status
    });
    expect(rejected).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    if (status === 401)
      expect(rejected).toHaveBeenCalledWith(profile.profileId, expect.objectContaining({ code }));
    expect(setSession).toHaveBeenLastCalledWith(
      "error",
      "connect_preflight_failed",
      expect.objectContaining({ code })
    );
    expect(current).toBeNull();
  });
});
