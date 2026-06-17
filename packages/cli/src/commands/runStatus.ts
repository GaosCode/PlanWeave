import type { Command } from "commander";
import { getAutoRunStatus } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliCanvasId, resolveCliPackageWorkspace, type CanvasCommandOptions } from "../cliWorkspace.js";

function formatRunCommand(canvasId: string | null): string {
  return ["planweave", "run", ...(canvasId ? ["--canvas", canvasId] : [])].join(" ");
}

export function registerRunStatusCommand(program: Command): void {
  addCanvasOption(program
    .command("run-status")
    .description("Show current PlanWeave runner state")
    .option("--json", "print JSON output"))
    .action(async (options: { json?: boolean } & CanvasCommandOptions) => {
      const status = await getAutoRunStatus({ projectRoot: await resolveCliPackageWorkspace(options) });
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(`current: ${status.current.refs.join(", ") || "none"}`);
      console.log(`feedback: ${status.current.feedbackId ?? "none"}`);
      console.log(`review: ${status.current.reviewBlockRef ?? "none"}`);
      console.log(`phase: ${status.explanation.phase}`);
      console.log(`latest record: ${status.explanation.latestRecordId ?? "none"}${status.explanation.latestRecordPath ? ` (${status.explanation.latestRecordPath})` : ""}`);
      console.log(`next action: ${status.explanation.nextAction.message}`);
      const nextCommand = status.explanation.nextAction.command ?? (status.explanation.nextAction.kind === "start" ? formatRunCommand(resolveCliCanvasId(options)) : null);
      if (nextCommand) {
        console.log(`next command: ${nextCommand}`);
      }
      console.log("latest runs:");
      for (const run of status.latestRuns) {
        console.log(`- ${run.ref} ${run.runId} ${run.status} ${run.executor ?? "unknown"} ${run.adapter ?? "unknown"}`);
        if (run.stdoutSummary) {
          console.log(`  stdout: ${run.stdoutSummary}`);
        }
        if (run.stderrSummary) {
          console.log(`  stderr: ${run.stderrSummary}`);
        }
        if (run.failureReason) {
          console.log(`  failure: ${run.failureReason}`);
        }
      }
    });
}
