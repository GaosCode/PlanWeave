import { createHash } from "node:crypto";
import { z } from "zod";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { loadPlanGraphPackage } from "../plangraph/packageRepository.js";
import { stableJson } from "../plangraph/hash.js";
import { commandCanvasIdForWorkspace } from "../taskManager/canvasCommandScope.js";
import {
  localWorkspaceAuthorityBindingSchema,
  localWorkspaceAuthorityLocatorSchema,
  ownerCanvasRemoteAuthorityBindingSchema,
  ownerCanvasRemoteAuthorityLocatorSchema,
  remoteWorkspaceAuthorityBindingSchema,
  remoteWorkspaceAuthorityLocatorSchema,
  workspaceAuthorityBindingSchema,
  workspaceAuthorityRevisionsSchema,
  workspaceExecutionScopeSchema,
  type LocalWorkspaceAuthorityLocator,
  type OwnerCanvasRemoteAuthorityBinding,
  type RemoteWorkspaceAuthorityBinding,
  type RemoteWorkspaceAuthorityLocator,
  type WorkspaceAuthorityBinding,
  type WorkspaceExecutionAuthorityLocator,
  type WorkspaceExecutionScope
} from "./contracts.js";
import { WorkspaceExecutionError } from "./errors.js";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";

const localAuthoritySnapshotSchema = z
  .object({
    packageWorkspace: z.string().trim().min(1).max(4_096),
    projectId: z.string().trim().min(1).max(256),
    canvasId: z.string().trim().min(1).max(256),
    contentRevision: z.string().trim().min(1).max(256),
    graphFingerprint: z.string().regex(/^pkg-[a-f0-9]{64}$/)
  })
  .strict();

const remoteAuthoritySnapshotSchema = z
  .object({
    connectionProfileId: z.string().trim().min(1).max(256),
    serverOrigin: z
      .string()
      .url()
      .refine((value) => new URL(value).origin === value),
    workspaceId: z.string().trim().min(1).max(256),
    projectId: z.string().trim().min(1).max(256),
    canvasId: z.string().trim().min(1).max(256),
    blockRef: z.string().trim().min(3).max(512),
    contentRevision: z.string().trim().min(1).max(256),
    graphFingerprint: z.string().regex(/^pkg-[a-f0-9]{64}$/),
    authorityRevisions: workspaceAuthorityRevisionsSchema
  })
  .strict();

export type LocalWorkspaceAuthoritySnapshot = z.infer<typeof localAuthoritySnapshotSchema>;
export type RemoteWorkspaceAuthoritySnapshot = z.infer<typeof remoteAuthoritySnapshotSchema>;

export interface LocalWorkspaceAuthoritySourcePort {
  inspect(
    locator: LocalWorkspaceAuthorityLocator,
    scope: WorkspaceExecutionScope,
    signal?: AbortSignal
  ): Promise<LocalWorkspaceAuthoritySnapshot>;
}

export interface RemoteWorkspaceAuthoritySourcePort {
  inspect(
    locator: RemoteWorkspaceAuthorityLocator,
    blockRef: string,
    signal?: AbortSignal
  ): Promise<RemoteWorkspaceAuthoritySnapshot>;
}

const validatedBindingBrand = Symbol("ValidatedWorkspaceAuthorityBinding");
export type ValidatedWorkspaceAuthorityBinding = WorkspaceAuthorityBinding & {
  readonly [validatedBindingBrand]: true;
};

export interface WorkspaceAuthorityBindingPort {
  resolve(
    locator: WorkspaceExecutionAuthorityLocator,
    scope: WorkspaceExecutionScope,
    signal?: AbortSignal
  ): Promise<ValidatedWorkspaceAuthorityBinding>;
}

function bindingId(value: unknown): string {
  return `wxb:sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function remoteBindingIdentityValue(
  value: Omit<RemoteWorkspaceAuthorityBinding, "bindingId">
): unknown {
  if (!("workspaceId" in value)) return value;
  if (value.contentAuthority.kind === "server_canvas") return value;
  return {
    version: value.version,
    kind: value.kind,
    packageWorkspace: value.contentAuthority.packageWorkspace,
    connectionProfileId: value.connectionProfileId,
    serverOrigin: value.serverOrigin,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    canvasId: value.canvasId,
    blockRef: value.blockRef,
    authorityRevisions: value.authorityRevisions,
    contentRevision: value.contentRevision,
    graphFingerprint: value.graphFingerprint
  };
}

function validateContent(
  expected: { contentRevision: string; graphFingerprint: string },
  actual: { contentRevision: string; graphFingerprint: string }
): void {
  if (actual.contentRevision !== expected.contentRevision) {
    throw new WorkspaceExecutionError("workspace_content_revision_mismatch");
  }
  if (actual.graphFingerprint !== expected.graphFingerprint) {
    throw new WorkspaceExecutionError("workspace_graph_fingerprint_mismatch");
  }
}

function brand(binding: WorkspaceAuthorityBinding): ValidatedWorkspaceAuthorityBinding {
  return Object.freeze(
    Object.defineProperty(binding, validatedBindingBrand, { value: true, enumerable: false })
  ) as ValidatedWorkspaceAuthorityBinding;
}

export function adoptStoredWorkspaceAuthorityBinding(
  value: unknown
): ValidatedWorkspaceAuthorityBinding {
  return brand(workspaceAuthorityBindingSchema.parse(value));
}

export function assertValidatedWorkspaceAuthorityBinding(
  value: WorkspaceAuthorityBinding
): asserts value is ValidatedWorkspaceAuthorityBinding {
  if (!(validatedBindingBrand in value)) {
    throw new WorkspaceExecutionError("workspace_execution_binding_unvalidated");
  }
}

export function assertRemoteWorkAuthorityMatchesBinding(
  binding: RemoteWorkspaceAuthorityBinding,
  authority: WorkAuthorityProjection | null,
  mismatchCode:
    | "workspace_execution_authority_mismatch"
    | "workspace_execution_resume_mismatch" = "workspace_execution_authority_mismatch"
): void {
  if (isOwnerCanvasRemoteAuthorityBinding(binding)) {
    if (authority !== null) {
      throw new WorkspaceExecutionError(mismatchCode);
    }
    return;
  }
  if (authority === null) {
    throw new WorkspaceExecutionError(mismatchCode);
  }
  if (
    authority.scope.kind !== "block" ||
    authority.scope.canvasId !== binding.canvasId ||
    authority.scope.blockRef !== binding.blockRef ||
    authority.revisions.responsibilityRevision !==
      binding.authorityRevisions.responsibilityRevision ||
    authority.revisions.reviewerRevision !== binding.authorityRevisions.reviewerRevision ||
    authority.revisions.executionTargetRevision !==
      binding.authorityRevisions.executionTargetRevision
  ) {
    throw new WorkspaceExecutionError(mismatchCode);
  }
}

export function isOwnerCanvasRemoteAuthorityBinding(
  binding: RemoteWorkspaceAuthorityBinding
): binding is OwnerCanvasRemoteAuthorityBinding {
  return "authorityKind" in binding && binding.authorityKind === "owner_canvas";
}

export function createWorkspaceAuthorityBindingResolver(input: {
  local: LocalWorkspaceAuthoritySourcePort;
  remote: RemoteWorkspaceAuthoritySourcePort;
}): WorkspaceAuthorityBindingPort {
  return {
    async resolve(locatorInput, scopeInput, signal) {
      const locator =
        locatorInput.kind === "local_package"
          ? localWorkspaceAuthorityLocatorSchema.parse(locatorInput)
          : locatorInput.kind === "owner_canvas"
            ? ownerCanvasRemoteAuthorityLocatorSchema.parse(locatorInput)
            : remoteWorkspaceAuthorityLocatorSchema.parse(locatorInput);
      const scope = workspaceExecutionScopeSchema.parse(scopeInput);
      if (locator.kind === "local_package") {
        const snapshot = localAuthoritySnapshotSchema.parse(
          await input.local.inspect(locator, scope, signal)
        );
        if (snapshot.packageWorkspace !== locator.packageWorkspace) {
          throw new WorkspaceExecutionError("workspace_execution_authority_mismatch");
        }
        validateContent(locator.expected, snapshot);
        const withoutId = {
          version: "planweave.workspace-authority-binding/v1" as const,
          kind: "local" as const,
          packageWorkspace: snapshot.packageWorkspace,
          canvasId: snapshot.canvasId,
          scope,
          contentRevision: snapshot.contentRevision,
          graphFingerprint: snapshot.graphFingerprint
        };
        return brand(
          localWorkspaceAuthorityBindingSchema.parse({
            ...withoutId,
            bindingId: bindingId(withoutId)
          })
        );
      }
      if (scope.kind !== "block") {
        throw new WorkspaceExecutionError("workspace_execution_authority_mismatch");
      }
      if (locator.kind === "owner_canvas") {
        const snapshot = localAuthoritySnapshotSchema.parse(
          await input.local.inspect(
            {
              kind: "local_package",
              packageWorkspace: locator.packageWorkspace,
              expected: locator.expected,
              canvasId: locator.canvasId
            },
            scope,
            signal
          )
        );
        if (
          snapshot.packageWorkspace !== locator.packageWorkspace ||
          snapshot.projectId !== locator.projectId ||
          snapshot.canvasId !== locator.canvasId
        ) {
          throw new WorkspaceExecutionError("workspace_execution_authority_mismatch");
        }
        validateContent(locator.expected, snapshot);
        const withoutId = {
          version: "planweave.workspace-authority-binding/v1" as const,
          kind: "remote" as const,
          authorityKind: "owner_canvas" as const,
          contentAuthority: {
            kind: "package_snapshot" as const,
            packageWorkspace: snapshot.packageWorkspace,
            expected: locator.expected
          },
          connectionProfileId: locator.connectionProfileId,
          serverOrigin: locator.serverOrigin,
          humanPrincipalId: locator.humanPrincipalId,
          projectId: snapshot.projectId,
          canvasId: snapshot.canvasId,
          blockRef: scope.blockRef,
          authorityRevisions: {
            responsibilityRevision: 0,
            reviewerRevision: 0,
            executionTargetRevision: 0
          },
          contentRevision: snapshot.contentRevision,
          graphFingerprint: snapshot.graphFingerprint
        };
        return brand(
          ownerCanvasRemoteAuthorityBindingSchema.parse({
            ...withoutId,
            bindingId: bindingId(remoteBindingIdentityValue(withoutId))
          })
        );
      }
      const snapshot = remoteAuthoritySnapshotSchema.parse(
        await input.remote.inspect(locator, scope.blockRef, signal)
      );
      const authorityMatches =
        snapshot.connectionProfileId === locator.connectionProfileId &&
        snapshot.serverOrigin === locator.serverOrigin &&
        snapshot.workspaceId === locator.workspaceId &&
        snapshot.projectId === locator.projectId &&
        snapshot.canvasId === locator.canvasId &&
        snapshot.blockRef === scope.blockRef;
      if (!authorityMatches) {
        throw new WorkspaceExecutionError("workspace_execution_authority_mismatch");
      }
      if (locator.contentAuthority.kind === "package_snapshot") {
        validateContent(locator.contentAuthority.expected, snapshot);
      }
      const withoutId = {
        version: "planweave.workspace-authority-binding/v1" as const,
        kind: "remote" as const,
        contentAuthority: locator.contentAuthority,
        connectionProfileId: snapshot.connectionProfileId,
        serverOrigin: snapshot.serverOrigin,
        workspaceId: snapshot.workspaceId,
        projectId: snapshot.projectId,
        canvasId: snapshot.canvasId,
        blockRef: snapshot.blockRef,
        authorityRevisions: snapshot.authorityRevisions,
        contentRevision: snapshot.contentRevision,
        graphFingerprint: snapshot.graphFingerprint
      };
      return brand(
        remoteWorkspaceAuthorityBindingSchema.parse({
          ...withoutId,
          bindingId: bindingId(remoteBindingIdentityValue(withoutId))
        })
      );
    }
  };
}

export function createLocalPackageAuthoritySource(): LocalWorkspaceAuthoritySourcePort {
  return {
    async inspect(locator, _scope) {
      const workspace = locator.canvasId
        ? await resolveTaskCanvasWorkspace(locator.packageWorkspace, locator.canvasId)
        : locator.packageWorkspace;
      const captured = await capturePackageSnapshot({ projectRoot: workspace });
      const loaded = await loadPlanGraphPackage(workspace);
      return localAuthoritySnapshotSchema.parse({
        packageWorkspace: locator.packageWorkspace,
        projectId: loaded.workspace.id,
        canvasId: (await commandCanvasIdForWorkspace(loaded.workspace)) ?? "default",
        contentRevision: captured.snapshot.sourceRevision,
        graphFingerprint: loaded.graph.packageFingerprint
      });
    }
  };
}
