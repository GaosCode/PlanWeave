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
    expect(skill).toContain("Treat the CLI-returned package directory as the only writable Plan Package location.");
  });

  it("documents importer task-only defaults, prompt placement, and canvas/review strategy", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-importer/SKILL.md"), "utf8");

    expect(skill).toContain("Do not create context nodes by default.");
    expect(skill).toContain("Create context nodes only when the user explicitly asks for them.");
    expect(skill).toContain("Do not write rendered prompt output back into source prompt files.");
    expect(skill).toContain("Prompt Placement");
    expect(skill).toContain("100+ tasks/nodes");
    expect(skill).toContain("Do not add review blocks for simple docs");
    expect(skill).toContain("Do not split for the sake of splitting.");
  });

  it("documents importer plan quality checks before writing the package", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-importer/SKILL.md"), "utf8");

    expect(skill).toContain("Run the Plan Quality Gate below before writing.");
    expect(skill).toContain("Identify core objects and trace create");
    expect(skill).toContain("Keep schema, types, APIs, CLI flags, events, files, and prompt inputs/outputs consistent");
    expect(skill).toContain("Reject fake completion");
    expect(skill).toContain("Separate plan defects from PlanWeave toolchain defects in the report.");
  });

  it("documents plan-maker as a focused draft-planning skill before a package exists", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-maker/SKILL.md"), "utf8");

    expect(skill).toContain("Use when the user asks to make, draft, design, break down, or plan PlanWeave work");
    expect(skill).toContain("Do not execute work, audit an existing package, or write a Plan Package unless the user explicitly asks.");
    expect(skill).toContain("If strong source docs exist, prefer `plan-importer` instead of this skill.");
    expect(skill).toContain("Design around core object lifecycles");
    expect(skill).toContain("## Task Graph");
    expect(skill).toContain("This skill produces a plan draft, not runtime state.");
  });

  it("documents runner work kinds and recovery protocol without duplicating CLI help", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-runner/SKILL.md"), "utf8");

    expect(skill).toContain("This is an execution protocol, not a CLI reference.");
    expect(skill).toContain("For command syntax and topic help");
    expect(skill).toContain("<pw> help recovery");
    expect(skill).toContain("Treat claim results by kind: block work, feedback work, batch work, no work, or blocked work.");
    expect(skill).toContain("Resolved feedback usually returns to review");
    expect(skill).toContain("Do not create feedback blocks");
  });

  it("documents that plan-runner may maintain editable source prompts", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-runner/SKILL.md"), "utf8");

    expect(skill).toContain("PlanWeave Global Prompt, Project Prompt, Task Node Prompt, and Block Prompt are editable source prompts");
    expect(skill).toContain("Do not write rendered prompt output back into source prompt files.");
  });

  it("documents runner explicit claims, fallback, prompt diagnostics, and subagent control", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-runner/SKILL.md"), "utf8");

    expect(skill).toContain("<pw> help work");
    expect(skill).toContain("<pw> help submit");
    expect(skill).toContain("Prefer explicit refs when a controller assigns work");
    expect(skill).toContain("Preview scheduling before parallel or ambiguous claims.");
    expect(skill).toContain("Manual Fallback");
    expect(skill).toContain("Check source prompt placement");
    expect(skill).toContain("Controller duties");
    expect(skill).toContain("Review blocks are sequential gate work");
  });

  it("documents plan-auditor as a focused PlanWeave plan review skill", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-auditor/SKILL.md"), "utf8");

    expect(skill).toContain("Use when auditing, reviewing, checking, or challenging a PlanWeave plan before execution.");
    expect(skill).toContain("Do not import a new plan, execute blocks, repair state, or rewrite the package");
    expect(skill).toContain("Core Object Lifecycle");
    expect(skill).toContain("schema without runtime use");
    expect(skill).toContain("Separate plan design defects from PlanWeave toolchain defects.");
    expect(skill).toContain("End with the recommended revision order.");
  });
});
