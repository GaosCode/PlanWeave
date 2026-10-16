import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectWorkspace } from "../project.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDefaultCanvasWorkspaceMigration,
  detectDefaultCanvasWorkspaceMigration
} from "../projectGraph/defaultCanvasWorkspaceMigration.js";
import {
  loadProjectGraph,
  projectGraphPath,
  writeProjectGraph
} from "../projectGraph/loadProjectGraph.js";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { validatePackage } from "../validatePackage.js";
import { writeJsonFile } from "../json.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { customDefaultCanvasMigrationFixture } from "./customDefaultCanvasMigrationFixture.js";
import { runtimeGateway } from "../../../mcp/src/toolRuntime.js";
import { handlePlanweaveTool } from "../../../mcp/src/tools.js";
import { readJson } from "../../../mcp/src/__tests__/toolTestHelpers.js";

vi.mock("@planweave-ai/runtime", () => import("../index.js"));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, cp: vi.fn(actual.cp), readFile: vi.fn(actual.readFile) };
});
let actualFs: typeof import("node:fs/promises");
beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(cp).mockImplementation(actualFs.cp);
  vi.mocked(readFile).mockImplementation(actualFs.readFile);
});
afterEach(() => vi.restoreAllMocks());

describe("registered default canvas migration", () => {
  it("detects no migration before init without creating a workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-custom-migration-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-custom-migration-project-"));
    process.env.PLANWEAVE_HOME = home;
    const workspace = await resolveProjectWorkspace(root);
    expect((await detectDefaultCanvasWorkspaceMigration(workspace)).action).toBe("none");
    await expect(access(workspace.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { absolute: false, residue: false },
    { absolute: false, residue: true },
    { absolute: true, residue: false },
    { absolute: true, residue: true }
  ])("preserves execution and history for $absolute absolute paths and $residue root residue", async ({
    absolute,
    residue
  }) => {
    const f = await customDefaultCanvasMigrationFixture(absolute, residue);
    expect(f.expected).toMatchObject({ currentRefs: ["T-001#R-001"] });
    expect(f.state.blocks["T-001#B-001"].status).toBe("completed");
    const plan = await detectDefaultCanvasWorkspaceMigration(f.init.workspace);
    expect.soft(plan).toMatchObject({ action: "migrate", legacyPaths: f.sourcePaths });
    const result = await applyDefaultCanvasWorkspaceMigration(f.init.workspace);
    expect.soft(result.legacyPaths).toMatchObject(f.sourcePaths);
    const moved = await resolveTaskCanvasWorkspace(f.root, "default");
    expect(await readFile(moved.stateFile, "utf8")).toBe(f.sourceStateBytes);
    expect(await readFile(join(moved.resultsDir, f.reportRelativePath), "utf8")).toBe(f.report);
    const status = readJson(
      await handlePlanweaveTool("get_status", { projectId: f.init.project.id }, runtimeGateway)
    );
    expect(status).toMatchObject({
      currentRefs: ["T-001#R-001"],
      blocks: expect.arrayContaining([
        expect.objectContaining({ ref: "T-001#B-001", status: "completed" })
      ])
    });
    expect(
      readJson(
        await handlePlanweaveTool(
          "list_ready_blocks",
          { projectId: f.init.project.id },
          runtimeGateway
        )
      )
    ).toMatchObject({
      readyBlocks: [expect.objectContaining({ ref: "T-002#B-001", canvasId: "default" })]
    });
    expect(
      await runtimeGateway.getBlockDetail(f.init.project.id, "T-001#B-001", "default")
    ).toMatchObject({ status: "completed", latestRunId: "RUN-001" });
    expect(
      (await runtimeGateway.getPrompt(f.init.project.id, "default", "T-001#R-001")).markdown
    ).toContain(f.report.trim());
    expect((await loadProjectGraph(f.root)).manifest.canvases[0]).toMatchObject({
      stateFile: "canvases/default/state.json",
      resultsDir: "canvases/default/results"
    });
    for (const path of [
      f.sourcePaths.packageDir,
      f.sourcePaths.stateFile,
      f.sourcePaths.resultsDir
    ])
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(result.legacyBackupPaths.resultsDir!, f.reportRelativePath), "utf8")
    ).toBe(f.report);
    if (residue) {
      expect(await readFile(join(f.init.workspace.workspaceRoot, "state.json"), "utf8")).not.toBe(
        f.sourceStateBytes
      );
      expect(
        await readFile(join(f.init.workspace.workspaceRoot, "results", "unrelated.txt"), "utf8")
      ).toBe("Root residue");
    }
  });

  it.each([
    false,
    true
  ])("validates the registered state rather than valid root residue (absolute=%s)", async (absolute) => {
    const f = await customDefaultCanvasMigrationFixture(absolute, true);
    await writeJsonFile(f.sourcePaths.stateFile, { currentRefs: "invalid" });
    const validation = await validatePackage({ projectRoot: f.root });
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContainEqual(
      expect.objectContaining({ code: "state_read_failed", path: "legacy-state/runtime.json" })
    );
    await expect(access(projectGraphPath(f.init.workspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it.each([
    "invalid",
    "missing",
    "read"
  ] as const)("rejects %s canonical manifests without a traditional root package anchor", async (failure) => {
    const f = await customDefaultCanvasMigrationFixture();
    await applyDefaultCanvasWorkspaceMigration(f.init.workspace);
    const graphBefore = await readFile(projectGraphPath(f.init.workspace), "utf8");
    const manifestPath = join(f.init.workspace.packageDir, "manifest.json");
    if (failure === "invalid") await writeJsonFile(manifestPath, { version: "invalid" });
    if (failure === "missing") await rm(manifestPath);
    if (failure === "read")
      vi.mocked(readFile).mockImplementation(async (path, options) => {
        if (path === manifestPath)
          throw Object.assign(new Error("canonical read failed"), { code: "EIO" });
        return actualFs.readFile(path, options);
      });
    await expect(detectDefaultCanvasWorkspaceMigration(f.init.workspace)).rejects.toThrow();
    await expect(applyDefaultCanvasWorkspaceMigration(f.init.workspace)).rejects.toThrow();
    expect(await readFile(projectGraphPath(f.init.workspace), "utf8")).toBe(graphBefore);
    expect(await readFile(f.init.workspace.stateFile, "utf8")).toBe(f.sourceStateBytes);
    expect(await readFile(join(f.init.workspace.resultsDir, f.reportRelativePath), "utf8")).toBe(
      f.report
    );
  });

  it.each([
    "read",
    "copy",
    "incomplete-copy",
    "verify"
  ] as const)("does not publish or quarantine after a registered-storage %s failure", async (failure) => {
    const f = await customDefaultCanvasMigrationFixture();
    const canonical = f.init.workspace;
    if (failure === "copy" || failure === "incomplete-copy") {
      vi.mocked(cp).mockImplementation(async (source, target, options) => {
        if (source === f.sourcePaths.resultsDir) {
          if (failure === "incomplete-copy") return;
          throw new Error("registered copy failed");
        }
        return actualFs.cp(source, target, options);
      });
    } else {
      vi.mocked(readFile).mockImplementation(async (path, options) => {
        if (path === (failure === "read" ? f.sourcePaths.stateFile : canonical.stateFile))
          throw new Error(`registered ${failure} failed`);
        return actualFs.readFile(path, options);
      });
    }
    await expect(applyDefaultCanvasWorkspaceMigration(canonical)).rejects.toThrow(
      failure === "incomplete-copy" ? "storage verification failed" : `registered ${failure} failed`
    );
    await expect(access(projectGraphPath(canonical))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(canonical.workspaceRoot, "migration-quarantine"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await actualFs.readFile(f.sourcePaths.stateFile, "utf8")).toBe(f.sourceStateBytes);
    expect(
      await actualFs.readFile(join(f.sourcePaths.resultsDir, f.reportRelativePath), "utf8")
    ).toBe(f.report);
  });

  it("refuses conflicting canonical history before changing either source", async () => {
    const f = await customDefaultCanvasMigrationFixture();
    await cp(f.sourcePaths.packageDir, f.init.workspace.packageDir, { recursive: true });
    await cp(f.sourcePaths.stateFile, f.init.workspace.stateFile);
    await mkdir(f.init.workspace.resultsDir, { recursive: true });
    await writeFile(join(f.init.workspace.resultsDir, "different.txt"), "Canonical conflict");
    await expect(applyDefaultCanvasWorkspaceMigration(f.init.workspace)).rejects.toThrow(
      "default_canvas_legacy_root_conflict"
    );
    expect(await readFile(join(f.init.workspace.resultsDir, "different.txt"), "utf8")).toBe(
      "Canonical conflict"
    );
    expect(await readFile(f.sourcePaths.stateFile, "utf8")).toBe(f.sourceStateBytes);
    await expect(access(projectGraphPath(f.init.workspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("preflights an actual registered results import before copying or publishing", async () => {
    const f = await customDefaultCanvasMigrationFixture();
    const staged = join(f.home, "staged-results");
    await cp(f.sourcePaths.resultsDir, staged, { recursive: true });
    const tx = await ImportTransaction.create({
      workspaceRoot: f.init.workspace.workspaceRoot,
      transactionId: "custom-default-results"
    });
    await tx.replacePath(f.sourcePaths.resultsDir, staged);
    try {
      await expect(applyDefaultCanvasWorkspaceMigration(f.init.workspace)).rejects.toThrow(
        "write conflict"
      );
      await expect(access(f.init.workspace.packageDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(projectGraphPath(f.init.workspace))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await tx.rollback();
    }
  });

  it.each([
    "outside",
    "symlink",
    "nested-symlink",
    "overlap",
    "partial-canonical",
    "other-canvas"
  ] as const)("rejects unsafe %s registered storage before any migration write", async (kind) => {
    const f = await customDefaultCanvasMigrationFixture();
    const record = f.registry.canvases[0];
    if (kind === "outside")
      record.resultsDir = join(dirname(f.init.workspace.workspaceRoot), "outside");
    if (kind === "symlink") {
      const target = join(f.home, "outside-results");
      await mkdir(target);
      await symlink(target, join(f.init.workspace.workspaceRoot, "alias-results"));
      record.resultsDir = "alias-results";
    }
    if (kind === "nested-symlink") {
      await symlink(f.sourcePaths.stateFile, join(f.sourcePaths.resultsDir, "linked-state.json"));
    }
    if (kind === "overlap") record.resultsDir = "package/nested-results";
    if (kind === "partial-canonical") record.resultsDir = "canvases/default/results";
    if (kind === "other-canvas")
      f.registry.canvases.push({
        ...record,
        canvasId: "other",
        name: "Other",
        resultsDir: "legacy-results/nested"
      });
    await writeJsonFile(f.registryFile, f.registry);
    await expect(applyDefaultCanvasWorkspaceMigration(f.init.workspace)).rejects.toThrow();
    await expect(access(f.init.workspace.packageDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(projectGraphPath(f.init.workspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(f.sourcePaths.stateFile, "utf8")).toBe(f.sourceStateBytes);
  });

  it.each([
    "authority",
    "identity"
  ] as const)("rechecks source %s after copying before publishing", async (change) => {
    const f = await customDefaultCanvasMigrationFixture();
    vi.mocked(cp).mockImplementation(async (source, target, options) => {
      await actualFs.cp(source, target, options);
      if (source !== f.sourcePaths.resultsDir) return;
      if (change === "authority") {
        f.registry.canvases[0].stateFile = "replacement-state.json";
        await writeJsonFile(f.registryFile, f.registry);
      } else {
        await rename(f.sourcePaths.stateFile, `${f.sourcePaths.stateFile}.previous`);
        await writeFile(f.sourcePaths.stateFile, f.sourceStateBytes);
      }
    });
    await expect(applyDefaultCanvasWorkspaceMigration(f.init.workspace)).rejects.toThrow(
      "authority changed"
    );
    await expect(access(projectGraphPath(f.init.workspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(f.sourcePaths.stateFile, "utf8")).toBe(f.sourceStateBytes);
    expect(await readFile(join(f.sourcePaths.resultsDir, f.reportRelativePath), "utf8")).toBe(
      f.report
    );
  });

  it.each([
    { storage: "resultsDir", directory: "Thumbs.db" },
    { storage: "packageDir", directory: ".DS_Store" }
  ] as const)("rejects aliases nested in $storage/$directory before writing", async ({
    storage,
    directory
  }) => {
    const f = await customDefaultCanvasMigrationFixture();
    const nested = join(f.sourcePaths[storage], directory);
    const link = join(nested, "history-alias.json");
    await mkdir(nested);
    await symlink(f.sourcePaths.stateFile, link);
    await expect(applyDefaultCanvasWorkspaceMigration(f.init.workspace)).rejects.toThrow(
      "non-regular storage"
    );
    await expect(access(projectGraphPath(f.init.workspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      access(join(f.init.workspace.workspaceRoot, "migration-quarantine"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(f.init.workspace.packageDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readlink(link)).toBe(f.sourcePaths.stateFile);
    expect(await readFile(f.sourcePaths.stateFile, "utf8")).toBe(f.sourceStateBytes);
    expect(await readFile(join(f.sourcePaths.resultsDir, f.reportRelativePath), "utf8")).toBe(
      f.report
    );
  });

  it("ignores ordinary metadata files while preserving identical registered history", async () => {
    const f = await customDefaultCanvasMigrationFixture();
    await writeFile(join(f.sourcePaths.packageDir, ".DS_Store"), "Source metadata");
    await writeFile(join(f.sourcePaths.resultsDir, "Thumbs.db"), "Source thumbnails");
    await cp(f.sourcePaths.packageDir, f.init.workspace.packageDir, { recursive: true });
    await cp(f.sourcePaths.stateFile, f.init.workspace.stateFile);
    await cp(f.sourcePaths.resultsDir, f.init.workspace.resultsDir, { recursive: true });
    await writeFile(join(f.init.workspace.packageDir, ".DS_Store"), "Canonical metadata");
    await writeFile(join(f.init.workspace.resultsDir, "Thumbs.db"), "Canonical thumbnails");
    expect((await applyDefaultCanvasWorkspaceMigration(f.init.workspace)).action).toBe(
      "mixed_identical"
    );
    expect(await readFile(f.init.workspace.stateFile, "utf8")).toBe(f.sourceStateBytes);
    expect(await readFile(join(f.init.workspace.resultsDir, f.reportRelativePath), "utf8")).toBe(
      f.report
    );
    expect(await readFile(join(f.init.workspace.resultsDir, "Thumbs.db"), "utf8")).toBe(
      "Canonical thumbnails"
    );
  });

  it("compares ordinary history files inside a directory named like ignored metadata", async () => {
    const f = await customDefaultCanvasMigrationFixture();
    const nested = join(f.sourcePaths.resultsDir, "Thumbs.db");
    await mkdir(nested);
    await writeFile(join(nested, "extra-report.md"), "Registered history");
    await cp(f.sourcePaths.packageDir, f.init.workspace.packageDir, { recursive: true });
    await cp(f.sourcePaths.stateFile, f.init.workspace.stateFile);
    await cp(f.sourcePaths.resultsDir, f.init.workspace.resultsDir, { recursive: true });
    await writeFile(
      join(f.init.workspace.resultsDir, "Thumbs.db", "extra-report.md"),
      "Distinct canonical history"
    );
    expect
      .soft((await detectDefaultCanvasWorkspaceMigration(f.init.workspace)).action)
      .toBe("conflict");
    await expect(applyDefaultCanvasWorkspaceMigration(f.init.workspace)).rejects.toThrow(
      "default_canvas_legacy_root_conflict"
    );
    await expect(access(projectGraphPath(f.init.workspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      access(join(f.init.workspace.workspaceRoot, "migration-quarantine"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(nested, "extra-report.md"), "utf8")).toBe("Registered history");
  });

  it("quarantines identical custom storage only after preserving its canonical history", async () => {
    const f = await customDefaultCanvasMigrationFixture();
    await cp(f.sourcePaths.packageDir, f.init.workspace.packageDir, { recursive: true });
    await cp(f.sourcePaths.stateFile, f.init.workspace.stateFile);
    await cp(f.sourcePaths.resultsDir, f.init.workspace.resultsDir, { recursive: true });
    const migrated = await applyDefaultCanvasWorkspaceMigration(f.init.workspace);
    expect(migrated.action).toBe("mixed_identical");
    const workspace = await resolveTaskCanvasWorkspace(f.root);
    expect(await readFile(workspace.stateFile, "utf8")).toBe(f.sourceStateBytes);
    expect(await readFile(join(workspace.resultsDir, f.reportRelativePath), "utf8")).toBe(f.report);
  });

  it("leaves a graph without a default canvas unchanged", async () => {
    const f = await customDefaultCanvasMigrationFixture();
    const graph = await loadProjectGraph(f.root);
    graph.manifest.canvases[0].id = "other";
    await writeProjectGraph(f.init.workspace, graph.manifest);
    const before = await readFile(projectGraphPath(f.init.workspace), "utf8");
    expect((await applyDefaultCanvasWorkspaceMigration(f.init.workspace)).action).toBe("none");
    expect(await readFile(projectGraphPath(f.init.workspace), "utf8")).toBe(before);
    expect(await readFile(f.sourcePaths.stateFile, "utf8")).toBe(f.sourceStateBytes);
  });

  it("uses formal default storage ahead of a stale registry", async () => {
    const f = await customDefaultCanvasMigrationFixture();
    const graph = await loadProjectGraph(f.root);
    await writeProjectGraph(f.init.workspace, graph.manifest);
    f.registry.canvases[0].stateFile = "state.json";
    f.registry.canvases[0].resultsDir = "results";
    await writeJsonFile(f.registryFile, f.registry);
    const migrated = await applyDefaultCanvasWorkspaceMigration(f.init.workspace);
    expect(migrated.legacyPaths).toMatchObject(f.sourcePaths);
    const workspace = await resolveTaskCanvasWorkspace(f.root);
    expect(await readFile(workspace.stateFile, "utf8")).toBe(f.sourceStateBytes);
  });
});
