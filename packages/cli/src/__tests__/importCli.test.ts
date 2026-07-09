import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, runCliExpectFailure, repoRoot, type ValidationReport, type GraphQualityJsonReport, type GraphTestManifest } from "./support/cliTestHarness.js";

describe("STEP-1 CLI contract: package import", () => {
  it("validates and imports package drafts through the real CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const draftRoot = await mkdtemp(join(tmpdir(), "planweave-draft-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), draftRoot, {
      recursive: true,
      force: true
    });
    const draftManifestPath = join(draftRoot, "manifest.json");
    const draftManifest = JSON.parse(await readFile(draftManifestPath, "utf8")) as GraphTestManifest & {
      project: { title: string; description: string };
    };
    draftManifest.project.title = "Draft Import Title";
    await writeFile(draftManifestPath, `${JSON.stringify(draftManifest, null, 2)}\n`, "utf8");

    const draftValidation = JSON.parse((await runCli(["package-draft", "validate", "--draft-root", draftRoot, "--json"], env)).stdout) as {
      ok: boolean;
      mode: string;
      validation: { summary: { errorCount: number } };
    };
    const draftQuality = JSON.parse((await runCli(["package-draft", "quality", "--draft-root", draftRoot, "--json"], env)).stdout) as {
      ok: boolean;
      canvases: Array<{ graphQuality: { ok: boolean } }>;
    };
    const dryRun = JSON.parse((await runCli(["package", "import", "--from", draftRoot, "--dry-run", "--canvas", "default", "--json"], env)).stdout) as {
      ok: boolean;
      target: { canvasId: string };
      summary: { changed: number };
    };
    const targetManifestBeforeApply = JSON.parse(await readFile(join(init.workspace.packageDir, "manifest.json"), "utf8")) as {
      project: { title: string };
    };
    const applied = JSON.parse((await runCli(["package", "import", "--from", draftRoot, "--apply", "--canvas", "default", "--json"], env)).stdout) as {
      ok: boolean;
      applied: boolean;
    };
    const targetManifestAfterApply = JSON.parse(await readFile(join(init.workspace.packageDir, "manifest.json"), "utf8")) as {
      project: { title: string };
    };
    const validationAfterApply = JSON.parse((await runCli(["validate", "--json"], env)).stdout) as ValidationReport;
    const qualityAfterApply = JSON.parse((await runCli(["graph", "quality", "--json"], env)).stdout) as GraphQualityJsonReport;

    expect(draftValidation).toMatchObject({ ok: true, mode: "single-canvas", validation: { summary: { errorCount: 0 } } });
    expect(draftQuality).toMatchObject({ ok: true, canvases: [{ graphQuality: { ok: true } }] });
    expect(dryRun).toMatchObject({ ok: true, target: { canvasId: "default" } });
    expect(dryRun.summary.changed).toBeGreaterThan(0);
    expect(targetManifestBeforeApply.project.title).not.toBe("Draft Import Title");
    expect(applied).toMatchObject({ ok: true, applied: true });
    expect(targetManifestAfterApply.project.title).toBe("Draft Import Title");
    expect(validationAfterApply.ok).toBe(true);
    expect(qualityAfterApply.ok).toBe(true);
  }, 20_000);

  it("returns a non-zero exit code for invalid package draft quality", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const draftRoot = await mkdtemp(join(tmpdir(), "planweave-bad-draft-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    await cp(join(repoRoot, "examples/basic-plan-package/package"), draftRoot, {
      recursive: true,
      force: true
    });
    const manifestPath = join(draftRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GraphTestManifest;
    manifest.edges = [{ from: "T-001", to: "MISSING", type: "depends_on" }];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const failure = await runCliExpectFailure(["package-draft", "quality", "--draft-root", draftRoot, "--json"], env);
    const result = JSON.parse(failure.stdout) as { ok: boolean; canvases: Array<{ graphQuality: { diagnostics: Array<{ code: string }> } }> };

    expect(failure.code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.canvases[0]?.graphQuality.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "edge_to_missing" })]));
  }, 20_000);
});
