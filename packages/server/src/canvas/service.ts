import { existsSync } from "node:fs";
import {
  CANVAS_COMMAND_MAX_JOURNAL_DELTA_ENTRIES,
  CANVAS_COMMAND_PROTOCOL_VERSION
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasScopeRefSchema,
  type ActorRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  canvasCommandAcceptedSchema,
  canvasCommandSubmitSchema,
  canvasReconnectDeltaSchema,
  canvasReconnectErrorSchema,
  canvasReconnectRequestSchema,
  canvasReconnectSnapshotSchema,
  type CanvasCommandAccepted,
  type CanvasCommandOutcome,
  type CanvasJournalEntry,
  type CanvasCommandSubmit,
  type CanvasReconnectRequest,
  type CanvasReconnectResponse,
  type CanvasCommandIntent,
  type CanvasSnapshotContent
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  type AuthoritativeContentVersion,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import { type CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import { type PackageSnapshotDigestManifest } from "@planweave-ai/collaboration-protocol/content/snapshot";
import {
  applyCanvasReplicaIntent,
  decodeCanvasReplicaDocument,
  encodeCanvasReplicaDocument
} from "@planweave-ai/runtime";
import type { CollaborationAuthContext } from "../identity/auth.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { authorizeCanvasCommand, authorizeCanvasContent, authorizeCanvasRead } from "./policy.js";
import {
  CanvasCommandRepository,
  digestCanvasIntent,
  rejectedOutcome,
  type CanvasScopeKey
} from "./repository.js";
import {
  CanvasOperationRetentionCorruptionError,
  CanvasOperationRetentionUnavailableError
} from "./operationRetention.js";
import type { CanvasRuntimeMutationPort } from "./runtimePort.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import type { AuthoritativeCanvasCommitPort } from "./authoritativeCanvasCommitPort.js";

export type CanvasCommandServiceOptions = {
  repository: CanvasCommandRepository;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  runtime: CanvasRuntimeMutationPort;
  /** When configured, commands are only visible after a complete immutable content version advances. */
  contentVersions?: ContentAuthorityStore;
  authoritativeCommits?: AuthoritativeCanvasCommitPort;
  /** Invoked only after a non-idempotent accepted journal commit is durable. */
  onAcceptedEntry?: (entry: CanvasJournalEntry) => void;
  /** Invalidates active live subscribers when a committed entry cannot be published. */
  onAcceptedEntryUnavailable?: (input: {
    scope: CanvasScopeKey;
    headRevision: number;
    headContentDigest: string;
  }) => void;
  clock?: () => Date;
  /**
   * Optional presence hub probe — only used in negative tests to prove presence is never
   * a durable mutation source. Production composition leaves this undefined.
   */
  presenceHeadProbe?: (scope: { projectId: string; canvasId: string }) => number | undefined;
};

function actorFrom(context: CollaborationAuthContext): ActorRef {
  return {
    kind: "human",
    id: context.humanPrincipalId,
    displayName: context.displayName
  };
}

function scopeKey(scope: {
  workspaceId: string;
  projectId: string;
  canvasId: string;
}): CanvasScopeKey {
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    canvasId: scope.canvasId
  };
}

function baseContentDigests(intent: CanvasCommandIntent): readonly string[] {
  switch (intent.kind) {
    case "update_task_fields":
    case "update_block_fields":
      return intent.fields.baseContentDigest === undefined ? [] : [intent.fields.baseContentDigest];
    case "update_task_prompt":
    case "update_block_prompt":
      return intent.baseContentDigest === undefined ? [] : [intent.baseContentDigest];
    case "bulk_update_blocks":
      return intent.updates.flatMap((update) =>
        update.fields.baseContentDigest === undefined ? [] : [update.fields.baseContentDigest]
      );
    default:
      return [];
  }
}

function packageDigestManifestFromContent(
  content: CompleteContentVersion
): PackageSnapshotDigestManifest {
  const manifest = content.members.find((member) => member.kind === "manifest");
  if (!manifest) throw new Error("canvas_baseline_rebase_authority_malformed");
  const prompts = content.members
    .filter((member) => member.kind === "task_prompt" || member.kind === "block_prompt")
    .map((member) => ({
      path: member.path,
      digest: { digestSha256: member.digestSha256, sizeBytes: member.sizeBytes }
    }));
  return {
    manifest: { digestSha256: manifest.digestSha256, sizeBytes: manifest.sizeBytes },
    prompts,
    totalBytes:
      manifest.sizeBytes + prompts.reduce((total, member) => total + member.digest.sizeBytes, 0)
  };
}

/**
 * Server-authoritative Canvas command service: ACL, CAS, serialization, idempotency,
 * journal/snapshot persistence, and reconnect. Presence is never consulted for mutations.
 */
export class CanvasCommandService {
  private readonly clock: () => Date;
  /** Per-canvas in-process serializer (complements SQLite IMMEDIATE transactions). */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CanvasCommandServiceOptions) {
    if (
      (options.onAcceptedEntry === undefined) !==
      (options.onAcceptedEntryUnavailable === undefined)
    ) {
      throw new Error("canvas_live_sync_publication_callbacks_must_be_paired");
    }
    this.clock = options.clock ?? (() => new Date());
  }

  private chainKey(scope: CanvasScopeKey): string {
    return `${scope.workspaceId}\0${scope.projectId}\0${scope.canvasId}`;
  }

  private async serialize<T>(scope: CanvasScopeKey, action: () => Promise<T>): Promise<T> {
    const key = this.chainKey(scope);
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    this.chains.set(key, next);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }

  private async rebuildLegacyBaseline(scope: CanvasScopeKey): Promise<void> {
    const rebase = this.options.repository.legacyBaselineRebase(scope);
    if (!rebase || rebase.status === "completed") return;

    const contentVersions = this.options.contentVersions;
    if (!contentVersions) throw new Error("canvas_baseline_rebase_authority_unavailable");
    const authorityHead = contentVersions.head(scope);
    if (!authorityHead) throw new Error("canvas_baseline_rebase_authority_unavailable");

    let authorityVersion: AuthoritativeContentVersion;
    try {
      authorityVersion = contentVersions.readVersion(scope, authorityHead.content);
    } catch {
      throw new Error("canvas_baseline_rebase_authority_unavailable");
    }
    if (
      authorityVersion.completed.versionId !== authorityHead.content.versionId ||
      authorityVersion.completed.canonicalDigest !== authorityHead.content.canonicalDigest ||
      authorityVersion.content.canonicalDigest !== authorityHead.content.canonicalDigest
    ) {
      throw new Error("canvas_baseline_rebase_authority_mismatch");
    }

    this.options.repository.completeLegacyBaselineRebase(scope, {
      contentDigest: authorityVersion.content.canonicalDigest,
      digestManifest: packageDigestManifestFromContent(authorityVersion.content),
      sizeBytes: authorityVersion.content.totalBytes
    });
  }

  private readAuthoritativeContent(scope: CanvasScopeKey): {
    content: AuthoritativeContentVersion;
    expectedContentHeadRevision: number;
  } {
    const contentVersions = this.options.contentVersions;
    if (!contentVersions) throw new Error("content_authority_unavailable");
    const head = contentVersions.head(scope);
    if (!head) throw new Error("initial_content_publish_required");
    const content = contentVersions.readVersion(scope, head.content);
    if (content.content.canonicalDigest !== head.content.canonicalDigest) {
      throw new Error("content_authority_head_mismatch");
    }
    return {
      content,
      expectedContentHeadRevision: head.revision
    };
  }

  private snapshotFromAuthoritativeHead(
    scope: CanvasScopeKey,
    revision: number
  ): CanvasSnapshotContent | null {
    try {
      const authority = this.readAuthoritativeContent(scope);
      if (
        authority.content.content.canonicalDigest !==
        this.options.repository.head(scope).contentDigest
      ) {
        return null;
      }
      return {
        metadata: {
          schemaVersion: "canvas-snapshot/v2",
          scope: canvasScopeRefSchema.parse(scope),
          revision,
          contentDigest: authority.content.content.canonicalDigest,
          createdAt: authority.content.createdAt,
          sizeBytes: authority.content.content.totalBytes
        },
        encoding: "content_version_ref",
        content: authority.content.completed
      };
    } catch {
      return null;
    }
  }

  private commitAcceptedWithAuthoritativeContent(input: {
    scope: CanvasScopeKey;
    operationId: string;
    intent: CanvasCommandSubmit["intent"];
    intentDigest: string;
    actor: ActorRef;
    previousRevision: number;
    expectedContentDigest?: string;
    digestManifest?: Parameters<CanvasCommandRepository["commitAccepted"]>[0]["digestManifest"];
    content: AuthoritativeContentVersion;
    expectedContentHeadRevision: number;
  }): CanvasCommandAccepted {
    const authoritativeCommits = this.options.authoritativeCommits;
    if (!authoritativeCommits) throw new Error("content_commit_unavailable");
    return authoritativeCommits.commit({
      content: {
        scope: input.scope,
        expectedRevision: input.expectedContentHeadRevision,
        version: input.content.completed
      },
      accepted: {
        scope: input.scope,
        operationId: input.operationId,
        intent: input.intent,
        intentDigest: input.intentDigest,
        actor: input.actor,
        previousRevision: input.previousRevision,
        expectedContentDigest: input.expectedContentDigest,
        revision: input.previousRevision + 1,
        contentDigest: input.content.completed.canonicalDigest,
        digestManifest: input.digestManifest,
        sizeBytes: input.content.content.totalBytes
      }
    });
  }

  async submit(actor: CollaborationAuthContext, rawSubmit: unknown): Promise<CanvasCommandOutcome> {
    const parsed = canvasCommandSubmitSchema.safeParse(rawSubmit);
    if (!parsed.success) {
      const projectId =
        typeof (rawSubmit as { projectId?: unknown })?.projectId === "string"
          ? String((rawSubmit as { projectId: string }).projectId)
          : actor.projectId;
      const canvasId =
        typeof (rawSubmit as { canvasId?: unknown })?.canvasId === "string"
          ? String((rawSubmit as { canvasId: string }).canvasId)
          : "unknown";
      const operationId =
        typeof (rawSubmit as { operationId?: unknown })?.operationId === "string"
          ? String((rawSubmit as { operationId: string }).operationId)
          : "invalid-operation";
      return rejectedOutcome({
        projectId,
        canvasId,
        operationId,
        code: "invalid_command",
        detail: "submit_schema_invalid"
      });
    }
    const submit = parsed.data;
    // Presence must never gate durable mutations.
    void this.options.presenceHeadProbe?.({
      projectId: submit.projectId,
      canvasId: submit.canvasId
    });

    const auth = authorizeCanvasCommand({
      actor,
      projectId: submit.projectId,
      canvasId: submit.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!auth.ok) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: auth.code,
        detail: auth.code === "forbidden" ? "canvas_write_denied" : undefined
      });
    }

    const scope = scopeKey(auth.scope);
    return this.serialize(scope, async () => {
      try {
        return await this.submitAuthorized(actor, submit, auth);
      } catch (error) {
        if (error instanceof CanvasOperationRetentionCorruptionError) {
          this.options.repository.operationRetention.markRepairRequired(
            error.scope,
            error.failureCode
          );
          return rejectedOutcome({
            projectId: submit.projectId,
            canvasId: submit.canvasId,
            operationId: submit.operationId,
            code: "server_error",
            detail: "canvas_operation_retention_repair_required"
          });
        }
        if (error instanceof CanvasOperationRetentionUnavailableError) {
          return rejectedOutcome({
            projectId: submit.projectId,
            canvasId: submit.canvasId,
            operationId: submit.operationId,
            code: "server_error",
            detail:
              error.reason === "repair_required"
                ? "canvas_operation_retention_repair_required"
                : "canvas_operation_retention_reconciling"
          });
        }
        throw error;
      }
    });
  }

  private async submitAuthorized(
    actor: CollaborationAuthContext,
    submit: CanvasCommandSubmit,
    auth: Extract<ReturnType<typeof authorizeCanvasCommand>, { ok: true }>
  ): Promise<CanvasCommandOutcome> {
    const scope = scopeKey(auth.scope);
    const intentDigest = digestCanvasIntent(submit.intent);

    // Re-check ACL inside the serializer (covers revocation races).
    const reauth = authorizeCanvasCommand({
      actor,
      projectId: submit.projectId,
      canvasId: submit.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!reauth.ok) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: reauth.code,
        detail: reauth.code === "forbidden" ? "canvas_write_denied" : undefined
      });
    }

    try {
      await this.rebuildLegacyBaseline(scope);
    } catch (error) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "journal_unavailable",
        detail:
          error instanceof Error ? error.message.slice(0, 200) : "canvas_baseline_rebase_failed"
      });
    }

    const existing = this.options.repository.getOperation(scope, submit.operationId);
    if (existing) {
      if (existing.intentDigest !== intentDigest) {
        return rejectedOutcome({
          projectId: submit.projectId,
          canvasId: submit.canvasId,
          operationId: submit.operationId,
          code: "operation_conflict",
          detail: "operation_id_intent_mismatch"
        });
      }
      if (existing.outcome.type === "canvas.command.accepted") {
        return canvasCommandAcceptedSchema.parse({
          ...existing.outcome,
          idempotentReplay: true
        });
      }
      return existing.outcome;
    }
    if (this.options.repository.hasPendingRecovery(scope)) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "journal_unavailable",
        detail: "canvas_recovery_pending"
      });
    }

    let authority: { content: AuthoritativeContentVersion; expectedContentHeadRevision: number };
    try {
      authority = this.readAuthoritativeContent(scope);
    } catch (error) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "journal_unavailable",
        detail:
          error instanceof Error ? error.message.slice(0, 200) : "content_authority_unavailable"
      });
    }
    let head = this.options.repository.head(scope);
    if (head.revision === 0 && head.contentDigest === "0".repeat(64)) {
      head = this.options.repository.ensureInitialHead(
        scope,
        authority.content.content.canonicalDigest
      );
    }
    if (head.contentDigest !== authority.content.content.canonicalDigest) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "journal_unavailable",
        detail: "canvas_content_head_mismatch"
      });
    }
    if (submit.expectedRevision !== head.revision) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "stale_revision",
        conflict: {
          expectedRevision: submit.expectedRevision,
          authoritativeRevision: head.revision,
          authoritativeContentDigest: head.contentDigest
        }
      });
    }
    if (
      baseContentDigests(submit.intent).some(
        (digest) => digest !== authority.content.content.canonicalDigest
      )
    ) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "operation_conflict",
        detail: "base_content_digest_mismatch"
      });
    }

    const actorRef = actorFrom(actor);
    this.options.repository.reservePending({
      scope,
      operationId: submit.operationId,
      expectedRevision: submit.expectedRevision,
      intent: submit.intent,
      intentDigest,
      actor: actorRef
    });

    let nextContent: CompleteContentVersion;
    try {
      nextContent = encodeCanvasReplicaDocument(
        applyCanvasReplicaIntent(
          decodeCanvasReplicaDocument(authority.content.content),
          submit.intent
        )
      );
    } catch (error) {
      const rejected = rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "invalid_command",
        detail: error instanceof Error ? error.message.slice(0, 200) : "intent_apply_failed"
      });
      this.options.repository.storeRejected({
        scope,
        operationId: submit.operationId,
        intent: submit.intent,
        intentDigest,
        rejected
      });
      return rejected;
    }

    let nextAuthority: AuthoritativeContentVersion;
    try {
      const contentVersions = this.options.contentVersions;
      if (!contentVersions) throw new Error("content_authority_unavailable");
      nextAuthority = contentVersions.persistImmutable({
        scope,
        content: nextContent,
        createdBy: actorRef
      });
    } catch (error) {
      this.options.repository.clearPending(scope, submit.operationId);
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "journal_unavailable",
        detail: error instanceof Error ? error.message.slice(0, 200) : "content_persist_failed"
      });
    }

    // CAS re-check immediately before durable commit (concurrent writers).
    const headAfter = this.options.repository.head(scope);
    if (headAfter.revision !== submit.expectedRevision) {
      this.options.repository.clearPending(scope, submit.operationId);
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "stale_revision",
        conflict: {
          expectedRevision: submit.expectedRevision,
          authoritativeRevision: headAfter.revision,
          authoritativeContentDigest: headAfter.contentDigest
        }
      });
    }

    let accepted: CanvasCommandAccepted;
    try {
      accepted = this.commitAcceptedWithAuthoritativeContent({
        scope,
        operationId: submit.operationId,
        intent: submit.intent,
        intentDigest,
        actor: actorRef,
        previousRevision: submit.expectedRevision,
        expectedContentDigest: head.contentDigest,
        content: nextAuthority,
        expectedContentHeadRevision: authority.expectedContentHeadRevision
      });
    } catch (error) {
      if (
        error instanceof CanvasOperationRetentionUnavailableError ||
        error instanceof CanvasOperationRetentionCorruptionError
      ) {
        throw error;
      }
      this.options.repository.clearPending(scope, submit.operationId);
      const currentHead = this.options.repository.head(scope);
      if (currentHead.revision !== submit.expectedRevision) {
        return rejectedOutcome({
          projectId: submit.projectId,
          canvasId: submit.canvasId,
          operationId: submit.operationId,
          code: "stale_revision",
          conflict: {
            expectedRevision: submit.expectedRevision,
            authoritativeRevision: currentHead.revision,
            authoritativeContentDigest: currentHead.contentDigest
          }
        });
      }
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "journal_unavailable",
        detail: error instanceof Error ? error.message.slice(0, 200) : "journal_commit_failed"
      });
    }
    this.publishAcceptedEntry(scope, accepted);
    return accepted;
  }

  private publishAcceptedEntry(scope: CanvasScopeKey, accepted: CanvasCommandAccepted): void {
    if (accepted.idempotentReplay || !this.options.onAcceptedEntry) return;
    try {
      const entry = this.options.repository.journalEntryAt(scope, accepted.revision);
      if (!entry) throw new Error("canvas_live_sync_committed_entry_missing");
      this.options.onAcceptedEntry(entry);
    } catch {
      this.notifyLiveSubscribersOfPublicationFailure(scope, accepted);
    }
  }

  private notifyLiveSubscribersOfPublicationFailure(
    scope: CanvasScopeKey,
    accepted: CanvasCommandAccepted
  ): void {
    try {
      this.options.onAcceptedEntryUnavailable?.({
        scope,
        headRevision: accepted.revision,
        headContentDigest: accepted.contentDigest
      });
    } catch {
      // A durable command must remain accepted even if its best-effort transport invalidation fails.
      process.emitWarning("canvas_live_sync_invalidation_failed", {
        code: "PLANWEAVE_CANVAS_LIVE_SYNC_INVALIDATION_FAILED"
      });
    }
  }

  async reconnect(
    actor: CollaborationAuthContext,
    rawRequest: unknown
  ): Promise<CanvasReconnectResponse> {
    const parsed = canvasReconnectRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      const projectId =
        typeof (rawRequest as { projectId?: unknown })?.projectId === "string"
          ? String((rawRequest as { projectId: string }).projectId)
          : actor.projectId;
      const canvasId =
        typeof (rawRequest as { canvasId?: unknown })?.canvasId === "string"
          ? String((rawRequest as { canvasId: string }).canvasId)
          : "unknown";
      return canvasReconnectErrorSchema.parse({
        type: "canvas.reconnect.error",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId,
        canvasId,
        code: "invalid_request",
        detail: "reconnect_schema_invalid"
      });
    }
    const request = parsed.data;
    const auth = authorizeCanvasContent({
      actor,
      projectId: request.projectId,
      canvasId: request.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!auth.ok) {
      return canvasReconnectErrorSchema.parse({
        type: "canvas.reconnect.error",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId: request.projectId,
        canvasId: request.canvasId,
        code: auth.code
      });
    }
    const scope = scopeKey(auth.scope);
    return this.serialize(scope, () => this.reconnectAuthorized(request, scope));
  }

  async readRuntimeStatus(
    actor: CollaborationAuthContext,
    input: { projectId: string; canvasId: string }
  ): Promise<CanvasRuntimeStatusProjection> {
    const contentAuth = authorizeCanvasContent({
      actor,
      projectId: input.projectId,
      canvasId: input.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!contentAuth.ok) throw new Error(`canvas_runtime_status_${contentAuth.code}`);
    const capturedAt = this.clock().toISOString();
    const pathAuth = authorizeCanvasRead({
      actor,
      projectId: input.projectId,
      canvasId: input.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    const readStatus = this.options.runtime.readStatus;
    if (
      !pathAuth.ok ||
      !readStatus ||
      !existsSync(pathAuth.projectRoot) ||
      !existsSync(pathAuth.packageDir)
    ) {
      throw new Error("canvas_runtime_status_unavailable");
    }
    try {
      return await readStatus({
        projectRoot: pathAuth.projectRoot,
        canvasId: input.canvasId,
        expectedPackageDir: pathAuth.packageDir,
        scope: canvasScopeRefSchema.parse(pathAuth.scope),
        capturedAt
      });
    } catch (error) {
      throw new Error("canvas_runtime_status_unavailable", { cause: error });
    }
  }

  private async reconnectAuthorized(
    request: CanvasReconnectRequest,
    scope: CanvasScopeKey
  ): Promise<CanvasReconnectResponse> {
    const authorizedScope = {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    };
    try {
      await this.rebuildLegacyBaseline(scope);
    } catch (error) {
      return canvasReconnectErrorSchema.parse({
        type: "canvas.reconnect.error",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId: request.projectId,
        canvasId: request.canvasId,
        code: "server_error",
        detail:
          error instanceof Error ? error.message.slice(0, 200) : "canvas_baseline_rebase_failed"
      });
    }
    let authority: { content: AuthoritativeContentVersion; expectedContentHeadRevision: number };
    try {
      authority = this.readAuthoritativeContent(scope);
    } catch (error) {
      return canvasReconnectErrorSchema.parse({
        type: "canvas.reconnect.error",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId: request.projectId,
        canvasId: request.canvasId,
        code: "snapshot_malformed",
        detail:
          error instanceof Error ? error.message.slice(0, 200) : "content_authority_unavailable"
      });
    }
    let head = this.options.repository.head(scope);
    if (head.revision === 0 && head.contentDigest === "0".repeat(64)) {
      head = this.options.repository.ensureInitialHead(
        scope,
        authority.content.content.canonicalDigest
      );
    }
    if (head.contentDigest !== authority.content.content.canonicalDigest) {
      return canvasReconnectErrorSchema.parse({
        type: "canvas.reconnect.error",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId: request.projectId,
        canvasId: request.canvasId,
        code: "snapshot_malformed",
        detail: "canvas_content_head_mismatch"
      });
    }

    if (request.afterRevision > head.revision) {
      return this.verifiedSnapshotOrError(scope, request, "revision_ahead");
    }

    if (request.afterRevision === 0) {
      return this.verifiedSnapshotOrError(scope, request, "fresh_session");
    }

    if (request.afterContentDigest !== undefined) {
      const entry = this.options.repository.journalEntryAt(scope, request.afterRevision);
      const digestAt =
        entry?.contentDigest ??
        (request.afterRevision === head.revision ? head.contentDigest : undefined);
      if (digestAt !== undefined && digestAt !== request.afterContentDigest) {
        const snapshot = this.verifiedSnapshotOrError(scope, request, "digest_mismatch");
        return snapshot;
      }
    }

    const oldest = this.options.repository.oldestRetainedRevision(scope);
    if (request.afterRevision > 0 && oldest > 0 && request.afterRevision < oldest - 0) {
      // If the next entry is not contiguous from afterRevision, journal was truncated.
      const entriesProbe = this.options.repository.listJournalAfter(scope, request.afterRevision);
      if (
        entriesProbe.length === 0
          ? request.afterRevision !== head.revision
          : entriesProbe[0]!.previousRevision !== request.afterRevision
      ) {
        return this.verifiedSnapshotOrError(scope, request, "truncated_journal");
      }
    }

    if (oldest > 0 && request.afterRevision < oldest - 1) {
      // Retention dropped history before the client's cursor.
      const first = this.options.repository.listJournalAfter(scope, oldest - 1)[0];
      if (!first || first.previousRevision > request.afterRevision) {
        return this.verifiedSnapshotOrError(scope, request, "retention_gap");
      }
    }

    const entries = this.options.repository.listJournalAfter(scope, request.afterRevision);
    if (entries.length > CANVAS_COMMAND_MAX_JOURNAL_DELTA_ENTRIES) {
      return this.verifiedSnapshotOrError(scope, request, "truncated_journal");
    }
    if (entries.length === 0) {
      if (request.afterRevision !== head.revision) {
        return this.verifiedSnapshotOrError(scope, request, "retention_gap");
      }
      return canvasReconnectDeltaSchema.parse({
        type: "canvas.reconnect.delta",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        scope: authorizedScope,
        afterRevision: request.afterRevision,
        headRevision: head.revision,
        headContentDigest: head.contentDigest,
        entries: []
      });
    }
    if (entries[0]!.previousRevision !== request.afterRevision) {
      return this.verifiedSnapshotOrError(scope, request, "truncated_journal");
    }

    return canvasReconnectDeltaSchema.parse({
      type: "canvas.reconnect.delta",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: authorizedScope,
      afterRevision: request.afterRevision,
      headRevision: head.revision,
      headContentDigest: head.contentDigest,
      entries
    });
  }

  private verifiedSnapshotOrError(
    scope: CanvasScopeKey,
    request: CanvasReconnectRequest,
    reason:
      | "retention_gap"
      | "digest_mismatch"
      | "truncated_journal"
      | "fresh_session"
      | "revision_ahead"
  ): CanvasReconnectResponse {
    const head = this.options.repository.head(scope);
    const snapshot = this.snapshotFromAuthoritativeHead(scope, head.revision);
    if (!snapshot || !this.verifySnapshot(head.contentDigest, snapshot)) {
      return canvasReconnectErrorSchema.parse({
        type: "canvas.reconnect.error",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId: request.projectId,
        canvasId: request.canvasId,
        code: "snapshot_malformed",
        detail: reason
      });
    }
    return canvasReconnectSnapshotSchema.parse({
      type: "canvas.reconnect.snapshot",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId
      },
      reason,
      afterRevision: request.afterRevision,
      snapshot
    });
  }

  private verifySnapshot(expectedDigest: string, snapshot: CanvasSnapshotContent): boolean {
    if (snapshot.metadata.contentDigest !== expectedDigest) return false;
    return snapshot.content.canonicalDigest === expectedDigest;
  }

  /** Failed authority transactions cannot have changed a local package, so retries are safe. */
  async recoverInterrupted(
    limit = 100
  ): Promise<{ cleared: number; recovered: number; deferred: number }> {
    let pending: ReturnType<CanvasCommandRepository["listNeedsRecovery"]>;
    try {
      pending = this.options.repository.listNeedsRecovery(limit);
    } catch (error) {
      if (error instanceof CanvasOperationRetentionCorruptionError) {
        this.options.repository.operationRetention.markRepairRequired(
          error.scope,
          error.failureCode
        );
        return { cleared: 0, recovered: 0, deferred: 1 };
      }
      throw error;
    }
    let cleared = 0;
    let deferred = 0;
    for (const item of pending) {
      try {
        await this.serialize(item.scope, async () => {
          this.options.repository.operationRetention.assertScopeWritable(item.scope);
          this.options.repository.clearPending(item.scope, item.operationId);
        });
        cleared += 1;
      } catch (error) {
        if (error instanceof CanvasOperationRetentionCorruptionError) {
          this.options.repository.operationRetention.markRepairRequired(
            error.scope,
            error.failureCode
          );
          deferred += 1;
          continue;
        }
        if (error instanceof CanvasOperationRetentionUnavailableError) {
          deferred += 1;
          continue;
        }
        throw error;
      }
    }
    return { cleared, recovered: 0, deferred };
  }

  /** Test/diagnostic head read; not a presence cursor. */
  head(scope: CanvasScopeKey) {
    return this.options.repository.head(scope);
  }
}

export type { CanvasCommandAccepted };
