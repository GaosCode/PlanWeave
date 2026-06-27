import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { loadPackage } from "../package/loadPackage.js";
import { resolveProjectWorkspace } from "../project.js";
import { loadPlanGraphPackage } from "./packageRepository.js";
import {
  parsePlanGraphCommand,
  parsePlanGraphCommandArrayOrSingle,
  PlanGraphOperationLogParseError,
  planGraphCommandIssueSummary
} from "./commandSchema.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../types.js";
import type { PlanGraphAffectedRefs, PlanGraphCommand } from "./commands.js";
import type { PlanGraph, PlanGraphBlockNode, PlanGraphTaskNode, PromptRef } from "./domain/types.js";
import type { PlanGraphIndexStore, PlanGraphOperationLog, PlanGraphOperationLogEntry, PlanGraphProjectionVersion } from "./ports.js";

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

type OperationLogCoalescingEntry = {
  id: number;
  workspaceRef: PackageWorkspaceRef;
  command: PlanGraphCommand;
  affected: PlanGraphAffectedRefs;
};

const nodeRequire = createRequire(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSqliteModule(value: unknown): value is SqliteModule {
  return isRecord(value) && typeof value.DatabaseSync === "function";
}

function loadSqliteModule(): SqliteModule {
  const moduleValue: unknown = nodeRequire("node:sqlite");
  if (!isSqliteModule(moduleValue)) {
    throw new Error("node:sqlite module did not expose DatabaseSync.");
  }
  return moduleValue;
}

export function defaultPlanGraphIndexPath(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "cache", "plangraph.sqlite");
}

async function resolveIndexPath(projectRoot: PackageWorkspaceRef, indexPath?: string): Promise<{ workspace: ProjectWorkspace; indexPath: string }> {
  const { workspace } = await loadPackage(projectRoot);
  const projectWorkspace = await resolveProjectWorkspace(workspace.rootPath);
  return { workspace, indexPath: indexPath ?? defaultPlanGraphIndexPath(projectWorkspace) };
}

async function openDatabase(indexPath: string): Promise<SqliteDatabase> {
  await mkdir(dirname(indexPath), { recursive: true });
  const sqlite = loadSqliteModule();
  const db = new sqlite.DatabaseSync(indexPath);
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  return db;
}

function ensureSchema(db: SqliteDatabase): void {
  const projectionVersionsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_versions'").get();
  if (projectionVersionsTable) {
    const columns = db.prepare("PRAGMA table_info(projection_versions)").all();
    const cacheKeyColumn = columns.find((column) => isRecord(column) && column.name === "cache_key");
    const cacheKeyPrimaryKeyPosition = isRecord(cacheKeyColumn) ? cacheKeyColumn.pk : null;
    if (cacheKeyPrimaryKeyPosition !== 3) {
      db.exec("DROP TABLE projection_versions");
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_meta (
      project_root TEXT PRIMARY KEY,
      package_fingerprint TEXT NOT NULL,
      graph_version TEXT NOT NULL,
      project_json TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      project_root TEXT NOT NULL,
      task_id TEXT NOT NULL,
      canvas_id TEXT,
      title TEXT NOT NULL,
      prompt_path TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      prompt_preview TEXT NOT NULL,
      executor TEXT,
      acceptance_json TEXT NOT NULL,
      block_refs_json TEXT NOT NULL,
      PRIMARY KEY (project_root, task_id)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      project_root TEXT NOT NULL,
      block_ref TEXT NOT NULL,
      task_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt_path TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      prompt_preview TEXT NOT NULL,
      executor TEXT,
      depends_on_json TEXT NOT NULL,
      PRIMARY KEY (project_root, block_ref)
    );

    CREATE TABLE IF NOT EXISTS edges (
      project_root TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      from_ref TEXT NOT NULL,
      to_ref TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_index (
      project_root TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_ref TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      preview TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (project_root, owner_ref)
    );

    CREATE TABLE IF NOT EXISTS operation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_root TEXT NOT NULL,
      graph_version_before TEXT NOT NULL,
      graph_version_after TEXT NOT NULL,
      command_json TEXT NOT NULL,
      inverse_json TEXT NOT NULL,
      affected_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      undone_at TEXT
    );

    CREATE TABLE IF NOT EXISTS projection_versions (
      project_root TEXT NOT NULL,
      projection_name TEXT NOT NULL,
      graph_version TEXT NOT NULL,
      projection_version TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_root, projection_name, cache_key)
    );
  `);
  const operationLogColumns = db.prepare("PRAGMA table_info(operation_log)").all();
  if (!operationLogColumns.some((column) => isRecord(column) && column.name === "workspace_ref_json")) {
    db.exec("ALTER TABLE operation_log ADD COLUMN workspace_ref_json TEXT");
  }
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseJsonArray(value: string, label: string): unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed;
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`SQLite column '${key}' must be a string.`);
  }
  return value;
}

function nullableStringColumn(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`SQLite column '${key}' must be a string or null.`);
  }
  return value;
}

function numberColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`SQLite column '${key}' must be numeric.`);
}

function stringArrayColumn(row: Record<string, unknown>, key: string): string[] {
  const values = parseJsonArray(stringColumn(row, key), key);
  if (!values.every((value): value is string => typeof value === "string")) {
    throw new Error(`SQLite column '${key}' must contain a string array.`);
  }
  return values;
}

function writeGraphIndex(db: SqliteDatabase, projectRoot: string, graph: PlanGraph): void {
  const indexedAt = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM graph_meta WHERE project_root = ?").run(projectRoot);
    db.prepare("DELETE FROM tasks WHERE project_root = ?").run(projectRoot);
    db.prepare("DELETE FROM blocks WHERE project_root = ?").run(projectRoot);
    db.prepare("DELETE FROM edges WHERE project_root = ?").run(projectRoot);
    db.prepare("DELETE FROM prompt_index WHERE project_root = ?").run(projectRoot);
    db.prepare(
      `INSERT INTO graph_meta (project_root, package_fingerprint, graph_version, project_json, diagnostics_json, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(projectRoot, graph.packageFingerprint, graph.graphVersion, jsonString(graph.project), jsonString(graph.diagnostics), indexedAt);

    const insertTask = db.prepare(
      `INSERT INTO tasks
       (project_root, task_id, canvas_id, title, prompt_path, prompt_hash, prompt_preview, executor, acceptance_json, block_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const task of graph.tasks.values()) {
      insertTask.run(
        projectRoot,
        task.taskId,
        task.canvasId,
        task.title,
        task.promptRef.path,
        task.promptRef.contentHash,
        task.promptRef.preview,
        task.executor,
        jsonString(task.acceptance),
        jsonString(task.blockRefs)
      );
    }

    const insertBlock = db.prepare(
      `INSERT INTO blocks
       (project_root, block_ref, task_id, block_id, type, title, prompt_path, prompt_hash, prompt_preview, executor, depends_on_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const block of graph.blocks.values()) {
      insertBlock.run(
        projectRoot,
        block.ref,
        block.taskId,
        block.blockId,
        block.type,
        block.title,
        block.promptRef.path,
        block.promptRef.contentHash,
        block.promptRef.preview,
        block.executor,
        jsonString(block.dependsOn)
      );
    }

    const insertEdge = db.prepare("INSERT INTO edges (project_root, edge_type, from_ref, to_ref) VALUES (?, ?, ?, ?)");
    for (const edge of graph.edges) {
      if (edge.type === "taskDependsOn") {
        insertEdge.run(projectRoot, edge.type, edge.fromTaskId, edge.toTaskId);
      } else {
        insertEdge.run(projectRoot, edge.type, edge.fromBlockRef, edge.toBlockRef);
      }
    }

    const insertPrompt = db.prepare(
      `INSERT INTO prompt_index (project_root, owner_kind, owner_ref, path, content_hash, preview, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const prompt of graph.promptRefs.values()) {
      insertPrompt.run(projectRoot, prompt.ownerKind, prompt.ownerRef, prompt.path, prompt.contentHash, prompt.preview, indexedAt);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function deleteTaskRows(db: SqliteDatabase, projectRoot: string, taskId: string): void {
  db.prepare("DELETE FROM tasks WHERE project_root = ? AND task_id = ?").run(projectRoot, taskId);
  db.prepare("DELETE FROM prompt_index WHERE project_root = ? AND owner_ref = ?").run(projectRoot, taskId);
}

function deleteBlockRows(db: SqliteDatabase, projectRoot: string, blockRef: string): void {
  db.prepare("DELETE FROM blocks WHERE project_root = ? AND block_ref = ?").run(projectRoot, blockRef);
  db.prepare("DELETE FROM prompt_index WHERE project_root = ? AND owner_ref = ?").run(projectRoot, blockRef);
}

function upsertTaskRow(db: SqliteDatabase, projectRoot: string, task: PlanGraphTaskNode): void {
  db.prepare(
    `INSERT OR REPLACE INTO tasks
     (project_root, task_id, canvas_id, title, prompt_path, prompt_hash, prompt_preview, executor, acceptance_json, block_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    projectRoot,
    task.taskId,
    task.canvasId,
    task.title,
    task.promptRef.path,
    task.promptRef.contentHash,
    task.promptRef.preview,
    task.executor,
    jsonString(task.acceptance),
    jsonString(task.blockRefs)
  );
}

function upsertBlockRow(db: SqliteDatabase, projectRoot: string, block: PlanGraphBlockNode): void {
  db.prepare(
    `INSERT OR REPLACE INTO blocks
     (project_root, block_ref, task_id, block_id, type, title, prompt_path, prompt_hash, prompt_preview, executor, depends_on_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    projectRoot,
    block.ref,
    block.taskId,
    block.blockId,
    block.type,
    block.title,
    block.promptRef.path,
    block.promptRef.contentHash,
    block.promptRef.preview,
    block.executor,
    jsonString(block.dependsOn)
  );
}

function upsertPromptRow(db: SqliteDatabase, projectRoot: string, prompt: PromptRef, indexedAt: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO prompt_index (project_root, owner_kind, owner_ref, path, content_hash, preview, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(projectRoot, prompt.ownerKind, prompt.ownerRef, prompt.path, prompt.contentHash, prompt.preview, indexedAt);
}

function writeGraphMeta(db: SqliteDatabase, projectRoot: string, graph: PlanGraph, indexedAt: string): void {
  db.prepare("DELETE FROM graph_meta WHERE project_root = ?").run(projectRoot);
  db.prepare(
    `INSERT INTO graph_meta (project_root, package_fingerprint, graph_version, project_json, diagnostics_json, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(projectRoot, graph.packageFingerprint, graph.graphVersion, jsonString(graph.project), jsonString(graph.diagnostics), indexedAt);
}

function changedPromptOwnerRefs(graph: PlanGraph, paths: string[]): string[] {
  const normalized = new Set(paths.map(normalizePackagePath).filter((path): path is string => path !== null));
  return [...graph.promptRefs.values()].filter((prompt) => normalized.has(prompt.path)).map((prompt) => prompt.ownerRef);
}

function normalizePackagePath(path: string): string | null {
  const normalized = path.split("\\").join("/");
  if (normalized === "manifest.json" || normalized === "package/manifest.json") {
    return "manifest.json";
  }
  const packageNodesPrefix = "package/nodes/";
  if (normalized.startsWith(packageNodesPrefix)) {
    return normalized.slice("package/".length);
  }
  const nodesIndex = normalized.indexOf("/nodes/");
  if (nodesIndex >= 0) {
    return normalized.slice(nodesIndex + 1);
  }
  if (normalized.startsWith("nodes/")) {
    return normalized;
  }
  return null;
}

function shouldFullRebuildChangedPaths(paths: string[]): boolean {
  if (paths.length === 0) {
    return false;
  }
  return paths.some((path) => {
    const normalized = normalizePackagePath(path);
    return normalized === null || normalized === "manifest.json";
  });
}

function writeChangedPromptIndex(db: SqliteDatabase, projectRoot: string, graph: PlanGraph, paths: string[]): void {
  const ownerRefs = changedPromptOwnerRefs(graph, paths);
  const indexedAt = new Date().toISOString();
  db.exec("BEGIN");
  try {
    writeGraphMeta(db, projectRoot, graph, indexedAt);
    db.prepare("DELETE FROM edges WHERE project_root = ?").run(projectRoot);
    const insertEdge = db.prepare("INSERT INTO edges (project_root, edge_type, from_ref, to_ref) VALUES (?, ?, ?, ?)");
    for (const edge of graph.edges) {
      if (edge.type === "taskDependsOn") {
        insertEdge.run(projectRoot, edge.type, edge.fromTaskId, edge.toTaskId);
      } else {
        insertEdge.run(projectRoot, edge.type, edge.fromBlockRef, edge.toBlockRef);
      }
    }
    for (const ownerRef of ownerRefs) {
      const prompt = graph.promptRefs.get(ownerRef);
      if (!prompt) {
        continue;
      }
      upsertPromptRow(db, projectRoot, prompt, indexedAt);
      if (prompt.ownerKind === "task") {
        const task = graph.tasks.get(ownerRef);
        if (task) {
          upsertTaskRow(db, projectRoot, task);
        } else {
          deleteTaskRows(db, projectRoot, ownerRef);
        }
      } else {
        const block = graph.blocks.get(ownerRef);
        if (block) {
          upsertBlockRow(db, projectRoot, block);
        } else {
          deleteBlockRows(db, projectRoot, ownerRef);
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readGraphIndex(db: SqliteDatabase, projectRoot: string): PlanGraph | null {
  const meta = db.prepare("SELECT * FROM graph_meta WHERE project_root = ?").get(projectRoot);
  if (!meta) {
    return null;
  }

  const promptRefs = new Map<string, PromptRef>();
  for (const row of db.prepare("SELECT * FROM prompt_index WHERE project_root = ? ORDER BY owner_ref").all(projectRoot)) {
    const prompt: PromptRef = {
      ownerKind: stringColumn(row, "owner_kind") === "task" ? "task" : "block",
      ownerRef: stringColumn(row, "owner_ref"),
      path: stringColumn(row, "path"),
      contentHash: stringColumn(row, "content_hash"),
      preview: stringColumn(row, "preview")
    };
    promptRefs.set(prompt.ownerRef, prompt);
  }

  const tasks = new Map<string, PlanGraphTaskNode>();
  for (const row of db.prepare("SELECT * FROM tasks WHERE project_root = ? ORDER BY task_id").all(projectRoot)) {
    const taskId = stringColumn(row, "task_id");
    const promptRef = promptRefs.get(taskId);
    if (!promptRef) {
      throw new Error(`SQLite index missing task prompt '${taskId}'.`);
    }
    tasks.set(taskId, {
      taskId,
      canvasId: nullableStringColumn(row, "canvas_id"),
      title: stringColumn(row, "title"),
      promptRef,
      acceptance: stringArrayColumn(row, "acceptance_json"),
      executor: nullableStringColumn(row, "executor"),
      blockRefs: stringArrayColumn(row, "block_refs_json")
    });
  }

  const blocks = new Map<string, PlanGraphBlockNode>();
  for (const row of db.prepare("SELECT * FROM blocks WHERE project_root = ? ORDER BY block_ref").all(projectRoot)) {
    const ref = stringColumn(row, "block_ref");
    const promptRef = promptRefs.get(ref);
    if (!promptRef) {
      throw new Error(`SQLite index missing block prompt '${ref}'.`);
    }
    const type = stringColumn(row, "type");
    if (type !== "implementation" && type !== "review") {
      throw new Error(`SQLite index contains unsupported block type '${type}'.`);
    }
    blocks.set(ref, {
      ref,
      taskId: stringColumn(row, "task_id"),
      blockId: stringColumn(row, "block_id"),
      type,
      title: stringColumn(row, "title"),
      promptRef,
      executor: nullableStringColumn(row, "executor"),
      dependsOn: stringArrayColumn(row, "depends_on_json")
    });
  }

  const edges = db.prepare("SELECT * FROM edges WHERE project_root = ? ORDER BY edge_type, from_ref, to_ref").all(projectRoot).map((row) => {
    const type = stringColumn(row, "edge_type");
    if (type === "taskDependsOn") {
      return { type, fromTaskId: stringColumn(row, "from_ref"), toTaskId: stringColumn(row, "to_ref") } as const;
    }
    if (type === "blockDependsOn") {
      return { type, fromBlockRef: stringColumn(row, "from_ref"), toBlockRef: stringColumn(row, "to_ref") } as const;
    }
    throw new Error(`SQLite index contains unsupported edge type '${type}'.`);
  });

  return {
    graphVersion: stringColumn(meta, "graph_version"),
    packageFingerprint: stringColumn(meta, "package_fingerprint"),
    project: parseJsonRecord(stringColumn(meta, "project_json"), "project_json") as PlanGraph["project"],
    diagnostics: parseJsonArray(stringColumn(meta, "diagnostics_json"), "diagnostics_json") as PlanGraph["diagnostics"],
    tasks,
    blocks,
    edges,
    promptRefs
  };
}

function parseWorkspaceRef(value: unknown, fallbackProjectRoot: string): PackageWorkspaceRef {
  if (typeof value !== "string" || !value.trim()) {
    return fallbackProjectRoot;
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed === "string") {
    return parsed;
  }
  if (isRecord(parsed)) {
    return parsed as ProjectWorkspace;
  }
  return fallbackProjectRoot;
}

function parseAffected(value: string): PlanGraphAffectedRefs {
  return parseJsonRecord(value, "affected_json") as PlanGraphAffectedRefs;
}

function operationLogJson(row: Record<string, unknown>, fieldName: "command_json" | "inverse_json"): unknown {
  const operationId = numberColumn(row, "id");
  try {
    return JSON.parse(stringColumn(row, fieldName));
  } catch (error) {
    throw new PlanGraphOperationLogParseError({
      operationId,
      fieldName,
      issueSummary: planGraphCommandIssueSummary(error)
    });
  }
}

function operationLogCommand(row: Record<string, unknown>): PlanGraphCommand {
  const operationId = numberColumn(row, "id");
  try {
    return parsePlanGraphCommand(operationLogJson(row, "command_json"));
  } catch (error) {
    if (error instanceof PlanGraphOperationLogParseError) {
      throw error;
    }
    throw new PlanGraphOperationLogParseError({
      operationId,
      fieldName: "command_json",
      issueSummary: planGraphCommandIssueSummary(error)
    });
  }
}

function operationLogInverse(row: Record<string, unknown>): PlanGraphCommand | PlanGraphCommand[] {
  const operationId = numberColumn(row, "id");
  try {
    return parsePlanGraphCommandArrayOrSingle(operationLogJson(row, "inverse_json"));
  } catch (error) {
    if (error instanceof PlanGraphOperationLogParseError) {
      throw error;
    }
    throw new PlanGraphOperationLogParseError({
      operationId,
      fieldName: "inverse_json",
      issueSummary: planGraphCommandIssueSummary(error)
    });
  }
}

function operationLogEntry(row: Record<string, unknown>, projectRoot: string): PlanGraphOperationLogEntry {
  return {
    id: numberColumn(row, "id"),
    workspaceRef: parseWorkspaceRef(row.workspace_ref_json, projectRoot),
    graphVersionBefore: stringColumn(row, "graph_version_before"),
    graphVersionAfter: stringColumn(row, "graph_version_after"),
    command: operationLogCommand(row),
    inverse: operationLogInverse(row),
    affected: parseAffected(stringColumn(row, "affected_json")),
    createdAt: stringColumn(row, "created_at"),
    undoneAt: nullableStringColumn(row, "undone_at")
  };
}

function operationLogCoalescingEntry(row: Record<string, unknown>, projectRoot: string): OperationLogCoalescingEntry {
  return {
    id: numberColumn(row, "id"),
    workspaceRef: parseWorkspaceRef(row.workspace_ref_json, projectRoot),
    command: operationLogCommand(row),
    affected: parseAffected(stringColumn(row, "affected_json"))
  };
}

function tryOperationLogCoalescingEntry(row: Record<string, unknown>, projectRoot: string): OperationLogCoalescingEntry | null {
  try {
    return operationLogCoalescingEntry(row, projectRoot);
  } catch {
    return null;
  }
}

function promptHistoryTarget(command: PlanGraphCommand): string | null {
  if (command.type === "updateTaskPrompt") {
    return `task:${command.taskId}`;
  }
  if (command.type === "updateBlockPrompt") {
    return `block:${command.blockRef}`;
  }
  if (
    command.type === "updateTaskFields" &&
    command.fields.promptMarkdown !== undefined &&
    command.fields.title === undefined &&
    command.fields.executor === undefined &&
    command.fields.acceptance === undefined
  ) {
    return `task:${command.taskId}`;
  }
  if (
    command.type === "updateBlockFields" &&
    command.fields.promptMarkdown !== undefined &&
    command.fields.title === undefined &&
    command.fields.executor === undefined &&
    command.fields.dependsOn === undefined &&
    command.fields.parallelSafe === undefined &&
    command.fields.parallelLocks === undefined &&
    command.fields.reviewRequired === undefined &&
    command.fields.maxFeedbackCycles === undefined &&
    command.fields.reviewHook === undefined
  ) {
    return `block:${command.blockRef}`;
  }
  return null;
}

function mergeAffectedRefs(left: PlanGraphAffectedRefs, right: PlanGraphAffectedRefs): PlanGraphAffectedRefs {
  return {
    canvases: [...new Set([...left.canvases, ...right.canvases])],
    tasks: [...new Set([...left.tasks, ...right.tasks])],
    blocks: [...new Set([...left.blocks, ...right.blocks])],
    prompts: [...new Set([...left.prompts, ...right.prompts])],
    packageFiles: [...new Set([...left.packageFiles, ...right.packageFiles])]
  };
}

function sameWorkspaceRef(left: PackageWorkspaceRef, right: PackageWorkspaceRef): boolean {
  return jsonString(left) === jsonString(right);
}

function projectionVersion(row: Record<string, unknown>): PlanGraphProjectionVersion {
  return {
    projectionName: stringColumn(row, "projection_name"),
    graphVersion: stringColumn(row, "graph_version"),
    projectionVersion: stringColumn(row, "projection_version"),
    cacheKey: stringColumn(row, "cache_key"),
    updatedAt: stringColumn(row, "updated_at")
  };
}

export async function createSqlitePlanGraphStore(options: {
  projectRoot: PackageWorkspaceRef;
  indexPath?: string;
}): Promise<PlanGraphIndexStore & { log: PlanGraphOperationLog; indexPath: string }> {
  const { workspace, indexPath } = await resolveIndexPath(options.projectRoot, options.indexPath);
  const graphKey = workspace.workspaceRoot;
  const historyKey = workspace.rootPath;
  const rebuild = async (rebuildOptions: { clearHistory?: boolean } = {}): Promise<PlanGraph> => {
    const db = await openDatabase(indexPath);
    try {
      const loaded = await loadPlanGraphPackage(options.projectRoot);
      writeGraphIndex(db, graphKey, loaded.graph);
      if (rebuildOptions.clearHistory) {
        db.prepare("DELETE FROM operation_log WHERE project_root = ?").run(historyKey);
      }
      db.prepare("DELETE FROM projection_versions WHERE project_root = ?").run(graphKey);
      return loaded.graph;
    } finally {
      db.close();
    }
  };

  return {
    indexPath,
    rebuild,
    async indexChangedPaths(paths: string[], rebuildOptions: { clearHistory?: boolean } = {}) {
      if (shouldFullRebuildChangedPaths(paths)) {
        return rebuild(rebuildOptions);
      }
      const db = await openDatabase(indexPath);
      try {
        const loaded = await loadPlanGraphPackage(options.projectRoot);
        writeChangedPromptIndex(db, graphKey, loaded.graph, paths);
        if (rebuildOptions.clearHistory) {
          db.prepare("DELETE FROM operation_log WHERE project_root = ?").run(historyKey);
        }
        db.prepare("DELETE FROM projection_versions WHERE project_root = ?").run(graphKey);
        return loaded.graph;
      } finally {
        db.close();
      }
    },
    async load() {
      const db = await openDatabase(indexPath);
      try {
        return readGraphIndex(db, graphKey);
      } finally {
        db.close();
      }
    },
    async getProjectionVersion(projectionName, cacheKey) {
      const db = await openDatabase(indexPath);
      try {
        const row = db
          .prepare("SELECT * FROM projection_versions WHERE project_root = ? AND projection_name = ? AND cache_key = ?")
          .get(graphKey, projectionName, cacheKey);
        return row ? projectionVersion(row) : null;
      } finally {
        db.close();
      }
    },
    async setProjectionVersion(projection) {
      const db = await openDatabase(indexPath);
      try {
        db.prepare(
          `INSERT OR REPLACE INTO projection_versions
           (project_root, projection_name, graph_version, projection_version, cache_key, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(graphKey, projection.projectionName, projection.graphVersion, projection.projectionVersion, projection.cacheKey, projection.updatedAt);
      } finally {
        db.close();
      }
    },
    async clearProjectionVersions() {
      const db = await openDatabase(indexPath);
      try {
        db.prepare("DELETE FROM projection_versions WHERE project_root = ?").run(graphKey);
      } finally {
        db.close();
      }
    },
    log: {
      async append(entry) {
        const db = await openDatabase(indexPath);
        try {
          db.prepare("DELETE FROM operation_log WHERE project_root = ? AND undone_at IS NOT NULL").run(historyKey);
          const promptTarget = promptHistoryTarget(entry.command);
          if (promptTarget) {
            const latest = db
              .prepare("SELECT * FROM operation_log WHERE project_root = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1")
              .get(historyKey);
            if (latest) {
              const latestEntry = tryOperationLogCoalescingEntry(latest, historyKey);
              if (latestEntry && promptHistoryTarget(latestEntry.command) === promptTarget && sameWorkspaceRef(latestEntry.workspaceRef, entry.workspaceRef)) {
                db.prepare(
                  `UPDATE operation_log
                   SET graph_version_after = ?, command_json = ?, affected_json = ?
                   WHERE id = ? AND project_root = ?`
                ).run(
                  entry.graphVersionAfter,
                  jsonString(entry.command),
                  jsonString(mergeAffectedRefs(latestEntry.affected, entry.affected)),
                  latestEntry.id,
                  historyKey
                );
                return latestEntry.id;
              }
            }
          }
          const result = db
            .prepare(
              `INSERT INTO operation_log
               (project_root, workspace_ref_json, graph_version_before, graph_version_after, command_json, inverse_json, affected_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              historyKey,
              jsonString(entry.workspaceRef),
              entry.graphVersionBefore,
              entry.graphVersionAfter,
              jsonString(entry.command),
              jsonString(entry.inverse),
              jsonString(entry.affected),
              new Date().toISOString()
            );
          return Number(result.lastInsertRowid);
        } finally {
          db.close();
        }
      },
      async latestUndoable() {
        const db = await openDatabase(indexPath);
        try {
          const row = db
            .prepare("SELECT * FROM operation_log WHERE project_root = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1")
            .get(historyKey);
          return row ? operationLogEntry(row, historyKey) : null;
        } finally {
          db.close();
        }
      },
      async latestRedoable() {
        const db = await openDatabase(indexPath);
        try {
          const row = db
            .prepare("SELECT * FROM operation_log WHERE project_root = ? AND undone_at IS NOT NULL ORDER BY undone_at DESC, id ASC LIMIT 1")
            .get(historyKey);
          return row ? operationLogEntry(row, historyKey) : null;
        } finally {
          db.close();
        }
      },
      async markUndone(id) {
        const db = await openDatabase(indexPath);
        try {
          db.prepare("UPDATE operation_log SET undone_at = ? WHERE id = ? AND project_root = ?").run(new Date().toISOString(), id, historyKey);
        } finally {
          db.close();
        }
      },
      async markRedone(id) {
        const db = await openDatabase(indexPath);
        try {
          db.prepare("UPDATE operation_log SET undone_at = NULL WHERE id = ? AND project_root = ?").run(id, historyKey);
        } finally {
          db.close();
        }
      },
      async clear() {
        const db = await openDatabase(indexPath);
        try {
          db.prepare("DELETE FROM operation_log WHERE project_root = ?").run(historyKey);
        } finally {
          db.close();
        }
      }
    }
  };
}
