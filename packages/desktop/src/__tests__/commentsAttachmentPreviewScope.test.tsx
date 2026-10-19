/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationCommentAttachmentBody } from "../shared/collaboration";
import { resetCommentDraftStoreForTests } from "../renderer/collaboration/commentDraftStore";
import { useCommentsPanelController } from "../renderer/hooks/useCommentsPanelController";
import { createTranslator } from "../renderer/i18n";
import { CommentAttachmentView } from "../renderer/team/CommentAttachmentView";
import { deferred } from "./helpers/commentsComposerFixture";
import { connectedStatus, createApi, taskItem } from "./helpers/commentsPanelFixture";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");
const digest = "a".repeat(64);
const displayName = "scope-image.png";
const buttonName = `View attachment ${displayName}`;
const attachment = {
  id: digest,
  displayName,
  mediaType: "image/png",
  sizeBytes: 4,
  digestShort: "aaaaaaaa…"
};

function body(bodyBase64 = "QQ=="): CollaborationCommentAttachmentBody {
  return { digestSha256: digest, mediaType: "image/png", sizeBytes: 4, bodyBase64 };
}

afterEach(() => {
  cleanupRendererTestEnvironment();
  resetCommentDraftStoreForTests();
});

async function preview() {
  const fixture = createApi();
  fixture.readCommentAttachment.mockResolvedValue(body());
  let current: ReturnType<typeof useCommentsPanelController> | null = null;
  function Harness({ workItem }: { workItem: WorkItemRef }) {
    const panel = useCommentsPanelController({ api: fixture.api, workItem, open: true, t });
    current = panel;
    return (
      <CommentAttachmentView
        commentId="comment-1"
        attachments={[attachment]}
        onReadAttachment={panel.readAttachment}
        t={t}
      />
    );
  }
  const view = render(<Harness workItem={taskItem} />);
  await waitFor(() => expect(current?.canCompose).toBe(true));
  await waitFor(() => expect(current?.loading).toBe(false));
  const emit = (status: ReturnType<typeof connectedStatus>) => {
    act(() => fixture.emitStatus(structuredClone(status)));
  };
  return {
    ...fixture,
    ...view,
    emit,
    user: userEvent.setup(),
    read: () => {
      if (!current) throw new Error("comments panel not mounted");
      return current.readAttachment;
    },
    changeWorkItem: (workItem: WorkItemRef) => view.rerender(<Harness workItem={workItem} />),
    broadcast: () => {
      const next = connectedStatus();
      next.session.detail = "observer:catching_up";
      emit(next);
    }
  };
}

type Preview = Awaited<ReturnType<typeof preview>>;
type IdentityChange = "session" | "profile" | "project" | "server" | "work item";

function changeIdentity(fixture: Preview, change: IdentityChange) {
  if (change === "work item") {
    fixture.changeWorkItem({ kind: "task", canvasId: taskItem.canvasId, taskId: "T-2" });
    return connectedStatus().session.operationScope;
  }
  const next = connectedStatus();
  const scope = next.session.operationScope;
  const profile = next.profiles[0];
  if (!scope || !profile) throw new Error("connected identity missing");
  if (change === "session") scope.sessionId = "00000000-0000-4000-8000-000000000002";
  if (change === "profile") {
    scope.profileId = "profile-2";
    profile.profileId = scope.profileId;
    next.activeProfileId = scope.profileId;
    next.session.activeProfileId = scope.profileId;
  }
  if (change === "project") {
    scope.projectId = "project-2";
    profile.projectId = scope.projectId;
  }
  if (change === "server") {
    scope.serverBaseUrl = "https://other.example.test/";
    profile.serverBaseUrl = scope.serverBaseUrl;
  }
  fixture.emit(next);
  return scope;
}

async function openLightbox(fixture: Preview) {
  await fixture.user.click(screen.getByRole("button", { name: buttonName }));
  expect(await screen.findByTestId("comments-attachment-preview")).toBeVisible();
  await fixture.user.click(screen.getByRole("button", { name: `Expand image ${displayName}` }));
  expect(screen.getByRole("dialog", { name: displayName })).toBeVisible();
}

describe("attachment reads through the comments controller", () => {
  it("keeps a loaded preview and lightbox across cloned same-session broadcasts", async () => {
    const fixture = await preview();
    await openLightbox(fixture);
    fixture.broadcast();
    expect(screen.getByTestId("comments-attachment-preview")).toBeVisible();
    expect(screen.getByRole("dialog", { name: displayName })).toBeVisible();
    expect(fixture.readCommentAttachment).toHaveBeenCalledTimes(1);
    expect(fixture.readCommentAttachment).toHaveBeenCalledWith({
      operationScope: connectedStatus().session.operationScope,
      commentId: "comment-1",
      digestSha256: digest
    });
  });

  it.each([
    true,
    false
  ])("settles an in-flight read after an equivalent broadcast (success=%s)", async (success) => {
    const fixture = await preview();
    const pending = deferred<CollaborationCommentAttachmentBody>();
    fixture.readCommentAttachment.mockReturnValueOnce(pending.promise);
    await fixture.user.click(screen.getByRole("button", { name: buttonName }));
    fixture.broadcast();
    expect(screen.getByRole("button", { name: buttonName })).toBeDisabled();
    expect(screen.getByText(t("commentsAttachmentLoading"))).toBeVisible();
    await act(async () => {
      if (success) pending.resolve(body());
      else pending.reject(new Error("attachment unavailable"));
    });
    if (success) {
      expect(screen.getByTestId("comments-attachment-preview")).toBeVisible();
      expect(screen.queryByRole("alert")).toBeNull();
    } else {
      expect(screen.getByRole("alert")).toHaveTextContent(t("commentsAttachmentReadFailed"));
      expect(screen.queryByTestId("comments-attachment-preview")).toBeNull();
    }
    expect(screen.getByRole("button", { name: buttonName })).toBeEnabled();
    expect(screen.queryByText(t("commentsAttachmentLoading"))).toBeNull();
    expect(fixture.readCommentAttachment).toHaveBeenCalledTimes(1);
  });

  describe.each([
    "session",
    "profile",
    "project",
    "server",
    "work item"
  ] as const)("%s identity", (change) => {
    it("clears the loaded preview and expanded image", async () => {
      const fixture = await preview();
      await openLightbox(fixture);
      const retiredRead = fixture.read();
      changeIdentity(fixture, change);
      expect(screen.queryByTestId("comments-attachment-preview")).toBeNull();
      expect(screen.queryByRole("dialog", { name: displayName })).toBeNull();
      await expect(retiredRead("comment-1", digest)).rejects.toThrow(
        "collaboration_session_inactive"
      );
      expect(fixture.readCommentAttachment).toHaveBeenCalledTimes(1);
    });

    it.each([
      true,
      false
    ])("ignores retired completion and finally while the new read is pending (success=%s)", async (success) => {
      const fixture = await preview();
      const old = deferred<CollaborationCommentAttachmentBody>();
      const next = deferred<CollaborationCommentAttachmentBody>();
      fixture.readCommentAttachment
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise);
      await fixture.user.click(screen.getByRole("button", { name: buttonName }));
      const nextScope = changeIdentity(fixture, change);
      await fixture.user.click(screen.getByRole("button", { name: buttonName }));
      expect(fixture.readCommentAttachment).toHaveBeenNthCalledWith(1, {
        operationScope: connectedStatus().session.operationScope,
        commentId: "comment-1",
        digestSha256: digest
      });
      expect(fixture.readCommentAttachment).toHaveBeenNthCalledWith(2, {
        operationScope: nextScope,
        commentId: "comment-1",
        digestSha256: digest
      });
      await act(async () => {
        if (success) old.resolve(body("QQ=="));
        else old.reject(new Error("retired read failed"));
      });
      expect(screen.queryByTestId("comments-attachment-preview")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: buttonName })).toBeDisabled();
      await act(async () => next.resolve(body("Qg==")));
      expect(screen.getByRole("img", { name: displayName })).toHaveAttribute(
        "src",
        "data:image/png;base64,Qg=="
      );
      expect(screen.getByRole("button", { name: buttonName })).toBeEnabled();
      expect(fixture.readCommentAttachment).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    "disconnect",
    "unmount"
  ] as const)("retires pending reads and rejects new calls after %s", async (change) => {
    const fixture = await preview();
    const pending = deferred<CollaborationCommentAttachmentBody>();
    fixture.readCommentAttachment.mockReturnValueOnce(pending.promise);
    await fixture.user.click(screen.getByRole("button", { name: buttonName }));
    const retiredRead = fixture.read();
    if (change === "unmount") fixture.unmount();
    else {
      const next = connectedStatus();
      next.session.phase = "idle";
      next.session.operationScope = null;
      fixture.emit(next);
    }
    await expect(retiredRead("comment-1", digest)).rejects.toThrow(
      "collaboration_session_inactive"
    );
    await act(async () => pending.resolve(body()));
    expect(screen.queryByTestId("comments-attachment-preview")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fixture.readCommentAttachment).toHaveBeenCalledTimes(1);
  });
});
