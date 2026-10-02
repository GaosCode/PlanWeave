import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationService } from "../main/collaboration/CollaborationService.js";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore.js";
import { createApplicationCredentialStorage } from "../main/credentialStorage/applicationCredentialStorage.js";

class ObserverSocket extends WebSocket {
  constructor(url: string, options?: string | string[] | { headers?: Record<string, string> }) {
    const protocols = typeof options === "string" || Array.isArray(options) ? options : undefined;
    const config = typeof options === "string" || Array.isArray(options) ? undefined : options;
    super(url, protocols, config);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

for (const termination of ["disconnect", "shutdown"] as const) {
  it(`does not open a late observer WebSocket after real session ${termination}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pw-observer-session-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let resolveToken!: (token: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    let signalPending!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalPending = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [], nextCursor: null }));
    });
    const ws = new WebSocketServer({ server });
    let connections = 0;
    ws.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}/`;
    cleanups.push(async () => {
      for (const client of ws.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        ws.close((error) => (error ? reject(error) : resolve()))
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    });
    let statusPublications = 0;
    const service = new CollaborationService({
      onStatusChange: () => {
        statusPublications += 1;
      },
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace.json") },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: createApplicationCredentialStorage({ keyPath: join(root, "credential.key") })
      }),
      invitationsPath: join(root, "invitations.json"),
      exportedIdentityPath: join(root, "identity.json"),
      createClient: (options) => {
        let calls = 0;
        return new CollaborationClient({
          ...options,
          WebSocketImpl: ObserverSocket,
          credential: {
            getDeviceToken: () => {
              calls += 1;
              if (calls === 2) {
                signalPending();
                return pending;
              }
              return options.credential.getDeviceToken();
            }
          }
        });
      }
    });
    cleanups.push(async () => {
      resolveToken(exampleHumanDeviceToken);
      await service.shutdown();
    });
    await service.upsertProfile({
      profileId: "observer-session",
      displayName: "Session",
      serverBaseUrl: origin,
      projectId: "project-demo-001",
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "not_applicable"
      }
    });
    await service.importDeviceCredential({
      profileId: "observer-session",
      deviceToken: exampleHumanDeviceToken
    });
    await service.connectSession({ profileId: "observer-session" });
    await entered;
    if (termination === "disconnect") await service.disconnectSession();
    else await service.shutdown();
    const before = termination === "disconnect" ? await service.getStatus() : null;
    const publications = statusPublications;
    resolveToken(exampleHumanDeviceToken);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(connections).toBe(0);
    expect(statusPublications).toBe(publications);
    if (before) {
      const after = await service.getStatus();
      expect(after.session).toEqual(before.session);
      expect(after.session.phase).toBe("idle");
    } else {
      await expect(service.getStatus()).rejects.toThrow();
    }
  });
}
