import type { Command } from "commander";
import { markBlockDiverged } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerMarkDivergedCommand(program: Command): void {
  addCanvasOption(
    program
      .command("mark-diverged")
      .argument("<block-ref>")
      .requiredOption("--reason <reason>", "why the plan no longer matches implementation reality")
      .description("Mark a block as diverged")
  ).action(async (ref: string, options: { reason: string } & CanvasCommandOptions) => {
    const result = await markBlockDiverged({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref,
      reason: options.reason
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
