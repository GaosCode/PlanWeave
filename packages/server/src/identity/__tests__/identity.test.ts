import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, addMembership, createDevice, createInvitation, createSession, ensureUser, getUser, redeemInvitation, requireProjectRole, resolveActiveSession, revokeSession } from "../index.js";
import { cleanupTestHarness, createTestDatabase, seedMembership, seedProject, type TestHarness } from "./testDatabase.js";

describe("identity module", () => {
  let harness: TestHarness;
  beforeEach(async () => { harness = await createTestDatabase(); });
  afterEach(async () => { await cleanupTestHarness(harness); });

  it("creates a user, binds a device, and issues a session; resolves fields end to end", async () => {
    const user = ensureUser(harness.database, { deviceId: "dev-1", route: "/api/v1/users", key: "k-user-1", requestFingerprint: "f-1", userId: "user-alice", displayName: "Alice" });
    expect(user.replayed).toBe(false);
    expect(user.value.user).toEqual({ id: "user-alice", displayName: "Alice", email: null, createdAt: user.value.user.createdAt });
    expect(getUser(harness.database, "user-alice").displayName).toBe("Alice");

    const device = createDevice(harness.database, { deviceId: "dev-1", route: "/api/v1/devices", key: "k-device-1", requestFingerprint: "f-1", userId: "user-alice", id: "device-laptop", deviceName: "Alice's Laptop", publicKeyFingerprint: "fp:abc" });
    expect(device.value.device).toMatchObject({ id: "device-laptop", userId: "user-alice", deviceName: "Alice's Laptop", publicKeyFingerprint: "fp:abc", status: "active" });

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const sessionResult = createSession(harness.database, { deviceId: "dev-1", route: "/api/v1/sessions", key: "k-session-1", requestFingerprint: "f-1", userId: "user-alice", id: "session-1", deviceRefId: "device-laptop", expiresAt });
    expect(sessionResult.value.session).toMatchObject({ id: "session-1", userId: "user-alice", deviceId: "device-laptop", revokedAt: null });
    expect(sessionResult.value.session.expiresAt).toBe(expiresAt);

    const resolved = resolveActiveSession(harness.database, "session-1");
    expect(resolved.user.id).toBe("user-alice");
    expect(resolved.device.id).toBe("device-laptop");
    expect(resolved.session).toEqual(sessionResult.value.session);
  });

  it("replays create-user with the same idempotency key without producing duplicates", () => {
    const first = ensureUser(harness.database, { deviceId: "dev-1", route: "/api/v1/users", key: "k-replay", requestFingerprint: "f-1", userId: "user-bob", displayName: "Bob" });
    const second = ensureUser(harness.database, { deviceId: "dev-1", route: "/api/v1/users", key: "k-replay", requestFingerprint: "f-1", userId: "user-bob", displayName: "Bob" });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(harness.database.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("redeems an invitation once and rejects the second redemption with state_conflict", async () => {
    await seedProject(harness.database, "project-x", "Project X");
    ensureUser(harness.database, { deviceId: "dev-1", route: "/api/v1/users", key: "k-owner", requestFingerprint: "f-1", userId: "user-owner", displayName: "Owner" });
    ensureUser(harness.database, { deviceId: "dev-1", route: "/api/v1/users", key: "k-alice", requestFingerprint: "f-1", userId: "user-alice", displayName: "Alice" });
    ensureUser(harness.database, { deviceId: "dev-1", route: "/api/v1/users", key: "k-bob", requestFingerprint: "f-1", userId: "user-bob", displayName: "Bob" });
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "k-member-owner", requestFingerprint: "f-1", actorUserId: "user-owner", projectId: "project-x", userId: "user-owner", role: "owner" });
    const invitation = createInvitation(harness.database, { deviceId: "dev-1", route: "/api/v1/invitations", key: "k-inv", requestFingerprint: "f-1", actorUserId: "user-owner", projectId: "project-x", code: "INVITE-ABC", role: "contributor", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(invitation.value.invitation.code).toBe("INVITE-ABC");

    const first = redeemInvitation(harness.database, { deviceId: "dev-1", route: "/api/v1/invitations/redeem", key: "k-redeem-1", requestFingerprint: "f-1", userId: "user-alice", code: "INVITE-ABC" });
    expect(first.value.membership).toEqual({ projectId: "project-x", userId: "user-alice", role: "contributor", createdAt: first.value.membership.createdAt });
    expect(harness.database.prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?").get("project-x", "user-alice")).toEqual({ role: "contributor" });

    let captured: DomainError | undefined;
    try { redeemInvitation(harness.database, { deviceId: "dev-1", route: "/api/v1/invitations/redeem", key: "k-redeem-2", requestFingerprint: "f-1", userId: "user-bob", code: "INVITE-ABC" }); }
    catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("state_conflict");
    expect(harness.database.prepare("SELECT COUNT(*) AS n FROM memberships WHERE project_id=? AND user_id=?").get("project-x", "user-bob")).toEqual({ n: 0 });
  });

  it("treats a revoked session as unauthenticated and emits session.revoked", () => {
    ensureUser(harness.database, { deviceId: "dev-1", route: "/api/v1/users", key: "k-user", requestFingerprint: "f-1", userId: "user-alice", displayName: "Alice" });
    createDevice(harness.database, { deviceId: "dev-1", route: "/api/v1/devices", key: "k-dev", requestFingerprint: "f-1", userId: "user-alice", id: "device-laptop", deviceName: "Laptop" });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    createSession(harness.database, { deviceId: "dev-1", route: "/api/v1/sessions", key: "k-sess", requestFingerprint: "f-1", userId: "user-alice", id: "session-1", deviceRefId: "device-laptop", expiresAt });
    expect(resolveActiveSession(harness.database, "session-1").user.id).toBe("user-alice");

    const revoked = revokeSession(harness.database, { deviceId: "dev-1", route: "/api/v1/sessions/revoke", key: "k-revoke", requestFingerprint: "f-1", actorUserId: "user-alice", id: "session-1" });
    expect(revoked.value.session.revokedAt).not.toBeNull();

    let captured: DomainError | undefined;
    try { resolveActiveSession(harness.database, "session-1"); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("forbidden");
    expect(captured?.message).toMatch(/revoked/);
    const eventRow = harness.database.prepare("SELECT type FROM domain_events WHERE aggregate_id=? AND aggregate_type='session' ORDER BY event_id DESC LIMIT 1").get("session-1") as { type: string };
    expect(eventRow.type).toBe("session.revoked");
  });

  it("enforces the role hierarchy: owner-only authorization rejects a viewer", async () => {
    await seedProject(harness.database, "project-y", "Project Y");
    ensureUser(harness.database, { deviceId: "dev-1", route: "/api/v1/users", key: "k-alice", requestFingerprint: "f-1", userId: "user-alice", displayName: "Alice" });
    ensureUser(harness.database, { deviceId: "dev-1", route: "/api/v1/users", key: "k-bob", requestFingerprint: "f-1", userId: "user-bob", displayName: "Bob" });
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "k-member-alice", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-y", userId: "user-alice", role: "owner" });
    await seedMembership(harness.database, "project-y", "user-bob", "viewer");

    const ownerRole = requireProjectRole(harness.database, "project-y", "user-alice", "owner");
    expect(ownerRole).toBe("owner");
    const viewerRole = requireProjectRole(harness.database, "project-y", "user-bob", "viewer");
    expect(viewerRole).toBe("viewer");

    let captured: DomainError | undefined;
    try { requireProjectRole(harness.database, "project-y", "user-bob", "owner"); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("forbidden");
    expect(captured?.details).toMatchObject({ actual: "viewer", minimum: "owner" });

    let outside: DomainError | undefined;
    try { requireProjectRole(harness.database, "project-y", "user-mallory", "viewer"); } catch (error) { outside = error as DomainError; }
    expect(outside).toBeInstanceOf(DomainError);
    expect(outside?.code).toBe("forbidden");
  });
});
