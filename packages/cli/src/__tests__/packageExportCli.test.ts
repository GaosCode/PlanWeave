import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, runCliExpectFailure, repoRoot } from "./support/cliTestHarness.js";

describe("CLI package export", () => {
  it("exports package files, validates, and round-trips through import", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-export-home-"));
    const exportTarget = await mkdtemp(join(tmpdir(), "planweave-export-target-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout) as {
      workspace: { packageDir: string; stateFile: string; resultsDir: string };
    };
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    // Runtime state lives outside the package and must never appear in export.
    await mkdir(init.workspace.resultsDir, { recursive: true });
    await writeFile(init.workspace.stateFile, '{"version":"runtime-state/v1"}', "utf8");
    await writeFile(
      join(init.workspace.resultsDir, "T-001-B-001-report.md"),
      "should not export",
      "utf8"
    );

    const exported = JSON.parse(
      (
        await runCli(
          [
            "package",
            "export",
            "--target",
            exportTarget,
            "--canvas",
            "default",
            "--force",
            "--json"
          ],
          env
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
      (await runCli(["package-draft", "validate", "--draft-root", exportTarget, "--json"], env))
        .stdout
    ) as { ok: boolean; validation: { summary: { errorCount: number } } };
    expect(draftValidation).toMatchObject({ ok: true, validation: { summary: { errorCount: 0 } } });

    const sourceManifest = JSON.parse(
      await readFile(join(init.workspace.packageDir, "manifest.json"), "utf8")
    ) as {
      nodes: Array<{ id: string; blocks?: Array<{ id: string }> }>;
    };
    const sourceRefs = collectTaskBlockRefs(sourceManifest);

    const importHome = await mkdtemp(join(tmpdir(), "planweave-export-import-home-"));
    const importEnv = { ...process.env, PLANWEAVE_HOME: importHome };
    const importInit = JSON.parse((await runCli(["init", "--json"], importEnv)).stdout) as {
      workspace: { packageDir: string };
    };
    const applied = JSON.parse(
      (
        await runCli(
          ["package", "import", "--from", exportTarget, "--apply", "--canvas", "default", "--json"],
          importEnv
        )
      ).stdout
    ) as { ok: boolean; applied: boolean };
    expect(applied).toMatchObject({ ok: true, applied: true });

    const importedManifest = JSON.parse(
      await readFile(join(importInit.workspace.packageDir, "manifest.json"), "utf8")
    ) as {
      nodes: Array<{ id: string; blocks?: Array<{ id: string }> }>;
    };
    expect(collectTaskBlockRefs(importedManifest)).toEqual(sourceRefs);
  }, 30_000);

  it("refuses a non-empty export target without --force", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-export-refuse-home-"));
    const exportTarget = await mkdtemp(join(tmpdir(), "planweave-export-refuse-target-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    await runCli(["init", "--json"], env);
    await writeFile(join(exportTarget, "existing.txt"), "keep", "utf8");

    const failure = await runCliExpectFailure(
      ["package", "export", "--target", exportTarget, "--json"],
      env
    );
    expect(failure.code).not.toBe(0);
    expect(`${failure.stdout}\n${failure.stderr}`).toMatch(/not empty|force/i);
    await expect(readFile(join(exportTarget, "existing.txt"), "utf8")).resolves.toBe("keep");
  }, 20_000);
});

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
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
