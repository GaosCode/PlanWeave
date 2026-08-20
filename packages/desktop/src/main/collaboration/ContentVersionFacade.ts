import { randomUUID } from "node:crypto";
import {
  completedContentVersionRefSchema,
  type CompleteContentVersion,
  type CompletedContentVersionRef
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  contentVersionAuthorityDiscoveryToDesktopReadModel,
  contentVersionDesktopReadModelSchema,
  type ContentVersionDesktopReadModel
} from "@planweave-ai/collaboration-protocol/content/authority";
import { type CanvasAccessRecord } from "@planweave-ai/collaboration-protocol/access/project";
import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  captureAuthorizedCanvasContent,
  createManagedProjectFromAuthoritativeContent,
  getProjectOverview,
  listProjects,
  materializeAuthoritativeCanvasContent,
  planManagedProjectFromAuthoritativeContent,
  resolveTaskCanvasWorkspace
} from "@planweave-ai/runtime";
import {
  collaborationContentAuthorityCanvasInputSchema,
  collaborationCanvasScopeResolutionSchema,
  collaborationContentBootstrapCandidateSchema,
  collaborationContentBootstrapInputSchema,
  collaborationContentBootstrapResultSchema,
  type CollaborationContentBootstrapCandidate,
  type CollaborationContentBootstrapResult
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import {
  CollaborationContentReplicaStore,
  type CollaborationContentReplica,
  type CollaborationContentReplicaStorePort
} from "./CollaborationContentReplicaStore.js";
import {
  CollaborationRuntimeStatusStore,
  type CollaborationRuntimeStatusStorePort
} from "./CollaborationRuntimeStatusStore.js";
import {
  CollaborationRuntimeAvailabilityStore,
  type CollaborationRuntimeAvailabilityStorePort
} from "./CollaborationRuntimeAvailabilityStore.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { CanvasReplicaScope } from "./CanvasReplicaStore.js";

type LocalCanvasBinding = {
  clientFingerprint: string;
  authorityProjectId: string;
  remoteCanvasId: string;
  projectRoot: string;
  localProjectId: string;
  localCanvasId: string;
  expectedPackageDir: string;
};

export type ResolvedCollaborationCanvasBinding = {
  localProjectId: string;
  localCanvasId: string;
  remoteProjectId: string;
  remoteCanvasId: string;
};

export type CanvasReplicaBaseline = {
  scope: CanvasReplicaScope;
  content: CompleteContentVersion;
  contentDigest: string;
};

export type CollaborationAuthorityContext = {
  profileId: string;
  serverOrigin: string;
  projectId: string;
};

function unavailable(code: string, retryable = false): CollaborationClientError {
  return new CollaborationClientError({ kind: "unknown", code, message: code, retryable });
}

/** Main-only authority workflow. Renderer receives only redacted content refs/read models. */
export class ContentVersionFacade {
  private binding: LocalCanvasBinding | null = null;
  private lastModel: ContentVersionDesktopReadModel | null = null;

  constructor(
    private readonly resolveClient: () => CollaborationClient | null,
    private readonly replicas: CollaborationContentReplicaStorePort = new CollaborationContentReplicaStore(),
    private readonly resolveAuthorityContext: () =>
      | CollaborationAuthorityContext
      | null
      | Promise<CollaborationAuthorityContext | null> = () => null,
    private readonly runtimeStatuses: CollaborationRuntimeStatusStorePort = new CollaborationRuntimeStatusStore(),
    private readonly runtimeAvailabilities: CollaborationRuntimeAvailabilityStorePort = new CollaborationRuntimeAvailabilityStore()
  ) {}

  async bind(input: unknown): Promise<ContentVersionDesktopReadModel> {
    const { localProjectId, canvasId } =
      collaborationContentAuthorityCanvasInputSchema.parse(input);
    const client = this.requireClient();
    const mapped = (await this.replicas.list()).find(
      (replica) =>
        replica.remote.serverOrigin === this.serverOrigin(client) &&
        replica.remote.projectId === client.projectId &&
        replica.local.projectId === localProjectId &&
        replica.local.canvasId === canvasId
    );
    this.binding = await this.bindLocal(
      client,
      localProjectId,
      canvasId,
      mapped?.remote.canvasId ?? canvasId,
      mapped
    );
    return this.refresh();
  }

  async listBootstrapCandidates(): Promise<CollaborationContentBootstrapCandidate[]> {
    const client = this.requireClient();
    const serverOrigin = this.serverOrigin(client);
    const [canvases, storedReplicas, localProjects] = await Promise.all([
      this.listAuthorizedCanvases(client),
      this.replicas.list(),
      listProjects()
    ]);
    const localProjectIds = new Set(localProjects.map((project) => project.projectId));
    return Promise.all(
      canvases.map(async (canvas) => {
        const remote = {
          serverOrigin,
          workspaceId: canvas.registry.workspaceId,
          projectId: canvas.registry.projectId,
          canvasId: canvas.registry.canvasId
        };
        let mapped =
          storedReplicas.find((replica) => this.sameRemote(replica.remote, remote)) ?? null;
        if (mapped?.phase === "ready" && !localProjectIds.has(mapped.local.projectId)) {
          await this.replicas.remove(remote);
          mapped = null;
        }
        const discovered = await client.discoverContentAuthority({
          canvasId: canvas.registry.canvasId,
          localReplica: null,
          knownRevision: null
        });
        return collaborationContentBootstrapCandidateSchema.parse({
          workspaceId: canvas.registry.workspaceId,
          projectId: canvas.registry.projectId,
          canvasId: canvas.registry.canvasId,
          visibility: canvas.visibility,
          authority: contentVersionAuthorityDiscoveryToDesktopReadModel(discovered),
          localReplica:
            mapped?.phase === "ready"
              ? { projectId: mapped.local.projectId, canvasId: mapped.local.canvasId }
              : null
        });
      })
    );
  }

  async bootstrap(input: unknown): Promise<CollaborationContentBootstrapResult> {
    const requested = collaborationContentBootstrapInputSchema.parse(input);
    const client = this.requireClient();
    const serverOrigin = this.serverOrigin(client);
    const canvases = await this.listAuthorizedCanvases(client);
    const canvas = canvases.find(
      (candidate) =>
        candidate.registry.workspaceId === requested.workspaceId &&
        candidate.registry.projectId === requested.projectId &&
        candidate.registry.canvasId === requested.canvasId
    );
    if (!canvas) throw unavailable("content_remote_canvas_not_authorized", false);
    const remote = {
      serverOrigin,
      workspaceId: canvas.registry.workspaceId,
      projectId: canvas.registry.projectId,
      canvasId: canvas.registry.canvasId
    };
    let existing = (await this.replicas.list()).find((replica) =>
      this.sameRemote(replica.remote, remote)
    );
    const localProjects = new Set((await listProjects()).map((project) => project.projectId));
    if (existing?.phase === "ready" && !localProjects.has(existing.local.projectId)) {
      await this.replicas.remove(remote);
      existing = undefined;
    }
    if (existing?.phase === "ready") {
      this.binding = await this.bindLocal(
        client,
        existing.local.projectId,
        existing.local.canvasId,
        remote.canvasId,
        existing
      );
      const authority = await this.refresh();
      const acknowledgement = await this.acknowledgeCurrentHead(client, authority);
      return collaborationContentBootstrapResultSchema.parse({
        outcome: "reused",
        localProjectId: existing.local.projectId,
        localCanvasId: existing.local.canvasId,
        remoteCanvasId: remote.canvasId,
        acknowledgement,
        authority
      });
    }

    const discovered = await client.discoverContentAuthority({
      canvasId: remote.canvasId,
      localReplica: null,
      knownRevision: null
    });
    const authority = contentVersionDesktopReadModelSchema.parse(
      contentVersionAuthorityDiscoveryToDesktopReadModel(discovered)
    );
    const head = authority.authoritativeHead;
    if (!head || !authority.canMaterialize) {
      throw unavailable("content_authoritative_head_unavailable", false);
    }
    this.assertRemoteScope(head.scope, remote);
    const fetched = await client.fetchContentVersion({
      scope: head.scope,
      content: head.content
    });
    if (
      fetched.completed.versionId !== head.content.versionId ||
      fetched.content.canonicalDigest !== head.content.canonicalDigest
    ) {
      throw unavailable("content_authoritative_head_mismatch", false);
    }
    this.assertRemoteScope(fetched.scope, remote);
    let replica = existing;
    if (!replica) {
      const planned = await planManagedProjectFromAuthoritativeContent({
        content: fetched.content
      });
      const now = new Date().toISOString();
      replica = await this.replicas.reserve({
        remote,
        local: { projectId: planned.projectId, canvasId: planned.canvasId },
        phase: "importing",
        projectName: planned.projectName,
        reservationToken: randomUUID(),
        createdAt: now,
        updatedAt: now
      });
    }
    if (!replica.projectName || !replica.reservationToken) {
      throw unavailable("content_replica_reservation_invalid", false);
    }
    const created = await createManagedProjectFromAuthoritativeContent({
      authorityProjectId: client.projectId,
      content: fetched.content,
      projectName: replica.projectName,
      expectedProjectId: replica.local.projectId,
      resumeReservedProject: true,
      reservationToken: replica.reservationToken
    });
    const completedReplica = await this.replicas.complete(remote);
    this.binding = await this.bindLocal(
      client,
      created.project.projectId,
      created.canvasId,
      remote.canvasId,
      completedReplica
    );
    const synchronizedAuthority = contentVersionDesktopReadModelSchema.parse({
      ...authority,
      localReplica: fetched.completed,
      replicaStatus: "in_sync"
    });
    this.lastModel = synchronizedAuthority;
    let acknowledgement: "acknowledged" | "pending" = "acknowledged";
    try {
      await client.acknowledgeContentVersion({
        canvasId: remote.canvasId,
        content: fetched.completed
      });
    } catch {
      acknowledgement = "pending";
    }
    return collaborationContentBootstrapResultSchema.parse({
      outcome: "created",
      localProjectId: created.project.projectId,
      localCanvasId: created.canvasId,
      remoteCanvasId: remote.canvasId,
      acknowledgement,
      authority: synchronizedAuthority
    });
  }

  async read(): Promise<ContentVersionDesktopReadModel | null> {
    const client = this.resolveClient();
    if (
      !client ||
      !this.binding ||
      this.binding.clientFingerprint !== this.clientFingerprint(client)
    ) {
      this.binding = null;
      this.lastModel = null;
    }
    return this.lastModel;
  }

  async resolveCanvasBinding(input: unknown): Promise<ResolvedCollaborationCanvasBinding | null> {
    const { localProjectId, canvasId } =
      collaborationContentAuthorityCanvasInputSchema.parse(input);
    const client = this.resolveClient();
    const authority = await this.authorityContext(client);
    if (!authority) return null;
    if (client && localProjectId === client.projectId) {
      return {
        localProjectId,
        localCanvasId: canvasId,
        remoteProjectId: client.projectId,
        remoteCanvasId: canvasId
      };
    }
    const replica = (await this.replicas.list()).find(
      (candidate) =>
        candidate.phase === "ready" &&
        candidate.remote.serverOrigin === authority.serverOrigin &&
        candidate.remote.projectId === authority.projectId &&
        candidate.local.projectId === localProjectId &&
        candidate.local.canvasId === canvasId
    );
    return replica
      ? {
          localProjectId: replica.local.projectId,
          localCanvasId: replica.local.canvasId,
          remoteProjectId: replica.remote.projectId,
          remoteCanvasId: replica.remote.canvasId
        }
      : null;
  }

  /**
   * Read the immutable content for an in-memory Canvas replica baseline.
   * Uses reconnect(afterRevision: 0) so command revision and content ref come from one
   * consistent snapshot — never discover(content head) then reconnect separately.
   * Does not materialize disk. Content-authority revision is intentionally not returned.
   */
  async readCanvasReplicaBaseline(input: unknown): Promise<CanvasReplicaBaseline> {
    const requested = collaborationContentAuthorityCanvasInputSchema.parse(input);
    const client = this.requireClient();
    const binding = await this.resolveCanvasBinding(requested);
    if (!binding) throw unavailable("canvas_replica_scope_unmapped", false);
    const scope = await this.resolveCanvasScope(requested);
    if (
      !scope ||
      scope.projectId !== binding.remoteProjectId ||
      scope.canvasId !== binding.remoteCanvasId
    ) {
      throw unavailable("canvas_replica_scope_mismatch", false);
    }
    const reconnect = await client.reconnectCanvasCommands({
      canvasId: scope.canvasId,
      afterRevision: 0
    });
    const response = reconnect.response;
    if (response.type !== "canvas.reconnect.snapshot") {
      throw unavailable("canvas_replica_snapshot_required", true);
    }
    if (
      response.scope.workspaceId !== scope.workspaceId ||
      response.scope.projectId !== scope.projectId ||
      response.scope.canvasId !== scope.canvasId ||
      response.snapshot.metadata.scope.workspaceId !== scope.workspaceId ||
      response.snapshot.metadata.scope.projectId !== scope.projectId ||
      response.snapshot.metadata.scope.canvasId !== scope.canvasId
    ) {
      throw unavailable("canvas_replica_scope_mismatch", false);
    }
    const snapshot = response.snapshot;
    const fetched = await client.fetchContentVersion({
      scope: snapshot.metadata.scope,
      content: snapshot.content
    });
    if (
      fetched.scope.workspaceId !== scope.workspaceId ||
      fetched.scope.projectId !== scope.projectId ||
      fetched.scope.canvasId !== scope.canvasId ||
      fetched.completed.versionId !== snapshot.content.versionId ||
      fetched.content.canonicalDigest !== snapshot.metadata.contentDigest ||
      fetched.content.canonicalDigest !== snapshot.content.canonicalDigest
    ) {
      throw unavailable("canvas_replica_snapshot_content_mismatch", true);
    }
    return {
      scope: {
        authorityId: this.clientFingerprint(client),
        localProjectId: binding.localProjectId,
        localCanvasId: binding.localCanvasId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId
      },
      content: fetched.content,
      contentDigest: snapshot.metadata.contentDigest
    };
  }

  /** Public authority fingerprint for replica scope keys (profile + server + project). */
  authorityIdForClient(client: CollaborationClient = this.requireClient()): string {
    return this.clientFingerprint(client);
  }

  async resolveCanvasScope(input: unknown) {
    const requested = collaborationContentAuthorityCanvasInputSchema.parse(input);
    const client = this.resolveClient();
    const authority = await this.authorityContext(client);
    if (!authority) return null;
    if (!client) {
      const replica = (await this.replicas.list()).find(
        (candidate) =>
          candidate.phase === "ready" &&
          candidate.remote.serverOrigin === authority.serverOrigin &&
          candidate.remote.projectId === authority.projectId &&
          candidate.local.projectId === requested.localProjectId &&
          candidate.local.canvasId === requested.canvasId
      );
      if (replica) {
        return collaborationCanvasScopeResolutionSchema.parse({
          workspaceId: replica.remote.workspaceId,
          projectId: replica.remote.projectId,
          canvasId: replica.remote.canvasId
        });
      }
      const cached = await this.runtimeStatuses.get({
        ...authority,
        localProjectId: requested.localProjectId,
        localCanvasId: requested.canvasId
      });
      return cached ? collaborationCanvasScopeResolutionSchema.parse(cached.scope) : null;
    }
    const binding = await this.resolveCanvasBinding(input);
    if (!binding) return null;
    const replica = (await this.replicas.list()).find(
      (candidate) =>
        candidate.phase === "ready" &&
        candidate.remote.serverOrigin === authority.serverOrigin &&
        candidate.local.projectId === requested.localProjectId &&
        candidate.local.canvasId === requested.canvasId &&
        candidate.remote.projectId === binding.remoteProjectId &&
        candidate.remote.canvasId === binding.remoteCanvasId
    );
    if (replica) {
      return collaborationCanvasScopeResolutionSchema.parse({
        workspaceId: replica.remote.workspaceId,
        projectId: binding.remoteProjectId,
        canvasId: binding.remoteCanvasId
      });
    }
    const matchingCanvases = (await this.listAuthorizedCanvases(client)).filter(
      (candidate) =>
        candidate.registry.projectId === binding.remoteProjectId &&
        candidate.registry.canvasId === binding.remoteCanvasId
    );
    if (matchingCanvases.length > 1) {
      throw unavailable("content_remote_canvas_scope_ambiguous", false);
    }
    const canvas = matchingCanvases[0];
    return canvas
      ? collaborationCanvasScopeResolutionSchema.parse({
          workspaceId: canvas.registry.workspaceId,
          projectId: binding.remoteProjectId,
          canvasId: binding.remoteCanvasId
        })
      : null;
  }

  async readRuntimeStatus(input: unknown) {
    const requested = collaborationContentAuthorityCanvasInputSchema.parse(input);
    const client = this.resolveClient();
    const authority = await this.authorityContext(client);
    if (!authority) return null;
    const cacheKey = {
      ...authority,
      localProjectId: requested.localProjectId,
      localCanvasId: requested.canvasId
    };
    if (!client) return this.runtimeStatuses.get(cacheKey);
    const scope = await this.resolveCanvasScope(requested);
    if (!scope) return null;
    const status = await client.readRuntimeStatus(scope.canvasId);
    if (
      status.scope.workspaceId !== scope.workspaceId ||
      status.scope.projectId !== scope.projectId ||
      status.scope.canvasId !== scope.canvasId
    ) {
      throw unavailable("runtime_status_scope_mismatch", false);
    }
    return this.runtimeStatuses.put(cacheKey, status);
  }

  async readRuntimeAvailability(input: unknown): Promise<CanvasRuntimeAvailability | null> {
    const requested = collaborationContentAuthorityCanvasInputSchema.parse(input);
    const client = this.resolveClient();
    const authority = await this.authorityContext(client);
    if (!authority) return null;
    const cacheKey = {
      ...authority,
      localProjectId: requested.localProjectId,
      localCanvasId: requested.canvasId
    };
    if (!client) return this.runtimeAvailabilities.get(cacheKey);
    const scope = await this.resolveCanvasScope(requested);
    if (!scope) return null;
    const availability = await client.readRuntimeAvailability(scope.canvasId);
    if (
      availability.kind === "available" &&
      (availability.status.scope.workspaceId !== scope.workspaceId ||
        availability.status.scope.projectId !== scope.projectId ||
        availability.status.scope.canvasId !== scope.canvasId)
    ) {
      throw unavailable("runtime_availability_scope_mismatch", false);
    }
    return this.runtimeAvailabilities.put(cacheKey, availability);
  }

  async refresh(): Promise<ContentVersionDesktopReadModel> {
    const client = this.requireClient();
    const binding = this.requireBinding(client);
    const local = await this.collect(binding);
    const discovered = await client.discoverContentAuthority({
      canvasId: binding.remoteCanvasId,
      localReplica: local.ref,
      knownRevision: this.lastModel?.authoritativeHead?.revision ?? null
    });
    this.lastModel = contentVersionDesktopReadModelSchema.parse(
      contentVersionAuthorityDiscoveryToDesktopReadModel(discovered)
    );
    return this.lastModel;
  }

  async publishInitial(): Promise<ContentVersionDesktopReadModel> {
    const client = this.requireClient();
    const binding = this.requireBinding(client);
    const local = await this.collect(binding);
    const published = await client.publishInitialContent({
      canvasId: binding.remoteCanvasId,
      content: local.content
    });
    if (published.outcome !== "published") {
      throw unavailable(`content_initial_publish_${published.reason}`, published.retryable);
    }
    await client.acknowledgeContentVersion({
      canvasId: binding.remoteCanvasId,
      content: published.version.completed
    });
    return this.refresh();
  }

  async materializeHead(): Promise<ContentVersionDesktopReadModel> {
    const client = this.requireClient();
    const binding = this.requireBinding(client);
    const model = await this.refresh();
    const head = model.authoritativeHead;
    if (!head || !model.canMaterialize)
      throw unavailable("content_materialization_not_available", false);
    const fetched = await client.fetchContentVersion({
      scope: head.scope,
      content: head.content
    });
    if (
      fetched.completed.versionId !== head.content.versionId ||
      fetched.content.canonicalDigest !== head.content.canonicalDigest
    ) {
      throw unavailable("content_authoritative_head_mismatch", false);
    }
    await materializeAuthoritativeCanvasContent({
      projectRoot: binding.projectRoot,
      canvasId: binding.localCanvasId,
      expectedPackageDir: binding.expectedPackageDir,
      authorityProjectId: binding.authorityProjectId,
      content: fetched.content
    });
    await client.acknowledgeContentVersion({
      canvasId: binding.remoteCanvasId,
      content: fetched.completed
    });
    return this.refresh();
  }

  private requireClient(): CollaborationClient {
    const client = this.resolveClient();
    if (!client) throw unavailable("collaboration_content_offline", true);
    if (this.binding && this.binding.clientFingerprint !== this.clientFingerprint(client)) {
      this.binding = null;
      this.lastModel = null;
    }
    return client;
  }

  private requireBinding(client: CollaborationClient): LocalCanvasBinding {
    if (!this.binding) throw unavailable("content_canvas_binding_required", false);
    if (this.binding.clientFingerprint !== this.clientFingerprint(client)) {
      this.binding = null;
      this.lastModel = null;
      throw unavailable("content_canvas_binding_scope_mismatch", false);
    }
    return this.binding;
  }

  private async bindLocal(
    client: CollaborationClient,
    localProjectId: string,
    localCanvasId: string,
    remoteCanvasId: string,
    expectedReplica?: CollaborationContentReplica
  ): Promise<LocalCanvasBinding> {
    const matches = (await listProjects()).filter(
      (project) => project.projectId === localProjectId
    );
    if (matches.length !== 1) throw unavailable("content_local_project_binding_invalid", false);
    const overview = await getProjectOverview(matches[0]!.rootPath);
    if (overview.projectId !== localProjectId)
      throw unavailable("content_local_project_binding_invalid", false);
    const workspace = await resolveTaskCanvasWorkspace(overview.rootPath, localCanvasId);
    if (expectedReplica) {
      if (
        expectedReplica.local.projectId !== localProjectId ||
        expectedReplica.local.canvasId !== localCanvasId ||
        expectedReplica.remote.serverOrigin !== this.serverOrigin(client) ||
        expectedReplica.remote.projectId !== client.projectId ||
        expectedReplica.remote.canvasId !== remoteCanvasId
      ) {
        throw unavailable("content_replica_mapping_conflict", false);
      }
    } else if (workspace.id !== client.projectId) {
      throw unavailable("content_local_project_scope_mismatch", false);
    }
    return {
      clientFingerprint: this.clientFingerprint(client),
      authorityProjectId: client.projectId,
      remoteCanvasId,
      projectRoot: overview.rootPath,
      localProjectId,
      localCanvasId,
      expectedPackageDir: workspace.packageDir
    };
  }

  private async collect(binding: LocalCanvasBinding): Promise<{
    content: CompleteContentVersion;
    ref: CompletedContentVersionRef;
  }> {
    const captured = await captureAuthorizedCanvasContent({
      projectRoot: binding.projectRoot,
      canvasId: binding.localCanvasId,
      expectedPackageDir: binding.expectedPackageDir,
      authorityProjectId: binding.authorityProjectId
    });
    if (captured.packageDir !== binding.expectedPackageDir)
      throw unavailable("content_local_package_binding_invalid", false);
    const content = captured.content;
    return {
      content,
      ref: completedContentVersionRefSchema.parse({
        versionId: `version-${content.canonicalDigest}`,
        canonicalDigest: content.canonicalDigest,
        verification: "complete"
      })
    };
  }

  private serverOrigin(client: CollaborationClient): string {
    return new URL(client.connectionProfile.serverBaseUrl).origin;
  }

  private async authorityContext(
    client: CollaborationClient | null
  ): Promise<CollaborationAuthorityContext | null> {
    if (client) {
      return {
        profileId: client.connectionProfile.profileId,
        serverOrigin: this.serverOrigin(client),
        projectId: client.projectId
      };
    }
    return this.resolveAuthorityContext();
  }

  private clientFingerprint(client: CollaborationClient): string {
    const profile = client.connectionProfile;
    return `${profile.profileId}\u0000${this.serverOrigin(client)}\u0000${client.projectId}`;
  }

  private sameRemote(
    left: CollaborationContentReplica["remote"],
    right: CollaborationContentReplica["remote"]
  ): boolean {
    return (
      left.serverOrigin === right.serverOrigin &&
      left.workspaceId === right.workspaceId &&
      left.projectId === right.projectId &&
      left.canvasId === right.canvasId
    );
  }

  private assertRemoteScope(
    actual: { workspaceId: string; projectId: string; canvasId: string },
    expected: CollaborationContentReplica["remote"]
  ): void {
    if (
      actual.workspaceId !== expected.workspaceId ||
      actual.projectId !== expected.projectId ||
      actual.canvasId !== expected.canvasId
    ) {
      throw unavailable("content_authoritative_scope_mismatch", false);
    }
  }

  private async listAuthorizedCanvases(client: CollaborationClient): Promise<CanvasAccessRecord[]> {
    const items: CanvasAccessRecord[] = [];
    const cursors = new Set<number>();
    let cursor = 0;
    while (true) {
      if (cursors.has(cursor)) throw unavailable("content_registry_pagination_invalid", false);
      cursors.add(cursor);
      const page = await client.registry().listCanvases({
        projectId: client.projectId,
        cursor,
        limit: 100
      });
      items.push(...page.items);
      if (page.nextCursor === null) return items;
      cursor = page.nextCursor;
    }
  }

  private async acknowledgeCurrentHead(
    client: CollaborationClient,
    authority: ContentVersionDesktopReadModel
  ): Promise<"acknowledged" | "pending"> {
    const binding = this.requireBinding(client);
    const head = authority.authoritativeHead;
    if (!head || authority.localReplica?.canonicalDigest !== head.content.canonicalDigest) {
      return "pending";
    }
    try {
      await client.acknowledgeContentVersion({
        canvasId: binding.remoteCanvasId,
        content: head.content
      });
      return "acknowledged";
    } catch {
      return "pending";
    }
  }
}
