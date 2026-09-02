import type { Command } from "commander";
import {
  createRunTerminalEvent,
  runEventSchema,
  runWithSession,
  type ClaimScope,
  type RunEvent,
  type RunnerInteractionObserver
} from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";
import { formatRunResult } from "./formatters/runFormatters.js";
import { executeWorkspaceRun } from "../workspaceExecution/run.js";
import {
  WorkspaceExecutionCliError,
  workspaceExecutionResultExitCode
} from "../workspaceExecution/errors.js";
import { parseCliExecutionAuthority } from "../workspaceExecution/preflight.js";

export function registerRunCommand(program: Command): void {
  addCanvasOption(
    program
      .command("run")
      .description("Run PlanWeave auto-run until it stops, or one step with --once")
      .option("--once", "execute only one auto-run step")
      .option("--parallel", "claim a deterministic parallel batch")
      .option("--executor <name>", "override executor profile for this run")
      .option("--scope <kind>", "restrict run scope: project, task, or block")
      .option("--task <taskId>", "task id for --scope task")
      .option("--block <blockRef>", "block ref for --scope block")
      .option("--reset", "reset runtime state before running")
      .option("--force", "allow reset while active work exists")
      .option("--reason <text>", "record a reason for reset")
      .option("--step-limit <n>", "maximum auto-run steps to execute")
      .option("--timeout <ms>", "bound each executor operation in milliseconds")
      .option("--json", "print JSON output")
      .option("--event-stream", "print versioned NDJSON run events")
      .option("--target <policy>", "execution target: local, remote, or auto")
      .option("--agent-endpoint <endpointId>", "select one Remote Agent endpoint")
      .option("--connection-profile <profileId>", "select a preconfigured Workspace connection")
      .option(
        "--authority <kind>",
        "remote authority: owner_canvas or workspace_canvas (default workspace_canvas)"
      )
      .option("--event-format <format>", "workspace event format: legacy or execution-v1")
      .option(
        "--follow",
        "follow the selected Workspace execution until terminal or action required"
      )
  ).action(
    async (
      options: {
        once?: boolean;
        parallel?: boolean;
        executor?: string;
        scope?: string;
        task?: string;
        block?: string;
        reset?: boolean;
        force?: boolean;
        reason?: string;
        stepLimit?: string;
        timeout?: string;
        json?: boolean;
        eventStream?: boolean;
        target?: string;
        agentEndpoint?: string;
        connectionProfile?: string;
        authority?: string;
        eventFormat?: string;
        follow?: boolean;
      } & CanvasCommandOptions
    ) => {
      if (options.json === true && options.eventStream === true) {
        throw new Error("--event-stream cannot be combined with --json.");
      }
      const workspaceExecution =
        options.target !== undefined ||
        options.agentEndpoint !== undefined ||
        options.connectionProfile !== undefined ||
        options.authority !== undefined ||
        options.eventFormat !== undefined ||
        options.follow === true;
      if (workspaceExecution) {
        if (
          options.json ||
          options.eventStream ||
          options.reset ||
          options.force ||
          options.reason
        ) {
          throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
        }
        if (options.parallel || options.stepLimit || options.timeout) {
          throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
        }
        const target = parseWorkspaceTarget(options.target);
        const eventFormat = parseWorkspaceEventFormat(options.eventFormat);
        const abort = new AbortController();
        const onSigInt = (): void => abort.abort();
        process.once("SIGINT", onSigInt);
        try {
          const result = await executeWorkspaceRun({
            ...options,
            target,
            authority: parseCliExecutionAuthority(options.authority),
            eventFormat,
            scope: parseRunScope(options) ?? { kind: "project" },
            signal: abort.signal
          });
          process.exitCode = workspaceExecutionResultExitCode(result);
        } catch (error) {
          if (abort.signal.aborted) {
            process.exitCode = 130;
            return;
          }
          throw error;
        } finally {
          process.off("SIGINT", onSigInt);
        }
        return;
      }
      const projectRoot = await resolveCliPackageWorkspace(options);
      const abort = new AbortController();
      const onSigInt = (): void => abort.abort();
      process.once("SIGINT", onSigInt);
      const interactionObserver = options.json
        ? undefined
        : createCliInteractionObserver(options.eventStream === true);
      const result = await runWithSession({
        projectRoot,
        reset: options.reset,
        force: options.force,
        reason: options.reason,
        once: options.once,
        executorName: options.executor,
        parallel: options.parallel,
        scope: parseRunScope(options),
        stepLimit: parseStepLimit(options.stepLimit),
        timeoutMs: parsePositiveInteger(options.timeout, "--timeout"),
        signal: abort.signal,
        interactionObserver
      }).finally(() => process.off("SIGINT", onSigInt));

      if (options.eventStream) {
        writeRunEvent(createRunTerminalEvent(result));
      } else if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatRunResult(result));
      }

      if (!result.ok || result.session.phase === "failed") {
        process.exitCode = 1;
      }
    }
  );
}

function writeRunEvent(event: RunEvent): void {
  process.stdout.write(`${JSON.stringify(runEventSchema.parse(event))}\n`);
}

function createCliInteractionObserver(eventStream: boolean): RunnerInteractionObserver {
  if (eventStream) {
    return {
      interactionRequired: writeRunEvent,
      interactionResolved: writeRunEvent
    };
  }
  return {
    interactionRequired: () => {
      console.log(
        "Waiting for a permission decision; handle it in Task Workspace or with `planweave interaction respond`."
      );
    },
    interactionResolved: () => {
      console.log("Run owner consumed the permission decision; protocol response is ready.");
    }
  };
}

export function parseRunScope(options: {
  scope?: string;
  task?: string;
  block?: string;
}): ClaimScope | undefined {
  const scope = options.scope ?? "project";
  if (scope !== "project" && scope !== "task" && scope !== "block") {
    throw new Error(`Invalid --scope '${scope}'. Expected project, task, or block.`);
  }
  if (scope === "project") {
    if (options.task || options.block) {
      throw new Error("--task and --block can only be used with --scope task or --scope block.");
    }
    return undefined;
  }
  if (scope === "task") {
    if (!options.task) {
      throw new Error("--scope task requires --task <taskId>.");
    }
    if (options.block) {
      throw new Error("--block cannot be combined with --scope task.");
    }
    return { kind: "task", taskId: options.task };
  }
  if (!options.block) {
    throw new Error("--scope block requires --block <blockRef>.");
  }
  if (options.task) {
    throw new Error("--task cannot be combined with --scope block.");
  }
  return { kind: "block", blockRef: options.block };
}

function parseWorkspaceTarget(value: string | undefined): "local" | "remote" | "auto" {
  const target = value ?? "auto";
  if (target !== "local" && target !== "remote" && target !== "auto") {
    throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  }
  return target;
}

function parseWorkspaceEventFormat(value: string | undefined): "legacy" | "execution-v1" {
  const format = value ?? "legacy";
  if (format !== "legacy" && format !== "execution-v1") {
    throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
  }
  return format;
}

function parseStepLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new Error(`Invalid --step-limit '${value}'. Expected a non-negative integer.`);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`Invalid ${option} '${value}'. Expected a positive integer.`);
  }
  return parsed;
}
