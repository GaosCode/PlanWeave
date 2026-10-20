import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { optionalStat } from "../fs/optionalFile.js";
import {
  assertProjectRootIdentity,
  captureProjectRootIdentity
} from "../fs/projectRootIdentity.js";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { assertManagedWorkspaceReservation, initManagedWorkspace } from "../initWorkspace.js";
import { writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import {
  assertCurrentProjectWorkspace,
  projectWorkspacePaths,
  resolveProjectWorkspaceInHome
} from "../project.js";
import { createManagedProjectId } from "../projectId.js";
import { validatePackage } from "../validatePackage.js";
import type { ProjectWorkspace, ValidationReport } from "../types.js";
import { ImportTransaction } from "./importTransaction.js";
import { withPackageFileConsistency } from "./packageFileConsistency.js";
import { validatePackageDraft } from "./packageDraftImport.js";
import { withPackageDraftImportStaging } from "./packageDraftImportStaging.js";
import {
  assertPackageStorageIdentity,
  capturePackageStorageIdentity
} from "./packageStorageIdentity.js";

function validationMessage(prefix: string, report: ValidationReport): string {
  const issues = [...report.errors, ...report.warnings]
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join("; ");
  return issues ? `${prefix}: ${issues}` : prefix;
}

/** Create-only admission and package publication share the stable project lock. */
export async function importManagedPackage(options: {
  name: string;
  draftRoot: string;
  overwrite: boolean;
}): Promise<{ workspace: ProjectWorkspace; validation: ValidationReport }> {
  const name = options.name.trim();
  if (!name) throw new Error("Managed project name must not be empty.");
  const home = resolvePlanweaveHome();
  await mkdir(home, { recursive: true });
  const planweaveHome = await realpath(home);
  const id = createManagedProjectId(name);
  const root = join(planweaveHome, "projects", id);
  const identity = await captureProjectRootIdentity(root);
  const captured = (await optionalStat(join(root, "project.json")))
    ? await resolveProjectWorkspaceInHome(root, planweaveHome)
    : null;
  const canvas = captured ? await resolveTaskCanvasWorkspace(captured, "default") : null;

  return withPackageDraftImportStaging(planweaveHome, [], async (stagingRoot) => {
    const draftRoot = join(stagingRoot, "incoming");
    await cp(options.draftRoot, draftRoot, {
      recursive: true,
      filter: async (source) => {
        const info = await lstat(source);
        if (!info.isDirectory() && !info.isFile()) {
          throw new Error(`Managed package import cannot copy non-regular draft path '${source}'.`);
        }
        return true;
      }
    });
    const draft = await validatePackageDraft({ draftRoot });
    if (draft.mode === "project") {
      throw new Error(
        "Imported PlanWeave package is invalid: this import accepts a single-canvas package with a root manifest.json, not a project-graph.json project draft."
      );
    }
    if (!draft.validation.ok || draft.mode !== "single-canvas") {
      throw new Error(validationMessage("Imported PlanWeave package is invalid", draft.validation));
    }

    return withProjectMutationLock(
      root,
      async () => {
        await assertManagedWorkspaceReservation(root);
        if ((await optionalStat(join(root, "project.json"))) && !options.overwrite) {
          throw new Error(
            "Imported project already exists. Pass overwrite: true to replace its package files."
          );
        }
        await assertProjectRootIdentity(root, identity);
        if (identity && !captured) {
          throw new Error(
            `Managed project directory '${root}' exists without an initialized project.`
          );
        }
        if (captured) await assertCurrentProjectWorkspace(captured);

        let workspace: ProjectWorkspace;
        let staged: string;
        if (canvas) {
          workspace = canvas;
          staged = draftRoot;
        } else {
          // This independent staging registry uses the same initializer as ordinary init.
          const initialized = await initManagedWorkspace({ name, planweaveHome: stagingRoot });
          workspace = projectWorkspacePaths({
            id,
            projectCreatedAt: initialized.project.createdAt,
            kind: "managed",
            rootPath: root,
            sourceRoot: null,
            planweaveHome,
            workspaceRoot: root
          });
          await cp(draftRoot, initialized.workspace.packageDir, { recursive: true });
          await writeJsonFile(initialized.workspace.projectFile, {
            ...initialized.project,
            rootPath: root
          });
          staged = initialized.workspace.workspaceRoot;
          // Keep the user-level prompt initialization owned by ordinary workspace init.
          const globalPrompt = join(planweaveHome, "config", "global-prompt.md");
          await mkdir(join(planweaveHome, "config"), { recursive: true });
          await cp(join(stagingRoot, "config", "global-prompt.md"), globalPrompt, { force: false });
        }
        const target = canvas ? workspace.packageDir : root;
        const transactionRoot = canvas ? root : planweaveHome;
        return withPackageFileConsistency([target], async () => {
          await assertProjectRootIdentity(root, identity);
          await assertManagedWorkspaceReservation(root);
          if (canvas) {
            await assertCurrentProjectWorkspace(canvas);
            await assertPackageStorageIdentity(canvas);
          }
          const transactionId = randomUUID();
          const recoveryRoot = join(
            transactionRoot,
            "desktop",
            "recovery",
            "package-import",
            transactionId
          );
          const transaction = await ImportTransaction.create({
            workspaceRoot: transactionRoot,
            transactionId,
            writeIsolationTargets: [target]
          });
          let validation: ValidationReport;
          try {
            await transaction.replacePath(target, staged);
            const installedIdentity = await captureProjectRootIdentity(root);
            await assertManagedWorkspaceReservation(root);
            validation = await validatePackage({ projectRoot: workspace.rootPath });
            if (!validation.ok) {
              throw new Error(
                validationMessage(
                  "Imported PlanWeave package became invalid after install",
                  validation
                )
              );
            }
            await assertProjectRootIdentity(root, installedIdentity);
            await assertCurrentProjectWorkspace(workspace);
            await assertManagedWorkspaceReservation(root);
            if (canvas) await assertPackageStorageIdentity(canvas);
            workspace = await capturePackageStorageIdentity(workspace);
          } catch (error) {
            try {
              await transaction.rollback();
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                `Managed package import failed; inspect recovery under '${transactionRoot}/desktop/recovery/package-import'.`
              );
            }
            throw error;
          }
          let committed = false;
          try {
            await transaction.markCommitted();
            committed = true;
            await transaction.cleanupCommitted();
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
              `Managed package import commit failed: ${detail}. ${committed ? "Installation committed; journal cleanup incomplete" : "Commit checkpoint incomplete; installation pending recovery"}; journal owner '${transactionRoot}', recovery '${recoveryRoot}'. Inspect project import recovery before retry.`,
              { cause: error }
            );
          }
          return { workspace, validation };
        });
      },
      { operation: "import-managed-package" }
    );
  });
}
