import { createHash } from "node:crypto";
import {
  canonicalContentVersionDigestPayload,
  compareContentVersionMemberPaths,
  type CompleteContentVersion,
  type ContentVersionMember
} from "../../../../collaboration-protocol/src/contentVersion.js";
import { ContentVersionRepository } from "../../../../server/src/canvas/contentVersionRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../../../../server/src/sqlite.js";

export const transferScope = { workspaceId: "w", projectId: "p", canvasId: "default" };
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

export function transferContent(
  taskCount: number,
  promptContent: (index: number) => string = () => "# Task\n"
): CompleteContentVersion {
  const nodes = Array.from({ length: taskCount }, (_, index) => ({
    id: `T-${index.toString().padStart(4, "0")}`,
    type: "task",
    title: "Task",
    prompt: `nodes/T-${index.toString().padStart(4, "0")}/prompt.md`,
    acceptance: ["done"],
    blocks: [
      {
        id: "B-001",
        type: "implementation",
        title: "Block",
        prompt: `nodes/T-${index.toString().padStart(4, "0")}/blocks/B-001.prompt.md`
      }
    ]
  }));
  const raw: Array<Pick<ContentVersionMember, "kind" | "path" | "content">> = [
    {
      kind: "desktop_layout",
      path: "desktop/layout.json",
      content: JSON.stringify({
        version: "desktop-layout/v1",
        projectId: "p",
        nodes: [],
        updatedAt: "2026-01-01T00:00:00.000Z"
      })
    },
    {
      kind: "manifest",
      path: "manifest.json",
      content: JSON.stringify({
        version: "plan-package/v1",
        project: { title: "Transfer", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
        executors: {},
        nodes,
        edges: []
      })
    },
    ...nodes.flatMap((node, index) => [
      { kind: "task_prompt" as const, path: node.prompt, content: promptContent(index) },
      { kind: "block_prompt" as const, path: node.blocks[0]!.prompt, content: "# Block\n" }
    ])
  ];
  const members = raw
    .map((member) => ({
      ...member,
      sizeBytes: Buffer.byteLength(member.content),
      digestSha256: digest(member.content)
    }))
    .sort((left, right) => compareContentVersionMemberPaths(left.path, right.path));
  const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  return {
    members,
    totalBytes,
    canonicalDigest: digest(
      canonicalContentVersionDigestPayload({ members, totalBytes, canonicalDigest: "0".repeat(64) })
    )
  };
}

/** Real SQLite storage focused on immutable transfer; authorization is tested by the HTTP boundary suite. */
export async function transferFixture(content: CompleteContentVersion, path = ":memory:") {
  const database = await openServerDatabase(path, 5_000);
  database.exec(`
    CREATE TABLE canvas_content_versions(workspace_id TEXT,project_id TEXT,canvas_id TEXT,version_id TEXT,
      canonical_digest TEXT,total_bytes INTEGER,created_at TEXT,creator_kind TEXT,creator_id TEXT,creator_display_name TEXT,
      PRIMARY KEY(workspace_id,project_id,canvas_id,version_id));
    CREATE TABLE canvas_content_version_members(workspace_id TEXT,project_id TEXT,canvas_id TEXT,version_id TEXT,
      member_path TEXT,member_kind TEXT,content TEXT,digest_sha256 TEXT,size_bytes INTEGER,
      PRIMARY KEY(workspace_id,project_id,canvas_id,version_id,member_path));
  `);
  const original = new ContentVersionRepository(database).persistImmutable({
    scope: transferScope,
    content,
    createdBy: { kind: "human", id: "owner" },
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  const stats = {
    queries: 0,
    batches: [] as Array<{ count: number; bytes: number }>,
    transactions: 0
  };
  const measured: SqliteDatabase = {
    close: () => database.close(),
    exec(sql) {
      stats.transactions++;
      database.exec(sql);
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        run: (...values) => statement.run(...values),
        get(...values) {
          stats.queries++;
          return statement.get(...values);
        },
        all(...values) {
          stats.queries++;
          const rows = statement.all(...values);
          if (rows.some((row) => typeof row.content === "string"))
            stats.batches.push({
              count: rows.length,
              bytes: rows.reduce((sum, row) => sum + Buffer.byteLength(String(row.content)), 0)
            });
          return rows;
        }
      };
    }
  };
  return {
    database,
    measured,
    original,
    stats,
    repository: new ContentVersionRepository(measured)
  };
}
