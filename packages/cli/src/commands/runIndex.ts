import type { Command } from "commander";
import { basename, dirname } from "node:path";
import {
  listTaskCanvases,
  migrateBlockRunIndexes,
  resolveTaskCanvasWorkspace
} from "@planweave-ai/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerRunIndexCommand(program: Command): void {
  const command = program
    .command("run-index")
    .description("Manage the bounded Task Workspace block-run index");

  command
    .command("migrate")
    .description("Build missing block-run indexes from legacy run metadata and reports")
    .option("--canvas <canvasId>", "migrate one task canvas")
    .option("--all-canvases", "migrate every task canvas")
    .option("--json", "print machine-readable output")
    .action(async (options: { canvas?: string; allCanvases?: boolean; json?: boolean }) => {
      if (options.canvas && options.allCanvases) {
        throw new Error("Use either --canvas or --all-canvases, not both.");
      }
      const projectRoot = await resolveCliProjectRoot();
      const canvasIds = options.allCanvases
        ? (await listTaskCanvases(projectRoot))
            .filter((canvas) => canvas.packageDir !== null)
            .map((canvas) => canvas.canvasId)
        : [options.canvas ?? null];
      const migrations = [];
      for (const canvasId of canvasIds) {
        const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
        migrations.push({
          canvasId: canvasId ?? basename(dirname(workspace.packageDir)),
          ...(await migrateBlockRunIndexes(workspace))
        });
      }
      const result = {
        indexedBlocks: migrations.reduce((total, item) => total + item.indexedBlocks, 0),
        indexedRuns: migrations.reduce((total, item) => total + item.indexedRuns, 0),
        canvases: migrations
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `Indexed ${result.indexedRuns} runs across ${result.indexedBlocks} blocks in ${migrations.length} canvas(es).`
      );
    });
}
