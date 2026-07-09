import type { Command } from "commander";
import { resolve } from "node:path";
import {
  archiveTaskCanvas,
  createCanvasWorkspace,
  getActiveTaskCanvasId,
  listTaskCanvases,
  selectTaskCanvas,
  type ArchiveTaskCanvasResult,
  type CreateCanvasWorkspaceResult,
  type DesktopTaskCanvasSummary
} from "@planweave-ai/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

// Runtime inventory (plan 021):
// - list → listTaskCanvases + getActiveTaskCanvasId (active canvas = default when --canvas omitted)
// - use/activate → selectTaskCanvas
// - archive → archiveTaskCanvas (quarantine via removeTaskCanvas; refuses only/default/active without force+reason)

type CanvasCreateOptions = {
  id?: string;
  title: string;
  activate?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

type CanvasListOptions = {
  json?: boolean;
};

type CanvasUseOptions = {
  json?: boolean;
};

type CanvasArchiveOptions = {
  force?: boolean;
  reason?: string;
  json?: boolean;
};

type CanvasCreateOutput = Omit<
  CreateCanvasWorkspaceResult,
  "canvasValidationArgs" | "projectValidationArgs" | "qualityArgs"
> & {
  canvasValidationCommand: string;
  projectValidationCommand: string;
  qualityCommand: string;
};

type CanvasListEntry = {
  canvasId: string;
  title: string;
  active: boolean;
  taskCount: number;
  packageDir: string | null;
};

type CanvasListOutput = {
  activeCanvasId: string | null;
  canvases: CanvasListEntry[];
};

type CanvasUseOutput = {
  action: "set";
  activeCanvasId: string;
  canvases: CanvasListEntry[];
};

function shellQuoteArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function planweaveCommand(args: string[]): string {
  return ["planweave", ...args].map(shellQuoteArg).join(" ");
}

function toCanvasCreateOutput(
  result: CreateCanvasWorkspaceResult,
  projectRoot: string
): CanvasCreateOutput {
  const rootArgs = ["--project-root", projectRoot];
  return {
    canvasId: result.canvasId,
    title: result.title,
    created: result.created,
    activated: result.activated,
    projectGraphPath: result.projectGraphPath,
    canvasRoot: result.canvasRoot,
    packageDir: result.packageDir,
    manifestPath: result.manifestPath,
    taskPromptsDir: result.taskPromptsDir,
    blockPromptsDir: result.blockPromptsDir,
    statePath: result.statePath,
    resultsDir: result.resultsDir,
    canvasValidationCommand: planweaveCommand([...rootArgs, ...result.canvasValidationArgs]),
    projectValidationCommand: planweaveCommand([...rootArgs, ...result.projectValidationArgs]),
    qualityCommand: planweaveCommand([...rootArgs, ...result.qualityArgs])
  };
}

function formatCanvasCreateHuman(result: CanvasCreateOutput): string {
  return [
    `Canvas: ${result.canvasId}`,
    `Created: ${result.created ? "yes" : "no"}`,
    `Activated: ${result.activated ? "yes" : "no"}`,
    `Package: ${result.packageDir}`,
    `Manifest: ${result.manifestPath}`,
    `Validate canvas: ${result.canvasValidationCommand}`,
    `Validate project: ${result.projectValidationCommand}`,
    `Quality: ${result.qualityCommand}`
  ].join("\n");
}

function toListEntries(
  canvases: DesktopTaskCanvasSummary[],
  activeCanvasId: string | null
): CanvasListEntry[] {
  return canvases.map((canvas) => ({
    canvasId: canvas.canvasId,
    title: canvas.name,
    active: canvas.canvasId === activeCanvasId,
    taskCount: canvas.taskCount,
    packageDir: canvas.packageDir
  }));
}

async function loadCanvasList(projectRoot: string): Promise<CanvasListOutput> {
  const [canvases, activeCanvasId] = await Promise.all([
    listTaskCanvases(projectRoot),
    getActiveTaskCanvasId(projectRoot)
  ]);
  return {
    activeCanvasId,
    canvases: toListEntries(canvases, activeCanvasId)
  };
}

function formatCanvasListHuman(result: CanvasListOutput): string {
  if (result.canvases.length === 0) {
    return "Canvases: none";
  }
  const lines = [`Active canvas: ${result.activeCanvasId ?? "(none)"}`, "Canvases:"];
  for (const canvas of result.canvases) {
    const marker = canvas.active ? " (active)" : "";
    lines.push(`- ${canvas.canvasId}${marker}`);
    lines.push(`  title: ${canvas.title}`);
    lines.push(`  tasks: ${canvas.taskCount}`);
    if (canvas.packageDir) {
      lines.push(`  package: ${canvas.packageDir}`);
    }
  }
  return lines.join("\n");
}

function formatCanvasUseHuman(result: CanvasUseOutput): string {
  return [
    `Set active canvas: ${result.activeCanvasId}`,
    formatCanvasListHuman({ activeCanvasId: result.activeCanvasId, canvases: result.canvases })
  ].join("\n");
}

function formatCanvasArchiveHuman(result: ArchiveTaskCanvasResult): string {
  const lines = [
    `Archived canvas: ${result.archivedCanvasId}`,
    `Forced: ${result.forced ? "yes" : "no"}`,
    `Reason: ${result.reason ?? "(none)"}`,
    `Active canvas: ${result.activeCanvasId ?? "(none)"}`,
    "Remaining canvases:"
  ];
  if (result.remaining.length === 0) {
    lines.push("- (none)");
  } else {
    for (const canvas of result.remaining) {
      const marker = canvas.canvasId === result.activeCanvasId ? " (active)" : "";
      lines.push(`- ${canvas.canvasId}${marker}: ${canvas.name}`);
    }
  }
  return lines.join("\n");
}

export function registerCanvasCommand(program: Command): void {
  const canvas = program.command("canvas").description("Manage PlanWeave canvases");

  canvas
    .command("create")
    .description("Create a new PlanWeave canvas workspace")
    .option("--id <canvasId>", "requested canvas id")
    .requiredOption("--title <title>", "canvas title")
    .option("--activate", "make the new canvas active")
    .option("--dry-run", "print the workspace that would be created without writing files")
    .option("--json", "print machine-readable output")
    .action(async (options: CanvasCreateOptions) => {
      const projectRoot = resolve(await resolveCliProjectRoot());
      const result = await createCanvasWorkspace({
        cwd: projectRoot,
        id: options.id,
        title: options.title,
        activate: options.activate,
        dryRun: options.dryRun
      });
      const output = toCanvasCreateOutput(result, projectRoot);
      console.log(options.json ? JSON.stringify(output, null, 2) : formatCanvasCreateHuman(output));
    });

  canvas
    .command("list")
    .description("List PlanWeave canvases in the current project")
    .option("--json", "print machine-readable output")
    .action(async (options: CanvasListOptions) => {
      const projectRoot = resolve(await resolveCliProjectRoot());
      const output = await loadCanvasList(projectRoot);
      console.log(options.json ? JSON.stringify(output, null, 2) : formatCanvasListHuman(output));
    });

  canvas
    .command("use <canvasId>")
    .alias("activate")
    .description("Set the active PlanWeave canvas (default target when --canvas is omitted)")
    .option("--json", "print machine-readable output")
    .action(async (canvasId: string, options: CanvasUseOptions) => {
      const projectRoot = resolve(await resolveCliProjectRoot());
      const activeCanvasId = await selectTaskCanvas(projectRoot, canvasId);
      const listed = await loadCanvasList(projectRoot);
      const output: CanvasUseOutput = {
        action: "set",
        activeCanvasId,
        canvases: listed.canvases
      };
      console.log(options.json ? JSON.stringify(output, null, 2) : formatCanvasUseHuman(output));
    });

  canvas
    .command("archive <canvasId>")
    .description(
      "Reversibly retire a non-default canvas (quarantine workspace; does not delete data)"
    )
    .option("--force", "allow archiving the active canvas after switching to a fallback")
    .option("--reason <text>", "record why the canvas is being archived (required with --force)")
    .option("--json", "print machine-readable output")
    .action(async (canvasId: string, options: CanvasArchiveOptions) => {
      const projectRoot = resolve(await resolveCliProjectRoot());
      const result = await archiveTaskCanvas(projectRoot, canvasId, {
        force: options.force,
        reason: options.reason
      });
      console.log(
        options.json ? JSON.stringify(result, null, 2) : formatCanvasArchiveHuman(result)
      );
    });
}
