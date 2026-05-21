import type { Command } from "commander";
import { getAutoRunStatus } from "@planweave/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerRunStatusCommand(program: Command): void {
  program
    .command("run-status")
    .description("Show current PlanWeave runner state")
    .option("--json", "print JSON output")
    .action(async (options: { json?: boolean }) => {
      const status = await getAutoRunStatus({ projectRoot: resolveCliProjectRoot() });
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(`current: ${status.current.refs.join(", ") || "none"}`);
      console.log(`feedback: ${status.current.feedbackId ?? "none"}`);
      console.log(`review: ${status.current.reviewBlockRef ?? "none"}`);
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
