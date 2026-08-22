import {
  humanObserverEventSchema,
  type HumanObserverEvent
} from "@planweave-ai/collaboration-protocol/activity/observer";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import type { SqliteDatabase } from "./sqlite.js";

const journalEventInputSchema = z
  .object({
    kind: humanObserverEventSchema.shape.kind,
    workItem: humanObserverEventSchema.shape.workItem,
    commentId: humanObserverEventSchema.shape.commentId,
    activityId: humanObserverEventSchema.shape.activityId,
    humanPrincipalId: humanObserverEventSchema.shape.humanPrincipalId,
    dispatchId: humanObserverEventSchema.shape.dispatchId,
    canvasId: humanObserverEventSchema.shape.canvasId,
    canvasRevision: humanObserverEventSchema.shape.canvasRevision,
    canvasContentDigest: humanObserverEventSchema.shape.canvasContentDigest,
    runtimeRevision: humanObserverEventSchema.shape.runtimeRevision,
    remoteRunStatus: humanObserverEventSchema.shape.remoteRunStatus
  })
  .strict();

export type HumanObserverJournalEventInput = z.input<typeof journalEventInputSchema>;

const humanObserverScopeSchema = z
  .object({ workspaceId: workspaceIdSchema, projectId: z.string().min(1) })
  .strict();

export type HumanObserverScope = z.input<typeof humanObserverScopeSchema>;

export const HUMAN_OBSERVER_REPLAY_LIMITS = Object.freeze({
  maxEvents: 1_024,
  maxBytes: 512 * 1_024
});

export type HumanObserverReplayLimits = {
  maxEvents: number;
  maxBytes: number;
};

export type HumanObserverReplay =
  | { kind: "events"; headCursor: number; events: HumanObserverEvent[] }
  | {
      kind: "gap";
      reason: "retention_gap" | "cursor_ahead" | "reset";
      headCursor: number;
      droppedThroughCursor?: number;
    };

export class HumanObserverJournal {
  private readonly subscribers = new Map<string, Set<(event: HumanObserverEvent) => void>>();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly maxEventsPerProject: number,
    private readonly clock: () => Date = () => new Date()
  ) {
    if (!Number.isSafeInteger(maxEventsPerProject) || maxEventsPerProject < 1) {
      throw new Error("human_observer_retention_invalid");
    }
  }

  appendInCallerTransaction(
    rawScope: HumanObserverScope,
    rawInput: HumanObserverJournalEventInput,
    occurredAt = this.clock().toISOString()
  ): HumanObserverEvent {
    const scope = humanObserverScopeSchema.parse(rawScope);
    const input = journalEventInputSchema.parse(rawInput);
    const previousCursor = this.head(scope);
    const result = this.database
      .prepare(
        `INSERT INTO human_observer_events(workspace_id,project_id,previous_cursor,event_json,occurred_at)
         VALUES (?,?,?,?,?)`
      )
      .run(scope.workspaceId, scope.projectId, previousCursor, JSON.stringify(input), occurredAt);
    const cursor = Number(result.lastInsertRowid);
    const event = humanObserverEventSchema.parse({
      type: "human.observer.event",
      protocolVersion: 1,
      cursor,
      previousCursor,
      occurredAt,
      ...input
    });
    this.database
      .prepare(
        `DELETE FROM human_observer_events
         WHERE workspace_id=? AND project_id=? AND cursor NOT IN (
           SELECT cursor FROM human_observer_events
           WHERE workspace_id=? AND project_id=? ORDER BY cursor DESC LIMIT ?
         )`
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        scope.workspaceId,
        scope.projectId,
        this.maxEventsPerProject
      );
    queueMicrotask(() => {
      const committed = this.database
        .prepare(
          "SELECT 1 FROM human_observer_events WHERE workspace_id=? AND project_id=? AND cursor=?"
        )
        .get(scope.workspaceId, scope.projectId, cursor);
      if (!committed) return;
      for (const subscriber of this.subscribers.get(scopeKey(scope)) ?? []) subscriber(event);
    });
    return event;
  }

  head(rawScope: HumanObserverScope): number {
    const scope = humanObserverScopeSchema.parse(rawScope);
    return Number(
      this.database
        .prepare(
          "SELECT MAX(cursor) AS cursor FROM human_observer_events WHERE workspace_id=? AND project_id=?"
        )
        .get(scope.workspaceId, scope.projectId)?.cursor ?? 0
    );
  }

  replay(
    rawScope: HumanObserverScope,
    lastCursor: number,
    rawLimits: HumanObserverReplayLimits = HUMAN_OBSERVER_REPLAY_LIMITS
  ): HumanObserverReplay {
    const scope = humanObserverScopeSchema.parse(rawScope);
    if (!Number.isSafeInteger(lastCursor) || lastCursor < 0) {
      throw new Error("human_observer_cursor_invalid");
    }
    const limits = replayLimits(rawLimits);
    const headCursor = this.head(scope);
    if (lastCursor === 0) return { kind: "events", headCursor, events: [] };
    if (lastCursor > headCursor) return { kind: "gap", reason: "cursor_ahead", headCursor };
    const first = this.database
      .prepare(
        `SELECT previous_cursor FROM human_observer_events
         WHERE workspace_id=? AND project_id=? ORDER BY cursor ASC LIMIT 1`
      )
      .get(scope.workspaceId, scope.projectId);
    const droppedThroughCursor = Number(first?.previous_cursor ?? 0);
    if (lastCursor < droppedThroughCursor) {
      return {
        kind: "gap",
        reason: "retention_gap",
        headCursor,
        droppedThroughCursor
      };
    }
    const rows = this.database
      .prepare(
        `SELECT cursor,previous_cursor,event_json,occurred_at
         FROM human_observer_events WHERE workspace_id=? AND project_id=? AND cursor>?
         ORDER BY cursor ASC LIMIT ?`
      )
      .all(scope.workspaceId, scope.projectId, lastCursor, limits.maxEvents + 1);
    if (rows.length > limits.maxEvents) {
      return { kind: "gap", reason: "reset", headCursor };
    }
    const events: HumanObserverEvent[] = [];
    let serializedBytes = 0;
    for (const row of rows) {
      const event = humanObserverEventSchema.parse({
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: row.cursor,
        previousCursor: row.previous_cursor,
        occurredAt: row.occurred_at,
        ...journalEventInputSchema.parse(JSON.parse(String(row.event_json)))
      });
      serializedBytes += Buffer.byteLength(JSON.stringify(event));
      if (serializedBytes > limits.maxBytes) {
        return { kind: "gap", reason: "reset", headCursor };
      }
      events.push(event);
    }
    return {
      kind: "events",
      headCursor,
      events
    };
  }

  subscribe(
    rawScope: HumanObserverScope,
    subscriber: (event: HumanObserverEvent) => void
  ): () => void {
    const key = scopeKey(humanObserverScopeSchema.parse(rawScope));
    const projectSubscribers = this.subscribers.get(key) ?? new Set();
    projectSubscribers.add(subscriber);
    this.subscribers.set(key, projectSubscribers);
    return () => {
      projectSubscribers.delete(subscriber);
      if (projectSubscribers.size === 0) this.subscribers.delete(key);
    };
  }
}

function replayLimits(rawLimits: HumanObserverReplayLimits): HumanObserverReplayLimits {
  if (!Number.isSafeInteger(rawLimits.maxEvents) || rawLimits.maxEvents < 1) {
    throw new Error("human_observer_replay_max_events_invalid");
  }
  if (!Number.isSafeInteger(rawLimits.maxBytes) || rawLimits.maxBytes < 1) {
    throw new Error("human_observer_replay_max_bytes_invalid");
  }
  if (rawLimits.maxEvents === Number.MAX_SAFE_INTEGER) {
    throw new Error("human_observer_replay_max_events_invalid");
  }
  return rawLimits;
}

function scopeKey(scope: z.output<typeof humanObserverScopeSchema>): string {
  return `${scope.workspaceId}\u0000${scope.projectId}`;
}
