import {
  ownerCanvasMaterializationResultSchema,
  ownerCanvasMaterializationScopeSchema,
  type OwnerCanvasMaterializationResult,
  type OwnerCanvasMaterializationScope
} from "@planweave-ai/collaboration-protocol/owner-canvas/materialization";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { createHash } from "node:crypto";
import { HumanPrincipalIdentity, sqlPlaceholders } from "../identity/humanPrincipalIdentity.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import type { RuntimeCanvasScope } from "./executionRuntimePort.js";

export type OwnerCanvasMaterializationScopeRecord = OwnerCanvasMaterializationScope & {
  workspaceId: string;
};

type ScopeRow = Record<string, unknown>;
type ReceiptRow = Record<string, unknown>;

function scopeParameters(scope: OwnerCanvasMaterializationScope): [string, string, string] {
  return [scope.ownerHumanPrincipalId, scope.projectId, scope.canvasId];
}

/** The content namespace is server-internal and never supplied by an Operator client. */
export function ownerCanvasMaterializationWorkspaceIdForScope(
  database: SqliteDatabase,
  rawScope: OwnerCanvasMaterializationScope
): string {
  const parsed = ownerCanvasMaterializationScopeSchema.parse(rawScope);
  const scope = {
    ...parsed,
    ownerHumanPrincipalId: new HumanPrincipalIdentity(database).canonicalizeTarget(
      parsed.ownerHumanPrincipalId
    )
  };
  const digest = createHash("sha256")
    .update(JSON.stringify([scope.ownerHumanPrincipalId, scope.projectId, scope.canvasId]), "utf8")
    .digest("hex");
  return workspaceIdSchema.parse(`owner-canvas-runtime:${digest}`);
}

function toScope(row: ScopeRow): OwnerCanvasMaterializationScopeRecord {
  const scope = ownerCanvasMaterializationScopeSchema.parse({
    ownerHumanPrincipalId: row.owner_human_principal_id,
    projectId: row.project_id,
    canvasId: row.canvas_id
  });
  return { ...scope, workspaceId: workspaceIdSchema.parse(row.workspace_id) };
}

function toReceipt(row: ReceiptRow): OwnerCanvasMaterializationResult {
  return ownerCanvasMaterializationResultSchema.parse({
    schemaVersion: "owner-canvas-materialization/v1",
    materializationId: row.materialization_id,
    scope: {
      ownerHumanPrincipalId: row.owner_human_principal_id,
      projectId: row.project_id,
      canvasId: row.canvas_id
    },
    head: {
      revision: row.revision,
      content: {
        versionId: row.version_id,
        canonicalDigest: row.canonical_digest,
        verification: "complete"
      }
    },
    contentRevision: row.content_revision,
    graphFingerprint: row.graph_fingerprint
  });
}

/** Durable owner-scope lookup and idempotent materialization receipts. */
export class OwnerCanvasMaterializationRepository {
  private readonly identity: HumanPrincipalIdentity;

  constructor(private readonly database: SqliteDatabase) {
    this.identity = new HumanPrincipalIdentity(database);
  }

  canonicalizeScope(rawScope: OwnerCanvasMaterializationScope): OwnerCanvasMaterializationScope {
    const scope = ownerCanvasMaterializationScopeSchema.parse(rawScope);
    return ownerCanvasMaterializationScopeSchema.parse({
      ...scope,
      ownerHumanPrincipalId: this.identity.canonicalizeTarget(scope.ownerHumanPrincipalId)
    });
  }

  registerScope(
    input: OwnerCanvasMaterializationScope & { createdAt: string }
  ): OwnerCanvasMaterializationScopeRecord {
    const scope = this.canonicalizeScope({
      ownerHumanPrincipalId: input.ownerHumanPrincipalId,
      projectId: input.projectId,
      canvasId: input.canvasId
    });
    const workspaceId = ownerCanvasMaterializationWorkspaceIdForScope(this.database, scope);
    return inWriteTransaction(this.database, () => {
      const existing = this.findScope(scope);
      if (existing) {
        if (existing.workspaceId !== workspaceId) {
          throw new Error("owner_canvas_materialization_scope_conflict");
        }
        return existing;
      }
      this.database
        .prepare(
          `INSERT INTO owner_canvas_materialization_scopes(
             owner_human_principal_id,project_id,canvas_id,workspace_id,created_at
           ) VALUES(?,?,?,?,?)`
        )
        .run(
          scope.ownerHumanPrincipalId,
          scope.projectId,
          scope.canvasId,
          workspaceId,
          input.createdAt
        );
      return { ...scope, workspaceId };
    });
  }

  ensureScope(input: OwnerCanvasMaterializationScope & { createdAt: string }) {
    return this.registerScope(input);
  }

  findScope(
    rawScope: OwnerCanvasMaterializationScope
  ): OwnerCanvasMaterializationScopeRecord | undefined {
    const scope = this.canonicalizeScope(rawScope);
    this.assertNoLegacyAliasScope(scope);
    const row = this.database
      .prepare(
        `SELECT owner_human_principal_id,project_id,canvas_id,workspace_id
           FROM owner_canvas_materialization_scopes
          WHERE owner_human_principal_id=? AND project_id=? AND canvas_id=?`
      )
      .get(...scopeParameters(scope));
    return row ? this.assertStoredScopeCanonical(toScope(row)) : undefined;
  }

  findRuntimeScope(
    rawScope: RuntimeCanvasScope
  ): OwnerCanvasMaterializationScopeRecord | undefined {
    const workspaceId = workspaceIdSchema.parse(rawScope.workspaceId);
    const projectId = ownerCanvasMaterializationScopeSchema.shape.projectId.parse(
      rawScope.projectId
    );
    const canvasId = ownerCanvasMaterializationScopeSchema.shape.canvasId.parse(rawScope.canvasId);
    const row = this.database
      .prepare(
        `SELECT owner_human_principal_id,project_id,canvas_id,workspace_id
           FROM owner_canvas_materialization_scopes
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(workspaceId, projectId, canvasId);
    return row ? this.assertStoredScopeCanonical(toScope(row)) : undefined;
  }

  hasRuntimeScope(rawScope: RuntimeCanvasScope): boolean {
    return this.findRuntimeScope(rawScope) !== undefined;
  }

  getReceipt(input: {
    scope: OwnerCanvasMaterializationScope;
    materializationId: string;
  }): OwnerCanvasMaterializationResult | undefined {
    const scope = this.canonicalizeScope(input.scope);
    this.assertNoLegacyAliasScope(scope);
    const row = this.database
      .prepare(
        `SELECT owner_human_principal_id,project_id,canvas_id,materialization_id,
                canonical_digest,version_id,revision,content_revision,graph_fingerprint
           FROM owner_canvas_materialization_receipts
          WHERE owner_human_principal_id=? AND project_id=? AND canvas_id=?
            AND materialization_id=?`
      )
      .get(...scopeParameters(scope), input.materializationId);
    return row ? toReceipt(row) : undefined;
  }

  recordReceipt(input: {
    result: OwnerCanvasMaterializationResult;
    workspaceId: string;
    createdAt: string;
  }): void {
    const parsedResult = ownerCanvasMaterializationResultSchema.parse(input.result);
    const canonicalScope = this.canonicalizeScope(parsedResult.scope);
    this.assertNoLegacyAliasScope(canonicalScope);
    const result = ownerCanvasMaterializationResultSchema.parse({
      ...parsedResult,
      scope: canonicalScope
    });
    const workspaceId = workspaceIdSchema.parse(input.workspaceId);
    this.database
      .prepare(
        `INSERT INTO owner_canvas_materialization_receipts(
           owner_human_principal_id,project_id,canvas_id,materialization_id,workspace_id,
           canonical_digest,version_id,revision,content_revision,graph_fingerprint,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        result.scope.ownerHumanPrincipalId,
        result.scope.projectId,
        result.scope.canvasId,
        result.materializationId,
        workspaceId,
        result.head.content.canonicalDigest,
        result.head.content.versionId,
        result.head.revision,
        result.contentRevision,
        result.graphFingerprint,
        input.createdAt
      );
  }

  private assertNoLegacyAliasScope(scope: OwnerCanvasMaterializationScope): void {
    const aliasIds = this.identity
      .equivalentIds(scope.ownerHumanPrincipalId)
      .filter((id) => id !== scope.ownerHumanPrincipalId);
    if (aliasIds.length === 0) return;
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM owner_canvas_materialization_scopes
          WHERE owner_human_principal_id IN (${sqlPlaceholders(aliasIds)})
            AND project_id=? AND canvas_id=? LIMIT 1`
      )
      .get(...aliasIds, scope.projectId, scope.canvasId);
    if (row) throw new Error("owner_canvas_materialization_alias_scope_conflict");
  }

  private assertStoredScopeCanonical(
    scope: OwnerCanvasMaterializationScopeRecord
  ): OwnerCanvasMaterializationScopeRecord {
    if (
      this.identity.canonicalizeTarget(scope.ownerHumanPrincipalId) !== scope.ownerHumanPrincipalId
    ) {
      throw new Error("owner_canvas_materialization_alias_scope_conflict");
    }
    return scope;
  }
}
