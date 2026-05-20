import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPackageFileSnapshot,
  detectPackageFileChanges,
  refreshChangedPackagePrompts
} from "../package/fileChanges.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { baseManifest, createPackageWorkspace } from "./promptTestHelpers.js";

describe("package file change detection", () => {
  it("detects global prompt changes and refreshes affected Prompt Surfaces", async () => {
    const { root, init } = await createPackageWorkspace();
    const snapshot = await createPackageFileSnapshot(root);

    await writeFile(join(init.workspace.packageDir, "global-prompt.md"), "Updated global rules.\n", "utf8");
    const result = await refreshChangedPackagePrompts(root, snapshot);
    const prompt = await readFile(join(init.workspace.packageDir, "nodes", "T-001.prompt.md"), "utf8");

    expect(result.impact).toMatchObject({ ok: true, affectedTasks: ["T-001"], fullRefresh: false });
    expect(result.refreshed.map((surface) => surface.taskId)).toEqual(["T-001"]);
    expect(prompt).toContain("Updated global rules.");
    delete process.env.PLANWEAVE_HOME;
  });

  it("detects direct task prompt edits without guessing manifest changes from markdown", async () => {
    const { root, init } = await createPackageWorkspace();
    const snapshot = await createPackageFileSnapshot(root);
    const promptPath = join(init.workspace.packageDir, "nodes", "T-001.prompt.md");

    await writeFile(
      promptPath,
      "<!-- planweave:user:start task-body -->\nUser edited body.\n<!-- planweave:user:end task-body -->\n",
      "utf8"
    );
    const result = await detectPackageFileChanges(root, snapshot);

    expect(result.impact).toMatchObject({ ok: true, affectedTasks: ["T-001"], fullRefresh: false });
    delete process.env.PLANWEAVE_HOME;
  });

  it("reports changed stale prompt files as diagnostics", async () => {
    const { root, init } = await createPackageWorkspace();
    const stalePath = join(init.workspace.packageDir, "nodes", "stale.prompt.md");
    await writeFile(stalePath, "old\n", "utf8");
    const snapshot = await createPackageFileSnapshot(root);

    await writeFile(stalePath, "new\n", "utf8");
    const result = await detectPackageFileChanges(root, snapshot);

    expect(result.impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain("stale_prompt_reference");
    delete process.env.PLANWEAVE_HOME;
  });

  it("applies manifest file changes to a new snapshot graph without mutating the previous snapshot", async () => {
    const { root, init } = await createPackageWorkspace();
    const snapshot = await createPackageFileSnapshot(root);
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    await writeJsonFile(init.workspace.manifestFile, {
      ...manifest,
      nodes: [
        ...manifest.nodes,
        {
          id: "T-002",
          type: "task",
          title: "Second task",
          prompt: "nodes/T-002.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        }
      ],
      edges: [...manifest.edges, { from: "T-002", to: "T-001", type: "depends_on" }]
    });
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-002.prompt.md"),
      "<!-- planweave:user:start task-body -->\nSecond body.\n<!-- planweave:user:end task-body -->\n",
      "utf8"
    );

    const result = await detectPackageFileChanges(root, snapshot);

    expect(result.impact).toMatchObject({ ok: true, affectedTasks: ["T-002", "T-001"], fullRefresh: false });
    expect(result.impact.graph).not.toBe(snapshot.graph);
    expect(result.snapshot?.graph).toBe(result.impact.graph);
    expect(result.snapshot?.graph.dependenciesByTask.get("T-002")).toEqual(["T-001"]);
    expect(snapshot.graph.nodesById.has("T-002")).toBe(false);
    delete process.env.PLANWEAVE_HOME;
  });

  it("reports a missing prompt for a task added through manifest file changes", async () => {
    const { root, init } = await createPackageWorkspace();
    const snapshot = await createPackageFileSnapshot(root);
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    await writeJsonFile(init.workspace.manifestFile, {
      ...manifest,
      nodes: [
        ...manifest.nodes,
        {
          id: "T-MISSING-PROMPT",
          type: "task",
          title: "Missing prompt",
          prompt: "nodes/T-MISSING-PROMPT.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        }
      ],
      edges: [...manifest.edges, { from: "T-MISSING-PROMPT", to: "T-001", type: "depends_on" }]
    });

    const result = await refreshChangedPackagePrompts(root, snapshot);

    expect(result.impact.ok).toBe(false);
    expect(result.impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain("prompt_missing");
    expect(result.impact.affectedTasks).toEqual(["T-MISSING-PROMPT", "T-001"]);
    expect(result.refreshed).toEqual([]);
    expect(result.snapshot).toBeNull();
    expect(snapshot.graph.nodesById.has("T-MISSING-PROMPT")).toBe(false);
    delete process.env.PLANWEAVE_HOME;
  });

  it("reports a missing global prompt instead of throwing during refresh", async () => {
    const { root, init } = await createPackageWorkspace();
    const snapshot = await createPackageFileSnapshot(root);

    await rm(join(init.workspace.packageDir, "global-prompt.md"));

    const result = await refreshChangedPackagePrompts(root, snapshot);

    expect(result.impact.ok).toBe(false);
    expect(result.impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain("global_prompt_missing");
    expect(result.refreshed).toEqual([]);
    expect(result.snapshot).toBeNull();
    delete process.env.PLANWEAVE_HOME;
  });

  it("reports a missing task-body section for a task added through manifest file changes", async () => {
    const { root, init } = await createPackageWorkspace();
    const snapshot = await createPackageFileSnapshot(root);
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    await writeJsonFile(init.workspace.manifestFile, {
      ...manifest,
      nodes: [
        ...manifest.nodes,
        {
          id: "T-BAD-PROMPT",
          type: "task",
          title: "Bad prompt",
          prompt: "nodes/T-BAD-PROMPT.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        }
      ],
      edges: [...manifest.edges, { from: "T-BAD-PROMPT", to: "T-001", type: "depends_on" }]
    });
    await writeFile(join(init.workspace.packageDir, "nodes", "T-BAD-PROMPT.prompt.md"), "No managed task body.\n", "utf8");

    const result = await detectPackageFileChanges(root, snapshot);

    expect(result.impact.ok).toBe(false);
    expect(result.impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain("task_body_missing");
    expect(result.impact.affectedTasks).toEqual(["T-BAD-PROMPT", "T-001"]);
    expect(result.snapshot).toBeNull();
    delete process.env.PLANWEAVE_HOME;
  });

  it("does not advance the snapshot when refresh fails before applying a global prompt change", async () => {
    const manifest = baseManifest({
      nodes: [
        ...baseManifest().nodes,
        {
          id: "T-002",
          type: "task",
          title: "Second task",
          prompt: "nodes/T-002.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        }
      ],
      edges: [
        ...baseManifest().edges,
        { from: "T-002", to: "G-001", type: "implements" }
      ]
    });
    const { root, init } = await createPackageWorkspace(manifest);
    const t1Path = join(init.workspace.packageDir, "nodes", "T-001.prompt.md");
    const t2Path = join(init.workspace.packageDir, "nodes", "T-002.prompt.md");
    await writeFile(
      t2Path,
      "<!-- planweave:user:start task-body -->\nSecond body.\n<!-- planweave:user:end task-body -->\n",
      "utf8"
    );
    const snapshot = await createPackageFileSnapshot(root);

    await writeFile(join(init.workspace.packageDir, "global-prompt.md"), "Updated global rules.\n", "utf8");
    await writeFile(t2Path, "Broken prompt.\n", "utf8");

    const first = await refreshChangedPackagePrompts(root, snapshot);
    const savedSnapshot = first.snapshot ?? snapshot;

    await writeFile(
      t2Path,
      "<!-- planweave:user:start task-body -->\nRepaired body.\n<!-- planweave:user:end task-body -->\n",
      "utf8"
    );
    const second = await refreshChangedPackagePrompts(root, savedSnapshot);
    const t1Prompt = await readFile(t1Path, "utf8");
    const t2Prompt = await readFile(t2Path, "utf8");

    expect(first.impact.ok).toBe(false);
    expect(first.impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain("task_body_missing");
    expect(first.refreshed).toEqual([]);
    expect(first.snapshot).toBeNull();
    expect(second.impact).toMatchObject({ ok: true, affectedTasks: ["T-001", "T-002"], fullRefresh: false });
    expect(second.refreshed.map((surface) => surface.taskId)).toEqual(["T-001", "T-002"]);
    expect(t1Prompt).toContain("Updated global rules.");
    expect(t2Prompt).toContain("Updated global rules.");
    delete process.env.PLANWEAVE_HOME;
  });
});
