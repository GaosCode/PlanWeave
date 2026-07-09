import type { Command } from "commander";
import { resolveTaskCanvasWorkspace, type PackageWorkspaceRef } from "@planweave-ai/runtime";
import { resolveCliProjectRoot } from "./projectRoot.js";

export type CanvasCommandOptions = {
  canvas?: string;
};

export function addCanvasOption(command: Command): Command {
  return command.option("--canvas <canvasId>", "select a task canvas in a multi-canvas project");
}

export function resolveCliCanvasId(options: CanvasCommandOptions = {}): string | null {
  return options.canvas?.trim() || process.env.PLANWEAVE_CANVAS_ID?.trim() || null;
}

export async function resolveCliPackageWorkspace(
  options: CanvasCommandOptions = {}
): Promise<PackageWorkspaceRef> {
  const projectRoot = await resolveCliProjectRoot();
  const canvasId = resolveCliCanvasId(options);
  return canvasId ? resolveTaskCanvasWorkspace(projectRoot, canvasId) : projectRoot;
}
