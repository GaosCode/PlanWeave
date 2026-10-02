/* @vitest-environment jsdom */

import { webcrypto } from "node:crypto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import {
  getCommentDraft,
  resetCommentDraftStoreForTests
} from "../renderer/collaboration/commentDraftStore";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { useCommentsPanelController } from "../renderer/hooks/useCommentsPanelController";
import { useActivityPanelController } from "../renderer/hooks/useActivityPanelController";
import { createTranslator } from "../renderer/i18n";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
import { workItemKey } from "../shared/collaborationReadModels";

const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };

function connectedStatus(): CollaborationStatus {
  return {
    profiles: [
      {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://example.test",
        projectId: "project-1",
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: "human-1",
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    activeProfileId: "profile-1",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connected",
      activeProfileId: "profile-1",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

function commentProjection(id: string, body: string, revision = 1) {
  return {
    commentId: id,
    projectId: "project-1",
    workItem: taskItem,
    author: {
      humanPrincipalId: "human-1",
      displayName: "Ada",
      membershipActive: true
    },
    body,
    bodyFormat: "markdown" as const,
    revision,
    createdAt: `2030-01-01T00:00:0${id.slice(-1)}.000Z`,
    updatedAt: `2030-01-01T00:00:0${id.slice(-1)}.000Z`,
    tombstoned: false,
    attachments: [],
    workItemPresence: "present" as const
  };
}

function createApi() {
  let status = connectedStatus();
  const statusListeners = new Set<(status: CollaborationStatus) => void>();
  const listComments = vi.fn().mockImplementation(async (query: { cursor?: unknown }) => {
    if (query?.cursor) {
      return {
        items: [commentProjection("comment-0", "older")],
        nextCursor: null
      };
    }
    return {
      items: [
        { ...commentProjection("comment-1", "first"), projectId: status.profiles[0]!.projectId }
      ],
      nextCursor: { createdAt: "2030-01-01T00:00:01.000Z", commentId: "comment-1" }
    };
  });
  const listActivity = vi.fn().mockImplementation(async (query: { cursor?: unknown }) => {
    if (query?.cursor) {
      return { items: [], nextCursor: null };
    }
    return {
      items: [
        {
          activityId: "act-1",
          projectId: "project-1",
          type: "comment_created",
          source: { kind: "comment", sourceId: "comment-1" },
          summary: { headline: "Ada commented", commentId: "comment-1", workItem: taskItem },
          subjects: [{ kind: "human", humanPrincipalId: "human-1", displayName: "Ada" }],
          workItem: taskItem,
          occurredAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      nextCursor: { occurredAt: "2030-01-01T00:00:01.000Z", activityId: "act-1" }
    };
  });

  const createComment = vi.fn().mockResolvedValue(commentProjection("comment-2", "new", 1));
  const editComment = vi.fn().mockResolvedValue(commentProjection("comment-1", "edited", 2));
  const tombstoneComment = vi.fn().mockResolvedValue({
    ...commentProjection("comment-1", "first", 3),
    body: null,
    tombstoned: true,
    tombstonedAt: "2030-01-01T00:05:00.000Z"
  });
  const readCommentAttachment = vi.fn().mockResolvedValue({
    digestSha256: "a".repeat(64),
    mediaType: "image/png",
    sizeBytes: 4,
    bodyBase64: "iVBORw=="
  });

  const api = {
    getCollaborationStatus: vi.fn(async () => status),
    listCollaborationMembers: vi.fn().mockResolvedValue({
      items: [
        {
          membershipId: "m-1",
          projectId: "project-1",
          humanPrincipalId: "human-1",
          displayName: "Ada",
          role: "owner",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      nextCursor: null
    }),
    listCollaborationAssignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({
      workItem: taskItem,
      humans: [],
      hosts: [],
      nextHumanCursor: null,
      nextHostCursor: null
    }),
    listCollaborationComments: listComments,
    listCollaborationActivity: listActivity,
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: createComment,
    editCollaborationComment: editComment,
    tombstoneCollaborationComment: tombstoneComment,
    createCollaborationPendingAttachment: vi.fn(),
    uploadCollaborationPendingAttachment: vi.fn(),
    finalizeCollaborationPendingAttachment: vi.fn(),
    readCollaborationCommentAttachment: readCommentAttachment,
    onCollaborationStatusChanged: vi.fn((listener: (next: CollaborationStatus) => void) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    }),
    onCollaborationObserverSignal: vi.fn(() => () => undefined)
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;

  return {
    api,
    listComments,
    listActivity,
    createComment,
    editComment,
    tombstoneComment,
    readCommentAttachment,
    changeStatus: (projectId: string, profileId = "profile-1") => {
      status = connectedStatus();
      status.activeProfileId = profileId;
      status.session.activeProfileId = profileId;
      status.profiles[0] = { ...status.profiles[0]!, projectId, profileId };
      for (const listener of statusListeners) listener(status);
    }
  };
}

afterEach(() => {
  resetCollaborationReadModelHubForTests();
  resetCommentDraftStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useCommentsPanelController", () => {
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
      expect.objectContaining({ includeTombstoned: false })
    );
    expect(listComments).toHaveBeenCalledWith(expect.objectContaining({ includeTombstoned: true }));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function scopedPanel() {
  const fixture = createApi();
  const shell = acquireCollaborationReadModelController(fixture.api);
  await shell.controller.setActiveProject({
    profileId: "profile-1",
    projectId: "project-1",
    canvasId: "canvas-1"
  });
  const hook = renderHook(
    ({ open }) =>
      useCommentsPanelController({
        workItem: taskItem,
        open,
        api: fixture.api,
        t: createTranslator("en")
      }),
    { initialProps: { open: true } }
  );
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await waitFor(() => expect(hook.result.current.canCompose).toBe(true));
  const switchProject = async (projectId: string, profileId = "profile-1") => {
    await act(async () => {
      fixture.changeStatus(projectId, profileId);
      await shell.controller.setActiveProject({ profileId, projectId, canvasId: "canvas-1" });
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
  };
  return { ...fixture, ...hook, shell, switchProject };
}

function enableUploads(api: PlanWeaveCollaborationApi) {
  vi.stubGlobal("crypto", webcrypto);
  let seq = 0;
  vi.mocked(api.createCollaborationPendingAttachment).mockImplementation(async () => ({
    pendingUploadId: `upload-${++seq}`
  }));
  vi.mocked(api.uploadCollaborationPendingAttachment).mockResolvedValue(undefined);
  vi.mocked(api.finalizeCollaborationPendingAttachment).mockImplementation(async (command) => ({
    pendingUploadId: command.pendingUploadId,
    digestSha256: command.expectedDigestSha256,
    sizeBytes: 4,
    mediaType: "image/png",
    fileName: "image.png"
  }));
}

const imageFile = (name: string) => ({
  name,
  type: "image/png",
  size: 4,
  arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
});

async function stageImage(panel: Awaited<ReturnType<typeof scopedPanel>>, name: string) {
  await act(async () => {
    await panel.result.current.stageFiles([imageFile(name)]);
  });
  await waitFor(() =>
    expect(
      panel.result.current.stagedAttachments.find((item) => item.displayName === name)?.phase
    ).toBe("ready")
  );
}

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
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(f.api.createCollaborationPendingAttachment).not.toHaveBeenCalled();
    expect(f.result.current.stagedAttachments).toEqual([]);
    f.unmount();
  });
});
