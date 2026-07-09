import type { Command } from "commander";
import { refreshPrompt } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerRefreshPromptCommand(program: Command): void {
  addCanvasOption(
    program
      .command("refresh-prompt")
      .argument("<block-ref>")
      .description("Render one block Prompt Surface without writing source prompts")
  ).action(async (ref: string, options: CanvasCommandOptions) => {
    const result = await refreshPrompt({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref
    });
    console.log(JSON.stringify({ ref: result.ref, rendered: true }, null, 2));
  });
}
