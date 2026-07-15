import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateGraphQuality } from "../graph/validateGraphQuality.js";
import type { ManifestTaskNode, PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

function findDiagnostic(result: Awaited<ReturnType<typeof validateGraphQuality>>, code: string) {
  return result.diagnostics.find((diagnostic) => diagnostic.code === code);
}

function withoutReview(manifest: PlanPackageManifest): PlanPackageManifest {
  return {
    ...manifest,
    nodes: manifest.nodes.map((task) => ({
      ...task,
      blocks: task.blocks.filter((block) => block.type !== "review")
    }))
  };
}

function withoutImplementation(manifest: PlanPackageManifest): PlanPackageManifest {
  return {
    ...manifest,
    nodes: manifest.nodes.map((task) => ({
      ...task,
      blocks: task.blocks.filter((block) => block.type !== "implementation")
    }))
  };
}

function reviewWithoutDependency(manifest: PlanPackageManifest): PlanPackageManifest {
  return {
    ...manifest,
    nodes: manifest.nodes.map((task) => ({
      ...task,
      blocks: task.blocks.map((block) =>
        block.type === "review" ? { ...block, depends_on: [] } : block
      )
    }))
  };
}

function taskFromTemplate(index: number): ManifestTaskNode {
  const id = `T-${String(index).padStart(3, "0")}`;
  return {
    id,
    type: "task",
    title: `Task ${index}`,
    prompt: `nodes/${id}/prompt.md`,
    acceptance: [`Task ${index} is implemented.`],
    blocks: [
      {
        id: "B-001",
        type: "implementation",
        title: `Implement task ${index}`,
        prompt: `nodes/${id}/blocks/B-001.prompt.md`,
        depends_on: [],
        parallel: { sharedResources: [`task-${index}`] }
      },
      {
        id: "R-001",
        type: "review",
        title: `Review task ${index}`,
        prompt: `nodes/${id}/blocks/R-001.prompt.md`,
        depends_on: ["B-001"],
        review: {
          required: true,
          maxFeedbackCycles: 1,
          hook: null
        }
      }
    ]
  };
}

function gateTask(): ManifestTaskNode {
  return {
    id: "QUALITY-GATE",
    type: "task",
    title: "Quality Gate",
    prompt: "nodes/QUALITY-GATE/prompt.md",
    acceptance: ["The canvas is ready to pass the gate."],
    blocks: [
      {
        id: "B-001",
        type: "implementation",
        title: "Run quality gate",
        prompt: "nodes/QUALITY-GATE/blocks/B-001.prompt.md",
        depends_on: [],
        parallel: { sharedResources: ["quality-gate"] }
      },
      {
        id: "R-001",
        type: "review",
        title: "Review quality gate",
        prompt: "nodes/QUALITY-GATE/blocks/R-001.prompt.md",
        depends_on: ["B-001"],
        review: {
          required: true,
          maxFeedbackCycles: 1,
          hook: null
        }
      }
    ]
  };
}

function investigateTask(): ManifestTaskNode {
  const task = taskFromTemplate(3);
  return {
    ...task,
    id: "INVESTIGATE",
    title: "Investigate issue",
    prompt: "nodes/INVESTIGATE/prompt.md",
    acceptance: ["Investigation is complete."],
    blocks: task.blocks.map((block) => ({
      ...block,
      prompt: `nodes/INVESTIGATE/blocks/${block.id}.prompt.md`
    }))
  };
}

function manifestWithGate(gateDependencies: string[]): PlanPackageManifest {
  const manifest = basicManifest({ includeSecondTask: true });
  return {
    ...manifest,
    nodes: [...manifest.nodes, gateTask()],
    edges: gateDependencies.map((taskId) => ({
      from: "QUALITY-GATE",
      to: taskId,
      type: "depends_on" as const
    }))
  };
}

function sparseManifest(taskCount: number): PlanPackageManifest {
  return {
    ...basicManifest(),
    nodes: Array.from({ length: taskCount }, (_, index) => taskFromTemplate(index + 1)),
    edges: []
  };
}

describe("validateGraphQuality", () => {
  it("reports tasks missing implementation blocks as structural errors", async () => {
    const { root } = await createTestWorkspace(withoutImplementation(basicManifest()));

    const result = await validateGraphQuality({ projectRoot: root });

    expect(result.ok).toBe(false);
    expect(findDiagnostic(result, "task_missing_implementation_block")).toMatchObject({
      severity: "error",
      ruleType: "structural",
      affectedIds: ["T-001"]
    });
  });

  it("reports compile graph errors as structural quality errors", async () => {
    const manifest = basicManifest();
    const { root } = await createTestWorkspace({
      ...manifest,
      edges: [{ from: "T-001", to: "MISSING", type: "depends_on" }]
    });

    const result = await validateGraphQuality({ projectRoot: root });

    expect(result.ok).toBe(false);
    expect(result.summary.errorCount).toBeGreaterThan(0);
    expect(findDiagnostic(result, "edge_to_missing")).toMatchObject({
      severity: "error",
      ruleType: "structural"
    });
  });

  it("reports compile graph warnings without failing quality", async () => {
    const { init, root } = await createTestWorkspace();
    await mkdir(join(init.workspace.packageDir, "nodes", "T-STALE"), { recursive: true });
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-STALE", "prompt.md"),
      "# stale prompt\n",
      "utf8"
    );

    const result = await validateGraphQuality({
      projectRoot: root,
      reviewPolicy: "none",
      heuristics: "off"
    });

    expect(result.ok).toBe(true);
    expect(result.summary.warningCount).toBeGreaterThan(0);
    expect(findDiagnostic(result, "stale_prompt_reference")).toMatchObject({
      severity: "warning",
      ruleType: "structural"
    });
  });

  it("reports review blocks that do not depend on implementation work and honors strict mode", async () => {
    const { root } = await createTestWorkspace(reviewWithoutDependency(basicManifest()));

    const loose = await validateGraphQuality({ projectRoot: root });
    const strict = await validateGraphQuality({ projectRoot: root, strict: true });

    expect(loose.ok).toBe(true);
    expect(findDiagnostic(loose, "review_missing_implementation_dependency")).toMatchObject({
      severity: "warning",
      affectedIds: ["T-001#R-001"]
    });
    expect(strict.ok).toBe(false);
    expect(findDiagnostic(strict, "review_missing_implementation_dependency")).toMatchObject({
      severity: "error"
    });
  });

  it("reports orphaned tasks only for multi-task graphs", async () => {
    const single = await createTestWorkspace();
    const multi = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    const singleResult = await validateGraphQuality({ projectRoot: single.init.workspace });
    const multiResult = await validateGraphQuality({ projectRoot: multi.init.workspace });

    expect(findDiagnostic(singleResult, "task_orphaned")).toBeUndefined();
    expect(findDiagnostic(multiResult, "task_orphaned")).toMatchObject({
      severity: "warning",
      affectedIds: ["T-001", "T-002"]
    });
  });

  it("applies review policy without forcing review warnings when policy is none", async () => {
    const { root } = await createTestWorkspace(withoutReview(basicManifest()));

    const none = await validateGraphQuality({ projectRoot: root, reviewPolicy: "none" });
    const riskBased = await validateGraphQuality({ projectRoot: root, reviewPolicy: "risk-based" });
    const required = await validateGraphQuality({ projectRoot: root, reviewPolicy: "required" });
    const requiredStrict = await validateGraphQuality({
      projectRoot: root,
      reviewPolicy: "required",
      strict: true
    });

    expect(findDiagnostic(none, "task_missing_review_block")).toBeUndefined();
    expect(findDiagnostic(riskBased, "task_missing_review_block")).toMatchObject({
      severity: "info"
    });
    expect(findDiagnostic(required, "task_missing_review_block")).toMatchObject({
      severity: "warning"
    });
    expect(requiredStrict.ok).toBe(false);
    expect(findDiagnostic(requiredStrict, "task_missing_review_block")).toMatchObject({
      severity: "error"
    });
  });

  it("reports sparse dependency heuristics only above the configured threshold", async () => {
    const large = await createTestWorkspace(sparseManifest(4));
    const small = await createTestWorkspace(sparseManifest(3));

    const largeResult = await validateGraphQuality({ projectRoot: large.init.workspace });
    const disabledResult = await validateGraphQuality({
      projectRoot: large.init.workspace,
      heuristics: "off"
    });
    const smallResult = await validateGraphQuality({ projectRoot: small.init.workspace });

    expect(findDiagnostic(largeResult, "graph_sparse_dependencies")).toMatchObject({
      severity: "warning",
      ruleType: "heuristic",
      count: 4
    });
    expect(findDiagnostic(disabledResult, "graph_sparse_dependencies")).toBeUndefined();
    expect(findDiagnostic(smallResult, "graph_sparse_dependencies")).toBeUndefined();
  });

  it("reports a missing canvas gate only when gate policy requires one", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    const policyNone = await validateGraphQuality({
      projectRoot: root,
      gatePolicy: "none",
      reviewPolicy: "none",
      heuristics: "off"
    });
    const required = await validateGraphQuality({
      projectRoot: root,
      gatePolicy: "required",
      reviewPolicy: "none",
      heuristics: "off"
    });
    const requiredStrict = await validateGraphQuality({
      projectRoot: root,
      gatePolicy: "required",
      reviewPolicy: "none",
      heuristics: "off",
      strict: true
    });

    expect(findDiagnostic(policyNone, "canvas_gate_missing")).toBeUndefined();
    expect(required.ok).toBe(true);
    expect(findDiagnostic(required, "canvas_gate_missing")).toMatchObject({
      severity: "warning",
      ruleType: "policy",
      affectedIds: ["canvas"]
    });
    expect(requiredStrict.ok).toBe(false);
    expect(findDiagnostic(requiredStrict, "canvas_gate_missing")).toMatchObject({
      severity: "error"
    });
  });

  it("reports gate tasks that do not directly depend on every non-gate task", async () => {
    const { root } = await createTestWorkspace(manifestWithGate(["T-001"]));

    const loose = await validateGraphQuality({
      projectRoot: root,
      gatePolicy: "none",
      reviewPolicy: "none",
      heuristics: "off"
    });
    const strict = await validateGraphQuality({
      projectRoot: root,
      gatePolicy: "none",
      reviewPolicy: "none",
      heuristics: "off",
      strict: true
    });

    expect(loose.ok).toBe(true);
    expect(findDiagnostic(loose, "canvas_gate_incomplete_dependencies")).toMatchObject({
      severity: "warning",
      ruleType: "structural",
      affectedIds: ["QUALITY-GATE->T-002"]
    });
    expect(strict.ok).toBe(false);
    expect(findDiagnostic(strict, "canvas_gate_incomplete_dependencies")).toMatchObject({
      severity: "error"
    });
  });

  it("does not treat INVESTIGATE as a gate task", async () => {
    const manifest = basicManifest();
    const { root } = await createTestWorkspace({
      ...manifest,
      nodes: [...manifest.nodes, investigateTask()],
      edges: []
    });

    const result = await validateGraphQuality({
      projectRoot: root,
      gatePolicy: "none",
      reviewPolicy: "none",
      heuristics: "off"
    });

    expect(findDiagnostic(result, "canvas_gate_incomplete_dependencies")).toBeUndefined();
  });

  it("accepts a gate task with complete non-gate dependencies", async () => {
    const { root } = await createTestWorkspace(manifestWithGate(["T-001", "T-002"]));

    const result = await validateGraphQuality({
      projectRoot: root,
      gatePolicy: "required",
      reviewPolicy: "none",
      heuristics: "off"
    });

    expect(findDiagnostic(result, "canvas_gate_missing")).toBeUndefined();
    expect(findDiagnostic(result, "canvas_gate_incomplete_dependencies")).toBeUndefined();
  });

  it("reports review gates with no feedback cycles", async () => {
    const { root } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));

    const loose = await validateGraphQuality({ projectRoot: root, reviewPolicy: "required" });
    const strict = await validateGraphQuality({
      projectRoot: root,
      reviewPolicy: "required",
      strict: true
    });

    expect(loose.ok).toBe(true);
    expect(findDiagnostic(loose, "review_loop_cycles_missing")).toMatchObject({
      severity: "warning",
      suggestedTool: "set_review_pipeline",
      fixId: "enable_review_feedback_cycles"
    });
    expect(strict.ok).toBe(false);
    expect(findDiagnostic(strict, "review_loop_cycles_missing")).toMatchObject({
      severity: "error"
    });
  });

  it("reports large flat layouts, weak acceptance criteria, and duplicate block prompts as heuristics", async () => {
    const manifest = sparseManifest(10);
    manifest.nodes[0].acceptance = ["done"];
    const { init, root } = await createTestWorkspace(manifest);
    const duplicatePrompt = "# Shared prompt\n";
    await writeFile(
      join(init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      duplicatePrompt,
      "utf8"
    );
    await writeFile(
      join(init.workspace.packageDir, "nodes/T-002/blocks/B-001.prompt.md"),
      duplicatePrompt,
      "utf8"
    );
    await writeFile(
      join(init.workspace.packageDir, "nodes/T-003/blocks/B-001.prompt.md"),
      duplicatePrompt,
      "utf8"
    );

    const result = await validateGraphQuality({ projectRoot: root });

    expect(findDiagnostic(result, "layout_single_column_risk")).toMatchObject({
      severity: "info",
      suggestedTool: "bulk_add_task_dependencies",
      fixId: "apply_canvas_lane_layout"
    });
    expect(findDiagnostic(result, "acceptance_too_weak")).toMatchObject({
      severity: "info",
      affectedIds: ["T-001"],
      suggestedTool: "update_task_acceptance",
      fixId: "strengthen_acceptance_criteria"
    });
    expect(findDiagnostic(result, "prompt_duplicate_many")).toMatchObject({
      severity: "info",
      affectedIds: expect.arrayContaining(["T-001#B-001", "T-002#B-001", "T-003#B-001"]),
      suggestedTool: "write_prompt_source"
    });
  });

  it("reports unreadable prompt files during heuristic checks instead of hiding them", async () => {
    const manifest = basicManifest();
    const { init, root } = await createTestWorkspace(manifest);
    await rm(join(init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"));

    const result = await validateGraphQuality({ projectRoot: root, reviewPolicy: "none" });

    expect(result.ok).toBe(false);
    expect(findDiagnostic(result, "prompt_heuristic_read_failed")).toMatchObject({
      severity: "warning",
      affectedIds: ["T-001#B-001"],
      suggestedTool: "validate_project"
    });
  });
});
