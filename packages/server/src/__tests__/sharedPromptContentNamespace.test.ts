import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  completeContentVersionSchema,
  compareContentVersionMemberPaths,
  normalizeContentVersionPromptPath,
  type CompleteContentVersion,
  type ContentVersionMember
} from "@planweave-ai/collaboration-protocol/content/version";
import { packageSnapshotDigestManifestSchema } from "@planweave-ai/collaboration-protocol/content/snapshot";
import {
  captureAuthorizedCanvasContent,
  decodeCanvasReplicaDocument,
  encodeCanvasReplicaDocument,
  materializeAuthoritativeCanvasWorkspace,
  parseCanvasReplicaDocument,
  restorePackageSnapshot
} from "@planweave-ai/runtime";
import { validateAuthoritativeCanvasContent } from "../../../runtime/src/desktop/contentVersionValidation.js";
import { layoutPathForWorkspace } from "../../../runtime/src/desktop/layoutStore.js";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ContentVersionService } from "../canvas/contentVersionService.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { actor, canvasCommandServiceFixture } from "./support/canvasCommandServiceFixture.js";

type Fixture = Awaited<ReturnType<typeof canvasCommandServiceFixture>>;
const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function member(
  kind: ContentVersionMember["kind"],
  path: string,
  content: string
): ContentVersionMember {
  return {
    kind,
    path,
    content,
    digestSha256: hash(content),
    sizeBytes: Buffer.byteLength(content)
  };
}

function explicitContent(
  fixture: Fixture,
  firstPath: string,
  secondPath: string
): CompleteContentVersion {
  const initial = fixture.contentVersions.readVersion(
    scope,
    fixture.contentVersions.head(scope)!.content
  ).content;
  const document = decodeCanvasReplicaDocument(initial);
  const manifest = structuredClone(document.manifest);
  manifest.nodes[0]!.prompt = firstPath;
  manifest.nodes[1]!.prompt = secondPath;
  const members = [
    ...initial.members.filter((item) => item.kind !== "manifest" && item.kind !== "task_prompt"),
    member("manifest", "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`),
    member(
      "task_prompt",
      normalizeContentVersionPromptPath(firstPath),
      "# First explicit Prompt\r\n"
    ),
    member(
      "task_prompt",
      normalizeContentVersionPromptPath(secondPath),
      "# Second explicit Prompt\r\n"
    )
  ].sort((left, right) => compareContentVersionMemberPaths(left.path, right.path));
  const totalBytes = members.reduce((total, item) => total + item.sizeBytes, 0);
  const canonicalPayload = JSON.stringify({
    members: members.map(({ kind, path, digestSha256, sizeBytes }) => ({
      kind,
      path,
      digestSha256,
      sizeBytes
    })),
    totalBytes
  });
  return { members, totalBytes, canonicalDigest: hash(canonicalPayload) };
}

function publisher(fixture: Fixture) {
  return new ContentVersionService({
    repository: fixture.contentVersions,
    access: fixture.access,
    workspaceIdentity: new WorkspaceIdentityRepository(fixture.database)
  });
}

function persistedRows(fixture: Fixture) {
  return Object.fromEntries(
    [
      "canvas_registry",
      "canvas_content_versions",
      "canvas_content_version_members",
      "canvas_content_heads",
      "canvas_content_journal",
      "canvas_workspace_publish_operations"
    ].map((table) => [table, fixture.database.prepare(`SELECT * FROM ${table}`).all()])
  );
}

const collisions = [
  ["prompt-parent", "nodes/T-001/prompt.md", "nodes/T-001/prompt.md/child.md"],
  ["reverse-owner-order", "nodes/T-001/prompt.md/child.md", "nodes/T-001/prompt.md"],
  ["nested-descendant", "nodes/T-001/prompt.md", "nodes/T-001/prompt.md/a/b/child.md"],
  ["normalized-alias", "nodes/T-001/./prompt.md", "nodes/T-001/blocks/../prompt.md/child.md"],
  ["manifest-parent", "nodes/T-001/prompt.md", "manifest.json/child.md"],
  ["normalized-manifest-parent", "nodes/T-001/prompt.md", "nodes/../manifest.json/child.md"],
  ["case-alias", "shared/prompt.md", "shared/PROMPT.md"],
  ["case-parent", "shared/prompt.md", "shared/PROMPT.md/child.md"],
  ["case-reverse-parent", "shared/PROMPT.md/child.md", "shared/prompt.md"],
  ["case-directory-alias", "SHARED/prompt.md", "shared/prompt.md"],
  ["case-manifest-parent", "nodes/T-001/prompt.md", "MANIFEST.JSON/child.md"]
] as const;

describe("physical package file namespace publication", () => {
  it.each(
    collisions
  )("rejects %s before creating any durable publication", async (name, first, second) => {
    const fixture = await canvasCommandServiceFixture({
      manifest: basicManifest({ includeSecondTask: true })
    });
    const content = explicitContent(fixture, first, second);
    const before = persistedRows(fixture);
    expect(() =>
      fixture.contentVersions.persistImmutable({
        scope,
        content,
        createdBy: { kind: "human", id: "owner" }
      })
    ).toThrow("content_version_semantic_validation_failed");
    expect(persistedRows(fixture)).toEqual(before);
    const result = publisher(fixture).publishWorkspaceCanvas(actor("owner"), "p", {
      operationId: `namespace-${name}`,
      localSource: { localProjectId: "local-namespace", localCanvasId: name },
      content
    });
    expect(result).toMatchObject({
      outcome: "rejected",
      reason: "content_verification_failed",
      retryable: false,
      scope: null
    });
    expect(persistedRows(fixture)).toEqual(before);
  });

  it.each(
    collisions
  )("rejects %s at wire, runtime, replica and snapshot boundaries without file writes", async (_name, first, second) => {
    const fixture = await canvasCommandServiceFixture({
      manifest: basicManifest({ includeSecondTask: true })
    });
    const content = explicitContent(fixture, first, second);
    const manifestMember = content.members.find((item) => item.kind === "manifest")!;
    const manifest = JSON.parse(manifestMember.content);
    const prompts = content.members.filter(
      (item) => item.kind === "task_prompt" || item.kind === "block_prompt"
    );
    const digestManifest = {
      manifest: { digestSha256: manifestMember.digestSha256, sizeBytes: manifestMember.sizeBytes },
      prompts: prompts.map((item) => ({
        path: item.path,
        digest: { digestSha256: item.digestSha256, sizeBytes: item.sizeBytes }
      })),
      totalBytes:
        manifestMember.sizeBytes + prompts.reduce((total, item) => total + item.sizeBytes, 0)
    };
    const workspace = fixture.workspace.init.workspace;
    const beforeManifest = await readFile(workspace.manifestFile);
    const beforePrompt = await readFile(join(workspace.packageDir, "nodes/T-001/prompt.md"));
    const error = /package_file_namespace_conflict/;
    expect(() => completeContentVersionSchema.parse(content)).toThrow(error);
    expect(() => validateAuthoritativeCanvasContent(content)).toThrow(error);
    expect(() =>
      parseCanvasReplicaDocument({
        schemaVersion: "canvas-replica-document/v1",
        manifest,
        promptMarkdownByPath: Object.fromEntries(prompts.map((item) => [item.path, item.content])),
        layout: JSON.parse(content.members.find((item) => item.kind === "desktop_layout")!.content)
      })
    ).toThrow(error);
    const document = decodeCanvasReplicaDocument(
      fixture.contentVersions.readVersion(scope, fixture.contentVersions.head(scope)!.content)
        .content
    );
    expect(() =>
      encodeCanvasReplicaDocument({
        ...document,
        manifest,
        promptMarkdownByPath: Object.fromEntries(prompts.map((item) => [item.path, item.content]))
      })
    ).toThrow(error);
    expect(() => packageSnapshotDigestManifestSchema.parse(digestManifest)).toThrow(error);
    await expect(
      materializeAuthoritativeCanvasWorkspace({ workspace, authorityProjectId: "p", content })
    ).rejects.toThrow(error);
    await expect(
      restorePackageSnapshot({
        projectRoot: workspace,
        snapshot: {
          sourceRevision: `snapshot:${hash(JSON.stringify(digestManifest))}`,
          digestManifest,
          files: content.members
            .filter((item) => item.kind !== "desktop_layout")
            .map(({ path, content, digestSha256, sizeBytes }) => ({
              path,
              content,
              digestSha256,
              sizeBytes
            }))
        }
      })
    ).rejects.toThrow(error);
    expect(await readFile(workspace.manifestFile)).toEqual(beforeManifest);
    expect(await readFile(join(workspace.packageDir, "nodes/T-001/prompt.md"))).toEqual(
      beforePrompt
    );
  });

  it.each([
    ["sibling-prefix", "nodes/custom/prompt.md", "nodes/custom/prompt.md-sibling/child.md"],
    ["directory-case", "SHARED/first.md", "shared/second.md"],
    ["layout-label-parent", "desktop/layout.json/child.md", "desktop/layout.json-sibling.md"],
    ["layout-label-descendant", "desktop.md", "desktop/layout.json/child.md"]
  ])("publishes and materializes legal %s without treating the external layout label as a package file", async (name, first, second) => {
    const fixture = await canvasCommandServiceFixture({
      manifest: basicManifest({ includeSecondTask: true })
    });
    const content = explicitContent(fixture, first!, second!);
    const result = publisher(fixture).publishWorkspaceCanvas(actor("owner"), "p", {
      operationId: `namespace-valid-${name}`,
      localSource: { localProjectId: "local-namespace", localCanvasId: name },
      content
    });
    expect(result.outcome).toBe("published");
    if (result.outcome === "rejected") throw new Error(result.detail);
    expect(fixture.contentVersions.readVersion(result.scope, result.content).content).toEqual(
      content
    );
    const workspace = fixture.workspace.init.workspace;
    await materializeAuthoritativeCanvasWorkspace({ workspace, authorityProjectId: "p", content });
    expect(await readFile(join(workspace.packageDir, first!), "utf8")).toBe(
      "# First explicit Prompt\r\n"
    );
    expect(await readFile(join(workspace.packageDir, second!), "utf8")).toBe(
      "# Second explicit Prompt\r\n"
    );
    expect(relative(workspace.packageDir, layoutPathForWorkspace(workspace)).startsWith("..")).toBe(
      true
    );
    expect(JSON.parse(await readFile(layoutPathForWorkspace(workspace), "utf8"))).toEqual({
      ...JSON.parse(content.members.find((item) => item.kind === "desktop_layout")!.content),
      projectId: workspace.id
    });
    expect(
      (await captureAuthorizedCanvasContent({ projectRoot: workspace, authorityProjectId: "p" }))
        .content
    ).toEqual(content);
  });
});
