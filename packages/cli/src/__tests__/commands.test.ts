import { describe, expect, it } from "vitest";
import {
  layoutSchemaDocument as runtimeLayoutSchemaDocument,
  manifestSchemaDocument as runtimeManifestSchemaDocument,
  projectSchemaDocument as runtimeProjectSchemaDocument,
  runtimeSchemaDocuments,
  runtimeSchemaTopicOrder,
  stateSchemaDocument as runtimeStateSchemaDocument,
  type AutoRunStatus,
  type AutoRunStepResult,
  type RunSessionState
} from "@planweave-ai/runtime";
import { createProgram } from "../index.js";
import { formatExecutorProfilesHuman, formatExecutorTestHuman, formatExecutorTestJson } from "../commands/formatters/executorFormatters.js";
import { formatClaimHint, formatExecutionStatusHuman } from "../commands/formatters/statusFormatters.js";
import { formatCliHelp, planweaveHelpTopics } from "../commands/help.js";
import { formatSchemaHelp, schemaDocuments } from "../commands/schema.js";
import {
  formatResetResult,
  formatRunResult,
  formatRunSessionDetail,
  formatRunSessions,
  formatRunStatusHuman
} from "../commands/formatters/runFormatters.js";
import {
  formatProjectGraphConflictDiagnostics,
  formatProjectGraphMaterializeHuman,
  formatProjectGraphMigrationHuman
} from "../commands/formatters/projectGraphFormatters.js";

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

function nestedSubcommandOptionLongs(parentName: string, childName: string, name: string): string[] {
  const parent = createProgram().commands.find((item) => item.name() === parentName);
  if (!parent) {
    throw new Error(`Missing command '${parentName}'.`);
  }
  const child = parent.commands.find((item) => item.name() === childName);
  if (!child) {
    throw new Error(`Missing command '${parentName} ${childName}'.`);
  }
  const command = child.commands.find((item) => item.name() === name);
  if (!command) {
    throw new Error(`Missing command '${parentName} ${childName} ${name}'.`);
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
        "use",
        "submit-feedback",
        "reset",
        "run",
        "run-sessions",
        "run-session",
        "executors",
        "run-status",
        "project-graph",
        "schema",
        "mcp",
        "help"
      ])
    );
  });

  it("registers MCP tunnel commands", () => {
    const mcp = createProgram().commands.find((command) => command.name() === "mcp");
    expect(mcp?.commands.map((command) => command.name())).toEqual(expect.arrayContaining(["serve", "tunnel"]));
    const tunnel = mcp?.commands.find((command) => command.name() === "tunnel");
    expect(tunnel?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["download", "set-binary", "configure", "status", "doctor", "run", "print-systemd"])
    );
    expect(subcommandOptionLongs("mcp", "serve")).toEqual(expect.arrayContaining(["--host", "--port", "--token", "--oauth", "--json"]));
    expect(nestedSubcommandOptionLongs("mcp", "tunnel", "status")).toContain("--json");
    expect(nestedSubcommandOptionLongs("mcp", "tunnel", "doctor")).toContain("--json");
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
    expect(commandOptionLongs("use")).toEqual(expect.arrayContaining(["--source-root", "--clear", "--json"]));
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
    expect(commandOptionLongs("reset")).toEqual(expect.arrayContaining(["--canvas", "--force", "--reason", "--json"]));
    expect(commandOptionLongs("run")).toEqual(
      expect.arrayContaining(["--once", "--parallel", "--executor", "--scope", "--task", "--block", "--reset", "--force", "--reason", "--step-limit", "--json"])
    );
    expect(commandOptionLongs("run")).toContain("--canvas");
    expect(commandOptionLongs("run-sessions")).toEqual(expect.arrayContaining(["--canvas", "--json"]));
    expect(commandOptionLongs("run-session")).toEqual(expect.arrayContaining(["--canvas", "--json"]));
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

  it("prints executor profile lists in human output", () => {
    expect(
      formatExecutorProfilesHuman([
        {
          name: "manual",
          adapter: "manual",
          source: "builtin"
        }
      ])
    ).toBe("manual\tmanual\tbuiltin");
  });

  it("prints run session diagnostics even when no valid sessions exist", () => {
    expect(
      formatRunSessions({
        sessions: [],
        diagnostics: [
          {
            code: "run_session_read_failed",
            sessionId: "SESSION-0001",
            path: "/tmp/project/results/run-sessions/SESSION-0001/session.json",
            message: "Unexpected token"
          }
        ]
      })
    ).toContain("diagnostics:\n- SESSION-0001 run_session_read_failed: Unexpected token");
  });

  it("prints run session stop reasons in text summaries", () => {
    expect(
      formatRunSessions({
        sessions: [
          {
            sessionId: "SESSION-0001",
            kind: "run",
            trigger: "manual",
            projectRoot: "/tmp/project",
            canvasId: "default",
            scope: { kind: "project" },
            phase: "completed",
            startedAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:01.000Z",
            finishedAt: "2026-06-25T00:00:01.000Z",
            reset: null,
            autoRun: {
              desktopRunId: null,
              stepCount: 1,
              parallel: false,
              executorOverride: null,
              stopReason: "step_limit"
            },
            latestRecordId: "T-001#B-001::RUN-001",
            latestRecordPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
            error: null
          }
        ],
        diagnostics: []
      })
    ).toContain("SESSION-0001 run completed steps=1 stop=step_limit");
  });

  it("prints run session details in human output", () => {
    const session: RunSessionState = {
      sessionId: "SESSION-0001",
      kind: "run",
      trigger: "manual",
      projectRoot: "/tmp/project",
      canvasId: "default",
      scope: { kind: "project" },
      phase: "completed",
      startedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:01.000Z",
      finishedAt: "2026-06-25T00:00:01.000Z",
      reset: null,
      autoRun: {
        desktopRunId: null,
        stepCount: 1,
        parallel: false,
        executorOverride: null,
        stopReason: "once"
      },
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
      error: null
    };

    expect(
      formatRunSessionDetail({
        session,
        events: [{ timestamp: "2026-06-25T00:00:00.000Z", sessionId: "SESSION-0001", type: "session_created", phase: "running" }],
        diagnostics: []
      })
    ).toContain("events:\n- 2026-06-25T00:00:00.000Z session_created running");
  });

  it("prints reset summaries in human output", () => {
    const session: RunSessionState = {
      sessionId: "SESSION-0001",
      kind: "reset",
      trigger: "manual",
      projectRoot: "/tmp/project",
      canvasId: "default",
      scope: { kind: "project" },
      phase: "completed",
      startedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:01.000Z",
      finishedAt: "2026-06-25T00:00:01.000Z",
      reset: null,
      autoRun: null,
      latestRecordId: null,
      latestRecordPath: null,
      error: null
    };

    expect(
      formatResetResult({
        session,
        sessionId: "SESSION-0001",
        statePath: "/tmp/project/canvases/default/state.json",
        reason: "restart",
        forced: true,
        previousCurrentRefs: ["T-001#B-001"],
        previousCurrentFeedbackId: null,
        previousCurrentReviewBlockRef: null,
        previousInProgressRefs: []
      })
    ).toContain("forced: yes\nprevious current refs: T-001#B-001");
  });

  it("prints step-limit terminal reason in run text output", () => {
    expect(
      formatRunResult({
        session: {
          sessionId: "SESSION-0001",
          kind: "run",
          trigger: "manual",
          projectRoot: "/tmp/project",
          canvasId: "default",
          scope: { kind: "project" },
          phase: "completed",
          startedAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:01.000Z",
          finishedAt: "2026-06-25T00:00:01.000Z",
          reset: null,
          autoRun: {
            desktopRunId: null,
            stepCount: 1,
            parallel: false,
            executorOverride: null,
            stopReason: "step_limit"
          },
          latestRecordId: "T-001#B-001::RUN-001",
          latestRecordPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
          error: null
        },
        steps: [],
        terminalReason: "step_limit_reached"
      })
    ).toContain("terminal: completed by step limit");
  });

  it("prints manual prompt summaries for manual parallel batches", () => {
    const batchStep = {
      kind: "batch_submitted",
      claim: {
        kind: "batch",
        refs: ["T-001#B-001", "T-002#B-001"],
        effectiveExecutors: {
          "T-001#B-001": "manual",
          "T-002#B-001": "manual"
        }
      },
      steps: [
        {
          kind: "manual",
          claim: { kind: "block", ref: "T-001#B-001", taskId: "T-001", blockId: "B-001", blockType: "implementation", effectiveExecutor: "manual" },
          adapterResult: {
            kind: "manual",
            executor: "manual",
            adapter: "manual",
            promptPath: "/tmp/project/package/nodes/T-001/blocks/B-001.prompt.md",
            runDir: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001",
            runId: "RUN-001",
            nextCommand: "planweave submit-result T-001#B-001 --report <report.md>"
          }
        },
        {
          kind: "manual",
          claim: { kind: "block", ref: "T-002#B-001", taskId: "T-002", blockId: "B-001", blockType: "implementation", effectiveExecutor: "manual" },
          adapterResult: {
            kind: "manual",
            executor: "manual",
            adapter: "manual",
            promptPath: "/tmp/project/package/nodes/T-002/blocks/B-001.prompt.md",
            runDir: "/tmp/project/results/T-002/blocks/B-001/runs/RUN-001",
            runId: "RUN-001",
            nextCommand: "planweave submit-result T-002#B-001 --report <report.md>"
          }
        }
      ]
    } satisfies AutoRunStepResult;

    expect(
      formatRunResult({
        session: {
          sessionId: "SESSION-0001",
          kind: "run",
          trigger: "manual",
          projectRoot: "/tmp/project",
          canvasId: "default",
          scope: { kind: "project" },
          phase: "manual",
          startedAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:01.000Z",
          finishedAt: "2026-06-25T00:00:01.000Z",
          reset: null,
          autoRun: {
            desktopRunId: null,
            stepCount: 1,
            parallel: true,
            executorOverride: "manual",
            stopReason: null
          },
          latestRecordId: "T-002#B-001::RUN-001",
          latestRecordPath: "/tmp/project/results/T-002/blocks/B-001/runs/RUN-001/metadata.json",
          error: null
        },
        steps: [batchStep],
        terminalReason: "manual"
      })
    ).toContain("manual prompts generated for 2 blocks");
  });

  it("prints run status using the command-layer default start command", () => {
    const status: AutoRunStatus = {
      current: {
        refs: [],
        feedbackId: null,
        reviewBlockRef: null
      },
      latestRuns: [
        {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          status: "completed",
          runId: "RUN-001",
          executor: "manual",
          adapter: "manual",
          startedAt: "2026-06-25T00:00:00.000Z",
          finishedAt: "2026-06-25T00:00:01.000Z",
          stdoutSummary: "ok",
          stderrSummary: "",
          failureReason: null,
          promptPath: "/tmp/project/package/nodes/T-001/blocks/B-001.prompt.md",
          reportPath: "/tmp/project/results/T-001/blocks/B-001/report.md",
          metadataPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
          tmuxSessionName: null,
          tmuxAttachCommand: null,
          tmuxReadOnlyAttachCommand: null
        }
      ],
      explanation: {
        phase: "idle",
        currentRef: null,
        currentExecutor: null,
        latestRecordId: "T-001#B-001::RUN-001",
        latestRecordPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
        latestOutputSummary: "ok",
        error: null,
        nextAction: {
          kind: "start",
          message: "Start auto-run.",
          command: null,
          targetPath: null,
          ref: null
        }
      },
      warnings: []
    };

    expect(formatRunStatusHuman(status, { defaultStartCommand: "planweave run --canvas default" })).toContain(
      "next command: planweave run --canvas default"
    );
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
    expect(formatCliHelp("autorun")).toContain("planweave run --reset --force --reason <reason> --json");
    expect(formatCliHelp("autorun")).toContain("planweave run --scope task --task <task-id> --once --json");
    expect(formatCliHelp("autorun")).toContain("planweave run --scope block --block <block-ref> --once --json");
    expect(formatCliHelp("autorun")).toContain("planweave reset --force --reason <reason> --json");
    expect(formatCliHelp("autorun")).toContain("planweave run-sessions --json");
    expect(formatCliHelp("autorun")).toContain("planweave run-session <session-id> --json");
    expect(formatCliHelp("autorun")).toContain("init --reset-package resets package source files");
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
    expect(schemaDocuments.state.schema).toHaveProperty("tasks");
    expect(schemaDocuments.layout.schema).toHaveProperty("nodes");
    expect(schemaDocuments).toBe(runtimeSchemaDocuments);
    expect(Object.keys(schemaDocuments)).toEqual([...runtimeSchemaTopicOrder]);
    expect(schemaDocuments.manifest).toBe(runtimeManifestSchemaDocument);
    expect(schemaDocuments.project).toBe(runtimeProjectSchemaDocument);
    expect(schemaDocuments.state).toBe(runtimeStateSchemaDocument);
    expect(schemaDocuments.layout).toBe(runtimeLayoutSchemaDocument);
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
        blockedByProject: [],
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
        blockedByProject: [],
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

  it("prints execution status in human output", () => {
    const status: Parameters<typeof formatExecutionStatusHuman>[0] = {
      projectId: "project",
      projectRoot: "/tmp/project",
      taskTotal: 1,
      blockTotal: 1,
      tasks: [{ taskId: "T-001", status: "ready", openFeedbackCount: 0 }],
      blocks: [
        {
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          type: "implementation",
          status: "ready",
          reason: null,
          completionReason: null,
          lastRunId: null,
          latestReviewAttemptId: null,
          activeFeedbackId: null
        }
      ],
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      openFeedback: [],
      nextClaimable: ["T-001#B-001"],
      nextParallelClaimable: ["T-001#B-001"],
      nextSequentialClaimable: [],
      nextParallelDispatchable: [],
      claimHints: [],
      warnings: [{ code: "example_warning", message: "Check this." }],
      counts: {
        tasks: { planned: 0, ready: 1, in_progress: 0, implemented: 0 },
        blocks: { planned: 0, ready: 1, in_progress: 0, completed: 0, needs_changes: 0, blocked: 0, diverged: 0 },
        feedback: { open: 0, in_progress: 0, resolved: 0, dismissed: 0 }
      },
      orphanState: [],
      orphanResults: []
    };

    expect(formatExecutionStatusHuman(status)).toContain("Next claimable: T-001#B-001\nNext parallel claimable: T-001#B-001");
    expect(formatExecutionStatusHuman(status)).toContain("Warnings:\n- example_warning: Check this.");
  });

  it("prints project graph migration summaries in human output", () => {
    expect(formatProjectGraphConflictDiagnostics([{ code: "conflict", message: "Legacy and canonical paths both exist." }])).toBe(
      "conflict: Legacy and canonical paths both exist."
    );
    expect(
      formatProjectGraphMigrationHuman({
        action: "migrate",
        reason: "Legacy default canvas workspace can be migrated.",
        diagnostics: [],
        canonicalPaths: {
          workspaceRoot: "/tmp/project/canvases/default",
          packageDir: "/tmp/project/canvases/default/package",
          stateFile: "/tmp/project/canvases/default/state.json",
          resultsDir: "/tmp/project/canvases/default/results"
        },
        legacyPaths: {
          workspaceRoot: "/tmp/project",
          packageDir: "/tmp/project/package",
          stateFile: "/tmp/project/state.json",
          resultsDir: "/tmp/project/results"
        },
        legacyFiles: ["package/manifest.json"],
        canonicalFiles: [],
        legacyBackupPaths: {
          workspaceRoot: "/tmp/project/.legacy-default-canvas"
        },
        projectGraphPath: "/tmp/project/project-graph.json"
      })
    ).toContain("Legacy backup: /tmp/project/.legacy-default-canvas");
    expect(
      formatProjectGraphMaterializeHuman({
        created: true,
        path: "/tmp/project/project-graph.json",
        source: "legacy_default_canvas",
        canvasCount: 1
      })
    ).toBe("Project graph: /tmp/project/project-graph.json\nSource: legacy_default_canvas\nCanvases: 1");
  });
});
