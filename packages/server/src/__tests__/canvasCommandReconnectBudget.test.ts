import { describe, expect, it } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canonicalContentVersionDigestPayload,
  type CompletedContentVersionRef,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  applyCanvasReplicaIntent,
  decodeCanvasReplicaDocument,
  encodeCanvasReplicaDocument
} from "@planweave-ai/runtime";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { CanvasCommandService } from "../canvas/service.js";
import {
  CanvasCommandRepository,
  digestCanvasIntent,
  type CanvasScopeKey
} from "../canvas/repository.js";
import { SqliteAuthoritativeCanvasCommitStore } from "../canvas/sqliteAuthoritativeCanvasCommitStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  actor,
  canvasCommandServiceFixture,
  digestOf,
  submitBody
} from "./support/canvasCommandServiceFixture.js";

const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
const request = (afterRevision = 0, afterContentDigest?: string) => ({
  type: "canvas.reconnect.request" as const,
  protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
  schemaVersion: "canvas-command/v1" as const,
  projectId: "p",
  canvasId: "default",
  afterRevision,
  ...(afterContentDigest === undefined ? {} : { afterContentDigest })
});

/** Counts the real repository boundary; semantic verification remains production code. */
class MeasuredContentVersions extends ContentVersionRepository {
  reads = 0;
  validations = 0;
  afterRead: (() => void) | undefined;
  beforeHead: (() => void) | undefined;

  override verify(content: unknown): CompleteContentVersion {
    this.validations += 1;
    return super.verify(content);
  }

  override readVersion(scope: CanvasScopeKey, content: CompletedContentVersionRef) {
    this.reads += 1;
    const version = super.readVersion(scope, content);
    this.afterRead?.();
    return version;
  }

  override head(scope: CanvasScopeKey) {
    this.beforeHead?.();
    return super.head(scope);
  }
}

class InterleavedCommandRepository extends CanvasCommandRepository {
  beforeJournal: (() => void) | undefined;

  override listJournalAfter(scope: CanvasScopeKey, afterRevision: number) {
    this.beforeJournal?.();
    return super.listJournalAfter(scope, afterRevision);
  }
}

async function fixture(revisions = 0) {
  const base = await canvasCommandServiceFixture({ journalRetention: 10 });
  for (let revision = 0; revision < revisions; revision += 1) {
    expect(
      await base.service.submit(
        actor("owner"),
        submitBody(`op-${revision}`, revision, {
          kind: "update_task_prompt",
          taskId: "T-001",
          promptMarkdown: `# revision ${revision + 1}`
        })
      )
    ).toMatchObject({ type: "canvas.command.accepted", revision: revision + 1 });
  }
  const measured = new MeasuredContentVersions(base.database);
  const repository = new InterleavedCommandRepository(base.database, { maxJournalEntries: 10 });
  const service = new CanvasCommandService({
    repository,
    access: base.access,
    workspaceIdentity: new WorkspaceIdentityRepository(base.database),
    contentVersions: measured
  });
  return { ...base, repository, service, measured };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function expectSnapshot(
  response: Awaited<ReturnType<CanvasCommandService["reconnect"]>>,
  f: Fixture
) {
  const commandHead = f.repository.head(scope);
  const contentHead = f.contentVersions.head(scope)!;
  expect(response).toMatchObject({
    type: "canvas.reconnect.snapshot",
    scope,
    snapshot: {
      metadata: { scope, revision: commandHead.revision, contentDigest: commandHead.contentDigest },
      encoding: "content_version_ref",
      content: contentHead.content
    }
  });
  expect(commandHead.contentDigest).toBe(contentHead.content.canonicalDigest);
}

function prepareCommit(f: Fixture, sequence: number, changeContent = true) {
  const current = f.contentVersions.head(scope)!;
  const version = f.contentVersions.readVersion(scope, current.content);
  const intent = {
    kind: "update_task_prompt" as const,
    taskId: "T-001",
    promptMarkdown: `# concurrent ${sequence}`
  };
  const next = changeContent
    ? f.contentVersions.persistImmutable({
        scope,
        content: encodeCanvasReplicaDocument(
          applyCanvasReplicaIntent(decodeCanvasReplicaDocument(version.content), intent)
        ),
        createdBy: { kind: "human", id: "owner" }
      })
    : version;
  const commits = new SqliteAuthoritativeCanvasCommitStore(
    f.database,
    f.contentVersions,
    f.repository
  );
  return () => {
    const head = f.repository.head(scope);
    commits.commit({
      content: {
        scope,
        expectedRevision: f.contentVersions.head(scope)!.revision,
        version: next.completed
      },
      accepted: {
        scope,
        operationId: `concurrent-${sequence}`,
        intent,
        intentDigest: digestCanvasIntent(intent),
        actor: { kind: "human", id: "owner" },
        previousRevision: head.revision,
        revision: head.revision + 1,
        expectedContentDigest: head.contentDigest,
        contentDigest: next.completed.canonicalDigest,
        sizeBytes: next.content.totalBytes
      }
    });
  };
}

describe("canvas reconnect request-local verification", () => {
  it.each([
    { name: "fresh_session", after: 0, digest: undefined, remove: "none" },
    { name: "revision_ahead", after: 99, digest: undefined, remove: "none" },
    { name: "digest_mismatch", after: 1, digest: "f".repeat(64), remove: "none" },
    { name: "truncated_journal", after: 1, digest: undefined, remove: "middle" },
    { name: "retention_gap", after: 1, digest: undefined, remove: "all" }
  ])("reads and validates once per request for $name", async ({ name, after, digest, remove }) => {
    const f = await fixture(3);
    if (remove === "middle") {
      f.database.prepare("DELETE FROM canvas_command_journal WHERE revision=2").run();
    } else if (remove === "all") {
      f.database.prepare("DELETE FROM canvas_command_journal").run();
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await f.service.reconnect(actor("editor"), request(after, digest));
      expect(response).toMatchObject({ type: "canvas.reconnect.snapshot", reason: name });
      expectSnapshot(response, f);
      expect(f.measured.reads).toBe(attempt);
      expect(f.measured.validations).toBe(attempt);
    }
  });

  it.each([1, 3])("retains coherent delta semantics from cursor %i", async (after) => {
    const f = await fixture(3);
    const response = await f.service.reconnect(actor("editor"), request(after));
    expect(response).toMatchObject({
      type: "canvas.reconnect.delta",
      scope,
      afterRevision: after,
      headRevision: 3,
      headContentDigest: f.repository.head(scope).contentDigest
    });
    if (response.type !== "canvas.reconnect.delta") throw new Error("expected delta");
    expect(response.entries.map((entry) => entry.revision)).toEqual(after === 1 ? [2, 3] : []);
    expect(f.measured.reads).toBe(1);
    expect(f.measured.validations).toBe(1);
  });

  it("initializes revision zero without confusing content and journal revisions", async () => {
    const f = await fixture();
    const response = await f.service.reconnect(actor("editor"), request());
    expectSnapshot(response, f);
    expect(f.repository.head(scope).revision).toBe(0);
    expect(f.contentVersions.head(scope)!.revision).toBe(1);
    expect(f.measured.reads).toBe(1);
    expect(f.measured.validations).toBe(1);
  });

  it("reuses the verified legacy replacement only within its rebuilding request", async () => {
    const f = await fixture(1);
    const head = f.repository.head(scope);
    f.database
      .prepare(`INSERT INTO canvas_command_baseline_rebases(
      workspace_id,project_id,canvas_id,source_revision,source_content_digest,status,reason,detected_at
    ) VALUES('w','p','default',?,?,'pending','legacy_nondeterministic_layout','2026-01-01')`)
      .run(head.revision, head.contentDigest);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expectSnapshot(await f.service.reconnect(actor("editor"), request()), f);
      expect(f.measured.reads).toBe(attempt);
      expect(f.measured.validations).toBe(attempt);
    }
    expect(f.repository.legacyBaselineRebase(scope)?.status).toBe("completed");
  });

  it.each([
    "missing",
    "corrupt",
    "schema"
  ])("revalidates and rejects a later %s member", async (kind) => {
    const f = await fixture(1);
    expectSnapshot(await f.service.reconnect(actor("editor"), request()), f);
    const head = f.contentVersions.head(scope)!;
    if (kind === "missing") {
      f.database
        .prepare(
          "DELETE FROM canvas_content_version_members WHERE version_id=? AND member_path='manifest.json'"
        )
        .run(head.content.versionId);
    } else if (kind === "corrupt") {
      f.database
        .prepare(
          "UPDATE canvas_content_version_members SET content='broken' WHERE version_id=? AND member_path='manifest.json'"
        )
        .run(head.content.versionId);
    } else {
      const version = f.contentVersions.readVersion(scope, head.content);
      const members = version.content.members.map((member) =>
        member.path === "manifest.json"
          ? { ...member, content: "{}", digestSha256: digestOf("{}"), sizeBytes: 2 }
          : member
      );
      const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
      const canonicalDigest = digestOf(
        canonicalContentVersionDigestPayload({
          members,
          totalBytes,
          canonicalDigest: "0".repeat(64)
        })
      );
      const versionId = `version-${canonicalDigest}`;
      f.database
        .prepare(`INSERT INTO canvas_content_versions(
        workspace_id,project_id,canvas_id,version_id,canonical_digest,total_bytes,
        created_at,creator_kind,creator_id,creator_display_name
      ) SELECT workspace_id,project_id,canvas_id,?,?,?,created_at,creator_kind,creator_id,creator_display_name
        FROM canvas_content_versions WHERE version_id=?`)
        .run(versionId, canonicalDigest, totalBytes, head.content.versionId);
      f.database
        .prepare(`INSERT INTO canvas_content_version_members(
        workspace_id,project_id,canvas_id,version_id,member_path,member_kind,content,digest_sha256,size_bytes
      ) SELECT workspace_id,project_id,canvas_id,?,member_path,member_kind,
          CASE WHEN member_path='manifest.json' THEN '{}' ELSE content END,
          CASE WHEN member_path='manifest.json' THEN ? ELSE digest_sha256 END,
          CASE WHEN member_path='manifest.json' THEN 2 ELSE size_bytes END
        FROM canvas_content_version_members WHERE version_id=?`)
        .run(versionId, digestOf("{}"), head.content.versionId);
      f.database
        .prepare("UPDATE canvas_content_heads SET version_id=?,canonical_digest=?")
        .run(versionId, canonicalDigest);
      f.database.prepare("UPDATE canvas_command_heads SET content_digest=?").run(canonicalDigest);
    }
    const response = await f.service.reconnect(actor("editor"), request());
    expect(response).toMatchObject({ type: "canvas.reconnect.error", code: "snapshot_malformed" });
    if (kind === "schema")
      expect(response).toMatchObject({ detail: "content_version_semantic_validation_failed" });
    expect(f.measured.reads).toBe(2);
    expect(f.measured.validations).toBe(kind === "corrupt" ? 1 : 2);
  });

  it("fails a stable head/content mismatch and denies revoked access before reading", async () => {
    const f = await fixture(1);
    f.database.prepare("UPDATE canvas_command_heads SET content_digest=?").run("f".repeat(64));
    expect(await f.service.reconnect(actor("editor"), request())).toMatchObject({
      type: "canvas.reconnect.error",
      code: "snapshot_malformed",
      detail: "canvas_content_head_mismatch"
    });
    expect(f.measured.reads).toBe(1);
    f.database
      .prepare(
        "UPDATE project_access_grants SET revoked_at='2026-10-01' WHERE human_principal_id='editor'"
      )
      .run();
    expect(await f.service.reconnect(actor("editor"), request())).toMatchObject({
      type: "canvas.reconnect.error",
      code: "unknown_canvas"
    });
    expect(f.measured.reads).toBe(1);
  });

  it.each(["during_read", "before_publish"])("recaptures one real commit %s", async (phase) => {
    const f = await fixture(1);
    const commit = prepareCommit(f, 1);
    let committed = false;
    const advance = () => {
      if (committed) return;
      committed = true;
      commit();
    };
    if (phase === "during_read") f.measured.afterRead = advance;
    else {
      let heads = 0;
      f.measured.beforeHead = () => {
        heads += 1;
        if (heads === 2) advance();
      };
    }
    const response = await f.service.reconnect(actor("editor"), request());
    expectSnapshot(response, f);
    expect(f.repository.head(scope).revision).toBe(2);
    expect(f.measured.reads).toBe(2);
    expect(f.measured.validations).toBe(2);
  });

  it("recaptures a delta when a real commit advances the journal after head capture", async () => {
    const f = await fixture(2);
    const commit = prepareCommit(f, 1);
    f.repository.beforeJournal = () => {
      f.repository.beforeJournal = undefined;
      commit();
    };
    const response = await f.service.reconnect(actor("editor"), request(1));
    expect(response).toMatchObject({
      type: "canvas.reconnect.delta",
      headRevision: 3,
      headContentDigest: f.repository.head(scope).contentDigest
    });
    if (response.type !== "canvas.reconnect.delta") throw new Error("expected delta");
    expect(response.entries.map((entry) => entry.revision)).toEqual([2, 3]);
    expect(f.measured.reads).toBe(2);
    expect(f.measured.validations).toBe(2);
  });

  it("detects a content-head revision advance even when version and digest stay equal", async () => {
    const f = await fixture(1);
    let heads = 0;
    f.measured.beforeHead = () => {
      heads += 1;
      if (heads !== 2) return;
      const current = f.contentVersions.head(scope)!;
      f.contentVersions.advanceHeadForSqliteCommit({
        scope,
        expectedRevision: current.revision,
        content: current.content
      });
    };
    expectSnapshot(await f.service.reconnect(actor("editor"), request()), f);
    expect(f.measured.reads).toBe(2);
    expect(f.measured.validations).toBe(2);
  });

  it("returns the existing malformed-snapshot protocol when a head becomes corrupt before publication", async () => {
    const f = await fixture(1);
    let heads = 0;
    f.measured.beforeHead = () => {
      heads += 1;
      if (heads === 2) {
        f.database
          .prepare("UPDATE canvas_content_heads SET canonical_digest=?")
          .run("f".repeat(64));
      }
    };
    await expect(f.service.reconnect(actor("editor"), request())).resolves.toMatchObject({
      type: "canvas.reconnect.error",
      code: "snapshot_malformed"
    });
    expect(f.measured.reads).toBe(1);
    expect(f.measured.validations).toBe(1);
  });

  it("fails explicitly after a second changing capture instead of returning mixed versions", async () => {
    const f = await fixture(1);
    const first = prepareCommit(f, 1);
    const second = prepareCommit(f, 2);
    const commits = [first, second];
    f.measured.afterRead = () => commits.shift()?.();
    expect(await f.service.reconnect(actor("editor"), request())).toMatchObject({
      type: "canvas.reconnect.error",
      code: "snapshot_malformed",
      detail: "content_authority_head_changed"
    });
    expect(f.measured.reads).toBe(2);
    expect(f.measured.validations).toBe(2);
    expect(f.repository.head(scope).revision).toBe(3);
  });
});
