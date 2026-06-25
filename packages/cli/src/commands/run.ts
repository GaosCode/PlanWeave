import type { Command } from "commander";
import { runWithSession, type AutoRunStepResult, type RunSessionState } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliPackageWorkspace, type CanvasCommandOptions } from "../cliWorkspace.js";

type FormattableRunResult = {
  session: RunSessionState;
  steps: AutoRunStepResult[];
  terminalReason: Awaited<ReturnType<typeof runWithSession>>["terminalReason"];
};

export function registerRunCommand(program: Command): void {
  addCanvasOption(program
    .command("run")
    .description("Run PlanWeave auto-run until it stops, or one step with --once")
    .option("--once", "execute only one auto-run step")
    .option("--parallel", "claim a deterministic parallel batch")
    .option("--executor <name>", "override executor profile for this run")
    .option("--reset", "reset runtime state before running")
    .option("--force", "allow reset while active work exists")
    .option("--reason <text>", "record a reason for reset")
    .option("--step-limit <n>", "maximum auto-run steps to execute")
    .option("--json", "print JSON output"))
    .action(async (options: { once?: boolean; parallel?: boolean; executor?: string; reset?: boolean; force?: boolean; reason?: string; stepLimit?: string; json?: boolean } & CanvasCommandOptions) => {
      const projectRoot = await resolveCliPackageWorkspace(options);
      const result = await runWithSession({
        projectRoot,
        reset: options.reset,
        force: options.force,
        reason: options.reason,
        once: options.once,
        executorName: options.executor,
        parallel: options.parallel,
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

export function formatRunResult(result: FormattableRunResult): string {
  const lines = [
    `session: ${result.session.sessionId}`,
    `phase: ${result.session.phase}`,
    `steps: ${result.steps.length}`,
    `latest record: ${result.session.latestRecordId ?? "none"}${result.session.latestRecordPath ? ` (${result.session.latestRecordPath})` : ""}`,
    `terminal: ${formatTerminalReason(result.terminalReason)}`
  ];
  if (result.steps.length > 0) {
    lines.push("step summaries:");
    lines.push(...result.steps.map((step) => `- ${formatRunStep(step).replace(/\n/g, "\n  ")}`));
  }
  return lines.join("\n");
}

function formatTerminalReason(reason: Awaited<ReturnType<typeof runWithSession>>["terminalReason"]): string {
  if (reason === "step_limit_reached") {
    return "completed by step limit";
  }
  return reason;
}

function formatRunStep(step: AutoRunStepResult): string {
  if (step.kind === "submitted") {
    return `submitted ${step.claim.kind}${step.claim.kind === "block" ? ` ${step.claim.ref}` : ""}`;
  }
  if (step.kind === "batch_submitted") {
    const manualCount = step.steps.filter((item) => item.kind === "manual").length;
    if (manualCount === step.steps.length) {
      return `manual prompts generated for ${step.steps.length} blocks`;
    }
    if (manualCount > 0) {
      return `batch completed with manual prompts for ${manualCount} of ${step.steps.length} blocks`;
    }
    return `batch submitted ${step.steps.length} blocks`;
  }
  if (step.kind === "manual") {
    return `manual ${step.claim.kind}${step.claim.kind === "block" ? ` ${step.claim.ref}` : ""}\nprompt: ${step.adapterResult.promptPath}\nnext: ${step.adapterResult.nextCommand}`;
  }
  return `${step.kind}: ${step.claim.kind}`;
}
