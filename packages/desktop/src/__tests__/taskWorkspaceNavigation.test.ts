import { describe, expect, it } from "vitest";
import {
  blockWorkspaceTarget,
  graphNavigationSnapshotSchema,
  recordAuthorityTargetSchema,
  resolveGraphNavigationSnapshot,
  resolveTaskWorkspaceNavigation,
  runWorkspaceTarget,
  sameTaskWorkspaceNavigationIdentity,
  taskWorkspaceNavigationIdentity,
  taskWorkspaceNavigationIdentitySchema,
  taskWorkspaceTarget,
  type TaskWorkspaceNavigationAuthority,
  type TaskWorkspaceNavigationIdentityInput
} from "../renderer/taskWorkspaceNavigation";

function tupleKey(...parts: Array<string | undefined>): string {
  return JSON.stringify(parts);
}

const projects = new Set(["/projects/demo"]);
const canvases = new Set([
  tupleKey("/projects/demo", "canvas-main"),
  tupleKey("/projects/demo", "canvas-next")
]);
const tasks = new Set([
  tupleKey("/projects/demo", "canvas-main", "T-001"),
  tupleKey("/projects/demo", "canvas-main", "T-002"),
  tupleKey("/projects/demo", "canvas-next", "T-001")
]);
const blocks = new Set([
  tupleKey("/projects/demo", "canvas-main", "T-001", "T-001#B-001"),
  tupleKey("/projects/demo", "canvas-main", "T-001", "T-001#B-002"),
  tupleKey("/projects/demo", "canvas-main", "T-002", "T-002#B-001"),
  tupleKey("/projects/demo", "canvas-next", "T-001", "T-001#B-002")
]);
const records = new Set([
  tupleKey("/projects/demo", "canvas-main", "T-001", "T-001#B-001", "RUN-001"),
  tupleKey("/projects/demo", "canvas-main", "T-002", "T-002#B-001", "RUN-SHARED"),
  tupleKey("/projects/demo", "canvas-next", "T-001", "T-001#B-002", "RUN-NEXT")
]);

const authority: TaskWorkspaceNavigationAuthority = {
  hasProject: ({ projectRoot }) => projects.has(projectRoot),
  hasCanvas: ({ projectRoot, canvasId }) => canvases.has(tupleKey(projectRoot, canvasId)),
  hasTask: ({ projectRoot, canvasId, taskId }) =>
    tasks.has(tupleKey(projectRoot, canvasId, taskId)),
  hasBlock: ({ projectRoot, canvasId, taskId, blockRef }) =>
    blocks.has(tupleKey(projectRoot, canvasId, taskId, blockRef)),
  hasRecord: ({ projectRoot, canvasId, taskId, blockRef, recordId }) =>
    records.has(tupleKey(projectRoot, canvasId, taskId, blockRef, recordId))
};

const source = {
  view: "graph",
  graphSnapshot: {
    projectRoot: "/projects/demo",
    canvasId: "canvas-main",
    viewport: { x: 10, y: -20, zoom: 0.8 },
    selectedTaskId: "T-001",
    selectedBlockRef: "T-001#B-001"
  }
};

function runNavigation(
  patch: Partial<TaskWorkspaceNavigationIdentityInput> = {}
): TaskWorkspaceNavigationIdentityInput {
  return {
    projectRoot: "/projects/demo",
    canvasId: "canvas-main",
    taskId: "T-001",
    blockRef: "T-001#B-001",
    recordId: "RUN-001",
    source,
    ...patch
  };
}

describe("Task Workspace navigation construction", () => {
  it("normalizes task, block, and run entry points into one identity shape", () => {
    const task = taskWorkspaceNavigationIdentity(
      taskWorkspaceTarget({
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001"
      }),
      source
    );
    const block = taskWorkspaceNavigationIdentity(
      blockWorkspaceTarget({
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001"
      }),
      source
    );
    const run = taskWorkspaceNavigationIdentity(
      runWorkspaceTarget({
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        recordId: "RUN-001"
      }),
      source
    );

    expect(task).toMatchObject({ taskId: "T-001", source });
    expect(block).toMatchObject({ taskId: "T-001", blockRef: "T-001#B-001", source });
    expect(run).toMatchObject({
      taskId: "T-001",
      blockRef: "T-001#B-001",
      recordId: "RUN-001",
      source
    });
  });

  it("compares structured navigation fields without treating source as action identity", () => {
    const target = runWorkspaceTarget({
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      recordId: "RUN-001"
    });
    const left = taskWorkspaceNavigationIdentity(target, source);
    const sameTargetFromSearch = taskWorkspaceNavigationIdentity(target, { view: "search" });
    const otherCanvas = taskWorkspaceNavigationIdentity(
      runWorkspaceTarget({ ...target, canvasId: "canvas-next", recordId: "RUN-NEXT" }),
      source
    );

    expect(sameTaskWorkspaceNavigationIdentity(left, sameTargetFromSearch)).toBe(true);
    expect(sameTaskWorkspaceNavigationIdentity(left, otherCanvas)).toBe(false);
  });

  it("strictly rejects mismatched refs, extra fields, and invalid viewport selection", () => {
    expect(() =>
      blockWorkspaceTarget({
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-002#B-001"
      })
    ).toThrow("blockRef must belong to taskId");
    expect(
      taskWorkspaceNavigationIdentitySchema.safeParse({
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        source: { view: "graph" },
        displayRunId: "RUN-001"
      }).success
    ).toBe(false);
    expect(
      graphNavigationSnapshotSchema.safeParse({
        ...source.graphSnapshot,
        selectedTaskId: "T-002"
      }).success
    ).toBe(false);
  });
});

describe("Task Workspace navigation authority", () => {
  it.each([
    [runNavigation({ projectRoot: "/projects/missing" }), "project_unavailable"],
    [runNavigation({ canvasId: "canvas-missing" }), "canvas_unavailable"],
    [
      runNavigation({
        canvasId: "canvas-next",
        taskId: "T-002",
        blockRef: undefined,
        recordId: undefined
      }),
      "task_unavailable"
    ],
    [
      runNavigation({
        canvasId: "canvas-next",
        blockRef: "T-001#B-001",
        recordId: undefined
      }),
      "block_unavailable"
    ],
    [runNavigation({ recordId: "RUN-404" }), "record_unavailable"]
  ] as const)("reports stale hierarchical selection as %s", (navigation, reason) => {
    expect(resolveTaskWorkspaceNavigation(navigation, authority)).toMatchObject({
      status: "invalid",
      reason
    });
  });

  it("rejects a record that exists only under another task", () => {
    expect(
      resolveTaskWorkspaceNavigation(runNavigation({ recordId: "RUN-SHARED" }), authority)
    ).toMatchObject({ status: "invalid", reason: "record_unavailable" });
  });

  it("rejects a record that exists only on another canvas", () => {
    expect(
      resolveTaskWorkspaceNavigation(
        runNavigation({
          canvasId: "canvas-next",
          blockRef: "T-001#B-002",
          recordId: "RUN-001"
        }),
        authority
      )
    ).toMatchObject({ status: "invalid", reason: "record_unavailable" });
  });

  it("rejects a record that exists under another block in the same task", () => {
    expect(
      resolveTaskWorkspaceNavigation(runNavigation({ blockRef: "T-001#B-002" }), authority)
    ).toMatchObject({ status: "invalid", reason: "record_unavailable" });
  });

  it("accepts only the complete authoritative tuple", () => {
    expect(resolveTaskWorkspaceNavigation(runNavigation(), authority)).toMatchObject({
      status: "valid",
      navigation: {
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        recordId: "RUN-001"
      }
    });
  });

  it("passes a strict record authority target without navigation source", () => {
    const strictAuthority: TaskWorkspaceNavigationAuthority = {
      ...authority,
      hasRecord: (target) => {
        expect(recordAuthorityTargetSchema.safeParse(target).success).toBe(true);
        expect(target).not.toHaveProperty("source");
        return authority.hasRecord(target);
      }
    };

    expect(resolveTaskWorkspaceNavigation(runNavigation(), strictAuthority)).toMatchObject({
      status: "valid"
    });
  });

  it("reports stale graph selections without selecting a fallback", () => {
    expect(
      resolveGraphNavigationSnapshot(
        {
          ...source.graphSnapshot,
          canvasId: "canvas-next",
          selectedTaskId: "T-002",
          selectedBlockRef: null
        },
        authority
      )
    ).toMatchObject({ status: "invalid", reason: "task_unavailable" });
  });
});
