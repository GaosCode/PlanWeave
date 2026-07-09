import type { Command } from "commander";
import { resolveBlockDivergence } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerResolveDivergenceCommand(program: Command): void {
  addCanvasOption(
    program
      .command("resolve-divergence")
      .argument("<block-ref>")
      .requiredOption("--reason <reason>", "why the divergence is resolved")
      .description("Clear a diverged block after the Plan Package has been reconciled")
  ).action(async (ref: string, options: { reason: string } & CanvasCommandOptions) => {
    const result = await resolveBlockDivergence({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref,
      reason: options.reason
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
