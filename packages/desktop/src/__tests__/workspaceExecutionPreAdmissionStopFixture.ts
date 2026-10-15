import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { WORKSPACE_CANVAS_EXECUTION_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { loadPlanGraphPackage } from "@planweave-ai/runtime";
import type { WebSocket } from "ws";
import type { Server } from "node:http";
import { setupServerCompositionFixture } from "../../../server/src/__tests__/support/serverCompositionFixture.js";
import { connectPathlessCanvasRuntimeHost } from "../../../server/src/__tests__/support/workspaceExecutionPlaneGapCanvasRuntimeHost.js";
import { ownHostRemoteAgents } from "../../../server/src/__tests__/support/remoteAgentOwnerFixture.js";
import { AgentHostRepository } from "../../../server/src/hosts.js";
import { syncRemoteAgentsFromHost } from "../../../server/src/remoteAgent/index.js";
import { openServerDatabase, type SqliteDatabase } from "../../../server/src/sqlite.js";
import type { DistributedServerComposition } from "../../../server/src/serverComposition.js";
import {
  CollaborationCredentialVault,
  CollaborationService,
  WorkspaceConnectionProfileStore
} from "../main/collaboration/index.js";
import { WorkspaceExecutionDesktopService } from "../main/workspaceExecutionDesktopService.js";
import { createWorkspaceExecutionPreloadApi } from "../preload/workspaceExecutionPreloadBridge.js";
import { workspaceExecutionHandlerResult } from "../main/workspaceExecutionIpcResult.js";
import {
  desktopWorkspaceExecutionCancellationRecoveryInputSchema,
  desktopWorkspaceExecutionStartCancellationInputSchema,
  desktopWorkspaceExecutionStartInputSchema
} from "../shared/workspaceExecution.js";
import { workspaceExecutionInvokeChannels } from "../shared/workspaceExecutionIpc.js";

const roots: string[] = [];
const collaborations: CollaborationService[] = [];
const httpServers: Server[] = [];
const compositions: DistributedServerComposition[] = [];
const databases: SqliteDatabase[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  await Promise.all(collaborations.splice(0).map((service) => service.shutdown()));
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function setupPreAdmissionStop() {
  const composed = await setupServerCompositionFixture({
    directories: roots,
    httpServers,
    compositions
  });
  const database = await openServerDatabase(composed.databasePath, 5_000);
  databases.push(database);
  const bootstrap = await fetch(
    `${composed.origin}/api/v1/projects/${composed.projectId}/human/bootstrap`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Pre-admission Owner",
        humanPrincipalId: "pre-admission-owner"
      })
    }
  );
  const owner = (await bootstrap.json()) as { deviceToken: string };
  if (bootstrap.status !== 201) throw new Error("pre_admission_owner_bootstrap_failed");
  const hosts = new AgentHostRepository(
    database,
    () => new Date(),
    (host) => {
      syncRemoteAgentsFromHost({ database, host, clock: () => new Date() });
    }
  );
  const registration = hosts.register("Pre-admission Host");
  const host = registration.host;
  ownHostRemoteAgents({
    database,
    hostId: host.id,
    ownerHumanPrincipalId: "pre-admission-owner",
    grantWorkspaceId: composed.workspaceId
  });
  hosts.bindToWorkspace(host.id, composed.workspaceId);
  hosts.reportOnline(
    host.id,
    ["acp.codex", "acp.session.load", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
    1,
    {
      workspaceMappings: [{ workspaceId: composed.workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Test Agent",
          status: "ready",
          capabilities: ["acp.codex", "acp.session.load"]
        }
      ]
    }
  );
  const projectRoot = roots.at(-1);
  if (!projectRoot) throw new Error("pre_admission_project_root_required");
  const loaded = await loadPlanGraphPackage(projectRoot);
  await connectPathlessCanvasRuntimeHost({
    origin: composed.origin,
    hostId: host.id,
    token: registration.token,
    scope: {
      workspaceId: composed.workspaceId,
      projectId: composed.projectId,
      canvasId: "default"
    },
    projectRoot,
    expectedPackageDir: loaded.workspace.packageDir,
    sockets,
    contentGraphFingerprint: composed.dispatchAuthority.graphFingerprint
  });
  const endpoint = database
    .prepare("SELECT endpoint_id FROM remote_agents WHERE host_id=? AND revoked_at IS NULL")
    .get(host.id) as { endpoint_id: string } | undefined;
  if (!endpoint) throw new Error("pre_admission_endpoint_required");
  const server = {
    ...composed,
    canvasId: "default",
    blockRef: "T-001#B-001",
    endpointId: endpoint.endpoint_id,
    ownerToken: owner.deviceToken,
    countOperations: () =>
      Number(
        (database.prepare("SELECT COUNT(*) AS n FROM remote_operations").get() as { n: number }).n
      )
  };
  const root = await mkdtemp(join(tmpdir(), "pw-pre-admission-stop-"));
  roots.push(root);
  const sessionsRoot = join(root, "sessions");
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  };
  const vault = new CollaborationCredentialVault({
    paths: { credentialsPath: join(root, "credentials.json") },
    safeStorage
  });
  const workspaceProfiles = new WorkspaceConnectionProfileStore({
    profilesPath: join(root, "workspaces.json")
  });
  const requests: { path: string; method: string }[] = [];
  const collaboration = new CollaborationService({
    profileStorePaths: { profilesPath: join(root, "profiles.json") },
    workspaceProfileStore: workspaceProfiles,
    vault,
    safeStorage,
    invitationsPath: join(root, "invitations.json"),
    exportedIdentityPath: join(root, "exported.json"),
    request: async (input, init) => {
      requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" });
      return fetch(input, init);
    }
  });
  collaborations.push(collaboration);
  const profileId = "profile-pre-admission";
  await workspaceProfiles.upsert({
    profile: {
      schemaVersion: "workspace-identity/v1",
      profileId,
      displayName: "Pre-admission Workspace",
      serverBaseUrl: server.origin,
      workspaceId: server.workspaceId,
      allowInsecureTransport: true
    },
    workspaceDisplayName: "Pre-admission Workspace",
    membershipRole: "owner",
    membershipActive: true
  });
  await collaboration.upsertProfile({
    profileId,
    displayName: "Pre-admission Workspace",
    serverBaseUrl: server.origin,
    projectId: server.projectId,
    allowInsecureTransport: true,
    endpoint: {
      topology: "loopback_http",
      serverOrigin: server.origin,
      allowedClientOrigins: [server.origin],
      tlsTrust: "not_applicable"
    }
  });
  const restoreCredential = () =>
    collaboration.importDeviceCredential({ profileId, deviceToken: server.ownerToken });
  await restoreCredential();
  const input = {
    locator: {
      kind: "workspace" as const,
      connectionProfileId: profileId,
      workspaceId: server.workspaceId,
      projectId: server.projectId,
      canvasId: server.canvasId
    },
    blockRef: server.blockRef,
    agentEndpointId: server.endpointId,
    effectiveExecutor: { name: "codex-acp", agentId: "codex" },
    startRequestId: "start-before-admission"
  };
  const stop = {
    input,
    startRequestId: input.startRequestId,
    actionId: "stop-before-admission",
    reason: "Desktop Auto Run stop requested."
  };
  const create = () =>
    new WorkspaceExecutionDesktopService(
      collaboration,
      {
        withExecutionProfile: async () => {
          throw new Error("unexpected_owner_canvas");
        }
      },
      sessionsRoot
    );
  async function diskFiles(): Promise<string[]> {
    try {
      return (await readdir(sessionsRoot, { recursive: true })).filter((name) =>
        name.endsWith(".json")
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
  }
  const journals = async (): Promise<{ path: string; value: unknown }[]> =>
    Promise.all(
      (await diskFiles())
        .filter((name) => name.startsWith("start-intents/"))
        .map(async (name) => ({
          path: join(sessionsRoot, name),
          value: JSON.parse(await readFile(join(sessionsRoot, name), "utf8"))
        }))
    );
  return {
    server,
    collaboration,
    vault,
    sessionsRoot,
    input,
    stop,
    requests,
    create,
    diskFiles,
    journals,
    restoreCredential,
    clearCredential: () => collaboration.clearDeviceCredential({ profileId }),
    // Exercises production preload validation and Main result envelopes; the adapter is not Electron IPC.
    preload: (service: WorkspaceExecutionDesktopService) =>
      createWorkspaceExecutionPreloadApi(async (channel, raw) => {
        if (channel === workspaceExecutionInvokeChannels.start)
          return workspaceExecutionHandlerResult(() =>
            service.start(desktopWorkspaceExecutionStartInputSchema.parse(raw))
          );
        if (channel === workspaceExecutionInvokeChannels.cancelStart)
          return workspaceExecutionHandlerResult(() =>
            service.cancelStart(desktopWorkspaceExecutionStartCancellationInputSchema.parse(raw))
          );
        if (channel === workspaceExecutionInvokeChannels.recoverCancellation)
          return workspaceExecutionHandlerResult(() =>
            service.recoverCancellations(
              desktopWorkspaceExecutionCancellationRecoveryInputSchema.parse(raw)
            )
          );
        throw new Error(`unexpected_test_invoke:${channel}`);
      })
  };
}
