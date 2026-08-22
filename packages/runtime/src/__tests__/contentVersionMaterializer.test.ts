import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema,
  contentVersionDesktopLayoutMemberPath,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  capturePackageSnapshot,
  createManagedProjectFromAuthoritativeContent,
  getDesktopLayout,
  listProjects,
  materializeAuthoritativeCanvasContent,
  resolveTaskCanvasWorkspace,
  saveDesktopLayout
} from "../index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { resolveStagedContentVersionLayoutPath } from "../desktop/contentVersionMaterializer.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettingsFile = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettingsFile === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettingsFile;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function withRecomputedContent(
  content: CompleteContentVersion,
  change: (members: CompleteContentVersion["members"]) => CompleteContentVersion["members"]
): CompleteContentVersion {
  const members = change(content.members)
    .map((member) => ({
      ...member,
      digestSha256: sha256(member.content),
      sizeBytes: Buffer.byteLength(member.content, "utf8")
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = members.reduce((total, member) => total + member.sizeBytes, 0);
  const provisional = { members, totalBytes, canonicalDigest: "0".repeat(64) };
  return completeContentVersionSchema.parse({
    ...provisional,
    canonicalDigest: sha256(canonicalContentVersionDigestPayload(provisional))
  });
}

async function contentFromWorkspace(projectRoot: string): Promise<CompleteContentVersion> {
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, "default");
  const snapshot = await capturePackageSnapshot({ projectRoot, canvasId: "default" });
  const layout = await getDesktopLayout(workspace);
  const members = [
    ...snapshot.snapshot.files.map((file) => ({
      kind:
        file.path === "manifest.json"
          ? ("manifest" as const)
          : file.path.includes("/blocks/")
            ? ("block_prompt" as const)
            : ("task_prompt" as const),
      path: file.path,
      content: file.content,
      digestSha256: file.digestSha256,
      sizeBytes: file.sizeBytes
    })),
    {
      kind: "desktop_layout" as const,
      path: contentVersionDesktopLayoutMemberPath,
      content: `${JSON.stringify(layout, null, 2)}\n`,
      digestSha256: "",
      sizeBytes: 0
    }
  ]
    .map((member) =>
      member.kind === "desktop_layout"
        ? {
            ...member,
            digestSha256: sha256(member.content),
            sizeBytes: Buffer.byteLength(member.content, "utf8")
          }
        : member
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = members.reduce((total, member) => total + member.sizeBytes, 0);
  const provisional = { members, totalBytes, canonicalDigest: "0".repeat(64) };
  return completeContentVersionSchema.parse({
    ...provisional,
    canonicalDigest: sha256(canonicalContentVersionDigestPayload(provisional))
  });
}

describe("authoritative content materializer", () => {
  it("keeps a Windows staging layout beside the package instead of nesting the absolute path", () => {
    const staging =
      "C:\\Users\\24385\\.planweave\\projects\\tiny-notes-agent-board-9cd37a11\\canvases\\default\\.planweave-content-version-z9qklC";

    expect(resolveStagedContentVersionLayoutPath(staging, win32)).toBe(
      "C:\\Users\\24385\\.planweave\\projects\\tiny-notes-agent-board-9cd37a11\\canvases\\default\\.planweave-content-version-z9qklC.layout.json"
    );
  });

  it("creates a managed local project from a remote authority without requiring a local canvas", async () => {
    const authority = await createTestWorkspace();
    directories.push(authority.home, authority.root);
    const content = await contentFromWorkspace(authority.root);

    const created = await createManagedProjectFromAuthoritativeContent({
      authorityProjectId: authority.init.workspace.id,
      content
    });

    expect(created.project.projectId).not.toBe(authority.init.workspace.id);
    expect(created.canvasId).toBe("default");
    expect(await listProjects()).toContainEqual(
      expect.objectContaining({
        projectId: created.project.projectId,
        activeCanvasId: "default"
      })
    );
    await expect(getDesktopLayout(created.project.rootPath)).resolves.toMatchObject({
      projectId: created.project.projectId
    });
    const localCanvas = await resolveTaskCanvasWorkspace(created.project.rootPath, "default");
    await expect(readdir(localCanvas.resultsDir)).resolves.toEqual([]);
    await expect(readFile(localCanvas.stateFile, "utf8")).resolves.toContain('"tasks"');
    expect(created.lineage).toBeNull();
  });

  it("forks a new local identity with empty runtime and read-only lineage", async () => {
    const authority = await createTestWorkspace();
    directories.push(authority.home, authority.root);
    const content = await contentFromWorkspace(authority.root);
    const digest = content.canonicalDigest;

    const created = await createManagedProjectFromAuthoritativeContent({
      authorityProjectId: authority.init.workspace.id,
      content,
      importMode: "fork",
      sourceLineage: {
        scope: {
          workspaceId: "workspace-source",
          projectId: "project-source",
          canvasId: "canvas-source"
        },
        revision: 3,
        content: {
          versionId: `version-${digest}`,
          canonicalDigest: digest,
          verification: "complete"
        }
      }
    });

    expect(created.project.projectId).not.toBe(authority.init.workspace.id);
    expect(created.canvasId).toBe("default");
    expect(created.lineage).toMatchObject({
      schemaVersion: "workspace-fork-lineage/v1",
      writeback: false,
      source: {
        scope: {
          workspaceId: "workspace-source",
          projectId: "project-source",
          canvasId: "canvas-source"
        },
        revision: 3
      }
    });
    const lineageFile = await readFile(
      join(created.project.rootPath, "workspace-fork-lineage.json"),
      "utf8"
    );
    expect(JSON.parse(lineageFile)).toEqual(created.lineage);
    const localCanvas = await resolveTaskCanvasWorkspace(created.project.rootPath, "default");
    await expect(readdir(localCanvas.resultsDir)).resolves.toEqual([]);
    const state = JSON.parse(await readFile(localCanvas.stateFile, "utf8")) as {
      tasks: Record<string, unknown>;
      blocks: Record<string, unknown>;
    };
    expect(state.tasks).toEqual({});
    expect(state.blocks).toEqual({});
    await expect(
      createManagedProjectFromAuthoritativeContent({
        authorityProjectId: authority.init.workspace.id,
        content,
        importMode: "fork"
      })
    ).rejects.toThrow("content_fork_source_lineage_required");
  });

  it("removes only the newly created project when authoritative materialization fails", async () => {
    const authority = await createTestWorkspace();
    directories.push(authority.home, authority.root);
    const content = await contentFromWorkspace(authority.root);
    const malformed = withRecomputedContent(content, (members) =>
      members.map((member) =>
        member.path === contentVersionDesktopLayoutMemberPath
          ? {
              ...member,
              content: JSON.stringify({
                version: "desktop-layout/v1",
                projectId: "wrong",
                nodes: [],
                updatedAt: "2026-08-01T00:00:00.000Z"
              })
            }
          : member
      )
    );
    const before = await listProjects();

    await expect(
      createManagedProjectFromAuthoritativeContent({
        authorityProjectId: authority.init.workspace.id,
        content: malformed
      })
    ).rejects.toThrow("content_version_layout_invalid");

    expect(await listProjects()).toEqual(before);
  });

  it("replaces package and logical layout together after validating the authoritative digest", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    await saveDesktopLayout(workspace.root, {
      version: "desktop-layout/v1",
      projectId: workspace.init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }],
      updatedAt: "2026-07-28T00:00:00.000Z"
    });
    const authoritative = await contentFromWorkspace(workspace.root);
    const canvas = await resolveTaskCanvasWorkspace(workspace.root, "default");
    const promptPath = join(canvas.packageDir, "nodes", "T-001", "prompt.md");
    await writeFile(promptPath, "# local divergent prompt\n", "utf8");
    await saveDesktopLayout(workspace.root, {
      version: "desktop-layout/v1",
      projectId: workspace.init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 1, y: 2 }],
      updatedAt: "2026-07-28T00:01:00.000Z"
    });

    await materializeAuthoritativeCanvasContent({
      projectRoot: workspace.root,
      canvasId: "default",
      expectedPackageDir: canvas.packageDir,
      content: authoritative
    });

    await expect(readFile(promptPath, "utf8")).resolves.toBe("# T-001 task prompt\n");
    await expect(getDesktopLayout(workspace.root)).resolves.toMatchObject({
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }]
    });
  });

  it("fails closed on a member digest mismatch without replacing either local artifact", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const canvas = await resolveTaskCanvasWorkspace(workspace.root, "default");
    const promptPath = join(canvas.packageDir, "nodes", "T-001", "prompt.md");
    await writeFile(promptPath, "# preserve this prompt\n", "utf8");
    await saveDesktopLayout(workspace.root, {
      version: "desktop-layout/v1",
      projectId: workspace.init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 9, y: 8 }],
      updatedAt: "2026-07-28T00:02:00.000Z"
    });
    const content = await contentFromWorkspace(workspace.root);
    const members = content.members.map((member) =>
      member.path === "manifest.json" ? { ...member, digestSha256: "0".repeat(64) } : member
    );
    const malformed = completeContentVersionSchema.parse({
      members,
      totalBytes: content.totalBytes,
      canonicalDigest: sha256(
        canonicalContentVersionDigestPayload({
          members,
          totalBytes: content.totalBytes,
          canonicalDigest: "0".repeat(64)
        })
      )
    });

    await expect(
      materializeAuthoritativeCanvasContent({
        projectRoot: workspace.root,
        canvasId: "default",
        content: malformed
      })
    ).rejects.toThrow("content_version_member_digest_mismatch");

    await expect(readFile(promptPath, "utf8")).resolves.toBe("# preserve this prompt\n");
    await expect(getDesktopLayout(workspace.root)).resolves.toMatchObject({
      nodes: [{ nodeId: "T-001", x: 9, y: 8 }]
    });
  });

  it("fails closed before replacement for invalid manifest, prompt set, or layout content", async () => {
    const cases = [
      (content: CompleteContentVersion) =>
        withRecomputedContent(content, (members) =>
          members.map((member) =>
            member.path === "manifest.json" ? { ...member, content: "{}" } : member
          )
        ),
      (content: CompleteContentVersion) =>
        withRecomputedContent(content, (members) =>
          members.filter((member) => member.path !== "nodes/T-001/blocks/B-001.prompt.md")
        ),
      (content: CompleteContentVersion) =>
        withRecomputedContent(content, (members) => [
          ...members,
          {
            kind: "block_prompt" as const,
            path: "nodes/T-001/blocks/B-999.prompt.md",
            content: "# Extra\n",
            digestSha256: "",
            sizeBytes: 0
          }
        ]),
      (content: CompleteContentVersion) =>
        withRecomputedContent(content, (members) =>
          members.map((member) =>
            member.path === contentVersionDesktopLayoutMemberPath
              ? { ...member, content: "{}" }
              : member
          )
        ),
      (content: CompleteContentVersion) => {
        const malformed = structuredClone(content);
        malformed.members[0]!.sizeBytes += 1;
        return malformed;
      }
    ];
    for (const createInvalid of cases) {
      const workspace = await createTestWorkspace();
      directories.push(workspace.home, workspace.root);
      const canvas = await resolveTaskCanvasWorkspace(workspace.root, "default");
      const promptPath = join(canvas.packageDir, "nodes", "T-001", "prompt.md");
      await writeFile(promptPath, "# preserve this prompt\n", "utf8");
      await saveDesktopLayout(workspace.root, {
        version: "desktop-layout/v1",
        projectId: workspace.init.workspace.id,
        nodes: [{ nodeId: "T-001", x: 9, y: 8 }],
        updatedAt: "2026-07-28T00:02:00.000Z"
      });
      const localLayoutPath = join(canvas.workspaceRoot, "desktop", "layout.json");
      const beforeLayout = await readFile(localLayoutPath, "utf8");
      const invalid = createInvalid(await contentFromWorkspace(workspace.root));

      await expect(
        materializeAuthoritativeCanvasContent({
          projectRoot: workspace.root,
          canvasId: "default",
          content: invalid
        })
      ).rejects.toThrow();

      await expect(readFile(promptPath, "utf8")).resolves.toBe("# preserve this prompt\n");
      await expect(readFile(localLayoutPath, "utf8")).resolves.toBe(beforeLayout);
    }
  });
});
