import type { Command } from "commander";
import { initWorkspace } from "@planweave-ai/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create the local PlanWeave workspace for the current project")
    .option("--force", "fail if an existing workspace would require overwriting package or state")
    .option("--reset-package", "back up and recreate the Plan Package and runtime state")
    .option("--reset-results", "back up and clear task results")
    .option("--project-graph", "write formal project-graph.json for the current canvas graph")
    .option("--json", "print machine-readable output")
    .action(async (options: { force?: boolean; resetPackage?: boolean; resetResults?: boolean; projectGraph?: boolean; json?: boolean }) => {
      const result = await initWorkspace({
        projectRoot: await resolveCliProjectRoot(),
        force: options.force,
        resetPackage: options.resetPackage,
        resetResults: options.resetResults,
        projectGraph: options.projectGraph
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Workspace: ${result.workspace.workspaceRoot}`);
      console.log(`Project: ${result.project.id}`);
      if (result.projectGraph) {
        console.log(`Project graph: ${result.projectGraph.path}`);
      }
      if (result.backup) {
        console.log(`Backup: ${result.backup.backupDir}`);
      }
    });
}
