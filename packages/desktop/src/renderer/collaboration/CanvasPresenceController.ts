import type {
  CanvasPresencePointer,
  CanvasPresenceServerMessage,
  CanvasPresenceSession
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import {
  CANVAS_PRESENCE_MAX_SELECTION_IDS,
  CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasPresencePointerSchema,
  canvasPresenceSelectionIdSchema,
  canvasPresenceSessionSchema
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import type {
  CollaborationPresenceSignal,
  CollaborationPresenceUpdateInput,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";

export type CanvasPresenceBridge = Pick<
  PlanWeaveCollaborationApi,
  | "startCollaborationPresence"
  | "stopCollaborationPresence"
  | "publishCollaborationPresence"
  | "onCollaborationPresenceSignal"
  | "resolveCollaborationCanvasBindingScope"
>;

export type CanvasPresenceRemoteSession = {
  sessionId: string;
  humanPrincipalId: string;
  displayName: string;
  pointer: CanvasPresencePointer | null;
  selectionIds: string[];
};

export type CanvasPresenceSnapshot = {
  sessions: CanvasPresenceRemoteSession[];
  error: string | null;
};

export type CanvasPresenceScope = {
  profileId: string;
  canvasId: string;
};

export type CanvasPresenceLabels = {
  error: (code: string) => string;
};

type TrackedSession = CanvasPresenceRemoteSession;
type PresenceUpdate = CollaborationPresenceUpdateInput;

const EMPTY_SNAPSHOT: CanvasPresenceSnapshot = { sessions: [], error: null };

function cleanPointer(value: unknown): CanvasPresencePointer | null {
  const parsed = canvasPresencePointerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function cleanSelectionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = canvasPresenceSelectionIdSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data)) continue;
    const id = parsed.data;
    seen.add(id);
    ids.push(id);
    if (ids.length >= CANVAS_PRESENCE_MAX_SELECTION_IDS) break;
  }
  return ids;
}

function sanitizeSession(session: CanvasPresenceSession): CanvasPresenceRemoteSession | null {
  const parsed = canvasPresenceSessionSchema.safeParse(session);
  if (!parsed.success) return null;
  return {
    sessionId: parsed.data.identity.sessionId,
    humanPrincipalId: parsed.data.identity.humanPrincipalId,
    displayName: parsed.data.identity.displayName,
    pointer: parsed.data.pointer,
    selectionIds: parsed.data.selectionIds
  };
}

function sameScope(message: CanvasPresenceServerMessage, scope: CanvasPresenceScope): boolean {
  return message.canvasId === scope.canvasId;
}

function toErrorMessage(
  message: Extract<CanvasPresenceServerMessage, { type: "canvas.presence.error" }>,
  labels: CanvasPresenceLabels
): string {
  return labels.error(message.code);
}

/**
 * Renderer read model for one ephemeral canvas presence scope.
 * Sole owner of local presence replay after reconnect: latestUpdate/pendingUpdate
 * are flushed when the next snapshot (or peer update) proves the socket is live.
 * Main-process CollaborationPresenceSession must not also re-publish last state.
 */
export class CanvasPresenceController {
  private readonly api: CanvasPresenceBridge;
  private readonly labels: CanvasPresenceLabels;
  private scope: CanvasPresenceScope | null = null;
  private sessions = new Map<string, TrackedSession>();
  private listeners = new Set<(snapshot: CanvasPresenceSnapshot) => void>();
  private unsubscribeSignal: (() => void) | null = null;
  private connected = false;
  private latestUpdate: PresenceUpdate | null = null;
  private pendingUpdate: PresenceUpdate | null = null;
  private generation = 0;
  private snapshot: CanvasPresenceSnapshot = EMPTY_SNAPSHOT;

  constructor(options: { api: CanvasPresenceBridge; labels: CanvasPresenceLabels }) {
    this.api = options.api;
    this.labels = options.labels;
  }

  getSnapshot(): CanvasPresenceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: CanvasPresenceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(scope: CanvasPresenceScope): Promise<void> {
    if (this.scope?.profileId === scope.profileId && this.scope.canvasId === scope.canvasId) {
      return;
    }
    await this.stop();
    const generation = ++this.generation;
    this.scope = { ...scope };
    this.connected = false;
    this.latestUpdate = null;
    this.pendingUpdate = null;
    this.unsubscribeSignal = this.api.onCollaborationPresenceSignal((signal) => {
      if (generation !== this.generation) return;
      this.handleSignal(signal);
    });
    try {
      await this.api.startCollaborationPresence({ canvasId: scope.canvasId });
    } catch (error) {
      if (generation !== this.generation) return;
      this.connected = false;
      this.publishSnapshot({
        sessions: [],
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.scope = null;
    this.connected = false;
    this.latestUpdate = null;
    this.pendingUpdate = null;
    this.unsubscribeSignal?.();
    this.unsubscribeSignal = null;
    this.sessions.clear();
    this.publishSnapshot(EMPTY_SNAPSHOT);
    try {
      await this.api.stopCollaborationPresence();
    } catch {
      // Main process may already have stopped the socket during disconnect.
    }
  }

  async publish(input: CollaborationPresenceUpdateInput): Promise<void> {
    const update = {
      pointer: cleanPointer(input.pointer),
      selectionIds: cleanSelectionIds(input.selectionIds)
    };
    this.latestUpdate = update;
    if (!this.connected) {
      this.pendingUpdate = update;
      return;
    }
    try {
      await this.api.publishCollaborationPresence(update);
    } catch (error) {
      // Transport may already be down; keep the update for the next snapshot/reconnect flush.
      this.connected = false;
      this.pendingUpdate = update;
      this.publishSnapshot({
        sessions: this.readSessions(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private handleSignal(signal: CollaborationPresenceSignal): void {
    const scope = this.scope;
    if (!scope || signal.profileId !== scope.profileId) return;
    if ("reset" in signal) {
      if (signal.reset.canvasId !== scope.canvasId) return;
      this.connected = false;
      this.pendingUpdate = this.latestUpdate;
      this.sessions.clear();
      this.publishSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    const message = signal.message;
    if (!sameScope(message, scope)) return;
    switch (message.type) {
      case "canvas.presence.snapshot": {
        const wasConnected = this.connected;
        this.connected = true;
        this.sessions.clear();
        for (const session of message.sessions) this.upsertSession(session);
        this.publishSnapshot({ sessions: this.readSessions(), error: null });
        // First snapshot after bind/reconnect: re-announce last local pointer/selection.
        if (!wasConnected || this.pendingUpdate) void this.flushPendingUpdate();
        return;
      }
      case "canvas.presence.update": {
        const wasConnected = this.connected;
        this.connected = true;
        this.upsertSession(message.session);
        this.publishSnapshot({ sessions: this.readSessions(), error: null });
        // Peer traffic can prove connectivity after a soft error reset without a new snapshot.
        if (!wasConnected && this.pendingUpdate) void this.flushPendingUpdate();
        return;
      }
      case "canvas.presence.leave":
        this.sessions.delete(message.sessionId);
        this.publishSnapshot({ sessions: this.readSessions(), error: null });
        return;
      case "canvas.presence.error":
        this.connected = false;
        this.pendingUpdate = this.latestUpdate;
        this.sessions.clear();
        this.publishSnapshot({ sessions: [], error: toErrorMessage(message, this.labels) });
        return;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  private async flushPendingUpdate(): Promise<void> {
    const pending = this.pendingUpdate;
    if (!this.connected || !pending) return;
    this.pendingUpdate = null;
    try {
      await this.api.publishCollaborationPresence(pending);
    } catch (error) {
      this.pendingUpdate = pending;
      this.publishSnapshot({
        sessions: this.readSessions(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private upsertSession(session: CanvasPresenceSession): void {
    const scope = this.scope;
    if (!scope) return;
    const sanitized = sanitizeSession(session);
    if (!sanitized) return;
    if (
      !this.sessions.has(sanitized.sessionId) &&
      this.sessions.size >= CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS
    ) {
      return;
    }
    this.sessions.set(sanitized.sessionId, sanitized);
  }

  private readSessions(): CanvasPresenceRemoteSession[] {
    return [...this.sessions.values()];
  }

  private publishSnapshot(next: CanvasPresenceSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener(next);
  }
}
