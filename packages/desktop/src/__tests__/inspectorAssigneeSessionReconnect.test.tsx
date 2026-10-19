/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import { resetCommentDraftStoreForTests } from "../renderer/collaboration/commentDraftStore";
import { TaskInspectorWindow } from "../renderer/TaskInspectorWindow";
import { BlockInspectorWindow } from "../renderer/BlockInspectorWindow";
import {
  createInspectorAssigneeFixture,
  inspectorGraph,
  inspectorTask,
  inspectorBlock,
  inspectorAuthority,
  inspectorEligible
} from "./helpers/inspectorAssigneeSessionFixture";
import {
  cleanupRendererTestEnvironment,
  stubSelectLayoutApis
} from "./helpers/rendererTestEnvironment";
import { responsibilityReadModelSchema } from "@planweave-ai/collaboration-protocol/work/responsibility";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

afterEach(() => {
  cleanupRendererTestEnvironment();
  resetCommentDraftStoreForTests();
  ports.collaboration = null;
  window.history.replaceState(null, "", "/");
});

function mountInspector(
  kind: "task" | "block",
  configure?: (fixture: ReturnType<typeof createInspectorAssigneeFixture>) => void
) {
  stubSelectLayoutApis();
  const fixture = createInspectorAssigneeFixture(kind);
  configure?.(fixture);
  ports.collaboration = fixture.api;
  ports.desktop.getGraphViewModel.mockResolvedValue(inspectorGraph);
  ports.desktop.getTaskDetail.mockResolvedValue(inspectorTask);
  ports.desktop.getBlockDetail.mockResolvedValue(inspectorBlock);
  window.history.replaceState(
    null,
    "",
    `/?window=${kind}-inspector&projectRoot=%2Finspector&canvasId=canvas-1&taskId=T-1&blockRef=T-1%23B-1&language=en`
  );
  const view = render(kind === "task" ? <TaskInspectorWindow /> : <BlockInspectorWindow />);
  return { ...fixture, ...view, user: userEvent.setup() };
}

async function expectAuthorities(owner: string, reviewer: string) {
  await waitFor(() => {
    for (const [role, expected] of [
      ["responsibility", owner],
      ["reviewer", reviewer]
    ]) {
      const field = within(screen.getByTestId(`authority-field-${role}`));
      expect(field.getByTestId("assignee-current-label")).toHaveTextContent(expected);
      expect(field.getByTestId("assignee-picker")).toHaveAttribute("data-mode", "ready");
    }
  });
}

it.each([
  "task",
  "block"
] as const)("restores both authorities in the mounted %s Inspector on direct connected S1 to S2 and assigns using S2", async (kind) => {
  const f = mountInspector(kind);
  try {
    await expectAuthorities("owner-s1", "reviewer-s1");
    const ownerField = screen.getByTestId("authority-field-responsibility");
    const reviewerField = screen.getByTestId("authority-field-reviewer");
    let secondScope!: typeof f.firstScope;
    await act(async () => {
      secondScope = f.reconnect();
    });
    await expectAuthorities("owner-s2", "reviewer-s2");
    expect(screen.getByTestId("authority-field-responsibility")).toBe(ownerField);
    expect(screen.getByTestId("authority-field-reviewer")).toBe(reviewerField);
    expect(
      f.readAuthority.mock.calls.some(
        ([query]) => query.operationScope.sessionId === secondScope.sessionId
      )
    ).toBe(true);

    await f.user.click(within(ownerField).getByTestId("assignee-picker-trigger"));
    await screen.findByRole("option", { name: /^Next owner s2/ });
    await f.user.type(screen.getByTestId("assignee-search"), "Next owner");
    const readsBeforeClone = {
      authority: f.readAuthority.mock.calls.length,
      eligible: f.listEligible.mock.calls.length,
      assignments: f.listAssignments.mock.calls.length
    };
    await act(async () => {
      f.emitClone();
    });
    expect(f.readAuthority).toHaveBeenCalledTimes(readsBeforeClone.authority);
    expect(f.listEligible).toHaveBeenCalledTimes(readsBeforeClone.eligible);
    expect(f.listAssignments).toHaveBeenCalledTimes(readsBeforeClone.assignments);
    expect(screen.getByTestId("assignee-search")).toHaveValue("Next owner");
    await f.user.click(await screen.findByRole("option", { name: /^Next owner s2/ }));
    await expectAuthorities("next-owner-s2", "reviewer-s2");
    expect(f.updateResponsibility).toHaveBeenCalledWith({
      operationScope: secondScope,
      workItem: f.workItem,
      principal: { kind: "human", humanPrincipalId: "next-owner-s2" },
      expectedRevision: 5
    });
    await f.user.click(within(reviewerField).getByTestId("assignee-picker-trigger"));
    await f.user.click(await screen.findByRole("option", { name: /^Next reviewer s2/ }));
    await expectAuthorities("next-owner-s2", "next-reviewer-s2");
    expect(f.updateReviewer).toHaveBeenCalledWith({
      operationScope: secondScope,
      workItem: f.workItem,
      principal: { kind: "human", humanPrincipalId: "next-reviewer-s2" },
      expectedRevision: 7
    });
    expect(f.rejected).toEqual([]);
  } finally {
    f.unmount();
    f.dispose();
  }
});

it.each([
  ["task", true],
  ["task", false],
  ["block", true],
  ["block", false]
] as const)("keeps the %s Inspector's S2 selection and search when an admitted S1 mutation settles (success=%s)", async (kind, success) => {
  const f = mountInspector(kind);
  type Responsibility = Awaited<
    ReturnType<PlanWeaveCollaborationApi["updateCollaborationResponsibility"]>
  >;
  const old = deferred<Responsibility>();
  const current = deferred<Responsibility>();
  try {
    await expectAuthorities("owner-s1", "reviewer-s1");
    const field = within(screen.getByTestId("authority-field-responsibility"));
    f.updateResponsibility.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await f.user.click(field.getByTestId("assignee-picker-trigger"));
    await f.user.click(await screen.findByRole("option", { name: /^Next owner s1/ }));
    await waitFor(() => expect(f.updateResponsibility).toHaveBeenCalledTimes(1));
    expect(field.getByTestId("assignee-picker-trigger")).toBeDisabled();
    let secondScope!: typeof f.firstScope;
    await act(async () => {
      secondScope = f.reconnect();
    });
    await expectAuthorities("owner-s2", "reviewer-s2");
    await f.user.click(await screen.findByRole("option", { name: /^Next owner s2/ }));
    await waitFor(() => expect(f.updateResponsibility).toHaveBeenCalledTimes(2));
    await f.user.type(screen.getByTestId("assignee-search"), "S2 search");
    const authorityReads = f.readAuthority.mock.calls.length;
    const eligibleReads = f.listEligible.mock.calls.length;
    const oldProjection = responsibilityReadModelSchema.parse({
      ...f.authorities.get(f.firstScope.sessionId)!.responsibility,
      principal: { kind: "human", humanPrincipalId: "next-owner-s1" },
      revision: 6
    });
    await act(async () => {
      if (success) old.resolve(oldProjection);
      else old.reject(new Error("S1 request failed"));
      await old.promise.catch(() => undefined);
    });
    expect(screen.getByTestId("assignee-search")).toHaveValue("S2 search");
    expect(field.getByTestId("assignee-picker-trigger")).toBeDisabled();
    expect(field.queryByTestId("assignee-action-error")).not.toBeInTheDocument();
    expect(f.readAuthority).toHaveBeenCalledTimes(authorityReads);
    expect(f.listEligible).toHaveBeenCalledTimes(eligibleReads);
    const authority = f.authorities.get(secondScope.sessionId)!;
    const responsibility = responsibilityReadModelSchema.parse({
      ...authority.responsibility,
      principal: { kind: "human", humanPrincipalId: "next-owner-s2" },
      revision: 6
    });
    f.authorities.set(secondScope.sessionId, {
      ...authority,
      responsibility,
      revisions: { ...authority.revisions, responsibilityRevision: responsibility.revision }
    });
    await act(async () => {
      current.resolve(responsibility);
      await current.promise;
    });
    await expectAuthorities("next-owner-s2", "reviewer-s2");
    expect(screen.queryByTestId("assignee-search")).not.toBeInTheDocument();
    await f.user.click(field.getByTestId("assignee-picker-trigger"));
    expect(await screen.findByTestId("assignee-search")).toHaveValue("");
    expect(
      f.updateResponsibility.mock.calls.map(([input]) => input.operationScope.sessionId)
    ).toEqual([f.firstScope.sessionId, secondScope.sessionId]);
    expect(f.rejected).toEqual([]);
  } finally {
    old.resolve(f.authorities.get(f.firstScope.sessionId)!.responsibility);
    current.resolve(f.authorities.get(f.firstScope.sessionId)!.responsibility);
    f.unmount();
    f.dispose();
  }
});

it.each([
  "task",
  "block"
] as const)("ignores admitted late S1 authority after the mounted %s Inspector has restored S2", async (kind) => {
  type Authority = Awaited<ReturnType<PlanWeaveCollaborationApi["getCollaborationWorkAuthority"]>>;
  const old = deferred<Authority>();
  const f = mountInspector(kind, (fixture) => {
    const read = fixture.readAuthority.getMockImplementation()!;
    fixture.readAuthority.mockImplementation((query) =>
      query.operationScope.sessionId === fixture.firstScope.sessionId ? old.promise : read(query)
    );
  });
  try {
    await waitFor(() => expect(f.readAuthority).toHaveBeenCalled());
    let secondScope!: typeof f.firstScope;
    await act(async () => {
      secondScope = f.reconnect();
    });
    await expectAuthorities("owner-s2", "reviewer-s2");
    const reads = f.readAuthority.mock.calls.length;
    await act(async () => {
      old.resolve(inspectorAuthority(f.workItem, "late-s1"));
      await old.promise;
    });
    await expectAuthorities("owner-s2", "reviewer-s2");
    expect(f.readAuthority).toHaveBeenCalledTimes(reads);
    expect(
      f.readAuthority.mock.calls.some(
        ([query]) => query.operationScope.sessionId === secondScope.sessionId
      )
    ).toBe(true);
    expect(screen.queryByTestId("assignee-action-error")).not.toBeInTheDocument();
    expect(f.rejected).toEqual([]);
    await expect(
      f.api.getCollaborationWorkAuthority({ operationScope: f.firstScope, workItem: f.workItem })
    ).rejects.toMatchObject({ code: "collaboration_operation_scope_stale" });
    expect(f.readAuthority).toHaveBeenCalledTimes(reads);
  } finally {
    old.resolve(inspectorAuthority(f.workItem, "late-s1"));
    f.unmount();
    f.dispose();
  }
});

it.each([
  ["task", true],
  ["task", false],
  ["block", true],
  ["block", false]
] as const)("preserves S2 options and search in the %s Inspector when S1 eligible settles (success=%s)", async (kind, success) => {
  type Eligible = Awaited<
    ReturnType<PlanWeaveCollaborationApi["listCollaborationEligibleAssignees"]>
  >;
  const old = deferred<Eligible>();
  const f = mountInspector(kind);
  try {
    await expectAuthorities("owner-s1", "reviewer-s1");
    f.listEligible.mockReturnValueOnce(old.promise);
    const field = within(screen.getByTestId("authority-field-responsibility"));
    await f.user.click(field.getByTestId("assignee-picker-trigger"));
    await waitFor(() => expect(f.listEligible).toHaveBeenCalledTimes(1));
    await act(async () => {
      f.reconnect();
    });
    await expectAuthorities("owner-s2", "reviewer-s2");
    expect(await screen.findByRole("option", { name: /^Next owner s2/ })).toBeEnabled();
    await f.user.type(screen.getByTestId("assignee-search"), "Next owner");
    const reads = f.listEligible.mock.calls.length;
    await act(async () => {
      if (success) old.resolve(inspectorEligible(f.workItem, "s1"));
      else old.reject(new Error("S1 eligible failed"));
      await old.promise.catch(() => undefined);
    });
    expect(screen.getByTestId("assignee-search")).toHaveValue("Next owner");
    expect(screen.getByRole("option", { name: /^Next owner s2/ })).toBeEnabled();
    expect(screen.queryByRole("option", { name: /^Next owner s1/ })).not.toBeInTheDocument();
    expect(field.queryByTestId("assignee-action-error")).not.toBeInTheDocument();
    expect(f.listEligible).toHaveBeenCalledTimes(reads);
    await f.user.click(screen.getByRole("option", { name: /^Next owner s2/ }));
    await expectAuthorities("next-owner-s2", "reviewer-s2");
    expect(f.rejected).toEqual([]);
  } finally {
    old.resolve(inspectorEligible(f.workItem, "s1"));
    f.unmount();
    f.dispose();
  }
});
