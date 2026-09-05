import { describe, expect, it, vi } from "vitest";
import { createPackageWorkspaceExecutionSessionRepository } from "../workspaceExecution/sessionRepository.js";
import { listRunSessions } from "../runSessions/repository.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import {
  fixture,
  request,
  sessionPorts,
  emptyReplay,
  authorityResolver,
  observation,
  revisions
} from "./workspaceExecutionCoordinatorTestFixture.js";

describe("WorkspaceExecutionCoordinator observeExisting", () => {
  it("reads completed history after content and assignment revisions change without rebinding the saved run", async () => {
    const { root } = await createTestWorkspace();
    const initialRequest = request(root);
    const first = fixture({ packageWorkspace: root });
    const input = {
      authority: initialRequest.authority,
      scope: initialRequest.scope,
      operationId: "operation-1"
    };
    const initial = await first.coordinator.observeExisting(input);
    const current = {
      contentRevision: "snapshot:revision-2",
      graphFingerprint: `pkg-${"b".repeat(64)}`
    };
    const changed = fixture({
      packageWorkspace: root,
      authority: authorityResolver(root, {
        ...current,
        authorityRevisions: { ...revisions, executionTargetRevision: 4 }
      })
    });
    const reopened = await changed.coordinator.observeExisting({
      ...input,
      authority: {
        ...input.authority,
        contentAuthority: { ...input.authority.contentAuthority, expected: current }
      }
    });
    expect(reopened.session.sessionId).toBe(initial.session.sessionId);
    expect(reopened.session.workspaceExecution?.binding).toEqual(
      initial.session.workspaceExecution?.binding
    );
    expect(reopened.session.phase).toBe("completed");
    expect(changed.dispatch).not.toHaveBeenCalled();
  });

  it("attaches completed history at older revisions but rejects stale active execution", async () => {
    const { root } = await createTestWorkspace();
    const executionRequest = request(root);
    const authority = authorityResolver(root, {
      authorityRevisions: { ...revisions, executionTargetRevision: 4 }
    });
    const input = {
      authority: executionRequest.authority,
      scope: executionRequest.scope,
      operationId: "operation-1"
    };
    const active = fixture({
      packageWorkspace: root,
      authority,
      observe: async () => observation()
    });
    await expect(active.coordinator.observeExisting(input)).rejects.toMatchObject({
      code: "workspace_execution_resume_mismatch"
    });
    const completed = fixture({ packageWorkspace: root, authority });
    expect((await completed.coordinator.observeExisting(input)).session.phase).toBe("completed");
    expect(completed.dispatch).not.toHaveBeenCalled();
  });

  it("replays from the new consumer cursor instead of the persisted execution cursor", async () => {
    const { root } = await createTestWorkspace();
    const executionRequest = request(root);
    const replay = async (afterCursor: number) => ({
      ...emptyReplay(afterCursor),
      cursor: 1,
      highWatermark: 1,
      events:
        afterCursor === 0
          ? [
              {
                eventVersion: 2 as const,
                cursor: 1,
                sourceSequence: 1,
                timestamp: "2030-01-01T00:00:01.000Z",
                fragment: {
                  kind: "engine_terminal" as const,
                  terminal: { state: "succeeded" as const, stopReason: "end_turn" }
                }
              }
            ]
          : []
    });
    const first = fixture({ packageWorkspace: root, replay });
    const input = {
      authority: executionRequest.authority,
      scope: executionRequest.scope,
      operationId: "operation-1"
    };
    const initial = await first.coordinator.observeExisting(input);
    expect(initial.handle).toMatchObject({ cursor: { eventCursor: 1 } });
    const second = fixture({ packageWorkspace: root, replay });
    const reopened = await second.coordinator.observeExisting(input);
    expect(reopened.events.some((event) => event.type === "runner_event")).toBe(true);
    expect(second.replay).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterCursor: 0 }),
      undefined
    );
    await second.coordinator.observeExisting({
      ...input,
      evidenceCursor: { target: "remote", executionAttemptId: "attempt-1", eventCursor: 1 }
    });
    expect(second.replay).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterCursor: 1 }),
      undefined
    );
    await second.coordinator.observeExisting({
      ...input,
      evidenceCursor: { target: "remote", executionAttemptId: "previous-attempt", eventCursor: 100 }
    });
    expect(second.replay).toHaveBeenLastCalledWith(
      expect.objectContaining({ afterCursor: 0 }),
      undefined
    );
    expect(second.dispatch).not.toHaveBeenCalled();
    expect((await listRunSessions(root)).sessions).toHaveLength(1);
  });
  it("attaches without Catalog, work authority, or Dispatch", async () => {
    const { root } = await createTestWorkspace();
    const executionRequest = request(root);
    const first = fixture({ packageWorkspace: root });

    const attached = await first.coordinator.observeExisting({
      authority: executionRequest.authority,
      scope: executionRequest.scope,
      operationId: "operation-1"
    });

    expect(attached.handle).toMatchObject({ operationId: "operation-1" });
    expect(first.observe).toHaveBeenCalledOnce();
    expect(first.catalog).not.toHaveBeenCalled();
    expect(first.workAuthority).not.toHaveBeenCalled();
    expect(first.dispatch).not.toHaveBeenCalled();
  });

  it("reuses one observed session across Coordinator instances", async () => {
    const { root } = await createTestWorkspace();
    const executionRequest = request(root);
    const first = fixture({ packageWorkspace: root });
    const second = fixture({ packageWorkspace: root });
    const input = {
      authority: executionRequest.authority,
      scope: executionRequest.scope,
      operationId: "operation-1"
    };

    const initial = await first.coordinator.observeExisting(input);
    const resumed = await second.coordinator.observeExisting(input);

    expect(resumed.session.sessionId).toBe(initial.session.sessionId);
    expect((await listRunSessions(root)).sessions).toHaveLength(1);
    expect(first.dispatch).not.toHaveBeenCalled();
    expect(second.dispatch).not.toHaveBeenCalled();
  });

  it("fails closed when one operation matches multiple local sessions", async () => {
    const { root } = await createTestWorkspace();
    const executionRequest = request(root);
    const repository = createPackageWorkspaceExecutionSessionRepository();
    const first = fixture({ packageWorkspace: root, sessions: repository });
    const input = {
      authority: executionRequest.authority,
      scope: executionRequest.scope,
      operationId: "operation-1"
    };

    await first.coordinator.observeExisting(input);
    const session = (await repository.list({ kind: "package", packageWorkspace: root }))
      .sessions[0];
    expect(session).toBeDefined();
    if (!session) return;
    const create = vi.fn(repository.create);
    const ambiguous = fixture({
      packageWorkspace: root,
      sessions: sessionPorts({
        create,
        list: vi.fn(async () => ({
          sessions: [session, { ...session, sessionId: "SESSION-9999" }],
          diagnostics: []
        }))
      })
    });

    await expect(ambiguous.coordinator.observeExisting(input)).rejects.toMatchObject({
      code: "workspace_execution_resume_mismatch"
    });
    expect(create).not.toHaveBeenCalled();
    expect(ambiguous.dispatch).not.toHaveBeenCalled();
  });

  it("rejects a wrong scope before session state is written", async () => {
    const { root } = await createTestWorkspace();
    const executionRequest = request(root);
    const current = fixture({ packageWorkspace: root });

    await expect(
      current.coordinator.observeExisting({
        authority: executionRequest.authority,
        scope: { kind: "block", blockRef: "T-001#R-001" },
        operationId: "operation-1"
      })
    ).rejects.toMatchObject({ code: "workspace_execution_authority_mismatch" });

    expect((await listRunSessions(root)).sessions).toHaveLength(0);
    expect(current.catalog).not.toHaveBeenCalled();
    expect(current.dispatch).not.toHaveBeenCalled();
  });
});
