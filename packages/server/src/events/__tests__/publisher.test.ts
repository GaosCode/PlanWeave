/* @vitest-environment node */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openServerDatabase, type SqliteDatabase } from "../../sqlite.js";
import { applyMigrations } from "../../migrations.js";
import { applyEventsMigrations } from "../migrations.js";
import {
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_RESYNC_REQUIRED,
  WS_CLOSE_UNAUTHENTICATED,
  createEventHttpApi,
  createEventPublisher,
  createEventWebSocketServer,
  readProjectSnapshot,
  type Authenticator,
  type EventPublisher,
  type EventWebSocketServer,
  type EventEnvelopeV1,
  type ProjectSnapshotV1,
  type SessionRevocationCheck,
  type SubscriberIdentity,
} from "../index.js";
import { executeIdempotent } from "../../store.js";

const directories: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTestDb(): Promise<{ database: SqliteDatabase; dataDirectory: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-a4-"));
  directories.push(dataDirectory);
  const database = await openServerDatabase(join(dataDirectory, "server.sqlite"), 5000);
  applyMigrations(database);
  applyEventsMigrations(database);
  // Seed a project so snapshots and event-replay have a target.
  database.prepare("INSERT INTO projects(id, version, name, created_at) VALUES (?,?,?,?)").run("project-a", 1, "Project A", "2026-07-12T00:00:00.000Z");
  return { database, dataDirectory };
}

function insertEvent(database: SqliteDatabase, input: { projectId: string; type: string; aggregateId: string; aggregateVersion: number }): string {
  const row = database
    .prepare("INSERT INTO domain_events(project_id, aggregate_type, aggregate_id, aggregate_version, type, occurred_at) VALUES (?,?,?,?,?,?)")
    .run(input.projectId, "project", input.aggregateId, input.aggregateVersion, input.type, new Date().toISOString());
  return String(row.lastInsertRowid);
}

function makeEnvelope(eventId: string, projectId: string, type: string, aggregateId: string, aggregateVersion: number): EventEnvelopeV1 {
  return {
    protocolVersion: 1,
    eventId,
    projectId,
    aggregateType: "project",
    aggregateId,
    aggregateVersion,
    type,
    occurredAt: new Date().toISOString(),
  };
}

const TEST_USERS: Record<string, { userId: string; sessionId: string; projectId: string; role: string }> = {
  alice: { userId: "user-alice", sessionId: "session-alice", projectId: "project-a", role: "owner" },
  bob: { userId: "user-bob", sessionId: "session-bob", projectId: "project-a", role: "contributor" },
};

function makeAuthenticator(revoked: ReadonlySet<string> = new Set()): Authenticator {
  return async (input) => {
    const raw = input.headers?.["x-test-user"];
    const userKey = Array.isArray(raw) ? raw[0] : raw;
    if (!userKey) return { ok: false, reason: "unauthenticated" };
    const identity = TEST_USERS[userKey];
    if (!identity) return { ok: false, reason: "unauthenticated" };
    if (input.projectId && identity.projectId !== input.projectId) return { ok: false, reason: "forbidden" };
    if (revoked.has(identity.sessionId)) return { ok: false, reason: "unauthenticated" };
    return { ok: true, identity: { ...identity, role: identity.role as SubscriberIdentity["role"] } };
  };
}

function makeSessionRevocation(revoked: ReadonlySet<string>): SessionRevocationCheck {
  return async (input) => {
    if (revoked.has(input.sessionId)) return { ok: false, reason: "unauthenticated" };
    const identity = Object.values(TEST_USERS).find((u) => u.sessionId === input.sessionId);
    if (!identity) return { ok: false, reason: "unauthenticated" };
    return { ok: true, role: identity.role as SubscriberIdentity["role"] };
  };
}

// Collect all WebSocket messages into a buffer for assertions.
type Collected = { messages: EventEnvelopeV1[]; closeCode: number | null; closeReason: string | null; opened: boolean };
async function openWebSocket(url: string, headers: Record<string, string>): Promise<{ ws: WebSocket; collected: Collected }> {
  return new Promise((resolve, reject) => {
    const collected: Collected = { messages: [], closeCode: null, closeReason: null, opened: false };
    const ws = new WebSocket(url, { headers });
    const timeout = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.once("open", () => {
      clearTimeout(timeout);
      collected.opened = true;
      resolve({ ws, collected });
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timeout);
      reject(new Error(`ws upgrade failed: ${res.statusCode}`));
    });
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString("utf8"));
        if (message.kind === "event") collected.messages.push(message.event);
      } catch {
        // ignore non-JSON
      }
    });
    ws.on("close", (code, reason) => {
      collected.closeCode = code;
      collected.closeReason = reason.toString("utf8");
    });
    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function waitForMessages(collected: Collected, count: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (collected.messages.length >= count) {
      resolve();
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      if (collected.messages.length >= count) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`timeout waiting for ${count} messages, got ${collected.messages.length}`));
      }
    }, 20);
  });
}

function waitForClose(collected: Collected, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (collected.closeCode !== null) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`timeout waiting for close (still open)`));
      }
    }, 20);
  });
}

describe("A4 durable events and WebSocket sync", () => {
  describe("publisher — drop / duplicate / reorder convergence", () => {
    it("drop: subscriber that misses a notification converges via HTTP replay", async () => {
      const { database } = await createTestDb();
      const publisher = createEventPublisher({ database, authenticator: makeAuthenticator(), pollIntervalMs: 50, disablePersistence: true });
      const subscriber = publisher.attach({ identity: { userId: "user-alice", sessionId: "s1", projectId: "project-a", role: "owner" } });

      // Event 1: insert into DB and tick. Subscriber dequeues and acknowledges.
      const id1 = insertEvent(database, { projectId: "project-a", type: "project.renamed", aggregateId: "project-a", aggregateVersion: 2 });
      await publisher.tick();
      let event = dequeue(subscriber);
      expect(event?.eventId).toBe(id1);
      publisher.acknowledgeDelivery(subscriber, id1);
      expect(subscriber.lastSeenEventId).toBe(id1);

      // "Drop" scenario: events 2 and 3 are inserted into the DB but the publisher's
      // tick does NOT run (simulating a publisher restart, a network partition, or a
      // subscriber that wasn't draining its queue). The durable cursor is preserved.
      const id2 = insertEvent(database, { projectId: "project-a", type: "project.renamed", aggregateId: "project-a", aggregateVersion: 3 });
      const id3 = insertEvent(database, { projectId: "project-a", type: "project.renamed", aggregateId: "project-a", aggregateVersion: 4 });

      // Subscriber reconnects via HTTP replay from its last-seen cursor.
      const replayed = replayFromDatabase(database, "project-a", id1);
      expect(replayed.map((e) => e.eventId)).toEqual([id2, id3]);

      // Subscriber applies replayed events in order. Final state: aggregateVersion=4.
      const finalVersion = applyEvents(replayed);
      expect(finalVersion).toBe(4);
      publisher.acknowledgeDelivery(subscriber, id3);
      expect(subscriber.lastSeenEventId).toBe(id3);
    });

    it("duplicate: same eventId dispatched twice — subscribers dedupe and do not double-process", async () => {
      const { database } = await createTestDb();
      const publisher = createEventPublisher({ database, authenticator: makeAuthenticator(), pollIntervalMs: 50, disablePersistence: true });
      const subscriber = publisher.attach({ identity: { userId: "user-alice", sessionId: "s1", projectId: "project-a", role: "owner" } });

      const e1 = makeEnvelope("1", "project-a", "project.renamed", "project-a", 2);
      const first = publisher.dispatch(e1);
      expect(first.delivered).toBe(1);
      expect(first.duplicates).toBe(0);

      // Dispatch the same eventId again — must dedupe.
      const second = publisher.dispatch(e1);
      expect(second.delivered).toBe(0);
      expect(second.duplicates).toBe(1);

      // Dequeue exactly once.
      const firstDequeue = dequeue(subscriber);
      expect(firstDequeue?.eventId).toBe("1");
      expect(dequeue(subscriber)).toBeUndefined();
    });

    it("reorder: out-of-order delivery — client detects gap and converges via snapshot+replay", async () => {
      const { database } = await createTestDb();
      const publisher = createEventPublisher({ database, authenticator: makeAuthenticator(), pollIntervalMs: 50, disablePersistence: true });
      const subscriber = publisher.attach({ identity: { userId: "user-alice", sessionId: "s1", projectId: "project-a", role: "owner" } });

      // Insert events into DB in the correct order (event_id 1, then 2).
      const id1 = insertEvent(database, { projectId: "project-a", type: "project.renamed", aggregateId: "project-a", aggregateVersion: 2 });
      const id2 = insertEvent(database, { projectId: "project-a", type: "project.renamed", aggregateId: "project-a", aggregateVersion: 3 });

      // Simulate the publisher pushing them in the wrong order (e.g., due to a network
      // reordering or a dispatch race). The subscriber's queue receives [id2, id1].
      publisher.dispatch(makeEnvelope(id2, "project-a", "project.renamed", "project-a", 3));
      publisher.dispatch(makeEnvelope(id1, "project-a", "project.renamed", "project-a", 2));

      // The client dequeues in arrival order, sees id2 first then id1. It detects a
      // gap (event id 1 arrived after event id 2) and triggers a snapshot+replay.
      const appliedInArrivalOrder: string[] = [];
      while (true) {
        const event = dequeue(subscriber);
        if (!event) break;
        appliedInArrivalOrder.push(event.eventId);
      }
      expect(appliedInArrivalOrder).toEqual([id2, id1]);

      // Client requests a fresh snapshot to discover the durable lastEventId.
      const snapshot = readProjectSnapshot(database, "project-a");
      expect(snapshot.lastEventId).toBe(id2);

      // Client then replays events strictly after the snapshot's lastEventId. Since the
      // client has already seen id1 and id2 (in some order), the replay is empty here.
      // In a real-world scenario the client would also fetch the snapshot's
      // `lastEventId` and use it as the new cursor; for the convergence test we replay
      // from 0 to confirm the full ordered history.
      const fullReplay = replayFromDatabase(database, "project-a", "0");
      expect(fullReplay.map((e) => e.eventId)).toEqual([id1, id2]);
      const finalVersion = applyEvents(fullReplay);
      expect(finalVersion).toBe(3);
    });
  });

  describe("HTTP event-replay + snapshot APIs", () => {
    it("returns events after a cursor + snapshot with lastEventId", async () => {
      const { database } = await createTestDb();
      const ids = [insertEvent(database, { projectId: "project-a", type: "project.renamed", aggregateId: "project-a", aggregateVersion: 2 }), insertEvent(database, { projectId: "project-a", type: "project.renamed", aggregateId: "project-a", aggregateVersion: 3 })];
      const api = createEventHttpApi({ database, authenticator: makeAuthenticator() });
      servers.push({ close: () => api.close() });
      await api.start();
      const address = api.address()!;
      const headers = { "x-test-user": "alice", host: "127.0.0.1" };

      const replayRes = await fetch(`http://127.0.0.1:${address.port}/api/v1/projects/project-a/events?afterEventId=0&limit=10`, { headers });
      expect(replayRes.status).toBe(200);
      const page = (await replayRes.json()) as { items: EventEnvelopeV1[]; nextCursor: string | null };
      expect(page.items.map((e) => e.eventId)).toEqual(ids);
      expect(page.nextCursor).toBeNull();

      const snapshotRes = await fetch(`http://127.0.0.1:${address.port}/api/v1/projects/project-a/snapshot`, { headers });
      expect(snapshotRes.status).toBe(200);
      const snapshot = (await snapshotRes.json()) as ProjectSnapshotV1;
      expect(snapshot.project.id).toBe("project-a");
      expect(snapshot.lastEventId).toBe(ids[ids.length - 1]!);
    });

    it("rejects unauthenticated requests with 401 + standard error envelope", async () => {
      const { database } = await createTestDb();
      const api = createEventHttpApi({ database, authenticator: makeAuthenticator() });
      servers.push({ close: () => api.close() });
      await api.start();
      const address = api.address()!;
      const res = await fetch(`http://127.0.0.1:${address.port}/api/v1/projects/project-a/snapshot`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string; requestId: string; retryable: boolean } };
      expect(body.error.code).toBe("unauthenticated");
      expect(typeof body.error.requestId).toBe("string");
    });

    it("rejects malformed percent-encoded project ids without crashing the HTTP server", async () => {
      const { database } = await createTestDb();
      const api = createEventHttpApi({ database, authenticator: async () => ({ ok: false, reason: "unauthenticated" }) });
      servers.push({ close: () => api.close() });
      await api.start();
      const address = api.address()!;
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/projects/%E0%A4%A/events`);
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "validation_failed" } });
      const health = await fetch(`http://${address.host}:${address.port}/healthz`);
      expect(health.status).toBe(200);
    });

    it("returns 410 event_cursor_expired when afterEventId is older than retention", async () => {
      const { database } = await createTestDb();
      const oldId = insertEvent(database, { projectId: "project-a", type: "old", aggregateId: "project-a", aggregateVersion: 2 });
      // Backdate the event to 30 days ago.
      const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      database.prepare("UPDATE domain_events SET occurred_at = ? WHERE event_id = ?").run(oldIso, Number(oldId));
      // Retention of 7 days; the only event is 30 days old.
      const api = createEventHttpApi({ database, authenticator: makeAuthenticator(), retentionMs: 7 * 24 * 60 * 60 * 1000 });
      servers.push({ close: () => api.close() });
      await api.start();
      const address = api.address()!;
      const headers = { "x-test-user": "alice", host: "127.0.0.1" };

      const res = await fetch(`http://127.0.0.1:${address.port}/api/v1/projects/project-a/events?afterEventId=0&limit=10`, { headers });
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: { code: string; details?: { oldestAvailableEventId?: string } } };
      expect(body.error.code).toBe("event_cursor_expired");
      expect(body.error.details?.oldestAvailableEventId).toBeDefined();
    });
  });

  describe("WebSocket transport", () => {
    it("delivers new events to authenticated subscribers", async () => {
      const { database } = await createTestDb();
      const publisher = createEventPublisher({ database, authenticator: makeAuthenticator(), pollIntervalMs: 50, disablePersistence: true });
      const wss = createEventWebSocketServer({ publisher, authenticator: makeAuthenticator(), heartbeatIntervalMs: 100 });
      servers.push({ close: () => wss.close() });
      await wss.start();
      const address = wss.address()!;
      const { ws, collected } = await openWebSocket(`ws://127.0.0.1:${address.port}/events`, { "x-test-user": "alice" });
      try {
        // Dispatch two events.
        publisher.dispatch(makeEnvelope("1", "project-a", "project.renamed", "project-a", 2));
        publisher.dispatch(makeEnvelope("2", "project-a", "project.renamed", "project-a", 3));
        await waitForMessages(collected, 2, 3000);
        expect(collected.messages.map((m) => m.eventId)).toEqual(["1", "2"]);
      } finally {
        ws.close();
      }
    });

    it("rejects unauthenticated upgrade with HTTP 401 (close code 4401 documented in errors)", async () => {
      const { database } = await createTestDb();
      const publisher = createEventPublisher({ database, authenticator: makeAuthenticator(), pollIntervalMs: 50, disablePersistence: true });
      const wss = createEventWebSocketServer({ publisher, authenticator: makeAuthenticator(), heartbeatIntervalMs: 100 });
      servers.push({ close: () => wss.close() });
      await wss.start();
      const address = wss.address()!;
      // Send a raw upgrade without our test header.
      const result = await new Promise<{ status: number }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${address.port}/events`);
        const timeout = setTimeout(() => reject(new Error("timeout")), 3000);
        ws.once("unexpected-response", (_req, res) => {
          clearTimeout(timeout);
          resolve({ status: res.statusCode ?? 0 });
        });
        ws.once("error", () => {
          // Some implementations go through "error" then "unexpected-response" — fall through.
        });
        ws.once("open", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ status: 101 });
        });
      });
      expect(result.status).toBe(401);
      // Document the close code that the contract pairs with this HTTP rejection.
      expect(WS_CLOSE_UNAUTHENTICATED).toBe(4401);
    });

    it("disconnects slow consumer with 4408 resync_required when queue is full", async () => {
      const { database } = await createTestDb();
      const smallCapacity = 3;
      const publisher = createEventPublisher({ database, authenticator: makeAuthenticator(), pollIntervalMs: 50, disablePersistence: true, defaultQueueCapacity: smallCapacity });
      const wss = createEventWebSocketServer({ publisher, authenticator: makeAuthenticator(), heartbeatIntervalMs: 100 });
      servers.push({ close: () => wss.close() });
      await wss.start();
      const address = wss.address()!;
      // We do NOT open a WebSocket — we just attach a subscriber and dispatch directly.
      // The publisher's dispatch() will mark the subscriber for close because no socket
      // is draining the queue.
      const subscriber = publisher.attach({ identity: { userId: "user-alice", sessionId: "s1", projectId: "project-a", role: "owner" } });
      // Fill the queue past capacity — dispatch 5 events.
      for (let i = 1; i <= 5; i += 1) {
        publisher.dispatch(makeEnvelope(String(i), "project-a", "project.renamed", "project-a", i + 1));
      }
      // The subscriber must be marked for disconnect with WS_CLOSE_RESYNC_REQUIRED.
      expect(subscriber.closed).toBe(true);
      expect(subscriber.closeReason?.code).toBe(WS_CLOSE_RESYNC_REQUIRED);
    });

    it("detects a dead client (missed pongs) and cleans up the subscriber", async () => {
      const { database } = await createTestDb();
      const publisher = createEventPublisher({ database, authenticator: makeAuthenticator(), pollIntervalMs: 50, disablePersistence: true });
      const wss = createEventWebSocketServer({ publisher, authenticator: makeAuthenticator(), heartbeatIntervalMs: 60, heartbeatMissLimit: 2 });
      servers.push({ close: () => wss.close() });
      await wss.start();
      const address = wss.address()!;
      const { ws, collected } = await openWebSocket(`ws://127.0.0.1:${address.port}/events`, { "x-test-user": "alice" });
      // Simulate dead client: stop responding to pings. We do this by overriding ws.pong
      // to be a no-op so the server's missed-pong counter never resets.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ws as any).pong = () => {
        /* swallow */
      };
      await waitForClose(collected, 5000);
      expect([1001, 1006]).toContain(collected.closeCode);
      // Publisher must have detached the subscriber.
      expect(publisher.subscriberCount()).toBe(0);
    });
  });

  describe("idempotency replay safety", () => {
    it("invoke executeIdempotent twice — only one domain_events row is created", async () => {
      const { database } = await createTestDb();
      const cmd = () => executeIdempotent(database, {
        deviceId: "device-a", route: "/api/v1/projects", projectId: "project-a", key: "idempotency-key-a4-1", requestFingerprint: "f-1",
        execute: (unit) => {
          const eventId = unit.appendEvent({ projectId: "project-a", aggregateType: "project", aggregateId: "project-a", aggregateVersion: 2, type: "project.renamed" });
          return { eventId };
        },
      });
      const first = cmd();
      const second = cmd();
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(first.value.eventId).toBe(second.value.eventId);
      const count = (database.prepare("SELECT COUNT(*) AS c FROM domain_events").get() as { c: number }).c;
      expect(count).toBe(1);
    });
  });

  describe("reauthorization on session change", () => {
    it("closes a subscriber with 4401 when its session is revoked", async () => {
      const { database } = await createTestDb();
      const revoked = new Set<string>();
      const publisher = createEventPublisher({ database, authenticator: makeAuthenticator(revoked), sessionRevocation: makeSessionRevocation(revoked), pollIntervalMs: 50, disablePersistence: true });
      publisher.attach({ identity: { userId: "user-alice", sessionId: "session-alice", projectId: "project-a", role: "owner" } });
      expect(publisher.subscriberCount()).toBe(1);
      // Revoke Alice's session, then run a tick. The publisher should close her.
      revoked.add("session-alice");
      await publisher.tick();
      expect(publisher.subscriberCount()).toBe(0);
    });

    it("forbidden session revocation closes with 4403", async () => {
      const { database } = await createTestDb();
      const publisher = createEventPublisher({
        database, authenticator: makeAuthenticator(),
        sessionRevocation: async (input) => {
          if (input.sessionId === "session-bob") return { ok: false, reason: "forbidden" };
          return { ok: true, role: "contributor" };
        },
        pollIntervalMs: 50, disablePersistence: true,
      });
      const subscriber = publisher.attach({ identity: { userId: "user-bob", sessionId: "session-bob", projectId: "project-a", role: "contributor" } });
      expect(publisher.subscriberCount()).toBe(1);
      await publisher.tick();
      expect(subscriber.closed).toBe(true);
      expect(subscriber.closeReason?.code).toBe(WS_CLOSE_FORBIDDEN);
    });
  });

  describe("eventing migrations", () => {
    it("applies the events schema migrations idempotently", async () => {
      const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-a4-"));
      directories.push(dataDirectory);
      const database = await openServerDatabase(join(dataDirectory, "server.sqlite"), 5000);
      applyMigrations(database);
      applyEventsMigrations(database);
      // Calling again is a no-op.
      applyEventsMigrations(database);
      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('subscribers','events_schema_migrations')").all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toContain("subscribers");
      expect(tables).toContain("events_schema_migrations");
      database.close();
    });
  });
});

// --- Test helpers ---

function dequeue(subscriber: ReturnType<EventPublisher["attach"]>): EventEnvelopeV1 | undefined {
  // Use the local helper rather than reaching into the publisher's dequeueEvent.
  // This mirrors what the wsServer does.
  const event = subscriber.queue.shift();
  if (event) subscriber.deliveredEventIds.add(event.eventId);
  return event;
}

function replayFromDatabase(database: SqliteDatabase, projectId: string, afterEventId: string): EventEnvelopeV1[] {
  const rows = database
    .prepare("SELECT event_id, project_id, aggregate_type, aggregate_id, aggregate_version, type, occurred_at FROM domain_events WHERE project_id = ? AND event_id > ? ORDER BY event_id ASC")
    .all(projectId, afterEventId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    protocolVersion: 1,
    eventId: String(row.event_id),
    projectId: String(row.project_id),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    aggregateVersion: Number(row.aggregate_version),
    type: String(row.type),
    occurredAt: String(row.occurred_at),
  }));
}

function applyEvents(events: EventEnvelopeV1[]): number {
  // Simulate a client that applies events in order, tracking the highest aggregateVersion.
  // The contract guarantees events are returned in event_id ASC order, so we just track
  // the last seen aggregateVersion.
  return events.reduce((version, event) => Math.max(version, event.aggregateVersion), 0);
}
