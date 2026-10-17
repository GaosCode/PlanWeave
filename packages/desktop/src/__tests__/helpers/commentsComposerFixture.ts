import { webcrypto } from "node:crypto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { acquireCollaborationReadModelController } from "../../renderer/collaboration/collaborationReadModelHub";
import { useCommentsPanelController } from "../../renderer/hooks/useCommentsPanelController";
import { createTranslator } from "../../renderer/i18n";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { createApi, taskItem } from "./commentsPanelFixture";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function scopedPanel() {
  const fixture = createApi();
  const shell = acquireCollaborationReadModelController(fixture.api);
  await shell.controller.setActiveProject({
    profileId: "profile-1",
    projectId: "project-1",
    canvasId: "canvas-1"
  });
  const hook = renderHook(
    ({ open, workItem = taskItem }: { open: boolean; workItem?: WorkItemRef }) =>
      useCommentsPanelController({
        workItem,
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

export function enableUploads(api: PlanWeaveCollaborationApi) {
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

export const imageFile = (name: string) => ({
  name,
  type: "image/png",
  size: 4,
  arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
});

export async function stageImage(panel: Awaited<ReturnType<typeof scopedPanel>>, name: string) {
  const existingIds = new Set(panel.result.current.stagedAttachments.map((item) => item.localId));
  await act(async () => {
    await panel.result.current.stageFiles([imageFile(name)]);
  });
  await waitFor(() =>
    expect(
      panel.result.current.stagedAttachments.find(
        (item) => item.displayName === name && !existingIds.has(item.localId)
      )?.phase
    ).toBe("ready")
  );
}
