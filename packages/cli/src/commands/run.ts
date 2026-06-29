import type { Command } from "commander";
import { runWithSession, type ClaimScope } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliPackageWorkspace, type CanvasCommandOptions } from "../cliWorkspace.js";
import { formatRunResult } from "./formatters/runFormatters.js";

export function registerRunCommand(program: Command): void {
  addCanvasOption(program
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
    .option("--json", "print JSON output"))
    .action(async (options: {
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
      json?: boolean;
    } & CanvasCommandOptions) => {
      const projectRoot = await resolveCliPackageWorkspace(options);
      const result = await runWithSession({
        projectRoot,
        reset: options.reset,
        force: options.force,
        reason: options.reason,
        once: options.once,
        executorName: options.executor,
        parallel: options.parallel,
        scope: parseRunScope(options),
        stepLimit: parseStepLimit(options.stepLimit)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatRunResult(result));
      }

      if (!result.ok || result.session.phase === "failed") {
        process.exitCode = 1;
      }
    });
}

function parseRunScope(options: { scope?: string; task?: string; block?: string }): ClaimScope | undefined {
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
