import { describe, expect, it, vi } from "vitest";
import { createPackageWorkspaceExecutionSessionRepository } from "../workspaceExecution/sessionRepository.js";
import { listRunSessions } from "../runSessions/repository.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { fixture, request, sessionPorts } from "./workspaceExecutionCoordinatorTestFixture.js";

describe("WorkspaceExecutionCoordinator observeExisting", () => {
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
