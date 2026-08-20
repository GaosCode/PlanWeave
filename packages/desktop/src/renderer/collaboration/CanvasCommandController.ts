import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import type {
  CollaborationCanvasBindingInput,
  CollaborationCanvasCommandSessionView,
  CollaborationCanvasCommandSubmitResult,
  CollaborationCanvasReconnectResult,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { isCollaborationConnectionUnavailable } from "./formatCollaborationError.js";

export type CanvasCommandBridge = Pick<
  PlanWeaveCollaborationApi,
  | "submitCollaborationCanvasCommand"
  | "reconnectCollaborationCanvas"
  | "bindCollaborationCanvasBindingSession"
  | "getCollaborationCanvasCommandSession"
>;

export type CanvasCommandControllerSnapshot = {
  session: CollaborationCanvasCommandSessionView | null;
  connectionPhase: "idle" | "connecting" | "connected" | "disconnected";
  lastError: string | null;
  lastStaleConflict: CollaborationCanvasCommandSessionView["lastConflict"] | null;
  busy: boolean;
};

export type CanvasCommandLabels = {
  staleRevision: (expected: number, authoritative: number) => string;
  rejected: (code: string) => string;
  reconnectFailed: (code: string) => string;
  notConnected: string;
};

const EMPTY: CanvasCommandControllerSnapshot = {
  session: null,
  connectionPhase: "idle",
  lastError: null,
  lastStaleConflict: null,
  busy: false
};

function sessionsEqual(
  left: CollaborationCanvasCommandSessionView | null,
  right: CollaborationCanvasCommandSessionView | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.canvasId === right.canvasId &&
    left.revision === right.revision &&
    left.contentDigest === right.contentDigest &&
    left.lastOperationId === right.lastOperationId &&
    left.lastJournalEntryId === right.lastJournalEntryId &&
    left.pendingOperationId === right.pendingOperationId &&
    left.lastRejectCode === right.lastRejectCode &&
    left.lastConflict?.expectedRevision === right.lastConflict?.expectedRevision &&
    left.lastConflict?.authoritativeRevision === right.lastConflict?.authoritativeRevision &&
    left.lastConflict?.authoritativeContentDigest === right.lastConflict?.authoritativeContentDigest
  );
}

function snapshotsEqual(
  left: CanvasCommandControllerSnapshot,
  right: CanvasCommandControllerSnapshot
): boolean {
  return (
    sessionsEqual(left.session, right.session) &&
    left.connectionPhase === right.connectionPhase &&
    left.lastError === right.lastError &&
    left.lastStaleConflict?.expectedRevision === right.lastStaleConflict?.expectedRevision &&
    left.lastStaleConflict?.authoritativeRevision ===
      right.lastStaleConflict?.authoritativeRevision &&
    left.lastStaleConflict?.authoritativeContentDigest ===
      right.lastStaleConflict?.authoritativeContentDigest &&
    left.busy === right.busy
  );
}

/**
 * Renderer controller for shared-mode durable canvas mutations.
 * Submits typed intents only; never writes package files directly.
 * CAS conflicts are surfaced without guessing a merged revision.
 */
export class CanvasCommandController {
  private readonly api: CanvasCommandBridge;
  private readonly labels: CanvasCommandLabels;
  private snapshot: CanvasCommandControllerSnapshot = EMPTY;
  private readonly listeners = new Set<(snapshot: CanvasCommandControllerSnapshot) => void>();
  private canvasId: string | null = null;
  private bindingPromise: Promise<void> | null = null;
  private generation = 0;

  constructor(options: { api: CanvasCommandBridge; labels: CanvasCommandLabels }) {
    this.api = options.api;
    this.labels = options.labels;
  }

  subscribe(listener: (snapshot: CanvasCommandControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): CanvasCommandControllerSnapshot {
    return this.snapshot;
  }

  bind(input: CollaborationCanvasBindingInput): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.canvasId = null;
    this.patch({
      connectionPhase: "connecting",
      busy: true,
      lastError: null,
      lastStaleConflict: null
    });
    let tracked: Promise<void>;
    tracked = this.bindAndReconnect(input, generation).finally(() => {
      if (this.bindingPromise === tracked) this.bindingPromise = null;
    });
    this.bindingPromise = tracked;
    return tracked;
  }

  async unbind(): Promise<void> {
    this.generation += 1;
    this.canvasId = null;
    this.bindingPromise = null;
    this.patch({ ...EMPTY });
  }

  /**
   * Submit a typed intent. On acceptance, session revision advances.
   * On stale_revision, surfaces conflict and does not invent a retry revision.
   */
  async submit(input: {
    intent: CanvasCommandIntent;
  }): Promise<CollaborationCanvasCommandSubmitResult> {
    const binding = this.bindingPromise;
    if (binding) await binding;
    const canvasId = this.canvasId;
    if (!canvasId || this.snapshot.connectionPhase !== "connected" || this.snapshot.lastError) {
      throw new Error(this.snapshot.lastError ?? this.labels.notConnected);
    }
    this.patch({ busy: true, lastError: null, lastStaleConflict: null });
    try {
      const result = await this.api.submitCollaborationCanvasCommand({
        canvasId,
        intent: input.intent
      });
      if (result.outcome.type === "canvas.command.rejected") {
        if (result.outcome.code === "stale_revision" && result.outcome.conflict) {
          this.patch({
            session: result.session,
            connectionPhase: "connected",
            busy: false,
            lastStaleConflict: result.outcome.conflict,
            lastError: this.labels.staleRevision(
              result.outcome.conflict.expectedRevision,
              result.outcome.conflict.authoritativeRevision
            )
          });
        } else {
          this.patch({
            session: result.session,
            connectionPhase: "connected",
            busy: false,
            lastError: this.labels.rejected(result.outcome.code)
          });
        }
      } else {
        this.patch({
          session: result.session,
          connectionPhase: "connected",
          busy: false,
          lastError: null,
          lastStaleConflict: null
        });
      }
      return result;
    } catch (error) {
      if (isCollaborationConnectionUnavailable(error)) {
        this.patch({ connectionPhase: "disconnected", busy: false, lastError: null });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ busy: false, lastError: message });
      throw error;
    }
  }

  async reconnect(
    input?: {
      canvasId?: string;
      afterRevision?: number;
      afterContentDigest?: string;
    },
    options?: { background?: boolean }
  ): Promise<CollaborationCanvasReconnectResult> {
    const canvasId = input?.canvasId ?? this.canvasId;
    if (!canvasId) {
      throw new Error(this.labels.notConnected);
    }
    this.canvasId = canvasId;
    if (!options?.background) {
      this.patch({ connectionPhase: "connecting", busy: true, lastError: null });
    }
    try {
      const result = await this.api.reconnectCollaborationCanvas({
        canvasId,
        afterRevision: input?.afterRevision,
        afterContentDigest: input?.afterContentDigest
      });
      if (result.response.type === "canvas.reconnect.error") {
        this.patch({
          session: result.session,
          connectionPhase: "connected",
          busy: false,
          lastError: this.labels.reconnectFailed(result.response.code)
        });
      } else {
        this.patch({
          session: result.session,
          connectionPhase: "connected",
          busy: false,
          lastError: null,
          lastStaleConflict: null
        });
      }
      return result;
    } catch (error) {
      if (isCollaborationConnectionUnavailable(error)) {
        this.patch({ connectionPhase: "disconnected", busy: false, lastError: null });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ busy: false, lastError: message });
      throw error;
    }
  }

  /**
   * Poll without emitting transient busy states. Expected transport failures
   * move the command channel offline; other failures remain visible.
   */
  async reconnectInBackground(): Promise<CollaborationCanvasReconnectResult | null> {
    try {
      return await this.reconnect(undefined, { background: true });
    } catch {
      return null;
    }
  }

  reportRefreshFailure(error: unknown): void {
    this.patch({
      busy: false,
      lastError: error instanceof Error ? error.message : String(error)
    });
  }

  private async bindAndReconnect(
    input: CollaborationCanvasBindingInput,
    generation: number
  ): Promise<void> {
    try {
      const session = await this.api.bindCollaborationCanvasBindingSession(input);
      if (generation !== this.generation) return;
      if (!session) throw new Error(this.labels.notConnected);
      this.canvasId = session.canvasId;
      this.patch({ session, connectionPhase: "connecting" });
      // Align the local materialization and CAS revision with the authoritative head
      // before allowing the first mutation through this controller.
      await this.reconnect({ canvasId: session.canvasId });
    } catch (error) {
      if (generation !== this.generation) return;
      const connectionUnavailable = isCollaborationConnectionUnavailable(error);
      if (!connectionUnavailable) this.canvasId = null;
      this.patch({
        connectionPhase: connectionUnavailable ? "disconnected" : "idle",
        busy: false,
        lastError: connectionUnavailable
          ? null
          : error instanceof Error
            ? error.message
            : String(error)
      });
    }
  }

  private patch(partial: Partial<CanvasCommandControllerSnapshot>): void {
    const next = { ...this.snapshot, ...partial };
    if (snapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
