import type { Command } from "commander";
import { refreshPrompts } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerRefreshPromptsCommand(program: Command): void {
  addCanvasOption(
    program
      .command("refresh-prompts")
      .description("Render all block Prompt Surfaces without writing source prompts")
  ).action(async (options: CanvasCommandOptions) => {
    const result = await refreshPrompts({ projectRoot: await resolveCliPackageWorkspace(options) });
    for (const prompt of result.prompts) {
      console.log(`Rendered ${prompt.ref}`);
    }
    if (result.prompts.length === 0) {
      console.log("No block prompts to render.");
    }
  });
}
