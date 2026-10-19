/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopTaskDetail
} from "@planweave-ai/runtime";
import { collaborationConnectionProfileSchema } from "@planweave-ai/collaboration-protocol/connection";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { CollaborationClient } from "../main/collaboration/CollaborationClient";
import { CollaborationOperationSession } from "../main/collaboration/CollaborationOperationSession";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import { resetCommentDraftStoreForTests } from "../renderer/collaboration/commentDraftStore";
import { TaskInspectorWindow } from "../renderer/TaskInspectorWindow";
import { BlockInspectorWindow } from "../renderer/BlockInspectorWindow";
import { createApi, connectedStatus, commentProjection } from "./helpers/commentsPanelFixture";
import { deferred } from "./helpers/commentsComposerFixture";

const ports = vi.hoisted(() => ({
  collaboration: null as PlanWeaveCollaborationApi | null,
  desktop: {
    getGraphViewModel: vi.fn(),
    getTaskDetail: vi.fn(),
    getBlockDetail: vi.fn(),
    listBlockRunRecords: vi.fn(async () => []),
    getReviewAttempts: vi.fn(async () => []),
    getFeedbackRecords: vi.fn(async () => []),
    onAutoRunChanged: vi.fn(() => () => undefined),
    detectTerminalApps: vi.fn(async () => []),
    getTerminalPreferences: vi.fn(async () => ({ defaultTerminalAppId: null })),
    detectRuntimeTools: vi.fn(async () => ({ tmux: { available: false } }))
  }
}));
vi.mock("../renderer/bridge", () => ({
  get collaborationBridge() {
    return ports.collaboration;
  },
  bridge: ports.desktop,
  operatorControlBridge: null,
  workspaceExecutionBridge: null
}));
vi.mock("../renderer/hooks/useDesktopSettingsBridge", () => ({
  useDesktopSettingsBridge: () => ({
    settings: defaultDesktopSettings,
    updateSettingsAndWait: vi.fn()
  })
}));
vi.mock("../renderer/hooks/useDetectedAgents", () => ({
  useDetectedAgents: () => ({ agentDetections: [] })
}));
vi.mock("../renderer/hooks/useWorkspaceAgentEndpointCatalog", () => ({
  useWorkspaceAgentEndpointCatalog: () => ({
    endpoints: [],
    refresh: vi.fn(),
    refreshing: false,
    savePreference: vi.fn()
  })
}));
vi.mock("../renderer/team/AssigneeInspectorField", () => ({ AssigneeInspectorField: () => null }));
vi.mock("../renderer/team/RemoteRunPanel", () => ({ RemoteRunPanel: () => null }));

const graph: DesktopGraphViewModel = {
  projectId: "project-1",
  projectTitle: "Inspector",
  graphVersion: "graph-1",
  packageFingerprint: "package-1",
  executorOptions: [],
  tasks: [],
  edges: [],
  sharedResourceGroups: [],
  diagnostics: [],
  dirtyPromptRefs: []
};
const task: DesktopTaskDetail = {
  taskId: "T-1",
  graphVersion: "graph-1",
  title: "Task",
  status: "ready",
  executor: null,
  promptMarkdown: "Task prompt",
  promptHash: "hash",
  promptMissing: false,
  acceptance: [],
  blockOrder: []
};
const block: DesktopBlockDetail = {
  ref: "T-1#B-1",
  taskId: "T-1",
  blockId: "B-1",
  type: "implementation",
  title: "Block",
  status: "ready",
  executor: null,
  effectiveExecutor: "manual",
  promptMarkdown: "Block prompt",
  promptMissing: false,
  promptSurfaceMarkdown: "Block prompt",
  promptSources: [],
  dependencies: [],
  latestRunId: null,
  latestReviewAttemptId: null,
  activeFeedbackId: null,
  exceptionReason: null,
  reviewGate: null,
  remoteExecution: null
};

afterEach(() => {
  cleanup();
  resetCommentDraftStoreForTests();
  ports.collaboration = null;
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

it.each([
  "task",
  "block"
] as const)("rebinds the mounted %s Inspector before comment reads and mutations after reconnect", async (kind) => {
  const fixture = createApi();
  fixture.api.upsertCollaborationProfile = vi.fn();
  ports.collaboration = fixture.api;
  ports.desktop.getGraphViewModel.mockResolvedValue(graph);
  ports.desktop.getTaskDetail.mockResolvedValue(task);
  ports.desktop.getBlockDetail.mockResolvedValue(block);
  const workItem: WorkItemRef =
    kind === "task"
      ? { kind: "task", canvasId: "canvas-1", taskId: task.taskId }
      : { kind: "block", canvasId: "canvas-1", blockRef: block.ref };
  const client = new CollaborationClient({
    profile: collaborationConnectionProfileSchema.parse({
      profileId: "profile-1",
      displayName: "Inspector",
      projectId: "project-1",
      serverBaseUrl: "https://example.test",
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://example.test",
        allowedClientOrigins: ["https://example.test"],
        tlsTrust: "system_ca"
      }
    }),
    credential: { getDeviceToken: () => null }
  });
  const session = new CollaborationOperationSession();
  session.verify(client, "profile-1");
  let status = connectedStatus();
  status.session.operationScope = session.scope("connected");
  fixture.emitStatus(status);
  const firstScope = status.session.operationScope!;
  const records = new Map([
    ["comment-1", { ...commentProjection("comment-1", "initial comment"), workItem }]
  ]);
  const received: Array<{ operation: string; sessionId: string }> = [];
  const rejected: string[] = [];
  async function run<T>(
    operation: string,
    scope: NonNullable<typeof status.session.operationScope>,
    action: () => Promise<T>
  ) {
    received.push({ operation, sessionId: scope.sessionId });
    try {
      return await session.run(scope, status.session.phase, action);
    } catch (error) {
      rejected.push(scope.sessionId);
      throw error;
    }
  }
  fixture.listComments.mockImplementation((query) =>
    run("read", query.operationScope, async () => ({
      items: [...records.values()],
      nextCursor: null
    }))
  );
  let nextId = 2;
  const late = deferred<ReturnType<typeof commentProjection>>();
  fixture.createComment.mockImplementation((command) =>
    run("create", command.operationScope, async () => {
      if (command.body === "pending old session") return late.promise;
      const item = { ...commentProjection(`comment-${nextId++}`, command.body), workItem };
      records.set(item.commentId, item);
      return item;
    })
  );
  fixture.editComment.mockImplementation((command) =>
    run("edit", command.operationScope, async () => {
      const item = {
        ...commentProjection(command.commentId, command.body, command.expectedRevision + 1),
        workItem
      };
      records.set(item.commentId, item);
      return item;
    })
  );
  fixture.tombstoneComment.mockImplementation((command) =>
    run("delete", command.operationScope, async () => {
      const item = {
        ...commentProjection(command.commentId, "", command.expectedRevision + 1),
        workItem,
        tombstoned: true
      };
      records.set(item.commentId, item);
      return item;
    })
  );
  const user = userEvent.setup();
  window.history.replaceState(
    null,
    "",
    `/?window=${kind}-inspector&projectRoot=%2Finspector&canvasId=canvas-1&taskId=T-1&blockRef=T-1%23B-1&language=en`
  );
  const view = render(kind === "task" ? <TaskInspectorWindow /> : <BlockInspectorWindow />);
  try {
    expect(await screen.findByText("initial comment")).toBeVisible();
    await user.type(screen.getByTestId("comments-body-input"), "before reconnect");
    await user.click(screen.getByTestId("comments-submit"));
    expect(await screen.findByText("before reconnect")).toBeVisible();
    await user.type(screen.getByTestId("comments-body-input"), "pending old session");
    await user.click(screen.getByTestId("comments-submit"));
    await waitFor(() => expect(screen.getByTestId("comments-body-input")).toBeDisabled());
    await act(async () => {
      session.retire();
      status = { ...status, session: { ...status.session, phase: "idle", operationScope: null } };
      fixture.emitStatus(status);
    });
    expect(screen.getByTestId("comments-body-input")).toBeDisabled();
    await act(async () => {
      session.verify(client, "profile-1");
      status = {
        ...status,
        session: {
          ...status.session,
          phase: "connected",
          operationScope: session.scope("connected")
        }
      };
      fixture.emitStatus(status);
    });
    const currentScope = status.session.operationScope!;
    expect(currentScope.sessionId).not.toBe(firstScope.sessionId);
    await waitFor(() => expect(screen.getByTestId("comments-body-input")).toBeEnabled());
    await waitFor(() => expect(screen.queryByTestId("comments-error")).not.toBeInTheDocument());
    expect(rejected).toEqual([]);
    expect(
      received.some(
        (call) => call.operation === "read" && call.sessionId === currentScope.sessionId
      )
    ).toBe(true);
    await act(async () => {
      late.resolve({ ...commentProjection("comment-9", "late old response"), workItem });
      await late.promise;
    });
    expect(screen.queryByText("late old response")).not.toBeInTheDocument();
    await expect(
      fixture.api.createCollaborationComment({
        operationScope: firstScope,
        workItem,
        body: "rejected old operation"
      })
    ).rejects.toMatchObject({ code: "collaboration_operation_scope_stale" });
    const currentCalls = received.length;
    await user.type(screen.getByTestId("comments-body-input"), "after reconnect");
    await user.click(screen.getByTestId("comments-submit"));
    const created = (await screen.findByText("after reconnect")).closest("article")!;
    await user.click(within(created).getByTestId("comments-edit"));
    const edit = screen.getByLabelText("Edit comment body");
    await user.clear(edit);
    await user.type(edit, "edited after reconnect");
    await user.click(screen.getByTestId("comments-edit-save"));
    const edited = (await screen.findByText("edited after reconnect")).closest("article")!;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(within(edited).getByTestId("comments-tombstone"));
    await waitFor(() =>
      expect(screen.queryByText("edited after reconnect")).not.toBeInTheDocument()
    );
    for (const operation of ["create", "edit", "delete"])
      expect(received.slice(currentCalls)).toContainEqual({
        operation,
        sessionId: currentScope.sessionId
      });
    expect(
      received.slice(currentCalls).every((call) => call.sessionId === currentScope.sessionId)
    ).toBe(true);
    expect(rejected).toEqual([firstScope.sessionId]);
    expect(screen.queryByTestId("comments-error")).not.toBeInTheDocument();
    const assignmentsBefore = vi.mocked(fixture.api.listCollaborationAssignments).mock.calls.length;
    await act(async () => {
      fixture.emitStatus(structuredClone(status));
    });
    expect(vi.mocked(fixture.api.listCollaborationAssignments)).toHaveBeenCalledTimes(
      assignmentsBefore
    );
  } finally {
    late.resolve({ ...commentProjection("comment-9", "late old response"), workItem });
    view.unmount();
    session.retire();
    client.dispose();
  }
});
