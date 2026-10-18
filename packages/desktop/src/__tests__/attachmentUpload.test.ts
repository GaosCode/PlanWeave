import { collaborationOperationScopeFixture } from "./helpers/collaborationOperationScopeFixture";
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStagedAttachmentFromFile,
  uploadStagedAttachment,
  type StagedAttachment
} from "../renderer/collaboration/attachmentUpload";
import { createApi } from "./helpers/commentsPanelFixture";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.unstubAllGlobals());

describe("staged attachment cooperative cancellation", () => {
  it.each([
    { boundary: "start", outcome: "success", cancel: true },
    ...(["digest", "create", "upload", "finalize"] as const).flatMap((boundary) => [
      { boundary, outcome: "success", cancel: true },
      { boundary, outcome: "rejection", cancel: true },
      { boundary, outcome: "rejection", cancel: false }
    ])
  ])("settles $boundary $outcome with cancellation=$cancel", async ({
    boundary,
    outcome,
    cancel
  }) => {
    const { api } = createApi();
    const entered = deferred();
    const release = deferred();
    const digest = new Uint8Array(32).buffer;
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async () => {
          if (boundary === "digest") {
            entered.resolve();
            await release.promise;
          }
          return digest;
        }
      }
    });
    const pause = async (step: string) => {
      if (boundary !== step) return;
      entered.resolve();
      await release.promise;
    };
    vi.mocked(api.createCollaborationPendingAttachment).mockImplementation(async () => {
      await pause("create");
      return { pendingUploadId: "pending-1" };
    });
    vi.mocked(api.uploadCollaborationPendingAttachment).mockImplementation(async () => {
      await pause("upload");
    });
    vi.mocked(api.finalizeCollaborationPendingAttachment).mockImplementation(async () => {
      await pause("finalize");
      return {
        pendingUploadId: "pending-1",
        digestSha256: "0".repeat(64),
        mediaType: "image/png",
        sizeBytes: 4
      };
    });
    const created = createStagedAttachmentFromFile({
      name: "image.png",
      type: "image/png",
      size: 4
    });
    if (!created.ok) throw new Error(created.error);
    let cancelled = boundary === "start";
    const progress: StagedAttachment[] = [];
    const pending = uploadStagedAttachment({
      operationScope: collaborationOperationScopeFixture(),
      api,
      staged: created.staged,
      bytes: new Uint8Array([1, 2, 3, 4]),
      isCancelled: () => cancelled,
      onProgress: (next) => progress.push(next)
    });
    if (boundary !== "start") await entered.promise;
    const beforeCancellation = [...progress];
    cancelled = cancel;
    if (outcome === "rejection") release.reject(new Error("late failure"));
    else release.resolve();
    expect(await pending).toMatchObject({
      phase: cancel ? "cancelled" : "error",
      input: null,
      errorMessage: cancel ? null : "late failure"
    });
    if (cancel) expect(progress).toEqual(boundary === "start" ? [] : beforeCancellation);
    else {
      expect(progress.slice(0, -1)).toEqual(beforeCancellation);
      expect(progress.at(-1)).toMatchObject({ phase: "error", errorMessage: "late failure" });
    }
    expect(api.createCollaborationPendingAttachment).toHaveBeenCalledTimes(
      ["start", "digest"].includes(boundary) ? 0 : 1
    );
    expect(api.uploadCollaborationPendingAttachment).toHaveBeenCalledTimes(
      ["upload", "finalize"].includes(boundary) ? 1 : 0
    );
    expect(api.finalizeCollaborationPendingAttachment).toHaveBeenCalledTimes(
      boundary === "finalize" ? 1 : 0
    );
  });

  it("returns the finalized payload and ordered progress on success", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const { api } = createApi();
    vi.mocked(api.createCollaborationPendingAttachment).mockResolvedValue({
      pendingUploadId: "pending-1"
    });
    vi.mocked(api.uploadCollaborationPendingAttachment).mockResolvedValue(undefined);
    vi.mocked(api.finalizeCollaborationPendingAttachment).mockResolvedValue({
      pendingUploadId: "pending-1",
      digestSha256: "a".repeat(64),
      sizeBytes: 4,
      mediaType: "image/png"
    });
    const created = createStagedAttachmentFromFile({
      name: "image.png",
      type: "image/png",
      size: 4
    });
    if (!created.ok) throw new Error(created.error);
    const phases: string[] = [];
    const ready = await uploadStagedAttachment({
      operationScope: collaborationOperationScopeFixture(),
      api,
      staged: created.staged,
      bytes: new Uint8Array([1, 2, 3, 4]),
      isCancelled: () => false,
      onProgress: (next) => phases.push(next.phase)
    });
    expect(phases).toEqual(["creating", "uploading", "finalizing", "ready"]);
    expect(ready.input).toEqual({
      pendingUploadId: "pending-1",
      digestSha256: "a".repeat(64),
      sizeBytes: 4,
      mediaType: "image/png",
      fileName: "image.png"
    });
  });
});
