import { describe, expect, it, vi } from "vitest";
import { remoteOperationObservationSchema } from "@planweave-ai/collaboration-protocol/remote-run";
import { collaborationRemoteCanvasReplicaProjectionSchema } from "../shared/canvasReplicaIpc";
import {
  agentFamilyFromExecutorName,
  diskSelectedRecordId,
  isRemoteLiveRecordId,
  remoteLiveRecordId,
  withRemoteLiveTimelineRuns
} from "../renderer/task-workspace/remoteLiveRun";
import {
  loadWorkspaceTaskWorkspace,
  projectWorkspaceTaskWorkspace
} from "../renderer/task-workspace/workspaceTaskWorkspaceProjection";
import {
  taskWorkspaceNavigationIdentity,
  taskWorkspaceNavigationTargetSchema
} from "../renderer/taskWorkspaceNavigation";
import { taskWorkspaceSource } from "./helpers/taskWorkspaceControllerModelFixture";
import {
  timelineBlockFixture,
  timelineRunFixture,
  timelineWorkspaceFixture
} from "./helpers/taskWorkspaceTimelineFixture";

describe("remote live timeline runs", () => {
  it("injects an active remote-live row with the specified agent", () => {
    const blockRef = "T-001#B-001";
    const base = timelineWorkspaceFixture([
      timelineBlockFixture({
        blockId: "B-001",
        runs: [timelineRunFixture(blockRef, "RUN-DONE", { retryIndex: 1 })]
      })
    ]);
    const workspace = {
      ...base,
      blocks: base.blocks.map((block) =>
        block.ref === blockRef
          ? {
              ...block,
              executor: "grok",
              remoteExecution: {
                identity: { operationId: "operation-abc" },
                phase: "active" as const,
                status: "owned" as const,
                actionRequired: false,
                source: { revision: "rev-1", graphFingerprint: "fp-1" },
                dispatchAttempt: {
                  dispatchId: "dispatch-1",
                  executionAttemptId: "attempt-1"
                }
              }
            }
          : block
      )
    };

    const projected = withRemoteLiveTimelineRuns(workspace);
    const runs = projected.blocks[0]?.runs ?? [];
    expect(runs).toHaveLength(2);
    const live = runs.find((item) => isRemoteLiveRecordId(item.run.record.recordId));
    expect(live).toMatchObject({
      active: true,
      retryIndex: 2,
      run: {
        record: { recordId: remoteLiveRecordId(blockRef, "operation-abc") },
        metadata: { agentId: "grok", executor: "grok", terminalState: null }
      }
    });
    expect(diskSelectedRecordId(live?.run.record.recordId)).toBeNull();
    expect(agentFamilyFromExecutorName("grok-acp")).toBe("grok");
  });

  it("does not inject a live row for terminal remoteExecution", () => {
    const blockRef = "T-001#B-001";
    const base = timelineWorkspaceFixture([
      timelineBlockFixture({
        blockId: "B-001",
        runs: [timelineRunFixture(blockRef, "RUN-DONE")]
      })
    ]);
    const workspace = {
      ...base,
      blocks: base.blocks.map((block) =>
        block.ref === blockRef
          ? {
              ...block,
              remoteExecution: {
                identity: { operationId: "operation-done" },
                phase: "terminal" as const,
                status: "completed" as const,
                actionRequired: false,
                source: { revision: "rev-1", graphFingerprint: "fp-1" },
                dispatchAttempt: null
              }
            }
          : block
      )
    };
    expect(withRemoteLiveTimelineRuns(workspace).blocks[0]?.runs).toHaveLength(1);
  });

  it("projects a Server operation into a Workspace Block execution timeline", async () => {
    const projection = collaborationRemoteCanvasReplicaProjectionSchema.parse({
      authorityId: "profile-workspace\u0000https://workspace.example.test\u0000project-1",
      bindingKind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1",
      revision: 7,
      contentDigest: "a".repeat(64),
      canEdit: true,
      optimisticOperationIds: [],
      rejections: [],
      content: {
        projectTitle: "Workspace project",
        graphVersion: "7",
        packageFingerprint: `pkg-${"b".repeat(64)}`,
        tasks: [
          {
            taskId: "T-001",
            title: "Remote task",
            status: "in_progress",
            executor: "opencode",
            executorLabel: "OpenCode",
            promptMarkdown: "# Remote task",
            promptMissing: false,
            promptPreview: "Remote task",
            sharedResources: [],
            blocks: [
              {
                ref: "T-001#B-001",
                blockId: "B-001",
                type: "implementation",
                title: "Run remotely",
                status: "in_progress",
                executor: "opencode",
                requiredCapabilities: [],
                promptMissing: false,
                exceptionReason: null,
                dispatchable: true,
                remoteExecution: null
              }
            ],
            blockPreview: [],
            hiddenBlockRefs: [],
            overflowBlockCount: 0,
            exceptions: []
          }
        ],
        edges: [],
        sharedResourceGroups: [],
        diagnostics: [],
        layout: {
          version: "desktop-layout/v1",
          projectId: "project-1",
          nodes: [],
          updatedAt: "2026-08-24T00:00:00.000Z"
        },
        blockDependenciesByRef: { "T-001#B-001": [] },
        taskOpenFeedbackCountByTaskId: {},
        blockPromptMarkdownByRef: { "T-001#B-001": "Run remotely" }
      }
    });
    const operation = remoteOperationObservationSchema.parse({
      operationId: "operation-1",
      projectId: "project-1",
      canvasId: "canvas-1",
      blockRef: "T-001#B-001",
      state: "running",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2026-08-24T00:01:00.000Z",
      updatedAt: "2026-08-24T00:02:00.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "running",
        stateVersion: 3
      },
      agentEndpoint: {
        schemaVersion: "agent-endpoint/v1",
        endpointId: "endpoint-1",
        profileId: "profile-opencode",
        agentId: "opencode",
        displayName: "OpenCode · Mac",
        capabilities: [],
        hostDisplayName: "Mac",
        status: "available",
        resolvedAt: "2026-08-24T00:01:00.000Z"
      },
      runtime: {
        ref: "T-001#B-001",
        status: "in_progress",
        ownership: {
          operationId: "operation-1",
          phase: "active",
          dispatchId: "dispatch-1",
          executionAttemptId: "attempt-1"
        }
      }
    });

    const workspace = projectWorkspaceTaskWorkspace({
      blockRef: "T-001#B-001",
      operation,
      projection,
      selectedRecordId: null,
      taskId: "T-001",
      now: new Date("2026-08-24T00:02:00.000Z")
    });

    expect(workspace.project).toEqual({
      authority: "workspace",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });
    const block = workspace.blocks[0];
    expect(block?.remoteExecution).toMatchObject({
      identity: { operationId: "operation-1" },
      controlPlane: "collaboration",
      phase: "active",
      status: "owned"
    });
    expect(block?.runs).toHaveLength(1);
    expect(block?.runs[0]).toMatchObject({
      active: true,
      run: {
        runIdentity: {
          projectId: "project-1",
          canvasId: "canvas-1",
          runId: "remote-live-operation-1"
        },
        metadata: {
          executor: "opencode",
          agentId: "opencode",
          projectRoot: null
        }
      }
    });

    const lookupOperation = vi.fn(async () => operation);
    await loadWorkspaceTaskWorkspace({
      navigation: taskWorkspaceNavigationIdentity(
        taskWorkspaceNavigationTargetSchema.parse({
          authority: "workspace",
          connectionProfileId: "profile-workspace",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1",
          taskId: "T-001",
          blockRef: "T-001#B-001",
          recordId: remoteLiveRecordId("T-001#B-001", "operation-1")
        }),
        taskWorkspaceSource
      ),
      projection,
      lookupOperation
    });
    expect(lookupOperation).toHaveBeenCalledWith({
      locator: {
        kind: "workspace",
        connectionProfileId: "profile-workspace",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1"
      },
      blockRef: "T-001#B-001",
      operationId: "operation-1"
    });

    await expect(
      loadWorkspaceTaskWorkspace({
        navigation: taskWorkspaceNavigationIdentity(
          taskWorkspaceNavigationTargetSchema.parse({
            authority: "workspace",
            connectionProfileId: "profile-workspace",
            workspaceId: "workspace-1",
            projectId: "project-1",
            canvasId: "canvas-1",
            taskId: "T-001",
            blockRef: "T-001#B-001",
            recordId: remoteLiveRecordId("T-001#B-001", "operation-out-of-scope")
          }),
          taskWorkspaceSource
        ),
        projection,
        lookupOperation: vi.fn(async () => null)
      })
    ).rejects.toThrow("The selected Workspace execution record is unavailable for this Block.");
  });
});
