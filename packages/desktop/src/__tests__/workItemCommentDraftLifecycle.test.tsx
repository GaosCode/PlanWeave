/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import {
  getCommentDraft,
  resetCommentDraftStoreForTests
} from "../renderer/collaboration/commentDraftStore";
import { useCollaborationSurface } from "../renderer/hooks/useCollaborationSurface";
import { useCollaborationStatus } from "../renderer/hooks/useCollaborationStatus";
import { createTranslator } from "../renderer/i18n";
import { WorkItemCommentPopover } from "../renderer/team/WorkItemCommentPopover";
import {
  commentProjection,
  createApi,
  connectedStatus,
  taskItem
} from "./helpers/commentsPanelFixture";
import { deferred } from "./helpers/commentsComposerFixture";

const boundary = vi.hoisted(() => ({ api: null as PlanWeaveCollaborationApi | null }));
vi.mock("../renderer/bridge", () => ({
  get collaborationBridge() {
    return boundary.api;
  }
}));

const t = createTranslator("en");
function Shell() {
  useCollaborationSurface({ localProjectId: "project-1", t });
  const { refresh } = useCollaborationStatus();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => void refresh()}>
        Check connection
      </button>
      <WorkItemCommentPopover
        workItem={taskItem}
        commentCount={0}
        open={open}
        onOpenChange={setOpen}
        t={t}
      />
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  resetCommentDraftStoreForTests();
  boundary.api = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("preserves the unsent body through real Radix close/unmount and delayed same-session remount", async () => {
  const f = createApi();
  boundary.api = f.api;
  const user = userEvent.setup();
  render(<Shell />);
  const trigger = screen.getByTestId("work-item-comments-trigger");
  await user.click(trigger);
  const composer = await screen.findByTestId("comments-body-input");
  await waitFor(() => expect(composer).toBeEnabled());
  await user.type(composer, "unsent same-session body");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("work-item-collaboration-panel")).toBeNull());
  const delayed = deferred<ReturnType<typeof connectedStatus>>();
  vi.mocked(f.api.getCollaborationStatus).mockReturnValueOnce(delayed.promise);
  const reads = vi.mocked(f.api.getCollaborationStatus).mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Check connection" }));
  expect(f.api.getCollaborationStatus).toHaveBeenCalledTimes(reads + 1);
  await user.click(trigger);
  expect(await screen.findByTestId("comments-body-input")).toHaveValue("unsent same-session body");
  await act(async () => delayed.resolve(connectedStatus()));
  await waitFor(() => expect(screen.getByTestId("comments-body-input")).toBeEnabled());
  expect(screen.getByTestId("comments-body-input")).toHaveValue("unsent same-session body");
});

async function openAndWrite(body: string) {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("work-item-comments-trigger"));
  const composer = await screen.findByTestId("comments-body-input");
  await waitFor(() => expect(composer).toBeEnabled());
  await user.type(composer, body);
  return user;
}

async function close(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("work-item-collaboration-panel")).toBeNull());
}

it.each([
  "disconnect",
  "auth",
  "profile",
  "project",
  "principal",
  "device",
  "credential",
  "workspace"
] as const)("retires the body during %s → original identity while every comment panel is unmounted", async (transition) => {
  const f = createApi();
  boundary.api = f.api;
  render(<Shell />);
  const user = await openAndWrite("must not revive");
  await close(user);
  const next = connectedStatus();
  const profile = next.profiles[0]!;
  if (transition === "disconnect") next.session.phase = "idle";
  if (transition === "auth") {
    next.session.phase = "error";
    next.session.lastErrorCode = "device_credential_invalid";
    profile.hasDeviceCredential = false;
  }
  if (transition === "profile") {
    profile.profileId = "profile-B";
    next.activeProfileId = "profile-B";
    next.session.activeProfileId = "profile-B";
  }
  if (transition === "project") profile.projectId = "project-B";
  if (transition === "principal") profile.humanPrincipalId = "human-B";
  if (transition === "device") profile.deviceCredentialId = "device-B";
  if (transition === "credential") profile.credentialRevision = "revision-B";
  if (transition === "workspace") next.workspaceConnection.workspaceId = "workspace-B";
  // Both authoritative transitions can occur before React renders another frame.
  act(() => {
    f.emitStatus(next);
    f.emitStatus(connectedStatus());
  });
  expect(getCommentDraft(taskItem).body).toBe("");
  await user.click(screen.getByTestId("work-item-comments-trigger"));
  await waitFor(() => expect(screen.getByTestId("comments-body-input")).toBeEnabled());
  expect(screen.getByTestId("comments-body-input")).toHaveValue("");
});

it.each([
  "initial",
  "refresh"
] as const)("keeps the body through an unknown %s read failure and recovery", async (read) => {
  const f = createApi();
  boundary.api = f.api;
  let view = render(<Shell />);
  const user = await openAndWrite("read failure is not disconnect");
  await close(user);
  const delayed = deferred<ReturnType<typeof connectedStatus>>();
  vi.mocked(f.api.getCollaborationStatus).mockReturnValueOnce(delayed.promise);
  if (read === "initial") {
    view.unmount();
    view = render(<Shell />);
  } else await user.click(screen.getByRole("button", { name: "Check connection" }));
  await user.click(screen.getByTestId("work-item-comments-trigger"));
  expect(await screen.findByTestId("comments-body-input")).toHaveValue(
    "read failure is not disconnect"
  );
  await act(async () => delayed.reject(new Error("status unavailable")));
  expect(screen.getByTestId("comments-body-input")).toHaveValue("read failure is not disconnect");
  await act(async () => f.emitStatus(connectedStatus()));
  await waitFor(() => expect(screen.getByTestId("comments-body-input")).toBeEnabled());
  expect(screen.getByTestId("comments-body-input")).toHaveValue("read failure is not disconnect");
  view.unmount();
});

it("ignores a late initial status after an authoritative event and identity replacement", async () => {
  const f = createApi();
  boundary.api = f.api;
  const delayed = deferred<ReturnType<typeof connectedStatus>>();
  vi.mocked(f.api.getCollaborationStatus).mockReturnValueOnce(delayed.promise);
  render(<Shell />);
  act(() => f.emitStatus(connectedStatus()));
  const user = await openAndWrite("old identity");
  act(() => f.changeStatus("project-1", "profile-B"));
  await waitFor(() => expect(screen.getByTestId("comments-body-input")).toHaveValue(""));
  await waitFor(() => expect(screen.getByTestId("comments-body-input")).toBeEnabled());
  await user.type(screen.getByTestId("comments-body-input"), "new identity");
  await act(async () => delayed.resolve(connectedStatus()));
  expect(screen.getByTestId("comments-body-input")).toHaveValue("new identity");
});

it("isolates API replacement from old API events, reads and return to the original API", async () => {
  const a = createApi();
  const b = createApi();
  boundary.api = a.api;
  const oldConsumer = renderHook(() => useCollaborationStatus({ api: a.api }));
  const view = render(<Shell />);
  const user = await openAndWrite("API A body");
  await close(user);
  const pending = deferred<ReturnType<typeof connectedStatus>>();
  vi.mocked(a.api.getCollaborationStatus).mockReturnValueOnce(pending.promise);
  let refresh!: Promise<void>;
  act(() => {
    refresh = oldConsumer.result.current.refresh();
  });
  boundary.api = b.api;
  view.rerender(<Shell />);
  await openAndWrite("API B body");
  await act(async () => {
    a.emitStatus(connectedStatus());
    pending.resolve(connectedStatus());
    await refresh;
  });
  expect(screen.getByTestId("comments-body-input")).toHaveValue("API B body");
  await close(user);
  boundary.api = a.api;
  view.rerender(<Shell />);
  await user.click(screen.getByTestId("work-item-comments-trigger"));
  await waitFor(() => expect(screen.getByTestId("comments-body-input")).toBeEnabled());
  expect(screen.getByTestId("comments-body-input")).toHaveValue("");
});

it.each([
  { response: "before reopen", edited: false },
  { response: "after reopen", edited: false },
  { response: "before reopen", edited: true },
  { response: "after reopen", edited: true }
])("consumes only the submitted draft on success $response (edited=$edited)", async ({
  response,
  edited
}) => {
  const f = createApi();
  boundary.api = f.api;
  const pending = deferred<ReturnType<typeof commentProjection>>();
  f.createComment.mockReturnValueOnce(pending.promise);
  render(<Shell />);
  const user = await openAndWrite("submitted body");
  await user.click(screen.getByTestId("comments-submit"));
  await waitFor(() => expect(f.createComment).toHaveBeenCalledTimes(1));
  await close(user);
  if (edited || response === "after reopen") {
    await user.click(screen.getByTestId("work-item-comments-trigger"));
    const composer = await screen.findByTestId("comments-body-input");
    await waitFor(() => expect(composer).toBeEnabled());
    expect(composer).toHaveValue("submitted body");
    if (edited) {
      await user.clear(composer);
      await user.type(composer, "new unsent body");
      if (response === "before reopen") await close(user);
    }
  }
  await act(async () => pending.resolve(commentProjection("comment-2", "submitted body")));
  if (response === "before reopen")
    await user.click(screen.getByTestId("work-item-comments-trigger"));
  const composer = await screen.findByTestId("comments-body-input");
  await waitFor(() => expect(composer).toBeEnabled());
  await waitFor(() => expect(composer).toHaveValue(edited ? "new unsent body" : ""));
  await user.click(screen.getByTestId("comments-submit"));
  expect(f.createComment).toHaveBeenCalledTimes(edited ? 2 : 1);
});

it.each([
  "before reopen",
  "after reopen"
])("treats preview-only changes as the same pending content and consumes success %s", async (response) => {
  const f = createApi();
  boundary.api = f.api;
  const pending = deferred<ReturnType<typeof commentProjection>>();
  f.createComment.mockReturnValueOnce(pending.promise);
  render(<Shell />);
  const user = await openAndWrite("same submitted content");
  await user.click(screen.getByTestId("comments-submit"));
  await waitFor(() => expect(f.createComment).toHaveBeenCalledTimes(1));
  await close(user);
  await user.click(screen.getByTestId("work-item-comments-trigger"));
  await waitFor(() => expect(screen.getByTestId("comments-body-input")).toBeEnabled());
  await user.click(screen.getByTestId("comments-preview-toggle"));
  expect(screen.getByTestId("comments-preview")).toHaveTextContent("same submitted content");
  await user.click(screen.getByTestId("comments-submit"));
  expect(f.createComment).toHaveBeenCalledTimes(1);
  if (response === "before reopen") await close(user);
  await act(async () => pending.resolve(commentProjection("comment-2", "same submitted content")));
  if (response === "before reopen")
    await user.click(screen.getByTestId("work-item-comments-trigger"));
  await waitFor(() => expect(screen.getByTestId("comments-body-input")).toHaveValue(""));
});

it.each([
  false,
  true
])("blocks duplicate submission across Escape and preserves failure (edited=%s)", async (edited) => {
  const f = createApi();
  boundary.api = f.api;
  const pending = deferred<ReturnType<typeof commentProjection>>();
  f.createComment.mockReturnValueOnce(pending.promise);
  render(<Shell />);
  const user = await openAndWrite("retry after failure");
  await user.click(screen.getByTestId("comments-submit"));
  await waitFor(() => expect(f.createComment).toHaveBeenCalledTimes(1));
  await close(user);
  await user.click(screen.getByTestId("work-item-comments-trigger"));
  const composer = await screen.findByTestId("comments-body-input");
  await waitFor(() => expect(composer).toBeEnabled());
  await user.click(screen.getByTestId("comments-submit"));
  expect(f.createComment).toHaveBeenCalledTimes(1);
  if (edited) {
    await user.clear(composer);
    await user.type(composer, "new body after pending");
  }
  await act(async () => pending.reject(new Error("old submit unavailable")));
  expect(composer).toHaveValue(edited ? "new body after pending" : "retry after failure");
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByTestId("comments-submit"));
  await waitFor(() => expect(f.createComment).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(composer).toHaveValue(""));
});

it.each([
  "disconnect",
  "profile",
  "project",
  "credential",
  "session",
  "server",
  "API"
] as const)("does not consume a new draft after pending success crosses %s and ABA", async (transition) => {
  const f = createApi();
  boundary.api = f.api;
  const pending = deferred<ReturnType<typeof commentProjection>>();
  f.createComment.mockReturnValueOnce(pending.promise);
  const view = render(<Shell />);
  const user = await openAndWrite("old submitted body");
  await user.click(screen.getByTestId("comments-submit"));
  await waitFor(() => expect(f.createComment).toHaveBeenCalledTimes(1));
  await close(user);
  if (transition === "API") {
    boundary.api = createApi().api;
    view.rerender(<Shell />);
    await openAndWrite("other API body");
    await close(user);
    boundary.api = f.api;
    view.rerender(<Shell />);
  } else {
    const next = connectedStatus();
    const profile = next.profiles[0]!;
    if (transition === "disconnect") next.session.phase = "idle";
    if (transition === "profile") {
      profile.profileId = "profile-B";
      next.activeProfileId = "profile-B";
      next.session.activeProfileId = "profile-B";
    }
    if (transition === "project") profile.projectId = "project-B";
    if (transition === "credential") profile.credentialRevision = "revision-B";
    if (transition === "server") profile.serverBaseUrl = "https://other.example.test";
    if (transition === "session") {
      if (!next.session.operationScope) throw new Error("connected_scope_missing");
      next.session.operationScope = { ...next.session.operationScope, sessionId: "new-session" };
    }
    act(() => {
      f.emitStatus(next);
      f.emitStatus(connectedStatus());
    });
  }
  await openAndWrite("new scope body");
  await act(async () => pending.resolve(commentProjection("comment-2", "old submitted body")));
  expect(screen.getByTestId("comments-body-input")).toHaveValue("new scope body");
  expect(screen.getByTestId("comments-body-input")).toBeEnabled();
});

it("retires the unmounted draft when only the final same-profile status exposes a new verified session", async () => {
  const f = createApi();
  boundary.api = f.api;
  render(<Shell />);
  const user = await openAndWrite("hidden reconnect body");
  await close(user);
  const next = connectedStatus();
  if (!next.session.operationScope) throw new Error("connected_scope_missing");
  next.session.operationScope = {
    ...next.session.operationScope,
    sessionId: "00000000-0000-4000-8000-000000000002"
  };
  act(() => f.emitStatus(next));
  expect(getCommentDraft(taskItem).body).toBe("");
  await user.click(screen.getByTestId("work-item-comments-trigger"));
  await waitFor(() => expect(screen.getByTestId("comments-body-input")).toBeEnabled());
  expect(screen.getByTestId("comments-body-input")).toHaveValue("");
});
