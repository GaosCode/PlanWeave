import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace, validatePackage } from "../index.js";
import { writeJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";

async function createWorkspaceWithPackage(manifest: PlanPackageManifest, prompt: string) {
  const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
  const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
  process.env.PLANWEAVE_HOME = home;
  const init = await initWorkspace({ projectRoot: root });
  await mkdir(join(init.workspace.packageDir, "nodes"), { recursive: true });
  await writeJsonFile(init.workspace.manifestFile, manifest);
  await writeFile(join(init.workspace.packageDir, "global-prompt.md"), "Global rules\n", "utf8");
  await writeFile(join(init.workspace.packageDir, "nodes", "T-001.prompt.md"), prompt, "utf8");
  return { root, init };
}

describe("validatePackage", () => {
  it("accepts a valid package and reports warning-only task coverage", async () => {
    const { root } = await createWorkspaceWithPackage(
      {
        version: "plan-package/v0",
        project: { title: "Project", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        global_prompt: "global-prompt.md",
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Task",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: false, locks: [] }
          }
        ],
        edges: []
      },
      "<!-- planweave:user:start task-body -->\nDo it.\n<!-- planweave:user:end task-body -->\n"
    );

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((warning) => warning.code)).toContain("task_without_goal_or_requirement");
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects missing task-body user section and depends_on cycles", async () => {
    const { root } = await createWorkspaceWithPackage(
      {
        version: "plan-package/v0",
        project: { title: "Project", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        global_prompt: "global-prompt.md",
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Task 1",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: false, locks: [] }
          },
          {
            id: "T-002",
            type: "task",
            title: "Task 2",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: false, locks: [] }
          }
        ],
        edges: [
          { from: "T-001", to: "T-002", type: "depends_on" },
          { from: "T-002", to: "T-001", type: "depends_on" }
        ]
      },
      "No sections\n"
    );

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("task_body_missing");
    expect(report.errors.map((error) => error.code)).toContain("depends_on_cycle");
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects invalid edge endpoint type combinations", async () => {
    const { root } = await createWorkspaceWithPackage(
      {
        version: "plan-package/v0",
        project: { title: "Project", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        global_prompt: "global-prompt.md",
        nodes: [
          { id: "G-001", type: "goal", title: "Goal", summary: "Goal summary." },
          { id: "C-001", type: "constraint", title: "Constraint", summary: "Constraint summary." },
          { id: "CMP-001", type: "component", title: "Component", summary: "Component summary." },
          {
            id: "T-001",
            type: "task",
            title: "Task",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: false, locks: [] }
          }
        ],
        edges: [
          { from: "T-001", to: "G-001", type: "implements" },
          { from: "T-001", to: "C-001", type: "constrained_by" },
          { from: "T-001", to: "CMP-001", type: "touches" },
          { from: "G-001", to: "T-001", type: "implements" }
        ]
      },
      "<!-- planweave:user:start task-body -->\nDo it.\n<!-- planweave:user:end task-body -->\n"
    );

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("edge_endpoint_type_invalid");
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects manifest paths that escape the package directory", async () => {
    const { root } = await createWorkspaceWithPackage(
      {
        version: "plan-package/v0",
        project: { title: "Project", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        global_prompt: "../outside.md",
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Task",
            prompt: "../T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: false, locks: [] }
          }
        ],
        edges: []
      },
      "<!-- planweave:user:start task-body -->\nDo it.\n<!-- planweave:user:end task-body -->\n"
    );

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("package_path_outside");
    delete process.env.PLANWEAVE_HOME;
  });

  it("warns about orphan results for tasks no longer in the manifest", async () => {
    const { root, init } = await createWorkspaceWithPackage(
      {
        version: "plan-package/v0",
        project: { title: "Project", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        global_prompt: "global-prompt.md",
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Task",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: false, locks: [] }
          }
        ],
        edges: []
      },
      "<!-- planweave:user:start task-body -->\nDo it.\n<!-- planweave:user:end task-body -->\n"
    );
    await mkdir(join(init.workspace.resultsDir, "T-ORPHAN"), { recursive: true });
    await writeFile(join(init.workspace.resultsDir, "T-ORPHAN", "index.json"), "{}", "utf8");

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: "orphan_result", path: join(init.workspace.resultsDir, "T-ORPHAN") })
    );
    delete process.env.PLANWEAVE_HOME;
  });
});
