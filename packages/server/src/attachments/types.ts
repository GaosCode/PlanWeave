export type AttachmentStatus = "staged" | "ready" | "failed" | "superseded";
export type Attachment = { id: string; projectId: string; uploaderUserId: string; declaredSize: number; declaredDigest: string; actualSize: number | null; actualDigest: string | null; status: AttachmentStatus; originalName: string; mediaType: string; stagedPath: string; createdAt: string; promotedAt: string | null; supersedesAttachmentId: string | null };

export type AttachmentPolicy = { maxSizeBytes: number };

export const DEFAULT_ATTACHMENT_POLICY: AttachmentPolicy = { maxSizeBytes: 50 * 1024 * 1024 };
