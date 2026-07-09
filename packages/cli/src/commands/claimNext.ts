import type { Command } from "commander";
import { claimNext } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerClaimNextCommand(program: Command): void {
  addCanvasOption(
    program
      .command("claim-next")
      .description("Claim the next executable block or feedback event")
      .option("--json", "print machine-readable output")
      .option(
        "--parallel",
        "claim dispatchable blocks up to maxConcurrent, backfilling current capacity"
      )
      .option("--dry-run", "preview the next claim without mutating state")
  ).action(async (options: { parallel?: boolean; dryRun?: boolean } & CanvasCommandOptions) => {
    const result = await claimNext({
      projectRoot: await resolveCliPackageWorkspace(options),
      parallel: options.parallel,
      dryRun: options.dryRun
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
