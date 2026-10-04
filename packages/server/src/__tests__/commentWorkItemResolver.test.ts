import * as runtime from "@planweave-ai/runtime";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import type { CanvasScopeKey } from "../canvas/repository.js";
import { createCommentWorkItemResolver } from "../composition/commentWorkItemResolver.js";
import { applyMigrations } from "../migrations.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
const clock = () => new Date("2026-10-04T00:00:00.000Z");
const databases: SqliteDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function content(title = "Plan", blocks = 1, largeCapabilities = false) {
  const capabilities = largeCapabilities
    ? Array.from({ length: 128 }, (_, i) => `cap.${String(i).padStart(3, "0")}.${"x".repeat(120)}`)
    : ["acp.codex"];
  const manifest: PlanPackageManifest = {
    version: "plan-package/v1",
    project: { title, description: "" },
    execution: { parallel: { enabled: false, maxConcurrent: 1 } },
    review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
    nodes: [
      {
        id: "T-001",
        type: "task",
        title: "Task",
        prompt: "nodes/T-001/prompt.md",
        acceptance: ["done"],
        blocks: Array.from({ length: blocks }, (_, i) => ({
          id: `B-${i + 1}`,
          type: "implementation",
          title: "Block",
          prompt: `nodes/T-001/blocks/B-${i + 1}.prompt.md`,
          depends_on: [],
          requirements: { capabilities }
        }))
      }
    ],
    edges: []
  };
  return runtime.encodeCanvasReplicaDocument({
    schemaVersion: "canvas-replica-document/v1",
    manifest,
    promptMarkdownByPath: Object.fromEntries(
      manifest.nodes.flatMap((task) => [
        [task.prompt, "# Task"],
        ...task.blocks.map((block) => [block.prompt, "# Block"])
      ])
    ),
    layout: {
      version: "desktop-layout/v1",
      projectId: "p",
      nodes: [],
      updatedAt: clock().toISOString()
    }
  });
}

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const repository = new ContentVersionRepository(database, clock);
  const publish = (target: CanvasScopeKey, value = content()) =>
    repository.publishInitial({
      scope: target,
      content: value,
      createdBy: { kind: "human", id: "owner" }
    });
  const createResolver = () =>
    createCommentWorkItemResolver({ contentVersions: repository, hasScope: () => true });
  return { database, repository, publish, createResolver };
}

const workItem = { kind: "block", canvasId: "default", blockRef: "T-001#B-1" } as const;

describe("comment immutable WorkItem resolver", () => {
  it("isolates scope, returns defensive facts, and resets at composition lifecycle", async () => {
    const f = await fixture();
    f.publish(scope);
    const otherScopes = [
      { ...scope, workspaceId: "other" },
      { ...scope, projectId: "other" },
      { ...scope, canvasId: "other" }
    ];
    for (const other of otherScopes) f.publish(other);
    const reads = vi.spyOn(f.repository, "readVersion");
    const decodes = vi.spyOn(runtime, "decodeCanvasReplicaDocument");
    const resolve = f.createResolver();
    const first = resolve(scope)!.resolveWorkItem(workItem);
    first.exists = false;
    first.requiredCapabilities.push("polluted");
    expect(resolve(scope)!.resolveWorkItems([workItem])).toEqual([
      {
        canvasId: "default",
        kind: "block",
        blockRef: "T-001#B-1",
        taskId: "T-001",
        blockType: "implementation",
        exists: true,
        requiredCapabilities: ["acp.codex"]
      }
    ]);
    for (const other of otherScopes) {
      expect(
        resolve(other)!.resolveWorkItem({ ...workItem, canvasId: other.canvasId }).exists
      ).toBe(true);
    }
    expect(reads).toHaveBeenCalledTimes(4);
    expect(decodes).toHaveBeenCalledTimes(4);
    expect(f.createResolver()(scope)!.resolveWorkItem(workItem).exists).toBe(true);
    expect(reads).toHaveBeenCalledTimes(5);
    expect(
      resolve(scope)!.resolveWorkItem({ kind: "task", canvasId: "wrong", taskId: "T-001" }).exists
    ).toBe(false);
  });

  it("reads live head and scope, rejecting changed digest without old-key fallback", async () => {
    const f = await fixture();
    f.publish(scope);
    let active = true;
    const resolve = createCommentWorkItemResolver({
      contentVersions: f.repository,
      hasScope: () => active
    });
    expect(resolve(scope)!.resolveWorkItem(workItem).exists).toBe(true);
    active = false;
    expect(resolve(scope)).toBeUndefined();
    active = true;
    f.database.prepare("UPDATE canvas_content_heads SET canonical_digest=?").run("0".repeat(64));
    expect(() => resolve(scope)).toThrow("content_version_id_must_bind_canonical_digest");
    f.database
      .prepare("UPDATE canvas_content_heads SET revision=0,version_id=NULL,canonical_digest=NULL")
      .run();
    expect(resolve(scope)).toBeUndefined();
  });

  it("does not cache a corrupted candidate and retries after durable repair", async () => {
    const f = await fixture();
    f.publish(scope);
    const resolve = f.createResolver();
    resolve(scope);
    const version = f.repository.persistImmutable({
      scope,
      content: content("Next"),
      createdBy: { kind: "human", id: "owner" }
    });
    inWriteTransaction(f.database, () =>
      f.repository.advanceHeadForSqliteCommit({
        scope,
        content: version.completed,
        expectedRevision: 1
      })
    );
    const args = [scope.workspaceId, scope.projectId, scope.canvasId, version.completed.versionId];
    const row = f.database
      .prepare(
        "SELECT content FROM canvas_content_version_members WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=? AND member_path='nodes/T-001/prompt.md'"
      )
      .get(...args)!;
    f.database
      .prepare(
        "UPDATE canvas_content_version_members SET content='! Task' WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=? AND member_path='nodes/T-001/prompt.md'"
      )
      .run(...args);
    const reads = vi.spyOn(f.repository, "readVersion");
    expect(() => resolve(scope)).toThrow("content_version_member_digest_mismatch");
    expect(() => resolve(scope)).toThrow("content_version_member_digest_mismatch");
    f.database
      .prepare(
        "UPDATE canvas_content_version_members SET content=? WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=? AND member_path='nodes/T-001/prompt.md'"
      )
      .run(row.content, ...args);
    expect(resolve(scope)!.resolveWorkItem(workItem).exists).toBe(true);
    resolve(scope);
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it("evicts the least recently used version at the shared 64-version bound", async () => {
    const f = await fixture();
    const resolve = f.createResolver();
    const scopes = Array.from({ length: 65 }, (_, i) => ({ ...scope, canvasId: `canvas-${i}` }));
    const value = content();
    for (const target of scopes) f.publish(target, value);
    const reads = vi.spyOn(f.repository, "readVersion");
    for (const target of scopes.slice(0, 64)) resolve(target);
    resolve(scopes[0]!);
    resolve(scopes[64]!);
    resolve(scopes[0]!);
    expect(reads).toHaveBeenCalledTimes(65);
    resolve(scopes[1]!);
    expect(reads).toHaveBeenCalledTimes(66);
  });

  it("bounds aggregate index weight and resolves oversized legal versions without retaining them", async () => {
    const f = await fixture();
    const medium = content("Medium", 150, true);
    const big = content("Big", 270, true);
    const second = { ...scope, canvasId: "second" };
    const oversized = { ...scope, canvasId: "big" };
    f.publish(scope, medium);
    f.publish(second, medium);
    f.publish(oversized, big);
    const reads = vi.spyOn(f.repository, "readVersion");
    const resolve = f.createResolver();
    resolve(scope);
    resolve(second);
    resolve(scope);
    expect(reads).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 2; i++) {
      expect(
        resolve(oversized)!.resolveWorkItem({ ...workItem, canvasId: "big" }).requiredCapabilities
      ).toHaveLength(128);
    }
    expect(reads).toHaveBeenCalledTimes(5);
    resolve(scope);
    expect(reads).toHaveBeenCalledTimes(5);
  });
});
