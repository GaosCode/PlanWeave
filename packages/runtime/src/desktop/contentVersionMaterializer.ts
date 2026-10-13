import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { type CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { getProjectOverview, listProjects } from "./projectApi.js";
import { layoutPathForWorkspace, parseDesktopLayoutForPackage } from "./layoutStore.js";
import { validateAuthoritativeCanvasContent } from "./contentVersionValidation.js";
import { ImportTransaction } from "../package/importTransaction.js";
import {
  listPendingImportTransactions,
  listImportTransactionRecoveryTargets
} from "../package/importRecovery.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { withManagedProjectCreation } from "./managedProjectCreation.js";
import { resolvePlanweaveHome } from "../paths.js";
import { createManagedProjectId } from "../projectId.js";
import type { ProjectWorkspace } from "../types.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { withCurrentProjectWorkspace, assertCurrentProjectWorkspace } from "../project.js";
import { assertCurrentCanvasWorkspaceIdentity } from "../package/assertCurrentCanvasWorkspace.js";
import { assertResultsStorageIdentity } from "../package/packageStorageIdentity.js";
import { withImportTransactionMutationAdmission } from "../package/importTransactionLock.js";
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
  const content = validateAuthoritativeCanvasContent(input.content).content;
  const workspace = await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId);
  if (input.expectedPackageDir && workspace.packageDir !== input.expectedPackageDir) {
    throw fail("runtime_package_location_mismatch");
  }
  await materializeAuthoritativeCanvasWorkspace({
    workspace,
    authorityProjectId: input.authorityProjectId,
    content
  });
}

/**
 * Atomically replaces authoritative package and layout content in an explicitly
 * resolved canvas workspace while preserving its runtime state and results.
 */
export async function materializeAuthoritativeCanvasWorkspace(input: {
  workspace: ProjectWorkspace;
  authorityProjectId?: string;
  content: CompleteContentVersion;
}): Promise<void> {
  return withAuthoritativeCanvasWorkspaceLock(input.workspace, async () => {
    await recoverPendingAuthoritativeCanvasMaterialization(input.workspace);
    await materializeAuthoritativeCanvasWorkspaceUnlocked(input);
  });
}

export class AuthoritativeCanvasWorkspaceConflictError extends Error {
  constructor() {
    super("Authority recovery targets changed during lock acquisition.");
    this.name = "AuthoritativeCanvasWorkspaceConflictError";
  }
}

const authorityBoundary = new AsyncLocalStorage<{
  stateFile: string;
  targets: ReadonlySet<string>;
}>();

async function pendingRecoveryTargets(workspace: ProjectWorkspace): Promise<string[]> {
  return listImportTransactionRecoveryTargets(workspace.workspaceRoot);
}

async function assertRecoveryTargetsHeld(workspace: ProjectWorkspace): Promise<void> {
  const boundary = authorityBoundary.getStore();
  if (
    !boundary ||
    boundary.stateFile !== workspace.stateFile ||
    (await pendingRecoveryTargets(workspace)).some((target) => !boundary.targets.has(target))
  ) {
    throw new AuthoritativeCanvasWorkspaceConflictError();
  }
}

async function assertAuthorityOwner(workspace: ProjectWorkspace): Promise<void> {
  await assertCurrentProjectWorkspace(workspace);
  await assertCurrentCanvasWorkspaceIdentity(workspace);
  await assertResultsStorageIdentity(workspace);
}

/** Acquires replacement and recovery roots before the Runtime canvas mutation lock. */
export async function withAuthoritativeCanvasWorkspaceLock<T>(
  workspace: ProjectWorkspace,
  operation: () => Promise<T>
): Promise<T> {
  const held = authorityBoundary.getStore();
  if (held?.stateFile === workspace.stateFile) {
    await assertAuthorityOwner(workspace);
    await assertRecoveryTargetsHeld(workspace);
    return operation();
  }
  return withCurrentProjectWorkspace(workspace, async () => {
    await assertAuthorityOwner(workspace);
    const targets = new Set([
      nodePath.resolve(workspace.packageDir),
      nodePath.resolve(workspace.stateFile),
      nodePath.resolve(workspace.resultsDir),
      nodePath.resolve(layoutPathForWorkspace(workspace)),
      ...(await pendingRecoveryTargets(workspace))
    ]);
    return withPackageFileConsistency([...targets], () =>
      withImportTransactionMutationAdmission([workspace.workspaceRoot], [...targets], () =>
        withCanvasLock(
          nodePath.dirname(workspace.stateFile),
          () =>
            authorityBoundary.run({ stateFile: workspace.stateFile, targets }, async () => {
              await assertAuthorityOwner(workspace);
              await assertRecoveryTargetsHeld(workspace);
              return operation();
            }),
          { operation: "workspace-authority-materialization" }
        )
      )
    );
  });
}

/** Restores the last committed package/layout pair before any authority fast-path check. */
export async function recoverPendingAuthoritativeCanvasMaterialization(
  workspace: ProjectWorkspace
): Promise<void> {
  return withAuthoritativeCanvasWorkspaceLock(workspace, async () => {
    const pendingTransactions = await listPendingImportTransactions(workspace.workspaceRoot);
    for (const pending of pendingTransactions) {
      const transaction = await ImportTransaction.recover({
        workspaceRoot: workspace.workspaceRoot,
        transactionId: pending.transactionId
      });
      const targets = authorityBoundary.getStore()?.targets;
      if (!targets || transaction.getRecoveryTargets().some((target) => !targets.has(target))) {
        throw new AuthoritativeCanvasWorkspaceConflictError();
      }
      await transaction.rollback();
    }
  });
}

async function materializeAuthoritativeCanvasWorkspaceUnlocked(input: {
  workspace: ProjectWorkspace;
  authorityProjectId?: string;
  content: CompleteContentVersion;
}): Promise<void> {
  const validated = validateAuthoritativeCanvasContent(input.content);
  const content = validated.content;
  const { workspace } = input;
  const parsedLayout = parseDesktopLayoutForPackage(
    validated.layout,
    workspace,
    validated.manifest,
    {
      authorityProjectId: input.authorityProjectId
    }
  );
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
    await loadPackage(stagedWorkspace);
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

async function availableProjectName(baseName: string, planweaveHome: string): Promise<string> {
  const normalized = baseName.trim() || "Shared Plan";
  const names = new Set((await listProjects(planweaveHome)).map((project) => project.name));
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
  planweaveHome?: string;
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
  const planweaveHome = input.planweaveHome ?? resolvePlanweaveHome();
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
    input.projectName ??
    (await availableProjectName(validated.manifest.project.title, planweaveHome));
  const projectId = createManagedProjectId(projectName);
  if (input.expectedProjectId && input.expectedProjectId !== projectId) {
    throw fail("content_local_project_reservation_mismatch");
  }
  if (input.resumeReservedProject && !input.reservationToken) {
    throw fail("content_local_project_reservation_required");
  }
  return withManagedProjectCreation(
    {
      name: projectName,
      planweaveHome,
      reservationToken: input.reservationToken,
      resumeReservedProject: input.resumeReservedProject
    },
    async (initialized) => {
      const workspace = await resolveTaskCanvasWorkspace(initialized.workspace, "default");
      await materializeAuthoritativeCanvasWorkspace({
        workspace,
        authorityProjectId: input.authorityProjectId,
        content: validated.content
      });
      if (lineage) {
        await writeFile(
          workspaceForkLineagePath(initialized.workspace.workspaceRoot, join),
          `${JSON.stringify(lineage, null, 2)}\n`,
          "utf8"
        );
      }
      return {
        project: await getProjectOverview(initialized.workspace),
        canvasId: "default" as const,
        lineage
      };
    }
  );
}

export async function planManagedProjectFromAuthoritativeContent(input: {
  content: CompleteContentVersion;
}): Promise<{ projectName: string; projectId: string; canvasId: "default" }> {
  const planweaveHome = resolvePlanweaveHome();
  const validated = validateAuthoritativeCanvasContent(input.content);
  const projectName = await availableProjectName(validated.manifest.project.title, planweaveHome);
  return {
    projectName,
    projectId: createManagedProjectId(projectName),
    canvasId: "default"
  };
}
