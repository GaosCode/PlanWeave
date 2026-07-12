/**
 * A2 acceptance tests.
 *
 * Acceptance criteria (from RFC §A2):
 *   1. Barrier-synchronized ≥20 claims for one task produce exactly one
 *      active assignment; the other 19 return `version_conflict` or
 *      `state_conflict`.
 *   2. Repeated submit/heartbeat with the same idempotency key returns
 *      identical response (`replayed: true`) — no extra event/audit row.
 *   3. Lease expiry: simulate an expired lease, call reclaim, assert
 *      state transitions + event emitted, no branches/submissions deleted.
 *   4. Dependency readiness: claim a task with an unfinished dependency
 *      returns `state_conflict` with the dep id in `details`.
 *   5. Parallel vs locked policy: parallel task accepts two active
 *      assignments (different task ids); locked task rejects the second.
 *
 * Each test runs against a real SQLite database in a temp directory; no
 * mocks. Tests share the A1 store primitives; v2 work migrations are
 * applied in the harness.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkError, type ClaimTaskCommand, type WorkServices } from "../ids.js";
import { cleanupHarness, createWorkHarness, type WorkTestHarness } from "./helpers.js";

describe("A2 transactional work coordination", () => {
  let harness: WorkTestHarness;

  beforeEach(async () => {
    harness = await createWorkHarness();
    harness.seedProject("project-a");
  });

  afterEach(async () => {
    await cleanupHarness(harness);
  });

  it("creates a v2 schema and accepts a single claim on a parallel task", () => {
    harness.seedTask({ projectId: "project-a", taskId: "task-1", parallel: true });
    const result = harness.services.claimTask(makeClaimCommand({
      taskId: "task-1",
      idempotencyKey: "claim-initial-aaaaaaaa"
    }));
    expect(result.replayed).toBe(false);
    expect(result.value.assignment.status).toBe("active");
    expect(result.value.task.status).toBe("leased");
    expect(result.value.assignment.branchName).toBe("feature/task-1");
  });

  it("rejects a second claim for a locked task (one active assignment invariant)", () => {
    harness.seedTask({ projectId: "project-a", taskId: "locked-1", parallel: false });
    const first = harness.services.claimTask(makeClaimCommand({
      taskId: "locked-1",
      idempotencyKey: "claim-locked-1-aaaaa"
    }));
    expect(first.value.assignment.status).toBe("active");
    expect(() =>
      harness.services.claimTask(makeClaimCommand({
        taskId: "locked-1",
        idempotencyKey: "claim-locked-1-bbbbb"
      }))
    ).toThrow(WorkError);
  });

  it("returns version_conflict for a stale expectedVersion", () => {
    harness.seedTask({ projectId: "project-a", taskId: "ver-1", parallel: true });
    // First claim bumps task version 1 -> 2
    harness.services.claimTask(makeClaimCommand({
      taskId: "ver-1",
      idempotencyKey: "claim-ver-1-aaaaaaa"
    }));
    // Second claim with expectedVersion=1 should fail
    let caught: WorkError | null = null;
    try {
      harness.services.claimTask(makeClaimCommand({
        taskId: "ver-1",
        idempotencyKey: "claim-ver-1-bbbbbbb",
        expectedVersion: 1
      }));
    } catch (error) {
      caught = error as WorkError;
    }
    expect(caught).toBeInstanceOf(WorkError);
    expect(caught?.code).toBe("version_conflict");
    expect(caught?.details.aggregateId).toBe("task_ver-1");
    expect(caught?.details.currentVersion).toBe(2);
  });

  it("replays a repeated submit command with the same idempotency key", () => {
    harness.seedTask({ projectId: "project-a", taskId: "sub-1", parallel: true });
    const claim = harness.services.claimTask(makeClaimCommand({
      taskId: "sub-1",
      idempotencyKey: "claim-sub-1-aaaaaaa"
    }));
    const submitCommand = makeSubmitCommand({
      assignmentId: claim.value.assignment.id,
      expectedVersion: claim.value.assignment.version,
      idempotencyKey: "submit-sub-1-aaaaaaa"
    });
    const first = harness.services.submit(submitCommand);
    expect(first.replayed).toBe(false);
    const eventCountAfterFirst = countEvents(harness);
    const auditCountAfterFirst = countAuditRows(harness);
    const idempotencyCountAfterFirst = countIdempotencyRows(harness);

    const second = harness.services.submit(submitCommand);
    expect(second.replayed).toBe(true);
    expect(second.value).toEqual(first.value);
    // No new event, no new audit row, no new idempotency row
    expect(countEvents(harness)).toBe(eventCountAfterFirst);
    expect(countAuditRows(harness)).toBe(auditCountAfterFirst);
    expect(countIdempotencyRows(harness)).toBe(idempotencyCountAfterFirst);
  });

  it("replays a repeated heartbeat command with the same idempotency key", () => {
    harness.seedTask({ projectId: "project-a", taskId: "hb-1", parallel: true });
    const claim = harness.services.claimTask(makeClaimCommand({
      taskId: "hb-1",
      idempotencyKey: "claim-hb-1-aaaaaaaa"
    }));
    const hb = makeHeartbeatCommand({
      assignmentId: claim.value.assignment.id,
      expectedVersion: claim.value.assignment.version,
      idempotencyKey: "heartbeat-hb-1-aaaaaa"
    });
    const first = harness.services.heartbeat(hb);
    expect(first.replayed).toBe(false);
    const eventCountAfterFirst = countEvents(harness);
    const second = harness.services.heartbeat(hb);
    expect(second.replayed).toBe(true);
    expect(second.value.newLeaseExpiresAt).toBe(first.value.newLeaseExpiresAt);
    expect(countEvents(harness)).toBe(eventCountAfterFirst);
  });

  it("rejects a claim whose dependencies are not all in a terminal-success state", () => {
    harness.seedTask({ projectId: "project-a", taskId: "dep-target", parallel: true });
    harness.seedTask({ projectId: "project-a", taskId: "dep-prereq", parallel: true });
    // Wire the dep edge manually (the harness helper only seeds self-contained tasks)
    harness.database
      .prepare("INSERT INTO work_task_dependencies(project_id,task_id,depends_on_task_id) VALUES (?,?,?)")
      .run("project-a", "task_dep-target", "task_dep-prereq");

    let caught: WorkError | null = null;
    try {
      harness.services.claimTask(makeClaimCommand({
        taskId: "dep-target",
        idempotencyKey: "claim-dep-target-aaa"
      }));
    } catch (error) {
      caught = error as WorkError;
    }
    expect(caught).toBeInstanceOf(WorkError);
    expect(caught?.code).toBe("state_conflict");
    expect(caught?.details.blockingDependencyIds).toEqual(["task_dep-prereq"]);
  });

  it("allows two active assignments when the task is parallel (one per task)", () => {
    harness.seedTask({ projectId: "project-a", taskId: "par-a", parallel: true });
    harness.seedTask({ projectId: "project-a", taskId: "par-b", parallel: true });
    const claimA = harness.services.claimTask(makeClaimCommand({
      taskId: "par-a",
      idempotencyKey: "claim-par-a-aaaaaaa"
    }));
    const claimB = harness.services.claimTask(makeClaimCommand({
      taskId: "par-b",
      idempotencyKey: "claim-par-b-aaaaaaa"
    }));
    expect(claimA.value.assignment.status).toBe("active");
    expect(claimB.value.assignment.status).toBe("active");
    // Same user can lease two parallel tasks
    const activeAssignments = harness.database
      .prepare("SELECT COUNT(*) AS c FROM work_assignments WHERE project_id=? AND status='active'")
      .get("project-a") as { c: number };
    expect(activeAssignments.c).toBe(2);
  });

  it("expires an active lease and re-arms the task without deleting the assignment or branch", () => {
    harness.seedTask({ projectId: "project-a", taskId: "lease-1", parallel: false });
    const claim = harness.services.claimTask(makeClaimCommand({
      taskId: "lease-1",
      idempotencyKey: "claim-lease-1-aaaaaa",
      leaseDurationSeconds: 5
    }));
    // Capture the branch name + assignment id; reclaim must not touch them
    const originalBranch = claim.value.assignment.branchName;
    const originalAssignmentId = claim.value.assignment.id;
    const originalBaseCommit = claim.value.assignment.baseCommit;

    // Force the lease into the past by writing a direct UPDATE. The real
    // server would advance the wall clock; in the test we just bend it.
    harness.database
      .prepare("UPDATE work_assignments SET lease_expires_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", originalAssignmentId);

    const eventCountBefore = countEvents(harness);
    const result = harness.services.reclaimExpiredLeases();
    expect(result.expiredAssignmentIds).toEqual([originalAssignmentId]);

    // Assignment row still exists with branch/base intact, status flipped to `expired`
    const row = harness.database
      .prepare("SELECT status, branch_name, base_commit FROM work_assignments WHERE id=?")
      .get(originalAssignmentId) as { status: string; branch_name: string; base_commit: string };
    expect(row.status).toBe("expired");
    expect(row.branch_name).toBe(originalBranch);
    expect(row.base_commit).toBe(originalBaseCommit);

    // Task is back to `ready` and version bumped so the next claim succeeds
    const task = harness.services.repository.loadTaskByServerId("project-a", "task_lease-1");
    expect(task?.status).toBe("ready");
    expect(task?.version).toBeGreaterThan(1);

    // A `task.lease_expired` event was emitted
    const eventCountAfter = countEvents(harness);
    expect(eventCountAfter).toBe(eventCountBefore + 1);
    const lastEvent = harness.database
      .prepare("SELECT type FROM domain_events ORDER BY event_id DESC LIMIT 1")
      .get() as { type: string };
    expect(lastEvent.type).toBe("task.lease_expired");
  });

  it("produces exactly one active assignment from 20 barrier-synchronized claims for the same task", async () => {
    harness.seedTask({ projectId: "project-a", taskId: "race-1", parallel: false });
    // Barrier: every caller awaits the same shared promise before issuing
    // its claim. With node:sqlite (synchronous), the 20 invocations still
    // serialize on the BEGIN IMMEDIATE write lock; the partial UNIQUE
    // index on work_assignments(status='active') ensures the database
    // invariant. The barrier makes the race intent explicit.
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const claimPromises: Array<Promise<{ status: "fulfilled" | "rejected"; reason?: unknown; value?: { value: { assignment: { status: string } } } }>> = [];
    for (let i = 0; i < 20; i++) {
      const command = makeClaimCommand({
        taskId: "race-1",
        idempotencyKey: `claim-race-1-${String(i).padStart(2, "0")}-aaaaa`
      });
      claimPromises.push(
        barrier.then(() => {
          try {
            const value = harness.services.claimTask(command);
            return { status: "fulfilled" as const, value: { value: { assignment: { status: value.value.assignment.status } } } };
          } catch (reason) {
            return { status: "rejected" as const, reason };
          }
        })
      );
    }
    release();
    const settled = await Promise.all(claimPromises);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(19);
    // The single winner has an active assignment
    expect(fulfilled[0]?.value?.value.assignment.status).toBe("active");
    // The 19 losers are deterministic conflicts
    for (const r of rejected) {
      const error = r.reason as WorkError;
      expect(["version_conflict", "state_conflict"]).toContain(error.code);
    }
    // The database invariant: exactly one active assignment row for the task
    const activeCount = harness.database
      .prepare("SELECT COUNT(*) AS c FROM work_assignments WHERE project_id=? AND task_id=? AND status='active'")
      .get("project-a", "task_race-1") as { c: number };
    expect(activeCount.c).toBe(1);
  });
});

/* ---------------------------------- *
 * Test command factories            *
 * ---------------------------------- */

function makeClaimCommand(overrides: Partial<ClaimTaskCommand> = {}): ClaimTaskCommand {
  return {
    deviceId: "device-a",
    idempotencyKey: "claim-default-16-chars-AA",
    commandType: "claim_task",
    aggregateType: "task",
    projectId: "project-a",
    actorId: "user-a",
    taskId: overrides.taskId ?? "default-task",
    branchName: `feature/${overrides.taskId ?? "default-task"}`,
    baseCommit: "deadbeefcafebabe000000000000000000000000",
    leaseDurationSeconds: 3600,
    ...overrides
  };
}

function makeSubmitCommand(overrides: { assignmentId: string; expectedVersion: number; idempotencyKey: string }) {
  return {
    deviceId: "device-a",
    idempotencyKey: overrides.idempotencyKey,
    commandType: "submit" as const,
    aggregateType: "assignment" as const,
    aggregateId: overrides.assignmentId,
    expectedVersion: overrides.expectedVersion,
    projectId: "project-a",
    actorId: "user-a",
    headCommit: "feedbeefcafebabe000000000000000000000000",
    baseCommit: "deadbeefcafebabe000000000000000000000000"
  };
}

function makeHeartbeatCommand(overrides: { assignmentId: string; expectedVersion: number; idempotencyKey: string }) {
  return {
    deviceId: "device-a",
    idempotencyKey: overrides.idempotencyKey,
    commandType: "heartbeat" as const,
    aggregateType: "assignment" as const,
    aggregateId: overrides.assignmentId,
    expectedVersion: overrides.expectedVersion,
    projectId: "project-a",
    actorId: "user-a",
    leaseDurationSeconds: 7200
  };
}

function countEvents(harness: WorkTestHarness): number {
  return (harness.database.prepare("SELECT COUNT(*) AS c FROM domain_events").get() as { c: number }).c;
}

function countAuditRows(harness: WorkTestHarness): number {
  return (harness.database.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
}

function countIdempotencyRows(harness: WorkTestHarness): number {
  return (harness.database.prepare("SELECT COUNT(*) AS c FROM idempotency_keys").get() as { c: number }).c;
}

// Re-export to satisfy unused-import linters / future tests
export type { WorkServices };
