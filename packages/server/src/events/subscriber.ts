import type { EventEnvelopeV1, SubscriberIdentity, SubscriberRole } from "./types.js";
import { DEFAULT_SUBSCRIBER_QUEUE_CAPACITY, WS_CLOSE_RESYNC_REQUIRED, WS_CLOSE_UNAUTHENTICATED, WS_CLOSE_FORBIDDEN, WS_CLOSE_GOING_AWAY } from "./types.js";

// A Subscriber tracks the durable cursor and the outbound queue for a single live WebSocket.
// The Subscriber does NOT touch the network — the wsServer adapter pushes events via
// `enqueue()` and reads `messagesForDelivery`. This keeps Subscriber testable without sockets.

export type SubscriberOutboundMessage = { kind: "event"; event: EventEnvelopeV1 };

export type SubscriberCloseReason =
  | { code: number; reason: string } // raw close
  | { code: typeof WS_CLOSE_UNAUTHENTICATED; reason: "unauthenticated" }
  | { code: typeof WS_CLOSE_FORBIDDEN; reason: "forbidden" }
  | { code: typeof WS_CLOSE_RESYNC_REQUIRED; reason: "resync_required" }
  | { code: typeof WS_CLOSE_GOING_AWAY; reason: "going_away" };

export type Subscriber = {
  readonly subscriberId: string;
  readonly projectId: string;
  identity: SubscriberIdentity;
  lastSeenEventId: string;
  closed: boolean;
  // Bounded outbound queue. The wsServer drains this with a non-blocking send.
  queue: EventEnvelopeV1[];
  // Set of event_ids already observed by the consumer (publisher-side dedupe). NOT the
  // consumer's own application dedupe — this guards against the publisher accidentally
  // re-pushing the same event after a poll-cycle hiccup.
  deliveredEventIds: Set<string>;
  closeReason: SubscriberCloseReason | null;
};

export type CreateSubscriberInput = {
  subscriberId: string;
  identity: SubscriberIdentity;
  initialLastSeenEventId?: string;
  queueCapacity?: number;
  nowIso?: string;
};

export function createSubscriber(input: CreateSubscriberInput): Subscriber {
  return {
    subscriberId: input.subscriberId,
    projectId: input.identity.projectId,
    identity: input.identity,
    lastSeenEventId: input.initialLastSeenEventId ?? "0",
    closed: false,
    queue: [],
    deliveredEventIds: new Set(),
    closeReason: null,
    ...{ _queueCapacity: input.queueCapacity ?? DEFAULT_SUBSCRIBER_QUEUE_CAPACITY, _nowIso: input.nowIso ?? new Date().toISOString() } as object,
  };
}

// Re-export queue capacity accessor for the publisher. We attach it via the spread above so
// the Subscriber type stays clean and pure data.
export function subscriberQueueCapacity(subscriber: Subscriber): number {
  return (subscriber as unknown as { _queueCapacity: number })._queueCapacity;
}

// Enqueue an event for delivery. Returns:
//   - "delivered" if the event was placed on the queue (and event_id wasn't a duplicate).
//   - "duplicate" if the event_id was already in the delivered set (skipped silently).
//   - "full" if the queue is at capacity (caller MUST mark the subscriber for disconnect).
export function enqueueEvent(subscriber: Subscriber, event: EventEnvelopeV1): "delivered" | "duplicate" | "full" {
  if (subscriber.closed) return "full";
  if (subscriber.deliveredEventIds.has(event.eventId)) return "duplicate";
  if (subscriber.queue.length >= subscriberQueueCapacity(subscriber)) return "full";
  subscriber.queue.push(event);
  subscriber.deliveredEventIds.add(event.eventId);
  return "delivered";
}

// Pop the next event from the queue. Returns undefined if empty. The wsServer calls this
// after a successful WebSocket send to advance lastSeenEventId.
export function dequeueEvent(subscriber: Subscriber): EventEnvelopeV1 | undefined {
  return subscriber.queue.shift();
}

// Mark a subscriber as closed. The wsServer uses `closeReason` to send the WebSocket close
// frame. After this call, further enqueueEvent calls return "full" and dequeueEvent returns
// undefined.
export function markClosed(subscriber: Subscriber, reason: SubscriberCloseReason): void {
  if (subscriber.closed) return;
  subscriber.closed = true;
  subscriber.closeReason = reason;
}

// Convenience: a "disconnected" check the publisher uses before pushing.
export function isClosed(subscriber: Subscriber): boolean {
  return subscriber.closed;
}

// Snapshot helpers (used by tests + persistence).
export type SubscriberRow = {
  subscriber_id: string;
  project_id: string;
  user_id: string;
  session_id: string;
  last_seen_event_id: string;
  queue_size: number;
  last_heartbeat_at: string;
  connected_at: string;
};

export function toSubscriberRow(subscriber: Subscriber, connectedAtIso: string, lastHeartbeatAtIso: string): SubscriberRow {
  return {
    subscriber_id: subscriber.subscriberId,
    project_id: subscriber.projectId,
    user_id: subscriber.identity.userId,
    session_id: subscriber.identity.sessionId,
    last_seen_event_id: subscriber.lastSeenEventId,
    queue_size: subscriber.queue.length,
    last_heartbeat_at: lastHeartbeatAtIso,
    connected_at: connectedAtIso,
  };
}

// Re-export roles to keep the test file imports tidy.
export type { SubscriberIdentity, SubscriberRole };
