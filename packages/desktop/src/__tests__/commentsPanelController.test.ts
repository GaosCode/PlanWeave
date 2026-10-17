/* @vitest-environment jsdom */

import { createElement } from "react";
import {
  deferred,
  scopedPanel,
  enableUploads,
  imageFile,
  stageImage
} from "./helpers/commentsComposerFixture";
import "@testing-library/jest-dom/vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import {
  getCommentDraft,
  resetCommentDraftStoreForTests
} from "../renderer/collaboration/commentDraftStore";
import { useCommentsPanelController } from "../renderer/hooks/useCommentsPanelController";
import { useActivityPanelController } from "../renderer/hooks/useActivityPanelController";
import { createTranslator } from "../renderer/i18n";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import { workItemKey } from "../shared/collaborationReadModels";
import { WorkItemCollaborationPanel } from "../renderer/team/WorkItemCollaborationPanel";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  taskItem,
  commentProjection,
  createApi,
  connectedStatus
} from "./helpers/commentsPanelFixture";

afterEach(() => {
  cleanupRendererTestEnvironment();
  resetCollaborationReadModelHubForTests();
  resetCommentDraftStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useCommentsPanelController", () => {
  it.each([
    "offline",
    "timeout",
    "refresh"
  ] as const)("preserves the editing baseline through a real loading-to-%s failure and recovery", async (failure) => {
    const user = userEvent.setup();
    const t = createTranslator("en");
    const fixture = createApi();
    const shell = acquireCollaborationReadModelController(fixture.api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });
    const members =
      deferred<Awaited<ReturnType<PlanWeaveCollaborationApi["listCollaborationMembers"]>>>();
    const currentMembers = await fixture.api.listCollaborationMembers();
    let refresh = Promise.resolve();
    const view = render(
      createElement(WorkItemCollaborationPanel, { workItem: taskItem, api: fixture.api, t })
    );
    try {
      await user.click(await screen.findByTestId("comments-edit"));
      await user.clear(screen.getByLabelText(t("commentsEditAria")));
      await user.type(screen.getByLabelText(t("commentsEditAria")), "unsaved local draft");
      vi.mocked(fixture.api.listCollaborationMembers).mockReturnValueOnce(members.promise);
      act(() => {
        refresh = shell.controller.refreshAuthoritative();
      });
      await waitFor(() => expect(shell.controller.getSnapshot().syncPhase).toBe("loading"));
      expect(screen.getByTestId("comments-edit-save")).toBeEnabled();
      if (failure === "refresh") {
        await act(async () => {
          members.reject({
            kind: "offline",
            code: "refresh_unavailable",
            message: "Refresh unavailable",
            retryable: true
          });
          await refresh;
        });
        expect(shell.controller.getSnapshot().syncPhase).toBe("error");
      } else {
        fixture.editComment.mockRejectedValueOnce({
          kind: failure,
          code: "edit_unavailable",
          message: "Edit unavailable",
          retryable: true
        });
        await user.click(screen.getByTestId("comments-edit-save"));
        await waitFor(() => expect(shell.controller.getSnapshot().syncPhase).toBe("disconnected"));
        expect(await screen.findByRole("alert")).toBeVisible();
      }
      expect(screen.getByLabelText(t("commentsEditAria"))).toHaveValue("unsaved local draft");
      expect(screen.getByTestId("comments-edit-save")).toBeDisabled();
      if (failure !== "refresh") {
        await act(async () => {
          members.resolve(currentMembers);
          await refresh;
        });
      }
      fixture.listComments.mockResolvedValue({
        items: [commentProjection("comment-1", "second device body", 2)],
        nextCursor: null
      });
      await act(async () => {
        await shell.controller.refreshAuthoritative();
        fixture.emitObserver({
          type: "human.observer.event",
          profileId: "profile-1",
          projectId: "project-1",
          event: {
            type: "human.observer.event",
            protocolVersion: 1,
            cursor: 1,
            previousCursor: 0,
            kind: "comment",
            workItem: taskItem,
            occurredAt: "2030-01-01T00:00:02.000Z"
          }
        });
      });
      await waitFor(() => expect(screen.getByTestId("comments-edit-save")).toBeEnabled());
      expect(screen.getByLabelText(t("commentsEditAria"))).toHaveValue("unsaved local draft");
      fixture.editComment.mockRejectedValueOnce({
        kind: "conflict",
        code: "comment_revision_conflict",
        message: "Comment revision conflict",
        retryable: false
      });
      await user.click(screen.getByTestId("comments-edit-save"));
      await waitFor(() =>
        expect(fixture.editComment).toHaveBeenLastCalledWith({
          commentId: "comment-1",
          body: "unsaved local draft",
          expectedRevision: 1
        })
      );
      expect(screen.getByLabelText(t("commentsEditAria"))).toHaveValue("unsaved local draft");
      await user.click(screen.getByRole("button", { name: t("commentsCancelEdit") }));
      expect(screen.getByTestId("comments-item-body")).toHaveTextContent("second device body");
    } finally {
      await act(async () => {
        members.resolve(currentMembers);
        await refresh;
      });
      view.unmount();
      shell.release();
    }
  });

  it("binds an idle secondary-window hub to the connected profile", async () => {
    const { api } = createApi();

    renderHook(() =>
      useCommentsPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(api.listCollaborationMembers).toHaveBeenCalled();
      expect(api.listCollaborationAssignments).toHaveBeenCalled();
      expect(api.listCollaborationActivity).toHaveBeenCalled();
    });
  });

  it("loads pages, preserves drafts by work item, and mutates with expected revision", async () => {
    const {
      api,
      listComments,
      createComment,
      editComment,
      tombstoneComment,
      readCommentAttachment
    } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useCommentsPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.rows.length).toBeGreaterThan(0);
    });
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ includeTombstoned: true, limit: 20 })
    );
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ includeTombstoned: true, limit: 50 })
    );
    expect(result.current.hasMore).toBe(true);

    await expect(result.current.readAttachment("comment-1", "a".repeat(64))).resolves.toMatchObject(
      {
        mediaType: "image/png",
        bodyBase64: "iVBORw=="
      }
    );
    expect(readCommentAttachment).toHaveBeenCalledWith({
      commentId: "comment-1",
      digestSha256: "a".repeat(64)
    });

    await act(async () => {
      result.current.setDraftBody("saved draft");
    });
    expect(result.current.draft.body).toBe("saved draft");

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.hasMore).toBe(false);
    });

    await act(async () => {
      const ok = await result.current.submitComment();
      expect(ok).toBe(true);
    });
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        workItem: taskItem,
        body: "saved draft"
      })
    );
    expect(result.current.draft.body).toBe("");

    await act(async () => {
      await result.current.editComment("comment-1", "edited", 1);
    });
    expect(editComment).toHaveBeenCalledWith({
      commentId: "comment-1",
      body: "edited",
      expectedRevision: 1
    });

    await act(async () => {
      await result.current.tombstoneComment("comment-1", 2);
    });
    expect(tombstoneComment).toHaveBeenCalledWith({
      commentId: "comment-1",
      expectedRevision: 2
    });
    expect(result.current.rows.some((row) => row.commentId === "comment-1")).toBe(false);
    expect(
      Object.values(shell.controller.getSnapshot().commentsByWorkItem)
        .flat()
        .find((comment) => comment.commentId === "comment-1")
    ).toMatchObject({ tombstoned: true });
  });

  it("removes an active row when an observer refresh no longer returns the comment", async () => {
    const { api, listComments } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useCommentsPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.rows.map((row) => row.commentId)).toContain("comment-1");
    });

    const removedComment = {
      ...commentProjection("comment-1", "first", 2),
      body: null,
      tombstoned: true,
      tombstonedAt: "2030-01-01T00:10:00.000Z"
    };
    listComments.mockImplementation(async (query: { includeTombstoned?: boolean }) => ({
      items: query.includeTombstoned ? [removedComment] : [],
      nextCursor: null
    }));
    shell.controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-1",
      projectId: "project-1",
      event: {
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 1,
        previousCursor: 0,
        occurredAt: "2030-01-01T00:10:00.000Z",
        kind: "comment",
        workItem: taskItem
      }
    });

    await waitFor(() => {
      expect(shell.controller.getSnapshot().commentsByWorkItem[workItemKey(taskItem)]).toEqual([
        removedComment
      ]);
      expect(result.current.rows).toEqual([]);
    });
  });

  it("surfaces offline compose denial when session is disconnected", async () => {
    const { api } = createApi();
    (api.getCollaborationStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...connectedStatus(),
      activeProfileId: null,
      session: {
        phase: "idle",
        activeProfileId: null,
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });

    const { result } = renderHook(() =>
      useCommentsPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.mode).toBe("disconnected");
    });
    expect(result.current.canCompose).toBe(false);
  });
});

describe("useActivityPanelController", () => {
  it("loads activity pages and keeps rows non-commandable", async () => {
    const { api, listActivity } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useActivityPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    // Wait for the panel-scoped list (includes workItem), not only hub project catch-up.
    // Hub snapshot merge can populate rows earlier without establishing pagination cursors.
    await waitFor(() => {
      expect(listActivity).toHaveBeenCalledWith(expect.objectContaining({ workItem: taskItem }));
      expect(result.current.rows.length).toBe(1);
      expect(result.current.hasMore).toBe(true);
    });
    expect(result.current.rows[0]?.interactive).toBe(false);
    expect(result.current.rows[0]?.sourceLabelKey).toBe("activitySourceComment");

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.hasMore).toBe(false);
    });
  });
});

describe("comments hook mutation scope and composer ownership", () => {
  it.each([
    true,
    false
  ])("keeps B composer and busy intact after A completion (success=%s)", async (success) => {
    const f = await scopedPanel();
    enableUploads(f.api);
    const old = deferred<ReturnType<typeof commentProjection>>();
    const current = deferred<ReturnType<typeof commentProjection>>();
    f.createComment.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await act(async () => f.result.current.setDraftBody("A draft"));
    await stageImage(f, "A.png");
    let pendingA!: Promise<boolean>;
    act(() => {
      pendingA = f.result.current.submitComment();
    });
    await f.switchProject("project-B");
    await act(async () => f.result.current.setDraftBody("B draft"));
    await stageImage(f, "B.png");
    let pendingB!: Promise<boolean>;
    act(() => {
      pendingB = f.result.current.submitComment();
    });
    const rows = f.result.current.rows;
    const attachments = f.result.current.stagedAttachments;
    await act(async () => {
      if (success) old.resolve(commentProjection("comment-2", "A accepted"));
      else old.reject({ kind: "offline", code: "A_failed", message: "A offline", retryable: true });
      expect(await pendingA).toBe(success);
    });
    expect(f.result.current.draft.body).toBe("B draft");
    expect(f.result.current.stagedAttachments).toEqual(attachments);
    expect(f.result.current.rows).toEqual(rows);
    expect(f.result.current.actionError).toBeNull();
    expect(f.result.current.submitting).toBe(true);
    await act(async () => {
      current.resolve({ ...commentProjection("comment-3", "B accepted"), projectId: "project-B" });
      expect(await pendingB).toBe(true);
    });
    expect(f.result.current.draft.body).toBe("");
    expect(f.result.current.stagedAttachments).toEqual([]);
    expect(f.result.current.submitting).toBe(false);
    f.unmount();
  });

  it("consumes only the submitted draft version and attachment collection in the same scope", async () => {
    const f = await scopedPanel();
    enableUploads(f.api);
    const gate = deferred<ReturnType<typeof commentProjection>>();
    f.createComment.mockReturnValueOnce(gate.promise);
    await act(async () => f.result.current.setDraftBody("submitted body"));
    await stageImage(f, "submitted.png");
    let pending!: Promise<boolean>;
    act(() => {
      pending = f.result.current.submitComment();
    });
    await act(async () => {
      f.result.current.setDraftBody("new body");
      f.result.current.setDraftBody("submitted body");
    });
    await stageImage(f, "later.png");
    await act(async () => {
      gate.resolve(commentProjection("comment-2", "accepted"));
      expect(await pending).toBe(true);
    });
    expect(f.result.current.draft.body).toBe("submitted body");
    expect(f.result.current.stagedAttachments.map((item) => item.displayName)).toEqual([
      "later.png"
    ]);
    f.unmount();
  });

  for (const kind of ["edit", "delete"] as const) {
    it.each([
      true,
      false
    ])(`isolates late ${kind} row/error/finally (success=%s)`, async (success) => {
      const f = await scopedPanel();
      const old = deferred<ReturnType<typeof commentProjection>>();
      const next = deferred<ReturnType<typeof commentProjection>>();
      (kind === "edit" ? f.editComment : f.tombstoneComment).mockReturnValueOnce(old.promise);
      f.createComment.mockReturnValueOnce(next.promise);
      let pendingA!: Promise<boolean>;
      act(() => {
        pendingA =
          kind === "edit"
            ? f.result.current.editComment("comment-1", "A edit", 1)
            : f.result.current.tombstoneComment("comment-1", 1);
      });
      await f.switchProject("project-B");
      await act(async () => f.result.current.setDraftBody("B pending"));
      let pendingB!: Promise<boolean>;
      act(() => {
        pendingB = f.result.current.submitComment();
      });
      const rows = f.result.current.rows;
      await act(async () => {
        if (success)
          old.resolve({
            ...commentProjection("comment-1", "A changed", 2),
            tombstoned: kind === "delete"
          });
        else old.reject(new Error("A failed"));
        expect(await pendingA).toBe(success);
      });
      expect(f.result.current.rows).toEqual(rows);
      expect(f.result.current.actionError).toBeNull();
      expect(f.result.current.submitting).toBe(true);
      await act(async () => {
        next.resolve({ ...commentProjection("comment-3", "B accepted"), projectId: "project-B" });
        await pendingB;
      });
      f.unmount();
    });
  }

  it.each([
    "ABA",
    "profile",
    "close",
    "unmount"
  ])("protects the new draft after %s retires a pending submit", async (transition) => {
    const f = await scopedPanel();
    const old = deferred<ReturnType<typeof commentProjection>>();
    f.createComment.mockReturnValueOnce(old.promise);
    await act(async () => f.result.current.setDraftBody("old"));
    let pending!: Promise<boolean>;
    act(() => {
      pending = f.result.current.submitComment();
    });
    if (transition === "ABA") {
      await f.switchProject("project-B");
      await f.switchProject("project-1");
    }
    if (transition === "profile") await f.switchProject("project-1", "profile-B");
    if (transition === "close") {
      f.rerender({ open: false });
      f.rerender({ open: true });
      await waitFor(() => expect(f.result.current.loading).toBe(false));
    }
    if (transition === "unmount") f.unmount();
    const target = transition === "unmount" ? await scopedPanel() : f;
    await act(async () => target.result.current.setDraftBody("new unsent"));
    await act(async () => {
      old.resolve(commentProjection("comment-2", "accepted"));
      expect(await pending).toBe(true);
    });
    expect(getCommentDraft(taskItem).body).toBe("new unsent");
    expect(target.result.current.draft.body).toBe("new unsent");
    target.unmount();
  });

  it.each([
    "creating",
    "uploading",
    "finalizing"
  ] as const)("retires old attachment %s without advancing the upload chain in B", async (phase) => {
    const f = await scopedPanel();
    enableUploads(f.api);
    const gate = deferred<void>();
    if (phase === "creating")
      vi.mocked(f.api.createCollaborationPendingAttachment).mockImplementationOnce(async () => {
        await gate.promise;
        return { pendingUploadId: "old-upload" };
      });
    if (phase === "uploading")
      vi.mocked(f.api.uploadCollaborationPendingAttachment).mockImplementationOnce(async () => {
        await gate.promise;
      });
    if (phase === "finalizing")
      vi.mocked(f.api.finalizeCollaborationPendingAttachment).mockImplementationOnce(
        async (command) => {
          await gate.promise;
          return {
            pendingUploadId: command.pendingUploadId,
            digestSha256: command.expectedDigestSha256,
            sizeBytes: 4,
            mediaType: "image/png"
          };
        }
      );
    await act(async () => {
      await f.result.current.stageFiles([imageFile("old.png")]);
    });
    await waitFor(() => expect(f.result.current.stagedAttachments[0]?.phase).toBe(phase));
    act(() => f.result.current.setDraftBody("pending attachment draft"));
    await act(async () => expect(await f.result.current.submitComment()).toBe(false));
    expect(f.createComment).not.toHaveBeenCalled();
    expect(f.result.current.actionError).toBe(createTranslator("en")("commentsAttachmentsPending"));
    await f.switchProject("project-B");
    await stageImage(f, "B.png");
    const attachments = f.result.current.stagedAttachments;
    const uploads = vi.mocked(f.api.uploadCollaborationPendingAttachment).mock.calls.length;
    const finalizations = vi.mocked(f.api.finalizeCollaborationPendingAttachment).mock.calls.length;
    await act(async () => {
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(f.result.current.stagedAttachments).toEqual(attachments);
    expect(f.api.uploadCollaborationPendingAttachment).toHaveBeenCalledTimes(uploads);
    expect(f.api.finalizeCollaborationPendingAttachment).toHaveBeenCalledTimes(finalizations);
    f.unmount();
  });

  it("retires attachment staging before a delayed file read can create an upload in B", async () => {
    const f = await scopedPanel();
    enableUploads(f.api);
    const buffer = deferred<ArrayBuffer>();
    await act(async () => {
      await f.result.current.stageFiles([
        { ...imageFile("old.png"), arrayBuffer: () => buffer.promise }
      ]);
    });
    await f.switchProject("project-B");
    await act(async () => {
      buffer.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
      await buffer.promise;
    });
    expect(f.api.createCollaborationPendingAttachment).not.toHaveBeenCalled();
    expect(f.result.current.stagedAttachments).toEqual([]);
    f.unmount();
  });
});

describe("draft attachment cancellation and submission", () => {
  it("blocks submission while the file read is queued, including the staging event", async () => {
    const f = await scopedPanel();
    enableUploads(f.api);
    const buffer = deferred<ArrayBuffer>();
    act(() => f.result.current.setDraftBody("queued draft"));
    await act(async () => {
      const staging = f.result.current.stageFiles([
        { ...imageFile("queued.png"), arrayBuffer: () => buffer.promise }
      ]);
      expect(await f.result.current.submitComment()).toBe(false);
      await staging;
    });
    expect(f.result.current.stagedAttachments[0]?.phase).toBe("queued");
    expect(f.createComment).not.toHaveBeenCalled();
    await act(async () => {
      expect(await f.result.current.submitComment()).toBe(false);
    });
    expect(f.result.current.actionError).toBe(createTranslator("en")("commentsAttachmentsPending"));
    await act(async () => buffer.resolve(new Uint8Array([1, 2, 3, 4]).buffer));
    await waitFor(() => expect(f.result.current.stagedAttachments[0]?.phase).toBe("ready"));
    const input = f.result.current.stagedAttachments[0]!.input;
    await act(async () => expect(await f.result.current.submitComment()).toBe(true));
    expect(f.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "queued draft", attachments: [input] })
    );
    expect(f.result.current.stagedAttachments).toEqual([]);
    f.unmount();
    f.shell.release();
  });

  it("uses current draft and ready attachments after cancellation in the submit event", async () => {
    const f = await scopedPanel();
    enableUploads(f.api);
    await stageImage(f, "cancelled.png");
    const localId = f.result.current.stagedAttachments[0]!.localId;
    act(() => f.result.current.setDraftBody("previous text"));
    await act(async () => {
      f.result.current.cancelAttachment(localId);
      f.result.current.setDraftBody("current text");
      expect(await f.result.current.submitComment()).toBe(true);
    });
    expect(f.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "current text", attachments: [] })
    );
    expect(f.result.current.stagedAttachments[0]).toMatchObject({
      phase: "cancelled",
      input: null
    });
    expect(f.result.current.draft.body).toBe("");
    f.unmount();
    f.shell.release();
  });
});

describe("ready draft pending downloads", () => {
  it.each([
    "报告.pdf",
    "📎.txt"
  ])("saves %s from the Server read rather than the uploaded File", async (name) => {
    const f = await scopedPanel();
    enableUploads(f.api);
    await stageImage(f, name);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      expect(this.download).toBe(name);
      expect(this.href).toBe("data:text/plain;base64,c2VydmVy");
    });
    vi.mocked(f.api.readCollaborationPendingAttachment).mockResolvedValue({
      digestSha256: f.result.current.stagedAttachments[0]!.digestSha256!,
      mediaType: "text/plain",
      sizeBytes: 6,
      bodyBase64: "c2VydmVy"
    });
    await act(async () => {
      await f.result.current.downloadPendingAttachment(
        f.result.current.stagedAttachments[0]!.localId
      );
    });
    expect(click).toHaveBeenCalledOnce();
    f.unmount();
    f.shell.release();
  });

  it.each([
    "remove",
    "cancel",
    "publish",
    "project",
    "credential",
    "close"
  ] as const)("does not save or pollute the composer after %s retires a pending read", async (retire) => {
    const f = await scopedPanel();
    enableUploads(f.api);
    await stageImage(f, "📎.txt");
    const attachment = f.result.current.stagedAttachments[0]!;
    const gate =
      deferred<
        Awaited<ReturnType<PlanWeaveCollaborationApi["readCollaborationPendingAttachment"]>>
      >();
    vi.mocked(f.api.readCollaborationPendingAttachment).mockReturnValue(gate.promise);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    let download!: Promise<void>;
    act(() => {
      download = f.result.current.downloadPendingAttachment(attachment.localId);
    });
    if (retire === "remove") act(() => f.result.current.removeAttachment(attachment.localId));
    if (retire === "cancel") act(() => f.result.current.cancelAttachment(attachment.localId));
    if (retire === "publish") {
      act(() => f.result.current.setDraftBody("publish"));
      await act(async () => {
        expect(await f.result.current.submitComment()).toBe(true);
      });
    }
    if (retire === "project") await f.switchProject("project-B");
    if (retire === "credential")
      await act(async () => f.changeStatus("project-1", "profile-1", "new-credential-revision"));
    if (retire === "close") f.rerender({ open: false });
    await act(async () => {
      gate.resolve({
        digestSha256: attachment.digestSha256!,
        mediaType: "text/plain",
        sizeBytes: 6,
        bodyBase64: "c2VydmVy"
      });
      await download;
    });
    expect(click).not.toHaveBeenCalled();
    expect(f.result.current.actionError).toBeNull();
    expect(f.result.current.downloadingAttachments).toEqual([]);
    f.unmount();
    f.shell.release();
  });

  it("shows a current read error and permits another explicit download", async () => {
    const f = await scopedPanel();
    enableUploads(f.api);
    await stageImage(f, "报告.pdf");
    const item = f.result.current.stagedAttachments[0]!;
    vi.mocked(f.api.readCollaborationPendingAttachment).mockRejectedValueOnce(
      new Error("pending unavailable")
    );
    await act(async () => {
      await f.result.current.downloadPendingAttachment(item.localId);
    });
    expect(f.result.current.actionError).toContain("pending unavailable");
    expect(f.result.current.downloadingAttachments).toEqual([]);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(f.api.readCollaborationPendingAttachment).mockResolvedValue({
      digestSha256: item.digestSha256!,
      mediaType: "text/plain",
      sizeBytes: 6,
      bodyBase64: "c2VydmVy"
    });
    await act(async () => {
      await f.result.current.downloadPendingAttachment(item.localId);
    });
    expect(click).toHaveBeenCalledOnce();
    expect(f.result.current.actionError).toBeNull();
    f.unmount();
    f.shell.release();
  });
});

describe("pending download retired errors", () => {
  it("does not expose an old download failure in the new project draft", async () => {
    const f = await scopedPanel();
    enableUploads(f.api);
    await stageImage(f, "报告.pdf");
    const gate =
      deferred<
        Awaited<ReturnType<PlanWeaveCollaborationApi["readCollaborationPendingAttachment"]>>
      >();
    vi.mocked(f.api.readCollaborationPendingAttachment).mockReturnValueOnce(gate.promise);
    let read!: Promise<void>;
    act(() => {
      read = f.result.current.downloadPendingAttachment(
        f.result.current.stagedAttachments[0]!.localId
      );
    });
    await f.switchProject("project-B");
    act(() => f.result.current.setDraftBody("new draft"));
    await act(async () => {
      gate.reject(new Error("retired pending error"));
      await read;
    });
    expect(f.result.current.actionError).toBeNull();
    expect(f.result.current.draft.body).toBe("new draft");
    f.unmount();
    f.shell.release();
  });
});
