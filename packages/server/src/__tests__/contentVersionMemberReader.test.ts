import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareContentVersionMemberPaths,
  contentVersionMemberSchema,
  type ContentVersionMember,
  type CompletedContentVersionRef
} from "@planweave-ai/collaboration-protocol/content/version";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const scope = { workspaceId: "w", projectId: "p", canvasId: "c" };
const completed: CompletedContentVersionRef = {
  canonicalDigest: "a".repeat(64),
  versionId: `version-${"a".repeat(64)}`,
  verification: "complete"
};
function member(path: string, content = ""): ContentVersionMember {
  return {
    kind:
      path === "manifest.json"
        ? "manifest"
        : path === "desktop/layout.json"
          ? "desktop_layout"
          : "task_prompt",
    path,
    content,
    sizeBytes: Buffer.byteLength(content),
    digestSha256: createHash("sha256").update(content).digest("hex")
  };
}
async function fixture(members: ContentVersionMember[]) {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  database.exec(`
    CREATE TABLE canvas_content_versions(workspace_id TEXT,project_id TEXT,canvas_id TEXT,version_id TEXT,
      canonical_digest TEXT,total_bytes INTEGER,created_at TEXT,creator_kind TEXT,creator_id TEXT,creator_display_name TEXT);
    CREATE TABLE canvas_content_version_members(workspace_id TEXT,project_id TEXT,canvas_id TEXT,version_id TEXT,
      member_path TEXT,member_kind TEXT,content TEXT,digest_sha256 TEXT,size_bytes INTEGER);
  `);
  database.prepare("INSERT INTO canvas_content_versions VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "w",
    "p",
    "c",
    completed.versionId,
    completed.canonicalDigest,
    members.reduce((sum, item) => sum + item.sizeBytes, 0),
    "2026-01-01T00:00:00.000Z",
    "human",
    "owner",
    null
  );
  const insert = database.prepare(
    "INSERT INTO canvas_content_version_members VALUES(?,?,?,?,?,?,?,?,?)"
  );
  for (const item of members)
    insert.run(
      "w",
      "p",
      "c",
      completed.versionId,
      item.path,
      item.kind,
      item.content,
      item.digestSha256,
      item.sizeBytes
    );
  const queries = { get: 0, all: 0, batches: [] as Array<{ count: number; bytes: number }> };
  const measured: SqliteDatabase = {
    exec: (sql) => database.exec(sql),
    close: () => database.close(),
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        run: (...values) => statement.run(...values),
        get(...values) {
          queries.get++;
          return statement.get(...values);
        },
        all(...values) {
          queries.all++;
          const rows = statement.all(...values);
          if (rows.some((row) => typeof row.content === "string")) {
            queries.batches.push({
              count: rows.length,
              bytes: rows.reduce((sum, row) => sum + Buffer.byteLength(String(row.content)), 0)
            });
          }
          return rows;
        }
      };
    }
  };
  return { database, queries, repository: new ContentVersionRepository(measured) };
}
function smallMembers(count: number) {
  return Array.from({ length: count }, (_, index) =>
    member(
      index === 0
        ? "manifest.json"
        : index === 1
          ? "desktop/layout.json"
          : `nodes/T-${index}/prompt.md`,
      index % 2 === 0 ? "中文 é" : ""
    )
  );
}

describe("bounded content version member reads with real SQLite", () => {
  it.each([
    2, 63, 64, 65, 1000
  ])("reopens %i members with batch-scale queries and canonical order", async (count) => {
    const source = smallMembers(count);
    const { repository, queries } = await fixture(source);
    const expected = source.sort((a, b) => compareContentVersionMemberPaths(a.path, b.path));
    for (let pass = 0; pass < 2; pass++) {
      const transfer = repository.openTransfer(scope, completed);
      expect(transfer.members[Symbol.iterator]).toBeTypeOf("function");
      expect([...transfer.members]).toEqual(expected);
    }
    expect(queries.get + queries.all).toBe(6 + 2 * Math.ceil(count / 64));
    expect(
      queries.batches.every((batch) => batch.count <= 64 && batch.bytes <= 1_024 * 1_024)
    ).toBe(true);
  });

  it("rejects a member count over the protocol limit without loading contents", async () => {
    const { repository, queries } = await fixture(smallMembers(4099));
    expect(() => [...repository.openTransfer(scope, completed).members]).toThrow();
    expect(queries.batches).toEqual([]);
  });

  it("uses the protocol comparator for case, digits, hyphens and underscores", async () => {
    const source = ["a", "A", "a-1", "a_1", "a10", "a2"].map((id) =>
      member(`nodes/${id}/prompt.md`)
    );
    const { repository } = await fixture(source);
    expect([...repository.openTransfer(scope, completed).members]).toEqual(
      source.sort((a, b) => compareContentVersionMemberPaths(a.path, b.path))
    );
  });

  it("budgets UTF-8 bytes and isolates one legal member exceeding 1 MiB", async () => {
    const source = [
      member("nodes/a/prompt.md", "中".repeat(200_000)),
      member("nodes/b/prompt.md", "中".repeat(200_000)),
      member("nodes/c/prompt.md", "x".repeat(1_048_577)),
      member("nodes/d/prompt.md")
    ];
    const { repository, queries } = await fixture(source);
    expect([...repository.openTransfer(scope, completed).members]).toEqual(source);
    expect(queries.batches).toEqual([
      { count: 1, bytes: 600_000 },
      { count: 1, bytes: 600_000 },
      { count: 1, bytes: 1_048_577 },
      { count: 1, bytes: 0 }
    ]);
  });

  it("rejects empty versions and metadata that lies about actual bytes before reading contents", async () => {
    const empty = await fixture([]);
    expect(() => [...empty.repository.openTransfer(scope, completed).members]).toThrow();
    const { database, repository, queries } = await fixture(smallMembers(65));
    database.exec(
      "UPDATE canvas_content_version_members SET size_bytes=0 WHERE member_path='manifest.json'"
    );
    expect(() => [...repository.openTransfer(scope, completed).members]).toThrow(
      "content_version_member_size_mismatch"
    );
    expect(queries.batches).toEqual([]);
  });

  it.each([
    "中文",
    "é",
    "😀"
  ])("rejects non-ASCII paths %s in schema and persisted metadata", async (id) => {
    const invalid = member(`nodes/${id}/prompt.md`);
    expect(() => contentVersionMemberSchema.parse(invalid)).toThrow(
      "invalid_content_version_member_path"
    );
    const { repository, queries } = await fixture([member("manifest.json"), invalid]);
    expect(() => [...repository.openTransfer(scope, completed).members]).toThrow(
      "invalid_content_version_member_path"
    );
    expect(queries.batches).toEqual([]);
  });

  it("throws on a missing later batch and permits an independent reopen after interruption", async () => {
    const source = smallMembers(65).sort((a, b) =>
      compareContentVersionMemberPaths(a.path, b.path)
    );
    const { repository, database } = await fixture(source);
    const iterator = repository.openTransfer(scope, completed).members[Symbol.iterator]();
    expect(iterator.next().value).toEqual(source[0]);
    database
      .prepare("DELETE FROM canvas_content_version_members WHERE member_path=?")
      .run(source[64]!.path);
    for (let index = 1; index < 64; index++) expect(iterator.next().done).toBe(false);
    expect(() => iterator.next()).toThrow("content_version_member_missing");
    expect([...repository.openTransfer(scope, completed).members]).toEqual(source.slice(0, 64));
  });

  it("rejects duplicate metadata and changed size between batches", async () => {
    const duplicate = await fixture([member("manifest.json"), member("manifest.json")]);
    expect(() => [...duplicate.repository.openTransfer(scope, completed).members]).toThrow(
      "duplicate_content_version_member_path"
    );
    const source = smallMembers(65).sort((a, b) =>
      compareContentVersionMemberPaths(a.path, b.path)
    );
    const { database, repository } = await fixture(source);
    const iterator = repository.openTransfer(scope, completed).members[Symbol.iterator]();
    iterator.next();
    database
      .prepare(
        "UPDATE canvas_content_version_members SET content='changed',size_bytes=7 WHERE member_path=?"
      )
      .run(source[64]!.path);
    for (let index = 1; index < 64; index++) iterator.next();
    expect(() => iterator.next()).toThrow("content_version_member_size_mismatch");
  });

  it.each([
    "workspaceId",
    "projectId",
    "canvasId"
  ] as const)("isolates %s in headers and batch reads", async (key) => {
    const source = smallMembers(65);
    const { database, repository } = await fixture(source);
    expect(() => repository.openTransfer({ ...scope, [key]: "other" }, completed)).toThrow(
      "content_version_not_found"
    );
    const column = { workspaceId: "workspace_id", projectId: "project_id", canvasId: "canvas_id" }[
      key
    ];
    database.exec(`INSERT INTO canvas_content_version_members SELECT workspace_id,project_id,canvas_id,version_id,
      member_path,member_kind,'wrong',digest_sha256,5 FROM canvas_content_version_members WHERE member_path='manifest.json'`);
    database.exec(
      `UPDATE canvas_content_version_members SET ${column}='other' WHERE content='wrong'`
    );
    expect([...repository.openTransfer(scope, completed).members]).toEqual(
      source.sort((a, b) => compareContentVersionMemberPaths(a.path, b.path))
    );
  });
});
