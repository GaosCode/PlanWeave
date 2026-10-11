import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createProjectCanvas,
  loadProjectGraph,
  projectCanvasWorkspace
} from "../projectGraph/index.js";
import { capturePackageSnapshot, restorePackageSnapshot } from "../package/packageSnapshot.js";
import { applyAuthorizedCanvasCommand } from "../graph/canvasCommandPort.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

it.each([
  "null",
  "empty",
  "string"
] as const)("validates %s legacy root history against its original canvas generation", async (format) => {
  const f = await createTestWorkspace();
  directories.push(f.root, f.home);
  await removeTaskCanvas(f.root, "default");
  const { getDesktopLayoutDirect } = await import("../desktop/layoutStore.js");
  const original = await resolveTaskCanvasWorkspace(f.root, "default");
  const edited = await executePlanGraphCommand({
    projectRoot: original,
    command: {
      type: "updateLayout",
      layoutScope: "desktop",
      layout: {
        version: "desktop-layout/v1",
        projectId: original.id,
        nodes: [],
        updatedAt: "2024-01-01T00:00:00.000Z"
      }
    }
  });
  if (!edited.ok) throw new Error(JSON.stringify(edited.diagnostics));
  expect(edited.ok).toBe(true);
  const store = await createSqlitePlanGraphStore({ projectRoot: original });
  const db = await openDatabase(store.indexPath);
  db.prepare("UPDATE operation_log SET workspace_ref_json = ? WHERE id = ?").run(
    format === "null" ? null : format === "empty" ? "" : JSON.stringify(original.rootPath),
    edited.operationId
  );
  db.close();
  expect(await undoPlanGraphCommand({ projectRoot: original })).toMatchObject({ ok: true });
  expect(await redoPlanGraphCommand({ projectRoot: original })).toMatchObject({ ok: true });
  await removeTaskCanvas(f.root, "default");
  const current = await resolveTaskCanvasWorkspace(f.root, "default");
  const before = await getDesktopLayoutDirect(current);
  const result = await undoPlanGraphCommand({ projectRoot: current });
  expect(result).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: "history_command_invalid" })]
  });
  expect(await getDesktopLayoutDirect(current)).toEqual(before);
  const after = await openDatabase(store.indexPath);
  try {
    expect(
      after.prepare("SELECT undone_at FROM operation_log WHERE id = ?").get(edited.operationId)
        ?.undone_at
    ).toBeNull();
  } finally {
    after.close();
  }
});

it.each([
  "execute",
  "undo",
  "redo"
] as const)("keeps captured project %s and SQLite history in Home A while Home B is active", async (action) => {
  const f = {
    root: await mkdtemp(join(tmpdir(), "planweave-project-history-source-")),
    home: await mkdtemp(join(tmpdir(), "planweave-project-history-home-A-"))
  };
  process.env.PLANWEAVE_HOME = f.home;
  process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(f.home, "settings.json");
  await initWorkspace({ projectRoot: f.root, projectGraph: true });
  directories.push(f.root, f.home);
  await createProjectCanvas({ projectRoot: f.root, requestedId: "peer", title: "Peer" });
  const a = await resolveTaskCanvasWorkspace(f.root, "default");
  const command = {
    type: "addCanvasDependency" as const,
    fromCanvasId: "default",
    toCanvasId: "peer"
  };
  if (action !== "execute")
    expect(await executePlanGraphCommand({ projectRoot: a, command })).toMatchObject({ ok: true });
  if (action === "redo")
    expect(await undoPlanGraphCommand({ projectRoot: a })).toMatchObject({ ok: true });
  const homeB = await mkdtemp(join(tmpdir(), "planweave-project-history-home-B-"));
  directories.push(homeB);
  process.env.PLANWEAVE_HOME = homeB;
  await initWorkspace({ projectRoot: f.root, projectGraph: true });
  await createProjectCanvas({ projectRoot: f.root, requestedId: "peer", title: "Peer" });
  const b = await resolveTaskCanvasWorkspace(f.root, "default");
  if (action !== "execute")
    expect(await executePlanGraphCommand({ projectRoot: b, command })).toMatchObject({ ok: true });
  if (action === "redo")
    expect(await undoPlanGraphCommand({ projectRoot: b })).toMatchObject({ ok: true });
  const aGraph = join(a.planweaveHome, "projects", a.id, "project-graph.json");
  const bGraph = join(b.planweaveHome, "projects", b.id, "project-graph.json");
  const beforeA = await readFile(aGraph, "utf8"),
    beforeB = await readFile(bGraph, "utf8");
  const bStore = await createSqlitePlanGraphStore({ projectRoot: b });
  await bStore.log.latestUndoable();
  const beforeDb = await openDatabase(bStore.indexPath);
  const beforeRows = beforeDb.prepare("SELECT * FROM operation_log ORDER BY id").all();
  beforeDb.close();
  const result =
    action === "execute"
      ? await executePlanGraphCommand({ projectRoot: a, command })
      : action === "undo"
        ? await undoPlanGraphCommand({ projectRoot: a })
        : await redoPlanGraphCommand({ projectRoot: a });
  expect(result).toMatchObject({ ok: true });
  expect(await readFile(aGraph, "utf8")).not.toBe(beforeA);
  expect(await readFile(bGraph, "utf8")).toBe(beforeB);
  const afterDb = await openDatabase(bStore.indexPath);
  try {
    expect(afterDb.prepare("SELECT * FROM operation_log ORDER BY id").all()).toEqual(beforeRows);
  } finally {
    afterDb.close();
  }
  const aStore = await createSqlitePlanGraphStore({ projectRoot: a });
  const aDb = await openDatabase(aStore.indexPath);
  try {
    const row = aDb.prepare("SELECT undone_at FROM operation_log ORDER BY id DESC LIMIT 1").get();
    expect(row).toBeDefined();
    if (action === "undo") expect(row?.undone_at).not.toBeNull();
    else expect(row?.undone_at).toBeNull();
  } finally {
    aDb.close();
  }
});
