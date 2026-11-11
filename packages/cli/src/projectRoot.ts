import { InvalidArgumentError, type Command } from "commander";
import {
  hasProjectRegistration,
  listSourceDefaultProjectCandidates,
  readProject,
  resolveSourceDefaultProjectRoot
} from "@planweave-ai/runtime";

export type ProjectRootCommandOptions = {
  projectRoot?: string;
};

let projectRootOverride: string | undefined;

function trimProjectRoot(value: string, source: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${source} must not be empty. Pass a non-empty path or unset it.`);
  }
  return trimmed;
}

function parseProjectRootOption(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidArgumentError("--project-root must not be empty.");
  }
  return trimmed;
}

export function addProjectRootOption(program: Command): Command {
  return program
    .option(
      "--project-root <path>",
      "resolve the PlanWeave project from this root instead of INIT_CWD or cwd",
      parseProjectRootOption
    )
    .hook("preAction", (rootCommand) => {
      projectRootOverride = rootCommand.opts<ProjectRootCommandOptions>().projectRoot;
    });
}

export function resolveRawCliProjectRoot(): string {
  if (process.env.INIT_CWD !== undefined) {
    return trimProjectRoot(process.env.INIT_CWD, "INIT_CWD");
  }
  return process.cwd();
}

async function resolveRegisteredCliProjectRoot(
  rawRoot: string,
  isRegistered: (root: string) => Promise<boolean>
): Promise<string> {
  if (await isRegistered(rawRoot)) {
    return rawRoot;
  }
  const defaultProjectRoot = await resolveSourceDefaultProjectRoot(rawRoot);
  if (defaultProjectRoot) {
    return defaultProjectRoot;
  }
  const candidates = await listSourceDefaultProjectCandidates(rawRoot);
  if (candidates.length === 1) {
    return candidates[0].projectRoot;
  }
  if (candidates.length > 1) {
    const candidateList = candidates
      .map((candidate) => `${candidate.projectId} (${candidate.projectRoot})`)
      .join(", ");
    throw new Error(
      `Multiple PlanWeave projects are linked to source root '${rawRoot}'. Run 'planweave use <projectId> --source-root ${rawRoot}' to choose one. Candidates: ${candidateList}`
    );
  }
  return rawRoot;
}

export async function resolveCliProjectRootFromRaw(rawRoot: string): Promise<string> {
  return resolveRegisteredCliProjectRoot(
    rawRoot,
    async (root) => (await readProject(root)) !== null
  );
}

export async function resolveCliProjectRoot(): Promise<string> {
  return resolveCliProjectRootFromRaw(explicitCliProjectRoot() ?? resolveRawCliProjectRoot());
}

export async function resolveCliValidationProjectRoot(): Promise<string> {
  return resolveRegisteredCliProjectRoot(
    explicitCliProjectRoot() ?? resolveRawCliProjectRoot(),
    hasProjectRegistration
  );
}

export function explicitCliProjectRoot(): string | null {
  if (projectRootOverride !== undefined) {
    return trimProjectRoot(projectRootOverride, "--project-root");
  }
  return process.env.PLANWEAVE_PROJECT_ROOT === undefined
    ? null
    : trimProjectRoot(process.env.PLANWEAVE_PROJECT_ROOT, "PLANWEAVE_PROJECT_ROOT");
}
