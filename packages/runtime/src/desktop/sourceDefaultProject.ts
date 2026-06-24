import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { normalizeProjectMetadata } from "../project.js";
import type { ProjectMetadata } from "../types.js";

const sourceDefaultProjectVersion = "planweave-source-defaults/v1";

export type SourceDefaultProjectEntry = {
  projectId: string;
  projectRoot: string;
  sourceRoot: string;
  updatedAt: string;
};

export type SourceDefaultProjectCandidate = {
  projectId: string;
  projectRoot: string;
  sourceRoot: string;
  name: string;
  kind: "external" | "managed";
};

type SourceDefaultProjectFile = {
  version: typeof sourceDefaultProjectVersion;
  defaults: Record<string, SourceDefaultProjectEntry>;
};

function sourceDefaultProjectFilePath(): string {
  return join(resolvePlanweaveHome(), "source-defaults.json");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readSourceDefaultProjectFile(): Promise<SourceDefaultProjectFile> {
  const path = sourceDefaultProjectFilePath();
  if (!(await exists(path))) {
    return { version: sourceDefaultProjectVersion, defaults: {} };
  }
  const parsed = await readJsonFile<Partial<SourceDefaultProjectFile>>(path);
  return {
    version: sourceDefaultProjectVersion,
    defaults: parsed.defaults ?? {}
  };
}

async function writeSourceDefaultProjectFile(file: SourceDefaultProjectFile): Promise<void> {
  await writeJsonFile(sourceDefaultProjectFilePath(), {
    version: sourceDefaultProjectVersion,
    defaults: file.defaults
  });
}

async function registeredProject(projectId: string): Promise<{ project: ProjectMetadata; workspaceRoot: string } | null> {
  const planweaveHome = resolvePlanweaveHome();
  const workspaceRoot = join(planweaveHome, "projects", projectId);
  const projectFile = join(workspaceRoot, "project.json");
  if (!(await exists(projectFile))) {
    return null;
  }
  const project = normalizeProjectMetadata(await readJsonFile<ProjectMetadata>(projectFile), {
    planweaveHome,
    workspaceRoot
  });
  return { project, workspaceRoot };
}

async function registeredProjects(): Promise<Array<{ project: ProjectMetadata; workspaceRoot: string }>> {
  const planweaveHome = resolvePlanweaveHome();
  const projectsRoot = join(planweaveHome, "projects");
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => registeredProject(entry.name))
  );
  return projects.filter((project): project is { project: ProjectMetadata; workspaceRoot: string } => project !== null);
}

async function normalizeSourceRoot(sourceRoot: string): Promise<string> {
  const resolvedSourceRoot = await realpath(sourceRoot);
  const sourceRootStat = await stat(resolvedSourceRoot);
  if (!sourceRootStat.isDirectory()) {
    throw new Error("Source root must be a directory.");
  }
  return resolvedSourceRoot;
}

async function validateSourceDefaultProject(sourceRoot: string, projectId: string): Promise<SourceDefaultProjectEntry> {
  const resolvedSourceRoot = await normalizeSourceRoot(sourceRoot);
  const registered = await registeredProject(projectId);
  if (!registered) {
    throw new Error(`PlanWeave project '${projectId}' does not exist.`);
  }
  if (!registered.project.sourceRoot) {
    throw new Error(`PlanWeave project '${projectId}' is not linked to a source root.`);
  }
  const projectSourceRoot = await realpath(registered.project.sourceRoot);
  if (projectSourceRoot !== resolvedSourceRoot) {
    throw new Error(
      `PlanWeave project '${projectId}' is linked to source root '${projectSourceRoot}', not '${resolvedSourceRoot}'.`
    );
  }
  return {
    projectId,
    projectRoot: registered.workspaceRoot,
    sourceRoot: resolvedSourceRoot,
    updatedAt: new Date().toISOString()
  };
}

export async function setSourceDefaultProject(sourceRoot: string, projectId: string): Promise<SourceDefaultProjectEntry> {
  const entry = await validateSourceDefaultProject(sourceRoot, projectId);
  const file = await readSourceDefaultProjectFile();
  file.defaults[entry.sourceRoot] = entry;
  await writeSourceDefaultProjectFile(file);
  return entry;
}

export async function clearSourceDefaultProject(sourceRoot: string): Promise<SourceDefaultProjectEntry | null> {
  const resolvedSourceRoot = await normalizeSourceRoot(sourceRoot);
  const file = await readSourceDefaultProjectFile();
  const current = file.defaults[resolvedSourceRoot] ?? null;
  delete file.defaults[resolvedSourceRoot];
  await writeSourceDefaultProjectFile(file);
  return current;
}

export async function getSourceDefaultProject(sourceRoot: string): Promise<SourceDefaultProjectEntry | null> {
  const resolvedSourceRoot = await normalizeSourceRoot(sourceRoot);
  const file = await readSourceDefaultProjectFile();
  return file.defaults[resolvedSourceRoot] ?? null;
}

export async function listSourceDefaultProjectCandidates(sourceRoot: string): Promise<SourceDefaultProjectCandidate[]> {
  const resolvedSourceRoot = await normalizeSourceRoot(sourceRoot);
  const candidates: SourceDefaultProjectCandidate[] = [];
  for (const registered of await registeredProjects()) {
    if (!registered.project.sourceRoot) {
      continue;
    }
    let projectSourceRoot: string;
    try {
      projectSourceRoot = await realpath(registered.project.sourceRoot);
    } catch {
      continue;
    }
    if (projectSourceRoot !== resolvedSourceRoot) {
      continue;
    }
    candidates.push({
      projectId: registered.project.id,
      projectRoot: registered.workspaceRoot,
      sourceRoot: projectSourceRoot,
      name: registered.project.name,
      kind: registered.project.kind === "managed" ? "managed" : "external"
    });
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name) || left.projectId.localeCompare(right.projectId));
}

export async function resolveSourceDefaultProjectRoot(sourceRoot: string): Promise<string | null> {
  const current = await getSourceDefaultProject(sourceRoot);
  if (!current) {
    return null;
  }
  await validateSourceDefaultProject(current.sourceRoot, current.projectId);
  return current.projectRoot;
}
