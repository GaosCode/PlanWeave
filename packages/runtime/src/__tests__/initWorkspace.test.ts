import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace, readProject } from "../index.js";
import { readJsonFile } from "../json.js";
import type { PlanPackageManifest, RuntimeState } from "../types.js";

describe("initWorkspace", () => {
  it("creates the local workspace and minimal Plan Package skeleton", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "sample-project-"));
    process.env.PLANWEAVE_HOME = home;

    const result = await initWorkspace({ projectRoot: root });
    const project = await readProject(root);
    const manifest = await readJsonFile<PlanPackageManifest>(result.workspace.manifestFile);
    const state = await readJsonFile<RuntimeState>(result.workspace.stateFile);
    const globalPrompt = await readFile(join(result.workspace.packageDir, "global-prompt.md"), "utf8");

    await expect(access(join(result.workspace.packageDir, "nodes"), constants.F_OK)).resolves.toBeUndefined();
    await expect(access(result.workspace.resultsDir, constants.F_OK)).resolves.toBeUndefined();
    expect(project?.id).toBe(result.workspace.id);
    expect(manifest.version).toBe("plan-package/v0");
    expect(manifest.nodes).toEqual([]);
    expect(state).toEqual({ currentTaskId: null, tasks: {} });
    expect(globalPrompt).toContain("Global Prompt");

    delete process.env.PLANWEAVE_HOME;
  });

  it("does not let --force overwrite an existing package or state", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "sample-project-"));
    process.env.PLANWEAVE_HOME = home;

    const result = await initWorkspace({ projectRoot: root });
    await writeFile(join(result.workspace.packageDir, "global-prompt.md"), "custom prompt\n", "utf8");

    await expect(initWorkspace({ projectRoot: root, force: true })).rejects.toThrow("would overwrite");
    await expect(readFile(join(result.workspace.packageDir, "global-prompt.md"), "utf8")).resolves.toBe("custom prompt\n");

    delete process.env.PLANWEAVE_HOME;
  });

  it("backs up package and state before an explicit package reset", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "sample-project-"));
    process.env.PLANWEAVE_HOME = home;

    const result = await initWorkspace({ projectRoot: root });
    await writeFile(join(result.workspace.packageDir, "global-prompt.md"), "custom prompt\n", "utf8");
    await writeFile(result.workspace.stateFile, JSON.stringify({ currentTaskId: null, tasks: { T: { status: "ready" } } }), "utf8");

    const reset = await initWorkspace({ projectRoot: root, resetPackage: true });
    const backupEntries = await readdir(join(result.workspace.workspaceRoot, "backups"));

    expect(reset.backup?.packageDir).toContain("backups");
    expect(backupEntries).toHaveLength(1);
    await expect(readFile(join(reset.backup?.packageDir ?? "", "global-prompt.md"), "utf8")).resolves.toBe("custom prompt\n");
    await expect(readFile(reset.backup?.stateFile ?? "", "utf8")).resolves.toContain("T");
    await expect(readFile(join(result.workspace.packageDir, "global-prompt.md"), "utf8")).resolves.toContain("Global Prompt");

    delete process.env.PLANWEAVE_HOME;
  });
});
