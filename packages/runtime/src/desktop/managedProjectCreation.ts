import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { isNodeFileNotFoundError, optionalStat } from "../fs/optionalFile.js";
import {
  assertProjectRootIdentity,
  captureProjectRootIdentity,
  type ProjectRootIdentity
} from "../fs/projectRootIdentity.js";
import { authoritativeImportReservationFile, initManagedWorkspace } from "../initWorkspace.js";
import { assertCurrentProjectWorkspace } from "../project.js";
import { createManagedProjectId } from "../projectId.js";
import type { InitWorkspaceResult, ProjectWorkspace } from "../types.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import { listImportTransactionRecoveryTargets } from "../package/importRecovery.js";
import { withImportTransactionMutationAdmission } from "../package/importTransactionLock.js";
import { invalidateDesktopProjectProjection } from "./graph/projectProjectionModel.js";

async function claimReservation(root: string, token: string, allowCreate: boolean): Promise<void> {
  const path = join(root, authoritativeImportReservationFile);
  try {
    if ((await readFile(path, "utf8")).trim() !== token) {
      throw new Error("content_local_project_reservation_conflict");
    }
    return;
  } catch (error) {
    if (!isNodeFileNotFoundError(error)) throw error;
  }
  if (!allowCreate || (await optionalStat(join(root, "project.json")))) {
    throw new Error("content_local_project_reservation_conflict");
  }
  try {
    await writeFile(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
    if ((await readFile(path, "utf8")).trim() !== token) {
      throw new Error("content_local_project_reservation_conflict");
    }
  }
}

/** Creation, reservation, publication and compensation share one captured Home and parent lock. */
export async function withManagedProjectCreation<T>(
  input: {
    name: string;
    planweaveHome: string;
    reservationToken?: string;
    resumeReservedProject?: boolean;
    sourceWorkspaces?: readonly ProjectWorkspace[];
  },
  apply: (initialized: InitWorkspaceResult) => Promise<T>
): Promise<T> {
  const root = join(input.planweaveHome, "projects", createManagedProjectId(input.name));
  return withProjectMutationLock(root, async () => {
    let owned = false;
    let reservationClaimed = false;
    let identity: ProjectRootIdentity = null;
    let initialized: InitWorkspaceResult | null = null;
    let compensationAttempted = false;
    let publicationTargets: string[] | null = null;
    const canvasRoot = () =>
      initialized ? dirname(initialized.workspace.packageDir) : join(root, "canvases", "default");
    const publicationRoots = () => {
      const targetCanvasRoot = canvasRoot();
      return [
        initialized?.workspace.packageDir ?? join(targetCanvasRoot, "package"),
        initialized?.workspace.stateFile ?? join(targetCanvasRoot, "state.json"),
        initialized?.workspace.resultsDir ?? join(targetCanvasRoot, "results"),
        join(root, "desktop", "layout.json"),
        join(targetCanvasRoot, "desktop", "layout.json"),
        ...(input.sourceWorkspaces ?? []).flatMap((source) => [
          source.packageDir,
          join(source.workspaceRoot, "desktop", "layout.json")
        ])
      ];
    };
    const recoveryTargets = async () => [
      ...(await listImportTransactionRecoveryTargets(root)),
      ...(await listImportTransactionRecoveryTargets(canvasRoot()))
    ];
    const withPublicationBoundary = <R>(operation: () => Promise<R>) => {
      const targets = publicationTargets ?? publicationRoots();
      return withPackageFileConsistency(targets, () =>
        withImportTransactionMutationAdmission([root, canvasRoot()], targets, operation)
      );
    };
    const compensate = async (error: unknown): Promise<never> => {
      compensationAttempted = true;
      if (owned) {
        try {
          await withPublicationBoundary(async () => {
            await assertProjectRootIdentity(root, identity);
            if (reservationClaimed) {
              if (
                (await readFile(join(root, authoritativeImportReservationFile), "utf8")).trim() !==
                input.reservationToken
              ) {
                throw new Error("content_local_project_reservation_conflict");
              }
            }
            if (initialized) await assertCurrentProjectWorkspace(initialized.workspace);
            invalidateDesktopProjectProjection(initialized?.workspace.rootPath ?? root);
            await rm(root, { recursive: true, force: true });
          });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "content_local_project_rollback_failed");
        }
      }
      throw error;
    };
    try {
      if (await optionalStat(root)) {
        if (!input.reservationToken) throw new Error("content_local_project_name_conflict");
      } else {
        await mkdir(dirname(root), { recursive: true });
        await mkdir(root);
        owned = true;
      }
      identity = await captureProjectRootIdentity(root);
      if (input.reservationToken) {
        await claimReservation(root, input.reservationToken, owned);
        reservationClaimed = true;
        owned = true;
      }
      initialized = await initManagedWorkspace({
        name: input.name,
        planweaveHome: input.planweaveHome,
        projectGraph: true,
        ...(input.reservationToken
          ? { contentReplicaReservationToken: input.reservationToken }
          : {})
      });
      if (!initialized.created && !input.resumeReservedProject) {
        throw new Error("content_local_project_name_conflict");
      }
      owned ||= initialized.created;
      const creation = initialized;
      const targets = [...publicationRoots(), ...(await recoveryTargets())];
      publicationTargets = targets;
      return await withPublicationBoundary(async () => {
        try {
          await assertProjectRootIdentity(root, identity);
          if ((await recoveryTargets()).some((target) => !targets.includes(target))) {
            throw new Error("content_local_project_recovery_targets_changed");
          }
          return await apply(creation);
        } catch (error) {
          return compensate(error);
        }
      });
    } catch (error) {
      if (compensationAttempted) throw error;
      return compensate(error);
    }
  });
}
