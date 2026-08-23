import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  workspaceCanvasLocatorSchema,
  workspaceCanvasLocatorToBinding,
  type WorkspaceCanvasLocator
} from "../../shared/canvasLocator.js";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc.js";
import {
  workspaceCanvasCommandSubmitInputSchema,
  workspaceCanvasProjectionSchema,
  workspaceCanvasProjectionStatus,
  type WorkspaceCanvasConflict,
  type WorkspaceCanvasProjection
} from "../../shared/workspaceCanvasProjection.js";
import type {
  CollaborationCanvasCommandSessionView,
  CollaborationCanvasCommandSubmitResult,
  CollaborationCanvasReconnectResult
} from "./collaborationCanvasCommands.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { CollaborationCanvasBindingInput } from "../../shared/collaborationCanvasBinding.js";
import {
  workspaceCanvasRuntimeInitializeInputSchema,
  type WorkspaceCanvasRuntimeInitializeInput,
  workspaceCanvasRuntimeResetInputSchema,
  type WorkspaceCanvasRuntimeResetInput
} from "../../shared/collaborationRuntimeAvailability.js";
import type {
  CanvasRuntimeInitializeOutcome,
  CanvasRuntimeResetOutcome
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  type WorkspaceAuthoritativeSnapshotCacheEntry,
  type WorkspaceAuthoritativeSnapshotCache
} from "./WorkspaceAuthoritativeSnapshotCache.js";
import type { WorkspaceRemoteAuthorityKey } from "./WorkspaceRemoteAuthorityIdentity.js";

export type WorkspaceCanvasSessionCommands = {
  bind(input: CollaborationCanvasBindingInput): Promise<CollaborationCanvasCommandSessionView>;
  bindCached(input: {
    key: WorkspaceRemoteAuthorityKey;
    entry: WorkspaceAuthoritativeSnapshotCacheEntry;
  }): void;
  submit(
    input: unknown,
    options?: { retryStale?: boolean }
  ): Promise<CollaborationCanvasCommandSubmitResult>;
  reconnect(input: unknown): Promise<CollaborationCanvasReconnectResult>;
  projectionForBinding(
    input: CollaborationCanvasBindingInput
  ): CollaborationCanvasBindingReplicaProjection | null;
  session(): CollaborationCanvasCommandSessionView;
  releaseBinding(): void;
};

export type WorkspaceCanvasSessionDeps = {
  resolveConnectedProfileId: () => string | null;
  resolveSnapshotCacheKey(locator: WorkspaceCanvasLocator): Promise<WorkspaceRemoteAuthorityKey>;
  snapshotCache: Pick<WorkspaceAuthoritativeSnapshotCache, "get">;
  commands: WorkspaceCanvasSessionCommands;
  readRuntimeAvailability(
    input: CollaborationCanvasBindingInput
  ): Promise<CanvasRuntimeAvailability | null>;
  initializeRuntime(
    input: WorkspaceCanvasRuntimeInitializeInput
  ): Promise<CanvasRuntimeInitializeOutcome>;
  resetRuntime(input: WorkspaceCanvasRuntimeResetInput): Promise<CanvasRuntimeResetOutcome>;
  onProjection?: (projection: WorkspaceCanvasProjection) => void;
};

function sessionError(code: string, retryable = false): CollaborationClientError {
  return new CollaborationClientError({
    kind: "aborted",
    code,
    message: code,
    retryable
  });
}

function locatorsEqual(left: WorkspaceCanvasLocator, right: WorkspaceCanvasLocator): boolean {
  return (
    left.connectionProfileId === right.connectionProfileId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

/**
 * Main-process Workspace Canvas authority. Renderer talks only to this result-oriented session.
 * connectionProfileId selects the Desktop connection and is never forwarded to Server payloads.
 */
export class WorkspaceCanvasSession {
  private locator: WorkspaceCanvasLocator | null = null;
  private authorityMode: "server_authoritative" | "offline_cache_readonly" = "server_authoritative";
  private recovery: {
    key: WorkspaceRemoteAuthorityKey;
    entry: WorkspaceAuthoritativeSnapshotCacheEntry;
  } | null = null;
  private initialRuntimeAvailability: CanvasRuntimeAvailability | null = null;

  constructor(private readonly deps: WorkspaceCanvasSessionDeps) {}

  async open(input: unknown): Promise<WorkspaceCanvasProjection> {
    const locator = this.requireLocator(input);
    const binding = workspaceCanvasLocatorToBinding(locator);
    const connectedProfileId = this.deps.resolveConnectedProfileId();
    if (connectedProfileId && connectedProfileId !== locator.connectionProfileId) {
      throw sessionError("workspace_canvas_connection_mismatch");
    }
    if (connectedProfileId) {
      let bindingOpened = false;
      try {
        await this.deps.commands.bind(binding);
        bindingOpened = true;
        const runtimeAvailability = await this.deps.readRuntimeAvailability(binding);
        this.locator = locator;
        this.authorityMode = "server_authoritative";
        this.recovery = null;
        this.initialRuntimeAvailability = runtimeAvailability;
        return this.publishCurrent();
      } catch (error) {
        if (bindingOpened) {
          this.deps.commands.releaseBinding();
          this.locator = null;
          this.authorityMode = "server_authoritative";
          this.recovery = null;
          this.initialRuntimeAvailability = null;
        }
        if (!this.cacheRecoveryAllowed(error)) throw error;
      }
    }
    const key = await this.deps.resolveSnapshotCacheKey(locator);
    const entry = await this.deps.snapshotCache.get(key);
    if (!entry) throw sessionError("workspace_canvas_offline_cache_unavailable", true);
    this.deps.commands.bindCached({ key, entry });
    this.locator = locator;
    this.authorityMode = "offline_cache_readonly";
    this.recovery = { key, entry };
    this.initialRuntimeAvailability = null;
    return this.publishCurrent();
  }

  async submit(input: unknown): Promise<WorkspaceCanvasProjection> {
    const parsed = workspaceCanvasCommandSubmitInputSchema.parse(input);
    const locator = this.requireOpen(parsed.locator);
    if (this.authorityMode === "offline_cache_readonly") {
      throw sessionError("workspace_canvas_offline_readonly");
    }
    this.assertConnection(locator);
    const network = this.deps.commands.submit(
      { canvasId: locator.canvasId, intent: parsed.intent as CanvasCommandIntent },
      { retryStale: false }
    );
    this.publishIfOpen();
    const result = await network;
    return this.projectionFromSubmit(result);
  }

  async reconnect(input: unknown = this.locator): Promise<WorkspaceCanvasProjection> {
    const locator = this.requireOpen(input);
    this.assertConnection(locator);
    if (this.authorityMode === "offline_cache_readonly") {
      const recovery = this.recovery;
      if (!recovery) throw sessionError("workspace_canvas_offline_cache_unavailable", true);
      try {
        const binding = workspaceCanvasLocatorToBinding(locator);
        await this.deps.commands.bind(binding);
        this.initialRuntimeAvailability = await this.deps.readRuntimeAvailability(binding);
        this.authorityMode = "server_authoritative";
        this.recovery = null;
      } catch (error) {
        this.deps.commands.bindCached(recovery);
        throw error;
      }
    } else {
      await this.deps.commands.reconnect({ canvasId: locator.canvasId });
      this.initialRuntimeAvailability = await this.deps.readRuntimeAvailability(
        workspaceCanvasLocatorToBinding(locator)
      );
    }
    return this.publishCurrent();
  }

  async resetRuntime(input: unknown): Promise<CanvasRuntimeResetOutcome> {
    const parsed = workspaceCanvasRuntimeResetInputSchema.parse(input);
    const locator = this.requireOpen(parsed.locator);
    if (this.authorityMode === "offline_cache_readonly") {
      throw sessionError("workspace_canvas_offline_execution_disabled");
    }
    this.assertConnection(locator);
    return this.deps.resetRuntime(parsed);
  }

  async initializeRuntime(input: unknown): Promise<CanvasRuntimeInitializeOutcome> {
    const parsed = workspaceCanvasRuntimeInitializeInputSchema.parse(input);
    const locator = this.requireOpen(parsed.locator);
    if (this.authorityMode === "offline_cache_readonly") {
      throw sessionError("workspace_canvas_offline_execution_disabled");
    }
    this.assertConnection(locator);
    return this.deps.initializeRuntime(parsed);
  }

  async close(input?: unknown): Promise<void> {
    if (this.locator === null) {
      this.authorityMode = "server_authoritative";
      this.recovery = null;
      this.initialRuntimeAvailability = null;
      this.deps.commands.releaseBinding();
      return;
    }
    if (input !== undefined) {
      this.requireOpen(input);
    }
    this.locator = null;
    this.authorityMode = "server_authoritative";
    this.recovery = null;
    this.initialRuntimeAvailability = null;
    this.deps.commands.releaseBinding();
  }

  current(): WorkspaceCanvasProjection | null {
    if (!this.locator) return null;
    try {
      return this.readProjection(this.locator);
    } catch {
      return null;
    }
  }

  publishIfOpen(): WorkspaceCanvasProjection | null {
    const projection = this.current();
    if (projection) this.deps.onProjection?.(projection);
    return projection;
  }

  private requireLocator(input: unknown): WorkspaceCanvasLocator {
    return workspaceCanvasLocatorSchema.parse(input);
  }

  private requireOpen(input: unknown): WorkspaceCanvasLocator {
    const locator = this.requireLocator(input);
    if (!this.locator) {
      throw sessionError("workspace_canvas_session_closed");
    }
    if (!locatorsEqual(this.locator, locator)) {
      throw sessionError("workspace_canvas_locator_mismatch");
    }
    return this.locator;
  }

  private assertConnection(locator: WorkspaceCanvasLocator): void {
    const connectedProfileId = this.deps.resolveConnectedProfileId();
    if (!connectedProfileId) {
      throw sessionError("collaboration_session_not_connected", true);
    }
    if (connectedProfileId !== locator.connectionProfileId) {
      throw sessionError("workspace_canvas_connection_mismatch");
    }
  }

  private cacheRecoveryAllowed(error: unknown): boolean {
    return (
      error instanceof CollaborationClientError &&
      (error.kind === "offline" || error.kind === "timeout")
    );
  }

  private projectionFromSubmit(
    result: CollaborationCanvasCommandSubmitResult
  ): WorkspaceCanvasProjection {
    const locator = this.locator;
    if (!locator) throw sessionError("workspace_canvas_session_closed");
    const outcome = result.outcome;
    const conflict =
      outcome.type === "canvas.command.rejected" &&
      outcome.code === "stale_revision" &&
      outcome.conflict
        ? {
            expectedRevision: outcome.conflict.expectedRevision,
            authoritativeRevision: outcome.conflict.authoritativeRevision,
            authoritativeContentDigest: outcome.conflict.authoritativeContentDigest
          }
        : (result.session?.lastConflict ?? null);
    const rejectCode =
      outcome.type === "canvas.command.rejected" && outcome.code !== "stale_revision"
        ? outcome.code
        : outcome.type === "canvas.command.rejected"
          ? null
          : (result.session?.lastRejectCode ?? null);
    return this.publishCurrent({ conflict, rejectCode });
  }

  private publishCurrent(overrides?: {
    conflict?: WorkspaceCanvasConflict | null;
    rejectCode?: string | null;
  }): WorkspaceCanvasProjection {
    const locator = this.locator;
    if (!locator) throw sessionError("workspace_canvas_session_closed");
    const projection = this.readProjection(locator, overrides);
    this.deps.onProjection?.(projection);
    return projection;
  }

  private readProjection(
    locator: WorkspaceCanvasLocator,
    overrides?: {
      conflict?: WorkspaceCanvasConflict | null;
      rejectCode?: string | null;
    }
  ): WorkspaceCanvasProjection {
    const replica = this.deps.commands.projectionForBinding(
      workspaceCanvasLocatorToBinding(locator)
    );
    if (!replica || !("bindingKind" in replica) || replica.bindingKind !== "remote") {
      throw sessionError("workspace_canvas_projection_unavailable", true);
    }
    const session = this.deps.commands.session();
    const conflict =
      overrides && "conflict" in overrides
        ? (overrides.conflict ?? null)
        : (session?.lastConflict ?? null);
    const rejectCode =
      overrides && "rejectCode" in overrides
        ? (overrides.rejectCode ?? null)
        : (session?.lastRejectCode ?? null);
    return workspaceCanvasProjectionSchema.parse({
      locator,
      status: workspaceCanvasProjectionStatus({
        optimisticOperationIds: replica.optimisticOperationIds,
        conflict,
        rejectCode
      }),
      authorityMode: this.authorityMode,
      readOnly: this.authorityMode === "offline_cache_readonly",
      cachedAt: this.recovery?.entry.cachedAt ?? null,
      conflict,
      rejectCode,
      initialRuntimeAvailability: this.initialRuntimeAvailability,
      replica
    });
  }
}
