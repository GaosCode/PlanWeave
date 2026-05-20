import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { addEdge, addNode, affectedTasksForPackageFileChange, removeEdge, updateNode, updatePromptSurface } from "../graph/editGraph.js";
import { readJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { createPackageWorkspace } from "./promptTestHelpers.js";

const taskBody = "<!-- planweave:user:start task-body -->\nSecond body.\n<!-- planweave:user:end task-body -->\n";

describe("graph edit APIs", () => {
  it("writes structured node and edge edits back to manifest.json", async () => {
    const { root, init } = await createPackageWorkspace();

    const nodeResult = await addNode({
      projectRoot: root,
      node: {
        id: "T-002",
        type: "task",
        title: "Second task",
        prompt: "nodes/T-002.prompt.md",
        acceptance: ["done"],
        parallel: { safe: true, locks: [] }
      },
      promptMarkdown: taskBody
    });
    const edgeResult = await addEdge({
      projectRoot: root,
      edge: { from: "T-002", to: "T-001", type: "depends_on" }
    });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    expect(nodeResult).toMatchObject({ ok: true, affectedTasks: ["T-002"] });
    expect(edgeResult).toMatchObject({ ok: true });
    expect(edgeResult.affectedTasks).toEqual(["T-002", "T-001"]);
    expect(edgeResult.graph?.dependenciesByTask.get("T-002")).toEqual(["T-001"]);
    expect(edgeResult.graph?.dependentsByTask.get("T-001")).toEqual(["T-002"]);
    expect(edgeResult.graph?.reachable("T-002", "T-001")).toBe(true);
    expect(manifest.nodes.map((node) => node.id)).toContain("T-002");
    expect(manifest.edges).toContainEqual({ from: "T-002", to: "T-001", type: "depends_on" });
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects a dependency edge that would create a cycle", async () => {
    const { root } = await createPackageWorkspace();
    await addNode({
      projectRoot: root,
      node: {
        id: "T-002",
        type: "task",
        title: "Second task",
        prompt: "nodes/T-002.prompt.md",
        acceptance: ["done"],
        parallel: { safe: true, locks: [] }
      },
      promptMarkdown: taskBody
    });
    await addEdge({ projectRoot: root, edge: { from: "T-002", to: "T-001", type: "depends_on" } });

    const result = await addEdge({ projectRoot: root, edge: { from: "T-001", to: "T-002", type: "depends_on" } });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("depends_on_cycle");
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects non-dependency edges with invalid endpoint types before writing manifest.json", async () => {
    const { root, init } = await createPackageWorkspace();

    const result = await addEdge({
      projectRoot: root,
      edge: { from: "G-001", to: "T-001", type: "implements" }
    });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("edge_endpoint_type_invalid");
    expect(manifest.edges).not.toContainEqual({ from: "G-001", to: "T-001", type: "implements" });
    delete process.env.PLANWEAVE_HOME;
  });

  it("updates only the task-body user section in a Prompt Surface", async () => {
    const { root, init } = await createPackageWorkspace();

    const result = await updatePromptSurface({ projectRoot: root, taskId: "T-001", taskBody: "Updated body." });
    const prompt = await readFile(`${init.workspace.packageDir}/nodes/T-001.prompt.md`, "utf8");

    expect(result).toMatchObject({ ok: true, affectedTasks: ["T-001"], diagnostics: [] });
    expect(result.graph?.nodesById.get("T-001")?.type).toBe("task");
    expect(prompt).toContain("Updated body.");
    expect(prompt).toContain("<!-- planweave:user:start task-body -->");
    delete process.env.PLANWEAVE_HOME;
  });

  it("removes a structured edge and reports affected tasks", async () => {
    const { root, init } = await createPackageWorkspace();
    await addNode({
      projectRoot: root,
      node: {
        id: "T-002",
        type: "task",
        title: "Second task",
        prompt: "nodes/T-002.prompt.md",
        acceptance: ["done"],
        parallel: { safe: true, locks: [] }
      },
      promptMarkdown: taskBody
    });
    await addEdge({ projectRoot: root, edge: { from: "T-002", to: "T-001", type: "depends_on" } });

    const result = await removeEdge({ projectRoot: root, edge: { from: "T-002", to: "T-001", type: "depends_on" } });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    expect(result).toMatchObject({ ok: true, affectedTasks: ["T-002", "T-001"] });
    expect(manifest.edges).not.toContainEqual({ from: "T-002", to: "T-001", type: "depends_on" });
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects a structured edit before it can create an invalid package", async () => {
    const { root, init } = await createPackageWorkspace();

    const result = await addNode({
      projectRoot: root,
      node: {
        id: "T-002",
        type: "task",
        title: "Second task",
        prompt: "nodes/T-002.prompt.md",
        acceptance: ["done"],
        parallel: { safe: true, locks: [] }
      }
    });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("prompt_missing");
    expect(manifest.nodes.map((node) => node.id)).not.toContain("T-002");
    delete process.env.PLANWEAVE_HOME;
  });

  it("normalizes schema defaults before writing a structured node edit", async () => {
    const { root, init } = await createPackageWorkspace();
    const node = JSON.parse(
      JSON.stringify({
        id: "T-002",
        type: "task",
        title: "Second task",
        prompt: "nodes/T-002.prompt.md",
        acceptance: ["done"]
      })
    );

    const result = await addNode({ projectRoot: root, node, promptMarkdown: taskBody });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const writtenNode = manifest.nodes.find((item) => item.id === "T-002");

    expect(result).toMatchObject({ ok: true, affectedTasks: ["T-002"] });
    expect(writtenNode).toMatchObject({ parallel: { safe: false, locks: [] } });
    expect(result.graph?.locksByTask.get("T-002")).toEqual(new Set());
    delete process.env.PLANWEAVE_HOME;
  });

  it("creates prompt parent directories before writing a structured task node", async () => {
    const { root, init } = await createPackageWorkspace();

    const result = await addNode({
      projectRoot: root,
      node: {
        id: "T-NESTED",
        type: "task",
        title: "Nested task",
        prompt: "missing/T-NESTED.prompt.md",
        acceptance: ["done"],
        parallel: { safe: true, locks: [] }
      },
      promptMarkdown: taskBody
    });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const prompt = await readFile(`${init.workspace.packageDir}/missing/T-NESTED.prompt.md`, "utf8");

    expect(result).toMatchObject({ ok: true, affectedTasks: ["T-NESTED"] });
    expect(manifest.nodes.map((item) => item.id)).toContain("T-NESTED");
    expect(prompt).toContain("Second body.");
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects a task prompt write failure before writing manifest.json", async () => {
    const { root, init } = await createPackageWorkspace();
    await writeFile(`${init.workspace.packageDir}/blocked`, "not a directory", "utf8");

    const result = await addNode({
      projectRoot: root,
      node: {
        id: "T-BAD",
        type: "task",
        title: "Bad task",
        prompt: "blocked/T-BAD.prompt.md",
        acceptance: ["done"],
        parallel: { safe: true, locks: [] }
      },
      promptMarkdown: taskBody
    });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("prompt_write_failed");
    expect(manifest.nodes.map((item) => item.id)).not.toContain("T-BAD");
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects schema-invalid node edits before writing manifest.json", async () => {
    const { root, init } = await createPackageWorkspace();
    const node = JSON.parse(
      JSON.stringify({
        id: "T-BAD",
        type: "task",
        title: "Bad task",
        prompt: "nodes/T-BAD.prompt.md",
        parallel: { safe: true, locks: [] }
      })
    );

    const result = await addNode({ projectRoot: root, node, promptMarkdown: taskBody });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("manifest_schema_invalid");
    expect(manifest.nodes.map((item) => item.id)).not.toContain("T-BAD");
    delete process.env.PLANWEAVE_HOME;
  });

  it("normalizes schema defaults before writing a structured node update", async () => {
    const { root, init } = await createPackageWorkspace();
    const node = JSON.parse(
      JSON.stringify({
        id: "T-001",
        type: "task",
        title: "Updated task",
        prompt: "nodes/T-001.prompt.md",
        acceptance: ["done"]
      })
    );

    const result = await updateNode({ projectRoot: root, node });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const writtenNode = manifest.nodes.find((item) => item.id === "T-001");

    expect(result).toMatchObject({ ok: true, affectedTasks: ["T-001"] });
    expect(writtenNode).toMatchObject({ title: "Updated task", parallel: { safe: false, locks: [] } });
    expect(result.graph?.locksByTask.get("T-001")).toEqual(new Set());
    delete process.env.PLANWEAVE_HOME;
  });

  it("computes affected tasks for file-level manifest and global prompt changes", () => {
    const before: PlanPackageManifest = {
      version: "plan-package/v0",
      project: { title: "Project", description: "" },
      execution: { parallel: { enabled: false, maxConcurrent: 1 } },
      global_prompt: "global-prompt.md",
      nodes: [
        { id: "G-001", type: "goal", title: "Goal", summary: "Goal summary." },
        {
          id: "T-001",
          type: "task",
          title: "First",
          prompt: "nodes/T-001.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        },
        {
          id: "T-002",
          type: "task",
          title: "Second",
          prompt: "nodes/T-002.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        }
      ],
      edges: [{ from: "T-001", to: "G-001", type: "implements" }]
    };
    const after: PlanPackageManifest = {
      ...before,
      edges: [...before.edges, { from: "T-002", to: "T-001", type: "depends_on" }]
    };

    expect(affectedTasksForPackageFileChange({ kind: "manifest", before, after })).toMatchObject({
      ok: true,
      affectedTasks: ["T-002", "T-001"],
      fullRefresh: false
    });
    expect(affectedTasksForPackageFileChange({ kind: "global-prompt", manifest: after }).affectedTasks).toEqual([
      "T-001",
      "T-002"
    ]);
  });

  it("uses an existing graph for file-level manifest changes and updates it in place", () => {
    const before: PlanPackageManifest = {
      version: "plan-package/v0",
      project: { title: "Project", description: "" },
      execution: { parallel: { enabled: false, maxConcurrent: 1 } },
      global_prompt: "global-prompt.md",
      nodes: [
        { id: "G-001", type: "goal", title: "Goal", summary: "Goal summary." },
        {
          id: "T-001",
          type: "task",
          title: "First",
          prompt: "nodes/T-001.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        },
        {
          id: "T-002",
          type: "task",
          title: "Second",
          prompt: "nodes/T-002.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        }
      ],
      edges: [{ from: "T-001", to: "G-001", type: "implements" }]
    };
    const graph = compileTaskGraph(before);
    const after = {
      ...before,
      edges: [...before.edges, { from: "T-002", to: "T-001", type: "depends_on" as const }]
    };

    const result = affectedTasksForPackageFileChange({ kind: "manifest", before, after, graph });

    expect(result).toMatchObject({ ok: true, affectedTasks: ["T-002", "T-001"], fullRefresh: false });
    expect(result.graph).toBe(graph);
    expect(graph.dependenciesByTask.get("T-002")).toEqual(["T-001"]);
    expect(graph.reachable("T-002", "T-001")).toBe(true);
  });

  it("does not mutate the existing graph when a file-level manifest change is invalid", () => {
    const before: PlanPackageManifest = {
      version: "plan-package/v0",
      project: { title: "Project", description: "" },
      execution: { parallel: { enabled: false, maxConcurrent: 1 } },
      global_prompt: "global-prompt.md",
      nodes: [
        { id: "G-001", type: "goal", title: "Goal", summary: "Goal summary." },
        {
          id: "T-001",
          type: "task",
          title: "First",
          prompt: "nodes/T-001.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        }
      ],
      edges: [{ from: "T-001", to: "G-001", type: "implements" }]
    };
    const graph = compileTaskGraph(before);
    const after: PlanPackageManifest = {
      ...before,
      nodes: [
        ...before.nodes,
        {
          id: "T-002",
          type: "task",
          title: "Second",
          prompt: "nodes/T-002.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        }
      ],
      edges: [...before.edges, { from: "G-001", to: "T-002", type: "implements" }]
    };

    const result = affectedTasksForPackageFileChange({ kind: "manifest", before, after, graph });

    expect(result).toMatchObject({ ok: false, fullRefresh: true });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("edge_endpoint_type_invalid");
    expect(result.graph).not.toBe(graph);
    expect(graph.nodesById.has("T-002")).toBe(false);
    expect(graph.outgoingEdgesByNode.get("G-001")).toEqual([]);
  });

  it("rejects duplicate edges in file-level manifest changes before diff folding", () => {
    const before: PlanPackageManifest = {
      version: "plan-package/v0",
      project: { title: "Project", description: "" },
      execution: { parallel: { enabled: false, maxConcurrent: 1 } },
      global_prompt: "global-prompt.md",
      nodes: [
        { id: "G-001", type: "goal", title: "Goal", summary: "Goal summary." },
        {
          id: "T-001",
          type: "task",
          title: "First",
          prompt: "nodes/T-001.prompt.md",
          acceptance: ["done"],
          parallel: { safe: true, locks: [] }
        }
      ],
      edges: [{ from: "T-001", to: "G-001", type: "implements" }]
    };
    const graph = compileTaskGraph(before);
    const after: PlanPackageManifest = {
      ...before,
      edges: [...before.edges, { from: "T-001", to: "G-001", type: "implements" }]
    };

    const result = affectedTasksForPackageFileChange({ kind: "manifest", before, after, graph });

    expect(result).toMatchObject({ ok: false, fullRefresh: true });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("edge_duplicate");
    expect(result.graph).not.toBe(graph);
    expect(graph.outgoingEdgesByNode.get("T-001")).toEqual(before.edges);
  });
});
