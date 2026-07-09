import type { Command } from "commander";
import { markBlockBlocked } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerMarkBlockedCommand(program: Command): void {
  addCanvasOption(
    program
      .command("mark-blocked")
      .argument("<block-ref>")
      .requiredOption("--reason <reason>", "why the block is blocked")
      .description("Mark a block as blocked")
  ).action(async (ref: string, options: { reason: string } & CanvasCommandOptions) => {
    const result = await markBlockBlocked({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref,
      reason: options.reason
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
