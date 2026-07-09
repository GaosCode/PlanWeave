import type {
  PlanGraph,
  PlanGraphBlockNode,
  PlanGraphTaskNode,
  PromptRef
} from "../domain/types.js";
import {
  jsonString,
  nullableStringColumn,
  parseJsonArray,
  parseJsonRecord,
  stringArrayColumn,
  stringColumn
} from "./columns.js";
import type { SqliteDatabase } from "./connection.js";

export function writeGraphIndex(db: SqliteDatabase, projectRoot: string, graph: PlanGraph): void {
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
    ).run(
      projectRoot,
      graph.packageFingerprint,
      graph.graphVersion,
      jsonString(graph.project),
      jsonString(graph.diagnostics),
      indexedAt
    );

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

    const insertEdge = db.prepare(
      "INSERT INTO edges (project_root, edge_type, from_ref, to_ref) VALUES (?, ?, ?, ?)"
    );
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
      insertPrompt.run(
        projectRoot,
        prompt.ownerKind,
        prompt.ownerRef,
        prompt.path,
        prompt.contentHash,
        prompt.preview,
        indexedAt
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function deleteTaskRows(db: SqliteDatabase, projectRoot: string, taskId: string): void {
  db.prepare("DELETE FROM tasks WHERE project_root = ? AND task_id = ?").run(projectRoot, taskId);
  db.prepare("DELETE FROM prompt_index WHERE project_root = ? AND owner_ref = ?").run(
    projectRoot,
    taskId
  );
}

function deleteBlockRows(db: SqliteDatabase, projectRoot: string, blockRef: string): void {
  db.prepare("DELETE FROM blocks WHERE project_root = ? AND block_ref = ?").run(
    projectRoot,
    blockRef
  );
  db.prepare("DELETE FROM prompt_index WHERE project_root = ? AND owner_ref = ?").run(
    projectRoot,
    blockRef
  );
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

function upsertPromptRow(
  db: SqliteDatabase,
  projectRoot: string,
  prompt: PromptRef,
  indexedAt: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO prompt_index (project_root, owner_kind, owner_ref, path, content_hash, preview, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    projectRoot,
    prompt.ownerKind,
    prompt.ownerRef,
    prompt.path,
    prompt.contentHash,
    prompt.preview,
    indexedAt
  );
}

function writeGraphMeta(
  db: SqliteDatabase,
  projectRoot: string,
  graph: PlanGraph,
  indexedAt: string
): void {
  db.prepare("DELETE FROM graph_meta WHERE project_root = ?").run(projectRoot);
  db.prepare(
    `INSERT INTO graph_meta (project_root, package_fingerprint, graph_version, project_json, diagnostics_json, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    projectRoot,
    graph.packageFingerprint,
    graph.graphVersion,
    jsonString(graph.project),
    jsonString(graph.diagnostics),
    indexedAt
  );
}

function changedPromptOwnerRefs(graph: PlanGraph, paths: string[]): string[] {
  const normalized = new Set(
    paths.map(normalizePackagePath).filter((path): path is string => path !== null)
  );
  return [...graph.promptRefs.values()]
    .filter((prompt) => normalized.has(prompt.path))
    .map((prompt) => prompt.ownerRef);
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

export function shouldFullRebuildChangedPaths(paths: string[]): boolean {
  if (paths.length === 0) {
    return false;
  }
  return paths.some((path) => {
    const normalized = normalizePackagePath(path);
    return normalized === null || normalized === "manifest.json";
  });
}

export function writeChangedPromptIndex(
  db: SqliteDatabase,
  projectRoot: string,
  graph: PlanGraph,
  paths: string[]
): void {
  const ownerRefs = changedPromptOwnerRefs(graph, paths);
  const indexedAt = new Date().toISOString();
  db.exec("BEGIN");
  try {
    writeGraphMeta(db, projectRoot, graph, indexedAt);
    db.prepare("DELETE FROM edges WHERE project_root = ?").run(projectRoot);
    const insertEdge = db.prepare(
      "INSERT INTO edges (project_root, edge_type, from_ref, to_ref) VALUES (?, ?, ?, ?)"
    );
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

export function readGraphIndex(db: SqliteDatabase, projectRoot: string): PlanGraph | null {
  const meta = db.prepare("SELECT * FROM graph_meta WHERE project_root = ?").get(projectRoot);
  if (!meta) {
    return null;
  }

  const promptRefs = new Map<string, PromptRef>();
  for (const row of db
    .prepare("SELECT * FROM prompt_index WHERE project_root = ? ORDER BY owner_ref")
    .all(projectRoot)) {
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
  for (const row of db
    .prepare("SELECT * FROM tasks WHERE project_root = ? ORDER BY task_id")
    .all(projectRoot)) {
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
  for (const row of db
    .prepare("SELECT * FROM blocks WHERE project_root = ? ORDER BY block_ref")
    .all(projectRoot)) {
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

  const edges = db
    .prepare("SELECT * FROM edges WHERE project_root = ? ORDER BY edge_type, from_ref, to_ref")
    .all(projectRoot)
    .map((row) => {
      const type = stringColumn(row, "edge_type");
      if (type === "taskDependsOn") {
        return {
          type,
          fromTaskId: stringColumn(row, "from_ref"),
          toTaskId: stringColumn(row, "to_ref")
        } as const;
      }
      if (type === "blockDependsOn") {
        return {
          type,
          fromBlockRef: stringColumn(row, "from_ref"),
          toBlockRef: stringColumn(row, "to_ref")
        } as const;
      }
      throw new Error(`SQLite index contains unsupported edge type '${type}'.`);
    });

  return {
    graphVersion: stringColumn(meta, "graph_version"),
    packageFingerprint: stringColumn(meta, "package_fingerprint"),
    project: parseJsonRecord(
      stringColumn(meta, "project_json"),
      "project_json"
    ) as PlanGraph["project"],
    diagnostics: parseJsonArray(
      stringColumn(meta, "diagnostics_json"),
      "diagnostics_json"
    ) as PlanGraph["diagnostics"],
    tasks,
    blocks,
    edges,
    promptRefs
  };
}
