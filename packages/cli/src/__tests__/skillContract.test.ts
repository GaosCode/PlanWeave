import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("agent skill contract docs", () => {
  it("documents cross-platform PlanWeave home and package path discovery in plan-importer", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-importer/SKILL.md"), "utf8");

    expect(skill).toContain(
      "Do not create or write `./.planweave` inside the target project by hand."
    );
    expect(skill).toContain("PLANWEAVE_HOME");
    expect(skill).toContain("macOS: `~/.planweave`");
    expect(skill).toContain("Linux: `~/.planweave`");
    expect(skill).toContain("Windows: `%USERPROFILE%\\.planweave`");
    expect(skill).toContain("<pw> paths --json");
    expect(skill).toContain("package directories under that workspace");
    expect(skill).toContain("project-graph.json");
    expect(skill).toContain(
      "Treat CLI-returned project/workspace and package directories as the only writable PlanWeave locations."
    );
    expect(skill).toContain("Plan File Editing Boundary");
    expect(skill).toContain("Use CLI/runtime commands for mechanical workspace operations");
    expect(skill).toContain(
      "Edit Plan Package semantic files directly inside CLI-returned workspace paths"
    );
  });

  it("documents importer task-only defaults, prompt placement, and canvas/review strategy", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-importer/SKILL.md"), "utf8");

    expect(skill).toContain("Do not create context nodes.");
    expect(skill).toContain(
      "Put goals, requirements, constraints, risks, references, and architecture gates into project/global prompt"
    );
    expect(skill).toContain("Do not write rendered prompt output back into source prompt files.");
    expect(skill).toContain("Prompt Placement");
    expect(skill).toContain("100+ tasks/nodes");
    expect(skill).toContain("formal `project-graph.json` plus one `manifest.json` per canvas");
    expect(skill).toContain("explicit `crossTaskEdges`");
    expect(skill).toContain("Default imported multi-canvas plans to `crossTaskEdges: []`");
    expect(skill).toContain("canvas-boundary defect");
    expect(skill).toContain("Do not add review blocks for simple docs");
    expect(skill).toContain("Do not split for the sake of splitting.");
  });

  it("documents importer plan quality checks before writing the package", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-importer/SKILL.md"), "utf8");

    expect(skill).toContain("Run the Plan Quality Gate below before writing.");
    expect(skill).toContain("Default imported multi-canvas plans to `crossTaskEdges: []`");
    expect(skill).toContain("canvas-boundary defect");
    expect(skill).toContain("Identify core objects and trace create");
    expect(skill).toContain(
      "Keep schema, types, APIs, CLI flags, events, files, and prompt inputs/outputs consistent"
    );
    expect(skill).toContain("Reject fake completion");
    expect(skill).toContain("canvas-level order must be encoded as formal project graph edges");
    expect(skill).toContain("Complex blocks must encode architecture boundaries");
    expect(skill).toContain("Do not copy other projects' skills");
    expect(skill).toContain(
      "Separate plan defects from PlanWeave toolchain defects in the report."
    );
  });

  it("documents plan-maker as a focused draft-planning skill before a package exists", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-maker/SKILL.md"), "utf8");

    expect(skill).toContain(
      "Use when the user asks to make, draft, design, break down, or plan PlanWeave work"
    );
    expect(skill).toContain(
      "Do not execute work, audit an existing package, or write a Plan Package unless the user explicitly asks to materialize the plan."
    );
    expect(skill).toContain(
      "If strong source docs exist and the main job is converting them into a Plan Package, use `plan-importer`."
    );
    expect(skill).toContain("Design around core object lifecycles");
    expect(skill).toContain("Do not import other projects' skills");
    expect(skill).toContain("model orchestration as a formal project graph");
    expect(skill).toContain("## Project Graph");
    expect(skill).toContain("Default multi-canvas drafts to `crossTaskEdges: []`");
    expect(skill).toContain("canvas-boundary defect");
    expect(skill).toContain("formal graph dependencies must not exist only in prose");
    expect(skill).toContain("complex blocks must include architecture boundaries");
    expect(skill).toContain("## Task Graph");
    expect(skill).toContain("package file plan rather than a new schema");
    expect(skill).toContain("The Markdown report is only an explanatory view.");
    expect(skill).toContain("This skill produces a package-shaped plan draft, not runtime state.");
    expect(skill).toContain(
      "A package-shaped plan draft can be validated or materialized directly when the user asks to write or materialize it."
    );
    expect(skill).toContain("Use CLI/runtime commands for mechanical workspace operations");
    expect(skill).toContain(
      "Edit Plan Package semantic files directly inside CLI-returned workspace paths"
    );
  });

  it("documents execution-stage skill split for coordinator, reviewer, and recovery", async () => {
    const coordinator = await readFile(join(repoRoot, "skills/plan-coordinator/SKILL.md"), "utf8");
    const reviewer = await readFile(join(repoRoot, "skills/plan-reviewer/SKILL.md"), "utf8");
    const recovery = await readFile(join(repoRoot, "skills/plan-recovery/SKILL.md"), "utf8");

    expect(coordinator).toContain("Use when orchestrating a full PlanWeave plan");
    expect(coordinator).toContain(
      "Run preflight: confirm `PLANWEAVE_HOME`, project id, project graph path when present, package/canvas paths"
    );
    expect(coordinator).toContain(
      "Treat PlanWeave skills as execution roles for worker subagents."
    );
    expect(coordinator).toContain(
      "Use `<pw> claim-next --dry-run --json` only for automatic preview; exact `claim <ref>` has no dry-run option."
    );
    expect(coordinator).toContain("claim-next --parallel --dry-run --json");
    expect(coordinator).toContain(
      "configured runner (CLI or ACP) owns the work: `<pw> run --once --scope block --block <ref>`"
    );
    expect(coordinator).toContain(
      "CLI and ACP are alternative runner transports behind the same `effectiveExecutor` route."
    );
    expect(coordinator).toContain(
      "inspect `<pw> run-status --json` and `<pw> run-session <session-id> --json`"
    );
    expect(coordinator).toContain("Never substitute CLI for ACP or ACP for CLI");
    expect(coordinator).toContain(
      "The selected agent owns login, subscription, provider configuration, quota, and optional API-key mode."
    );
    expect(coordinator).toContain("PlanWeave does not collect or store those credentials.");
    expect(coordinator).toContain(
      "Near-headless execution is bounded to the selected profile and declared runner capabilities"
    );
    expect(coordinator).toContain("never auto-approve requests");
    expect(coordinator).toContain("never fall back to another runner transport");
    expect(coordinator).toContain("Use skill: plan-runner");
    expect(coordinator).toContain(
      "Assign `plan-runner` to a worker subagent for one implementation block"
    );
    expect(coordinator).toContain(
      "Assign `plan-reviewer` to a worker subagent for one review gate"
    );
    expect(coordinator).toContain(
      "Assign `plan-recovery` to a worker subagent or run recovery commands yourself only for doctor findings"
    );
    expect(coordinator).toContain("claim ownership: `already claimed` or `claim required`");
    expect(coordinator).toContain("Different canvases are not automatically parallel");
    expect(coordinator).toContain(
      "formal project graph canvas edges and explicit `crossTaskEdges`"
    );
    expect(coordinator).toContain(
      "Do not dispatch downstream canvas work while upstream canvas blockers or explicit cross-task blockers remain incomplete."
    );
    expect(coordinator).toContain("Do not inject other projects' skills");
    expect(coordinator).toContain("Surface inherited prompt sources before dispatching");
    expect(coordinator).toContain(
      "If the active tool exposes close, archive, or stop controls for subagents, close completed, failed, or idle subagents after their report is captured."
    );
    expect(coordinator).toContain(
      "Treat `doctor` as a state/results consistency probe, not a general plan repair tool."
    );
    expect(coordinator).toContain("edit Plan Package files");
    expect(coordinator).toContain("for plan update handoffs, CLI-returned workspace paths");
    expect(coordinator).toContain(
      "stop dependent dispatch and hand off a Plan Package update instead of `doctor --repair`"
    );
    expect(coordinator).toContain(
      "must not directly edit `project-graph.json`, canvas `manifest.json`, or source prompt Markdown"
    );
    expect(reviewer).toContain(
      "do not implement fixes, claim new work, coordinate the plan, edit Plan Package files, or repair runtime state"
    );
    expect(reviewer).toContain("Do not run `claim-next`");
    expect(reviewer).toContain("submit only if the coordinator explicitly asked you to submit");
    expect(reviewer).toContain(
      "Use `NEEDS_COORDINATOR` for blocked work, divergence, missing evidence, tool failure, stale prompts, invalid acceptance, bad dependencies, or review-gate design defects."
    );
    expect(reviewer).toContain("Do not encode Plan Package defects as implementation feedback");
    expect(reviewer).toContain(
      "Do not edit implementation files, `project-graph.json`, canvas `manifest.json`, source prompt Markdown, `state.json`, or `results/`"
    );
    expect(recovery).toContain("Do not perform normal implementation or review work.");
    expect(recovery).toContain("`doctor --repair` is not a general plan repair tool.");
    expect(recovery).toContain("schema-invalid package structure");
    expect(recovery).toContain("invalid project graph");
    expect(recovery).toContain("planweave schema project/manifest/state/layout");
    expect(recovery).toContain("For plan defects, report `NEEDS_PLAN_UPDATE`");
    expect(recovery).toContain(
      "edit Plan Package semantic files directly inside CLI-returned workspace paths when the repair is a plan update"
    );
    expect(recovery).toContain("verdict: `RECOVERED`, `NEEDS_PLAN_UPDATE`, or `BLOCKED`.");
  });

  it("documents runner as assigned implementation block execution", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-runner/SKILL.md"), "utf8");

    expect(skill).toContain(
      "Use this skill after the coordinator assigns one implementation block."
    );
    expect(skill).toContain("Focus on completing that block precisely");
    expect(skill).toContain(
      "If any required item is missing, ask the coordinator for it instead of claiming other work."
    );
    expect(skill).toContain("Do not execute review gates; use `plan-reviewer`.");
    expect(skill).toContain("Do not create feedback blocks");
  });

  it("documents runner claim boundaries, quality gate, and reporting", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-runner/SKILL.md"), "utf8");

    expect(skill).toContain("claim ownership: usually `already claimed`");
    expect(skill).toContain(
      "If ownership is `already claimed`, do not run `claim` or `claim-next`"
    );
    expect(skill).toContain("submit only if the coordinator explicitly asked you to submit");
    expect(skill).toContain(
      "Do not treat mock, dry-run, fixture-only tests, or uncalled APIs as live completion"
    );
    expect(skill).toContain("return `NEEDS_COORDINATOR`");
    expect(skill).toContain(
      "bad dependencies, missing prompts, invalid acceptance, wrong review gate design, or stale task scope"
    );
    expect(skill).toContain(
      "Do not edit `project-graph.json`, canvas `manifest.json`, source prompt Markdown, or other Plan Package files"
    );
    expect(skill).toContain(
      "Do not coordinate multiple blocks, canvases, or subagents; use `plan-coordinator`."
    );
  });

  it("documents plan-auditor as a focused PlanWeave plan review skill", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-auditor/SKILL.md"), "utf8");

    expect(skill).toContain(
      "Use when auditing, reviewing, checking, or challenging a PlanWeave plan before execution."
    );
    expect(skill).toContain("The default output is findings and revision order");
    expect(skill).toContain("Plan Update Boundary");
    expect(skill).toContain(
      "Audit findings name the needed task, block, edge, prompt, review, or validation update; they do not apply the change."
    );
    expect(skill).toContain(
      "If the user explicitly asks to apply revisions, finish the audit first"
    );
    expect(skill).toContain(
      "Do not edit runtime `state.json`, `results/`, active canvas selection, recovery transactions, or implementation artifacts from this skill."
    );
    expect(skill).toContain("Before judging task completeness");
    expect(skill).toContain("Flow Coverage table before findings.");
    expect(skill).toContain(
      "| Flow | Trigger/Input | Core Processing | External Dependency | State/Storage | Interface/Consumer | Output/Side Effect | Failure Path | Verification | Gaps |"
    );
    expect(skill).toContain("### Data Flow Coverage");
    expect(skill).toContain(
      "Do not let a long task list count as coverage when the end-to-end flow is broken."
    );
    expect(skill).toContain("Core Object Lifecycle");
    expect(skill).toContain("schema without runtime use");
    expect(skill).toContain("Read `project-graph.json` when present");
    expect(skill).toContain("cross-canvas task blockers must be explicit `crossTaskEdges`");
    expect(skill).toContain("Treat dense or repeated `crossTaskEdges`");
    expect(skill).toContain("canvas-boundary defect");
    expect(skill).toContain(
      "Compare suspicious project graph, manifest, state, and layout structure against `planweave schema project`"
    );
    expect(skill).toContain(
      "Check that prompt placement summary identifies global/project/task/block source of truth."
    );
    expect(skill).toContain("Flag copied skills");
    expect(skill).toContain("Separate plan design defects from PlanWeave toolchain defects.");
    expect(skill).toContain("End with the recommended revision order.");
  });
});
