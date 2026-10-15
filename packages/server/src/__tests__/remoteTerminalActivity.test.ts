import { describe, expect, it } from "vitest";
import { ActivityRepository } from "../comments/activityRepository.js";
import { SqliteRemoteDispatchPersistence } from "../remoteCoordinatorPersistence.js";
import { RemoteCoordinatorCheckpointCrash } from "../remoteBlockCoordinatorPorts.js";
import {
  setupTerminalActivity,
  terminalMessages
} from "./support/remoteTerminalActivityFixture.js";

const workItem = { kind: "block", canvasId: "default", blockRef: "T-001#B-001" };

describe("production Host terminal Activity", () => {
  it.each([
    "complete",
    "fail"
  ] as const)("projects real Host %s with Canvas privacy across HTTP, live and replay", async (action) => {
    const fixture = await setupTerminalActivity();
    const { dispatch, operation } = await fixture.start();
    const baseline = fixture.activity.humanObserverJournal.appendInCallerTransaction(
      { workspaceId: fixture.scope.workspaceId, projectId: fixture.scope.projectId },
      { kind: "project" }
    );
    const visible = await fixture.connect(fixture.viewer.token, baseline.cursor, 1);
    await visible.ready;
    const hidden = await fixture.connect(fixture.hidden.token, baseline.cursor, 1);
    await hidden.ready;
    const visibleLive = terminalMessages(visible.socket, 3);
    const hiddenLive = terminalMessages(hidden.socket, 1);
    await fixture.terminal(action, dispatch);
    const type = action === "complete" ? "remote_run_succeeded" : "remote_run_failed";
    expect(fixture.coordination.dispatches.getRequired(dispatch.id).status).toBe(
      action === "complete" ? "completed" : "failed"
    );
    expect(fixture.coordination.operations.getRequired(operation.id).state).toBe(
      action === "complete" ? "completed" : "failed"
    );
    expect(
      (await fixture.read(fixture.viewer.token)).items.filter((item) => item.type === type)
    ).toEqual([expect.objectContaining({ type, workItem })]);
    expect(
      (await fixture.read(fixture.hidden.token)).items.filter((item) =>
        item.type.startsWith("remote_run")
      )
    ).toEqual([]);
    const barrier = fixture.activity.humanObserverJournal.appendInCallerTransaction(
      { workspaceId: fixture.scope.workspaceId, projectId: fixture.scope.projectId },
      {
        kind: "project"
      }
    );
    await expect(visibleLive).resolves.toMatchObject([
      {
        kind: "remote_run",
        remoteRunStatus: action === "complete" ? "succeeded" : "failed",
        workItem
      },
      { kind: "activity", workItem },
      { kind: "project", cursor: barrier.cursor }
    ]);
    await expect(hiddenLive).resolves.toMatchObject([{ kind: "project", cursor: barrier.cursor }]);
    const visibleReplay = await fixture.connect(fixture.viewer.token, baseline.cursor, 4);
    await expect(visibleReplay.ready).resolves.toMatchObject([
      { kind: "remote_run", workItem },
      { kind: "activity", workItem },
      { kind: "project", cursor: barrier.cursor },
      { type: "human.observer.welcome" }
    ]);
    const hiddenReplay = await fixture.connect(fixture.hidden.token, baseline.cursor, 2);
    await expect(hiddenReplay.ready).resolves.toMatchObject([
      { kind: "project", cursor: barrier.cursor },
      { type: "human.observer.welcome" }
    ]);
  });

  it.each([
    ["complete", "after_terminal_event_persistence"],
    ["complete", "after_dispatch_terminal_persistence"],
    ["fail", "after_terminal_event_persistence"],
    ["fail", "after_dispatch_terminal_persistence"]
  ] as const)("recovers %s at %s with exactly one terminal Activity", async (action, checkpoint) => {
    let crashed = false;
    const fixture = await setupTerminalActivity({
      reached(point) {
        if (point === checkpoint && !crashed) {
          crashed = true;
          throw new RemoteCoordinatorCheckpointCrash(point);
        }
      }
    });
    const { dispatch, operation } = await fixture.start();
    await expect(fixture.terminal(action, dispatch)).rejects.toThrow(
      `injected_crash:${checkpoint}`
    );
    const expectedState = action === "complete" ? "completed" : "failed";
    expect(fixture.coordination.operations.getRequired(operation.id).state).toBe("activated");
    const recovered = await fixture.restart();
    expect(recovered.operations.getRequired(operation.id).state).toBe(expectedState);
    expect(recovered.dispatches.getRequired(dispatch.id).status).toBe(expectedState);
    await recovered.coordinator.reenter(operation.id);
    await recovered.reconcile();
    const type = action === "complete" ? "remote_run_succeeded" : "remote_run_failed";
    new ActivityRepository(fixture.database, {
      workspaceId: fixture.scope.workspaceId
    }).reconcileOutbox();
    expect(
      (await fixture.read(fixture.viewer.token)).items.filter((item) => item.type === type)
    ).toEqual([expect.objectContaining({ type, workItem })]);
    const rows = fixture.database
      .prepare(
        "SELECT event_json FROM human_observer_events WHERE workspace_id=? AND project_id=? ORDER BY cursor"
      )
      .all(fixture.scope.workspaceId, fixture.scope.projectId);
    const terminalEvents = rows
      .map(
        (row) =>
          JSON.parse(String(row.event_json)) as { remoteRunStatus?: string; workItem?: object }
      )
      .filter(
        (event) => event.remoteRunStatus === (action === "complete" ? "succeeded" : "failed")
      );
    expect(terminalEvents).toEqual([expect.objectContaining({ kind: "remote_run", workItem })]);
    expect(
      fixture.database
        .prepare("SELECT 1 FROM dispatch_events WHERE dispatch_id=? AND type=?")
        .all(dispatch.id, `dispatch.${expectedState}`)
    ).toHaveLength(1);
  });
  it.each([
    "complete",
    "fail"
  ] as const)("rolls back %s terminal persistence when Activity storage fails and recovers once", async (action) => {
    const fixture = await setupTerminalActivity();
    const { dispatch, operation } = await fixture.start();
    const type = action === "complete" ? "remote_run_succeeded" : "remote_run_failed";
    fixture.database.exec(`CREATE TRIGGER reject_terminal_activity BEFORE INSERT ON activity_records
      WHEN NEW.type IN ('remote_run_succeeded','remote_run_failed')
      BEGIN SELECT RAISE(ABORT, 'injected_activity_storage_failure'); END;`);
    await expect(fixture.terminal(action, dispatch)).rejects.toThrow(
      "injected_activity_storage_failure"
    );
    expect(fixture.coordination.dispatches.getRequired(dispatch.id).status).toBe(
      "awaiting_writeback"
    );
    expect(fixture.coordination.operations.getRequired(operation.id).state).toBe("activated");
    expect(
      fixture.database
        .prepare(
          "SELECT 1 FROM dispatch_events WHERE dispatch_id=? AND type IN ('dispatch.completed','dispatch.failed')"
        )
        .all(dispatch.id)
    ).toEqual([]);
    expect(
      fixture.database
        .prepare(
          "SELECT 1 FROM activity_projection_outbox WHERE json_extract(activity_json,'$.type')=?"
        )
        .all(type)
    ).toEqual([]);
    expect(
      fixture.database
        .prepare(
          "SELECT 1 FROM human_observer_events WHERE json_extract(event_json,'$.remoteRunStatus')=?"
        )
        .all(action === "complete" ? "succeeded" : "failed")
    ).toEqual([]);
    fixture.database.exec("DROP TRIGGER reject_terminal_activity");
    const recovered = await fixture.restart();
    await recovered.coordinator.reenter(operation.id);
    expect(
      (await fixture.read(fixture.viewer.token)).items.filter((item) => item.type === type)
    ).toEqual([expect.objectContaining({ type, workItem })]);
  });

  it("rejects mismatched dispatch identity even when the requested terminal state already exists", async () => {
    const fixture = await setupTerminalActivity();
    const { dispatch, operation } = await fixture.start();
    await fixture.terminal("fail", dispatch);
    const terminal = fixture.coordination.operations.getRequired(operation.id);
    const persistence = new SqliteRemoteDispatchPersistence(fixture.database);
    for (const field of ["workspaceId", "projectId", "blockRef", "executionAttemptId"] as const) {
      expect(() =>
        persistence.finishTerminal({
          operation: { ...terminal, [field]: "wrong-identity" },
          status: "failed"
        })
      ).toThrow("remote_dispatch_terminal_identity_mismatch");
    }
    for (const field of ["hostId", "leaseId"] as const) {
      expect(() =>
        persistence.finishTerminal({
          operation: { ...terminal, attempt: { ...terminal.attempt, [field]: "wrong-identity" } },
          status: "failed"
        })
      ).toThrow("remote_dispatch_terminal_identity_mismatch");
    }
    expect(fixture.coordination.dispatches.getRequired(dispatch.id).status).toBe("failed");
    expect(
      (await fixture.read(fixture.viewer.token)).items.filter(
        (item) => item.type === "remote_run_failed"
      )
    ).toHaveLength(1);
  });
});
