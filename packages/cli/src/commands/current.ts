import type { Command } from "commander";
import { getCurrentWork } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliPackageWorkspace, type CanvasCommandOptions } from "../cliWorkspace.js";

export function registerCurrentCommand(program: Command): void {
  addCanvasOption(program
    .command("current")
    .description("Print the current block or feedback work item for an agent loop"))
    .option("--json", "print JSON output")
    .action(async (options: CanvasCommandOptions) => {
      const result = await getCurrentWork({ projectRoot: await resolveCliPackageWorkspace(options) });
      console.log(JSON.stringify(result, null, 2));
    });
}
