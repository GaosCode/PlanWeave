import { cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, runCliExpectFailure, repoRoot } from "./support/cliTestHarness.js";

const cliTestTimeoutMs = 20_000;
const roundTripTimeoutMs = 30_000;
const cliPackageRoot = join(repoRoot, "packages", "cli");
const nonEmptyTargetErrorPattern = /not empty|force/i;
const protectedRootErrorPattern = /export target.*root.*ancestor/i;
const protectedProjectRootErrorPattern = /export target.*project root.*ancestor/i;
const destructiveOverlapErrorPattern = /export target.*overlap.*package directory/i;
const resultsOverlapErrorPattern = /export target.*overlap.*results directory/i;

interface TestProject {
  sandboxRoot: string;
  sourceRoot: string;
  env: NodeJS.ProcessEnv;
  init: {
    workspace: {
      workspaceRoot: string;
      packageDir: string;
      stateFile: string;
      resultsDir: string;
    };
  };
}

async function createTestProject(prefix: string): Promise<TestProject> {
  const sandboxRoot = await mkdtemp(join(tmpdir(), prefix));
  const sourceRoot = join(sandboxRoot, "source-parent", "project");
  const home = join(sandboxRoot, "planweave-home");
  await mkdir(sourceRoot, { recursive: true });
  const env = { ...process.env, PLANWEAVE_HOME: home };
  const init = JSON.parse(
    (await runCli(["--project-root", sourceRoot, "init", "--json"], env)).stdout
  ) as TestProject["init"];
  return { sandboxRoot, sourceRoot, env, init };
}

function projectArgs(project: TestProject, args: string[]): string[] {
  return ["--project-root", project.sourceRoot, ...args];
}

async function expectProtectedExportTarget(
  project: TestProject,
  target: string,
  sentinelRoot: string,
  errorPattern: RegExp
): Promise<void> {
  const sentinel = join(sentinelRoot, "export-guard-sentinel.txt");
  await writeFile(sentinel, "keep", "utf8");
  const failure = await runCliExpectFailure(
    projectArgs(project, ["package", "export", "--target", target, "--force", "--json"]),
    project.env
  );
  expect(failure.code).not.toBe(0);
  expect(`${failure.stdout}\n${failure.stderr}`).toMatch(errorPattern);
  await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
}

describe("CLI package export", () => {
  it(
    "exports package files, validates, and round-trips through import",
    async () => {
      const project = await createTestProject("planweave-export-project-");
      const exportTarget = await mkdtemp(join(tmpdir(), "planweave-export-target-"));
      await cp(
        join(repoRoot, "examples/basic-plan-package/package"),
        project.init.workspace.packageDir,
        {
          recursive: true,
          force: true
        }
      );

      // Runtime state lives outside the package and must never appear in export.
      await mkdir(project.init.workspace.resultsDir, { recursive: true });
      await writeFile(project.init.workspace.stateFile, '{"version":"runtime-state/v1"}', "utf8");
      await writeFile(
        join(project.init.workspace.resultsDir, "T-001-B-001-report.md"),
        "should not export",
        "utf8"
      );

      const exported = JSON.parse(
        (
          await runCli(
            projectArgs(project, [
              "package",
              "export",
              "--target",
              exportTarget,
              "--canvas",
              "default",
              "--force",
              "--json"
            ]),
            project.env
          )
        ).stdout
      ) as { ok: boolean; canvasId: string; fileCount: number; target: string };

      expect(exported).toMatchObject({ ok: true, canvasId: "default", target: exportTarget });
      expect(exported.fileCount).toBeGreaterThan(0);

      const exportedPaths = await listRelativeFiles(exportTarget);
      expect(exportedPaths).toContain("manifest.json");
      expect(
        exportedPaths.some(
          (path) =>
            path === "state.json" || path.startsWith("results/") || path.includes("/state.json")
        )
      ).toBe(false);

      const draftValidation = JSON.parse(
        (
          await runCli(
            projectArgs(project, [
              "package-draft",
              "validate",
              "--draft-root",
              exportTarget,
              "--json"
            ]),
            project.env
          )
        ).stdout
      ) as { ok: boolean; validation: { summary: { errorCount: number } } };
      expect(draftValidation).toMatchObject({
        ok: true,
        validation: { summary: { errorCount: 0 } }
      });

      const sourceManifest = JSON.parse(
        await readFile(join(project.init.workspace.packageDir, "manifest.json"), "utf8")
      ) as {
        nodes: Array<{ id: string; blocks?: Array<{ id: string }> }>;
      };
      const sourceRefs = collectTaskBlockRefs(sourceManifest);

      const importProject = await createTestProject("planweave-export-import-project-");
      const applied = JSON.parse(
        (
          await runCli(
            projectArgs(importProject, [
              "package",
              "import",
              "--from",
              exportTarget,
              "--apply",
              "--canvas",
              "default",
              "--json"
            ]),
            importProject.env
          )
        ).stdout
      ) as { ok: boolean; applied: boolean };
      expect(applied).toMatchObject({ ok: true, applied: true });

      const importedManifest = JSON.parse(
        await readFile(join(importProject.init.workspace.packageDir, "manifest.json"), "utf8")
      ) as {
        nodes: Array<{ id: string; blocks?: Array<{ id: string }> }>;
      };
      expect(collectTaskBlockRefs(importedManifest)).toEqual(sourceRefs);
    },
    roundTripTimeoutMs
  );

  it(
    "refuses a non-empty export target without --force",
    async () => {
      const project = await createTestProject("planweave-export-refuse-project-");
      const exportTarget = await mkdtemp(join(tmpdir(), "planweave-export-refuse-target-"));
      await writeFile(join(exportTarget, "existing.txt"), "keep", "utf8");

      const failure = await runCliExpectFailure(
        projectArgs(project, ["package", "export", "--target", exportTarget, "--json"]),
        project.env
      );
      expect(failure.code).not.toBe(0);
      expect(`${failure.stdout}\n${failure.stderr}`).toMatch(nonEmptyTargetErrorPattern);
      await expect(readFile(join(exportTarget, "existing.txt"), "utf8")).resolves.toBe("keep");
    },
    cliTestTimeoutMs
  );

  const protectedTargetCases = [
    {
      name: "source project root",
      target: (project: TestProject) => project.sourceRoot
    },
    {
      name: "source project ancestor",
      target: (project: TestProject) => dirname(project.sourceRoot)
    },
    {
      name: "PlanWeave project workspace root",
      target: (project: TestProject) => project.init.workspace.workspaceRoot
    },
    {
      name: "PlanWeave project workspace ancestor",
      target: (project: TestProject) => dirname(project.init.workspace.workspaceRoot)
    },
    {
      name: "task canvas workspace root",
      target: (project: TestProject) => dirname(project.init.workspace.packageDir)
    }
  ];

  it.each(protectedTargetCases)(
    "refuses --force when target is the $name",
    async ({ target }) => {
      const project = await createTestProject("planweave-export-protected-");
      const exportTarget = target(project);
      await expectProtectedExportTarget(
        project,
        exportTarget,
        exportTarget,
        protectedRootErrorPattern
      );
    },
    cliTestTimeoutMs
  );

  it(
    "normalizes a relative protected target before checking it",
    async () => {
      const project = await createTestProject("planweave-export-relative-");
      const normalizationChild = join(project.sourceRoot, "normalization-child");
      await mkdir(normalizationChild);
      const relativeTarget = `${relative(cliPackageRoot, normalizationChild)}${sep}..`;
      await expectProtectedExportTarget(
        project,
        relativeTarget,
        project.sourceRoot,
        protectedProjectRootErrorPattern
      );
    },
    cliTestTimeoutMs
  );

  it(
    "resolves existing symlinks before checking a protected target",
    async () => {
      const project = await createTestProject("planweave-export-symlink-");
      const sourceParent = dirname(project.sourceRoot);
      const sourceParentLink = join(project.sandboxRoot, "source-parent-link");
      await symlink(sourceParent, sourceParentLink, "dir");
      const exportTarget = join(sourceParentLink, basename(project.sourceRoot));
      await expectProtectedExportTarget(
        project,
        exportTarget,
        project.sourceRoot,
        protectedProjectRootErrorPattern
      );
    },
    cliTestTimeoutMs
  );

  it(
    "allows a dedicated export directory below the source project root",
    async () => {
      const project = await createTestProject("planweave-export-child-");
      const exportTarget = join(project.sourceRoot, "artifacts", "package-export");

      const exported = JSON.parse(
        (
          await runCli(
            projectArgs(project, ["package", "export", "--target", exportTarget, "--json"]),
            project.env
          )
        ).stdout
      ) as { ok: boolean; target: string };

      expect(exported).toMatchObject({ ok: true, target: exportTarget });
      await expect(readFile(join(exportTarget, "manifest.json"), "utf8")).resolves.toContain(
        '"version": "plan-package/v1"'
      );
    },
    cliTestTimeoutMs
  );

  it(
    "refuses --force when target is the active package directory",
    async () => {
      const project = await createTestProject("planweave-export-package-dir-");
      await expectProtectedExportTarget(
        project,
        project.init.workspace.packageDir,
        project.init.workspace.packageDir,
        destructiveOverlapErrorPattern
      );
    },
    cliTestTimeoutMs
  );

  it(
    "refuses --force when target is the runtime results directory",
    async () => {
      const project = await createTestProject("planweave-export-results-dir-");
      await mkdir(project.init.workspace.resultsDir, { recursive: true });
      await expectProtectedExportTarget(
        project,
        project.init.workspace.resultsDir,
        project.init.workspace.resultsDir,
        resultsOverlapErrorPattern
      );
    },
    cliTestTimeoutMs
  );

  it(
    "refuses --force when target is a run directory below results",
    async () => {
      const project = await createTestProject("planweave-export-results-child-");
      const runDir = join(project.init.workspace.resultsDir, "runs", "run-001");
      await mkdir(runDir, { recursive: true });
      await expectProtectedExportTarget(project, runDir, runDir, resultsOverlapErrorPattern);
    },
    cliTestTimeoutMs
  );

  it.each([
    {
      name: "package directory",
      prepare: async (project: TestProject) => {
        const target = join(project.sandboxRoot, "package-link");
        await symlink(project.init.workspace.packageDir, target, "dir");
        return {
          target,
          sentinelRoot: project.init.workspace.packageDir,
          errorPattern: destructiveOverlapErrorPattern
        };
      }
    },
    {
      name: "results run directory",
      prepare: async (project: TestProject) => {
        const runDir = join(project.init.workspace.resultsDir, "runs", "run-linked");
        await mkdir(runDir, { recursive: true });
        const target = join(project.sandboxRoot, "results-run-link");
        await symlink(runDir, target, "dir");
        return { target, sentinelRoot: runDir, errorPattern: resultsOverlapErrorPattern };
      }
    }
  ])(
    "refuses --force when target is a symlink to the $name",
    async ({ prepare }) => {
      const project = await createTestProject("planweave-export-destructive-symlink-");
      const target = await prepare(project);
      await expectProtectedExportTarget(
        project,
        target.target,
        target.sentinelRoot,
        target.errorPattern
      );
    },
    cliTestTimeoutMs
  );
});

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        let relativePath = entry.name;
        if (prefix) {
          relativePath = `${prefix}/${entry.name}`;
        }
        if (entry.isDirectory()) {
          await visit(join(dir, entry.name), relativePath);
        } else if (entry.isFile()) {
          files.push(relativePath);
        }
      })
    );
  }
  await visit(root, "");
  return files.sort((left, right) => left.localeCompare(right));
}

function collectTaskBlockRefs(manifest: {
  nodes: Array<{ id: string; blocks?: Array<{ id: string }> }>;
}): string[] {
  const refs: string[] = [];
  for (const node of manifest.nodes) {
    refs.push(node.id);
    for (const block of node.blocks ?? []) {
      refs.push(`${node.id}#${block.id}`);
    }
  }
  return refs.sort((left, right) => left.localeCompare(right));
}
