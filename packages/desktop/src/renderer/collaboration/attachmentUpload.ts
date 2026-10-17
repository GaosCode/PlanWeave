import {
  COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES,
  COMMENT_ATTACHMENT_MAX_BYTES
} from "@planweave-ai/collaboration-protocol/core/limits";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { sanitizeAttachmentFileName } from "./commentViewModels.js";

export type CommentAttachmentMediaType = (typeof COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES)[number];

export type StagedAttachmentPhase =
  | "queued"
  | "creating"
  | "uploading"
  | "finalizing"
  | "ready"
  | "error"
  | "cancelled";

/** Wire attachment input for comment create (matches commentAttachmentInputSchema). */
export type StagedAttachmentInput = {
  pendingUploadId: string;
  digestSha256: string;
  sizeBytes: number;
  mediaType: CommentAttachmentMediaType;
  fileName?: string;
};

export type StagedAttachment = {
  localId: string;
  displayName: string;
  mediaType: CommentAttachmentMediaType;
  sizeBytes: number;
  phase: StagedAttachmentPhase;
  progress: number;
  errorMessage: string | null;
  pendingUploadId: string | null;
  digestSha256: string | null;
  /** Ready payload for comment create. */
  input: StagedAttachmentInput | null;
};

export function isStagedAttachmentPending(attachment: StagedAttachment): boolean {
  return (
    attachment.phase === "queued" ||
    attachment.phase === "creating" ||
    attachment.phase === "uploading" ||
    attachment.phase === "finalizing"
  );
}

const allowedMedia = new Set<string>(COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES);

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("crypto_subtle_unavailable");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createStagedAttachmentFromFile(file: {
  name: string;
  type: string;
  size: number;
}): { ok: true; staged: StagedAttachment } | { ok: false; error: string } {
  const displayName = sanitizeAttachmentFileName(file.name);
  const mediaType = file.type || "application/octet-stream";
  if (!allowedMedia.has(mediaType)) {
    return { ok: false, error: "attachment_media_type_not_allowed" };
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > COMMENT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: "attachment_size_invalid" };
  }
  return {
    ok: true,
    staged: {
      localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      displayName,
      mediaType: mediaType as CommentAttachmentMediaType,
      sizeBytes: file.size,
      phase: "queued",
      progress: 0,
      errorMessage: null,
      pendingUploadId: null,
      digestSha256: null,
      input: null
    }
  };
}

/**
 * Stage create → upload → finalize for one file.
 * Cancellation is cooperative: when `isCancelled()` returns true, later steps are skipped.
 * Never accepts or returns filesystem paths.
 */
export async function uploadStagedAttachment(input: {
  api: PlanWeaveCollaborationApi;
  staged: StagedAttachment;
  bytes: Uint8Array;
  isCancelled: () => boolean;
  onProgress: (next: StagedAttachment) => void;
}): Promise<StagedAttachment> {
  let current: StagedAttachment = {
    ...input.staged,
    phase: "creating",
    progress: 0.1,
    errorMessage: null
  };
  const cancelled = (): StagedAttachment => ({
    ...current,
    phase: "cancelled",
    progress: 0,
    errorMessage: null,
    input: null
  });
  if (input.isCancelled()) return cancelled();
  input.onProgress(current);

  try {
    if (input.isCancelled()) return cancelled();
    const digestSha256 = await sha256Hex(input.bytes);
    if (input.isCancelled()) {
      return cancelled();
    }

    const pending = await input.api.createCollaborationPendingAttachment({
      expectedSizeBytes: input.bytes.byteLength,
      mediaType: current.mediaType,
      fileName: current.displayName,
      expectedDigestSha256: digestSha256
    });
    if (input.isCancelled()) return cancelled();
    current = {
      ...current,
      phase: "uploading",
      progress: 0.35,
      pendingUploadId: pending.pendingUploadId,
      digestSha256
    };
    input.onProgress(current);
    if (input.isCancelled()) {
      return cancelled();
    }

    await input.api.uploadCollaborationPendingAttachment({
      pendingUploadId: pending.pendingUploadId,
      mediaType: current.mediaType,
      bodyBase64: bytesToBase64(input.bytes),
      digestSha256
    });
    if (input.isCancelled()) return cancelled();
    current = { ...current, phase: "finalizing", progress: 0.8 };
    input.onProgress(current);
    if (input.isCancelled()) {
      return cancelled();
    }

    const finalized = await input.api.finalizeCollaborationPendingAttachment({
      pendingUploadId: pending.pendingUploadId,
      expectedDigestSha256: digestSha256
    });
    if (input.isCancelled()) return cancelled();
    const ready: StagedAttachment = {
      ...current,
      phase: "ready",
      progress: 1,
      digestSha256: finalized.digestSha256,
      pendingUploadId: finalized.pendingUploadId,
      input: {
        pendingUploadId: finalized.pendingUploadId,
        digestSha256: finalized.digestSha256,
        sizeBytes: finalized.sizeBytes,
        mediaType: finalized.mediaType,
        fileName: finalized.fileName ?? current.displayName
      }
    };
    input.onProgress(ready);
    return ready;
  } catch (error) {
    if (input.isCancelled()) {
      return cancelled();
    }
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "attachment_upload_failed";
    const failed: StagedAttachment = {
      ...current,
      phase: "error",
      progress: 0,
      errorMessage: message
    };
    input.onProgress(failed);
    return failed;
  }
}
