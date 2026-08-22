import {
  authoritativeContentHeadSchema,
  authoritativeContentVersionSchema,
  compareContentVersionMemberPaths,
  completedContentVersionRefSchema,
  contentVersionMemberSchema,
  contentVersionJournalEntrySchema,
  workspaceCanvasPublishedAuthoritySchema,
  workspaceCanvasPublishLocalSourceSchema,
  type AuthoritativeContentHead,
  type AuthoritativeContentVersion,
  type CompleteContentVersion,
  type CompletedContentVersionRef,
  type ContentVersionMember,
  type WorkspaceCanvasPublishedAuthority,
  type WorkspaceCanvasPublishLocalSource
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  canvasScopeRefSchema,
  type ActorRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { type ContentVersionTransferHeaderFrame } from "@planweave-ai/collaboration-protocol/content/transfer";
import { validateAuthoritativeCanvasContent } from "@planweave-ai/runtime";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import type { CanvasScopeKey } from "./repository.js";

type VersionRow = Record<string, unknown>;

const workspacePublishOperationSelect = `SELECT operation_id,recovery_token,workspace_id,project_id,canvas_id,local_project_id,local_canvas_id,version_id,canonical_digest,revision,visibility`;

export type WorkspaceCanvasPublishOperationRecord = {
  authority: WorkspaceCanvasPublishedAuthority;
  localSource: WorkspaceCanvasPublishLocalSource;
};

function contentRef(content: CompleteContentVersion): CompletedContentVersionRef {
  return completedContentVersionRefSchema.parse({
    versionId: `version-${content.canonicalDigest}`,
    canonicalDigest: content.canonicalDigest,
    verification: "complete"
  });
}

/**
 * Durable immutable content objects and their scoped heads. The storage is authoritative;
 * working directories are deliberately absent from the schema and API.
 */
export class ContentVersionRepository implements ContentAuthorityStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  verify(rawContent: unknown): CompleteContentVersion {
    try {
      return validateAuthoritativeCanvasContent(rawContent).content;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("content_version_")) throw error;
      throw new Error("content_version_semantic_validation_failed");
    }
  }

  persistImmutable(input: {
    scope: CanvasScopeKey;
    content: unknown;
    createdBy: ActorRef;
    createdAt?: string;
  }): AuthoritativeContentVersion {
    const content = this.verify(input.content);
    const completed = contentRef(content);
    const createdAt = input.createdAt ?? this.clock().toISOString();
    inWriteTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          `SELECT canonical_digest,total_bytes,created_at,creator_kind,creator_id,creator_display_name
             FROM canvas_content_versions
            WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=?`
        )
        .get(
          input.scope.workspaceId,
          input.scope.projectId,
          input.scope.canvasId,
          completed.versionId
        ) as VersionRow | undefined;
      if (!existing) {
        this.database
          .prepare(
            `INSERT INTO canvas_content_versions(
              workspace_id,project_id,canvas_id,version_id,canonical_digest,total_bytes,
              created_at,creator_kind,creator_id,creator_display_name
            ) VALUES(?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            input.scope.workspaceId,
            input.scope.projectId,
            input.scope.canvasId,
            completed.versionId,
            content.canonicalDigest,
            content.totalBytes,
            createdAt,
            input.createdBy.kind,
            input.createdBy.id,
            input.createdBy.displayName ?? null
          );
        const insertMember = this.database.prepare(
          `INSERT INTO canvas_content_version_members(
             workspace_id,project_id,canvas_id,version_id,member_path,member_kind,content,digest_sha256,size_bytes
           ) VALUES(?,?,?,?,?,?,?,?,?)`
        );
        for (const member of content.members) {
          insertMember.run(
            input.scope.workspaceId,
            input.scope.projectId,
            input.scope.canvasId,
            completed.versionId,
            member.path,
            member.kind,
            member.content,
            member.digestSha256,
            member.sizeBytes
          );
        }
      } else if (
        String(existing.canonical_digest) !== content.canonicalDigest ||
        Number(existing.total_bytes) !== content.totalBytes
      ) {
        throw new Error("content_version_immutable_conflict");
      } else {
        this.readVersionInCallerTransaction(input.scope, completed);
      }
    });
    return this.readVersion(input.scope, completed);
  }

  readVersion(
    scope: CanvasScopeKey,
    content: CompletedContentVersionRef
  ): AuthoritativeContentVersion {
    return this.readVersionInCallerTransaction(scope, content);
  }

  /**
   * Opens a bounded, item-at-a-time immutable-content transfer source. The HTTP
   * adapter owns framing and backpressure; this repository never exposes paths.
   */
  openTransfer(
    scope: CanvasScopeKey,
    content: CompletedContentVersionRef
  ): { header: ContentVersionTransferHeaderFrame; members: Iterable<ContentVersionMember> } {
    const row = this.database
      .prepare(
        `SELECT canonical_digest,total_bytes,created_at,creator_kind,creator_id,creator_display_name
           FROM canvas_content_versions
          WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, content.versionId) as
      | VersionRow
      | undefined;
    if (!row || String(row.canonical_digest) !== content.canonicalDigest) {
      throw new Error("content_version_not_found");
    }
    const count = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM canvas_content_version_members
          WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, content.versionId);
    const memberCount = Number(count?.count ?? 0);
    const header: ContentVersionTransferHeaderFrame = {
      type: "header",
      schemaVersion: "content-version/v1",
      scope: canvasScopeRefSchema.parse(scope),
      completed: content,
      canonicalDigest: String(row.canonical_digest),
      totalBytes: Number(row.total_bytes),
      memberCount,
      createdAt: String(row.created_at),
      createdBy: {
        kind: row.creator_kind as ActorRef["kind"],
        id: String(row.creator_id),
        ...(row.creator_display_name === null
          ? {}
          : { displayName: String(row.creator_display_name) })
      }
    };
    return {
      header,
      members: this.transferMembers(scope, content)
    };
  }

  private *transferMembers(
    scope: CanvasScopeKey,
    content: CompletedContentVersionRef
  ): Iterable<ContentVersionMember> {
    const paths = this.database
      .prepare(
        `SELECT member_path
         FROM canvas_content_version_members
        WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=?`
      )
      .all(scope.workspaceId, scope.projectId, scope.canvasId, content.versionId)
      .map((row) => String(row.member_path))
      .sort(compareContentVersionMemberPaths);
    const readMember = this.database.prepare(
      `SELECT member_kind,member_path,content,digest_sha256,size_bytes
         FROM canvas_content_version_members
        WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=? AND member_path=?`
    );
    for (const path of paths) {
      const row = readMember.get(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        content.versionId,
        path
      );
      if (!row) throw new Error("content_version_member_missing");
      yield contentVersionMemberSchema.parse({
        kind: row.member_kind,
        path: row.member_path,
        content: row.content,
        digestSha256: row.digest_sha256,
        sizeBytes: row.size_bytes
      });
    }
  }

  private readVersionInCallerTransaction(
    scope: CanvasScopeKey,
    content: CompletedContentVersionRef
  ): AuthoritativeContentVersion {
    const row = this.database
      .prepare(
        `SELECT canonical_digest,total_bytes,created_at,creator_kind,creator_id,creator_display_name
           FROM canvas_content_versions
          WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, content.versionId) as
      | VersionRow
      | undefined;
    if (!row || String(row.canonical_digest) !== content.canonicalDigest) {
      throw new Error("content_version_not_found");
    }
    const members = [...this.transferMembers(scope, content)];
    const complete = this.verify({
      members,
      canonicalDigest: row.canonical_digest,
      totalBytes: row.total_bytes
    });
    return authoritativeContentVersionSchema.parse({
      schemaVersion: "content-version/v1",
      scope,
      content: complete,
      completed: content,
      createdAt: row.created_at,
      createdBy: {
        kind: row.creator_kind,
        id: row.creator_id,
        ...(row.creator_display_name === null ? {} : { displayName: row.creator_display_name })
      }
    });
  }

  head(scope: CanvasScopeKey): AuthoritativeContentHead | null {
    const row = this.database
      .prepare(
        `SELECT revision,version_id,canonical_digest,advanced_at FROM canvas_content_heads
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId) as VersionRow | undefined;
    if (!row || Number(row.revision) === 0) return null;
    return authoritativeContentHeadSchema.parse({
      schemaVersion: "content-version/v1",
      scope,
      revision: row.revision,
      content: {
        versionId: row.version_id,
        canonicalDigest: row.canonical_digest,
        verification: "complete"
      },
      advancedAt: row.advanced_at
    });
  }

  /** SQLite adapter operation; application services use AuthoritativeCanvasCommitPort instead. */
  advanceHeadForSqliteCommit(input: {
    scope: CanvasScopeKey;
    expectedRevision: number;
    content: CompletedContentVersionRef;
    acceptedAt?: string;
  }): AuthoritativeContentHead {
    this.readVersionInCallerTransaction(input.scope, input.content);
    const current = this.head(input.scope);
    const revision = current?.revision ?? 0;
    if (revision !== input.expectedRevision) throw new Error("content_version_head_cas_conflict");
    const acceptedAt = input.acceptedAt ?? this.clock().toISOString();
    const nextRevision = revision + 1;
    const changed = this.database
      .prepare(
        `INSERT INTO canvas_content_heads(workspace_id,project_id,canvas_id,revision,version_id,canonical_digest,advanced_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id,project_id,canvas_id) DO UPDATE SET
           revision=excluded.revision,version_id=excluded.version_id,
           canonical_digest=excluded.canonical_digest,advanced_at=excluded.advanced_at
         WHERE canvas_content_heads.revision=?`
      )
      .run(
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.canvasId,
        nextRevision,
        input.content.versionId,
        input.content.canonicalDigest,
        acceptedAt,
        revision
      );
    if (changed.changes !== 1) throw new Error("content_version_head_cas_conflict");
    this.database
      .prepare(
        `INSERT INTO canvas_content_journal(
          workspace_id,project_id,canvas_id,revision,previous_revision,version_id,canonical_digest,accepted_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.canvasId,
        nextRevision,
        revision,
        input.content.versionId,
        input.content.canonicalDigest,
        acceptedAt
      );
    return authoritativeContentHeadSchema.parse({
      schemaVersion: "content-version/v1",
      scope: input.scope,
      revision: nextRevision,
      content: input.content,
      advancedAt: acceptedAt
    });
  }

  publishInitial(input: { scope: CanvasScopeKey; content: unknown; createdBy: ActorRef }): {
    version: AuthoritativeContentVersion;
    head: AuthoritativeContentHead;
  } {
    const version = this.persistImmutable(input);
    inWriteTransaction(this.database, () => {
      this.advanceHeadForSqliteCommit({
        scope: input.scope,
        expectedRevision: 0,
        content: version.completed
      });
    });
    const head = this.head(input.scope);
    if (!head) throw new Error("content_version_head_missing");
    return { version, head };
  }

  journalAfter(scope: CanvasScopeKey, afterRevision: number) {
    const entries = this.database
      .prepare(
        `SELECT revision,previous_revision,version_id,canonical_digest,accepted_at
           FROM canvas_content_journal WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision>?
           ORDER BY revision ASC`
      )
      .all(scope.workspaceId, scope.projectId, scope.canvasId, afterRevision)
      .map((row) =>
        contentVersionJournalEntrySchema.parse({
          schemaVersion: "content-version/v1",
          scope,
          revision: row.revision,
          previousRevision: row.previous_revision,
          content: {
            versionId: row.version_id,
            canonicalDigest: row.canonical_digest,
            verification: "complete"
          },
          acceptedAt: row.accepted_at
        })
      );
    const head = this.head(scope);
    if ((head?.revision ?? 0) > afterRevision && entries.length === 0) {
      throw new Error("content_version_journal_gap");
    }
    let previousRevision = afterRevision;
    for (const entry of entries) {
      if (entry.previousRevision !== previousRevision)
        throw new Error("content_version_journal_gap");
      previousRevision = entry.revision;
    }
    if (head && previousRevision !== head.revision) throw new Error("content_version_journal_gap");
    return entries;
  }

  runInWriteTransaction<T>(action: () => T): T {
    return inWriteTransaction(this.database, action);
  }

  readWorkspacePublishOperation(operationId: string): WorkspaceCanvasPublishOperationRecord | null {
    const row = this.database
      .prepare(
        `${workspacePublishOperationSelect} FROM canvas_workspace_publish_operations WHERE operation_id=?`
      )
      .get(operationId) as VersionRow | undefined;
    return row ? this.parseWorkspacePublishOperation(row) : null;
  }

  readWorkspacePublishOperationByCanvas(
    scope: CanvasScopeKey
  ): WorkspaceCanvasPublishOperationRecord | null {
    const row = this.database
      .prepare(
        `${workspacePublishOperationSelect}
           FROM canvas_workspace_publish_operations
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId) as VersionRow | undefined;
    return row ? this.parseWorkspacePublishOperation(row) : null;
  }

  readWorkspacePublishOperationByLocalSource(
    workspaceId: string,
    projectId: string,
    localSource: WorkspaceCanvasPublishLocalSource
  ): WorkspaceCanvasPublishOperationRecord | null {
    const parsed = workspaceCanvasPublishLocalSourceSchema.parse(localSource);
    const row = this.database
      .prepare(
        `${workspacePublishOperationSelect}
           FROM canvas_workspace_publish_operations
          WHERE workspace_id=? AND project_id=? AND local_project_id=? AND local_canvas_id=?`
      )
      .get(workspaceId, projectId, parsed.localProjectId, parsed.localCanvasId) as
      | VersionRow
      | undefined;
    return row ? this.parseWorkspacePublishOperation(row) : null;
  }

  recordWorkspacePublishOperation(
    input: WorkspaceCanvasPublishedAuthority,
    localSource: WorkspaceCanvasPublishLocalSource
  ): void {
    const parsed = workspaceCanvasPublishedAuthoritySchema.parse(input);
    const source = workspaceCanvasPublishLocalSourceSchema.parse(localSource);
    this.database
      .prepare(
        `INSERT INTO canvas_workspace_publish_operations(
           operation_id,recovery_token,workspace_id,project_id,canvas_id,
           local_project_id,local_canvas_id,version_id,canonical_digest,revision,visibility,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        parsed.operationId,
        parsed.recoveryToken,
        parsed.scope.workspaceId,
        parsed.scope.projectId,
        parsed.scope.canvasId,
        source.localProjectId,
        source.localCanvasId,
        parsed.content.versionId,
        parsed.content.canonicalDigest,
        parsed.revision,
        parsed.visibility,
        this.clock().toISOString()
      );
  }

  private parseWorkspacePublishOperation(row: VersionRow): WorkspaceCanvasPublishOperationRecord {
    return {
      authority: workspaceCanvasPublishedAuthoritySchema.parse({
        operationId: row.operation_id,
        recoveryToken: row.recovery_token,
        scope: {
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          canvasId: row.canvas_id
        },
        revision: Number(row.revision),
        content: {
          versionId: row.version_id,
          canonicalDigest: row.canonical_digest,
          verification: "complete"
        },
        visibility: row.visibility
      }),
      localSource: workspaceCanvasPublishLocalSourceSchema.parse({
        localProjectId: row.local_project_id,
        localCanvasId: row.local_canvas_id
      })
    };
  }
}
