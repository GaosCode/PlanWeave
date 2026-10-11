import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonFile } from "../json.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { applyPackageDraftImport } from "../package/packageDraftImport.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";
import { realFs, recoveryRoot } from "./support/importTransactionTestHarness.js";

const faults = vi.hoisted(() => ({ copy: false, cleanup: false, roots: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      const root = await fs.mkdtemp(...args);
      if (
        String(args[0]).includes("planweave-package-import-") ||
        String(args[0]).includes("planweave-project-import-") ||
        String(args[0]).includes(".planweave-import-")
      )
        faults.roots.push(String(root));
      return root;
    },
    cp: async (...args: Parameters<typeof fs.cp>) => {
      if (faults.copy) throw new Error("draft copy interrupted");
      return fs.cp(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (faults.cleanup && faults.roots.includes(String(args[0])))
        throw new Error("staging cleanup interrupted");
      return fs.rm(...args);
    }
  };
});

const owned: string[] = [];
afterEach(async () => {
  faults.copy = false;
  faults.cleanup = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    [...owned.splice(0), ...faults.roots.splice(0)].map((path) =>
      rm(path, { recursive: true, force: true })
    )
  );
});

async function fixture(project: boolean, linked = false) {
  vi.stubEnv("PLANWEAVE_HOME", process.env.PLANWEAVE_HOME);
  vi.stubEnv("PLANWEAVE_DESKTOP_SETTINGS_FILE", process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE);
  const base = await mkdtemp(join(tmpdir(), "import home with spaces-"));
  owned.push(base);
  const physicalHome = join(base, "physical");
  await mkdir(physicalHome);
  const home = linked ? join(base, "linked home") : physicalHome;
  if (linked) await symlink(physicalHome, home, "dir");
  const f = await createTestWorkspace(basicManifest(), { planweaveHome: home });
  owned.push(f.root);
  const draft = await mkdtemp(join(tmpdir(), "source draft with spaces-"));
  owned.push(draft);
  const packageDir = project ? join(draft, "custom", "first", "package") : draft;
  const manifest = basicManifest();
  manifest.project.title = "Imported staging";
  await mkdir(packageDir, { recursive: true });
  await writeJsonFile(join(packageDir, "manifest.json"), manifest);
  await writePromptFiles(packageDir, manifest);
  if (project) {
    await writeJsonFile(join(draft, "project-graph.json"), {
      version: "plan-project/v1",
      canvases: ["first", "second"].map((id) => ({
        id,
        type: "canvas",
        title: id,
        packageDir: `custom/${id}/package`,
        stateFile: `states/${id}.json`,
        resultsDir: `history/${id}`
      })),
      edges: [],
      crossTaskEdges: []
    });
    await mkdir(join(draft, "custom", "second", "package"), { recursive: true });
    await writeJsonFile(join(draft, "custom", "second", "package", "manifest.json"), manifest);
    await writePromptFiles(join(draft, "custom", "second", "package"), manifest);
  }
  return { ...f, draft };
}

async function expectStagingClean() {
  expect(faults.roots.length).toBeGreaterThan(0);
  for (const path of faults.roots)
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("draft import owned staging", () => {
  it.each([
    false,
    true
  ])("imports %s project mode across simulated OS-temp/workspace volumes", async (project) => {
    const f = await fixture(project, true);
    const workspace = await realpath(f.init.workspace.workspaceRoot);
    const create = ImportTransaction.create;
    let installs = 0;
    vi.spyOn(ImportTransaction, "create").mockImplementation((options) =>
      create({
        ...options,
        fs: {
          ...realFs,
          rename: async (source, target) => {
            if (!String(source).includes(`${join("recovery", "package-import")}/`)) {
              const sourcePath = await realpath(String(source));
              // This is a volume simulation; the real transaction still performs every rename.
              if (relative(workspace, sourcePath).startsWith(".."))
                throw Object.assign(new Error("EXDEV simulated temp volume"), { code: "EXDEV" });
              if (!String(target).includes(`${join("recovery", "package-import")}/`)) {
                expect((await stat(dirname(sourcePath))).dev).toBe(
                  (await stat(dirname(String(target)))).dev
                );
                installs += 1;
              }
            }
            return realFs.rename(source, target);
          }
        }
      })
    );
    await expect(
      applyPackageDraftImport({ projectRoot: f.root, draftRoot: f.draft })
    ).resolves.toMatchObject({ applied: true });
    expect(installs).toBe(project ? 9 : 4);
    const manifestPath = project
      ? join(workspace, "custom", "second", "package", "manifest.json")
      : f.init.workspace.manifestFile;
    expect(JSON.parse(await readFile(manifestPath, "utf8")).project.title).toBe("Imported staging");
    await expectStagingClean();
  });

  it.each([
    "initialization",
    "copy"
  ])("cleans owned staging after %s failure without changing live package", async (failure) => {
    const f = await fixture(false);
    const before = await readFile(f.init.workspace.manifestFile);
    if (failure === "initialization")
      vi.spyOn(ImportTransaction, "create").mockRejectedValueOnce(
        new Error("transaction initialization interrupted")
      );
    else faults.copy = true;
    await expect(
      applyPackageDraftImport({ projectRoot: f.root, draftRoot: f.draft })
    ).rejects.toThrow("interrupted");
    expect(await readFile(f.init.workspace.manifestFile)).toEqual(before);
    await expectStagingClean();
  });

  it("reports staging cleanup alongside the apply error", async () => {
    const f = await fixture(false);
    faults.copy = true;
    faults.cleanup = true;
    await expect(
      applyPackageDraftImport({ projectRoot: f.root, draftRoot: f.draft })
    ).rejects.toThrow(/draft copy interrupted.*staging cleanup interrupted/s);
  });

  it("keeps committed recovery on cleanup failure and finalizes it independently of staging", async () => {
    const f = await fixture(false);
    const create = ImportTransaction.create;
    const recovery = recoveryRoot(f.init.workspace.workspaceRoot, "committed-staging");
    vi.spyOn(ImportTransaction, "create").mockImplementation((options) =>
      create({
        ...options,
        transactionId: "committed-staging",
        fs: {
          ...realFs,
          rm: async (path, options) => {
            if (path === recovery) throw new Error("commit cleanup interrupted");
            return realFs.rm(path, options);
          }
        }
      })
    );
    await expect(
      applyPackageDraftImport({ projectRoot: f.root, draftRoot: f.draft })
    ).rejects.toThrow("Package draft import commit cleanup failed: commit cleanup interrupted");
    await expectStagingClean();
    expect(JSON.parse(await readFile(f.init.workspace.manifestFile, "utf8")).project.title).toBe(
      "Imported staging"
    );
    const recovered = await ImportTransaction.recover({
      workspaceRoot: f.init.workspace.workspaceRoot,
      transactionId: "committed-staging"
    });
    await recovered.cleanupCommitted();
    await expect(stat(recovery)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves failed rollback recovery and restores original bytes through formal recovery", async () => {
    const f = await fixture(false);
    const before = await readFile(f.init.workspace.manifestFile);
    const beforeIdentity = (await resolveTaskCanvasWorkspace(f.root, "default"))
      .packageStorageIdentity;
    const create = ImportTransaction.create;
    let installs = 0;
    vi.spyOn(ImportTransaction, "create").mockImplementation((options) =>
      create({
        ...options,
        transactionId: "staging-recovery",
        fs: {
          ...realFs,
          rename: async (source, target) => {
            if (String(source).includes("backups")) throw new Error("rollback interrupted");
            if (!String(target).includes("backups") && ++installs === 2)
              throw new Error("second install interrupted");
            return realFs.rename(source, target);
          }
        }
      })
    );
    await expect(
      applyPackageDraftImport({ projectRoot: f.root, draftRoot: f.draft })
    ).rejects.toThrow(/rollback failed/);
    await expectStagingClean();
    const recovery = recoveryRoot(f.init.workspace.workspaceRoot, "staging-recovery");
    expect(await readdir(recovery)).toContain("recovery.json");
    await writeFile(join(f.init.workspace.workspaceRoot, "foreign-staging-marker"), "foreign");
    await (
      await ImportTransaction.recover({
        workspaceRoot: f.init.workspace.workspaceRoot,
        transactionId: "staging-recovery"
      })
    ).rollback();
    expect(await readFile(f.init.workspace.manifestFile)).toEqual(before);
    expect((await resolveTaskCanvasWorkspace(f.root, "default")).packageStorageIdentity).toBe(
      beforeIdentity
    );
    expect(
      await readFile(join(f.init.workspace.workspaceRoot, "foreign-staging-marker"), "utf8")
    ).toBe("foreign");
  });
});
