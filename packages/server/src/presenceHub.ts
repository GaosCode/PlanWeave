import { randomUUID } from "node:crypto";
import {
  CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS,
  CANVAS_PRESENCE_MAX_UPDATES_PER_SECOND,
  CANVAS_PRESENCE_SESSION_TTL_MS
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasPresenceSessionIdSchema,
  canvasPresenceSessionSchema,
  type CanvasPresencePointer,
  type CanvasPresenceServerTrace,
  type CanvasPresenceServerMessage,
  type CanvasPresenceSession,
  type CanvasPresenceSessionId
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import {
  humanProjectIdSchema,
  opaqueIdentifierSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";

export type CanvasPresenceScope = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

export type CanvasPresenceHubErrorCode =
  | "capacity_exceeded"
  | "cross_scope"
  | "rate_limited"
  | "server_error";

export class CanvasPresenceHubError extends Error {
  constructor(readonly code: CanvasPresenceHubErrorCode) {
    super(`canvas_presence_${code}`);
    this.name = "CanvasPresenceHubError";
  }
}

export type CanvasPresenceHubSession = {
  session: CanvasPresenceSession;
  scope: CanvasPresenceScope;
  expiresAt: number;
};

export type CanvasPresenceHubConnectInput = {
  scope: CanvasPresenceScope;
  humanPrincipalId: string;
  displayName: string;
  send(message: CanvasPresenceServerMessage): void;
  onRemoved?: (reason: CanvasPresenceRemovalReason) => void;
};

export type CanvasPresenceRemovalReason =
  | "leave"
  | "disconnect"
  | "revoked"
  | "expired"
  | "shutdown";

type HubEntry = {
  scope: CanvasPresenceScope;
  session: CanvasPresenceSession;
  send: (message: CanvasPresenceServerMessage) => void;
  onRemoved?: (reason: CanvasPresenceRemovalReason) => void;
  expiresAt: number;
  tokens: number;
  lastRefillAt: number;
};

export type CanvasPresenceHubOptions = {
  clock?: () => number;
  ttlMs?: number;
  maxSessionsPerCanvas?: number;
  maxUpdatesPerSecond?: number;
  cleanupIntervalMs?: number;
  setIntervalFn?: (handler: () => void, timeout: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
  sessionId?: () => string;
};

const scopeKey = ({ workspaceId, projectId, canvasId }: CanvasPresenceScope): string =>
  `${workspaceId}\u0000${projectId}\u0000${canvasId}`;

function validateScope(scope: CanvasPresenceScope): CanvasPresenceScope {
  return {
    workspaceId: workspaceIdSchema.parse(scope.workspaceId),
    projectId: humanProjectIdSchema.parse(scope.projectId),
    canvasId: opaqueIdentifierSchema.parse(scope.canvasId)
  };
}

export class CanvasPresenceHub {
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly maxSessionsPerCanvas: number;
  private readonly maxUpdatesPerSecond: number;
  private readonly sessions = new Map<CanvasPresenceSessionId, HubEntry>();
  private readonly sessionsByScope = new Map<string, Set<CanvasPresenceSessionId>>();
  private readonly sessionId: () => string;
  private readonly clearIntervalFn: (timer: ReturnType<typeof setInterval>) => void;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: CanvasPresenceHubOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? CANVAS_PRESENCE_SESSION_TTL_MS;
    this.maxSessionsPerCanvas =
      options.maxSessionsPerCanvas ?? CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS;
    this.maxUpdatesPerSecond =
      options.maxUpdatesPerSecond ?? CANVAS_PRESENCE_MAX_UPDATES_PER_SECOND;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error("canvas_presence_ttl_invalid");
    }
    if (!Number.isSafeInteger(this.maxSessionsPerCanvas) || this.maxSessionsPerCanvas < 1) {
      throw new Error("canvas_presence_capacity_invalid");
    }
    if (!Number.isSafeInteger(this.maxUpdatesPerSecond) || this.maxUpdatesPerSecond < 1) {
      throw new Error("canvas_presence_rate_invalid");
    }
    this.sessionId = options.sessionId ?? randomUUID;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? Math.min(this.ttlMs, 1_000);
    if (!Number.isFinite(cleanupIntervalMs) || cleanupIntervalMs <= 0) {
      throw new Error("canvas_presence_cleanup_interval_invalid");
    }
    const setIntervalFn = options.setIntervalFn ?? setInterval;
    this.cleanupTimer = setIntervalFn(() => this.cleanupExpired(), cleanupIntervalMs);
  }

  connect(input: CanvasPresenceHubConnectInput): {
    session: CanvasPresenceSession;
    snapshot: CanvasPresenceSession[];
  } {
    if (this.closed) throw new CanvasPresenceHubError("server_error");
    const scope = validateScope(input.scope);
    const workspaceId = scope.workspaceId;
    const projectId = scope.projectId;
    const canvasId = scope.canvasId;
    const key = scopeKey(scope);
    const scoped = this.sessionsByScope.get(key);
    if ((scoped?.size ?? 0) >= this.maxSessionsPerCanvas) {
      throw new CanvasPresenceHubError("capacity_exceeded");
    }
    const snapshot = this.snapshot(scope);
    const now = this.clock();
    let parsedSessionId: CanvasPresenceSessionId | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = canvasPresenceSessionIdSchema.parse(this.sessionId());
      if (!this.sessions.has(candidate)) {
        parsedSessionId = candidate;
        break;
      }
    }
    if (!parsedSessionId) throw new CanvasPresenceHubError("server_error");
    const session = canvasPresenceSessionSchema.parse({
      identity: {
        sessionId: parsedSessionId,
        humanPrincipalId: input.humanPrincipalId,
        displayName: input.displayName
      },
      pointer: null,
      selectionIds: []
    });
    const entry: HubEntry = {
      scope: { workspaceId, projectId, canvasId },
      session,
      send: input.send,
      onRemoved: input.onRemoved,
      expiresAt: now + this.ttlMs,
      tokens: this.maxUpdatesPerSecond,
      lastRefillAt: now
    };
    this.sessions.set(session.identity.sessionId, entry);
    (scoped ?? this.createScopeSet(key)).add(session.identity.sessionId);
    return { session, snapshot };
  }

  update(
    sessionId: CanvasPresenceSessionId,
    scopeInput: CanvasPresenceScope,
    pointer: CanvasPresencePointer | null,
    selectionIds: string[],
    trace?: CanvasPresenceServerTrace
  ): CanvasPresenceSession {
    if (this.closed) throw new CanvasPresenceHubError("server_error");
    const entry = this.sessions.get(canvasPresenceSessionIdSchema.parse(sessionId));
    if (!entry) throw new CanvasPresenceHubError("server_error");
    const scope = validateScope(scopeInput);
    if (scopeKey(scope) !== scopeKey(entry.scope)) {
      throw new CanvasPresenceHubError("cross_scope");
    }
    const now = this.clock();
    this.refill(entry, now);
    if (entry.tokens < 1) throw new CanvasPresenceHubError("rate_limited");
    entry.tokens -= 1;
    entry.expiresAt = now + this.ttlMs;
    entry.session = canvasPresenceSessionSchema.parse({
      identity: entry.session.identity,
      pointer,
      selectionIds
    });
    const message: CanvasPresenceServerMessage = {
      type: "canvas.presence.update",
      protocolVersion: 1,
      projectId: entry.scope.projectId,
      canvasId: entry.scope.canvasId,
      session: entry.session,
      ...(trace ? { trace } : {})
    };
    this.fanout(entry.scope, message, entry.session.identity.sessionId);
    return entry.session;
  }

  /** Refreshes liveness without changing pointer or selection state. */
  touch(sessionId: CanvasPresenceSessionId, now = this.clock()): void {
    if (this.closed) throw new CanvasPresenceHubError("server_error");
    const entry = this.sessions.get(canvasPresenceSessionIdSchema.parse(sessionId));
    if (!entry) throw new CanvasPresenceHubError("server_error");
    entry.expiresAt = now + this.ttlMs;
  }

  leave(
    sessionId: CanvasPresenceSessionId,
    reason: CanvasPresenceRemovalReason = "leave"
  ): boolean {
    const id = canvasPresenceSessionIdSchema.parse(sessionId);
    const entry = this.sessions.get(id);
    if (!entry) return false;
    this.remove(entry, reason);
    return true;
  }

  removeWhere(
    predicate: (session: CanvasPresenceHubSession) => boolean,
    reason: Exclude<CanvasPresenceRemovalReason, "leave" | "disconnect"> = "revoked"
  ): number {
    const entries = [...this.sessions.values()].filter((entry) =>
      predicate({ session: entry.session, scope: entry.scope, expiresAt: entry.expiresAt })
    );
    for (const entry of entries) this.remove(entry, reason);
    return entries.length;
  }

  cleanupExpired(now = this.clock()): number {
    const expired = [...this.sessions.values()].filter((entry) => entry.expiresAt <= now);
    for (const entry of expired) this.remove(entry, "expired");
    return expired.length;
  }

  snapshot(scopeInput: CanvasPresenceScope): CanvasPresenceSession[] {
    const scope = validateScope(scopeInput);
    const ids = this.sessionsByScope.get(scopeKey(scope));
    if (!ids) return [];
    return [...ids]
      .map((id) => this.sessions.get(id)?.session)
      .filter((session): session is CanvasPresenceSession => session !== undefined)
      .map((session) => ({
        identity: { ...session.identity },
        pointer: session.pointer ? { ...session.pointer } : null,
        selectionIds: [...session.selectionIds]
      }));
  }

  size(): number {
    return this.sessions.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer !== undefined) {
      this.clearIntervalFn(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    for (const entry of [...this.sessions.values()]) this.remove(entry, "shutdown");
    this.sessions.clear();
    this.sessionsByScope.clear();
  }

  private createScopeSet(key: string): Set<CanvasPresenceSessionId> {
    const scoped = new Set<CanvasPresenceSessionId>();
    this.sessionsByScope.set(key, scoped);
    return scoped;
  }

  private refill(entry: HubEntry, now: number): void {
    const elapsed = Math.max(0, now - entry.lastRefillAt);
    entry.tokens = Math.min(
      this.maxUpdatesPerSecond,
      entry.tokens + (elapsed / 1_000) * this.maxUpdatesPerSecond
    );
    entry.lastRefillAt = now;
  }

  private remove(entry: HubEntry, reason: CanvasPresenceRemovalReason): void {
    const id = entry.session.identity.sessionId;
    if (this.sessions.get(id) !== entry) return;
    this.sessions.delete(id);
    const key = scopeKey(entry.scope);
    const scoped = this.sessionsByScope.get(key);
    scoped?.delete(id);
    if (scoped?.size === 0) this.sessionsByScope.delete(key);
    const leave: CanvasPresenceServerMessage = {
      type: "canvas.presence.leave",
      protocolVersion: 1,
      projectId: entry.scope.projectId,
      canvasId: entry.scope.canvasId,
      sessionId: id
    };
    this.fanout(entry.scope, leave);
    entry.onRemoved?.(reason);
  }

  private fanout(
    scope: CanvasPresenceScope,
    message: CanvasPresenceServerMessage,
    exclude?: CanvasPresenceSessionId
  ): void {
    const ids = this.sessionsByScope.get(scopeKey(scope));
    if (!ids) return;
    for (const id of ids) {
      if (id === exclude) continue;
      const entry = this.sessions.get(id);
      if (!entry) continue;
      try {
        entry.send(message);
      } catch {
        this.remove(entry, "disconnect");
      }
    }
  }
}
