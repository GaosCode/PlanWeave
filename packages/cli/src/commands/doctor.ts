import type { Command } from "commander";
import { runDoctor, runProjectDoctor } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliPackageWorkspace, type CanvasCommandOptions } from "../cliWorkspace.js";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerDoctorCommand(program: Command): void {
  addCanvasOption(program
    .command("doctor")
    .description("Check PlanWeave state/results consistency for agent recovery")
    .option("--repair", "repair recoverable state/results drift")
    .option("--project", "check the full project graph and all task canvases"))
    .action(async (options: { repair?: boolean; project?: boolean } & CanvasCommandOptions) => {
      if (options.project === true && options.canvas) {
        throw new Error("doctor --project cannot be combined with --canvas.");
      }
      const result = options.project === true
        ? await runProjectDoctor({ projectRoot: resolveCliProjectRoot(), repair: options.repair === true })
        : await runDoctor({ projectRoot: await resolveCliPackageWorkspace(options), repair: options.repair === true });
      console.log(JSON.stringify(result, null, 2));
    });
}
