import type { Command } from "commander";
import { getAutoRunStatus } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliCanvasId, resolveCliPackageWorkspace, type CanvasCommandOptions } from "../cliWorkspace.js";
import { explicitCliProjectRoot } from "../projectRoot.js";
import { formatRunStatusHuman } from "./formatters/runFormatters.js";

function shellQuoteArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function formatRunCommand(options: CanvasCommandOptions): string {
  const canvasId = resolveCliCanvasId(options);
  const projectRoot = explicitCliProjectRoot();
  return ["planweave", ...(projectRoot ? ["--project-root", projectRoot] : []), "run", ...(canvasId ? ["--canvas", canvasId] : [])].map(shellQuoteArg).join(" ");
}

export function registerRunStatusCommand(program: Command): void {
  addCanvasOption(program
    .command("run-status")
    .description("Show current PlanWeave runner state")
    .option("--json", "print JSON output"))
    .action(async (options: { json?: boolean } & CanvasCommandOptions) => {
      const status = await getAutoRunStatus({ projectRoot: await resolveCliPackageWorkspace(options) });
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(formatRunStatusHuman(status, { defaultStartCommand: formatRunCommand(options) }));
    });
}
