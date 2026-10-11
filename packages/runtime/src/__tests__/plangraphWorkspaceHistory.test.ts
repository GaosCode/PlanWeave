import { loadProjectGraph, projectCanvasWorkspace } from "../projectGraph/index.js";
import { capturePackageSnapshot, restorePackageSnapshot } from "../package/packageSnapshot.js";
import { applyAuthorizedCanvasCommand } from "../graph/canvasCommandPort.js";
import { readFile, rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { removeTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { initWorkspace } from "../initWorkspace.js";
import { writeJsonFile } from "../json.js";
import { createSqlitePlanGraphStore } from "../plangraph/sqliteIndex.js";
import { openDatabase } from "../plangraph/sqlite/connection.js";
import {
  executePlanGraphCommand,
  undoPlanGraphCommand,
  redoPlanGraphCommand
} from "../plangraph/executeCommand.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestSchema } from "../schema/manifest.js";

const directories: string[] = [];
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
afterEach(async () => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(preProjectIdentity = true) {
  const { root, home, init } = await createTestWorkspace();
  directories.push(root, home);
  const workspace = await resolveTaskCanvasWorkspace(root, "default");
  const before = await readFile(workspace.manifestFile, "utf8");
  const result = await executePlanGraphCommand({
    projectRoot: workspace,
    command: { type: "updateTaskFields", taskId: "T-001", fields: { title: "History title" } }
  });
  expect(result.ok).toBe(true);
  if (result.operationId === undefined) throw new Error("Missing operation id.");
  const store = await createSqlitePlanGraphStore({ projectRoot: workspace });
  const db = await openDatabase(store.indexPath);
  try {
    const raw = db
      .prepare("SELECT workspace_ref_json FROM operation_log WHERE id = ?")
      .get(result.operationId)?.workspace_ref_json;
    if (typeof raw !== "string") throw new Error("Missing workspace history.");
    const legacy: unknown = JSON.parse(raw);
    if (!isRecord(legacy)) throw new Error("Expected structured workspace.");
    if (!("projectCreatedAt" in legacy)) throw new Error("Missing current identity.");
    if (preProjectIdentity) delete legacy.projectCreatedAt;
    delete legacy.packageStorageIdentity;
    db.prepare("UPDATE operation_log SET workspace_ref_json = ? WHERE id = ?").run(
      JSON.stringify(legacy),
      result.operationId
    );
    return {
      root,
      init,
      workspace,
      before,
      legacy,
      operationId: result.operationId,
      indexPath: store.indexPath
    };
  } finally {
    db.close();
  }
}

it.each([
  true,
  false
])("replays structured SQLite history predating storage identity (pre-project: %s)", async (preProjectIdentity) => {
  const { workspace, before } = await fixture(preProjectIdentity);
  await expect(undoPlanGraphCommand({ projectRoot: workspace })).resolves.toMatchObject({
    ok: true
  });
  expect(manifestSchema.parse(JSON.parse(await readFile(workspace.manifestFile, "utf8")))).toEqual(
    manifestSchema.parse(JSON.parse(before))
  );
  await expect(redoPlanGraphCommand({ projectRoot: workspace })).resolves.toMatchObject({
    ok: true
  });
  expect(await readFile(workspace.manifestFile, "utf8")).toContain("History title");
});

it.each([
  "partial",
  "unregistered",
  "other-home",
  "previous-instance",
  "previous-storage",
  "explicit-storage"
] as const)("rejects %s legacy workspace history without changing package or undo state", async (mode) => {
  const f = await fixture();
  const altered = { ...f.legacy };
  if (mode === "partial") delete altered.kind;
  if (mode === "unregistered") altered.resultsDir = `${f.workspace.resultsDir}-different`;
  if (mode === "other-home") altered.planweaveHome = `${f.workspace.planweaveHome}-different`;
  if (mode === "explicit-storage") altered.packageStorageIdentity = "directory:1:2:3";
  if (mode === "previous-storage") {
    const manifest: unknown = JSON.parse(await readFile(f.workspace.manifestFile, "utf8"));
    await removeTaskCanvas(f.root, "default");
    await writeJsonFile(f.workspace.manifestFile, manifest);
  }
  if (mode === "previous-instance") {
    const manifest: unknown = JSON.parse(await readFile(f.workspace.manifestFile, "utf8"));
    await initWorkspace({ projectRoot: f.root, resetPackage: true });
    await writeJsonFile(f.workspace.manifestFile, manifest);
  }
  const current = await resolveTaskCanvasWorkspace(f.root, "default");
  const before = await readFile(current.manifestFile, "utf8");
  const db = await openDatabase(f.indexPath);
  try {
    db.prepare("UPDATE operation_log SET workspace_ref_json = ? WHERE id = ?").run(
      JSON.stringify(altered),
      f.operationId
    );
  } finally {
    db.close();
  }
  const result = await undoPlanGraphCommand({ projectRoot: current });
  expect(result).toMatchObject({
    ok: false,
    diagnostics: [
      expect.objectContaining({
        code: "history_command_invalid",
        path: `operation_log.${f.operationId}.workspace_ref_json`
      })
    ]
  });
  expect(await readFile(current.manifestFile, "utf8")).toBe(before);
  const after = await openDatabase(f.indexPath);
  try {
    expect(
      after.prepare("SELECT undone_at FROM operation_log WHERE id = ?").get(f.operationId)
        ?.undone_at
    ).toBeNull();
  } finally {
    after.close();
  }
});

it.each([
  "layout",
  "snapshot"
] as const)("keeps task history valid after normal staged %s publication", async (kind) => {
  const f = await createTestWorkspace();
  directories.push(f.root, f.home);
  const before = await resolveTaskCanvasWorkspace(f.root, "default");
  expect(
    await executePlanGraphCommand({
      projectRoot: before,
      command: { type: "updateTaskFields", taskId: "T-001", fields: { title: "Published title" } }
    })
  ).toMatchObject({ ok: true });
  if (kind === "layout") {
    expect(
      await applyAuthorizedCanvasCommand({
        projectRoot: before,
        canvasId: "default",
        intent: {
          kind: "update_layout",
          nodes: [{ nodeId: "T-001", x: 777, y: 888 }],
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      })
    ).toMatchObject({ ok: true });
  } else {
    const captured = await capturePackageSnapshot({ projectRoot: before });
    await restorePackageSnapshot({ projectRoot: before, snapshot: captured.snapshot });
  }
  const current = await resolveTaskCanvasWorkspace(f.root, "default");
  expect(await undoPlanGraphCommand({ projectRoot: current })).toMatchObject({ ok: true });
  expect(
    manifestSchema.parse(JSON.parse(await readFile(current.manifestFile, "utf8"))).nodes[0]?.title
  ).toBe("Implement test task");
  expect(await redoPlanGraphCommand({ projectRoot: current })).toMatchObject({ ok: true });
  expect(
    manifestSchema.parse(JSON.parse(await readFile(current.manifestFile, "utf8"))).nodes[0]?.title
  ).toBe("Published title");
});

it.each([
  "execute",
  "undo",
  "redo"
] as const)("rejects an identity-free saved canvas writer at %s admission", async (action) => {
  const f = await createTestWorkspace();
  directories.push(f.root, f.home);
  const graph = await loadProjectGraph(f.root);
  const canvas = graph.manifest.canvases.find((item) => item.id === "default");
  if (!canvas) throw new Error("Missing default canvas.");
  const saved = projectCanvasWorkspace(graph.workspace, canvas);
  const replacementManifest = JSON.parse(await readFile(saved.manifestFile, "utf8"));
  await removeTaskCanvas(f.root, "default");
  await writeJsonFile(saved.manifestFile, replacementManifest);
  const current = await resolveTaskCanvasWorkspace(f.root, "default");
  expect(
    await executePlanGraphCommand({
      projectRoot: current,
      command: { type: "updateTaskFields", taskId: "T-001", fields: { title: "Valid history" } }
    })
  ).toMatchObject({ ok: true });
  if (action === "redo")
    expect(await undoPlanGraphCommand({ projectRoot: current })).toMatchObject({ ok: true });
  const before = await readFile(current.manifestFile, "utf8");
  const store = await createSqlitePlanGraphStore({ projectRoot: current });
  const db = await openDatabase(store.indexPath);
  const rows = db.prepare("SELECT id, undone_at FROM operation_log ORDER BY id").all();
  db.close();
  const operation =
    action === "execute"
      ? executePlanGraphCommand({
          projectRoot: saved,
          command: { type: "updateTaskFields", taskId: "T-001", fields: { title: "Invalid edit" } }
        })
      : action === "undo"
        ? undoPlanGraphCommand({ projectRoot: saved })
        : redoPlanGraphCommand({ projectRoot: saved });
  await expect(operation).rejects.toThrow("canvas storage identity changed");
  expect(await readFile(current.manifestFile, "utf8")).toBe(before);
  const after = await openDatabase(store.indexPath);
  try {
    expect(after.prepare("SELECT id, undone_at FROM operation_log ORDER BY id").all()).toEqual(
      rows
    );
  } finally {
    after.close();
  }
});

it.each([
  "undo",
  "redo"
] as const)("rejects historical explicit-null canvas identities during %s", async (action) => {
  const f = await createTestWorkspace();
  directories.push(f.root, f.home);
  const workspace = await resolveTaskCanvasWorkspace(f.root, "default");
  const result = await executePlanGraphCommand({
    projectRoot: workspace,
    command: { type: "updateTaskFields", taskId: "T-001", fields: { title: "Old unbound history" } }
  });
  expect(result.ok).toBe(true);
  if (action === "redo")
    expect(await undoPlanGraphCommand({ projectRoot: workspace })).toMatchObject({ ok: true });
  const store = await createSqlitePlanGraphStore({ projectRoot: workspace });
  const db = await openDatabase(store.indexPath);
  const rows = db.prepare("SELECT id, undone_at FROM operation_log ORDER BY id").all();
  db.prepare("UPDATE operation_log SET workspace_ref_json = ? WHERE id = ?").run(
    JSON.stringify({ ...workspace, packageStorageIdentity: null }),
    result.operationId
  );
  db.close();
  const before = await readFile(workspace.manifestFile, "utf8");
  await expect(
    action === "undo"
      ? undoPlanGraphCommand({ projectRoot: workspace })
      : redoPlanGraphCommand({ projectRoot: workspace })
  ).rejects.toThrow("canvas storage identity changed");
  expect(await readFile(workspace.manifestFile, "utf8")).toBe(before);
  const after = await openDatabase(store.indexPath);
  try {
    expect(after.prepare("SELECT id, undone_at FROM operation_log ORDER BY id").all()).toEqual(
      rows
    );
  } finally {
    after.close();
  }
});
