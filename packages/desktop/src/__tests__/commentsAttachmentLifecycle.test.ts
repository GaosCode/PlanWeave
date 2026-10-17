/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCollaborationReadModelHubForTests } from "../renderer/collaboration/collaborationReadModelHub";
import { resetCommentDraftStoreForTests } from "../renderer/collaboration/commentDraftStore";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { taskItem } from "./helpers/commentsPanelFixture";
import {
  deferred,
  scopedPanel,
  enableUploads,
  imageFile,
  stageImage
} from "./helpers/commentsComposerFixture";

afterEach(() => {
  cleanupRendererTestEnvironment();
  resetCollaborationReadModelHubForTests();
  resetCommentDraftStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const retireOutcomes = (["cancel", "remove"] as const).flatMap((retire) =>
  (["success", "rejection"] as const).map((outcome) => ({ retire, outcome }))
);

describe("attachment draft attempt ownership through the real uploader", () => {
  it.each(retireOutcomes)("ignores a file read $outcome after $retire", async ({
    retire,
    outcome
  }) => {
    const f = await scopedPanel();
    enableUploads(f.api);
    const buffer = deferred<ArrayBuffer>();
    await act(async () => {
      await f.result.current.stageFiles([
        { ...imageFile("same.png"), arrayBuffer: () => buffer.promise }
      ]);
    });
    const localId = f.result.current.stagedAttachments[0]!.localId;
    act(() => {
      if (retire === "cancel") f.result.current.cancelAttachment(localId);
      else f.result.current.removeAttachment(localId);
    });
    const retired = f.result.current.stagedAttachments;
    await act(async () => {
      if (outcome === "success") buffer.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
      else buffer.reject(new Error("late file read failure"));
      await buffer.promise.catch(() => undefined);
    });
    expect(f.result.current.stagedAttachments).toEqual(retired);
    expect(f.api.createCollaborationPendingAttachment).not.toHaveBeenCalled();
    expect(f.result.current.actionError).toBeNull();
    f.unmount();
    f.shell.release();
  });

  it.each(
    retireOutcomes
  )("keeps a new same-name selection after old finalize $outcome and $retire", async ({
    retire,
    outcome
  }) => {
    const f = await scopedPanel();
    enableUploads(f.api);
    const finalize = deferred<void>();
    vi.mocked(f.api.finalizeCollaborationPendingAttachment).mockImplementationOnce(
      async (command) => {
        await finalize.promise;
        return {
          pendingUploadId: command.pendingUploadId,
          digestSha256: command.expectedDigestSha256,
          sizeBytes: 4,
          mediaType: "image/png"
        };
      }
    );
    await act(async () => f.result.current.stageFiles([imageFile("same.png")]));
    await waitFor(() => expect(f.result.current.stagedAttachments[0]?.phase).toBe("finalizing"));
    const oldId = f.result.current.stagedAttachments[0]!.localId;
    act(() => {
      if (retire === "remove") f.result.current.removeAttachment(oldId);
      else {
        f.result.current.cancelAttachment(oldId);
        f.result.current.cancelAttachment(oldId);
      }
    });
    await stageImage(f, "same.png");
    const ready = f.result.current.stagedAttachments.find((item) => item.phase === "ready")!;
    expect(ready.localId).not.toBe(oldId);
    const snapshot = f.result.current.stagedAttachments;
    await act(async () => {
      if (outcome === "success") finalize.resolve();
      else finalize.reject(new Error("late finalize failure"));
      await finalize.promise.catch(() => undefined);
    });
    expect(f.result.current.stagedAttachments).toEqual(snapshot);
    act(() => f.result.current.setDraftBody("new selection only"));
    await act(async () => expect(await f.result.current.submitComment()).toBe(true));
    expect(f.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [ready.input] })
    );
    expect(f.result.current.stagedAttachments).toEqual(
      retire === "remove"
        ? []
        : [expect.objectContaining({ localId: oldId, phase: "cancelled", input: null })]
    );
    f.unmount();
    f.shell.release();
  });

  it("treats two consecutive same-name selections as independent identities", async () => {
    const f = await scopedPanel();
    enableUploads(f.api);
    await stageImage(f, "same.png");
    const firstId = f.result.current.stagedAttachments[0]!.localId;
    await stageImage(f, "same.png");
    const second = f.result.current.stagedAttachments[1]!;
    expect(second.localId).not.toBe(firstId);
    act(() => {
      f.result.current.removeAttachment(firstId);
      f.result.current.setDraftBody("second only");
    });
    await act(async () => expect(await f.result.current.submitComment()).toBe(true));
    expect(f.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [second.input] })
    );
    f.unmount();
    f.shell.release();
  });

  it.each(
    (["workItem", "canvas", "project", "credential"] as const).flatMap((scope) =>
      (["success", "rejection"] as const).map((outcome) => ({ scope, outcome }))
    )
  )("retires an old finalize across $scope A-B-A before its $outcome", async ({
    scope,
    outcome
  }) => {
    const f = await scopedPanel();
    enableUploads(f.api);
    const finalize = deferred<void>();
    vi.mocked(f.api.finalizeCollaborationPendingAttachment).mockImplementationOnce(
      async (command) => {
        await finalize.promise;
        return {
          pendingUploadId: command.pendingUploadId,
          digestSha256: command.expectedDigestSha256,
          sizeBytes: 4,
          mediaType: "image/png"
        };
      }
    );
    await act(async () => f.result.current.stageFiles([imageFile("same.png")]));
    await waitFor(() => expect(f.result.current.stagedAttachments[0]?.phase).toBe("finalizing"));
    const oldId = f.result.current.stagedAttachments[0]!.localId;
    if (scope === "project") {
      await f.switchProject("project-B");
      await f.switchProject("project-1");
    } else if (scope === "credential") {
      await act(async () => f.changeStatus("project-1", "profile-1", "credential-B"));
      await act(async () => f.changeStatus("project-1", "profile-1"));
    } else {
      f.rerender({
        open: true,
        workItem: {
          ...taskItem,
          ...(scope === "canvas" ? { canvasId: "canvas-B" } : { taskId: "T-B" })
        }
      });
      f.rerender({ open: true, workItem: taskItem });
    }
    await waitFor(() => expect(f.result.current.loading).toBe(false));
    act(() => f.result.current.setDraftBody("new A draft"));
    await stageImage(f, "same.png");
    const snapshot = f.result.current.stagedAttachments;
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.localId).not.toBe(oldId);
    await act(async () => {
      if (outcome === "success") finalize.resolve();
      else finalize.reject(new Error("retired scope failure"));
      await finalize.promise.catch(() => undefined);
    });
    expect(f.result.current.stagedAttachments).toEqual(snapshot);
    expect(f.result.current.draft.body).toBe("new A draft");
    expect(f.result.current.actionError).toBeNull();
    expect(f.result.current.submitting).toBe(false);
    f.unmount();
    f.shell.release();
  });

  it("preserves ready input and the draft after failed submit, then consumes them on retry", async () => {
    const f = await scopedPanel();
    enableUploads(f.api);
    await stageImage(f, "ready.png");
    act(() => f.result.current.setDraftBody("retry this draft"));
    const ready = f.result.current.stagedAttachments;
    f.createComment.mockRejectedValueOnce({
      kind: "conflict",
      code: "revision_conflict",
      message: "retry",
      retryable: false
    });
    await act(async () => expect(await f.result.current.submitComment()).toBe(false));
    expect(f.result.current.draft.body).toBe("retry this draft");
    expect(f.result.current.stagedAttachments).toEqual(ready);
    expect(f.result.current.submitting).toBe(false);
    expect(f.result.current.actionError).not.toBeNull();
    await act(async () => expect(await f.result.current.submitComment()).toBe(true));
    expect(f.createComment).toHaveBeenLastCalledWith(
      expect.objectContaining({ attachments: [ready[0]!.input], body: "retry this draft" })
    );
    expect(f.result.current.stagedAttachments).toEqual([]);
    expect(f.result.current.draft.body).toBe("");
    f.unmount();
    f.shell.release();
  });

  it("permits text submission with failed and cancelled rows without sending either input", async () => {
    const f = await scopedPanel();
    enableUploads(f.api);
    vi.mocked(f.api.createCollaborationPendingAttachment).mockRejectedValueOnce(
      new Error("upload denied")
    );
    await act(async () => f.result.current.stageFiles([imageFile("failed.png")]));
    await waitFor(() => expect(f.result.current.stagedAttachments[0]?.phase).toBe("error"));
    await stageImage(f, "cancelled.png");
    act(() => {
      f.result.current.cancelAttachment(f.result.current.stagedAttachments[1]!.localId);
      f.result.current.setDraftBody("text is still publishable");
    });
    await act(async () => expect(await f.result.current.submitComment()).toBe(true));
    expect(f.createComment).toHaveBeenCalledWith(expect.objectContaining({ attachments: [] }));
    expect(f.result.current.stagedAttachments.map((item) => item.phase)).toEqual([
      "error",
      "cancelled"
    ]);
    f.unmount();
    f.shell.release();
  });
});
