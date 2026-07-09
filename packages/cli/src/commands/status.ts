import type { Command } from "commander";
import { getExecutionStatus, type ClaimHint } from "@planweave-ai/runtime";
import {
  addCanvasOption,
  resolveCliCanvasId,
  resolveCliPackageWorkspace,
  type CanvasCommandOptions
} from "../cliWorkspace.js";
import { formatExecutionStatusHuman } from "./formatters/statusFormatters.js";

function withCanvasFlag(command: string | null, canvasId: string | null): string | null {
  if (!command || !canvasId) {
    return command;
  }
  const [binary, subcommand, ...rest] = command.split(" ");
  return [binary, subcommand, "--canvas", canvasId, ...rest].join(" ");
}

function withCanvasCommands<T extends { claimHints: ClaimHint[] }>(
  status: T,
  canvasId: string | null
): T {
  if (!canvasId) {
    return status;
  }
  return {
    ...status,
    claimHints: status.claimHints.map((hint) => ({
      ...hint,
      recommendedCommand: withCanvasFlag(hint.recommendedCommand, canvasId),
      dispatchCommand: withCanvasFlag(hint.dispatchCommand, canvasId)
    }))
  };
}

export function registerStatusCommand(program: Command): void {
  addCanvasOption(
    program
      .command("status")
      .description("Show the current PlanWeave block execution status")
      .option("--json", "print machine-readable output")
  ).action(async (options: { json?: boolean } & CanvasCommandOptions) => {
    const status = withCanvasCommands(
      await getExecutionStatus({ projectRoot: await resolveCliPackageWorkspace(options) }),
      resolveCliCanvasId(options)
    );
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(formatExecutionStatusHuman(status));
  });
}
