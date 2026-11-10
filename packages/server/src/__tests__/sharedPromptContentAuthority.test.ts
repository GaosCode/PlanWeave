import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canonicalContentVersionDigestPayload,
  compareContentVersionMemberPaths,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  captureAuthorizedCanvasContent,
  decodeCanvasReplicaDocument,
  materializeAuthoritativeCanvasWorkspace,
  projectCanvasReplicaDocument
} from "@planweave-ai/runtime";
import { loadPlanGraphPackage } from "../../../runtime/src/plangraph/index.js";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { openServerDatabase } from "../sqlite.js";
import {
  actor,
  canvasCommandServiceFixture,
  submitBody
} from "./support/canvasCommandServiceFixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const cases = ["custom-task", "task-review", "same-role", "normalized-alias"] as const;

function reseal(content: CompleteContentVersion): CompleteContentVersion {
  const members = [...content.members].sort((left, right) =>
    compareContentVersionMemberPaths(left.path, right.path)
  );
  const provisional = {
    ...content,
    members,
    totalBytes: members.reduce((total, member) => total + member.sizeBytes, 0)
  };
  return {
    ...provisional,
    canonicalDigest: createHash("sha256")
      .update(canonicalContentVersionDigestPayload(provisional))
      .digest("hex")
  };
}

function manifestFor(kind: (typeof cases)[number]) {
  const manifest = basicManifest({ includeSecondTask: true });
  const first = manifest.nodes[0]!;
  const second = manifest.nodes[1]!;
  if (kind === "custom-task") first.prompt = "nodes/T-001/blocks/R002.prompt.md";
  if (kind === "task-review") first.blocks[1]!.prompt = first.prompt;
  if (kind === "same-role") second.prompt = first.prompt;
  if (kind === "normalized-alias") {
    second.prompt = "nodes/T-001/blocks/.././prompt.md";
    first.blocks[1]!.prompt = "nodes/T-001/./prompt.md";
  }
  return manifest;
}

describe("shared Prompt Server content authority", () => {
  it.each(
    cases
  )("captures, persists, reopens, reads and writes %s without losing owners", async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-shared-content-"));
    directories.push(directory);
    const manifest = manifestFor(kind);
    const fixture = await canvasCommandServiceFixture({
      manifest,
      databasePath: join(directory, "server.sqlite")
    });
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const initial = fixture.contentVersions.head(scope)!;
    const content = fixture.contentVersions.readVersion(scope, initial.content).content;
    const manifestBytes = await readFile(fixture.workspace.init.workspace.manifestFile, "utf8");
    expect(content.members.find((member) => member.kind === "manifest")!.content).toBe(
      manifestBytes
    );
    const sharedPath =
      kind === "custom-task" ? "nodes/T-001/blocks/R002.prompt.md" : "nodes/T-001/prompt.md";
    const sourceBytes = await readFile(
      join(fixture.workspace.init.workspace.packageDir, sharedPath),
      "utf8"
    );
    const expectedKind =
      kind === "task-review" || kind === "normalized-alias" ? "shared_prompt" : "task_prompt";
    expect(content.members.find((member) => member.path === sharedPath)).toMatchObject({
      kind: expectedKind,
      content: sourceBytes,
      digestSha256: createHash("sha256").update(sourceBytes).digest("hex")
    });
    expect(content.members.map((member) => member.path)).toHaveLength(
      kind === "normalized-alias" ? 6 : kind === "custom-task" ? 8 : 7
    );
    expect(new Set(content.members.map((member) => member.path)).size).toBe(content.members.length);
    const reopened = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    try {
      expect(
        new ContentVersionRepository(reopened).readVersion(scope, initial.content).content
      ).toEqual(content);
    } finally {
      reopened.close();
    }
    const disk = await loadPlanGraphPackage(fixture.workspace.init.workspace);
    expect([...disk.graph.promptRefs.keys()].sort()).toEqual([
      "T-001",
      "T-001#B-001",
      "T-001#R-001",
      "T-002",
      "T-002#B-001",
      "T-002#R-001"
    ]);
    for (const task of manifest.nodes) {
      expect(disk.graph.tasks.get(task.id)!.promptRef).toMatchObject({
        ownerKind: "task",
        ownerRef: task.id,
        path: task.prompt
      });
      for (const block of task.blocks) {
        const ref = `${task.id}#${block.id}`;
        expect(disk.graph.blocks.get(ref)!.promptRef).toMatchObject({
          ownerKind: "block",
          ownerRef: ref,
          path: block.prompt
        });
      }
    }
    const body = "# 共享正文\r\n精确 UTF-8 bytes\r\n";
    const request = submitBody(`write-${kind}`, 0, {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: body
    });
    expect(await fixture.service.submit(actor("viewer"), request)).toMatchObject({
      type: "canvas.command.rejected",
      code: "forbidden"
    });
    const accepted = await fixture.service.submit(actor("owner"), request);
    expect(accepted).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    expect(await fixture.service.submit(actor("owner"), request)).toMatchObject({
      type: "canvas.command.accepted",
      revision: 1,
      idempotentReplay: true
    });
    expect(
      await fixture.service.submit(actor("editor"), submitBody(`stale-${kind}`, 0))
    ).toMatchObject({ type: "canvas.command.rejected", code: "stale_revision" });
    const head = fixture.contentVersions.head(scope)!;
    const updated = fixture.contentVersions.readVersion(scope, head.content).content;
    expect(updated.members.filter((member) => member.path === sharedPath)).toHaveLength(1);
    expect(updated.members.find((member) => member.path === sharedPath)!.content).toBe(body);
    const replica = decodeCanvasReplicaDocument(updated);
    const projected = projectCanvasReplicaDocument(replica);
    expect(projected.blockPromptMarkdownByRef["T-001#R-001"]).toBe(
      kind === "task-review" || kind === "normalized-alias"
        ? body
        : await readFile(
            join(fixture.workspace.init.workspace.packageDir, manifest.nodes[0]!.blocks[1]!.prompt),
            "utf8"
          )
    );
    await materializeAuthoritativeCanvasWorkspace({
      workspace: fixture.workspace.init.workspace,
      authorityProjectId: "p",
      content: updated
    });
    expect(
      await readFile(join(fixture.workspace.init.workspace.packageDir, sharedPath), "utf8")
    ).toBe(body);
    expect(
      (
        await captureAuthorizedCanvasContent({
          projectRoot: fixture.workspace.init.workspace,
          authorityProjectId: "p"
        })
      ).content
    ).toEqual(updated);
    const reconnect = await fixture.service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 0
    });
    expect(reconnect.type).toBe("canvas.reconnect.snapshot");
    if (kind === "task-review" || kind === "normalized-alias") {
      expect(
        await fixture.service.submit(
          actor("owner"),
          submitBody(`remove-${kind}`, 1, { kind: "remove_block", blockRef: "T-001#R-001" })
        )
      ).toMatchObject({ type: "canvas.command.accepted", revision: 2 });
      const remainingHead = fixture.contentVersions.head(scope)!;
      const remaining = fixture.contentVersions.readVersion(scope, remainingHead.content).content;
      expect(remaining.members.find((member) => member.path === sharedPath)).toMatchObject({
        kind: "task_prompt",
        content: body
      });
      expect(
        projectCanvasReplicaDocument(decodeCanvasReplicaDocument(remaining))
          .blockPromptMarkdownByRef
      ).not.toHaveProperty("T-001#R-001");
    }
  });

  it.each([
    "../outside.md",
    "/tmp/outside.md",
    "nodes\\escape.md",
    "manifest.json",
    "desktop/layout.json"
  ])("rejects unsafe Prompt identity %s at capture", async (path) => {
    const fixture = await canvasCommandServiceFixture();
    const manifest = basicManifest();
    manifest.nodes[0]!.prompt = path;
    await writeFile(fixture.workspace.init.workspace.manifestFile, JSON.stringify(manifest));
    await expect(
      captureAuthorizedCanvasContent({ projectRoot: fixture.workspace.init.workspace })
    ).rejects.toThrow();
  });

  it("rejects an outside symlink while keeping the previous authoritative head", async () => {
    const fixture = await canvasCommandServiceFixture();
    const path = join(fixture.workspace.init.workspace.packageDir, "nodes/T-001/prompt.md");
    const outside = join(fixture.workspace.home, "outside.md");
    await writeFile(outside, "# private bytes\n");
    await rm(path);
    await symlink(outside, path);
    await expect(
      captureAuthorizedCanvasContent({ projectRoot: fixture.workspace.init.workspace })
    ).rejects.toThrow("must stay inside");
    expect(
      fixture.contentVersions.head({ workspaceId: "w", projectId: "p", canvasId: "default" })!
        .revision
    ).toBe(1);
  });

  it.each([
    "missing",
    "extra",
    "wrong-role"
  ])("rejects a correctly hashed %s Prompt set", async (change) => {
    const fixture = await canvasCommandServiceFixture({ manifest: manifestFor("task-review") });
    const captured = (
      await captureAuthorizedCanvasContent({
        projectRoot: fixture.workspace.init.workspace,
        authorityProjectId: "p"
      })
    ).content;
    const shared = captured.members.find((member) => member.kind === "shared_prompt")!;
    const members =
      change === "missing"
        ? captured.members.filter((member) => member !== shared)
        : change === "extra"
          ? [...captured.members, { ...shared, path: "nodes/extra.md" }]
          : captured.members.map((member) =>
              member === shared ? { ...member, kind: "task_prompt" as const } : member
            );
    expect(() => fixture.contentVersions.verify(reseal({ ...captured, members }))).toThrow(
      "content_version_prompt_set_mismatch"
    );
  });

  it("captures safe symlinks as separate semantic file addresses without promising online link identity", async () => {
    const fixture = await canvasCommandServiceFixture();
    const workspace = fixture.workspace.init.workspace;
    const manifest = basicManifest();
    const taskPath = join(workspace.packageDir, manifest.nodes[0]!.prompt);
    const reviewPath = join(workspace.packageDir, manifest.nodes[0]!.blocks[1]!.prompt);
    await rm(reviewPath);
    await symlink("../prompt.md", reviewPath);
    const captured = await captureAuthorizedCanvasContent({
      projectRoot: workspace,
      authorityProjectId: "p"
    });
    const original = await readFile(taskPath, "utf8");
    expect(captured.content.members.filter((member) => member.content === original)).toHaveLength(
      2
    );
    await materializeAuthoritativeCanvasWorkspace({
      workspace,
      authorityProjectId: "p",
      content: captured.content
    });
    await writeFile(taskPath, "# changed separate address\n");
    expect(await readFile(reviewPath, "utf8")).toBe(original);
    expect(
      (
        await captureAuthorizedCanvasContent({ projectRoot: workspace, authorityProjectId: "p" })
      ).content.members.find((member) => member.path === manifest.nodes[0]!.blocks[1]!.prompt)!
        .content
    ).toBe(original);
  });
});
