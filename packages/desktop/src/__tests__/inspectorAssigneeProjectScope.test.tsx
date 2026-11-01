/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import {
  inspectorAuthority,
  inspectorEligible,
  inspectorGraph
} from "./helpers/inspectorAssigneeSessionFixture";
import { autoRunState, autoRunEvent } from "./helpers/autoRunControlHarness";
import { mountInspector, expectAuthorities, ports } from "./helpers/inspectorAssigneeWindowHarness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function expectUnbound() {
  await waitFor(() => {
    for (const role of ["responsibility", "reviewer"]) {
      const field = within(screen.getByTestId(`authority-field-${role}`));
      expect(field.getByTestId("assignee-picker")).toHaveAttribute("data-mode", "disconnected");
      expect(field.getByTestId("assignee-current-label")).not.toHaveTextContent(/owner-|reviewer-/);
    }
  });
}

async function expectHistoriesUnbound(f: ReturnType<typeof mountInspector>) {
  const comments = vi.mocked(f.api.listCollaborationComments);
  const activity = vi.mocked(f.api.listCollaborationActivity);
  const commentReads = comments.mock.calls.length;
  const activityReads = activity.mock.calls.length;
  expect(screen.getByTestId("comments-body-input")).toBeDisabled();
  await f.user.click(screen.getByTestId("comments-refresh"));
  await f.user.click(screen.getByTestId("collaboration-tab-activity"));
  await f.user.click(screen.getByTestId("activity-refresh"));
  await f.user.click(screen.getByTestId("collaboration-tab-comments"));
  expect(comments).toHaveBeenCalledTimes(commentReads);
  expect(activity).toHaveBeenCalledTimes(activityReads);
  expect(f.api.createCollaborationComment).not.toHaveBeenCalled();
}

it.each([
  ["task", "project-1"],
  ["block", "project-1"],
  ["task", "project-2"],
  ["block", "project-2"]
] as const)("keeps mounted %s Inspector bound to local %s through global A to B to A", async (kind, localProjectId) => {
  const f = mountInspector(kind, undefined, { ...inspectorGraph, projectId: localProjectId });
  try {
    await screen.findByTestId("authority-field-responsibility");
    const originalField = screen.getByTestId("authority-field-responsibility");
    if (localProjectId === "project-1") await expectAuthorities("owner-s1", "reviewer-s1");
    else {
      await expectUnbound();
      expect(f.readAuthority).not.toHaveBeenCalled();
      expect(f.listAssignments).not.toHaveBeenCalled();
      await expectHistoriesUnbound(f);
    }
    await act(async () => {
      f.switchProject("project-2", "b");
    });
    if (localProjectId === "project-2") {
      await expectAuthorities("owner-b", "reviewer-b");
      for (const role of ["responsibility", "reviewer"]) {
        await f.user.click(
          within(screen.getByTestId(`authority-field-${role}`)).getByTestId(
            "assignee-picker-trigger"
          )
        );
        expect(
          await screen.findByRole("option", {
            name: new RegExp(`^Next ${role === "reviewer" ? "reviewer" : "owner"} b`)
          })
        ).toBeEnabled();
        await f.user.keyboard("{Escape}");
      }
    } else {
      await expectUnbound();
      await expectHistoriesUnbound(f);
      const eligibleReads = f.listEligible.mock.calls.length;
      await f.user.click(within(originalField).getByTestId("assignee-picker-trigger"));
      for (const option of await screen.findAllByRole("option")) expect(option).toBeDisabled();
      expect(f.listEligible).toHaveBeenCalledTimes(eligibleReads);
      await f.user.keyboard("{Escape}");
    }
    const readsAtB = f.readAuthority.mock.calls.length;
    await act(async () => {
      f.switchProject("project-1", "a-return");
    });
    if (localProjectId === "project-1") {
      await expectAuthorities("owner-a-return", "reviewer-a-return");
      for (const role of ["responsibility", "reviewer"]) {
        await f.user.click(
          within(screen.getByTestId(`authority-field-${role}`)).getByTestId(
            "assignee-picker-trigger"
          )
        );
        const name = role === "reviewer" ? "reviewer" : "owner";
        await f.user.click(
          await screen.findByRole("option", { name: new RegExp(`^Next ${name} a-return`) })
        );
      }
      await expectAuthorities("next-owner-a-return", "next-reviewer-a-return");
    } else {
      await expectUnbound();
      await expectHistoriesUnbound(f);
      expect(f.readAuthority).toHaveBeenCalledTimes(readsAtB);
      expect(f.updateResponsibility).not.toHaveBeenCalled();
      expect(f.updateReviewer).not.toHaveBeenCalled();
    }
    expect(screen.getByTestId("authority-field-responsibility")).toBe(originalField);
    expect(f.rejected).toEqual([]);
  } finally {
    f.unmount();
    f.dispose();
  }
});

it.each([
  "task",
  "block"
] as const)("does not bind the %s Inspector before its local graph loads", async (kind) => {
  const graph = deferred<DesktopGraphViewModel>();
  const f = mountInspector(kind, () => {
    ports.desktop.getGraphViewModel.mockReturnValueOnce(graph.promise);
  });
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(f.listAssignments).not.toHaveBeenCalled();
    expect(f.readAuthority).not.toHaveBeenCalled();
    expect(f.listEligible).not.toHaveBeenCalled();
    await act(async () => {
      graph.resolve(inspectorGraph);
      await graph.promise;
    });
    await expectAuthorities("owner-s1", "reviewer-s1");
  } finally {
    graph.resolve(inspectorGraph);
    f.unmount();
    f.dispose();
  }
});

it.each([
  "task",
  "block"
] as const)("keeps the %s Inspector unbound when its local graph fails", async (kind) => {
  const f = mountInspector(kind, () => {
    ports.desktop.getGraphViewModel.mockRejectedValueOnce(new Error("local graph unavailable"));
  });
  try {
    await screen.findByText("local graph unavailable");
    expect(f.listAssignments).not.toHaveBeenCalled();
    expect(f.readAuthority).not.toHaveBeenCalled();
    expect(f.listEligible).not.toHaveBeenCalled();
    expect(f.updateResponsibility).not.toHaveBeenCalled();
    expect(f.updateReviewer).not.toHaveBeenCalled();
  } finally {
    f.unmount();
    f.dispose();
  }
});

it.each([
  "task",
  "block"
] as const)("ignores late authority and eligible after the %s Inspector loses its project binding", async (kind) => {
  type Authority = Awaited<ReturnType<PlanWeaveCollaborationApi["getCollaborationWorkAuthority"]>>;
  type Eligible = Awaited<
    ReturnType<PlanWeaveCollaborationApi["listCollaborationEligibleAssignees"]>
  >;
  const authority = deferred<Authority>();
  const eligible = deferred<Eligible>();
  const f = mountInspector(kind);
  try {
    await expectAuthorities("owner-s1", "reviewer-s1");
    f.listEligible.mockReturnValueOnce(eligible.promise);
    await f.user.click(
      within(screen.getByTestId("authority-field-responsibility")).getByTestId(
        "assignee-picker-trigger"
      )
    );
    await waitFor(() => expect(f.listEligible).toHaveBeenCalled());
    f.readAuthority.mockReturnValueOnce(authority.promise);
    // A new same-project session admits a fresh authority read before switching project.
    await act(async () => {
      f.reconnect();
    });
    await waitFor(() =>
      expect(
        f.readAuthority.mock.results.some((result) => result.value === authority.promise)
      ).toBe(true)
    );
    await act(async () => {
      f.switchProject("project-2", "b");
    });
    await expectUnbound();
    const reads = f.readAuthority.mock.calls.length;
    await act(async () => {
      authority.resolve(inspectorAuthority(f.workItem, "late-a"));
      eligible.resolve(inspectorEligible(f.workItem, "late-a"));
      await Promise.all([authority.promise, eligible.promise]);
    });
    await expectUnbound();
    expect(f.readAuthority).toHaveBeenCalledTimes(reads);
    expect(screen.queryByRole("option", { name: /late-a/ })).not.toBeInTheDocument();
    expect(f.updateResponsibility).not.toHaveBeenCalled();
    expect(f.updateReviewer).not.toHaveBeenCalled();
    await act(async () => {
      f.switchProject("project-1", "restored");
    });
    await expectAuthorities("owner-restored", "reviewer-restored");
  } finally {
    authority.resolve(inspectorAuthority(f.workItem, "late-a"));
    eligible.resolve(inspectorEligible(f.workItem, "late-a"));
    f.unmount();
    f.dispose();
  }
});

it.each([
  "task",
  "block"
] as const)("retires late roster from an old project binding in the mounted %s Inspector", async (kind) => {
  type Members = Awaited<ReturnType<PlanWeaveCollaborationApi["listCollaborationMembers"]>>;
  const roster = deferred<Members>();
  const member = (displayName: string) => ({
    membershipId: "owner-membership",
    projectId: "project-1",
    humanPrincipalId: "owner-s1",
    displayName,
    role: "member" as const,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z"
  });
  const f = mountInspector(kind, (fixture) => {
    vi.mocked(fixture.api.listCollaborationMembers).mockReturnValueOnce(roster.promise);
  });
  try {
    await waitFor(() => expect(f.api.listCollaborationMembers).toHaveBeenCalled());
    await act(async () => {
      f.switchProject("project-2", "b");
    });
    await expectUnbound();
    vi.mocked(f.api.listCollaborationMembers).mockResolvedValue({
      items: [member("Current A")],
      nextCursor: null
    });
    await act(async () => {
      f.switchProject("project-1", "s1");
    });
    await expectAuthorities("Current A", "reviewer-s1");
    await act(async () => {
      roster.resolve({ items: [member("Retired A")], nextCursor: null });
      await roster.promise;
    });
    await expectAuthorities("Current A", "reviewer-s1");
    expect(screen.queryByText("Retired A")).not.toBeInTheDocument();
  } finally {
    roster.resolve({ items: [], nextCursor: null });
    f.unmount();
    f.dispose();
  }
});

it.each([
  { kind: "task", bindingAfterReadFailure: "disconnected" },
  { kind: "block", bindingAfterReadFailure: "ready" }
] as const)("keeps the $kind Inspector $bindingAfterReadFailure on a failed read and ignores an older failure after recovery", async ({
  kind,
  bindingAfterReadFailure
}) => {
  const f = mountInspector(kind);
  try {
    await expectAuthorities("owner-s1", "reviewer-s1");
    const event = autoRunEvent(
      autoRunState({
        projectRoot: "/inspector",
        canvasId: "canvas-1",
        currentRef: "T-1#B-1"
      })
    );
    const emit = () => ports.desktop.onAutoRunChanged.mock.calls.at(-1)![0](event);
    ports.desktop.getGraphViewModel.mockRejectedValueOnce(new Error("graph refresh failed"));
    await act(async () => {
      emit();
    });
    await screen.findByText("graph refresh failed");
    if (bindingAfterReadFailure === "disconnected") await expectUnbound();
    else {
      await expectAuthorities("owner-s1", "reviewer-s1");
      await act(async () => {
        f.switchProject("project-2", "b");
      });
      await expectUnbound();
      await expectHistoriesUnbound(f);
      await act(async () => {
        f.switchProject("project-1", "s1");
      });
      await expectAuthorities("owner-s1", "reviewer-s1");
    }
    const old = deferred<DesktopGraphViewModel>();
    ports.desktop.getGraphViewModel.mockReturnValueOnce(old.promise);
    await act(async () => {
      emit();
    });
    await act(async () => {
      emit();
    });
    await expectAuthorities("owner-s1", "reviewer-s1");
    await act(async () => {
      old.reject(new Error("retired graph failure"));
      await old.promise.catch(() => undefined);
    });
    await expectAuthorities("owner-s1", "reviewer-s1");
    expect(screen.queryByText("graph refresh failed")).not.toBeInTheDocument();
  } finally {
    f.unmount();
    f.dispose();
  }
});
