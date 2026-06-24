import type { Command } from "commander";
import {
  clearSourceDefaultProject,
  getSourceDefaultProject,
  listSourceDefaultProjectCandidates,
  setSourceDefaultProject,
  type SourceDefaultProjectCandidate,
  type SourceDefaultProjectEntry
} from "@planweave-ai/runtime";
import { resolveRawCliProjectRoot } from "../projectRoot.js";

type UseCommandOptions = {
  clear?: boolean;
  json?: boolean;
  sourceRoot?: string;
};

function commandSourceRoot(options: UseCommandOptions): string {
  return options.sourceRoot?.trim() || resolveRawCliProjectRoot();
}

function printUseJson(result: {
  action: "cleared" | "set" | "show";
  availableProjects: SourceDefaultProjectCandidate[];
  clearedProject?: SourceDefaultProjectEntry | null;
  defaultProject: SourceDefaultProjectEntry | null;
  sourceRoot: string;
}): void {
  console.log(JSON.stringify(result, null, 2));
}

function printUseHuman(result: {
  action: "cleared" | "set" | "show";
  availableProjects: SourceDefaultProjectCandidate[];
  clearedProject?: SourceDefaultProjectEntry | null;
  defaultProject: SourceDefaultProjectEntry | null;
  sourceRoot: string;
}): void {
  if (result.defaultProject) {
    const verb = result.action === "set" ? "Set" : result.action === "cleared" ? "Cleared" : "Current";
    console.log(`${verb} PlanWeave default for source root: ${result.defaultProject.sourceRoot}`);
    console.log(`Project: ${result.defaultProject.projectId}`);
    console.log(`Project root: ${result.defaultProject.projectRoot}`);
  } else if (result.action === "cleared") {
    console.log(`Cleared PlanWeave default for source root: ${result.sourceRoot}`);
  } else {
    console.log(`No PlanWeave default is set for source root: ${result.sourceRoot}`);
  }

  if (result.availableProjects.length === 0) {
    console.log("Available projects: none");
    return;
  }
  console.log("Available projects:");
  for (const project of result.availableProjects) {
    const marker = result.defaultProject?.projectId === project.projectId ? " (current)" : "";
    console.log(`- ${project.projectId}${marker}`);
    console.log(`  name: ${project.name}`);
    console.log(`  kind: ${project.kind}`);
    console.log(`  project root: ${project.projectRoot}`);
    console.log(`  switch: planweave use ${project.projectId}`);
  }
}

export function registerUseCommand(program: Command): void {
  program
    .command("use [projectId]")
    .description("Set or show the default PlanWeave project for the current source root")
    .option("--source-root <path>", "set or inspect the default for this source root instead of INIT_CWD or cwd")
    .option("--clear", "clear the default PlanWeave project for the source root")
    .option("--json", "print machine-readable output")
    .action(async (projectId: string | undefined, options: UseCommandOptions) => {
      const sourceRoot = commandSourceRoot(options);
      if (options.clear) {
        if (projectId) {
          throw new Error("planweave use --clear cannot be combined with a projectId.");
        }
        const cleared = await clearSourceDefaultProject(sourceRoot);
        const availableProjects = await listSourceDefaultProjectCandidates(sourceRoot);
        const result = { action: "cleared" as const, availableProjects, clearedProject: cleared, defaultProject: null, sourceRoot };
        options.json ? printUseJson(result) : printUseHuman(result);
        return;
      }
      if (projectId) {
        const next = await setSourceDefaultProject(sourceRoot, projectId);
        const availableProjects = await listSourceDefaultProjectCandidates(sourceRoot);
        const result = { action: "set" as const, availableProjects, defaultProject: next, sourceRoot };
        options.json ? printUseJson(result) : printUseHuman(result);
        return;
      }
      const current = await getSourceDefaultProject(sourceRoot);
      const availableProjects = await listSourceDefaultProjectCandidates(sourceRoot);
      const result = { action: "show" as const, availableProjects, defaultProject: current, sourceRoot };
      options.json ? printUseJson(result) : printUseHuman(result);
    });
}
