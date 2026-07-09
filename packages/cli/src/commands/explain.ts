import type { Command } from "commander";
import { explainBlock } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";

export function registerExplainCommand(program: Command): void {
  addCanvasOption(
    program.command("explain <ref>").description("Explain why a block is or is not claimable")
  ).action(async (ref: string, options: CanvasCommandOptions) => {
    const result = await explainBlock({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref
    });
    console.log(JSON.stringify(result, null, 2));
  });
}

export function registerWhyNotCommand(program: Command): void {
  addCanvasOption(
    program
      .command("why-not <ref>")
      .description("Alias for explain: show why a block is not claimable")
  ).action(async (ref: string, options: CanvasCommandOptions) => {
    const result = await explainBlock({
      projectRoot: await resolveCliPackageWorkspace(options),
      ref
    });
    console.log(JSON.stringify(result, null, 2));
  });
}
