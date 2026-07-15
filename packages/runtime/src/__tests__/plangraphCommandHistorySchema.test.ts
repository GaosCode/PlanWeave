import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDesktopLayout } from "../desktop/layoutApi.js";
import { readJsonFile } from "../json.js";
import {
  createSqlitePlanGraphStore,
  defaultPlanGraphIndexPath,
  executePlanGraphCommand,
  loadPlanGraphPackage,
  parsePlanGraphCommand,
  parsePlanGraphCommandArrayOrSingle,
  redoPlanGraphCommand,
  undoPlanGraphCommand
} from "../plangraph/index.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

type SqliteRunResult = {
  lastInsertRowid: number | bigint;
};

type SqliteStatement = {
  run(...values: unknown[]): SqliteRunResult;
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Array<Record<string, unknown>>;
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteModule = {
  DatabaseSync: new (location: string) => SqliteDatabase;
};

const nodeRequire = createRequire(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadSqliteModule(): SqliteModule {
  const moduleValue: unknown = nodeRequire("node:sqlite");
  if (!isRecord(moduleValue) || typeof moduleValue.DatabaseSync !== "function") {
    throw new Error("node:sqlite module did not expose DatabaseSync.");
  }
  return moduleValue as SqliteModule;
}

function withSqlite<T>(indexPath: string, action: (db: SqliteDatabase) => T): T {
  const sqlite = loadSqliteModule();
  const db = new sqlite.DatabaseSync(indexPath);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`SQLite column '${key}' must be a string.`);
  }
  return value;
}

function sqliteIndexNames(indexPath: string): string[] {
  return withSqlite(indexPath, (db) =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((row) => stringColumn(row, "name"))
  );
}

function queryPlanDetails(indexPath: string, sql: string, ...values: unknown[]): string[] {
  return withSqlite(indexPath, (db) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...values)
      .map((row) => stringColumn(row, "detail"))
  );
}

function expectPlanUsesIndex(details: string[], indexName: string): void {
  expect(details.join("\n")).toContain(indexName);
}

function expectNoBareOperationLogScan(details: string[]): void {
  expect(details.some((detail) => detail === "SCAN operation_log")).toBe(false);
}

function setOperationLogField(
  indexPath: string,
  operationId: number,
  fieldName: "command_json" | "inverse_json" | "affected_json",
  value: unknown
): void {
  withSqlite(indexPath, (db) => {
    db.prepare(`UPDATE operation_log SET ${fieldName} = ? WHERE id = ?`).run(
      JSON.stringify(value),
      operationId
    );
  });
}

function operationUndoneAt(indexPath: string, operationId: number): string | null {
  let undoneAt: string | null = null;
  withSqlite(indexPath, (db) => {
    const row = db.prepare("SELECT undone_at FROM operation_log WHERE id = ?").get(operationId);
    const value = row?.undone_at;
    undoneAt = typeof value === "string" ? value : null;
  });
  return undoneAt;
}

describe("PlanGraph command history schema", () => {
  it("creates SQLite indexes and uses them for history and graph queries", async () => {
    const { root, init } = await createTestWorkspace(
      basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] })
    );
    const store = await createSqlitePlanGraphStore({ projectRoot: root });
    await store.rebuild();
    const indexPath = store.indexPath;
    const historyKey = init.workspace.rootPath;
    const graphKey = init.workspace.workspaceRoot;

    const firstResult = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: { title: "History index first" }
      }
    });
    const secondResult = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: { title: "History index second" }
      }
    });
    if (!firstResult.ok || !secondResult.ok) {
      throw new Error("Expected history seed commands to succeed.");
    }
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });

    const indexes = sqliteIndexNames(indexPath);
    expect(indexes).toEqual(
      expect.arrayContaining(["idx_edges_project_order", "idx_operation_log_undo_redo"])
    );
    expect(indexes).not.toContain("idx_prompt_index_project_owner");

    const undoPlan = queryPlanDetails(
      indexPath,
      "SELECT * FROM operation_log WHERE project_root = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1",
      historyKey
    );
    const redoPlan = queryPlanDetails(
      indexPath,
      "SELECT * FROM operation_log WHERE project_root = ? AND undone_at IS NOT NULL ORDER BY undone_at DESC, id ASC LIMIT 1",
      historyKey
    );
    const cleanupPlan = queryPlanDetails(
      indexPath,
      "DELETE FROM operation_log WHERE project_root = ? AND undone_at IS NOT NULL",
      historyKey
    );
    expectPlanUsesIndex(undoPlan, "idx_operation_log_undo_redo");
    expectPlanUsesIndex(redoPlan, "idx_operation_log_undo_redo");
    expectPlanUsesIndex(cleanupPlan, "idx_operation_log_undo_redo");
    expectNoBareOperationLogScan(undoPlan);
    expectNoBareOperationLogScan(redoPlan);
    expectNoBareOperationLogScan(cleanupPlan);

    expectPlanUsesIndex(
      queryPlanDetails(
        indexPath,
        "SELECT * FROM edges WHERE project_root = ? ORDER BY edge_type, from_ref, to_ref",
        graphKey
      ),
      "idx_edges_project_order"
    );
    expectPlanUsesIndex(
      queryPlanDetails(
        indexPath,
        "SELECT * FROM prompt_index WHERE project_root = ? ORDER BY owner_ref",
        graphKey
      ),
      "sqlite_autoindex_prompt_index"
    );
    expectPlanUsesIndex(
      queryPlanDetails(
        indexPath,
        "DELETE FROM prompt_index WHERE project_root = ? AND owner_ref = ?",
        graphKey,
        "T-001"
      ),
      "sqlite_autoindex_prompt_index"
    );
    expectPlanUsesIndex(
      queryPlanDetails(
        indexPath,
        "SELECT * FROM tasks WHERE project_root = ? ORDER BY task_id",
        graphKey
      ),
      "sqlite_autoindex_tasks"
    );
    expectPlanUsesIndex(
      queryPlanDetails(
        indexPath,
        "SELECT * FROM blocks WHERE project_root = ? ORDER BY block_ref",
        graphKey
      ),
      "sqlite_autoindex_blocks"
    );

    await expect(redoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.nodes[0]?.type === "task" ? manifest.nodes[0].title : null).toBe(
      "History index second"
    );
  });

  it("recreates explicit SQLite indexes when an existing database is reopened", async () => {
    const { root } = await createTestWorkspace();
    const store = await createSqlitePlanGraphStore({ projectRoot: root });
    await store.rebuild();

    withSqlite(store.indexPath, (db) => {
      db.exec("DROP INDEX idx_edges_project_order");
      db.exec("DROP INDEX idx_operation_log_undo_redo");
    });
    expect(sqliteIndexNames(store.indexPath)).not.toContain("idx_edges_project_order");
    expect(sqliteIndexNames(store.indexPath)).not.toContain("idx_operation_log_undo_redo");

    await store.load();

    expect(sqliteIndexNames(store.indexPath)).toEqual(
      expect.arrayContaining(["idx_edges_project_order", "idx_operation_log_undo_redo"])
    );
  });

  it("parses persisted command variants through the runtime command schema", () => {
    const taskSnapshot = {
      task: {
        id: "T-002",
        type: "task",
        title: "Restored task",
        prompt: "nodes/T-002/prompt.md",
        acceptance: ["Done."],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Implement",
            prompt: "nodes/T-002/blocks/B-001.prompt.md",
            depends_on: []
          }
        ]
      },
      taskPromptMarkdown: "# Task\n",
      blockPromptMarkdown: [{ blockId: "B-001", markdown: "# Block\n" }],
      insertIndex: 1,
      affectedTaskEdges: [{ from: "T-002", to: "T-001", type: "depends_on" }],
      layoutNode: { nodeId: "T-002", x: 10, y: 20 }
    };
    const blockSnapshot = {
      taskId: "T-001",
      block: {
        id: "R-002",
        type: "review",
        title: "Review",
        prompt: "nodes/T-001/blocks/R-002.prompt.md",
        depends_on: ["B-001"],
        review: { required: true, maxFeedbackCycles: 1, hook: null }
      },
      promptMarkdown: "# Review\n",
      insertIndex: 1,
      affectedDependsOn: [{ blockRef: "T-001#R-003", dependsOn: ["R-002"] }]
    };
    const commands = [
      { type: "addTaskDependency", fromTaskId: "T-002", toTaskId: "T-001", baseGraphVersion: "v1" },
      { type: "removeTaskDependency", fromTaskId: "T-002", toTaskId: "T-001" },
      {
        type: "reconnectTaskDependency",
        fromTaskId: "T-002",
        oldToTaskId: "T-001",
        newFromTaskId: "T-003",
        newToTaskId: "T-001"
      },
      {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: "# Task\n",
        basePromptHash: "hash"
      },
      {
        type: "updateBlockPrompt",
        blockRef: "T-001#B-001",
        promptMarkdown: "# Block\n",
        basePromptHash: "hash"
      },
      {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: { title: "Task", executor: null, acceptance: ["Done."], basePromptHash: "hash" }
      },
      {
        type: "updateBlockFields",
        blockRef: "T-001#R-001",
        fields: {
          title: "Review",
          executor: null,
          dependsOn: ["B-001"],
          sharedResources: ["runtime"],
          reviewRequired: true,
          maxFeedbackCycles: 2,
          reviewHook: {
            id: "review",
            type: "executable",
            command: "node",
            args: ["review.js"],
            executionPolicy: "trusted-local"
          },
          basePromptHash: "hash"
        }
      },
      { type: "addTask", snapshot: taskSnapshot },
      { type: "removeTask", taskId: "T-001", layoutNode: null },
      { type: "restoreTask", snapshot: taskSnapshot },
      { type: "addBlock", snapshot: blockSnapshot },
      { type: "removeBlock", blockRef: "T-001#B-001" },
      { type: "restoreBlock", snapshot: blockSnapshot },
      {
        type: "updateReviewPipeline",
        taskId: "T-001",
        packageDefaults: { maxFeedbackCycles: 1, completionPolicy: "strict" },
        reviewBlocks: [blockSnapshot.block],
        promptMarkdownByBlockId: [{ blockId: "R-002", markdown: "# Review\n" }]
      },
      {
        type: "updateLayout",
        layoutScope: "desktop",
        layout: {
          version: "desktop-layout/v1",
          projectId: "test-project",
          nodes: [{ nodeId: "T-001", x: 10, y: 20 }],
          updatedAt: "2026-05-23T00:00:00.000Z"
        }
      },
      { type: "updateLayout", layoutScope: "canvas", layout: { activeCanvasId: "default" } },
      { type: "addCanvasDependency", fromCanvasId: "default", toCanvasId: "second" },
      { type: "removeCanvasDependency", fromCanvasId: "default", toCanvasId: "second" },
      {
        type: "addCrossTaskDependency",
        from: { canvasId: "default", taskId: "T-001" },
        to: { canvasId: "second", taskId: "T-002" }
      },
      {
        type: "removeCrossTaskDependency",
        from: { canvasId: "default", taskId: "T-001" },
        to: { canvasId: "second", taskId: "T-002" }
      }
    ];

    expect(commands.map((command) => parsePlanGraphCommand(command).type)).toEqual(
      commands.map((command) => command.type)
    );
  });

  it("rejects polluted persisted command objects and empty inverse arrays", () => {
    expect(() =>
      parsePlanGraphCommand({
        type: "updateLayout",
        layoutScope: "desktop",
        layout: null,
        polluted: true
      })
    ).toThrow();
    expect(() => parsePlanGraphCommand({ type: "unknownCommand" })).toThrow();
    expect(() => parsePlanGraphCommandArrayOrSingle([])).toThrow();
  });

  it("strictly rejects removed block planning fields", () => {
    const removedFields = ["parallelSafe", "parallelLocks", "exclusive"];
    for (const field of removedFields) {
      expect(() =>
        parsePlanGraphCommand({
          type: "updateBlockFields",
          blockRef: "T-001#B-001",
          fields: { [field]: field === "exclusive" ? true : [] }
        })
      ).toThrow();
    }
  });

  it("rejects updateLayout commands with invalid scoped layout payloads", () => {
    expect(() =>
      parsePlanGraphCommand({ type: "updateLayout", layoutScope: "desktop", layout: { nodes: [] } })
    ).toThrow();
    expect(() =>
      parsePlanGraphCommand({ type: "updateLayout", layoutScope: "canvas", layout: { nodes: [] } })
    ).toThrow();
    expect(() =>
      parsePlanGraphCommand({
        type: "updateLayout",
        layoutScope: "canvas",
        layout: { activeCanvasId: "   " }
      })
    ).toThrow();
  });

  it("coalesces prompt autosave without parsing the latest history inverse_json", async () => {
    const { root, init } = await createTestWorkspace();
    const base = await loadPlanGraphPackage(root);
    const baseTask = base.graph.tasks.get("T-001");
    if (!baseTask) {
      throw new Error("Missing task fixture.");
    }

    const firstResult = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: "# Autosave before inverse pollution\n",
        baseGraphVersion: base.graph.graphVersion,
        basePromptHash: baseTask.promptRef.contentHash
      }
    });
    if (!firstResult.ok || firstResult.operationId === undefined) {
      throw new Error("Expected prompt operation id.");
    }
    const indexPath = defaultPlanGraphIndexPath(init.workspace);
    setOperationLogField(indexPath, firstResult.operationId, "inverse_json", {
      type: "oldVersionCommand",
      taskId: "T-001"
    });

    const afterFirst = await loadPlanGraphPackage(root);
    const afterFirstTask = afterFirst.graph.tasks.get("T-001");
    if (!afterFirstTask) {
      throw new Error("Missing task fixture.");
    }
    const secondResult = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: "# Autosave after inverse pollution\n",
        baseGraphVersion: afterFirst.graph.graphVersion,
        basePromptHash: afterFirstTask.promptRef.contentHash
      }
    });

    expect(secondResult).toMatchObject({ ok: true, operationId: firstResult.operationId });
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# Autosave after inverse pollution\n");

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });
    expect(undoResult.ok).toBe(false);
    expect(undoResult.diagnostics).toEqual([
      expect.objectContaining({
        code: "history_command_invalid",
        path: `operation_log.${firstResult.operationId}.inverse_json`
      })
    ]);
    expect(operationUndoneAt(indexPath, firstResult.operationId)).toBeNull();
  });

  it("skips prompt autosave coalescing when the latest history command_json is invalid", async () => {
    const { root, init } = await createTestWorkspace();
    const base = await loadPlanGraphPackage(root);
    const baseTask = base.graph.tasks.get("T-001");
    if (!baseTask) {
      throw new Error("Missing task fixture.");
    }

    const firstPrompt = "# Autosave before command pollution\n";
    const firstResult = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: firstPrompt,
        baseGraphVersion: base.graph.graphVersion,
        basePromptHash: baseTask.promptRef.contentHash
      }
    });
    if (!firstResult.ok || firstResult.operationId === undefined) {
      throw new Error("Expected prompt operation id.");
    }
    const indexPath = defaultPlanGraphIndexPath(init.workspace);
    setOperationLogField(indexPath, firstResult.operationId, "command_json", {
      type: "oldVersionCommand",
      taskId: "T-001"
    });

    const afterFirst = await loadPlanGraphPackage(root);
    const afterFirstTask = afterFirst.graph.tasks.get("T-001");
    if (!afterFirstTask) {
      throw new Error("Missing task fixture.");
    }
    const secondResult = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: "# Autosave after command pollution\n",
        baseGraphVersion: afterFirst.graph.graphVersion,
        basePromptHash: afterFirstTask.promptRef.contentHash
      }
    });

    expect(secondResult).toMatchObject({ ok: true });
    expect(secondResult.operationId).not.toBe(firstResult.operationId);
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# Autosave after command pollution\n");

    const undoSecondResult = await undoPlanGraphCommand({ projectRoot: root });
    expect(undoSecondResult).toMatchObject({ ok: true });
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe(firstPrompt);

    const undoPollutedResult = await undoPlanGraphCommand({ projectRoot: root });
    expect(undoPollutedResult.ok).toBe(false);
    expect(undoPollutedResult.diagnostics).toEqual([
      expect.objectContaining({
        code: "history_command_invalid",
        path: `operation_log.${firstResult.operationId}.command_json`
      })
    ]);
    expect(operationUndoneAt(indexPath, firstResult.operationId)).toBeNull();
  });

  it("skips prompt autosave coalescing when the latest history affected_json is invalid", async () => {
    const { root, init } = await createTestWorkspace();
    const base = await loadPlanGraphPackage(root);
    const baseTask = base.graph.tasks.get("T-001");
    if (!baseTask) {
      throw new Error("Missing task fixture.");
    }

    const firstPrompt = "# Autosave before affected pollution\n";
    const firstResult = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: firstPrompt,
        baseGraphVersion: base.graph.graphVersion,
        basePromptHash: baseTask.promptRef.contentHash
      }
    });
    if (!firstResult.ok || firstResult.operationId === undefined) {
      throw new Error("Expected prompt operation id.");
    }
    const indexPath = defaultPlanGraphIndexPath(init.workspace);
    setOperationLogField(indexPath, firstResult.operationId, "affected_json", []);

    const afterFirst = await loadPlanGraphPackage(root);
    const afterFirstTask = afterFirst.graph.tasks.get("T-001");
    if (!afterFirstTask) {
      throw new Error("Missing task fixture.");
    }
    const secondResult = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: "# Autosave after affected pollution\n",
        baseGraphVersion: afterFirst.graph.graphVersion,
        basePromptHash: afterFirstTask.promptRef.contentHash
      }
    });

    expect(secondResult).toMatchObject({ ok: true });
    expect(secondResult.operationId).not.toBe(firstResult.operationId);
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# Autosave after affected pollution\n");

    const undoSecondResult = await undoPlanGraphCommand({ projectRoot: root });
    expect(undoSecondResult).toMatchObject({ ok: true });
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe(firstPrompt);

    await expect(undoPlanGraphCommand({ projectRoot: root })).rejects.toThrow("affected_json");
    expect(operationUndoneAt(indexPath, firstResult.operationId)).toBeNull();
  });

  it("rejects invalid operation_log command_json before undo execution and keeps history untouched", async () => {
    const { root, init } = await createTestWorkspace();
    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: { title: "Invalid command history" }
      }
    });
    if (!result.ok || result.operationId === undefined) {
      throw new Error("Expected command operation id.");
    }
    const indexPath = defaultPlanGraphIndexPath(init.workspace);
    setOperationLogField(indexPath, result.operationId, "command_json", {
      type: "oldVersionCommand",
      taskId: "T-001"
    });

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });

    expect(undoResult.ok).toBe(false);
    expect(undoResult.diagnostics).toEqual([
      expect.objectContaining({
        code: "history_command_invalid",
        path: `operation_log.${result.operationId}.command_json`
      })
    ]);
    expect(undoResult.diagnostics[0]?.message).toContain(`operation ${result.operationId}`);
    expect(undoResult.diagnostics[0]?.message).toContain("command_json");
    expect(undoResult.diagnostics[0]?.message).not.toContain("oldVersionCommand");
    expect(operationUndoneAt(indexPath, result.operationId)).toBeNull();
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.nodes[0]?.type === "task" ? manifest.nodes[0].title : null).toBe(
      "Invalid command history"
    );
  });

  it("rejects invalid updateLayout command_json before undo execution and keeps history untouched", async () => {
    const { root, init } = await createTestWorkspace();
    const savedLayout = {
      version: "desktop-layout/v1" as const,
      projectId: init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }],
      updatedAt: "2026-05-23T00:00:00.000Z"
    };
    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: { type: "updateLayout", layoutScope: "desktop", layout: savedLayout }
    });
    if (!result.ok || result.operationId === undefined) {
      throw new Error("Expected layout operation id.");
    }
    const indexPath = defaultPlanGraphIndexPath(init.workspace);
    setOperationLogField(indexPath, result.operationId, "command_json", {
      type: "updateLayout",
      layoutScope: "desktop",
      layout: { nodes: [] }
    });

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });

    expect(undoResult.ok).toBe(false);
    expect(undoResult.diagnostics).toEqual([
      expect.objectContaining({
        code: "history_command_invalid",
        path: `operation_log.${result.operationId}.command_json`
      })
    ]);
    expect(operationUndoneAt(indexPath, result.operationId)).toBeNull();
    await expect(getDesktopLayout(root)).resolves.toMatchObject({
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }]
    });
  });

  it("rejects invalid operation_log inverse_json before undo execution and keeps history untouched", async () => {
    const { root, init } = await createTestWorkspace();
    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: { title: "Invalid inverse history" }
      }
    });
    if (!result.ok || result.operationId === undefined) {
      throw new Error("Expected command operation id.");
    }
    const indexPath = defaultPlanGraphIndexPath(init.workspace);
    setOperationLogField(indexPath, result.operationId, "inverse_json", {
      type: "oldVersionCommand",
      taskId: "T-001"
    });

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });

    expect(undoResult.ok).toBe(false);
    expect(undoResult.diagnostics).toEqual([
      expect.objectContaining({
        code: "history_command_invalid",
        path: `operation_log.${result.operationId}.inverse_json`
      })
    ]);
    expect(undoResult.diagnostics[0]?.message).toContain("inverse_json");
    expect(undoResult.diagnostics[0]?.message).not.toContain("oldVersionCommand");
    expect(operationUndoneAt(indexPath, result.operationId)).toBeNull();
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.nodes[0]?.type === "task" ? manifest.nodes[0].title : null).toBe(
      "Invalid inverse history"
    );
  });

  it("treats empty inverse_json arrays as invalid history instead of empty history", async () => {
    const { root, init } = await createTestWorkspace();
    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: { title: "Empty inverse history" }
      }
    });
    if (!result.ok || result.operationId === undefined) {
      throw new Error("Expected command operation id.");
    }
    const indexPath = defaultPlanGraphIndexPath(init.workspace);
    setOperationLogField(indexPath, result.operationId, "inverse_json", []);

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });

    expect(undoResult.ok).toBe(false);
    expect(undoResult.diagnostics).toEqual([
      expect.objectContaining({
        code: "history_command_invalid",
        path: `operation_log.${result.operationId}.inverse_json`
      })
    ]);
    expect(undoResult.diagnostics.map((item) => item.code)).not.toContain("history_empty");
    expect(operationUndoneAt(indexPath, result.operationId)).toBeNull();
  });

  it("rejects invalid operation_log command_json before redo execution and keeps history untouched", async () => {
    const { root, init } = await createTestWorkspace();
    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: { title: "Invalid redo history" }
      }
    });
    if (!result.ok || result.operationId === undefined) {
      throw new Error("Expected command operation id.");
    }
    const indexPath = defaultPlanGraphIndexPath(init.workspace);
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    setOperationLogField(indexPath, result.operationId, "command_json", {
      type: "oldVersionCommand",
      taskId: "T-001"
    });

    const redoResult = await redoPlanGraphCommand({ projectRoot: root });

    expect(redoResult.ok).toBe(false);
    expect(redoResult.diagnostics).toEqual([
      expect.objectContaining({
        code: "history_command_invalid",
        path: `operation_log.${result.operationId}.command_json`
      })
    ]);
    expect(operationUndoneAt(indexPath, result.operationId)).toEqual(expect.any(String));
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.nodes[0]?.type === "task" ? manifest.nodes[0].title : null).toBe(
      "Implement test task"
    );
  });
});
