import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as canvasApi from "../desktop/canvasApi.js";
import { selectTaskCanvas } from "../desktop/canvasSelectionApi.js";
import { writeJsonFile } from "../json.js";
import { ImportTransaction } from "../package/importTransaction.js";
import {
  applyPackageDraftImport,
  previewPackageDraftImport
} from "../package/packageDraftImport.js";
import { createEmptyState } from "../state.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path, `${key}/`);
      else entries[key] = (await readFile(path)).toString("base64");
    }
  }
  await walk(root, "");
  return entries;
}

async function twoCanvasFixture() {
  const { home, root, init } = await createTestWorkspace();
  roots.push(home, root);
  const second = await canvasApi.createTaskCanvas(root, { name: "Untouched B" });
  const a = await canvasApi.resolveTaskCanvasWorkspace(root, "default");
  const b = await canvasApi.resolveTaskCanvasWorkspace(root, second.canvasId);
  for (const [workspace, marker] of [
    [a, "A"],
    [b, "B"]
  ] as const) {
    await writeFile(
      join(workspace.packageDir, "sentinel.bin"),
      Buffer.from([0, 255, marker.charCodeAt(0)])
    );
    await writeJsonFile(workspace.stateFile, { ...createEmptyState(), marker });
    await mkdir(join(workspace.resultsDir, "nested"), { recursive: true });
    await writeFile(
      join(workspace.resultsDir, "nested", "sentinel.bin"),
      Buffer.from([254, 0, marker.charCodeAt(0)])
    );
  }
  await selectTaskCanvas(root, "default");
  const draft = await mkdtemp(join(tmpdir(), "planweave-scope-draft-"));
  roots.push(draft);
  const manifest = basicManifest();
  manifest.project.title = "Imported into A";
  await writeJsonFile(join(draft, "manifest.json"), manifest);
  await writePromptFiles(draft, manifest);
  return { root, init, draft, a, b, secondId: second.canvasId };
}

function switchAfterResolution(root: string, secondId: string) {
  const resolveWorkspace = canvasApi.resolveTaskCanvasWorkspace;
  vi.spyOn(canvasApi, "resolveTaskCanvasWorkspace").mockImplementationOnce(async (...args) => {
    const workspace = await resolveWorkspace(...args);
    await selectTaskCanvas(root, secondId);
    return workspace;
  });
}

describe("package import target scope", () => {
  it.each([
    "omitted",
    "null",
    "explicit"
  ] as const)("keeps the first %s target across active selection changes", async (mode) => {
    const f = await twoCanvasFixture();
    const bBefore = await snapshot(join(f.b.packageDir, ".."));
    switchAfterResolution(f.root, f.secondId);
    const result = await applyPackageDraftImport({
      projectRoot: f.root,
      draftRoot: f.draft,
      ...(mode === "omitted" ? {} : { canvasId: mode === "null" ? null : "default" })
    });
    expect(result).toMatchObject({ ok: true, applied: true, target: { canvasId: "default" } });
    expect(JSON.parse(await readFile(f.a.manifestFile, "utf8")).project.title).toBe(
      "Imported into A"
    );
    expect(await readFile(f.a.stateFile, "utf8")).toBe(
      `${JSON.stringify(createEmptyState(), null, 2)}\n`
    );
    expect(await readdir(f.a.resultsDir)).toEqual([]);
    expect(await readdir(f.a.packageDir)).not.toContain("sentinel.bin");
    expect(await snapshot(join(f.b.packageDir, ".."))).toEqual(bBefore);
    expect((await canvasApi.resolveTaskCanvasWorkspace(f.root)).packageDir).toBe(f.b.packageDir);
  });

  it("preview is read-only and unknown targets fail without touching either canvas", async () => {
    const f = await twoCanvasFixture();
    const before = await snapshot(join(f.init.workspace.workspaceRoot, "canvases"));
    expect(
      await previewPackageDraftImport({ projectRoot: f.root, draftRoot: f.draft, canvasId: null })
    ).toMatchObject({ target: { canvasId: "default" }, ok: true });
    await expect(
      applyPackageDraftImport({ projectRoot: f.root, draftRoot: f.draft, canvasId: "missing" })
    ).rejects.toThrow("Project has no task canvas");
    expect(await snapshot(join(f.init.workspace.workspaceRoot, "canvases"))).toEqual(before);
  });

  it("rolls back the fixed canvas after a transaction failure while leaving the new active canvas untouched", async () => {
    const f = await twoCanvasFixture();
    const before = await snapshot(join(f.init.workspace.workspaceRoot, "canvases"));
    switchAfterResolution(f.root, f.secondId);
    const replace = ImportTransaction.prototype.replacePath;
    vi.spyOn(ImportTransaction.prototype, "replacePath").mockImplementation(async function (
      this: ImportTransaction,
      target,
      staged
    ) {
      if (target === f.a.stateFile) throw new Error("state write rejected");
      return replace.call(this, target, staged);
    });
    await expect(
      applyPackageDraftImport({ projectRoot: f.root, draftRoot: f.draft })
    ).rejects.toThrow("state write rejected");
    expect(await snapshot(join(f.init.workspace.workspaceRoot, "canvases"))).toEqual(before);
  });
});
