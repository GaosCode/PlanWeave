import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  canonicalContentVersionDigestPayload,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { ContentVersionService } from "../canvas/contentVersionService.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function content(updatedAt = "2026-01-01T00:00:00.000Z"): CompleteContentVersion {
  const members = [
    {
      kind: "desktop_layout" as const,
      path: "desktop/layout.json",
      content: JSON.stringify({
        version: "desktop-layout/v1",
        projectId: "p",
        nodes: [],
        updatedAt
      })
    },
    {
      kind: "manifest" as const,
      path: "manifest.json",
      content: JSON.stringify({
        version: "plan-package/v1",
        project: { title: "Plan", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
        executors: {},
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Task",
            prompt: "nodes/T-001/prompt.md",
            acceptance: ["done"],
            blocks: [
              {
                id: "B-001",
                type: "implementation",
                title: "Block",
                prompt: "nodes/T-001/blocks/B-001.prompt.md"
              }
            ]
          }
        ],
        edges: []
      })
    },
    { kind: "task_prompt" as const, path: "nodes/T-001/prompt.md", content: "# Task\n" },
    {
      kind: "block_prompt" as const,
      path: "nodes/T-001/blocks/B-001.prompt.md",
      content: "# Block\n"
    }
  ].map((member) => ({
    ...member,
    digestSha256: sha256(member.content),
    sizeBytes: Buffer.byteLength(member.content)
  }));
  const canonicalMembers = members.sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = canonicalMembers.reduce((sum, member) => sum + member.sizeBytes, 0);
  const withoutDigest = { members: canonicalMembers, totalBytes };
  return {
    ...withoutDigest,
    canonicalDigest: sha256(
      canonicalContentVersionDigestPayload({ ...withoutDigest, canonicalDigest: "0".repeat(64) })
    )
  };
}

function caseDistinctContent(): CompleteContentVersion {
  const base = content();
  const manifestMember = base.members.find((member) => member.kind === "manifest");
  if (!manifestMember) throw new Error("expected manifest member");
  const manifest = JSON.parse(manifestMember.content) as {
    nodes: Array<{
      id: string;
      prompt: string;
      blocks: Array<{ id: string; prompt: string }>;
    }>;
  };
  const template = manifest.nodes[0];
  if (!template) throw new Error("expected manifest task");
  manifest.nodes = ["a", "A"].map((id) => ({
    ...template,
    id,
    prompt: `nodes/${id}/prompt.md`,
    blocks: template.blocks.map((block) => ({
      ...block,
      prompt: `nodes/${id}/blocks/${block.id}.prompt.md`
    }))
  }));
  const members = [
    ...base.members.filter((member) => member.kind === "desktop_layout"),
    { ...manifestMember, content: JSON.stringify(manifest) },
    ...manifest.nodes.flatMap((node) => [
      { kind: "task_prompt" as const, path: node.prompt, content: `# ${node.id}\n` },
      ...node.blocks.map((block) => ({
        kind: "block_prompt" as const,
        path: block.prompt,
        content: `# ${node.id}-${block.id}\n`
      }))
    ])
  ]
    .map((member) => ({
      ...member,
      digestSha256: sha256(member.content),
      sizeBytes: Buffer.byteLength(member.content)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  return {
    members,
    totalBytes,
    canonicalDigest: sha256(
      canonicalContentVersionDigestPayload({ members, totalBytes, canonicalDigest: "0".repeat(64) })
    )
  };
}

async function fixture() {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01',NULL),('w','member','Member','2026-01-01',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01','2026-01-01',NULL),('w','m-member','member','member',1,'2026-01-01','2026-01-01',NULL);
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at)
      VALUES ('p','legacy-project:p','w','2026-01-01');
  `);
  const access = new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"));
  access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: workspace.root,
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    packageDir: workspace.init.workspace.packageDir,
    ownerHumanPrincipalId: "owner"
  });
  access.markCanvasCutover("w", "p", "default");
  access.finalizeProjectCutover("w", "p");
  access.grant({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    humanPrincipalId: "member",
    role: "editor",
    grantedBy: { kind: "human", id: "owner" }
  });
  const repository = new ContentVersionRepository(
    database,
    () => new Date("2026-01-02T00:00:00.000Z")
  );
  const service = new ContentVersionService({
    repository,
    access,
    workspaceIdentity: new WorkspaceIdentityRepository(database)
  });
  return { database, repository, service };
}

const member = {
  humanPrincipalId: "member",
  displayName: "Member",
  deviceCredentialId: "device-member",
  projectId: "p",
  role: "member" as const,
  membershipId: "m-member"
};
const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };

function publishInitial(
  repository: ContentVersionRepository,
  value: CompleteContentVersion = content()
) {
  return repository.publishInitial({
    scope,
    content: value,
    createdBy: { kind: "human", id: "owner" }
  });
}

describe("authoritative content version repository", () => {
  it("persists a verified immutable version before creating the first head", async () => {
    const { repository } = await fixture();
    expect(latestCentralSchemaVersion).toBe(62);
    const result = publishInitial(repository);
    expect(result.head.content).toEqual(result.version.completed);
    expect(
      repository.readVersion(
        { workspaceId: "w", projectId: "p", canvasId: "default" },
        result.version.completed
      ).content.members
    ).toHaveLength(4);
    expect(
      repository.journalAfter({ workspaceId: "w", projectId: "p", canvasId: "default" }, 0)
    ).toHaveLength(1);
  });

  it("retains canonical locale ordering when SQLite ordering differs", async () => {
    const { repository } = await fixture();
    const value = caseDistinctContent();
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const stored = repository.persistImmutable({
      scope,
      content: value,
      createdBy: { kind: "human", id: "owner" }
    });
    const expectedPaths = value.members.map((member) => member.path);
    expect(expectedPaths.indexOf("nodes/a/prompt.md")).toBeLessThan(
      expectedPaths.indexOf("nodes/A/prompt.md")
    );
    expect(
      repository.readVersion(scope, stored.completed).content.members.map((member) => member.path)
    ).toEqual(expectedPaths);
    expect(
      [...repository.openTransfer(scope, stored.completed).members].map((member) => member.path)
    ).toEqual(expectedPaths);
  });

  it("fails closed for malformed content and first-head races", async () => {
    const { repository } = await fixture();
    const invalid = content();
    invalid.canonicalDigest = "0".repeat(64);
    expect(() => publishInitial(repository, invalid)).toThrow(
      "content_version_canonical_digest_mismatch"
    );
    expect(repository.head(scope)).toBeNull();
    publishInitial(repository);
    expect(() => publishInitial(repository)).toThrow("content_version_head_cas_conflict");
  });

  it("rejects semantically incomplete content before creating a first head", async () => {
    const invalidCases = [
      (value: CompleteContentVersion) =>
        value.members.map((member) =>
          member.path === "manifest.json" ? { ...member, content: "{}" } : member
        ),
      (value: CompleteContentVersion) =>
        value.members.filter((member) => member.path !== "nodes/T-001/blocks/B-001.prompt.md"),
      (value: CompleteContentVersion) => [
        ...value.members,
        {
          kind: "block_prompt" as const,
          path: "nodes/T-001/blocks/B-999.prompt.md",
          content: "# Extra\n",
          digestSha256: "",
          sizeBytes: 0
        }
      ],
      (value: CompleteContentVersion) =>
        value.members.map((member) =>
          member.path === "desktop/layout.json" ? { ...member, content: "{}" } : member
        )
    ];
    for (const change of invalidCases) {
      const { repository } = await fixture();
      const members = change(content())
        .map((member) => ({
          ...member,
          digestSha256: sha256(member.content),
          sizeBytes: Buffer.byteLength(member.content)
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
      const invalid = {
        members,
        totalBytes,
        canonicalDigest: sha256(
          canonicalContentVersionDigestPayload({
            members,
            totalBytes,
            canonicalDigest: "0".repeat(64)
          })
        )
      };
      expect(() => publishInitial(repository, invalid)).toThrow(/content_version_/);
      expect(repository.head(scope)).toBeNull();
    }
  });

  it("serves only scoped authorized content and reads the Server head directly", async () => {
    const { repository, service } = await fixture();
    const initial = publishInitial(repository);
    expect(
      service.fetch(member, {
        projectId: "p",
        canvasId: "default",
        content: initial.version.completed
      }).completed
    ).toEqual(initial.version.completed);
    expect(() =>
      service.fetch(member, {
        projectId: "p",
        canvasId: "other",
        content: initial.version.completed
      })
    ).toThrow("content_fetch_forbidden");
    expect(service.readHead(member, "p", "default")).toEqual(initial.head);
    expect(() => service.readHead(member, "p", "other")).toThrow("content_head_forbidden");
  });

  it("isolates same project and canvas identifiers across workspaces for head and fetch", async () => {
    const { repository } = await fixture();
    const first = publishInitial(repository);
    const otherScope = { workspaceId: "w-other", projectId: "p", canvasId: "default" };
    expect(repository.head(otherScope)).toBeNull();
    expect(() => repository.readVersion(otherScope, first.version.completed)).toThrow(
      "content_version_not_found"
    );
  });

  it("rejects a tampered immutable member on read rather than returning mutable cache content", async () => {
    const { database, repository, service } = await fixture();
    const initial = publishInitial(repository);
    database
      .prepare(
        "UPDATE canvas_content_version_members SET content='x' || substr(content,2) WHERE version_id=? AND member_path='manifest.json'"
      )
      .run(initial.version.completed.versionId);
    expect(() =>
      service.fetch(member, {
        projectId: "p",
        canvasId: "default",
        content: initial.version.completed
      })
    ).toThrow("content_version_member_digest_mismatch");
  });

  it("fails closed when retained journal rows cannot reach the authoritative head", async () => {
    const { database, repository } = await fixture();
    publishInitial(repository);
    database
      .prepare(
        "DELETE FROM canvas_content_journal WHERE workspace_id='w' AND project_id='p' AND canvas_id='default' AND revision=1"
      )
      .run();
    expect(() =>
      repository.journalAfter({ workspaceId: "w", projectId: "p", canvasId: "default" }, 0)
    ).toThrow("content_version_journal_gap");
  });
});
