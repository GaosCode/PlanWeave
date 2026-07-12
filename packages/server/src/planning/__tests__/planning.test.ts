import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, addMembership, createDevice, createSession, ensureUser, type Session } from "../../identity/index.js";
import { appendMessage, ensureDefaultRoom, getMessage, listMessages } from "../index.js";
import { cleanupTestHarness, createTestDatabase, seedMembership, seedProject, type TestHarness } from "../../identity/__tests__/testDatabase.js";

function makeSession(database: TestHarness["database"], userId: string, deviceId: string, sessionId: string): Session {
  ensureUser(database, { deviceId, route: "/api/v1/users", key: `u-${userId}`, requestFingerprint: "f-1", userId, displayName: userId });
  createDevice(database, { deviceId, route: "/api/v1/devices", key: `d-${deviceId}`, requestFingerprint: "f-1", userId, id: deviceId, deviceName: deviceId });
  const session = createSession(database, { deviceId, route: "/api/v1/sessions", key: `s-${sessionId}`, requestFingerprint: "f-1", userId, id: sessionId, deviceRefId: deviceId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return session.value.session;
}

describe("planning module", () => {
  let harness: TestHarness;
  beforeEach(async () => { harness = await createTestDatabase(); });
  afterEach(async () => { await cleanupTestHarness(harness); });

  it("appends a message and rejects any attempt to mutate it", async () => {
    await seedProject(harness.database, "project-planning", "Planning");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-alice", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-planning", userId: "user-alice", role: "contributor" });
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const room = ensureDefaultRoom(harness.database, session, { deviceId: "dev-1", route: "/api/v1/rooms/ensure", key: "r-1", requestFingerprint: "f-1", projectId: "project-planning" });

    const append = appendMessage(harness.database, session, { deviceId: "dev-1", route: "/api/v1/messages", key: "msg-1", requestFingerprint: "f-1", roomId: room.value.room.id, body: "Hello planning room" });
    expect(append.value.message).toMatchObject({ id: append.value.message.id, kind: "text", body: "Hello planning room", supersedesMessageId: null });
    expect(harness.database.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });

    expect(() => harness.database.prepare("UPDATE messages SET body=? WHERE id=?").run("edited", append.value.message.id)).toThrow();
    const stored = harness.database.prepare("SELECT body FROM messages WHERE id=?").get(append.value.message.id) as { body: string };
    expect(stored.body).toBe("Hello planning room");

    const priorId = append.value.message.id;
    const replacement = appendMessage(harness.database, session, { deviceId: "dev-1", route: "/api/v1/messages", key: "msg-2", requestFingerprint: "f-1", roomId: room.value.room.id, body: "Hello planning room (corrected)", supersedesMessageId: priorId });
    expect(replacement.value.message.supersedesMessageId).toBe(priorId);
    expect(harness.database.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 2 });

    const fetched = getMessage(harness.database, session, priorId);
    expect(fetched.body).toBe("Hello planning room");
    const fetchedReplacement = getMessage(harness.database, session, replacement.value.message.id);
    expect(fetchedReplacement.body).toBe("Hello planning room (corrected)");
  });

  it("supports system messages and emits room.message_appended", async () => {
    await seedProject(harness.database, "project-sys", "System");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-sys", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-sys", userId: "user-alice", role: "contributor" });
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const room = ensureDefaultRoom(harness.database, session, { deviceId: "dev-1", route: "/api/v1/rooms/ensure", key: "r-1", requestFingerprint: "f-1", projectId: "project-sys" });
    const append = appendMessage(harness.database, session, { deviceId: "dev-1", route: "/api/v1/messages", key: "sys-1", requestFingerprint: "f-1", roomId: room.value.room.id, body: "Project frozen for review", kind: "system" });
    expect(append.value.message.kind).toBe("system");
    const event = harness.database.prepare("SELECT type FROM domain_events WHERE aggregate_id=? AND aggregate_type='message' ORDER BY event_id DESC LIMIT 1").get(append.value.message.id) as { type: string };
    expect(event.type).toBe("room.message_appended");
  });

  it("paginates messages with an opaque cursor", async () => {
    await seedProject(harness.database, "project-page", "Page");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-page", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-page", userId: "user-alice", role: "contributor" });
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const room = ensureDefaultRoom(harness.database, session, { deviceId: "dev-1", route: "/api/v1/rooms/ensure", key: "r-page", requestFingerprint: "f-1", projectId: "project-page" });
    for (let i = 0; i < 7; i += 1) {
      appendMessage(harness.database, session, { deviceId: "dev-1", route: "/api/v1/messages", key: `page-${i}`, requestFingerprint: "f-1", roomId: room.value.room.id, body: `msg ${i}` });
    }
    const page1 = listMessages(harness.database, session, { roomId: room.value.room.id, limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).toBeTypeOf("string");
    expect(page1.nextCursor).not.toBe("");
    const page2 = listMessages(harness.database, session, { roomId: room.value.room.id, limit: 3, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(3);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    const page3 = listMessages(harness.database, session, { roomId: room.value.room.id, limit: 3, cursor: page2.nextCursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
    const allIds = [...page1.items, ...page2.items, ...page3.items].map((m) => m.id);
    expect(new Set(allIds).size).toBe(7);
  });

  it("rejects invalid cursors with cursor_invalid", async () => {
    await seedProject(harness.database, "project-cursor", "Cursor");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-cursor", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-cursor", userId: "user-alice", role: "contributor" });
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const room = ensureDefaultRoom(harness.database, session, { deviceId: "dev-1", route: "/api/v1/rooms/ensure", key: "r-cursor", requestFingerprint: "f-1", projectId: "project-cursor" });
    let captured: DomainError | undefined;
    try { listMessages(harness.database, session, { roomId: room.value.room.id, limit: 10, cursor: "this-is-not-base64-or-json" }); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("cursor_invalid");
  });

  it("prevents cross-project reads even when the user has membership in another project", async () => {
    await seedProject(harness.database, "project-p1", "P1");
    await seedProject(harness.database, "project-p2", "P2");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-p1", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-p1", userId: "user-alice", role: "contributor" });
    await seedMembership(harness.database, "project-p2", "user-alice", "viewer");
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const room = ensureDefaultRoom(harness.database, session, { deviceId: "dev-1", route: "/api/v1/rooms/ensure", key: "r-p1", requestFingerprint: "f-1", projectId: "project-p1" });
    const append = appendMessage(harness.database, session, { deviceId: "dev-1", route: "/api/v1/messages", key: "cross-1", requestFingerprint: "f-1", roomId: room.value.room.id, body: "p1 only" });
    expect(getMessage(harness.database, session, append.value.message.id).body).toBe("p1 only");

    addMembership(harness.database, { deviceId: "dev-2", route: "/api/v1/memberships", key: "m-p2", requestFingerprint: "f-1", actorUserId: "user-bob", projectId: "project-p2", userId: "user-bob", role: "contributor" });
    const bob = makeSession(harness.database, "user-bob", "device-bob", "session-bob");
    let captured: DomainError | undefined;
    try { listMessages(harness.database, bob, { roomId: room.value.room.id, limit: 10 }); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("forbidden");
  });
});
