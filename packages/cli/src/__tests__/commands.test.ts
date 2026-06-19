import { describe, expect, it } from "vitest";
import { manifestSchemaDocument as runtimeManifestSchemaDocument, projectSchemaDocument as runtimeProjectSchemaDocument } from "@planweave-ai/runtime";
import { createProgram } from "../index.js";
import { formatExecutorTestHuman, formatExecutorTestJson } from "../commands/executors.js";
import { formatClaimHint } from "../commands/status.js";
import { formatCliHelp, planweaveHelpTopics } from "../commands/help.js";
import { formatSchemaHelp, schemaDocuments } from "../commands/schema.js";

function commandOptionLongs(name: string): string[] {
  const command = createProgram().commands.find((item) => item.name() === name);
  if (!command) {
    throw new Error(`Missing command '${name}'.`);
  }
  return command.options.flatMap((option) => (option.long ? [option.long] : []));
}

function programOptionLongs(): string[] {
  return createProgram().options.flatMap((option) => (option.long ? [option.long] : []));
}

function subcommandOptionLongs(parentName: string, name: string): string[] {
  const parent = createProgram().commands.find((item) => item.name() === parentName);
  if (!parent) {
    throw new Error(`Missing command '${parentName}'.`);
  }
  const command = parent.commands.find((item) => item.name() === name);
  if (!command) {
    throw new Error(`Missing command '${parentName} ${name}'.`);
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
        "project-graph",
        "schema",
        "help"
      ])
    );
  });

  it("registers global project root selection once", () => {
    expect(programOptionLongs()).toContain("--project-root");
  });

  it("supports machine-readable output options for agent-facing commands", () => {
    expect(commandOptionLongs("init")).toContain("--json");
    expect(commandOptionLongs("init")).toContain("--project-graph");
    expect(commandOptionLongs("init")).toContain("--reset-package");
    expect(commandOptionLongs("init")).toContain("--reset-results");
    expect(commandOptionLongs("validate")).toContain("--json");
    expect(commandOptionLongs("status")).toContain("--json");
    expect(commandOptionLongs("status")).toContain("--canvas");
    expect(commandOptionLongs("claim")).toContain("--type");
    expect(commandOptionLongs("claim")).toContain("--dispatch");
    expect(commandOptionLongs("claim")).toContain("--canvas");
    expect(commandOptionLongs("claim-next")).toContain("--dry-run");
    expect(commandOptionLongs("claim-next")).toContain("--json");
    expect(commandOptionLongs("claim-next")).toContain("--canvas");
    expect(commandOptionLongs("submit-result")).toContain("--json");
    expect(commandOptionLongs("submit-review")).toContain("--json");
    expect(commandOptionLongs("submit-feedback")).toContain("--json");
    expect(commandOptionLongs("doctor")).toContain("--repair");
    expect(commandOptionLongs("doctor")).toContain("--canvas");
    expect(commandOptionLongs("doctor")).toContain("--project");
    expect(commandOptionLongs("retry-review")).toContain("--max-feedback-cycles");
    expect(commandOptionLongs("retry-review")).toContain("--canvas");
    expect(commandOptionLongs("edit-task")).toEqual(expect.arrayContaining(["--title", "--prompt-file", "--executor", "--clear-executor"]));
    expect(commandOptionLongs("edit-task")).toContain("--canvas");
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
    expect(commandOptionLongs("edit-block")).toContain("--canvas");
    expect(commandOptionLongs("resolve-divergence")).toContain("--reason");
    expect(commandOptionLongs("resolve-divergence")).toContain("--canvas");
    expect(commandOptionLongs("unblock")).toContain("--reason");
    expect(commandOptionLongs("unblock")).toContain("--canvas");
    expect(commandOptionLongs("run")).toEqual(expect.arrayContaining(["--once", "--parallel", "--executor", "--json"]));
    expect(commandOptionLongs("run")).toContain("--canvas");
    expect(commandOptionLongs("run-status")).toContain("--json");
    expect(commandOptionLongs("run-status")).toContain("--canvas");
    expect(subcommandOptionLongs("executors", "list")).toContain("--json");
    expect(subcommandOptionLongs("executors", "test")).toContain("--json");
    expect(commandOptionLongs("schema")).toContain("--json");
    expect(commandOptionLongs("help")).toContain("--json");
    for (const commandName of [
      "claim-task",
      "prompt",
      "explain",
      "why-not",
      "current",
      "submit-result",
      "submit-review",
      "submit-feedback",
      "mark-blocked",
      "mark-diverged",
      "refresh-prompt",
      "refresh-prompts"
    ]) {
      expect(commandOptionLongs(commandName), commandName).toContain("--canvas");
    }
  });

  it("rejects project doctor with canvas selection", async () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

    await expect(program.parseAsync(["doctor", "--project", "--canvas", "runtime"], { from: "user" })).rejects.toThrow(
      "doctor --project cannot be combined with --canvas."
    );
  });

  it("prints executor preflight facts as JSON", () => {
    const result = JSON.parse(
      formatExecutorTestJson({
        name: "node-version",
        adapter: "codex-exec",
        ok: true,
        message: "v26.3.0",
        checks: [
          { check: "profile_exists", status: "passed", message: "Executor profile 'node-version' exists." },
          { check: "adapter_supported", status: "passed", message: "Executor adapter 'codex-exec' is supported." },
          { check: "cwd_resolved", status: "passed", message: "Project cwd resolved.", cwd: "/tmp/project" },
          { check: "command_started", status: "passed", message: "Command started.", command: process.execPath, cwd: "/tmp/project" },
          {
            check: "command_version",
            status: "passed",
            message: "v26.3.0",
            command: process.execPath,
            cwd: "/tmp/project",
            output: "v26.3.0",
            exitCode: 0,
            timedOut: false
          }
        ]
      })
    );

    expect(result).toMatchObject({
      name: "node-version",
      adapter: "codex-exec",
      ok: true,
      checks: [
        { check: "profile_exists", status: "passed" },
        { check: "adapter_supported", status: "passed" },
        { check: "cwd_resolved", status: "passed" },
        { check: "command_started", status: "passed", command: process.execPath },
        { check: "command_version", status: "passed", output: "v26.3.0" }
      ]
    });
  });

  it("prints executor preflight failure reasons in human output", () => {
    expect(
      formatExecutorTestHuman({
        name: "missing-profile",
        adapter: null,
        ok: false,
        message: "Executor profile 'missing-profile' does not exist.",
        checks: [
          { check: "profile_exists", status: "failed", message: "Executor profile 'missing-profile' does not exist." },
          { check: "adapter_supported", status: "skipped", message: "Executor profile does not exist." },
          { check: "cwd_resolved", status: "passed", message: "Project cwd resolved.", cwd: "/tmp/project" },
          { check: "command_started", status: "skipped", message: "Executor profile does not exist." },
          { check: "command_version", status: "skipped", message: "Executor profile does not exist." }
        ]
      })
    ).toBe("failed missing-profile: Executor profile 'missing-profile' does not exist.");
  });

  it("prints PlanWeave-specific help topics for agent CLI workflows", () => {
    expect(planweaveHelpTopics.map((topic) => topic.name)).toEqual(["setup", "schema", "plan", "work", "submit", "explain", "recovery", "autorun"]);
    expect(formatCliHelp()).toContain("Common agent loop:");
    expect(formatCliHelp("schema")).toContain("planweave schema project");
    expect(formatCliHelp("schema")).toContain("planweave schema manifest");
    expect(formatCliHelp("schema")).toContain("Use schema project before writing formal multi-canvas project-graph.json.");
    expect(formatCliHelp("schema")).toContain("Do not hand-author project graph, manifest, state, or layout from memory.");
    expect(formatCliHelp("work")).toContain("planweave claim-next --parallel --dry-run");
    expect(formatCliHelp("work")).toContain("planweave status --json --canvas <canvasId>");
    expect(formatCliHelp("work")).toContain("CLI commands target the current or first canvas");
    expect(formatCliHelp("submit")).toContain("planweave submit-review <review-block-ref> --result <review-result.json>");
    expect(formatCliHelp("submit")).toContain("planweave submit-result --canvas <canvasId> <block-ref> --report <report.md>");
    expect(formatCliHelp("autorun")).toContain("planweave run --once --executor <name> --canvas <canvasId> --json");
    expect(formatCliHelp("recovery")).toContain("planweave doctor --repair");
    expect(formatCliHelp("recovery")).toContain("planweave retry-review <review-block-ref> --max-feedback-cycles 3");
    expect(formatCliHelp("plan")).toContain("planweave edit-block <block-ref> --review-required false");
    expect(formatCliHelp("recovery")).toContain("Doctor checks state/results consistency; it is not a general Plan Package repair tool.");
    expect(formatCliHelp("recovery")).toContain("Fix bad dependencies, unsafe parallelization, missing prompts, or review-gate design");
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
    expect(schemaDocuments.manifest).toBe(runtimeManifestSchemaDocument);
    expect(schemaDocuments.project).toBe(runtimeProjectSchemaDocument);
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
