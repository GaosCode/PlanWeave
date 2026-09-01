import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { captureAuthorizedCanvasContent, type CompleteContentVersion } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { OwnerCanvasMaterializationRepository } from "../canvas/ownerCanvasMaterializationRepository.js";
import { OwnerCanvasMaterializationService } from "../canvas/ownerCanvasMaterializationService.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const contentVersions = new ContentVersionRepository(
    database,
    () => new Date("2026-09-01T00:00:00.000Z")
  );
  const scopes = new OwnerCanvasMaterializationRepository(database);
  const scope = {
    ownerHumanPrincipalId: "owner-a",
    projectId: "project-a",
    canvasId: "default"
  };
  const activityFence = { assertScopeMaterializable: vi.fn() };
  const service = new OwnerCanvasMaterializationService({
    contentVersions,
    scopes,
    activityFence,
    clock: () => new Date("2026-09-01T00:00:00.000Z")
  });
  const capture = async (): Promise<CompleteContentVersion> =>
    (
      await captureAuthorizedCanvasContent({
        projectRoot: workspace.root,
        canvasId: "default",
        authorityProjectId: scope.projectId
      })
    ).content;
  return { database, workspace, scope, contentVersions, scopes, service, activityFence, capture };
}

describe("OwnerCanvasMaterializationService", () => {
  it("registers the owner materialization migration", async () => {
    const { database } = await fixture();
    expect(latestCentralSchemaVersion).toBe(67);
    expect(centralSchemaVersion(database)).toBe(67);
  });

  it("atomically persists content, advances the head, and reuses an identical receipt", async () => {
    const { scope, contentVersions, scopes, service, activityFence, capture } = await fixture();
    const content = await capture();
    const request = {
      schemaVersion: "owner-canvas-materialization/v1",
      materializationId: "materialization-1",
      scope,
      expectedHead: { kind: "absent" as const },
      content
    };

    const first = service.materialize(request);
    const replay = service.materialize(request);

    expect(replay).toEqual(first);
    expect(first.head.revision).toBe(1);
    expect(first.contentRevision).toMatch(/^snapshot:[a-f0-9]{64}$/);
    expect(activityFence.assertScopeMaterializable).toHaveBeenCalledOnce();
    const internalScope = scopes.findScope(scope);
    expect(internalScope).toBeDefined();
    expect(first.scope).not.toHaveProperty("workspaceId");
    expect(internalScope?.workspaceId).toMatch(/^owner-canvas-runtime:[a-f0-9]{64}$/);
    expect(
      contentVersions.head({
        workspaceId: internalScope!.workspaceId,
        projectId: internalScope!.projectId,
        canvasId: internalScope!.canvasId
      })
    ).toMatchObject({
      revision: 1,
      content: first.head.content
    });
  });

  it("validates complete content before registering a new owner scope", async () => {
    const { scope, scopes, service, capture } = await fixture();
    const content = await capture();

    expect(() =>
      service.materialize({
        schemaVersion: "owner-canvas-materialization/v1",
        materializationId: "invalid-materialization",
        scope,
        expectedHead: { kind: "absent" },
        content: { ...content, totalBytes: content.totalBytes + 1 }
      })
    ).toThrow();
    expect(scopes.findScope(scope)).toBeUndefined();
  });

  it("rejects stale heads and never records a receipt when the activity fence closes", async () => {
    const { scope, database, service, activityFence, capture } = await fixture();
    const content = await capture();
    activityFence.assertScopeMaterializable.mockImplementation(() => {
      throw new Error("owner_canvas_materialization_active_operation");
    });
    await expect(() =>
      service.materialize({
        schemaVersion: "owner-canvas-materialization/v1",
        materializationId: "blocked-materialization",
        scope,
        expectedHead: { kind: "absent" },
        content
      })
    ).toThrow("owner_canvas_materialization_active_operation");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM owner_canvas_materialization_receipts").get()
        ?.count
    ).toBe(0);

    activityFence.assertScopeMaterializable.mockReset();
    service.materialize({
      schemaVersion: "owner-canvas-materialization/v1",
      materializationId: "materialization-1",
      scope,
      expectedHead: { kind: "absent" },
      content
    });
    expect(() =>
      service.materialize({
        schemaVersion: "owner-canvas-materialization/v1",
        materializationId: "materialization-2",
        scope,
        expectedHead: { kind: "absent" },
        content
      })
    ).toThrow("owner_canvas_materialization_head_conflict");
  });

  it("conflicts when a reused id carries a different verified digest", async () => {
    const { workspace, scope, service, capture } = await fixture();
    const firstContent = await capture();
    service.materialize({
      schemaVersion: "owner-canvas-materialization/v1",
      materializationId: "materialization-1",
      scope,
      expectedHead: { kind: "absent" },
      content: firstContent
    });
    await appendFile(
      `${workspace.init.workspace.packageDir}/nodes/T-001/blocks/B-001.prompt.md`,
      "\nchanged\n",
      "utf8"
    );
    const changedContent = await capture();

    expect(() =>
      service.materialize({
        schemaVersion: "owner-canvas-materialization/v1",
        materializationId: "materialization-1",
        scope,
        expectedHead: { kind: "absent" },
        content: changedContent
      })
    ).toThrow("owner_canvas_materialization_idempotency_conflict");
  });

  it("publishes A after B with a new intent while preserving lost-response replay", async () => {
    const { workspace, scope, service, activityFence, capture } = await fixture();
    const promptPath = `${workspace.init.workspace.packageDir}/nodes/T-001/blocks/B-001.prompt.md`;
    const originalPrompt = await readFile(promptPath, "utf8");
    const contentA = await capture();
    const first = service.materialize({
      schemaVersion: "owner-canvas-materialization/v1",
      materializationId: "content-a-after-absent",
      scope,
      expectedHead: { kind: "absent" },
      content: contentA
    });
    await appendFile(promptPath, "\nchanged to B\n", "utf8");
    const contentB = await capture();
    const second = service.materialize({
      schemaVersion: "owner-canvas-materialization/v1",
      materializationId: "content-b-after-a",
      scope,
      expectedHead: { kind: "present", ...first.head },
      content: contentB
    });
    await writeFile(promptPath, originalPrompt, "utf8");
    const contentAAgain = await capture();
    const requestAAgain = {
      schemaVersion: "owner-canvas-materialization/v1" as const,
      materializationId: "content-a-after-b",
      scope,
      expectedHead: { kind: "present" as const, ...second.head },
      content: contentAAgain
    };

    const third = service.materialize(requestAAgain);
    const lostResponseReplay = service.materialize(requestAAgain);

    expect(third.head).toMatchObject({
      revision: 3,
      content: { canonicalDigest: first.head.content.canonicalDigest }
    });
    expect(third.contentRevision).toBe(first.contentRevision);
    expect(lostResponseReplay).toEqual(third);
    expect(activityFence.assertScopeMaterializable).toHaveBeenCalledTimes(3);
  });

  it("derives a distinct internal scope for a different owner principal", async () => {
    const { scope, scopes, service, capture } = await fixture();
    const content = await capture();
    const otherScope = { ...scope, ownerHumanPrincipalId: "owner-b" };
    const result = service.materialize({
      schemaVersion: "owner-canvas-materialization/v1",
      materializationId: "materialization-1",
      scope: otherScope,
      expectedHead: { kind: "absent" },
      content
    });
    expect(result.scope).toEqual(otherScope);
    expect(scopes.findScope(scope)?.workspaceId).not.toBe(
      scopes.findScope(otherScope)?.workspaceId
    );
  });
});
