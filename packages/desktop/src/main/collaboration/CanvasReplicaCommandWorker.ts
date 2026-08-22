import { randomUUID } from "node:crypto";
import type {
  CanvasCommandAccepted,
  CanvasCommandIntent,
  CanvasCommandOutcome,
  CanvasJournalEntry,
  CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import type { CanvasReplicaPendingOperation, CanvasReplicaScope } from "./CanvasReplicaStore.js";
import { CanvasReplicaStore } from "./CanvasReplicaStore.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import { reconnectDelay, type ReconnectBackoffOptions } from "./reconnectBackoff.js";

export type CanvasReplicaCommandTransport = {
  /**
   * First baseline: reconnect(afterRevision: 0) → require snapshot → download
   * only the snapshot's immutable content ref. Never discover a separate content head.
   */
  fetchReconnectBaseline(scope: CanvasReplicaScope): Promise<{
    response: Extract<CanvasReconnectResponse, { type: "canvas.reconnect.snapshot" }>;
    content: CompleteContentVersion;
  }>;
  reconnect(
    scope: CanvasReplicaScope,
    input: { afterRevision: number; afterContentDigest: string | null }
  ): Promise<{
    response: CanvasReconnectResponse;
    snapshotContent?: CompleteContentVersion;
  }>;
  canPersistCanvasCommand(scope: CanvasReplicaScope): Promise<boolean>;
  submit(input: {
    scope: CanvasReplicaScope;
    operationId: string;
    expectedRevision: number;
    intent: CanvasCommandIntent;
  }): Promise<CanvasCommandOutcome>;
};

export type CanvasReplicaCommandWorkerOptions = {
  /** Deterministic delay for tests; cancelled when the returned promise's cancel runs. */
  sleep?: (ms: number, isCancelled: () => boolean) => Promise<void>;
  random?: () => number;
  backoff?: ReconnectBackoffOptions;
};

/**
 * entryApplied: this live entry was folded / confirmed into the replica (or was a no-op duplicate).
 * materializedHead: store head after this call — used to advance the WebSocket hello cursor.
 *   Present after a successful entry apply OR after HTTP catch-up recovery installed a new head.
 *   Does not by itself prove a pending command's operationId was accepted by the Server.
 */
export type CanvasReplicaLiveApplyResult = {
  readonly entryApplied: boolean;
  readonly materializedHead: { readonly revision: number; readonly contentDigest: string } | null;
  readonly reason?: "ignored" | "recovered" | "failed";
};

type Queued = {
  operationId: string;
  intent: CanvasCommandIntent;
  resolve: (outcome: CanvasCommandOutcome) => void;
  reject: (error: Error) => void;
  settled: boolean;
  /** Workspace sessions surface stale CAS instead of silently retrying the intent. */
  retryStale: boolean;
};

type DelayHandle = { cancel: () => void };

function disconnectedError(): CollaborationClientError {
  return new CollaborationClientError({
    kind: "aborted",
    code: "canvas_replica_session_disconnected",
    message: "canvas_replica_session_disconnected",
    retryable: false
  });
}

function forbiddenError(): CollaborationClientError {
  return new CollaborationClientError({
    kind: "forbidden",
    code: "canvas_replica_command_forbidden",
    message: "canvas_replica_command_forbidden",
    retryable: false
  });
}

function settleReject(item: Queued, error: Error): void {
  if (item.settled) return;
  item.settled = true;
  item.reject(error);
}

function settleResolve(item: Queued, outcome: CanvasCommandOutcome): void {
  if (item.settled) return;
  item.settled = true;
  item.resolve(outcome);
}

function acceptedFromEntry(entry: CanvasJournalEntry): CanvasCommandAccepted {
  return {
    type: "canvas.command.accepted",
    protocolVersion: 1,
    schemaVersion: "canvas-command/v1",
    scope: entry.scope,
    operationId: entry.operationId,
    revision: entry.revision,
    previousRevision: entry.previousRevision,
    contentDigest: entry.contentDigest,
    journalEntryId: entry.entryId,
    actor: entry.actor,
    acceptedAt: entry.acceptedAt,
    idempotentReplay: true
  };
}

function defaultSleep(ms: number, isCancelled: () => boolean): Promise<void> {
  if (ms <= 0 || isCancelled()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const poll = setInterval(() => {
      if (isCancelled()) finish();
    }, 25);
    timer.unref?.();
    poll.unref?.();
  });
}

/**
 * Per-authority-scope FIFO command worker.
 * Renderer never supplies operationId or expectedRevision — both are main-process owned.
 * Optimistic pending is published before any network await; network submits are serial.
 */
export class CanvasReplicaCommandWorker {
  private readonly queues = new Map<string, Queued[]>();
  private readonly running = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly scopes = new Map<string, CanvasReplicaScope>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly delays = new Map<string, DelayHandle>();
  /** Serializes live-entry apply + reconnect recovery per scope (no concurrent install races). */
  private readonly serialChains = new Map<string, Promise<unknown>>();
  private readonly sleep: (ms: number, isCancelled: () => boolean) => Promise<void>;
  private readonly random: () => number;
  private readonly backoffOptions: ReconnectBackoffOptions;

  constructor(
    private readonly store: CanvasReplicaStore,
    private readonly transport: CanvasReplicaCommandTransport,
    options: CanvasReplicaCommandWorkerOptions = {}
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.backoffOptions = options.backoff ?? {
      initialDelayMs: 200,
      maxDelayMs: 30_000
    };
  }

  private enqueueSerial<T>(scopeKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.serialChains.get(scopeKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.serialChains.set(
      scopeKey,
      current.then(
        () => undefined,
        () => undefined
      )
    );
    return current;
  }

  /**
   * Transactional bind: incomplete baseline/permission work is rolled back so the
   * scope is not left half-initialized. Callers still own Facade binding updates.
   */
  async bind(scope: CanvasReplicaScope): Promise<void> {
    const scopeKey = this.key(scope);
    this.bumpGeneration(scopeKey);
    this.rejectQueue(scopeKey, disconnectedError());
    this.store.clear(scope);
    this.store.bind(scope);
    this.scopes.set(scopeKey, scope);

    const generation = this.generations.get(scopeKey) ?? 0;
    try {
      const [baseline, canEdit] = await Promise.all([
        this.transport.fetchReconnectBaseline(scope),
        this.transport.canPersistCanvasCommand(scope)
      ]);
      if (!this.isCurrent(scopeKey, generation)) {
        throw disconnectedError();
      }

      const { response, content } = baseline;
      if (
        response.snapshot.metadata.scope.workspaceId !== scope.workspaceId ||
        response.snapshot.metadata.scope.projectId !== scope.projectId ||
        response.snapshot.metadata.scope.canvasId !== scope.canvasId ||
        response.scope.workspaceId !== scope.workspaceId ||
        response.scope.projectId !== scope.projectId ||
        response.scope.canvasId !== scope.canvasId
      ) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "canvas_replica_scope_mismatch",
          message: "canvas_replica_scope_mismatch"
        });
      }
      if (
        content.canonicalDigest !== response.snapshot.metadata.contentDigest ||
        content.canonicalDigest !== response.snapshot.content.canonicalDigest ||
        response.snapshot.content.versionId.length === 0
      ) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "canvas_replica_snapshot_content_mismatch",
          message: "canvas_replica_snapshot_content_mismatch",
          retryable: true
        });
      }

      this.store.installBaseline(scope, {
        content,
        revision: response.snapshot.metadata.revision,
        contentDigest: response.snapshot.metadata.contentDigest
      });
      this.store.setCanEdit(scope, canEdit);
      this.resetBackoff(scopeKey);
    } catch (error) {
      // Roll back half-open bind so the next attempt starts clean.
      if (this.isCurrent(scopeKey, generation)) {
        this.bumpGeneration(scopeKey);
        this.rejectQueue(scopeKey, disconnectedError());
        this.scopes.delete(scopeKey);
        this.store.clear(scope);
      }
      throw error;
    }
  }

  /**
   * Synchronously enqueue optimistic pending + publish, then return a Promise for network outcome.
   * Must not await the network before the optimistic projection is published.
   */
  submit(
    scope: CanvasReplicaScope,
    intent: CanvasCommandIntent,
    options?: { retryStale?: boolean }
  ): Promise<CanvasCommandOutcome> {
    if (!this.store.has(scope) || !this.scopes.has(this.key(scope))) {
      return Promise.reject(
        new CollaborationClientError({
          kind: "aborted",
          code: "canvas_replica_scope_unbound",
          message: "canvas_replica_scope_unbound"
        })
      );
    }
    if (!this.store.canEdit(scope)) {
      return Promise.reject(forbiddenError());
    }
    const operationId = `op-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    // enqueue is atomic: invalid intents throw without leaving ghost pending.
    this.store.enqueue(scope, { operationId, intent });
    return new Promise((resolve, reject) => {
      const scopeKey = this.key(scope);
      const queue = this.queues.get(scopeKey) ?? [];
      queue.push({
        operationId,
        intent,
        resolve,
        reject,
        settled: false,
        retryStale: options?.retryStale !== false
      });
      this.queues.set(scopeKey, queue);
      void this.run(scope);
    });
  }

  async reconnect(
    scope: CanvasReplicaScope,
    input?: { afterRevision?: number; afterContentDigest?: string | null }
  ): Promise<CanvasReconnectResponse> {
    const scopeKey = this.key(scope);
    return this.enqueueSerial(scopeKey, async () => {
      const generation = this.generations.get(scopeKey) ?? 0;
      const afterRevision = input?.afterRevision ?? this.store.revision(scope);
      const afterContentDigest =
        input?.afterContentDigest !== undefined
          ? input.afterContentDigest
          : this.store.digest(scope);
      const result = await this.installReconnect(
        scope,
        scopeKey,
        generation,
        {
          afterRevision,
          afterContentDigest
        },
        { forceSnapshotOnMaterializeFailure: true }
      );
      if (!result) throw disconnectedError();
      this.rejectDropped(scopeKey, result.droppedPending);
      this.confirmQueueFromReconnectEntries(scopeKey, result.response);
      return result.response;
    });
  }

  /**
   * Fold one Server-broadcast accepted journal entry into the replica.
   * Serialized per scope with reconnect recovery. Own operationIds confirm pending at most once.
   * Returns applied=true only when the store committed the entry (caller may advance live cursor).
   */
  async applyLiveEntry(
    scope: CanvasReplicaScope,
    entry: CanvasJournalEntry
  ): Promise<CanvasReplicaLiveApplyResult> {
    const scopeKey = this.key(scope);
    return this.enqueueSerial(scopeKey, async () => {
      if (!this.scopes.has(scopeKey) || !this.store.has(scope)) {
        return { entryApplied: false, materializedHead: null, reason: "ignored" };
      }
      const generation = this.generations.get(scopeKey) ?? 0;
      if (
        entry.scope.workspaceId !== scope.workspaceId ||
        entry.scope.projectId !== scope.projectId ||
        entry.scope.canvasId !== scope.canvasId
      ) {
        return { entryApplied: false, materializedHead: null, reason: "ignored" };
      }
      try {
        const { droppedPending } = this.store.applyEntry(entry);
        if (!this.isCurrent(scopeKey, generation)) {
          return { entryApplied: false, materializedHead: null, reason: "ignored" };
        }
        this.rejectDropped(scopeKey, droppedPending);
        this.confirmLiveOperation(scopeKey, entry);
        this.resetBackoff(scopeKey);
        const digest = this.store.digest(scope);
        if (digest === null) {
          return { entryApplied: false, materializedHead: null, reason: "failed" };
        }
        // entryApplied when store head matches this entry (including idempotent same-head).
        const entryApplied =
          this.store.revision(scope) === entry.revision && digest === entry.contentDigest;
        return {
          entryApplied,
          materializedHead: {
            revision: this.store.revision(scope),
            contentDigest: digest
          }
        };
      } catch (error) {
        if (!this.isCurrent(scopeKey, generation)) {
          return { entryApplied: false, materializedHead: null, reason: "ignored" };
        }
        const code =
          error instanceof CollaborationClientError
            ? error.code
            : "canvas_replica_live_apply_failed";
        if (
          code !== "canvas_replica_revision_gap" &&
          code !== "canvas_replica_canonical_digest_mismatch" &&
          code !== "canvas_replica_reconnect_delta_invalid" &&
          code !== "canvas_replica_reconnect_head_mismatch"
        ) {
          return { entryApplied: false, materializedHead: null, reason: "failed" };
        }
        const ok = await this.waitBackoff(scopeKey, generation);
        if (!ok) return { entryApplied: false, materializedHead: null, reason: "ignored" };
        try {
          // Already on the serial lane — call installReconnect directly (do not re-enter enqueueSerial).
          const installed = await this.installReconnect(
            scope,
            scopeKey,
            generation,
            {
              afterRevision: this.store.revision(scope),
              afterContentDigest: this.store.digest(scope)
            },
            { forceSnapshotOnMaterializeFailure: true }
          );
          if (!installed || !this.isCurrent(scopeKey, generation)) {
            return { entryApplied: false, materializedHead: null, reason: "ignored" };
          }
          this.rejectDropped(scopeKey, installed.droppedPending);
          // Only confirm pending ops that appear as real journal entries — never synthesize.
          this.confirmQueueFromReconnectEntries(scopeKey, installed.response);
          this.resetBackoff(scopeKey);
          const digest = this.store.digest(scope);
          if (digest === null) {
            return { entryApplied: false, materializedHead: null, reason: "failed" };
          }
          // Head was materialised; advance cursor. entryApplied stays false (op not proven).
          return {
            entryApplied: false,
            reason: "recovered",
            materializedHead: {
              revision: this.store.revision(scope),
              contentDigest: digest
            }
          };
        } catch {
          return { entryApplied: false, materializedHead: null, reason: "failed" };
        }
      }
    });
  }

  clear(scope: CanvasReplicaScope): void {
    const scopeKey = this.key(scope);
    this.bumpGeneration(scopeKey);
    this.rejectQueue(scopeKey, disconnectedError());
    this.scopes.delete(scopeKey);
    this.store.clear(scope);
  }

  clearAll(): void {
    for (const scopeKey of [...this.scopes.keys()]) {
      this.bumpGeneration(scopeKey);
      this.rejectQueue(scopeKey, disconnectedError());
    }
    this.scopes.clear();
    this.store.clearAll();
  }

  private async run(scope: CanvasReplicaScope): Promise<void> {
    const scopeKey = this.key(scope);
    const generation = this.generations.get(scopeKey) ?? 0;
    const runningKey = `${scopeKey}:${generation}`;
    if (this.running.has(runningKey)) return;
    this.running.add(runningKey);
    try {
      while (true) {
        if (!this.isCurrent(scopeKey, generation)) return;
        const queue = this.queues.get(scopeKey);
        if (!queue?.length) return;
        const current = queue[0]!;
        if (current.settled) {
          queue.shift();
          continue;
        }
        try {
          if (!this.store.canEdit(scope)) {
            this.finishForbidden(scope, scopeKey);
            return;
          }
          const expectedRevision = this.store.revision(scope);
          const outcome = await this.transport.submit({
            scope,
            operationId: current.operationId,
            expectedRevision,
            intent: current.intent
          });
          if (!this.isCurrent(scopeKey, generation)) {
            settleReject(current, disconnectedError());
            return;
          }
          // Live broadcast may have already confirmed this operationId while HTTP was in flight.
          if (current.settled) {
            if (queue[0] === current) queue.shift();
            continue;
          }
          if (outcome.type === "canvas.command.accepted") {
            const folded = this.tryAccept(scope, scopeKey, outcome);
            if (folded === "accepted") {
              this.resetBackoff(scopeKey);
              if (queue[0] === current) queue.shift();
              settleResolve(current, outcome);
              continue;
            }
            // Local fold failed after Server accept: try delta from current revision first;
            // installReconnect upgrades to a full snapshot if materialization fails.
            await this.reconcileUncertain(scope, scopeKey, generation, current, queue, {
              knownAccepted: outcome
            });
            if (!this.isCurrent(scopeKey, generation)) {
              settleReject(current, disconnectedError());
              return;
            }
            if (!current.settled) {
              const ok = await this.waitBackoff(scopeKey, generation);
              if (!ok) {
                settleReject(current, disconnectedError());
                return;
              }
            }
            continue;
          }
          if (outcome.code === "stale_revision") {
            await this.recoverStaleRevision(scope, scopeKey, generation);
            if (!this.isCurrent(scopeKey, generation)) {
              settleReject(current, disconnectedError());
              return;
            }
            if (!current.retryStale) {
              this.store.reject(scope, current.operationId, outcome.code);
              if (queue[0] === current) queue.shift();
              settleResolve(current, outcome);
              this.resetBackoff(scopeKey);
              continue;
            }
            if (current.settled) {
              if (queue[0] === current) queue.shift();
              continue;
            }
            continue;
          }
          if (outcome.code === "forbidden") {
            this.store.reject(scope, current.operationId, outcome.code);
            queue.shift();
            settleResolve(current, outcome);
            this.finishForbidden(scope, scopeKey);
            return;
          }
          this.store.reject(scope, current.operationId, outcome.code);
          queue.shift();
          settleResolve(current, outcome);
          this.resetBackoff(scopeKey);
        } catch {
          if (!this.isCurrent(scopeKey, generation)) {
            settleReject(current, disconnectedError());
            return;
          }
          // Transport timeout / disconnect: Server may already have accepted.
          await this.reconcileUncertain(scope, scopeKey, generation, current, queue, {});
          if (!this.isCurrent(scopeKey, generation)) {
            settleReject(current, disconnectedError());
            return;
          }
          if (current.settled) continue;
          // Still uncertain — cancellable exponential backoff before the next attempt.
          const ok = await this.waitBackoff(scopeKey, generation);
          if (!ok) {
            settleReject(current, disconnectedError());
            return;
          }
        }
      }
    } finally {
      this.running.delete(runningKey);
      if (this.isCurrent(scopeKey, generation) && (this.queues.get(scopeKey)?.length ?? 0) > 0) {
        void this.run(scope);
      }
    }
  }

  /**
   * Outer wrapper: enter the per-scope serial lane, then run in-lane recovery.
   * Must not be called from inside another enqueueSerial task for the same scope.
   */
  private async reconcileUncertain(
    scope: CanvasReplicaScope,
    scopeKey: string,
    generation: number,
    current: Queued,
    queue: Queued[],
    options: { knownAccepted?: CanvasCommandAccepted; preferSnapshot?: boolean }
  ): Promise<void> {
    await this.enqueueSerial(scopeKey, () =>
      this.reconcileUncertainInLane(scope, scopeKey, generation, current, queue, options)
    );
  }

  /**
   * In-lane recovery body. Caller must already hold the serial lane (or be the sole caller).
   * Never re-enters enqueueSerial.
   */
  private async reconcileUncertainInLane(
    scope: CanvasReplicaScope,
    scopeKey: string,
    generation: number,
    current: Queued,
    queue: Queued[],
    options: { knownAccepted?: CanvasCommandAccepted; preferSnapshot?: boolean }
  ): Promise<void> {
    if (!this.isCurrent(scopeKey, generation) || current.settled) return;
    try {
      const preferred = options.preferSnapshot
        ? { afterRevision: 0, afterContentDigest: null as string | null }
        : {
            afterRevision: this.store.revision(scope),
            afterContentDigest: this.store.digest(scope)
          };
      const installed = await this.installReconnect(scope, scopeKey, generation, preferred, {
        forceSnapshotOnMaterializeFailure: true
      });
      if (!installed) {
        settleReject(current, disconnectedError());
        return;
      }
      if (!this.isCurrent(scopeKey, generation) || current.settled) return;
      const { response, droppedPending, viaSnapshot } = installed;

      const journalAccepted =
        response.type === "canvas.reconnect.delta"
          ? response.entries.find((entry) => entry.operationId === current.operationId)
          : undefined;

      if (journalAccepted) {
        this.rejectDropped(
          scopeKey,
          droppedPending.filter((item) => item.operationId !== current.operationId)
        );
        if (queue[0] === current) queue.shift();
        settleResolve(current, acceptedFromEntry(journalAccepted));
        this.resetBackoff(scopeKey);
        return;
      }

      const wasDropped = droppedPending.some((item) => item.operationId === current.operationId);
      const stillPending = this.store.pendingOperationIds(scope).includes(current.operationId);

      if (options.knownAccepted) {
        const folded = this.tryAccept(scope, scopeKey, options.knownAccepted);
        if (folded === "accepted") {
          this.rejectDropped(
            scopeKey,
            droppedPending.filter((item) => item.operationId !== current.operationId)
          );
          if (queue[0] === current) queue.shift();
          settleResolve(current, options.knownAccepted);
          this.resetBackoff(scopeKey);
          return;
        }
        if (viaSnapshot || this.store.revision(scope) >= options.knownAccepted.revision) {
          const included = this.store.acknowledgeIncluded(scope, current.operationId);
          this.rejectDropped(scopeKey, [
            ...droppedPending.filter((item) => item.operationId !== current.operationId),
            ...included.droppedPending
          ]);
          if (queue[0] === current) queue.shift();
          settleResolve(current, options.knownAccepted);
          this.resetBackoff(scopeKey);
          return;
        }
      }

      if (stillPending) {
        this.rejectDropped(scopeKey, droppedPending);
        return;
      }

      if (options.knownAccepted && !wasDropped) {
        this.rejectDropped(scopeKey, droppedPending);
        if (queue[0] === current) queue.shift();
        settleResolve(current, options.knownAccepted);
        this.resetBackoff(scopeKey);
        return;
      }

      if (wasDropped) {
        this.rejectDropped(
          scopeKey,
          droppedPending.filter((item) => item.operationId !== current.operationId)
        );
        await this.confirmDroppedOrRetryInLane(scope, scopeKey, generation, current, queue);
        return;
      }

      this.rejectDropped(scopeKey, droppedPending);
      if (options.knownAccepted) {
        if (queue[0] === current) queue.shift();
        settleResolve(current, options.knownAccepted);
        this.resetBackoff(scopeKey);
        return;
      }
      await this.confirmDroppedOrRetryInLane(scope, scopeKey, generation, current, queue);
    } catch {
      if (!this.isCurrent(scopeKey, generation)) {
        settleReject(current, disconnectedError());
      }
    }
  }

  /**
   * Install reconnect delta or snapshot. When materialization fails (e.g. digest mismatch
   * replaying a journal entry), upgrade to a full authoritative snapshot and replace once.
   */
  private async installReconnect(
    scope: CanvasReplicaScope,
    scopeKey: string,
    generation: number,
    input: { afterRevision: number; afterContentDigest: string | null },
    options: { forceSnapshotOnMaterializeFailure: boolean }
  ): Promise<{
    response: CanvasReconnectResponse;
    droppedPending: CanvasReplicaPendingOperation[];
    viaSnapshot: boolean;
  } | null> {
    const result = await this.transport.reconnect(scope, input);
    if (!this.isCurrent(scopeKey, generation)) return null;
    try {
      const { droppedPending } = this.store.replaceFromReconnect({
        scope,
        response: result.response,
        snapshotContent: result.snapshotContent
      });
      return {
        response: result.response,
        droppedPending,
        viaSnapshot: result.response.type === "canvas.reconnect.snapshot"
      };
    } catch (error) {
      if (!options.forceSnapshotOnMaterializeFailure || input.afterRevision === 0) {
        throw error;
      }
      // Delta cannot be materialized — fetch full snapshot and atomically replace.
      const snapshot = await this.transport.reconnect(scope, {
        afterRevision: 0,
        afterContentDigest: null
      });
      if (!this.isCurrent(scopeKey, generation)) return null;
      if (snapshot.response.type !== "canvas.reconnect.snapshot") {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "canvas_replica_snapshot_required",
          message: "canvas_replica_snapshot_required",
          retryable: true
        });
      }
      const { droppedPending } = this.store.replaceFromReconnect({
        scope,
        response: snapshot.response,
        snapshotContent: snapshot.snapshotContent
      });
      return { response: snapshot.response, droppedPending, viaSnapshot: true };
    }
  }

  /**
   * In-lane only: ask Server with the same operationId before rejecting.
   * Nested recovery uses *InLane helpers — never re-enters enqueueSerial.
   */
  private async confirmDroppedOrRetryInLane(
    scope: CanvasReplicaScope,
    scopeKey: string,
    generation: number,
    current: Queued,
    queue: Queued[]
  ): Promise<void> {
    try {
      const outcome = await this.transport.submit({
        scope,
        operationId: current.operationId,
        expectedRevision: this.store.revision(scope),
        intent: current.intent
      });
      if (!this.isCurrent(scopeKey, generation)) {
        settleReject(current, disconnectedError());
        return;
      }
      if (outcome.type === "canvas.command.accepted") {
        if (this.store.pendingOperationIds(scope).includes(current.operationId)) {
          const folded = this.tryAccept(scope, scopeKey, outcome);
          if (folded === "failed") {
            await this.reconcileUncertainInLane(scope, scopeKey, generation, current, queue, {
              knownAccepted: outcome
            });
            return;
          }
        }
        if (queue[0] === current) queue.shift();
        settleResolve(current, outcome);
        this.resetBackoff(scopeKey);
        return;
      }
      if (outcome.code === "stale_revision") {
        if (!this.store.pendingOperationIds(scope).includes(current.operationId)) {
          try {
            this.store.enqueue(scope, {
              operationId: current.operationId,
              intent: current.intent
            });
          } catch {
            if (queue[0] === current) queue.shift();
            settleReject(
              current,
              new CollaborationClientError({
                kind: "protocol",
                code: "canvas_replica_pending_rebase_failed",
                message: "canvas_replica_pending_rebase_failed"
              })
            );
            return;
          }
        }
        await this.recoverStaleRevisionInLane(scope, scopeKey, generation);
        return;
      }
      if (queue[0] === current) queue.shift();
      settleResolve(current, outcome);
      this.resetBackoff(scopeKey);
    } catch {
      if (!this.isCurrent(scopeKey, generation)) {
        settleReject(current, disconnectedError());
        return;
      }
      if (!this.store.pendingOperationIds(scope).includes(current.operationId)) {
        try {
          this.store.enqueue(scope, {
            operationId: current.operationId,
            intent: current.intent
          });
        } catch {
          if (queue[0] === current) queue.shift();
          settleReject(
            current,
            new CollaborationClientError({
              kind: "protocol",
              code: "canvas_replica_pending_rebase_failed",
              message: "canvas_replica_pending_rebase_failed"
            })
          );
        }
      }
    }
  }

  private tryAccept(
    scope: CanvasReplicaScope,
    scopeKey: string,
    outcome: CanvasCommandAccepted
  ): "accepted" | "failed" {
    try {
      const { droppedPending } = this.store.accept(scope, outcome);
      this.rejectDropped(scopeKey, droppedPending);
      return "accepted";
    } catch {
      return "failed";
    }
  }

  /** Confirm a queued submit at most once when a live entry matches its operationId. */
  private confirmLiveOperation(scopeKey: string, entry: CanvasJournalEntry): void {
    const queue = this.queues.get(scopeKey);
    if (!queue?.length) return;
    const index = queue.findIndex((item) => item.operationId === entry.operationId);
    if (index < 0) return;
    const item = queue[index]!;
    settleResolve(item, acceptedFromEntry(entry));
    queue.splice(index, 1);
  }

  /**
   * Confirm queued submits only from real journal entries in a reconnect delta.
   * Snapshot catch-up cannot prove operationId acceptance — remaining queue items
   * stay for FIFO idempotent resubmit against the Server.
   */
  private confirmQueueFromReconnectEntries(
    scopeKey: string,
    response: CanvasReconnectResponse
  ): void {
    if (response.type !== "canvas.reconnect.delta") return;
    for (const entry of response.entries) {
      this.confirmLiveOperation(scopeKey, entry);
    }
  }

  /** Outer wrapper for submit-path stale recovery (not already on the serial lane). */
  private async recoverStaleRevision(
    scope: CanvasReplicaScope,
    scopeKey: string,
    generation: number
  ): Promise<void> {
    await this.enqueueSerial(scopeKey, () =>
      this.recoverStaleRevisionInLane(scope, scopeKey, generation)
    );
  }

  /** In-lane only — never re-enters enqueueSerial. */
  private async recoverStaleRevisionInLane(
    scope: CanvasReplicaScope,
    scopeKey: string,
    generation: number
  ): Promise<void> {
    if (!this.isCurrent(scopeKey, generation)) return;
    const installed = await this.installReconnect(
      scope,
      scopeKey,
      generation,
      {
        afterRevision: this.store.revision(scope),
        afterContentDigest: this.store.digest(scope)
      },
      { forceSnapshotOnMaterializeFailure: true }
    );
    if (!installed || !this.isCurrent(scopeKey, generation)) return;
    this.rejectDropped(scopeKey, installed.droppedPending);
    this.confirmQueueFromReconnectEntries(scopeKey, installed.response);
  }

  private finishForbidden(scope: CanvasReplicaScope, scopeKey: string): void {
    this.store.setCanEdit(scope, false);
    const removed = this.store.clearPending(scope, "canvas_replica_command_forbidden");
    this.rejectDropped(scopeKey, removed, forbiddenError());
    const queue = this.queues.get(scopeKey) ?? [];
    this.queues.set(scopeKey, []);
    for (const item of queue) {
      settleReject(item, forbiddenError());
    }
  }

  private rejectDropped(
    scopeKey: string,
    dropped: CanvasReplicaPendingOperation[],
    error: Error = new CollaborationClientError({
      kind: "protocol",
      code: "canvas_replica_pending_rebase_failed",
      message: "canvas_replica_pending_rebase_failed"
    })
  ): void {
    if (dropped.length === 0) return;
    const droppedIds = new Set(dropped.map((item) => item.operationId));
    const queue = this.queues.get(scopeKey);
    if (!queue) return;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index]!;
      if (!droppedIds.has(item.operationId)) continue;
      settleReject(item, error);
      queue.splice(index, 1);
    }
  }

  private rejectQueue(scopeKey: string, error: Error): void {
    this.cancelDelay(scopeKey);
    const queue = this.queues.get(scopeKey) ?? [];
    this.queues.delete(scopeKey);
    for (const item of queue) settleReject(item, error);
  }

  private bumpGeneration(scopeKey: string): void {
    this.cancelDelay(scopeKey);
    this.recoveryAttempts.delete(scopeKey);
    this.generations.set(scopeKey, (this.generations.get(scopeKey) ?? 0) + 1);
  }

  private resetBackoff(scopeKey: string): void {
    this.recoveryAttempts.set(scopeKey, 0);
  }

  /** Cancellable exponential backoff. Returns false when the session generation changed. */
  private async waitBackoff(scopeKey: string, generation: number): Promise<boolean> {
    if (!this.isCurrent(scopeKey, generation)) return false;
    const attempt = (this.recoveryAttempts.get(scopeKey) ?? 0) + 1;
    this.recoveryAttempts.set(scopeKey, attempt);
    const delayMs = reconnectDelay(attempt, this.random, this.backoffOptions);
    this.cancelDelay(scopeKey);
    let cancelled = false;
    const handle: DelayHandle = {
      cancel: () => {
        cancelled = true;
      }
    };
    this.delays.set(scopeKey, handle);
    try {
      await this.sleep(delayMs, () => cancelled || !this.isCurrent(scopeKey, generation));
    } finally {
      if (this.delays.get(scopeKey) === handle) this.delays.delete(scopeKey);
    }
    return this.isCurrent(scopeKey, generation);
  }

  private cancelDelay(scopeKey: string): void {
    const handle = this.delays.get(scopeKey);
    if (!handle) return;
    handle.cancel();
    this.delays.delete(scopeKey);
  }

  private isCurrent(scopeKey: string, generation: number): boolean {
    return (this.generations.get(scopeKey) ?? 0) === generation;
  }

  private key(scope: CanvasReplicaScope): string {
    return JSON.stringify([scope.authorityId, scope.workspaceId, scope.projectId, scope.canvasId]);
  }
}
