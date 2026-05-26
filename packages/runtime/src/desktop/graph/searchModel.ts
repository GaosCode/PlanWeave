import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { loadPackage } from "../../package/loadPackage.js";
import { resolvePackagePath } from "../../package/resolvePackagePath.js";
import { readState } from "../../state.js";
import type { PackageWorkspaceRef } from "../../types.js";
import type { DesktopSearchFilters, DesktopSearchResult, DesktopSearchResultKind } from "../types.js";
import { blockRef, getTask, promptPreview, readOptionalFile } from "./graphHelpers.js";
import { mapProjectTaskCanvases } from "./projectCanvasAggregation.js";

async function listResultFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listResultFiles(path)));
      } else if (entry.isFile() && /\.(md|json|log|txt)$/.test(entry.name)) {
        files.push(path);
      }
    }
    return files;
  } catch {
    return [];
  }
}

async function smallTextFile(path: string): Promise<string> {
  const metadata = await stat(path);
  if (metadata.size > 256_000) {
    return "";
  }
  return readFile(path, "utf8");
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function runRecordIdFromResultPath(path: string): string | null {
  const match = /^([^/]+)\/blocks\/([^/]+)\/runs\/([^/]+)\//.exec(path);
  if (!match) {
    return null;
  }
  return `${match[1]}#${match[2]}::${match[3]}`;
}

async function searchWorkspace(
  projectRoot: PackageWorkspaceRef,
  query: string,
  filters: DesktopSearchFilters = {},
  canvasMeta?: { canvasId: string; canvasName: string }
): Promise<DesktopSearchResult[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const allowedKinds = filters.kinds?.length ? new Set<DesktopSearchResultKind>(filters.kinds) : null;
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const state = await readState(workspace.stateFile);
  const results: DesktopSearchResult[] = [];
  const reviewBlockRefFromResultPath = (path: string): string | null => {
    const match = path.match(/^([^/]+)\/reviews\/([^/]+)\/attempts\//);
    return match ? blockRef(match[1], match[2]) : null;
  };
  const pushResult = (result: DesktopSearchResult) => {
    if (!allowedKinds || allowedKinds.has(result.kind)) {
      results.push({
        ...result,
        canvasId: canvasMeta?.canvasId,
        canvasName: canvasMeta?.canvasName
      });
    }
  };
  for (const taskId of graph.taskNodesInManifestOrder) {
    const task = getTask(graph, taskId);
    const taskPrompt = (await readOptionalFile(await resolvePackagePath(workspace.packageDir, task.prompt), task.prompt)).markdown;
    if (task.title.toLowerCase().includes(normalized)) {
      pushResult({ kind: "task", ref: taskId, title: task.title, excerpt: task.title });
    }
    if (taskPrompt.toLowerCase().includes(normalized)) {
      pushResult({ kind: "prompt", ref: taskId, targetRef: taskId, title: task.title, excerpt: promptPreview(taskPrompt) });
    }
    for (const block of task.blocks) {
      const ref = blockRef(taskId, block.id);
      const blockPrompt = (await readOptionalFile(await resolvePackagePath(workspace.packageDir, block.prompt), block.prompt)).markdown;
      if (block.title.toLowerCase().includes(normalized)) {
        pushResult({ kind: "block", ref, title: block.title, excerpt: block.title });
      }
      if (blockPrompt.toLowerCase().includes(normalized)) {
        pushResult({ kind: "prompt", ref, targetRef: ref, title: block.title, excerpt: promptPreview(blockPrompt) });
      }
    }
  }
  for (const [feedbackId, feedback] of Object.entries(state.feedback)) {
    if (feedback.content.toLowerCase().includes(normalized)) {
      pushResult({
        kind: "feedback",
        ref: feedbackId,
        targetRef: feedback.sourceReviewBlockRef,
        title: `${feedbackId} · ${feedback.sourceReviewBlockRef}`,
        excerpt: promptPreview(feedback.content)
      });
    }
  }
  for (const file of await listResultFiles(workspace.resultsDir)) {
    const content = await smallTextFile(file);
    if (!content.toLowerCase().includes(normalized)) {
      continue;
    }
    const relativePath = relative(workspace.resultsDir, file);
    const kind = relativePath.includes("/reviews/") ? "review_attempt" : "run_record";
    pushResult({
      kind,
      ref: relativePath,
      targetRef:
        kind === "review_attempt"
          ? reviewBlockRefFromResultPath(toPosixPath(relativePath)) ?? undefined
          : runRecordIdFromResultPath(toPosixPath(relativePath))?.split("::")[0],
      title: relativePath,
      excerpt: promptPreview(content),
      path: relativePath,
      recordId: kind === "run_record" ? runRecordIdFromResultPath(toPosixPath(relativePath)) ?? undefined : undefined
    });
  }
  return results;
}

export async function searchProject(projectRoot: string, query: string, filters: DesktopSearchFilters = {}): Promise<DesktopSearchResult[]> {
  const results: DesktopSearchResult[] = [];
  const canvasResults = await mapProjectTaskCanvases(projectRoot, ({ canvasId, canvasName, workspace }) =>
    searchWorkspace(workspace, query, filters, { canvasId, canvasName })
  );
  for (const items of canvasResults) {
    results.push(...items);
  }
  return results;
}
