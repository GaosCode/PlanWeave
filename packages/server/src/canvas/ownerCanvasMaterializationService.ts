import {
  ownerCanvasMaterializationRequestSchema,
  ownerCanvasMaterializationHeadViewSchema,
  ownerCanvasMaterializationResultSchema,
  ownerCanvasMaterializationScopeSchema,
  type OwnerCanvasMaterializationRequest,
  type OwnerCanvasMaterializationResult
} from "@planweave-ai/collaboration-protocol/owner-canvas/materialization";
import {
  decodeCanvasReplicaDocument,
  packageSnapshotSourceRevision,
  projectCanvasReplicaDocument
} from "@planweave-ai/runtime";
import { packageDigestManifestFromContent } from "./contentFingerprint.js";
import { ContentVersionRepository } from "./contentVersionRepository.js";
import {
  OwnerCanvasMaterializationRepository,
  type OwnerCanvasMaterializationScopeRecord
} from "./ownerCanvasMaterializationRepository.js";
import type { CanvasScopeKey } from "./repository.js";

export type OwnerCanvasMaterializationActivityFence = {
  assertScopeMaterializable(scope: OwnerCanvasMaterializationScopeRecord): void;
};

function expectedHeadMatches(
  expected: OwnerCanvasMaterializationRequest["expectedHead"],
  current: ReturnType<ContentVersionRepository["head"]>
): boolean {
  if (expected.kind === "absent") return current === null;
  return (
    current !== null &&
    current.revision === expected.revision &&
    current.content.versionId === expected.content.versionId &&
    current.content.canonicalDigest === expected.content.canonicalDigest
  );
}

function contentScope(scope: OwnerCanvasMaterializationScopeRecord): CanvasScopeKey {
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    canvasId: scope.canvasId
  };
}

/**
 * Server-only owner authority publication. It neither selects nor inspects a
 * Host and cannot create a Workspace grant from caller-provided data.
 */
export class OwnerCanvasMaterializationService {
  constructor(
    private readonly options: {
      contentVersions: ContentVersionRepository;
      scopes: OwnerCanvasMaterializationRepository;
      activityFence: OwnerCanvasMaterializationActivityFence;
      clock?: () => Date;
    }
  ) {}

  inspectHead(rawScope: unknown) {
    const scope = this.options.scopes.canonicalizeScope(
      ownerCanvasMaterializationScopeSchema.parse(rawScope)
    );
    const registered = this.options.scopes.findScope(scope);
    const current = registered ? this.options.contentVersions.head(contentScope(registered)) : null;
    return ownerCanvasMaterializationHeadViewSchema.parse({
      schemaVersion: "owner-canvas-materialization/v1",
      scope,
      head: current
        ? { kind: "present", revision: current.revision, content: current.content }
        : { kind: "absent" }
    });
  }

  materialize(rawRequest: unknown): OwnerCanvasMaterializationResult {
    const parsedRequest = ownerCanvasMaterializationRequestSchema.parse(rawRequest);
    const request = ownerCanvasMaterializationRequestSchema.parse({
      ...parsedRequest,
      scope: this.options.scopes.canonicalizeScope(parsedRequest.scope)
    });
    const clock = this.options.clock ?? (() => new Date());
    const verifiedContent = this.options.contentVersions.verify(request.content);
    const scope = this.options.scopes.ensureScope({
      ...request.scope,
      createdAt: clock().toISOString()
    });
    const authorityScope = contentScope(scope);

    return this.options.contentVersions.runInWriteTransaction(() => {
      const replay = this.options.scopes.getReceipt({
        scope: request.scope,
        materializationId: request.materializationId
      });
      if (replay) {
        if (replay.head.content.canonicalDigest !== verifiedContent.canonicalDigest) {
          throw new Error("owner_canvas_materialization_idempotency_conflict");
        }
        return replay;
      }
      this.options.activityFence.assertScopeMaterializable(scope);
      const current = this.options.contentVersions.head(authorityScope);
      if (!expectedHeadMatches(request.expectedHead, current)) {
        throw new Error("owner_canvas_materialization_head_conflict");
      }
      const version = this.options.contentVersions.persistImmutable({
        scope: authorityScope,
        content: verifiedContent,
        createdBy: { kind: "human", id: request.scope.ownerHumanPrincipalId }
      });
      const head = this.options.contentVersions.advanceHeadForSqliteCommit({
        scope: authorityScope,
        expectedRevision: current?.revision ?? 0,
        content: version.completed
      });
      const contentRevision = packageSnapshotSourceRevision(
        packageDigestManifestFromContent(verifiedContent)
      );
      const graphFingerprint = projectCanvasReplicaDocument(
        decodeCanvasReplicaDocument(verifiedContent)
      ).packageFingerprint;
      const result = ownerCanvasMaterializationResultSchema.parse({
        schemaVersion: "owner-canvas-materialization/v1",
        materializationId: request.materializationId,
        scope: request.scope,
        head: { revision: head.revision, content: head.content },
        contentRevision,
        graphFingerprint
      });
      this.options.scopes.recordReceipt({
        result,
        workspaceId: scope.workspaceId,
        createdAt: clock().toISOString()
      });
      return result;
    });
  }
}
