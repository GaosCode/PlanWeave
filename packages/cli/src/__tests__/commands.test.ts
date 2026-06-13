import { describe, expect, it } from "vitest";
import { createProgram } from "../index.js";
import { formatClaimHint } from "../commands/status.js";
import { formatPlanweaveHelp, planweaveHelpTopics } from "../commands/help.js";
import { formatSchemaHelp, schemaDocuments } from "../commands/schema.js";

function commandOptionLongs(name: string): string[] {
  const command = createProgram().commands.find((item) => item.name() === name);
  if (!command) {
    throw new Error(`Missing command '${name}'.`);
  }
  return command.options.flatMap((option) => (option.long ? [option.long] : []));
}

describe("planweave CLI contract", () => {
  it("registers agent workflow commands", () => {
    const commandNames = createProgram().commands.map((command) => command.name());

    expect(commandNames).toEqual(
      expect.arrayContaining([
        "paths",
        "resolve-divergence",
        "mark-blocked",
        "unblock",
        "retry-review",
        "edit-task",
        "edit-block",
        "claim",
        "claim-task",
        "claim-next",
        "explain",
        "why-not",
        "current",
        "doctor",
        "submit-feedback",
        "run",
        "executors",
        "run-status",
        "schema",
        "help"
      ])
    );
  });

  it("supports json output for init, validate, and status", () => {
    expect(commandOptionLongs("init")).toContain("--json");
    expect(commandOptionLongs("init")).toContain("--reset-package");
    expect(commandOptionLongs("init")).toContain("--reset-results");
    expect(commandOptionLongs("validate")).toContain("--json");
    expect(commandOptionLongs("status")).toContain("--json");
    expect(commandOptionLongs("claim")).toContain("--type");
    expect(commandOptionLongs("claim")).toContain("--dispatch");
    expect(commandOptionLongs("claim-next")).toContain("--dry-run");
    expect(commandOptionLongs("doctor")).toContain("--repair");
    expect(commandOptionLongs("retry-review")).toContain("--max-feedback-cycles");
    expect(commandOptionLongs("edit-task")).toEqual(expect.arrayContaining(["--title", "--prompt-file", "--executor", "--clear-executor"]));
    expect(commandOptionLongs("edit-block")).toEqual(
      expect.arrayContaining([
        "--title",
        "--prompt-file",
        "--parallel-safe",
        "--parallel-locks",
        "--review-required",
        "--max-feedback-cycles",
        "--review-hook-json",
        "--clear-review-hook"
      ])
    );
    expect(commandOptionLongs("resolve-divergence")).toContain("--reason");
    expect(commandOptionLongs("unblock")).toContain("--reason");
    expect(commandOptionLongs("run")).toEqual(expect.arrayContaining(["--once", "--parallel", "--executor", "--json"]));
    expect(commandOptionLongs("run-status")).toContain("--json");
    expect(commandOptionLongs("schema")).toContain("--json");
    expect(commandOptionLongs("help")).toContain("--json");
  });

  it("prints PlanWeave-specific help topics for agent CLI workflows", () => {
    expect(planweaveHelpTopics.map((topic) => topic.name)).toEqual(["setup", "schema", "plan", "work", "submit", "explain", "recovery", "autorun"]);
    expect(formatPlanweaveHelp()).toContain("Common agent loop:");
    expect(formatPlanweaveHelp("schema")).toContain("planweave schema manifest");
    expect(formatPlanweaveHelp("schema")).toContain("Do not hand-author manifest, state, or layout from memory.");
    expect(formatPlanweaveHelp("work")).toContain("planweave claim-next --parallel --dry-run");
    expect(formatPlanweaveHelp("submit")).toContain("planweave submit-review <review-block-ref> --result <review-result.json>");
    expect(formatPlanweaveHelp("recovery")).toContain("planweave doctor --repair");
    expect(formatPlanweaveHelp("recovery")).toContain("planweave retry-review <review-block-ref> --max-feedback-cycles 3");
    expect(formatPlanweaveHelp("plan")).toContain("planweave edit-block <block-ref> --review-required false");
    expect(formatPlanweaveHelp("recovery")).toContain("Doctor checks state/results consistency; it is not a general Plan Package repair tool.");
    expect(formatPlanweaveHelp("recovery")).toContain("Fix bad dependencies, unsafe parallelization, missing prompts, or review-gate design");
  });

  it("prints focused schema navigation and full schema topics", () => {
    expect(formatSchemaHelp()).toContain("Use `planweave schema <topic>`");
    expect(formatSchemaHelp()).toContain("planweave schema project");
    expect(formatSchemaHelp()).toContain("planweave schema manifest");
    expect(formatSchemaHelp()).toContain("planweave edit-task <task-id>");
    expect(formatSchemaHelp()).toContain("planweave edit-block <block-ref>");
    expect(formatSchemaHelp()).not.toContain("edit package/manifest.json");
    expect(formatSchemaHelp("project")).toContain('"plan-project/v1"');
    expect(formatSchemaHelp("project")).toContain("from waits for to");
    expect(formatSchemaHelp("manifest")).toContain('"plan-package/v1"');
    expect(formatSchemaHelp("manifest")).toContain("Only task nodes are supported");
    expect(formatSchemaHelp("manifest")).toContain("Only implementation and review block types are supported.");
    expect(formatSchemaHelp("state")).toContain('"planned"');
    expect(formatSchemaHelp("state")).toContain('"implemented"');
    expect(formatSchemaHelp("layout")).toContain('"desktop-layout/v1"');
    expect(formatSchemaHelp("layout")).toContain("legacy_layout_schema");
    expect(formatSchemaHelp("all")).toContain("manifest: Plan Package source graph schema.");
    expect(formatSchemaHelp("all")).toContain("project: Project-level canvas graph schema.");
    expect(schemaDocuments.manifest.schema).toHaveProperty("nodes");
    expect(schemaDocuments.project.schema).toHaveProperty("canvases");
  });

  it("prints claim hint status reasons", () => {
    expect(
      formatClaimHint({
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        blockType: "implementation",
        status: "blocked",
        statusReason: "Waiting for external API access.",
        ready: false,
        readyReason: null,
        blockedByBlocks: [],
        blockedByTasks: [],
        parallelSafe: true,
        sequentialOnly: false,
        recommendedCommand: null,
        dispatchable: false,
        dispatchCommand: null,
        reviewGate: null
      })
    ).toContain("blocked: Waiting for external API access.");
  });

  it("prints optional review claimability reasons before raw ready status", () => {
    expect(
      formatClaimHint({
        ref: "T-001#R-001",
        taskId: "T-001",
        blockId: "R-001",
        blockType: "review",
        status: "ready",
        statusReason: "Optional review gate is not required and is not claimable; task can complete without it.",
        ready: false,
        readyReason: null,
        blockedByBlocks: [],
        blockedByTasks: [],
        parallelSafe: false,
        sequentialOnly: true,
        recommendedCommand: null,
        dispatchable: false,
        dispatchCommand: null,
        reviewGate: {
          isGate: true,
          required: false,
          requiredReason: "Optional review gate; not required for task completion.",
          executorRole: "reviewer",
          downstreamTasks: [],
          unlocksTasks: [],
          needsChangesReturnsTo: ["T-001#B-001"]
        }
      })
    ).toContain("ready: Optional review gate is not required and is not claimable; task can complete without it.");
  });
});
