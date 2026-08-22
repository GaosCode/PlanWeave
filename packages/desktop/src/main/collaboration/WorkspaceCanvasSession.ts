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

export type WorkspaceCanvasSessionCommands = {
  bind(input: CollaborationCanvasBindingInput): Promise<CollaborationCanvasCommandSessionView>;
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
  commands: WorkspaceCanvasSessionCommands;
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

  constructor(private readonly deps: WorkspaceCanvasSessionDeps) {}

  async open(input: unknown): Promise<WorkspaceCanvasProjection> {
    const locator = this.requireLocator(input);
    this.assertConnection(locator);
    const binding = workspaceCanvasLocatorToBinding(locator);
    await this.deps.commands.bind(binding);
    this.locator = locator;
    return this.publishCurrent();
  }

  async submit(input: unknown): Promise<WorkspaceCanvasProjection> {
    const parsed = workspaceCanvasCommandSubmitInputSchema.parse(input);
    const locator = this.requireOpen(parsed.locator);
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
    await this.deps.commands.reconnect({ canvasId: locator.canvasId });
    return this.publishCurrent();
  }

  async close(input?: unknown): Promise<void> {
    if (this.locator === null) {
      this.deps.commands.releaseBinding();
      return;
    }
    if (input !== undefined) {
      this.requireOpen(input);
    }
    this.locator = null;
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
      conflict,
      rejectCode,
      replica
    });
  }
}
