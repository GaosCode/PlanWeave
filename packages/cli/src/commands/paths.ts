import type { Command } from "commander";
import { PlanWeaveWorkspaceNotInitializedError, readProjectPaths } from "@planweave-ai/runtime";
import { formatWorkspaceNotInitialized, workspaceNotInitializedJson } from "../errors.js";
import { resolveCliProjectRoot } from "../projectRoot.js";

export function registerPathsCommand(program: Command): void {
  program
    .command("paths")
    .description("Print PlanWeave workspace paths for the current project")
    .option("--json", "print machine-readable output")
    .action(async (options: { json?: boolean }) => {
      let paths: Awaited<ReturnType<typeof readProjectPaths>>;
      try {
        paths = await readProjectPaths(await resolveCliProjectRoot());
      } catch (error) {
        if (!(error instanceof PlanWeaveWorkspaceNotInitializedError)) {
          throw error;
        }
        process.exitCode = 1;
        if (options.json) {
          console.log(JSON.stringify(workspaceNotInitializedJson(error), null, 2));
          return;
        }
        console.error(formatWorkspaceNotInitialized(error));
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(paths, null, 2));
        return;
      }
      console.log(`Workspace directory: ${paths.workspaceDir}`);
      console.log(`Project: ${paths.projectId}`);
      console.log(`Project directory: ${paths.projectDir}`);
      console.log(`Package: ${paths.packageDir}`);
      console.log(`State: ${paths.statePath}`);
      console.log(`Results: ${paths.resultsDir}`);
    });
}
