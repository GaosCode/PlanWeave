import {
  packageStorageIdentitySchema,
  resultsStorageIdentitySchema
} from "../../package/packageStorageIdentitySchema.js";
import { assertCurrentCanvasWorkspace } from "../../package/assertCurrentCanvasWorkspace.js";
import { isProjectGraphCommand } from "../projectGraphCommand.js";
import type { PlanGraphCommand } from "../commands.js";
import {
  capturePackageStorageIdentity,
  packageStorageCreatedAt
} from "../../package/packageStorageIdentity.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { canonicalFileTarget } from "../../fs/canonicalFileTarget.js";
import { listRegisteredCanvasWorkspacesForProject } from "../../desktop/projectCanvasStore.js";
import { assertCurrentProjectWorkspace, resolveProjectWorkspaceInHome } from "../../project.js";
import { projectKinds } from "../../projectMetadata.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../../types.js";
import { PlanGraphOperationLogParseError, planGraphCommandIssueSummary } from "../commandSchema.js";
import { numberColumn, stringColumn } from "./columns.js";

const pathSchema = z.string().min(1).refine(isAbsolute, "must be an absolute path");
const persistedWorkspaceSchema = z
  .object({
    id: z.string().min(1),
    projectCreatedAt: z.string().datetime().nullable().optional(),
    packageStorageIdentity: packageStorageIdentitySchema.nullable().optional(),
    resultsStorageIdentity: resultsStorageIdentitySchema.nullable().optional(),
    kind: z.enum(projectKinds),
    rootPath: pathSchema,
    sourceRoot: pathSchema.nullable(),
    planweaveHome: pathSchema,
    workspaceRoot: pathSchema,
    projectFile: pathSchema,
    packageDir: pathSchema,
    manifestFile: pathSchema,
    stateFile: pathSchema,
    resultsDir: pathSchema,
    projectPromptFile: pathSchema
  })
  .strict();

const storageKeys = [
  "rootPath",
  "planweaveHome",
  "workspaceRoot",
  "projectFile",
  "packageDir",
  "manifestFile",
  "stateFile",
  "resultsDir",
  "projectPromptFile"
] as const;

async function legacyRootWorkspace(
  row: Record<string, unknown>,
  owner: ProjectWorkspace,
  rootPath: string,
  command: PlanGraphCommand
): Promise<ProjectWorkspace> {
  await assertCurrentProjectWorkspace(owner);
  const createdAt = z.string().datetime().parse(stringColumn(row, "created_at"));
  if (
    owner.projectCreatedAt === null ||
    Date.parse(createdAt) < Date.parse(owner.projectCreatedAt) ||
    (await canonicalFileTarget(rootPath)) !== (await canonicalFileTarget(owner.rootPath))
  ) {
    throw new Error("History does not belong to the current project instance.");
  }
  if (!isProjectGraphCommand(command)) {
    const parent = await resolveProjectWorkspaceInHome(owner.rootPath, owner.planweaveHome);
    if (
      (await canonicalFileTarget(parent.packageDir)) !==
      (await canonicalFileTarget(owner.packageDir))
    ) {
      throw new Error("Legacy root history has no identity for this non-default canvas.");
    }
    await assertCurrentCanvasWorkspace(owner);
    if (
      owner.packageStorageIdentity === null ||
      Date.parse(createdAt) < packageStorageCreatedAt(owner.packageStorageIdentity)
    ) {
      throw new Error("History predates the current canvas storage instance.");
    }
  }
  return owner;
}

/** Only persisted pre-identity rows can bind to their validated current storage owner. */
export async function operationLogWorkspaceRef(
  row: Record<string, unknown>,
  owner: ProjectWorkspace,
  command: PlanGraphCommand
): Promise<PackageWorkspaceRef> {
  try {
    const raw = row.workspace_ref_json;
    // Databases predating workspace_ref_json stored the project root in project_root.
    if (raw === null || raw === undefined || raw === "")
      return await legacyRootWorkspace(row, owner, owner.rootPath, command);
    if (typeof raw !== "string") throw new Error("Workspace reference must be JSON text.");
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string")
      return await legacyRootWorkspace(row, owner, pathSchema.parse(value), command);
    const parsed = persistedWorkspaceSchema.parse(value);
    if (parsed.projectCreatedAt !== undefined && parsed.packageStorageIdentity !== undefined)
      return {
        ...parsed,
        projectCreatedAt: parsed.projectCreatedAt,
        resultsStorageIdentity: parsed.resultsStorageIdentity ?? null,
        packageStorageIdentity: parsed.packageStorageIdentity
      };

    await assertCurrentProjectWorkspace(owner);
    const createdAt = z.string().datetime().parse(stringColumn(row, "created_at"));
    if (
      owner.projectCreatedAt === null ||
      (parsed.projectCreatedAt !== undefined &&
        parsed.projectCreatedAt !== owner.projectCreatedAt) ||
      Date.parse(createdAt) < Date.parse(owner.projectCreatedAt)
    ) {
      throw new Error("History predates the current project instance.");
    }
    const parent = await resolveProjectWorkspaceInHome(owner.rootPath, owner.planweaveHome);
    const captured = await Promise.all(storageKeys.map((key) => canonicalFileTarget(parsed[key])));
    for (const current of await listRegisteredCanvasWorkspacesForProject(parent)) {
      if (parsed.id !== current.id || parsed.kind !== current.kind) continue;
      const paths = await Promise.all(storageKeys.map((key) => canonicalFileTarget(current[key])));
      if (!paths.every((path, index) => path === captured[index])) continue;
      const capturedCurrent = await capturePackageStorageIdentity(current);
      if (
        capturedCurrent.packageStorageIdentity === null ||
        (parsed.packageStorageIdentity !== undefined &&
          parsed.packageStorageIdentity !== capturedCurrent.packageStorageIdentity) ||
        Date.parse(createdAt) < packageStorageCreatedAt(capturedCurrent.packageStorageIdentity)
      ) {
        throw new Error("History predates the current canvas storage instance.");
      }
      return capturedCurrent;
    }
    throw new Error("History workspace does not match registered project and canvas storage.");
  } catch (error) {
    throw new PlanGraphOperationLogParseError({
      operationId: numberColumn(row, "id"),
      fieldName: "workspace_ref_json",
      issueSummary: planGraphCommandIssueSummary(error)
    });
  }
}
