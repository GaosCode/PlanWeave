import type { Command } from "commander";
import {
  applyDefaultCanvasWorkspaceMigration,
  detectDefaultCanvasWorkspaceMigration,
  materializeProjectGraph,
  resolveProjectWorkspace
} from "@planweave-ai/runtime";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerProjectGraphCommand(program: Command): void {
  const command = program.command("project-graph").description("Manage the formal project-graph.json canvas graph");

  command
    .command("migrate")
    .description("Write project-graph.json from the current legacy/default canvas graph when it is missing")
    .option("--json", "print machine-readable output")
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await resolveCliProjectRoot();
      const workspace = await resolveProjectWorkspace(projectRoot);
      const migrationPlan = await detectDefaultCanvasWorkspaceMigration(workspace);
      if (migrationPlan.action === "conflict") {
        const result = {
          action: "conflict",
          diagnostics: migrationPlan.diagnostics,
          canonicalPaths: migrationPlan.canonicalPaths,
          legacyPaths: migrationPlan.legacyPaths
        };
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          process.exitCode = 1;
          return;
        }
        throw new Error(migrationPlan.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"));
      }
      if (migrationPlan.action === "migrate" || migrationPlan.action === "mixed_identical") {
        const result = await applyDefaultCanvasWorkspaceMigration(workspace);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Default canvas migration: ${result.action}`);
        console.log(`Project graph: ${result.projectGraphPath}`);
        if (result.legacyBackupPaths.workspaceRoot) {
          console.log(`Legacy backup: ${result.legacyBackupPaths.workspaceRoot}`);
        }
        return;
      }
      const materialized = await materializeProjectGraph(projectRoot);
      const result = {
        action: materialized.created ? "materialize_project_graph" : "none",
        diagnostics: [],
        canonicalPaths: migrationPlan.canonicalPaths,
        legacyPaths: migrationPlan.legacyPaths,
        legacyBackupPaths: {},
        ...materialized
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(materialized.created ? `Project graph: ${materialized.path}` : `Project graph already exists: ${materialized.path}`);
      console.log(`Source: ${materialized.source}`);
      console.log(`Canvases: ${materialized.canvasCount}`);
    });
}
