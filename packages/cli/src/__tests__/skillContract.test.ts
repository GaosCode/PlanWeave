import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("agent skill contract docs", () => {
  it("documents cross-platform PlanWeave home and package path discovery in plan-importer", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-importer/SKILL.md"), "utf8");

    expect(skill).toContain("Do not create or write `./.planweave` inside the target project by hand.");
    expect(skill).toContain("PLANWEAVE_HOME");
    expect(skill).toContain("macOS: `~/.planweave`");
    expect(skill).toContain("Linux: `~/.planweave`");
    expect(skill).toContain("Windows: `%USERPROFILE%\\.planweave`");
    expect(skill).toContain("<pw> paths --json");
    expect(skill).toContain("workspace.packageDir");
    expect(skill).toContain("project-graph.json");
    expect(skill).toContain("Treat CLI-returned project/workspace and package directories as the only writable PlanWeave locations.");
  });

  it("documents importer task-only defaults, prompt placement, and canvas/review strategy", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-importer/SKILL.md"), "utf8");

    expect(skill).toContain("Do not create context nodes.");
    expect(skill).toContain("Put goals, requirements, constraints, risks, references, and architecture gates into project/global prompt");
    expect(skill).toContain("Do not write rendered prompt output back into source prompt files.");
    expect(skill).toContain("Prompt Placement");
    expect(skill).toContain("100+ tasks/nodes");
    expect(skill).toContain("formal `project-graph.json` plus one `manifest.json` per canvas");
    expect(skill).toContain("explicit `crossTaskEdges`");
    expect(skill).toContain("Do not add review blocks for simple docs");
    expect(skill).toContain("Do not split for the sake of splitting.");
  });

  it("documents importer plan quality checks before writing the package", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-importer/SKILL.md"), "utf8");

    expect(skill).toContain("Run the Plan Quality Gate below before writing.");
    expect(skill).toContain("Identify core objects and trace create");
    expect(skill).toContain("Keep schema, types, APIs, CLI flags, events, files, and prompt inputs/outputs consistent");
    expect(skill).toContain("Reject fake completion");
    expect(skill).toContain("canvas-level order must be encoded as formal project graph edges");
    expect(skill).toContain("Complex blocks must encode architecture boundaries");
    expect(skill).toContain("Do not copy other projects' skills");
    expect(skill).toContain("Separate plan defects from PlanWeave toolchain defects in the report.");
  });

  it("documents plan-maker as a focused draft-planning skill before a package exists", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-maker/SKILL.md"), "utf8");

    expect(skill).toContain("Use when the user asks to make, draft, design, break down, or plan PlanWeave work");
    expect(skill).toContain("Do not execute work, audit an existing package, or write a Plan Package unless the user explicitly asks.");
    expect(skill).toContain("If strong source docs exist, prefer `plan-importer` instead of this skill.");
    expect(skill).toContain("Design around core object lifecycles");
    expect(skill).toContain("Do not import other projects' skills");
    expect(skill).toContain("model orchestration as a formal project graph");
    expect(skill).toContain("## Project Graph");
    expect(skill).toContain("formal graph dependencies must not exist only in prose");
    expect(skill).toContain("complex blocks must include architecture boundaries");
    expect(skill).toContain("## Task Graph");
    expect(skill).toContain("This skill produces a plan draft, not runtime state.");
  });

  it("documents execution-stage skill split for coordinator, reviewer, and recovery", async () => {
    const coordinator = await readFile(join(repoRoot, "skills/plan-coordinator/SKILL.md"), "utf8");
    const reviewer = await readFile(join(repoRoot, "skills/plan-reviewer/SKILL.md"), "utf8");
    const recovery = await readFile(join(repoRoot, "skills/plan-recovery/SKILL.md"), "utf8");

    expect(coordinator).toContain("Use when orchestrating a full PlanWeave plan");
    expect(coordinator).toContain("Run preflight: confirm `PLANWEAVE_HOME`, project id, project graph path when present, package/canvas paths");
    expect(coordinator).toContain("Treat PlanWeave skills as execution roles for worker subagents.");
    expect(coordinator).toContain("Use skill: plan-runner");
    expect(coordinator).toContain("Assign `plan-runner` to a worker subagent for one implementation block");
    expect(coordinator).toContain("Assign `plan-reviewer` to a worker subagent for one review gate");
    expect(coordinator).toContain("Assign `plan-recovery` to a worker subagent or run recovery commands yourself only for doctor findings");
    expect(coordinator).toContain("claim ownership: `already claimed` or `claim required`");
    expect(coordinator).toContain("Different canvases are not automatically parallel");
    expect(coordinator).toContain("formal project graph canvas edges and explicit `crossTaskEdges`");
    expect(coordinator).toContain("Do not dispatch downstream canvas work while upstream canvas blockers or explicit cross-task blockers remain incomplete.");
    expect(coordinator).toContain("Do not inject other projects' skills");
    expect(coordinator).toContain("Surface inherited prompt sources before dispatching");
    expect(coordinator).toContain("If the active tool exposes close, archive, or stop controls for subagents, close completed, failed, or idle subagents after their report is captured.");
    expect(coordinator).toContain("Treat `doctor` as a state/results consistency probe, not a general plan repair tool.");
    expect(reviewer).toContain("do not implement fixes, claim new work, coordinate the plan, or repair runtime state");
    expect(reviewer).toContain("Do not run `claim-next`");
    expect(reviewer).toContain("submit only if the coordinator explicitly asked you to submit");
    expect(reviewer).toContain("Do not encode blocked, diverged, missing evidence, or tool failure as a review verdict");
    expect(recovery).toContain("Do not perform normal implementation or review work.");
    expect(recovery).toContain("`doctor --repair` is not a general plan repair tool.");
    expect(recovery).toContain("schema-invalid package structure");
    expect(recovery).toContain("invalid project graph");
    expect(recovery).toContain("planweave schema project/manifest/state/layout");
    expect(recovery).toContain("For plan defects, report `NEEDS_PLAN_UPDATE`");
    expect(recovery).toContain("verdict: `RECOVERED`, `NEEDS_PLAN_UPDATE`, or `BLOCKED`.");
  });

  it("documents runner as assigned implementation block execution", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-runner/SKILL.md"), "utf8");

    expect(skill).toContain("Use this skill after the coordinator assigns one implementation block.");
    expect(skill).toContain("Focus on completing that block precisely");
    expect(skill).toContain("If any required item is missing, ask the coordinator for it instead of claiming other work.");
    expect(skill).toContain("Do not execute review gates; use `plan-reviewer`.");
    expect(skill).toContain("Do not create feedback blocks");
  });

  it("documents runner claim boundaries, quality gate, and reporting", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-runner/SKILL.md"), "utf8");

    expect(skill).toContain("claim ownership: usually `already claimed`");
    expect(skill).toContain("If ownership is `already claimed`, do not run `claim` or `claim-next`");
    expect(skill).toContain("submit only if the coordinator explicitly asked you to submit");
    expect(skill).toContain("Do not treat mock, dry-run, fixture-only tests, or uncalled APIs as live completion");
    expect(skill).toContain("return `NEEDS_COORDINATOR`");
    expect(skill).toContain("Do not coordinate multiple blocks, canvases, or subagents; use `plan-coordinator`.");
  });

  it("documents plan-auditor as a focused PlanWeave plan review skill", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-auditor/SKILL.md"), "utf8");

    expect(skill).toContain("Use when auditing, reviewing, checking, or challenging a PlanWeave plan before execution.");
    expect(skill).toContain("Do not import a new plan, execute blocks, repair state, or rewrite the package");
    expect(skill).toContain("Before judging task completeness");
    expect(skill).toContain("Flow Coverage table before findings.");
    expect(skill).toContain("| Flow | Trigger/Input | Core Processing | External Dependency | State/Storage | Interface/Consumer | Output/Side Effect | Failure Path | Verification | Gaps |");
    expect(skill).toContain("### Data Flow Coverage");
    expect(skill).toContain("Do not let a long task list count as coverage when the end-to-end flow is broken.");
    expect(skill).toContain("Core Object Lifecycle");
    expect(skill).toContain("schema without runtime use");
    expect(skill).toContain("Read `project-graph.json` when present");
    expect(skill).toContain("cross-canvas task blockers must be explicit `crossTaskEdges`");
    expect(skill).toContain("Compare suspicious project graph, manifest, state, and layout structure against `planweave schema project`");
    expect(skill).toContain("Check that prompt placement summary identifies global/project/task/block source of truth.");
    expect(skill).toContain("Flag copied skills");
    expect(skill).toContain("Separate plan design defects from PlanWeave toolchain defects.");
    expect(skill).toContain("End with the recommended revision order.");
  });
});
