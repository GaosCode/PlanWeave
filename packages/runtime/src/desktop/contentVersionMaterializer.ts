import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { type CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { getProjectOverview, listProjects, removeProject } from "./projectApi.js";
import { layoutPathForWorkspace, parseDesktopLayoutForPackage } from "./layoutStore.js";
import { validateAuthoritativeCanvasContent } from "./contentVersionValidation.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { authoritativeImportReservationFile, initManagedWorkspace } from "../initWorkspace.js";
import { resolvePlanweaveHome } from "../paths.js";
import { createManagedProjectId } from "../projectId.js";
import type { DesktopProjectSummary } from "./types.js";
import {
  managedContentImportModeSchema,
  workspaceForkLineagePath,
  workspaceForkLineageSchema,
  type WorkspaceForkLineage
} from "./workspaceForkLineage.js";

type ContentVersionPathOperations = Pick<typeof nodePath, "basename" | "dirname" | "join">;

export function resolveStagedContentVersionLayoutPath(
  staging: string,
  paths: ContentVersionPathOperations = nodePath
): string {
  return paths.join(paths.dirname(staging), `${paths.basename(staging)}.layout.json`);
}

const { dirname, join } = nodePath;

function fail(code: string): Error {
  return new Error(code);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function claimReservedManagedProject(input: {
  projectId: string;
  reservationToken: string;
}): Promise<string> {
  const projectRoot = join(resolvePlanweaveHome(), "projects", input.projectId);
  const projectFile = join(projectRoot, "project.json");
  const reservationFile = join(projectRoot, authoritativeImportReservationFile);
  let existingReservation: string | null = null;
  try {
    existingReservation = (await readFile(reservationFile, "utf8")).trim();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existingReservation !== null) {
    if (existingReservation !== input.reservationToken) {
      throw fail("content_local_project_reservation_conflict");
    }
    return projectRoot;
  }
  try {
    await readFile(projectFile, "utf8");
    throw fail("content_local_project_reservation_conflict");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await mkdir(projectRoot, { recursive: true });
  try {
    await writeFile(reservationFile, `${input.reservationToken}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
    if ((await readFile(reservationFile, "utf8")).trim() !== input.reservationToken) {
      throw fail("content_local_project_reservation_conflict");
    }
  }
  return projectRoot;
}

/**
 * Main-process-only content replacement boundary. The logical layout member is
 * resolved through the runtime layout store; callers never provide disk paths.
 */
export async function materializeAuthoritativeCanvasContent(input: {
  projectRoot: string;
  canvasId: string;
  expectedPackageDir?: string;
  authorityProjectId?: string;
  content: CompleteContentVersion;
}): Promise<void> {
  const validated = validateAuthoritativeCanvasContent(input.content);
  const content = validated.content;
  const workspace = await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId);
  if (input.expectedPackageDir && workspace.packageDir !== input.expectedPackageDir) {
    throw fail("runtime_package_location_mismatch");
  }
  const packageMembers = content.members.filter((member) => member.kind !== "desktop_layout");
  const staging = await mkdtemp(join(dirname(workspace.packageDir), ".planweave-content-version-"));
  const transaction = await ImportTransaction.create({ workspaceRoot: workspace.workspaceRoot });
  try {
    for (const member of packageMembers) {
      const target = await resolvePackagePath(staging, member.path, { forWrite: true });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, member.content, "utf8");
    }
    const stagedWorkspace = {
      ...workspace,
      packageDir: staging,
      manifestFile: join(staging, "manifest.json")
    };
    const { manifest } = await loadPackage(stagedWorkspace);
    const parsedLayout = parseDesktopLayoutForPackage(validated.layout, stagedWorkspace, manifest, {
      authorityProjectId: input.authorityProjectId
    });
    const stagedLayout = resolveStagedContentVersionLayoutPath(staging);
    await writeFile(stagedLayout, `${JSON.stringify(parsedLayout, null, 2)}\n`, "utf8");
    await transaction.replacePath(workspace.packageDir, staging);
    await transaction.replacePath(layoutPathForWorkspace(workspace), stagedLayout);
    await transaction.commit();
  } catch (error) {
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "content_version_materialization_failed");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    throw error;
  }
}

async function availableProjectName(baseName: string): Promise<string> {
  const normalized = baseName.trim() || "Shared Plan";
  const names = new Set((await listProjects()).map((project) => project.name));
  if (!names.has(normalized)) return normalized;
  let suffix = 2;
  while (names.has(`${normalized} ${suffix}`)) suffix += 1;
  return `${normalized} ${suffix}`;
}

/**
 * Installs a fetched Server authority as a new managed local project. The
 * authoritative layout identity is validated before being adapted to the new
 * local project identity. Any failure removes only the project created here.
 */
export async function createManagedProjectFromAuthoritativeContent(input: {
  authorityProjectId: string;
  content: CompleteContentVersion;
  projectName?: string;
  expectedProjectId?: string;
  resumeReservedProject?: boolean;
  reservationToken?: string;
  importMode?: "replica" | "fork";
  sourceLineage?: WorkspaceForkLineage["source"];
}): Promise<{
  project: DesktopProjectSummary;
  canvasId: "default";
  lineage: WorkspaceForkLineage | null;
}> {
  const importMode = managedContentImportModeSchema.parse(input.importMode ?? "replica");
  if (importMode === "fork") {
    if (!input.sourceLineage) {
      throw fail("content_fork_source_lineage_required");
    }
    if (input.reservationToken) {
      throw fail("content_fork_reservation_forbidden");
    }
  }
  const lineage =
    importMode === "fork"
      ? workspaceForkLineageSchema.parse({
          schemaVersion: "workspace-fork-lineage/v1",
          writeback: false,
          source: input.sourceLineage
        })
      : null;
  const validated = validateAuthoritativeCanvasContent(input.content);
  const projectName =
    input.projectName ?? (await availableProjectName(validated.manifest.project.title));
  const projectId = createManagedProjectId(projectName);
  if (input.expectedProjectId && input.expectedProjectId !== projectId) {
    throw fail("content_local_project_reservation_mismatch");
  }
  if (input.resumeReservedProject && !input.reservationToken) {
    throw fail("content_local_project_reservation_required");
  }
  let reservedProjectRoot: string | null = null;
  let initialized: Awaited<ReturnType<typeof initManagedWorkspace>> | null = null;
  try {
    if (input.reservationToken) {
      reservedProjectRoot = await claimReservedManagedProject({
        projectId,
        reservationToken: input.reservationToken
      });
    }
    initialized = await initManagedWorkspace({
      name: projectName,
      projectGraph: true,
      ...(input.reservationToken ? { contentReplicaReservationToken: input.reservationToken } : {})
    });
    if (!initialized.created && !input.resumeReservedProject) {
      throw fail("content_local_project_name_conflict");
    }
    const workspace = await resolveTaskCanvasWorkspace(initialized.project.rootPath, "default");
    await materializeAuthoritativeCanvasContent({
      projectRoot: initialized.project.rootPath,
      canvasId: "default",
      expectedPackageDir: workspace.packageDir,
      authorityProjectId: input.authorityProjectId,
      content: validated.content
    });
    if (lineage) {
      await writeFile(
        workspaceForkLineagePath(initialized.project.rootPath, join),
        `${JSON.stringify(lineage, null, 2)}\n`,
        "utf8"
      );
    }
    return {
      project: await getProjectOverview(initialized.project.rootPath),
      canvasId: "default",
      lineage
    };
  } catch (error) {
    try {
      if (reservedProjectRoot) {
        await rm(reservedProjectRoot, { recursive: true, force: true });
      } else if (initialized?.created) {
        await removeProject(initialized.project.id);
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "content_local_project_rollback_failed");
    }
    throw error;
  }
}

export async function planManagedProjectFromAuthoritativeContent(input: {
  content: CompleteContentVersion;
}): Promise<{ projectName: string; projectId: string; canvasId: "default" }> {
  const validated = validateAuthoritativeCanvasContent(input.content);
  const projectName = await availableProjectName(validated.manifest.project.title);
  return {
    projectName,
    projectId: createManagedProjectId(projectName),
    canvasId: "default"
  };
}
