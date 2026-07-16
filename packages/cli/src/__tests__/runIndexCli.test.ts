import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, withoutInitCwd } from "./support/cliTestHarness.js";

describe("run-index CLI canvas scope", () => {
  it("migrates one canvas or every canvas without silently using only the active canvas", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-run-index-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const rootArgs = ["--project-root", root];
    await runCli([...rootArgs, "init", "--project-graph", "--json"], env);
    await runCli(
      [...rootArgs, "canvas", "create", "--id", "secondary", "--title", "Secondary", "--json"],
      env
    );

    const active = JSON.parse(
      (await runCli([...rootArgs, "run-index", "migrate", "--json"], env)).stdout
    ) as { canvases: Array<{ canvasId: string }> };
    expect(active.canvases.map((canvas) => canvas.canvasId)).toEqual(["default"]);

    const selected = JSON.parse(
      (await runCli([...rootArgs, "run-index", "migrate", "--canvas", "secondary", "--json"], env)).stdout
    ) as { canvases: Array<{ canvasId: string }> };
    expect(selected.canvases.map((canvas) => canvas.canvasId)).toEqual(["secondary"]);

    const all = JSON.parse(
      (await runCli([...rootArgs, "run-index", "migrate", "--all-canvases", "--json"], env)).stdout
    ) as { canvases: Array<{ canvasId: string }> };
    expect(all.canvases.map((canvas) => canvas.canvasId).sort()).toEqual(["default", "secondary"]);
  }, 20_000);
});
