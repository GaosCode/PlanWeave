import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAuthorizedCanvasContent } from "../desktop/authorizedCanvasContent.js";
import { materializeAuthoritativeCanvasWorkspace } from "../desktop/contentVersionMaterializer.js";
import { layoutPathForWorkspace, saveDesktopLayoutDirect } from "../desktop/layoutStore.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(writeFile).mockImplementation(realFs.writeFile);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("authoritative staging integrity", () => {
  it.for([
    "missing",
    "extra",
    "case-alias-extra",
    "wrong-body",
    "changed-manifest"
  ] as const)("rejects %s on the real staging filesystem before replacing package or layout", async (change, context) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    if (change === "case-alias-extra") {
      await writeFile(join(fixture.root, "probe.md"), "# case capability\n");
      const upper = await stat(join(fixture.root, "PROBE.md")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      );
      if (upper) context.skip("Requires distinct case-sensitive filesystem addresses");
    }
    const workspace = fixture.init.workspace;
    const authority = await captureAuthorizedCanvasContent({ projectRoot: workspace });
    await saveDesktopLayoutDirect(
      workspace,
      JSON.parse(
        authority.content.members.find((member) => member.kind === "desktop_layout")!.content
      )
    );
    const promptPath = join(workspace.packageDir, "nodes/T-001/prompt.md");
    await writeFile(promptPath, "# Preserve local divergent bytes\r\n");
    const resultPath = join(workspace.resultsDir, "preserved.json");
    await writeFile(resultPath, '{"preserved":true}\n');
    const before = await captureAuthorizedCanvasContent({ projectRoot: workspace });
    const paths = [
      workspace.manifestFile,
      layoutPathForWorkspace(workspace),
      workspace.stateFile,
      resultPath
    ];
    const bytes = await Promise.all(paths.map((path) => readFile(path)));
    const identities = await Promise.all(
      [workspace.packageDir, ...paths].map((path) => stat(path))
    );
    let corrupted = false;
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      await realFs.writeFile(...args);
      const path = String(args[0]);
      if (
        corrupted ||
        !path.includes(".planweave-content-version-") ||
        !path.replaceAll("\\", "/").endsWith("nodes/T-001/prompt.md")
      )
        return;
      corrupted = true;
      if (change === "missing") await realFs.unlink(path);
      if (change === "extra")
        await realFs.writeFile(join(dirname(path), "unreferenced.md"), "# Unexpected\n");
      if (change === "case-alias-extra")
        await realFs.writeFile(join(dirname(path), "PROMPT.md"), args[1]);
      if (change === "wrong-body") await realFs.writeFile(path, "# Incorrect staging bytes\n");
      if (change === "changed-manifest") {
        const manifestPath = join(dirname(dirname(dirname(path))), "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        manifest.project.title = "Unexpected staged manifest";
        await realFs.writeFile(manifestPath, JSON.stringify(manifest));
      }
    });
    const replace = vi.spyOn(ImportTransaction.prototype, "replacePath");

    await expect(
      materializeAuthoritativeCanvasWorkspace({ workspace, content: authority.content })
    ).rejects.toThrow();

    expect(corrupted).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(bytes);
    const afterIdentities = await Promise.all(
      [workspace.packageDir, ...paths].map((path) => stat(path))
    );
    expect(afterIdentities.map(({ ino, dev }) => ({ ino, dev }))).toEqual(
      identities.map(({ ino, dev }) => ({ ino, dev }))
    );
    expect((await captureAuthorizedCanvasContent({ projectRoot: workspace })).content).toEqual(
      before.content
    );
    expect(
      (await readdir(dirname(workspace.packageDir))).filter((path) =>
        path.startsWith(".planweave-content-version-")
      )
    ).toEqual([]);
  });

  it("probes case aliases and rejects both addresses without losing the original package", async (context) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const workspace = fixture.init.workspace;
    const probe = join(fixture.root, "probe.md");
    await writeFile(probe, "# case capability\n");
    const upper = await stat(join(fixture.root, "PROBE.md")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    );
    if (!upper || upper.ino !== (await stat(probe)).ino) {
      context.skip(true, "Requires a filesystem where case aliases identify the same inode");
    }
    const before = await captureAuthorizedCanvasContent({ projectRoot: workspace });
    const manifest = JSON.parse(await readFile(workspace.manifestFile, "utf8"));
    manifest.nodes[0].prompt = "shared/prompt.md";
    manifest.nodes[0].blocks[0].prompt = "shared/PROMPT.md";
    const shared = join(workspace.packageDir, "shared");
    await mkdir(shared);
    await writeFile(join(shared, "prompt.md"), "# first\n");
    await writeFile(join(shared, "PROMPT.md"), "# second\n");
    expect((await stat(join(shared, "prompt.md"))).ino).toBe(
      (await stat(join(shared, "PROMPT.md"))).ino
    );
    await writeFile(workspace.manifestFile, JSON.stringify(manifest));
    await expect(captureAuthorizedCanvasContent({ projectRoot: workspace })).rejects.toThrow(
      "package_file_namespace_conflict"
    );
    await materializeAuthoritativeCanvasWorkspace({ workspace, content: before.content });
    expect((await captureAuthorizedCanvasContent({ projectRoot: workspace })).content).toEqual(
      before.content
    );
  });
});
