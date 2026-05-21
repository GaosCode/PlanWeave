import type { Command } from "commander";
import { runAutoRunStep } from "@planweave/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run PlanWeave auto-run until it stops, or one step with --once")
    .option("--once", "execute only one auto-run step")
    .option("--parallel", "claim a deterministic parallel batch")
    .option("--executor <name>", "override executor profile for this run")
    .option("--json", "print JSON output")
    .action(async (options: { once?: boolean; parallel?: boolean; executor?: string; json?: boolean }) => {
      const projectRoot = resolveCliProjectRoot();
      const steps = [];
      let last = await runAutoRunStep({
        projectRoot,
        executorName: options.executor,
        parallel: options.parallel
      });
      steps.push(last);

      while (!options.once && (last.kind === "submitted" || last.kind === "batch_submitted")) {
        last = await runAutoRunStep({
          projectRoot,
          executorName: options.executor,
          parallel: options.parallel
        });
        steps.push(last);
      }

      if (options.json) {
        console.log(JSON.stringify(options.once ? steps[0] : { steps, final: last }, null, 2));
        return;
      }

      if (options.once) {
        console.log(formatRunStep(steps[0]));
        return;
      }
      console.log(steps.map(formatRunStep).join("\n"));
    });
}

function formatRunStep(step: Awaited<ReturnType<typeof runAutoRunStep>>): string {
  if (step.kind === "submitted") {
    return `submitted ${step.claim.kind}${step.claim.kind === "block" ? ` ${step.claim.ref}` : ""}`;
  }
  if (step.kind === "batch_submitted") {
    return `batch submitted ${step.steps.length} blocks`;
  }
  if (step.kind === "manual") {
    return `manual ${step.claim.kind}${step.claim.kind === "block" ? ` ${step.claim.ref}` : ""}\nprompt: ${step.adapterResult.promptPath}\nnext: ${step.adapterResult.nextCommand}`;
  }
  return `${step.kind}: ${step.claim.kind}`;
}
