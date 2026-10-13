import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isNodeFileNotFoundError, optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { normalizeProjectMetadata } from "../project.js";
import { readProjectMetadataFile } from "../projectMetadata.js";
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

function sourceDefaultProjectFilePath(planweaveHome: string): string {
  return join(planweaveHome, "source-defaults.json");
}

async function readSourceDefaultProjectFile(
  planweaveHome: string
): Promise<SourceDefaultProjectFile> {
  const path = sourceDefaultProjectFilePath(planweaveHome);
  if (!(await optionalStat(path))) {
    return { version: sourceDefaultProjectVersion, defaults: {} };
  }
  const parsed = await readJsonFile<Partial<SourceDefaultProjectFile>>(path);
  return {
    version: sourceDefaultProjectVersion,
    defaults: parsed.defaults ?? {}
  };
}

async function writeSourceDefaultProjectFile(
  file: SourceDefaultProjectFile,
  planweaveHome: string
): Promise<void> {
  await writeJsonFile(sourceDefaultProjectFilePath(planweaveHome), {
    version: sourceDefaultProjectVersion,
    defaults: file.defaults
  });
}

async function registeredProject(
  projectId: string,
  planweaveHome: string
): Promise<{ project: ProjectMetadata; workspaceRoot: string } | null> {
  const workspaceRoot = join(planweaveHome, "projects", projectId);
  const projectFile = join(workspaceRoot, "project.json");
  if (!(await optionalStat(projectFile))) {
    return null;
  }
  const project = normalizeProjectMetadata(await readProjectMetadataFile(projectFile), {
    planweaveHome,
    workspaceRoot
  });
  return { project, workspaceRoot };
}

async function registeredProjects(
  planweaveHome: string
): Promise<Array<{ project: ProjectMetadata; workspaceRoot: string }>> {
  const projectsRoot = join(planweaveHome, "projects");
  const entries = await optionalReaddir(projectsRoot, { withFileTypes: true });
  if (!entries) {
    return [];
  }
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => registeredProject(entry.name, planweaveHome))
  );
  return projects.filter(
    (project): project is { project: ProjectMetadata; workspaceRoot: string } => project !== null
  );
}

async function normalizeSourceRoot(sourceRoot: string): Promise<string> {
  const resolvedSourceRoot = await realpath(sourceRoot);
  const sourceRootStat = await stat(resolvedSourceRoot);
  if (!sourceRootStat.isDirectory()) {
    throw new Error("Source root must be a directory.");
  }
  return resolvedSourceRoot;
}

async function validateSourceDefaultProject(
  sourceRoot: string,
  projectId: string,
  planweaveHome: string
): Promise<SourceDefaultProjectEntry> {
  const resolvedSourceRoot = await normalizeSourceRoot(sourceRoot);
  const registered = await registeredProject(projectId, planweaveHome);
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

export async function setSourceDefaultProject(
  sourceRoot: string,
  projectId: string
): Promise<SourceDefaultProjectEntry> {
  const planweaveHome = resolvePlanweaveHome();
  const entry = await validateSourceDefaultProject(sourceRoot, projectId, planweaveHome);
  const file = await readSourceDefaultProjectFile(planweaveHome);
  file.defaults[entry.sourceRoot] = entry;
  await writeSourceDefaultProjectFile(file, planweaveHome);
  return entry;
}

export async function updateSourceDefaultProjectReference(
  previousProjectId: string,
  next: { projectId: string; projectRoot: string },
  planweaveHome: string = resolvePlanweaveHome()
): Promise<void> {
  const file = await readSourceDefaultProjectFile(planweaveHome);
  let changed = false;
  for (const [sourceRoot, entry] of Object.entries(file.defaults)) {
    if (entry.projectId !== previousProjectId) {
      continue;
    }
    file.defaults[sourceRoot] = {
      ...entry,
      projectId: next.projectId,
      projectRoot: next.projectRoot,
      updatedAt: new Date().toISOString()
    };
    changed = true;
  }
  if (changed) {
    await writeSourceDefaultProjectFile(file, planweaveHome);
  }
}

export async function clearSourceDefaultProject(
  sourceRoot: string,
  planweaveHome: string = resolvePlanweaveHome()
): Promise<SourceDefaultProjectEntry | null> {
  const resolvedSourceRoot = await normalizeSourceRoot(sourceRoot);
  const file = await readSourceDefaultProjectFile(planweaveHome);
  const current = file.defaults[resolvedSourceRoot] ?? null;
  delete file.defaults[resolvedSourceRoot];
  await writeSourceDefaultProjectFile(file, planweaveHome);
  return current;
}

export async function getSourceDefaultProject(
  sourceRoot: string,
  planweaveHome: string = resolvePlanweaveHome()
): Promise<SourceDefaultProjectEntry | null> {
  const resolvedSourceRoot = await normalizeSourceRoot(sourceRoot);
  const file = await readSourceDefaultProjectFile(planweaveHome);
  return file.defaults[resolvedSourceRoot] ?? null;
}

export async function listSourceDefaultProjectCandidates(
  sourceRoot: string
): Promise<SourceDefaultProjectCandidate[]> {
  const planweaveHome = resolvePlanweaveHome();
  const resolvedSourceRoot = await normalizeSourceRoot(sourceRoot);
  const candidates: SourceDefaultProjectCandidate[] = [];
  for (const registered of await registeredProjects(planweaveHome)) {
    if (!registered.project.sourceRoot) {
      continue;
    }
    let projectSourceRoot: string;
    try {
      projectSourceRoot = await realpath(registered.project.sourceRoot);
    } catch (error) {
      if (isNodeFileNotFoundError(error)) {
        continue;
      }
      throw error;
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
  return candidates.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.projectId.localeCompare(right.projectId)
  );
}

export async function resolveSourceDefaultProjectRoot(sourceRoot: string): Promise<string | null> {
  const planweaveHome = resolvePlanweaveHome();
  const current = await getSourceDefaultProject(sourceRoot, planweaveHome);
  if (!current) {
    return null;
  }
  await validateSourceDefaultProject(current.sourceRoot, current.projectId, planweaveHome);
  return current.projectRoot;
}
