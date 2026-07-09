import { join } from "node:path";
import { loadPackage } from "../../package/loadPackage.js";
import { resolveProjectWorkspace } from "../../project.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../../types.js";
import type { PlanGraph } from "../domain/types.js";
import { loadPlanGraphPackage } from "../packageRepository.js";
import type { PlanGraphIndexStore, PlanGraphOperationLog } from "../ports.js";
import { jsonString } from "./columns.js";
import { openDatabase, type SqliteDatabase } from "./connection.js";
import {
  readGraphIndex,
  shouldFullRebuildChangedPaths,
  writeChangedPromptIndex,
  writeGraphIndex
} from "./graphRows.js";
import {
  mergeAffectedRefs,
  operationLogEntry,
  promptHistoryTarget,
  sameWorkspaceRef,
  tryOperationLogCoalescingEntry
} from "./operationLogRows.js";
import {
  clearProjectionVersions,
  readProjectionVersion,
  writeProjectionVersion
} from "./projectionRows.js";
import { ensureSchema } from "./schema.js";

export function defaultPlanGraphIndexPath(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "cache", "plangraph.sqlite");
}

async function resolveIndexPath(
  projectRoot: PackageWorkspaceRef,
  indexPath?: string
): Promise<{ workspace: ProjectWorkspace; indexPath: string }> {
  const { workspace } = await loadPackage(projectRoot);
  const projectWorkspace = await resolveProjectWorkspace(workspace.rootPath);
  return { workspace, indexPath: indexPath ?? defaultPlanGraphIndexPath(projectWorkspace) };
}

async function openPlanGraphDatabase(indexPath: string): Promise<SqliteDatabase> {
  const db = await openDatabase(indexPath);
  try {
    ensureSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function createSqlitePlanGraphStore(options: {
  projectRoot: PackageWorkspaceRef;
  indexPath?: string;
}): Promise<PlanGraphIndexStore & { log: PlanGraphOperationLog; indexPath: string }> {
  const { workspace, indexPath } = await resolveIndexPath(options.projectRoot, options.indexPath);
  const graphKey = workspace.workspaceRoot;
  const historyKey = workspace.rootPath;
  const rebuild = async (rebuildOptions: { clearHistory?: boolean } = {}): Promise<PlanGraph> => {
    const db = await openPlanGraphDatabase(indexPath);
    try {
      const loaded = await loadPlanGraphPackage(options.projectRoot);
      writeGraphIndex(db, graphKey, loaded.graph);
      if (rebuildOptions.clearHistory) {
        db.prepare("DELETE FROM operation_log WHERE project_root = ?").run(historyKey);
      }
      clearProjectionVersions(db, graphKey);
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
      const db = await openPlanGraphDatabase(indexPath);
      try {
        const loaded = await loadPlanGraphPackage(options.projectRoot);
        writeChangedPromptIndex(db, graphKey, loaded.graph, paths);
        if (rebuildOptions.clearHistory) {
          db.prepare("DELETE FROM operation_log WHERE project_root = ?").run(historyKey);
        }
        clearProjectionVersions(db, graphKey);
        return loaded.graph;
      } finally {
        db.close();
      }
    },
    async load() {
      const db = await openPlanGraphDatabase(indexPath);
      try {
        return readGraphIndex(db, graphKey);
      } finally {
        db.close();
      }
    },
    async getProjectionVersion(projectionName, cacheKey) {
      const db = await openPlanGraphDatabase(indexPath);
      try {
        return readProjectionVersion(db, graphKey, projectionName, cacheKey);
      } finally {
        db.close();
      }
    },
    async setProjectionVersion(projection) {
      const db = await openPlanGraphDatabase(indexPath);
      try {
        writeProjectionVersion(db, graphKey, projection);
      } finally {
        db.close();
      }
    },
    async clearProjectionVersions() {
      const db = await openPlanGraphDatabase(indexPath);
      try {
        clearProjectionVersions(db, graphKey);
      } finally {
        db.close();
      }
    },
    log: {
      async append(entry) {
        const db = await openPlanGraphDatabase(indexPath);
        try {
          db.prepare(
            "DELETE FROM operation_log WHERE project_root = ? AND undone_at IS NOT NULL"
          ).run(historyKey);
          const promptTarget = promptHistoryTarget(entry.command);
          if (promptTarget) {
            const latest = db
              .prepare(
                "SELECT * FROM operation_log WHERE project_root = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1"
              )
              .get(historyKey);
            if (latest) {
              const latestEntry = tryOperationLogCoalescingEntry(latest, historyKey);
              if (
                latestEntry &&
                promptHistoryTarget(latestEntry.command) === promptTarget &&
                sameWorkspaceRef(latestEntry.workspaceRef, entry.workspaceRef)
              ) {
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
        const db = await openPlanGraphDatabase(indexPath);
        try {
          const row = db
            .prepare(
              "SELECT * FROM operation_log WHERE project_root = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1"
            )
            .get(historyKey);
          return row ? operationLogEntry(row, historyKey) : null;
        } finally {
          db.close();
        }
      },
      async latestRedoable() {
        const db = await openPlanGraphDatabase(indexPath);
        try {
          const row = db
            .prepare(
              "SELECT * FROM operation_log WHERE project_root = ? AND undone_at IS NOT NULL ORDER BY undone_at DESC, id ASC LIMIT 1"
            )
            .get(historyKey);
          return row ? operationLogEntry(row, historyKey) : null;
        } finally {
          db.close();
        }
      },
      async markUndone(id) {
        const db = await openPlanGraphDatabase(indexPath);
        try {
          db.prepare(
            "UPDATE operation_log SET undone_at = ? WHERE id = ? AND project_root = ?"
          ).run(new Date().toISOString(), id, historyKey);
        } finally {
          db.close();
        }
      },
      async markRedone(id) {
        const db = await openPlanGraphDatabase(indexPath);
        try {
          db.prepare(
            "UPDATE operation_log SET undone_at = NULL WHERE id = ? AND project_root = ?"
          ).run(id, historyKey);
        } finally {
          db.close();
        }
      },
      async clear() {
        const db = await openPlanGraphDatabase(indexPath);
        try {
          db.prepare("DELETE FROM operation_log WHERE project_root = ?").run(historyKey);
        } finally {
          db.close();
        }
      }
    }
  };
}
