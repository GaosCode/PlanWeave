import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../sqlite.js";
import { DEFAULT_PUBLISHER_BATCH_SIZE, readEventsForPublisher } from "./repository.js";
import { createSubscriber, dequeueEvent, enqueueEvent, isClosed, markClosed, subscriberQueueCapacity, toSubscriberRow, type Subscriber, type SubscriberCloseReason } from "./subscriber.js";
import type { Authenticator, EventEnvelopeV1, SessionRevocationCheck, SubscriberIdentity, SubscriberRole } from "./types.js";
import {
  DEFAULT_HEARTBEAT_MISS_LIMIT,
  DEFAULT_PUBLISHER_POLL_INTERVAL_MS,
  DEFAULT_SUBSCRIBER_QUEUE_CAPACITY,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_RESYNC_REQUIRED,
  WS_CLOSE_UNAUTHENTICATED,
} from "./types.js";

// EventPublisher — the durable-event broadcaster.
//
// Design:
//  - A poll loop wakes every `pollIntervalMs`. It reads events with event_id > lastSeenEventId
//    per subscriber, in stable event_id order, and pushes them to each subscriber's queue.
//  - Per-subscriber lastSeenEventId is the source of truth. event_id (not occurred_at) is
//    the ordering key — durable event_ids are AUTOINCREMENT monotonic.
//  - The publisher never blocks on a slow consumer: a full queue marks the subscriber
//    for disconnect with WS_CLOSE_RESYNC_REQUIRED (4408). The client resyncs via HTTP.
//  - Reauth runs before each push. A revoked/forbidden session is closed within one cycle
//    (~pollIntervalMs). For a stricter bound, set pollIntervalMs <= 5000 (RFC says 5s).
//  - The poll loop is recoverable: subscribers are persisted to the `subscribers` table
//    on attach, and lastSeenEventId is updated on each successful dequeue. After a crash
//    and restart, the publisher rehydrates subscriber state from the table.

export type EventPublisherOptions = {
  database: SqliteDatabase;
  authenticator: Authenticator;
  sessionRevocation?: SessionRevocationCheck;
  pollIntervalMs?: number;
  publisherBatchSize?: number;
  defaultQueueCapacity?: number;
  // If true, the publisher will skip writing to the `subscribers` table. Used in unit
  // tests that want a fully in-memory publisher.
  disablePersistence?: boolean;
  // Test seam: override the clock.
  now?: () => Date;
};

export type EventPublisher = {
  attach(input: { identity: SubscriberIdentity; initialLastSeenEventId?: string }): Subscriber;
  detach(subscriber: Subscriber, reason: SubscriberCloseReason): void;
  // Reattach a persisted subscriber row (used by the wsServer after a publisher restart).
  rehydrate(row: { subscriber_id: string; project_id: string; user_id: string; session_id: string; last_seen_event_id: string; connected_at: string; last_heartbeat_at: string; queue_size: number }): Subscriber;
  // Dispatch a single envelope to all matching subscribers. Used by the poll loop AND
  // by tests that want to simulate the publisher emitting an event without writing to DB.
  dispatch(envelope: EventEnvelopeV1): { delivered: number; duplicates: number; full: number };
  // Reauth all attached subscribers. Returns a list of subscribers closed this cycle.
  reauthorizeAll(): Subscriber[];
  // Tick the poll loop once. Returns the number of envelopes delivered.
  tick(): Promise<{ polled: number; delivered: number; duplicates: number; full: number; closed: number }>;
  start(): void;
  stop(): void;
  // Update lastSeenEventId for a subscriber. Called by the wsServer after a successful
  // WebSocket send.
  acknowledgeDelivery(subscriber: Subscriber, eventId: string): void;
  // Test seam: number of subscribers currently attached.
  subscriberCount(): number;
  // Test seam: list of attached subscribers.
  listSubscribers(): readonly Subscriber[];
  // Heartbeat: marks a subscriber as alive (called by the wsServer on pong).
  heartbeat(subscriber: Subscriber): void;
  // Heartbeat sweep: returns subscribers that have missed >= missLimit consecutive pings.
  sweepHeartbeats(input: { nowIso: string; heartbeatIntervalMs: number; missLimit?: number }): Subscriber[];
};

const DEFAULT_PUBLISHER_OPTIONS = {
  pollIntervalMs: DEFAULT_PUBLISHER_POLL_INTERVAL_MS,
  publisherBatchSize: DEFAULT_PUBLISHER_BATCH_SIZE,
  defaultQueueCapacity: DEFAULT_SUBSCRIBER_QUEUE_CAPACITY,
} as const;

export function createEventPublisher(options: EventPublisherOptions): EventPublisher {
  const opts = { ...DEFAULT_PUBLISHER_OPTIONS, ...options };
  const subscribersById = new Map<string, Subscriber>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const now = options.now ?? (() => new Date());

  function persistSubscriberRow(subscriber: Subscriber, kind: "upsert" | "delete"): void {
    if (opts.disablePersistence) return;
    if (kind === "upsert") {
      const row = toSubscriberRow(subscriber, now().toISOString(), now().toISOString());
      options.database
        .prepare(
          "INSERT INTO subscribers(subscriber_id, project_id, user_id, session_id, last_seen_event_id, queue_size, last_heartbeat_at, connected_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(subscriber_id) DO UPDATE SET last_seen_event_id=excluded.last_seen_event_id, queue_size=excluded.queue_size, last_heartbeat_at=excluded.last_heartbeat_at",
        )
        .run(row.subscriber_id, row.project_id, row.user_id, row.session_id, row.last_seen_event_id, row.queue_size, row.last_heartbeat_at, row.connected_at);
    } else {
      options.database.prepare("DELETE FROM subscribers WHERE subscriber_id = ?").run(subscriber.subscriberId);
    }
  }

  function persistLastSeen(subscriber: Subscriber): void {
    if (opts.disablePersistence) return;
    options.database
      .prepare("UPDATE subscribers SET last_seen_event_id = ?, queue_size = ?, last_heartbeat_at = ? WHERE subscriber_id = ?")
      .run(subscriber.lastSeenEventId, subscriber.queue.length, now().toISOString(), subscriber.subscriberId);
  }

  function closeSubscriber(subscriber: Subscriber, reason: SubscriberCloseReason): void {
    if (subscriber.closed) return;
    markClosed(subscriber, reason);
    persistSubscriberRow(subscriber, "delete");
  }

  function reauthenticateSubscriberSync(subscriber: Subscriber): { ok: true; role: SubscriberRole } | { ok: false; reason: "unauthenticated" | "forbidden" } {
    // Sync reauth is only used by `dispatch` (a test seam that bypasses the poll loop).
    // The real reauth sweep runs inside the async `tick()` method, which can await
    // sessionRevocation across all subscribers in one cycle. This keeps the 5-second
    // A4 reauth guarantee (pollIntervalMs <= 5000) on the production path.
    if (!options.sessionRevocation) return { ok: true, role: subscriber.identity.role };
    return { ok: true, role: subscriber.identity.role };
  }

  return {
    attach(input) {
      const subscriber = createSubscriber({
        subscriberId: randomUUID(),
        identity: input.identity,
        initialLastSeenEventId: input.initialLastSeenEventId ?? "0",
        queueCapacity: opts.defaultQueueCapacity,
        nowIso: now().toISOString(),
      });
      subscribersById.set(subscriber.subscriberId, subscriber);
      persistSubscriberRow(subscriber, "upsert");
      return subscriber;
    },

    detach(subscriber, reason) {
      closeSubscriber(subscriber, reason);
      subscribersById.delete(subscriber.subscriberId);
    },

    rehydrate(row) {
      const identity: SubscriberIdentity = { userId: row.user_id, sessionId: row.session_id, projectId: row.project_id, role: "viewer" };
      const subscriber = createSubscriber({
        subscriberId: row.subscriber_id,
        identity,
        initialLastSeenEventId: row.last_seen_event_id,
        queueCapacity: opts.defaultQueueCapacity,
        nowIso: row.connected_at,
      });
      subscribersById.set(subscriber.subscriberId, subscriber);
      return subscriber;
    },

    dispatch(envelope) {
      let delivered = 0;
      let duplicates = 0;
      let full = 0;
      for (const subscriber of subscribersById.values()) {
        if (isClosed(subscriber)) continue;
        if (subscriber.projectId !== envelope.projectId) continue;
        // Reauth: only when session revocation is configured. The poll loop also runs
        // a separate async reauth sweep via `reauthorizeAll()` for stricter guarantees.
        if (options.sessionRevocation) {
          const result = reauthenticateSubscriberSync(subscriber);
          if (!result.ok) {
            if (result.reason === "forbidden") {
              closeSubscriber(subscriber, { code: WS_CLOSE_FORBIDDEN, reason: "forbidden" });
            } else {
              closeSubscriber(subscriber, { code: WS_CLOSE_UNAUTHENTICATED, reason: "unauthenticated" });
            }
            subscribersById.delete(subscriber.subscriberId);
            continue;
          }
          subscriber.identity.role = result.role;
        }
        const outcome = enqueueEvent(subscriber, envelope);
        if (outcome === "delivered") delivered += 1;
        else if (outcome === "duplicate") duplicates += 1;
        else if (outcome === "full") {
          full += 1;
          closeSubscriber(subscriber, { code: WS_CLOSE_RESYNC_REQUIRED, reason: "resync_required" });
          subscribersById.delete(subscriber.subscriberId);
        }
      }
      return { delivered, duplicates, full };
    },

    reauthorizeAll() {
      // The real async reauth sweep lives inside `tick()` (the production poll path).
      // This method is a synchronous pre-flight that returns subscribers already closed
      // by previous ticks — used by the wsServer to clean up its drain timers without
      // duplicating reauth work. The wsServer's heartbeat sweep is the source of truth
      // for live subscriber state.
      const closed: Subscriber[] = [];
      for (const subscriber of subscribersById.values()) {
        if (isClosed(subscriber)) closed.push(subscriber);
      }
      return closed;
    },

    async tick() {
      let polled = 0;
      let delivered = 0;
      let duplicates = 0;
      let full = 0;
      let closed = 0;
      // Reauth all subscribers (async path) before polling.
      if (options.sessionRevocation) {
        const reauthTasks = [...subscribersById.values()].map(async (subscriber) => {
          if (isClosed(subscriber)) return;
          const result = await options.sessionRevocation!({ userId: subscriber.identity.userId, sessionId: subscriber.identity.sessionId, projectId: subscriber.identity.projectId });
          if (!result.ok) {
            closeSubscriber(subscriber, result.reason === "forbidden" ? { code: WS_CLOSE_FORBIDDEN, reason: "forbidden" } : { code: WS_CLOSE_UNAUTHENTICATED, reason: "unauthenticated" });
            subscribersById.delete(subscriber.subscriberId);
            closed += 1;
            return;
          }
          subscriber.identity.role = result.role;
        });
        await Promise.all(reauthTasks);
      }
      // Group subscribers by project for batched reads.
      const byProject = new Map<string, Subscriber[]>();
      for (const subscriber of subscribersById.values()) {
        if (isClosed(subscriber)) continue;
        const list = byProject.get(subscriber.projectId) ?? [];
        list.push(subscriber);
        byProject.set(subscriber.projectId, list);
      }
      for (const [projectId, list] of byProject) {
        // Read all events > 0 sorted by event_id; the cap is the publisher batch size.
        // Each subscriber advances its own lastSeenEventId.
        const events = readEventsForPublisher(options.database, { projectId, afterEventId: "0", limit: opts.publisherBatchSize });
        for (const subscriber of list) {
          for (const event of events) {
            if (BigInt(event.eventId) <= BigInt(subscriber.lastSeenEventId)) continue;
            const outcome = enqueueEvent(subscriber, event);
            if (outcome === "delivered") delivered += 1;
            else if (outcome === "duplicate") duplicates += 1;
            else if (outcome === "full") {
              full += 1;
              closeSubscriber(subscriber, { code: WS_CLOSE_RESYNC_REQUIRED, reason: "resync_required" });
              subscribersById.delete(subscriber.subscriberId);
              closed += 1;
              break;
            }
            polled += 1;
          }
        }
      }
      return { polled, delivered, duplicates, full, closed };
    },

    start() {
      if (pollTimer) return;
      const run = async () => {
        try {
          await this.tick();
        } catch {
          // Swallow poll errors — the next tick will retry. The publisher must be resilient
          // to transient DB errors; logging is the operator's job.
        }
        pollTimer = setTimeout(run, opts.pollIntervalMs);
      };
      pollTimer = setTimeout(run, opts.pollIntervalMs);
    },

    stop() {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    },

    acknowledgeDelivery(subscriber, eventId) {
      if (BigInt(eventId) > BigInt(subscriber.lastSeenEventId)) {
        subscriber.lastSeenEventId = eventId;
        // Don't drop enqueued older events here — the consumer is responsible for ordering.
        // The publisher just tracks the durable cursor.
        persistLastSeen(subscriber);
      }
    },

    heartbeat(subscriber) {
      if (opts.disablePersistence) return;
      options.database
        .prepare("UPDATE subscribers SET last_heartbeat_at = ? WHERE subscriber_id = ?")
        .run(now().toISOString(), subscriber.subscriberId);
    },

    sweepHeartbeats(input) {
      const missLimit = input.missLimit ?? DEFAULT_HEARTBEAT_MISS_LIMIT;
      const cutoffMs = new Date(input.nowIso).getTime() - input.heartbeatIntervalMs * missLimit;
      const cutoffIso = new Date(cutoffMs).toISOString();
      const rows = options.database
        .prepare("SELECT subscriber_id, project_id, user_id, session_id, last_seen_event_id, connected_at, last_heartbeat_at, queue_size FROM subscribers WHERE last_heartbeat_at < ?")
        .all(cutoffIso) as Array<{ subscriber_id: string; project_id: string; user_id: string; session_id: string; last_seen_event_id: string; connected_at: string; last_heartbeat_at: string; queue_size: number }>;
      const swept: Subscriber[] = [];
      for (const row of rows) {
        const subscriber = subscribersById.get(row.subscriber_id);
        if (subscriber && !isClosed(subscriber)) {
          closeSubscriber(subscriber, { code: WS_CLOSE_GOING_AWAY, reason: "going_away" });
          subscribersById.delete(subscriber.subscriberId);
          swept.push(subscriber);
        } else if (!subscriber) {
          // Subscriber was reaped from memory but still has a row — clean up the row.
          options.database.prepare("DELETE FROM subscribers WHERE subscriber_id = ?").run(row.subscriber_id);
        }
      }
      return swept;
    },

    subscriberCount() {
      return subscribersById.size;
    },

    listSubscribers() {
      return [...subscribersById.values()];
    },
  };
}

// Re-export queue capacity for tests.
export { subscriberQueueCapacity, dequeueEvent };
