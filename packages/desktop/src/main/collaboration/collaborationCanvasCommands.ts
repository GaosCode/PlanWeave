import {
  canvasCommandSubmissionIntentSchema,
  type CanvasCommandIntent,
  type CanvasCommandOutcome,
  type CanvasJournalEntry,
  type CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { opaqueIdentifierSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { type CanvasLiveSyncServerMessage } from "@planweave-ai/collaboration-protocol/canvas/live-sync";
import { type CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import { z } from "zod";
import {
  collaborationCanvasBindingInputSchema,
  type CollaborationCanvasBindingInput,
  type CollaborationCanvasScopeResolution
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import type { ResolvedCollaborationCanvasBinding } from "./ContentVersionFacade.js";
import {
  CanvasReplicaCommandWorker,
  type CanvasReplicaCommandTransport
} from "./CanvasReplicaCommandWorker.js";
import type { CanvasReplicaScope } from "./CanvasReplicaStore.js";
import type { CanvasReplicaStore } from "./CanvasReplicaStore.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { CanvasCommandSessionSnapshot } from "./canvasCommandSession.js";
import type { CanvasLiveSyncStatus } from "./CanvasLiveSyncClient.js";
import type { CanvasReplicaDiskMirror } from "./CanvasReplicaDiskMirror.js";

function isRetryableCatchupError(error: unknown): boolean {
  if (error instanceof CollaborationClientError) {
    if (error.kind === "forbidden" || error.kind === "aborted" || error.kind === "auth") {
      return false;
    }
    const terminalCodes = new Set([
      "forbidden",
      "unauthorized",
      "unknown_canvas",
      "cross_scope",
      "collaboration_canvas_scope_unmapped",
      "canvas_replica_scope_unbound",
      "canvas_replica_command_forbidden",
      "collaboration_session_not_connected"
    ]);
    if (terminalCodes.has(error.code)) return false;
    return error.retryable === true;
  }
  // Unknown/network failures remain retryable.
  return true;
}

export const collaborationCanvasCommandSubmitInputSchema = z
  .object({
    canvasId: opaqueIdentifierSchema,
    intent: canvasCommandSubmissionIntentSchema
  })
  .strict();
export type CollaborationCanvasCommandSubmitInput = z.infer<
  typeof collaborationCanvasCommandSubmitInputSchema
>;

export const collaborationCanvasReconnectInputSchema = z
  .object({
    canvasId: opaqueIdentifierSchema,
    afterRevision: z.number().int().nonnegative().optional(),
    afterContentDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict();
export type CollaborationCanvasReconnectInput = z.infer<
  typeof collaborationCanvasReconnectInputSchema
>;

/** Public result of a canvas command submit (no secrets). */
export type CollaborationCanvasCommandSubmitResult = {
  outcome: CanvasCommandOutcome;
  session: CanvasCommandSessionSnapshot | null;
};

/** Public result of canvas reconnect (no secrets). */
export type CollaborationCanvasReconnectResult = {
  response: CanvasReconnectResponse;
  entriesToApply: CanvasJournalEntry[];
  snapshotRequired: boolean;
  session: CanvasCommandSessionSnapshot | null;
};

export type CollaborationCanvasCommandSessionView = CanvasCommandSessionSnapshot | null;

type CanvasCommandClientPort = Pick<
  CollaborationClient,
  | "projectId"
  | "submitCanvasCommand"
  | "reconnectCanvasCommands"
  | "fetchContentVersion"
  | "bindCanvasCommandSession"
  | "clearCanvasCommandSession"
  | "canvasCommandSession"
  | "getCurrentCanvasAccess"
  | "connectionProfile"
  | "startLiveSync"
  | "stopLiveSync"
  | "subscribeLiveSync"
  | "acknowledgeLiveSyncRevision"
  | "acknowledgeLiveSyncMaterializedHead"
  | "reportLiveSyncCatchupRecovering"
>;

export type CollaborationCanvasCommandFacadeDeps = {
  resolveClient: () => CanvasCommandClientPort | null;
  resolveCanvasBinding: (
    input: CollaborationCanvasBindingInput
  ) => Promise<ResolvedCollaborationCanvasBinding | null>;
  resolveCanvasScope: (
    input: CollaborationCanvasBindingInput
  ) => Promise<CollaborationCanvasScopeResolution | null>;
  resolveAuthorityId: () => string | null;
  store: CanvasReplicaStore;
  mirror?: Pick<CanvasReplicaDiskMirror, "bind" | "flush" | "clear">;
  worker?: CanvasReplicaCommandWorker;
  transport?: CanvasReplicaCommandTransport;
};

function requireClient(client: CanvasCommandClientPort | null): CanvasCommandClientPort {
  if (!client) {
    throw new CollaborationClientError({
      kind: "aborted",
      code: "collaboration_session_not_connected",
      message: "Collaboration session is not connected."
    });
  }
  return client;
}

function createDefaultTransport(
  resolveClient: () => CanvasCommandClientPort | null
): CanvasReplicaCommandTransport {
  return {
    async fetchReconnectBaseline(scope) {
      const client = requireClient(resolveClient());
      // Single reconnect(0) establishes command revision + immutable content ref together.
      const reconnect = await client.reconnectCanvasCommands({
        canvasId: scope.canvasId,
        afterRevision: 0
      });
      const response = reconnect.response;
      if (response.type !== "canvas.reconnect.snapshot") {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "canvas_replica_snapshot_required",
          message: "canvas_replica_snapshot_required",
          retryable: true
        });
      }
      if (
        response.scope.workspaceId !== scope.workspaceId ||
        response.scope.projectId !== scope.projectId ||
        response.scope.canvasId !== scope.canvasId ||
        response.snapshot.metadata.scope.workspaceId !== scope.workspaceId ||
        response.snapshot.metadata.scope.projectId !== scope.projectId ||
        response.snapshot.metadata.scope.canvasId !== scope.canvasId
      ) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "canvas_replica_scope_mismatch",
          message: "canvas_replica_scope_mismatch"
        });
      }
      const fetched = await client.fetchContentVersion({
        scope: response.snapshot.metadata.scope,
        content: response.snapshot.content
      });
      if (
        fetched.scope.workspaceId !== scope.workspaceId ||
        fetched.scope.projectId !== scope.projectId ||
        fetched.scope.canvasId !== scope.canvasId ||
        fetched.completed.versionId !== response.snapshot.content.versionId ||
        fetched.content.canonicalDigest !== response.snapshot.metadata.contentDigest ||
        fetched.content.canonicalDigest !== response.snapshot.content.canonicalDigest
      ) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "canvas_replica_snapshot_content_mismatch",
          message: "canvas_replica_snapshot_content_mismatch",
          retryable: true
        });
      }
      return { response, content: fetched.content };
    },

    async reconnect(scope, input) {
      const client = requireClient(resolveClient());
      const reconnect = await client.reconnectCanvasCommands({
        canvasId: scope.canvasId,
        afterRevision: input.afterRevision,
        ...(input.afterContentDigest ? { afterContentDigest: input.afterContentDigest } : {})
      });
      let snapshotContent: CompleteContentVersion | undefined;
      if (reconnect.response.type === "canvas.reconnect.snapshot") {
        const response = reconnect.response;
        // Same strict scope checks as the initial reconnect(0) baseline path.
        if (
          response.scope.workspaceId !== scope.workspaceId ||
          response.scope.projectId !== scope.projectId ||
          response.scope.canvasId !== scope.canvasId ||
          response.snapshot.metadata.scope.workspaceId !== scope.workspaceId ||
          response.snapshot.metadata.scope.projectId !== scope.projectId ||
          response.snapshot.metadata.scope.canvasId !== scope.canvasId
        ) {
          throw new CollaborationClientError({
            kind: "protocol",
            code: "canvas_replica_scope_mismatch",
            message: "canvas_replica_scope_mismatch"
          });
        }
        const fetched = await client.fetchContentVersion({
          scope: response.snapshot.metadata.scope,
          content: response.snapshot.content
        });
        if (
          fetched.scope.workspaceId !== scope.workspaceId ||
          fetched.scope.projectId !== scope.projectId ||
          fetched.scope.canvasId !== scope.canvasId ||
          fetched.completed.versionId !== response.snapshot.content.versionId ||
          fetched.content.canonicalDigest !== response.snapshot.metadata.contentDigest ||
          fetched.content.canonicalDigest !== response.snapshot.content.canonicalDigest
        ) {
          throw new CollaborationClientError({
            kind: "protocol",
            code: "canvas_replica_snapshot_content_mismatch",
            message: "canvas_replica_snapshot_content_mismatch",
            retryable: true
          });
        }
        snapshotContent = fetched.content;
      }
      return { response: reconnect.response, snapshotContent };
    },

    async canPersistCanvasCommand(scope) {
      const client = requireClient(resolveClient());
      const access = await client.getCurrentCanvasAccess(scope.canvasId);
      if (
        access.scope.workspaceId !== scope.workspaceId ||
        access.scope.projectId !== scope.projectId ||
        access.scope.canvasId !== scope.canvasId
      ) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "canvas_replica_access_scope_mismatch",
          message: "canvas_replica_access_scope_mismatch"
        });
      }
      return access.canvas.capabilities.persistent_canvas_command === true;
    },

    async submit(input) {
      const client = requireClient(resolveClient());
      // Real-time edit success must not depend on local disk materialization.
      return client.submitCanvasCommand({
        canvasId: input.scope.canvasId,
        operationId: input.operationId,
        intent: input.intent,
        expectedRevision: input.expectedRevision
      });
    }
  };
}

/**
 * Service-facing seam for durable canvas commands via in-memory replica + FIFO worker.
 * Renderer never supplies operationId or expectedRevision.
 */
export class CollaborationCanvasCommandFacade {
  private binding: {
    scope: CanvasReplicaScope;
    remoteProjectId: string;
    remoteCanvasId: string;
  } | null = null;

  /** Bumps on every unbind so late live messages cannot touch a new or cleared scope. */
  private liveGeneration = 0;
  private liveUnsubscribe: (() => void) | null = null;
  private catchupRunning = false;
  private catchupDelayCancel: (() => void) | null = null;

  private readonly store: CanvasReplicaStore;
  private readonly worker: CanvasReplicaCommandWorker;
  private readonly resolveClient: () => CanvasCommandClientPort | null;
  private readonly resolveCanvasBinding: CollaborationCanvasCommandFacadeDeps["resolveCanvasBinding"];
  private readonly resolveCanvasScope: CollaborationCanvasCommandFacadeDeps["resolveCanvasScope"];
  private readonly resolveAuthorityId: () => string | null;
  private readonly mirror: CollaborationCanvasCommandFacadeDeps["mirror"];

  constructor(deps: CollaborationCanvasCommandFacadeDeps) {
    this.resolveClient = deps.resolveClient;
    this.resolveCanvasBinding = deps.resolveCanvasBinding;
    this.resolveCanvasScope = deps.resolveCanvasScope;
    this.resolveAuthorityId = deps.resolveAuthorityId;
    this.mirror = deps.mirror;
    this.store = deps.store;
    const transport = deps.transport ?? createDefaultTransport(deps.resolveClient);
    this.worker = deps.worker ?? new CanvasReplicaCommandWorker(deps.store, transport);
  }

  /**
   * Start a submit: validates binding, enqueues optimistic pending synchronously, returns
   * the network Promise without holding callers on disk materialization.
   */
  submit(input: unknown): Promise<CollaborationCanvasCommandSubmitResult> {
    try {
      const parsed = collaborationCanvasCommandSubmitInputSchema.parse(input);
      const client = requireClient(this.resolveClient());
      const binding = this.requireBinding(client, parsed.canvasId);
      const network = this.worker.submit(binding.scope, parsed.intent as CanvasCommandIntent);
      return network.then((outcome) => ({
        outcome,
        session: client.canvasCommandSession()
      }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async reconnect(input: unknown): Promise<CollaborationCanvasReconnectResult> {
    const parsed = collaborationCanvasReconnectInputSchema.parse(input);
    const client = requireClient(this.resolveClient());
    const binding = this.requireBinding(client, parsed.canvasId);
    const response = await this.worker.reconnect(binding.scope, {
      afterRevision: parsed.afterRevision,
      afterContentDigest: parsed.afterContentDigest
    });
    const entriesToApply = response.type === "canvas.reconnect.delta" ? [...response.entries] : [];
    return {
      response,
      entriesToApply,
      snapshotRequired: response.type === "canvas.reconnect.snapshot",
      session: client.canvasCommandSession()
    };
  }

  async bind(input: unknown): Promise<CollaborationCanvasCommandSessionView> {
    const parsed = collaborationCanvasBindingInputSchema.parse(input);
    const client = requireClient(this.resolveClient());
    const authorityId = this.resolveAuthorityId();
    if (!authorityId) {
      // Full unbind: resolution never starts, but an existing session must not keep running.
      this.unbindCurrent(client);
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_session_not_connected",
        message: "Collaboration session is not connected."
      });
    }
    const resolved = await this.resolveCanvasBinding(parsed);
    if (
      !resolved ||
      !sameBinding(resolved, parsed) ||
      resolved.remoteProjectId !== client.projectId
    ) {
      this.unbindCurrent(client);
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_canvas_scope_unmapped",
        message: "collaboration_canvas_scope_unmapped",
        retryable: false
      });
    }
    const remoteScope = await this.resolveCanvasScope(parsed);
    if (
      !remoteScope ||
      remoteScope.projectId !== resolved.remoteProjectId ||
      remoteScope.canvasId !== resolved.remoteCanvasId
    ) {
      this.unbindCurrent(client);
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_canvas_scope_unmapped",
        message: "collaboration_canvas_scope_unmapped",
        retryable: false
      });
    }

    // Drop the previous binding immediately so a failed rebind cannot leave the
    // facade pointing at a cleared scope.
    this.unbindCurrent(client);

    const remoteReplicaScope = {
      authorityId,
      workspaceId: remoteScope.workspaceId,
      projectId: remoteScope.projectId,
      canvasId: remoteScope.canvasId
    };
    const scope: CanvasReplicaScope =
      resolved.kind === "local"
        ? {
            ...remoteReplicaScope,
            bindingKind: "local",
            localProjectId: resolved.localProjectId,
            localCanvasId: resolved.canvasId
          }
        : { ...remoteReplicaScope, bindingKind: "remote" };

    try {
      if (scope.bindingKind === "local") await this.mirror?.bind(scope);
      await this.worker.bind(scope);
      this.binding = {
        scope,
        remoteProjectId: resolved.remoteProjectId,
        remoteCanvasId: resolved.remoteCanvasId
      };
      client.bindCanvasCommandSession(resolved.remoteCanvasId);
      this.startLiveSubscription(client, scope);
      return client.canvasCommandSession();
    } catch (error) {
      // Transactional rollback: new scope, queues, and client command session.
      this.worker.clear(scope);
      this.unbindCurrent(client);
      throw error;
    }
  }

  session(): CollaborationCanvasCommandSessionView {
    const client = this.resolveClient();
    return client?.canvasCommandSession() ?? null;
  }

  projectionForBinding(input: CollaborationCanvasBindingInput) {
    const binding = this.binding;
    if (!binding || !scopeMatchesBinding(binding.scope, input)) {
      return null;
    }
    return this.store.projection(binding.scope);
  }

  clearAllSessions(): void {
    this.cancelCatchupDelay();
    this.liveGeneration += 1;
    this.catchupRunning = false;
    this.liveUnsubscribe?.();
    this.liveUnsubscribe = null;
    const client = this.resolveClient();
    try {
      client?.stopLiveSync();
    } catch {
      // ignore stop races during shutdown
    }
    this.worker.clearAll();
    this.binding = null;
    this.mirror?.clear();
  }

  async flushMaterialization(): Promise<void> {
    await this.mirror?.flush();
  }

  /**
   * Full unbind: live subscription, worker scope + pending queues, facade binding,
   * and client command session.
   */
  private unbindCurrent(client: CanvasCommandClientPort | null): void {
    this.cancelCatchupDelay();
    this.liveGeneration += 1;
    this.catchupRunning = false;
    this.liveUnsubscribe?.();
    this.liveUnsubscribe = null;
    if (client) {
      try {
        client.stopLiveSync();
      } catch {
        // ignore
      }
    }
    if (this.binding) {
      this.worker.clear(this.binding.scope);
      this.binding = null;
    }
    this.mirror?.clear();
    if (!client) return;
    try {
      client.clearCanvasCommandSession();
    } catch {
      // Client may already be disposed; facade is unbound regardless.
    }
  }

  private cancelCatchupDelay(): void {
    this.catchupDelayCancel?.();
    this.catchupDelayCancel = null;
  }

  /**
   * Own the live socket for this canvas and fold accepted journal entries into the replica.
   * Materialized cursor advances when the store head is updated; entryApplied is independent.
   */
  private startLiveSubscription(client: CanvasCommandClientPort, scope: CanvasReplicaScope): void {
    if (typeof client.startLiveSync !== "function") {
      return;
    }
    this.cancelCatchupDelay();
    this.liveGeneration += 1;
    const generation = this.liveGeneration;
    this.catchupRunning = false;
    this.liveUnsubscribe?.();
    this.liveUnsubscribe = null;
    const boundScope = scope;
    const isCurrent = () =>
      this.liveGeneration === generation &&
      this.binding?.scope.authorityId === boundScope.authorityId &&
      this.binding.scope.workspaceId === boundScope.workspaceId &&
      this.binding.scope.projectId === boundScope.projectId &&
      this.binding.scope.canvasId === boundScope.canvasId;

    const handlers = {
      onMessage: (message: CanvasLiveSyncServerMessage) => {
        if (!isCurrent()) return;
        if (message.type !== "canvas.live.accepted_entry") return;
        // Drop cross-canvas frames even if the shared socket briefly delivers them.
        if (
          message.entry.scope.projectId !== boundScope.projectId ||
          message.entry.scope.canvasId !== boundScope.canvasId ||
          message.entry.scope.workspaceId !== boundScope.workspaceId
        ) {
          return;
        }
        void (async () => {
          const result = await this.worker.applyLiveEntry(boundScope, message.entry);
          if (!isCurrent()) return;
          if (!result.materializedHead) return;
          // Live entry: strict +1 cursor. HTTP recovery: monotone head jump.
          if (result.entryApplied && typeof client.acknowledgeLiveSyncRevision === "function") {
            client.acknowledgeLiveSyncRevision(result.materializedHead.revision);
            return;
          }
          if (
            result.reason === "recovered" &&
            typeof client.acknowledgeLiveSyncMaterializedHead === "function"
          ) {
            client.acknowledgeLiveSyncMaterializedHead(result.materializedHead.revision);
            return;
          }
          // Other materialised heads (e.g. head advanced without entryApplied) use jump ack.
          if (typeof client.acknowledgeLiveSyncMaterializedHead === "function") {
            client.acknowledgeLiveSyncMaterializedHead(result.materializedHead.revision);
          }
        })();
      },
      onStatus: (status: CanvasLiveSyncStatus) => {
        if (!isCurrent()) return;
        if (status.state !== "catchup_required") return;
        void this.recoverLiveCatchup(client, boundScope, generation);
      }
    };

    if (typeof client.subscribeLiveSync === "function") {
      this.liveUnsubscribe = client.subscribeLiveSync(handlers);
      client.startLiveSync(boundScope.canvasId, this.store.revision(boundScope));
    } else {
      client.startLiveSync(boundScope.canvasId, this.store.revision(boundScope), handlers);
    }
  }

  /**
   * Persistent catch-up: retry only transport/retryable failures with cancellable backoff.
   * Terminal auth/permission errors stop immediately with a failed status.
   */
  private async recoverLiveCatchup(
    client: CanvasCommandClientPort,
    scope: CanvasReplicaScope,
    generation: number
  ): Promise<void> {
    if (this.liveGeneration !== generation || this.catchupRunning) return;
    this.catchupRunning = true;
    let attempt = 0;
    try {
      while (this.liveGeneration === generation) {
        attempt += 1;
        const delayMs = Math.min(30_000, 200 * 2 ** Math.min(attempt - 1, 10));
        if (typeof client.reportLiveSyncCatchupRecovering === "function") {
          client.reportLiveSyncCatchupRecovering(scope.canvasId, attempt, delayMs);
        }
        try {
          await this.worker.reconnect(scope);
          if (this.liveGeneration !== generation) return;
          if (
            !this.binding ||
            this.binding.scope.authorityId !== scope.authorityId ||
            this.binding.scope.canvasId !== scope.canvasId
          ) {
            return;
          }
          // Materialised head may jump multiple revisions — use recovery cursor ack.
          if (typeof client.acknowledgeLiveSyncMaterializedHead === "function") {
            client.acknowledgeLiveSyncMaterializedHead(this.store.revision(scope));
          } else if (typeof client.acknowledgeLiveSyncRevision === "function") {
            client.acknowledgeLiveSyncRevision(this.store.revision(scope));
          }
          this.catchupRunning = false;
          this.startLiveSubscription(client, scope);
          return;
        } catch (error) {
          if (this.liveGeneration !== generation) return;
          if (!isRetryableCatchupError(error)) {
            // Terminal: permission / unknown canvas / non-retryable protocol failure.
            try {
              client.stopLiveSync();
            } catch {
              // ignore
            }
            return;
          }
          const wait = await this.waitCatchupDelay(delayMs, generation);
          if (wait === "cancelled") return;
        }
      }
    } finally {
      this.cancelCatchupDelay();
      if (this.liveGeneration === generation) this.catchupRunning = false;
    }
  }

  private waitCatchupDelay(ms: number, generation: number): Promise<"ok" | "cancelled"> {
    if (this.liveGeneration !== generation) return Promise.resolve("cancelled");
    if (ms <= 0) {
      return Promise.resolve(this.liveGeneration === generation ? "ok" : "cancelled");
    }
    return new Promise((resolve) => {
      this.cancelCatchupDelay();
      const timer = setTimeout(() => {
        this.catchupDelayCancel = null;
        resolve(this.liveGeneration === generation ? "ok" : "cancelled");
      }, ms);
      timer.unref?.();
      this.catchupDelayCancel = () => {
        clearTimeout(timer);
        this.catchupDelayCancel = null;
        resolve("cancelled");
      };
    });
  }

  private requireBinding(
    client: CanvasCommandClientPort,
    canvasId: string
  ): { scope: CanvasReplicaScope; remoteProjectId: string; remoteCanvasId: string } {
    const binding = this.binding;
    if (
      !binding ||
      binding.remoteCanvasId !== canvasId ||
      binding.remoteProjectId !== client.projectId
    ) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_canvas_local_binding_required",
        message: "collaboration_canvas_local_binding_required",
        retryable: false
      });
    }
    return binding;
  }
}

function sameBinding(
  resolved: ResolvedCollaborationCanvasBinding,
  requested: CollaborationCanvasBindingInput
): boolean {
  if (resolved.kind !== requested.kind || resolved.canvasId !== requested.canvasId) return false;
  return resolved.kind === "local" && requested.kind === "local"
    ? resolved.localProjectId === requested.localProjectId
    : resolved.kind === "remote" &&
        requested.kind === "remote" &&
        resolved.workspaceId === requested.workspaceId &&
        resolved.projectId === requested.projectId;
}

function scopeMatchesBinding(
  scope: CanvasReplicaScope,
  requested: CollaborationCanvasBindingInput
): boolean {
  if (scope.bindingKind !== requested.kind || scope.canvasId !== requested.canvasId) return false;
  return scope.bindingKind === "local" && requested.kind === "local"
    ? scope.localProjectId === requested.localProjectId &&
        scope.localCanvasId === requested.canvasId
    : scope.bindingKind === "remote" &&
        requested.kind === "remote" &&
        scope.workspaceId === requested.workspaceId &&
        scope.projectId === requested.projectId;
}
