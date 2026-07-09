import type { Command } from "commander";
import { getPrompt } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerPromptCommand(program: Command): void {
  addCanvasOption(
    program
      .command("prompt")
      .argument("<block-ref>")
      .description("Render and print a block Prompt Surface")
  ).action(async (ref: string, options: CanvasCommandOptions) => {
    process.stdout.write(
      await getPrompt({ projectRoot: await resolveCliPackageWorkspace(options), ref })
    );
  });
}
