import { describe, expect, it } from "vitest";
import {
  authorizeAttachmentProjectAccess,
  authorizeCommentAttachmentRead,
  authorizeDigestScopedRead,
  authorizePendingUploadMutation,
  authorizePendingUploadRead,
  evaluateAttachmentMediaAndSize,
  evaluatePendingUploadTtlMs,
  type PendingUploadRecord
} from "../attachments/index.js";
import { COMMENT_ATTACHMENT_MAX_BYTES, COMMENT_STAGED_UPLOAD_TTL_MS } from "../comments/limits.js";

const member = {
  humanPrincipalId: "human-1",
  displayName: "Ada",
  deviceCredentialId: "device-1",
  projectId: "project-a",
  role: "member" as const,
  membershipId: "membership-1"
};

const owner = {
  ...member,
  humanPrincipalId: "human-owner",
  displayName: "Olivia",
  deviceCredentialId: "device-owner",
  role: "owner" as const,
  membershipId: "membership-owner"
};

const now = new Date("2026-07-24T12:00:00.000Z");

function pending(overrides: Partial<PendingUploadRecord> = {}): PendingUploadRecord {
  return {
    pendingUploadId: "pending-1",
    projectId: "project-a",
    uploaderHumanPrincipalId: "human-1",
    expectedSizeBytes: 12,
    mediaType: "text/plain",
    createdAt: "2026-07-24T11:00:00.000Z",
    expiresAt: "2026-07-24T13:00:00.000Z",
    status: "pending",
    ...overrides
  };
}

describe("comment attachment authorization policy", () => {
  it("allows project members/owners and denies Host-like and unauthenticated subjects", () => {
    expect(
      authorizeAttachmentProjectAccess({
        subject: { kind: "human", context: member },
        projectId: "project-a"
      }).allowed
    ).toBe(true);
    expect(
      authorizeAttachmentProjectAccess({
        subject: { kind: "human", context: owner },
        projectId: "project-a"
      }).allowed
    ).toBe(true);
    expect(
      authorizeAttachmentProjectAccess({
        subject: { kind: "unauthenticated" },
        projectId: "project-a"
      }).code
    ).toBe("attachment_auth_unauthenticated");
    expect(
      authorizeAttachmentProjectAccess({
        subject: {
          kind: "local_administrative_proof",
          proof: {
            kind: "local_administrative_proof",
            projectId: "project-a",
            humanPrincipalId: "human-owner",
            displayName: "Olivia",
            issuedAt: now.toISOString()
          }
        },
        projectId: "project-a"
      }).code
    ).toBe("attachment_auth_forbidden");
  });

  it("rejects cross-project human subjects", () => {
    expect(
      authorizeAttachmentProjectAccess({
        subject: {
          kind: "human",
          context: { ...member, projectId: "project-b" }
        },
        projectId: "project-a"
      }).code
    ).toBe("attachment_auth_project_mismatch");
  });

  it("restricts stream/finalize to the uploader and valid status/expiry", () => {
    expect(
      authorizePendingUploadMutation({
        subject: { kind: "human", context: member },
        projectId: "project-a",
        record: pending(),
        now,
        requiredStatus: ["pending"]
      }).allowed
    ).toBe(true);

    expect(
      authorizePendingUploadMutation({
        subject: {
          kind: "human",
          context: { ...member, humanPrincipalId: "human-2" }
        },
        projectId: "project-a",
        record: pending(),
        now,
        requiredStatus: ["pending"]
      }).code
    ).toBe("attachment_pending_not_uploader");

    expect(
      authorizePendingUploadMutation({
        subject: {
          kind: "human",
          context: { ...member, humanPrincipalId: "human-alias" }
        },
        projectId: "project-a",
        record: pending(),
        now,
        requiredStatus: ["pending"],
        sameHumanPrincipal: (left, right) =>
          left === right ||
          (left === "human-alias" && right === "human-1") ||
          (left === "human-1" && right === "human-alias")
      }).allowed
    ).toBe(true);

    expect(
      authorizePendingUploadMutation({
        subject: { kind: "human", context: member },
        projectId: "project-a",
        record: pending({ expiresAt: "2026-07-24T11:00:00.000Z" }),
        now,
        requiredStatus: ["pending"]
      }).code
    ).toBe("attachment_pending_expired");

    expect(
      authorizePendingUploadMutation({
        subject: { kind: "human", context: member },
        projectId: "project-a",
        record: pending({ status: "uploaded", digestSha256: "a".repeat(64) }),
        now,
        requiredStatus: ["pending"]
      }).code
    ).toBe("attachment_status_conflict");
  });

  it("allows project members to read uploaded/finalized content; denies bare non-reference digests", () => {
    const uploaded = pending({
      status: "uploaded",
      digestSha256: "b".repeat(64),
      uploadedAt: now.toISOString()
    });
    expect(
      authorizePendingUploadRead({
        subject: { kind: "human", context: owner },
        projectId: "project-a",
        record: uploaded,
        now
      }).allowed
    ).toBe(true);

    expect(
      authorizeDigestScopedRead({
        subject: { kind: "human", context: member },
        projectId: "project-a",
        referencedInProject: false
      }).code
    ).toBe("attachment_not_found");
    expect(
      authorizeDigestScopedRead({
        subject: { kind: "human", context: member },
        projectId: "project-a",
        referencedInProject: true
      }).allowed
    ).toBe(true);
  });

  it("keeps tombstoned comment attachments readable for project members", () => {
    expect(
      authorizeCommentAttachmentRead({
        subject: { kind: "human", context: member },
        projectId: "project-a",
        binding: {
          projectId: "project-a",
          commentId: "comment-1",
          digestSha256: "c".repeat(64),
          sizeBytes: 4,
          mediaType: "text/plain",
          createdAt: now.toISOString(),
          commentTombstonedAt: now.toISOString()
        }
      }).allowed
    ).toBe(true);
  });

  it("enforces media/size/ttl bounds without relying on dispatch grant types", () => {
    expect(
      evaluateAttachmentMediaAndSize({
        sizeBytes: COMMENT_ATTACHMENT_MAX_BYTES,
        mediaType: "image/png"
      }).allowed
    ).toBe(true);
    expect(
      evaluateAttachmentMediaAndSize({
        sizeBytes: COMMENT_ATTACHMENT_MAX_BYTES + 1,
        mediaType: "image/png"
      }).code
    ).toBe("attachment_size_limit");
    expect(
      evaluateAttachmentMediaAndSize({
        sizeBytes: 10,
        mediaType: "application/octet-stream"
      }).code
    ).toBe("attachment_media_type");
    expect(evaluatePendingUploadTtlMs(COMMENT_STAGED_UPLOAD_TTL_MS).allowed).toBe(true);
    expect(evaluatePendingUploadTtlMs(1).code).toBe("attachment_input_invalid");
  });
});
