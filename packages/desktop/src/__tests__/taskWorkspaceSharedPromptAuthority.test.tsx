/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedCanvasCommandsResult } from "../renderer/hooks/useSharedCanvasCommands";
import {
  collaborationCanvasReplicaProjectionSchema,
  type CollaborationCanvasReplicaProjection
} from "../shared/canvasReplicaIpc";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { controllerApi, useControllerHarness } from "./helpers/taskWorkspaceControllerHarness";
import { navigation } from "./helpers/taskWorkspaceControllerModelFixture";

afterEach(cleanupRendererTestEnvironment);

function sharedPromptProjection(): CollaborationCanvasReplicaProjection {
  return collaborationCanvasReplicaProjectionSchema.parse({
    authorityId: "authority-1",
    localProjectId: "project-1",
    localCanvasId: "canvas-main",
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "canvas-main",
    revision: 2,
    contentDigest: "a".repeat(64),
    canEdit: true,
    optimisticOperationIds: [],
    rejections: [],
    content: {
      projectTitle: "Demo",
      graphVersion: "pgv-shared-2",
      packageFingerprint: `pkg-${"b".repeat(64)}`,
      tasks: [
        {
          taskId: "T-001",
          title: "Task workspace",
          status: "in_progress",
          executor: "codex",
          executorLabel: "codex",
          promptMarkdown: "# Shared Task workspace",
          promptHash: "shared-task-prompt-hash",
          promptMissing: false,
          promptPreview: "Shared Task workspace",
          sharedResources: [],
          blocks: [
            {
              ref: "T-001#B-001",
              blockId: "B-001",
              type: "implementation",
              title: "Implement",
              status: "in_progress",
              executor: "codex",
              requiredCapabilities: [],
              promptMissing: false,
              exceptionReason: null,
              dispatchable: false,
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
        updatedAt: "2026-08-03T00:00:00.000Z"
      },
      blockDependenciesByRef: {},
      taskOpenFeedbackCountByTaskId: {},
      blockPromptMarkdownByRef: {
        "T-001#B-001": "# Shared implementation"
      }
    }
  });
}

function sharedCanvasWithProjection(
  projection = sharedPromptProjection()
): SharedCanvasCommandsResult {
  return {
    enabled: true,
    authorityMode: "shared",
    snapshot: {
      session: {
        canvasId: projection.localCanvasId,
        revision: projection.revision,
        contentDigest: projection.contentDigest,
        lastOperationId: null,
        lastJournalEntryId: null,
        pendingOperationId: null,
        lastConflict: null,
        lastRejectCode: null
      },
      lastError: null,
      lastStaleConflict: null,
      busy: false
    },
    projection,
    submit: vi.fn().mockResolvedValue({ ok: true, error: null, staleConflict: null }),
    reconnect: vi.fn().mockResolvedValue(true)
  };
}

describe("Task Workspace shared prompt authority", () => {
  it("uses shared prompts after reopening instead of stale local package prompts", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const sharedCanvas = sharedCanvasWithProjection();
    const { result } = renderHook(() => useControllerHarness(api, navigation(), sharedCanvas));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.workspace?.task.promptMarkdown).toBe("# Shared Task workspace");
    expect(result.current.workspace?.blocks[0]?.promptMarkdown).toBe("# Shared implementation");

    await act(async () => {
      await result.current.saveTaskPrompt({
        baseMarkdown: "# Shared Task workspace",
        markdown: "# Shared Task workspace updated"
      });
      await result.current.saveBlockPrompt("T-001#B-001", {
        baseMarkdown: "# Shared implementation",
        markdown: "# Shared implementation updated"
      });
    });

    expect(api.getTaskDetail).not.toHaveBeenCalled();
    expect(api.getBlockDetail).not.toHaveBeenCalled();
    expect(sharedCanvas.submit).toHaveBeenNthCalledWith(1, {
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# Shared Task workspace updated"
      }
    });
    expect(sharedCanvas.submit).toHaveBeenNthCalledWith(2, {
      intent: {
        kind: "update_block_prompt",
        blockRef: "T-001#B-001",
        promptMarkdown: "# Shared implementation updated"
      }
    });
  });
});
