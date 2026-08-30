import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion,
  type CanvasRuntimeRequestCommand
} from "@planweave-ai/agent-host-protocol";
import type { CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { randomUUID } from "node:crypto";
import { ArtifactStore } from "../../artifacts.js";
import { RuntimeArtifactGrantRepository } from "../../canvas/runtimeArtifactGrantRepository.js";
import { CanvasRuntimeHostLocator } from "../../canvas/runtimeHostLocator.js";
import { CanvasRuntimeRpcBroker } from "../../canvas/runtimeRpcBroker.js";
import { AgentHostRepository } from "../../hosts.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { DurableMailbox, type MailboxMessage } from "../../mailbox.js";
import { applyMigrations } from "../../migrations.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import { openServerDatabase } from "../../sqlite.js";

export async function createRemoteHostRuntimeTestEnvironment(options: {
  scope: CanvasScopeRef;
  requestTimeoutMs?: number;
}) {
  const { scope } = options;
  const database = await openServerDatabase(":memory:", 5_000);
  applyMigrations(database);
  new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(scope.workspaceId);
  const projectAccess = new ProjectAccessRepository(database);
  projectAccess.registerProjectInternal({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    projectRoot: "/runtime/project"
  });
  projectAccess.registerCanvasInternal({ ...scope, packageDir: "/runtime/project/package" });
  database
    .prepare("UPDATE project_registry SET project_root_internal=NULL WHERE project_id=?")
    .run(scope.projectId);
  database
    .prepare("UPDATE canvas_registry SET package_dir_internal=NULL WHERE project_id=?")
    .run(scope.projectId);

  const hosts = new AgentHostRepository(database);
  const reportRuntimeHost = (hostId: string) =>
    hosts.reportOnline(hostId, [CANVAS_RUNTIME_CAPABILITY], 1, {
      workspaceMappings: [{ workspaceId: scope.workspaceId, status: "ready" }],
      acpProfiles: [],
      runtimeProjects: [
        { workspaceId: scope.workspaceId, projectId: scope.projectId, status: "ready" }
      ]
    });
  const host = hosts.register("Remote Runtime").host;
  reportRuntimeHost(host.id);

  const mailbox = new DurableMailbox(database);
  const broker = new CanvasRuntimeRpcBroker(database, hosts, mailbox, {
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000
  });
  const activeHostIds = new Set([host.id]);
  broker.attachSessionLookup({ isActive: (hostId) => activeHostIds.has(hostId) });
  const deliveries: MailboxMessage[] = [];
  mailbox.subscribe(host.id, (message) => deliveries.push(message));

  const locator = new CanvasRuntimeHostLocator(hosts.runtimeBindings, hosts, broker, projectAccess);
  const grants = new RuntimeArtifactGrantRepository(database, {
    maxArtifactBytes: 1024 * 1024,
    leaseActive: (lease) =>
      broker.isActive(lease.hostId) &&
      broker.attachmentVersion(lease.hostId) === lease.attachmentVersion
  });

  return {
    database,
    broker,
    locator,
    grants,
    artifacts: new ArtifactStore(database, "/not-observed", 1024 * 1024),
    host,
    deliveries,
    addHost(name: string) {
      const additionalHost = hosts.register(name).host;
      reportRuntimeHost(additionalHost.id);
      activeHostIds.add(additionalHost.id);
      const hostDeliveries: MailboxMessage[] = [];
      mailbox.subscribe(additionalHost.id, (message) => hostDeliveries.push(message));
      return { host: additionalHost, deliveries: hostDeliveries };
    },
    disconnectHost(hostId: string) {
      activeHostIds.delete(hostId);
      broker.detachHost(hostId, "disconnected");
    },
    close() {
      database.close();
    }
  };
}

export type RemoteHostRuntimeTestEnvironment = Awaited<
  ReturnType<typeof createRemoteHostRuntimeTestEnvironment>
>;

export function runtimeRequestCommandAt(
  deliveries: MailboxMessage[],
  index: number
): CanvasRuntimeRequestCommand {
  const command = deliveries[index]?.command;
  if (command?.type !== "canvas_runtime.request") {
    throw new Error("test_canvas_runtime_request_expected");
  }
  return command;
}

export function respondToRuntimeRequest(
  broker: CanvasRuntimeRpcBroker,
  hostId: string,
  command: CanvasRuntimeRequestCommand,
  response: Record<string, unknown>
) {
  broker.handleResponse(hostId, {
    type: "canvas_runtime.response",
    protocolVersion: agentHostProtocolVersion,
    messageId: randomUUID(),
    requestId: command.requestId,
    response
  });
}
