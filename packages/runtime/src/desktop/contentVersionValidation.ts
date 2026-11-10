import { createHash } from "node:crypto";
import {
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema,
  contentVersionDesktopLayoutMemberPath,
  isContentVersionPromptKind,
  type CompleteContentVersion,
  type ContentVersionMember
} from "@planweave-ai/collaboration-protocol/content/version";
import { manifestSchema } from "../schema/manifest.js";
import { manifestPromptContentMembers } from "../package/promptContentMembers.js";
import type { PlanPackageManifest } from "../types.js";
import { desktopLayoutFileSchema, type DesktopLayout } from "./types/desktopLayoutSchema.js";

export type ValidatedAuthoritativeCanvasContent = {
  content: CompleteContentVersion;
  manifest: PlanPackageManifest;
  layout: DesktopLayout;
};

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function verifyMemberDigests(content: CompleteContentVersion): void {
  for (const member of content.members) {
    if (member.sizeBytes !== Buffer.byteLength(member.content, "utf8")) {
      throw new Error("content_version_member_size_mismatch");
    }
    if (member.digestSha256 !== sha256(member.content)) {
      throw new Error("content_version_member_digest_mismatch");
    }
  }
  if (content.canonicalDigest !== sha256(canonicalContentVersionDigestPayload(content))) {
    throw new Error("content_version_canonical_digest_mismatch");
  }
}

function memberAtPath(content: CompleteContentVersion, path: string): ContentVersionMember {
  const member = content.members.find((candidate) => candidate.path === path);
  if (!member) throw new Error(`content_version_member_missing:${path}`);
  return member;
}

/**
 * Verifies the complete logical Plan Package represented by an immutable content version.
 * This pure boundary is shared by server persistence and runtime materialization.
 */
export function validateAuthoritativeCanvasContent(
  rawContent: unknown
): ValidatedAuthoritativeCanvasContent {
  const content = completeContentVersionSchema.parse(rawContent);
  verifyMemberDigests(content);

  const manifestMember = memberAtPath(content, "manifest.json");
  const manifest = manifestSchema.parse(JSON.parse(manifestMember.content)) as PlanPackageManifest;
  const layoutMember = memberAtPath(content, contentVersionDesktopLayoutMemberPath);
  const layout = desktopLayoutFileSchema.parse(JSON.parse(layoutMember.content));

  const expected = manifestPromptContentMembers(manifest);
  const actual = new Map(
    content.members
      .filter((member) => isContentVersionPromptKind(member.kind))
      .map((member) => [member.path, member.kind] as const)
  );
  if (actual.size !== expected.size) throw new Error("content_version_prompt_set_mismatch");
  for (const [path, kind] of expected) {
    if (actual.get(path) !== kind) throw new Error("content_version_prompt_set_mismatch");
  }

  return { content, manifest, layout };
}
