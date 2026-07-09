import type { Command } from "commander";
import { unblockBlock } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerUnblockCommand(program: Command): void {
  addCanvasOption(
    program
      .command("unblock")
      .argument("<block-ref>")
      .requiredOption("--reason <reason>", "reason for clearing the blocked state")
      .description("Clear an explicit block blocked state")
  ).action(async (ref: string, options: { reason: string } & CanvasCommandOptions) => {
    const result = await unblockBlock({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref,
      reason: options.reason
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
