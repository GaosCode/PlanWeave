import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalContentVersionDigestPayload,
  compareContentVersionMemberPaths,
  completeContentVersionSchema,
  contentVersionDesktopLayoutMemberPath,
  isContentVersionPromptKind,
  type CompleteContentVersion,
  type ContentVersionMember,
  type ContentVersionMemberKind
} from "@planweave-ai/collaboration-protocol/content/version";
import { timestampSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { validateAuthoritativeCanvasContent } from "../desktop/contentVersionValidation.js";
import {
  desktopLayoutFileSchema,
  type DesktopLayout
} from "../desktop/types/desktopLayoutSchema.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { manifestSchema } from "../schema/manifest.js";
import { manifestPromptContentMembers } from "../package/promptContentMembers.js";
import type { PlanPackageManifest } from "../types.js";

export const canvasReplicaDocumentSchemaVersion = "canvas-replica-document/v1" as const;

export type CanvasReplicaDocument = {
  schemaVersion: typeof canvasReplicaDocumentSchemaVersion;
  manifest: PlanPackageManifest;
  promptMarkdownByPath: Record<string, string>;
  layout: DesktopLayout;
};

const canvasReplicaDocumentInputSchema = z
  .object({
    schemaVersion: z.literal(canvasReplicaDocumentSchemaVersion),
    manifest: manifestSchema,
    promptMarkdownByPath: z.record(z.string(), z.string()),
    layout: desktopLayoutFileSchema
  })
  .strict();

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateManifest(manifest: PlanPackageManifest): void {
  const diagnostics = compileTaskGraph(manifest).diagnostics.errors;
  if (diagnostics.length > 0) {
    throw new Error(
      `canvas_replica_manifest_invalid:${diagnostics.map((item) => item.code).join(",")}`
    );
  }
}

function validatePromptSet(
  manifest: PlanPackageManifest,
  promptMarkdownByPath: Record<string, string>
): void {
  const expected = manifestPromptContentMembers(manifest);
  const paths = Object.keys(promptMarkdownByPath);
  if (paths.length !== expected.size || paths.some((path) => !expected.has(path))) {
    throw new Error("canvas_replica_prompt_set_mismatch");
  }
}

function validateLayout(layout: DesktopLayout, manifest: PlanPackageManifest): void {
  timestampSchema.parse(layout.updatedAt);
  const nodeIds = layout.nodes.map((node) => node.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new Error("canvas_replica_layout_node_duplicate");
  }
  const taskIds = new Set(manifest.nodes.map((task) => task.id));
  if (nodeIds.some((nodeId) => !taskIds.has(nodeId))) {
    throw new Error("canvas_replica_layout_node_unknown");
  }
}

/** Parse, isolate, validate, and freeze a canonical in-memory replica document. */
export function parseCanvasReplicaDocument(input: unknown): CanvasReplicaDocument {
  const parsed = canvasReplicaDocumentInputSchema.parse(input);
  const manifest: PlanPackageManifest = parsed.manifest;
  validateManifest(manifest);
  validatePromptSet(manifest, parsed.promptMarkdownByPath);
  validateLayout(parsed.layout, manifest);
  return deepFreeze({
    schemaVersion: canvasReplicaDocumentSchemaVersion,
    manifest,
    promptMarkdownByPath: parsed.promptMarkdownByPath,
    layout: parsed.layout
  });
}

export function decodeCanvasReplicaDocument(rawContent: unknown): CanvasReplicaDocument {
  const validated = validateAuthoritativeCanvasContent(rawContent);
  const promptMarkdownByPath = Object.fromEntries(
    validated.content.members
      .filter((member) => isContentVersionPromptKind(member.kind))
      .map((member) => [member.path, member.content])
  );
  return parseCanvasReplicaDocument({
    schemaVersion: canvasReplicaDocumentSchemaVersion,
    manifest: validated.manifest,
    promptMarkdownByPath,
    layout: validated.layout
  });
}

function member(
  kind: ContentVersionMemberKind,
  path: string,
  content: string
): ContentVersionMember {
  return {
    kind,
    path,
    content,
    digestSha256: sha256(content),
    sizeBytes: Buffer.byteLength(content, "utf8")
  };
}

export function encodeCanvasReplicaDocument(input: CanvasReplicaDocument): CompleteContentVersion {
  const document = parseCanvasReplicaDocument(input);
  const expected = manifestPromptContentMembers(document.manifest);
  const members = [
    member("manifest", "manifest.json", `${JSON.stringify(document.manifest, null, 2)}\n`),
    ...[...expected.entries()].map(([path, kind]) =>
      member(kind, path, document.promptMarkdownByPath[path]!)
    ),
    member(
      "desktop_layout",
      contentVersionDesktopLayoutMemberPath,
      `${JSON.stringify(document.layout, null, 2)}\n`
    )
  ].sort((left, right) => compareContentVersionMemberPaths(left.path, right.path));
  const totalBytes = members.reduce((sum, item) => sum + item.sizeBytes, 0);
  const provisional = { members, totalBytes, canonicalDigest: "0".repeat(64) };
  return deepFreeze(
    completeContentVersionSchema.parse({
      ...provisional,
      canonicalDigest: sha256(canonicalContentVersionDigestPayload(provisional))
    })
  );
}
