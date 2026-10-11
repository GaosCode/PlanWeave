import { readFile, rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
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

async function fixture() {
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
    delete legacy.projectCreatedAt;
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

it("replays pre-identity structured SQLite history through public undo and redo", async () => {
  const { workspace, before } = await fixture();
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
  "previous-instance"
] as const)("rejects %s legacy workspace history without changing package or undo state", async (mode) => {
  const f = await fixture();
  const altered = { ...f.legacy };
  if (mode === "partial") delete altered.kind;
  if (mode === "unregistered") altered.resultsDir = `${f.workspace.resultsDir}-different`;
  if (mode === "other-home") altered.planweaveHome = `${f.workspace.planweaveHome}-different`;
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
