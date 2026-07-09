import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCli,
  runCliExpectFailure,
  installTwoTaskGraphPackage,
  repoRoot,
  type GraphQualityJsonReport,
  type GraphTestManifest
} from "./support/cliTestHarness.js";

describe("STEP-1 CLI contract: graph", () => {
  it("exposes graph inspect and quality through the real CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await installTwoTaskGraphPackage(init.workspace.packageDir);

    const summaryOutput = (await runCli(["graph", "inspect", "--view", "summary", "--json"], env))
      .stdout;
    const summary = JSON.parse(summaryOutput) as {
      counts: { taskCount: number; blockCount: number; taskDependencyCount: number };
    };
    expect(summary.counts).toMatchObject({
      taskCount: 2,
      blockCount: 4,
      taskDependencyCount: 1
    });
    expect(summaryOutput).not.toContain("# T-001: Implement a tiny example change");
    expect(summaryOutput).not.toContain("promptSurfaceMarkdown");

    const tasks = JSON.parse(
      (await runCli(["graph", "inspect", "--view", "tasks", "--limit", "1", "--json"], env)).stdout
    ) as {
      tasks: Array<{ taskId: string }>;
      page: { limit: number; total: number; nextCursor: string | null; truncated: boolean };
    };
    expect(tasks.tasks.map((task) => task.taskId)).toEqual(["T-001"]);
    expect(tasks.page).toMatchObject({ limit: 1, total: 2, nextCursor: "next:1", truncated: true });

    const slice = JSON.parse(
      (await runCli(["graph", "inspect", "--view", "slice", "--task", "T-001", "--json"], env))
        .stdout
    ) as {
      blocks: { items: Array<{ ref: string }>; total: number; truncated: boolean };
    };
    expect(slice.blocks.items.map((block) => block.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(slice.blocks).toMatchObject({ total: 2, truncated: false });
    expect(JSON.stringify(slice)).not.toContain("nextCursor");
    const sliceCursorFailure = await runCliExpectFailure(
      ["graph", "inspect", "--view", "slice", "--task", "T-001", "--cursor", "next:1"],
      env
    );
    expect(sliceCursorFailure.stderr).toContain(
      "--cursor is not supported for graph inspect --view slice"
    );

    const quality = JSON.parse((await runCli(["graph", "quality", "--json"], env)).stdout) as {
      ok: boolean;
      summary: { taskCount: number; blockCount: number };
      diagnostics: unknown[];
    };
    expect(quality).toMatchObject({
      ok: true,
      summary: { taskCount: 2, blockCount: 4 }
    });
    expect(Array.isArray(quality.diagnostics)).toBe(true);
  }, 20_000);

  it("returns a non-zero exit code for failing graph quality JSON reports", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const manifestPath = join(init.workspace.packageDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GraphTestManifest;
    manifest.nodes = manifest.nodes.map((task) => ({
      ...task,
      blocks: task.blocks.filter((block) => block.type !== "review")
    }));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const failure = await runCliExpectFailure(
      ["graph", "quality", "--review-policy", "required", "--strict", "--json"],
      env
    );
    const result = JSON.parse(failure.stdout) as GraphQualityJsonReport;

    expect(failure.code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "task_missing_review_block" })])
    );
  }, 20_000);

  it("returns a non-zero exit code for graph quality compile errors", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const manifestPath = join(init.workspace.packageDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GraphTestManifest;
    manifest.edges = [{ from: "T-001", to: "MISSING", type: "depends_on" }];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const failure = await runCliExpectFailure(["graph", "quality", "--json"], env);
    const result = JSON.parse(failure.stdout) as GraphQualityJsonReport;

    expect(failure.code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "edge_to_missing" })])
    );
  }, 20_000);
});
