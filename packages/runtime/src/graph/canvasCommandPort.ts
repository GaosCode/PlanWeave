import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  canvasCommandIntentSchema,
  type CanvasCommandIntent
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  packageSnapshotDigestManifestSchema,
  type PackageSnapshotDigestManifest
} from "@planweave-ai/collaboration-protocol/content/snapshot";
import {
  buildCanvasCommandApplication,
  CanvasCommandMutationError,
  type CanvasCommandApplication
} from "./canvasCommandMutation.js";
import {
  checkPlanPackageGraphMutationVersion,
  commitPlanPackageGraphMutation
} from "./editGraph.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { captureAuthorizedCanvasContent } from "../desktop/authorizedCanvasContent.js";
import {
  getDesktopLayoutDirect,
  layoutPathForWorkspace,
  saveDesktopLayoutDirect
} from "../desktop/layoutStore.js";
import type { GraphEditResult, PackageWorkspaceRef, ProjectWorkspace } from "../types.js";

/**
 * Narrow Server-facing port for authorized shared Canvas mutations.
 * Server injects ACL/scope/CAS before calling; Runtime owns package parsing and graph semantics.
 * Does not accept actor, absolute paths from clients, or free-form filesystem ops.
 */
export type ApplyAuthorizedCanvasCommandInput = {
  projectRoot: PackageWorkspaceRef;
  canvasId: string;
  expectedPackageDir?: string;
  authorityProjectId?: string;
  intent: CanvasCommandIntent;
};

export type ApplyAuthorizedCanvasCommandSuccess = {
  ok: true;
  contentDigest: string;
  digestManifest: PackageSnapshotDigestManifest;
  packageDir: string;
  sizeBytes: number;
};

export type ApplyAuthorizedCanvasCommandFailure = {
  ok: false;
  code: "invalid_command" | "package_mismatch" | "mutation_failed";
  detail: string;
};

export type ApplyAuthorizedCanvasCommandResult =
  | ApplyAuthorizedCanvasCommandSuccess
  | ApplyAuthorizedCanvasCommandFailure;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function contentDigestFromManifest(manifest: PackageSnapshotDigestManifest): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex");
}

function fail(
  code: ApplyAuthorizedCanvasCommandFailure["code"],
  detail: string
): ApplyAuthorizedCanvasCommandFailure {
  return { ok: false, code, detail };
}

type CanvasCommandCommitDependencies = {
  saveLayout: typeof saveDesktopLayoutDirect;
  markTransactionCommitted(transaction: ImportTransaction): Promise<void>;
  cleanupCommittedTransaction(transaction: ImportTransaction): Promise<void>;
  reportCleanupFailure(error: unknown): void;
};

const canvasCommandCommitDependencies: CanvasCommandCommitDependencies = {
  saveLayout: saveDesktopLayoutDirect,
  markTransactionCommitted: (transaction) => transaction.markCommitted(),
  cleanupCommittedTransaction: (transaction) => transaction.cleanupCommitted(),
  reportCleanupFailure: (error) => {
    console.error("Canvas command committed, but transaction cleanup failed.", error);
  }
};

/** Stage the whole Plan Package and atomically replace it only after every write succeeds. */
export async function commitCanvasCommandApplication(options: {
  workspace: ProjectWorkspace;
  application: CanvasCommandApplication;
  dependencies?: Partial<CanvasCommandCommitDependencies>;
}): Promise<GraphEditResult> {
  const dependencies = {
    ...canvasCommandCommitDependencies,
    ...options.dependencies
  };
  const staging = await mkdtemp(
    join(dirname(options.workspace.packageDir), ".planweave-canvas-command-")
  );
  const layoutStagingRoot = await mkdtemp(
    join(dirname(options.workspace.packageDir), ".planweave-canvas-layout-")
  );
  const stagedWorkspace: ProjectWorkspace = {
    ...options.workspace,
    workspaceRoot: layoutStagingRoot,
    packageDir: staging,
    manifestFile: join(staging, "manifest.json")
  };
  const canonicalLayout = layoutPathForWorkspace(options.workspace);
  const stagedLayout = layoutPathForWorkspace(stagedWorkspace);
  const cleanupStaging = async () => {
    await rm(staging, { recursive: true, force: true });
    await rm(layoutStagingRoot, { recursive: true, force: true });
  };
  const transaction = await ImportTransaction.create({
    workspaceRoot: options.workspace.workspaceRoot,
    writeIsolationTargets: [options.workspace.packageDir, canonicalLayout]
  });
  return withPackageFileConsistency(
    [options.workspace.packageDir, canonicalLayout, staging, stagedLayout],
    async () => {
      try {
        const current = await loadPackage(options.workspace);
        let conflict = checkPlanPackageGraphMutationVersion(
          current.manifest,
          options.application.graphMutation
        );
        if (
          !conflict &&
          options.application.layoutChanged &&
          stableStringify(await getDesktopLayoutDirect(options.workspace)) !==
            stableStringify(options.application.baseLayout)
        ) {
          conflict = {
            ok: false,
            affectedTasks: [],
            diagnostics: [
              {
                code: "layout_version_conflict",
                message:
                  "Desktop layout changed after this mutation was prepared; reload and retry the edit."
              }
            ]
          };
        }
        if (conflict) {
          await transaction.rollback();
          await cleanupStaging();
          return conflict;
        }
        await rm(staging, { recursive: true, force: true });
        await cp(options.workspace.packageDir, staging, { recursive: true });
        const result = await commitPlanPackageGraphMutation({
          projectRoot: stagedWorkspace,
          mutation: options.application.graphMutation
        });
        if (!result.ok) {
          await transaction.rollback();
          await cleanupStaging();
          return result;
        }
        if (options.application.layoutChanged) {
          await dependencies.saveLayout(stagedWorkspace, options.application.nextLayout, {
            updatedAt: options.application.nextLayout.updatedAt
          });
        }
        await transaction.replacePath(options.workspace.packageDir, staging);
        if (options.application.layoutChanged) {
          await transaction.replacePath(canonicalLayout, stagedLayout);
        }
        await dependencies.markTransactionCommitted(transaction);
        try {
          await dependencies.cleanupCommittedTransaction(transaction);
          await cleanupStaging();
        } catch (cleanupError) {
          dependencies.reportCleanupFailure(cleanupError);
        }
        return result;
      } catch (error) {
        let rollbackError: unknown;
        try {
          await transaction.rollback();
        } catch (failure) {
          rollbackError = failure;
        }
        let cleanupError: unknown;
        try {
          await cleanupStaging();
        } catch (failure) {
          cleanupError = failure;
        }
        if (rollbackError || cleanupError) {
          throw new AggregateError(
            [
              error,
              ...(rollbackError ? [rollbackError] : []),
              ...(cleanupError ? [cleanupError] : [])
            ],
            "canvas_command_commit_rollback_failed"
          );
        }
        throw error;
      }
    }
  );
}

/** Apply one authorized intent against a Server-resolved package location. */
export async function applyAuthorizedCanvasCommand(
  input: ApplyAuthorizedCanvasCommandInput
): Promise<ApplyAuthorizedCanvasCommandResult> {
  const intentResult = canvasCommandIntentSchema.safeParse(input.intent);
  if (!intentResult.success) return fail("invalid_command", "intent_schema_invalid");
  const intent = intentResult.data;

  let workspace: Awaited<ReturnType<typeof resolvePackageWorkspace>>;
  try {
    workspace =
      typeof input.projectRoot === "string"
        ? await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId)
        : await resolvePackageWorkspace(input.projectRoot);
  } catch (error) {
    return fail(
      "mutation_failed",
      error instanceof Error ? error.message : "package_workspace_unresolved"
    );
  }
  if (input.expectedPackageDir !== undefined && workspace.packageDir !== input.expectedPackageDir) {
    return fail("package_mismatch", "runtime_package_location_mismatch");
  }

  let loaded: Awaited<ReturnType<typeof loadPackage>>;
  try {
    loaded = await loadPackage(workspace);
  } catch (error) {
    return fail("mutation_failed", error instanceof Error ? error.message : "package_load_failed");
  }

  try {
    const layout = await getDesktopLayoutDirect(workspace);
    const application = buildCanvasCommandApplication(loaded.manifest, layout, intent);
    const commit = await commitCanvasCommandApplication({ workspace, application });
    if (!commit.ok) {
      return fail(
        "mutation_failed",
        commit.diagnostics.map((item) => item.message).join("; ") || "graph_commit_failed"
      );
    }
  } catch (error) {
    if (error instanceof CanvasCommandMutationError) {
      return fail("invalid_command", error.message);
    }
    return fail(
      "mutation_failed",
      error instanceof Error ? error.message : "canvas_command_application_failed"
    );
  }

  try {
    const captured = await captureAuthorizedCanvasContent({
      projectRoot: workspace,
      authorityProjectId: input.authorityProjectId
    });
    if (captured.packageDir !== workspace.packageDir) {
      return fail("package_mismatch", "runtime_package_location_mismatch");
    }
    const digestManifest = packageSnapshotDigestManifestSchema.parse(captured.digestManifest);
    return {
      ok: true,
      contentDigest: captured.content.canonicalDigest,
      digestManifest,
      packageDir: workspace.packageDir,
      sizeBytes: captured.content.totalBytes
    };
  } catch (error) {
    return fail(
      "mutation_failed",
      error instanceof Error ? error.message : "content_digest_failed"
    );
  }
}

/** Read-only content digest for reconnect / CAS without applying a mutation. */
export async function readAuthorizedCanvasContentDigest(input: {
  projectRoot: PackageWorkspaceRef;
  canvasId: string;
  expectedPackageDir?: string;
  authorityProjectId?: string;
}): Promise<ApplyAuthorizedCanvasCommandResult> {
  try {
    const workspace =
      typeof input.projectRoot === "string"
        ? await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId)
        : await resolvePackageWorkspace(input.projectRoot);
    if (
      input.expectedPackageDir !== undefined &&
      workspace.packageDir !== input.expectedPackageDir
    ) {
      return fail("package_mismatch", "runtime_package_location_mismatch");
    }
    const captured = await captureAuthorizedCanvasContent({
      projectRoot: workspace,
      authorityProjectId: input.authorityProjectId
    });
    if (captured.packageDir !== workspace.packageDir) {
      return fail("package_mismatch", "runtime_package_location_mismatch");
    }
    const digestManifest = packageSnapshotDigestManifestSchema.parse(captured.digestManifest);
    return {
      ok: true,
      contentDigest: captured.content.canonicalDigest,
      digestManifest,
      packageDir: workspace.packageDir,
      sizeBytes: captured.content.totalBytes
    };
  } catch (error) {
    return fail(
      "mutation_failed",
      error instanceof Error ? error.message : "content_digest_failed"
    );
  }
}
