import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, addMembership, createDevice, createSession, ensureUser, type Session } from "../../identity/index.js";
import { appendRevision, createProposal, createProposalService, getRevision, listApprovalsForRevision, listRevisions, recordApproval, transitionProposal, type ProposalService } from "../index.js";
import { cleanupTestHarness, createTestDatabase, seedMembership, seedProject, type TestHarness } from "../../identity/__tests__/testDatabase.js";

function makeSession(database: TestHarness["database"], userId: string, deviceId: string, sessionId: string): Session {
  ensureUser(database, { deviceId, route: "/api/v1/users", key: `u-${userId}`, requestFingerprint: "f-1", userId, displayName: userId });
  createDevice(database, { deviceId, route: "/api/v1/devices", key: `d-${deviceId}`, requestFingerprint: "f-1", userId, id: deviceId, deviceName: deviceId });
  const session = createSession(database, { deviceId, route: "/api/v1/sessions", key: `s-${sessionId}`, requestFingerprint: "f-1", userId, id: sessionId, deviceRefId: deviceId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return session.value.session;
}

describe("proposals module", () => {
  let harness: TestHarness;
  let service: ProposalService;
  beforeEach(async () => {
    harness = await createTestDatabase();
    service = createProposalService({ database: harness.database });
  });
  afterEach(async () => { await cleanupTestHarness(harness); });

  it("creates a proposal with revision 1, records an owner approval, and transitions to approved", async () => {
    await seedProject(harness.database, "project-prop", "Proposal Project");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-author", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-prop", userId: "user-alice", role: "contributor" });
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-owner", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-prop", userId: "user-owner", role: "owner" });
    const alice = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const owner = makeSession(harness.database, "user-owner", "device-owner", "session-owner");

    const created = createProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals", key: "p-1", requestFingerprint: "f-1", projectId: "project-prop", title: "Adopt new merge policy", body: "Use rebase before push.", citations: [{ kind: "message", id: "m-1" }, { kind: "attachment", id: "a-1" }] });
    expect(created.value.proposal.status).toBe("draft");
    expect(created.value.proposal.version).toBe(1);
    expect(created.value.revision.revisionNumber).toBe(1);

    const opened = transitionProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals/transition", key: "p-2", requestFingerprint: "f-1", proposalId: created.value.proposal.id, nextStatus: "open", expectedVersion: 1 });
    expect(opened.value.proposal.status).toBe("open");
    expect(opened.value.proposal.version).toBe(2);

    const approval = recordApproval(service, owner, { deviceId: "dev-1", route: "/api/v1/approvals", key: "ap-1", requestFingerprint: "f-1", proposalId: created.value.proposal.id, revisionId: created.value.revision.id, decision: "approve", reason: "LGTM" });
    expect(approval.value.approval.decision).toBe("approve");
    expect(listApprovalsForRevision(harness.database, created.value.revision.id)).toHaveLength(1);

    const approved = transitionProposal(service, owner, { deviceId: "dev-1", route: "/api/v1/proposals/transition", key: "p-3", requestFingerprint: "f-1", proposalId: created.value.proposal.id, nextStatus: "approved", expectedVersion: 2 });
    expect(approved.value.proposal.status).toBe("approved");
    expect(approved.value.proposal.version).toBe(3);
  });

  it("invalidates prior approvals when a new revision is appended", async () => {
    await seedProject(harness.database, "project-rev", "Rev");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-author-rev", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-rev", userId: "user-alice", role: "contributor" });
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-owner-rev", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-rev", userId: "user-owner", role: "owner" });
    const alice = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const owner = makeSession(harness.database, "user-owner", "device-owner", "session-owner");

    const created = createProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals", key: "p-rev-1", requestFingerprint: "f-1", projectId: "project-rev", title: "Original", body: "Original body" });
    transitionProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals/transition", key: "p-rev-open-1", requestFingerprint: "f-1", proposalId: created.value.proposal.id, nextStatus: "open", expectedVersion: 1 });
    recordApproval(service, owner, { deviceId: "dev-1", route: "/api/v1/approvals", key: "ap-rev-1", requestFingerprint: "f-1", proposalId: created.value.proposal.id, revisionId: created.value.revision.id, decision: "approve" });
    expect(listApprovalsForRevision(harness.database, created.value.revision.id)).toHaveLength(1);

    const appended = appendRevision(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals/revision", key: "p-rev-2", requestFingerprint: "f-1", proposalId: created.value.proposal.id, title: "Updated", body: "Refined body", expectedVersion: 2 });
    expect(appended.value.proposal.version).toBe(3);
    expect(appended.value.revision.revisionNumber).toBe(2);

    expect(listApprovalsForRevision(harness.database, created.value.revision.id)).toHaveLength(1);
    expect(listApprovalsForRevision(harness.database, appended.value.revision.id)).toHaveLength(0);
    expect(listRevisions(harness.database, created.value.proposal.id)).toHaveLength(2);

    const row = harness.database.prepare("SELECT body FROM proposal_revisions WHERE id=?").get(created.value.revision.id) as { body: string };
    expect(row.body).toBe("Original body");
  });

  it("rejects a non-owner approval as forbidden and refuses to transition without qualifying approvals", async () => {
    await seedProject(harness.database, "project-pol", "Policy");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-author-pol", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-pol", userId: "user-alice", role: "contributor" });
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-maint-pol", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-pol", userId: "user-maint", role: "maintainer" });
    await seedMembership(harness.database, "project-pol", "user-bob", "contributor");
    const alice = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const bob = makeSession(harness.database, "user-bob", "device-bob", "session-bob");
    const maint = makeSession(harness.database, "user-maint", "device-maint", "session-maint");

    const created = createProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals", key: "p-pol-1", requestFingerprint: "f-1", projectId: "project-pol", title: "Policy", body: "Body" });
    transitionProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals/transition", key: "p-pol-open", requestFingerprint: "f-1", proposalId: created.value.proposal.id, nextStatus: "open", expectedVersion: 1 });

    let captured: DomainError | undefined;
    try { recordApproval(service, bob, { deviceId: "dev-1", route: "/api/v1/approvals", key: "ap-pol-1", requestFingerprint: "f-1", proposalId: created.value.proposal.id, revisionId: created.value.revision.id, decision: "approve" }); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("forbidden");

    let approvedCaptured: DomainError | undefined;
    try { transitionProposal(service, maint, { deviceId: "dev-1", route: "/api/v1/proposals/transition", key: "p-pol-approve", requestFingerprint: "f-1", proposalId: created.value.proposal.id, nextStatus: "approved", expectedVersion: 2 }); } catch (error) { approvedCaptured = error as DomainError; }
    expect(approvedCaptured).toBeInstanceOf(DomainError);
    expect(approvedCaptured?.code).toBe("state_conflict");
    expect(approvedCaptured?.details).toMatchObject({ qualifyingCount: 0, requiredCount: 1, requiredRole: "owner" });
  });

  it("replays a record-approval command with the same idempotency key", async () => {
    await seedProject(harness.database, "project-replay", "Replay");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-author-rep", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-replay", userId: "user-alice", role: "contributor" });
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-owner-rep", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-replay", userId: "user-owner", role: "owner" });
    const alice = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const owner = makeSession(harness.database, "user-owner", "device-owner", "session-owner");
    const created = createProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals", key: "p-rep-1", requestFingerprint: "f-1", projectId: "project-replay", title: "Replay", body: "Body" });
    transitionProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals/transition", key: "p-rep-open", requestFingerprint: "f-1", proposalId: created.value.proposal.id, nextStatus: "open", expectedVersion: 1 });

    const first = recordApproval(service, owner, { deviceId: "dev-1", route: "/api/v1/approvals", key: "ap-rep-1", requestFingerprint: "f-1", proposalId: created.value.proposal.id, revisionId: created.value.revision.id, decision: "approve" });
    const second = recordApproval(service, owner, { deviceId: "dev-1", route: "/api/v1/approvals", key: "ap-rep-1", requestFingerprint: "f-1", proposalId: created.value.proposal.id, revisionId: created.value.revision.id, decision: "approve" });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(listApprovalsForRevision(harness.database, created.value.revision.id)).toHaveLength(1);
  });

  it("returns version_conflict with correct details when expectedVersion is stale", async () => {
    await seedProject(harness.database, "project-stale", "Stale");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-author-st", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-stale", userId: "user-alice", role: "contributor" });
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-owner-st", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-stale", userId: "user-owner", role: "owner" });
    const alice = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const owner = makeSession(harness.database, "user-owner", "device-owner", "session-owner");
    const created = createProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals", key: "p-st-1", requestFingerprint: "f-1", projectId: "project-stale", title: "Stale", body: "Body" });
    transitionProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals/transition", key: "p-st-open", requestFingerprint: "f-1", proposalId: created.value.proposal.id, nextStatus: "open", expectedVersion: 1 });
    recordApproval(service, owner, { deviceId: "dev-1", route: "/api/v1/approvals", key: "ap-st-1", requestFingerprint: "f-1", proposalId: created.value.proposal.id, revisionId: created.value.revision.id, decision: "approve" });

    appendRevision(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals/revision", key: "p-st-rev", requestFingerprint: "f-1", proposalId: created.value.proposal.id, title: "Stale v2", body: "Body v2", expectedVersion: 2 });

    let captured: DomainError | undefined;
    try { transitionProposal(service, owner, { deviceId: "dev-1", route: "/api/v1/proposals/transition", key: "p-st-approve", requestFingerprint: "f-1", proposalId: created.value.proposal.id, nextStatus: "approved", expectedVersion: 2 }); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("version_conflict");
    expect(captured?.details).toMatchObject({ aggregateType: "proposal", aggregateId: created.value.proposal.id });
    const details = captured?.details as { currentVersion?: number; expectedVersion?: number };
    expect(typeof details.currentVersion).toBe("number");
    expect(details.currentVersion).toBeGreaterThan(2);
    expect(details.expectedVersion).toBe(2);
  });

  it("rejects an approval on a non-current revision with state_conflict", async () => {
    await seedProject(harness.database, "project-stale2", "Stale2");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-a-st2", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-stale2", userId: "user-alice", role: "contributor" });
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-o-st2", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-stale2", userId: "user-owner", role: "owner" });
    const alice = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const owner = makeSession(harness.database, "user-owner", "device-owner", "session-owner");
    const created = createProposal(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals", key: "p-st2-1", requestFingerprint: "f-1", projectId: "project-stale2", title: "T", body: "B" });
    const appended = appendRevision(service, alice, { deviceId: "dev-1", route: "/api/v1/proposals/revision", key: "p-st2-rev", requestFingerprint: "f-1", proposalId: created.value.proposal.id, title: "T2", body: "B2", expectedVersion: 1 });
    let captured: DomainError | undefined;
    try { recordApproval(service, owner, { deviceId: "dev-1", route: "/api/v1/approvals", key: "ap-st2-1", requestFingerprint: "f-1", proposalId: created.value.proposal.id, revisionId: created.value.revision.id, decision: "approve" }); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("state_conflict");
    expect(getRevision(harness.database, appended.value.revision.id).revisionNumber).toBe(2);
  });
});
