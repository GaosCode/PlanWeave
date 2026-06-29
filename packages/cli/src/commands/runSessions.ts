import type { Command } from "commander";
import { getRunSession, listRunSessions } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliPackageWorkspace, type CanvasCommandOptions } from "../cliWorkspace.js";
import { formatRunSessionDetail, formatRunSessions } from "./formatters/runFormatters.js";

type JsonCommandOptions = {
  json?: boolean;
} & CanvasCommandOptions;

export function registerRunSessionsCommands(program: Command): void {
  addCanvasOption(program
    .command("run-sessions")
    .description("List PlanWeave run/reset sessions")
    .option("--json", "print JSON output"))
    .action(async (options: JsonCommandOptions) => {
      const result = await listRunSessions(await resolveCliPackageWorkspace(options));
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatRunSessions(result));
    });

  addCanvasOption(program
    .command("run-session")
    .argument("<session-id>")
    .description("Show one PlanWeave run/reset session")
    .option("--json", "print JSON output"))
    .action(async (sessionId: string, options: JsonCommandOptions) => {
      const result = await getRunSession(await resolveCliPackageWorkspace(options), sessionId);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatRunSessionDetail(result));
    });
}
