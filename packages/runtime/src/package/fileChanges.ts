import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { compilePackageGraphFromPrompts } from "../graph/compileTaskGraph.js";
import { affectedTasksForPackageFileChange, type PackageChangeImpact } from "../graph/editGraph.js";
import { loadPackage } from "./loadPackage.js";
import {
  capturePackagePrompts,
  isOrphanPromptWatchPath,
  isPackageNodesPath,
  normalizePackageWatchPath,
  originalPromptPaths,
  packagePromptOwners,
  promptWatchAliases,
  resolvePackagePromptTargets,
  type PromptOwner
} from "./promptInventory.js";
import { refreshPrompt } from "../prompt/refreshPrompt.js";
import { refreshPrompts } from "../prompt/refreshPrompts.js";
import {
  createPromptRenderContextForPackageSnapshot,
  type PromptRenderContext
} from "../taskManager/promptRenderContext.js";
import type {
  CompiledExecutionGraph,
  FileFingerprint,
  PackageFileSnapshot,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ProjectWorkspace,
  PromptSurface,
  ValidationIssue
} from "../types.js";

const DEFAULT_PROMPT_REFRESH_CONCURRENCY = 4;
type PromptFingerprintMode = "content" | "stat";

export type PromptRefreshStats = {
  requested: number;
  refreshed: number;
  concurrency: number | null;
  elapsedMs: number;
  changedPathCount: number;
  refreshedRefs: number;
  mode: "incremental" | "full";
};

export type PackageFileSyncResult = {
  snapshot: PackageFileSnapshot | null;
  observedSnapshot?: PackageFileSnapshot;
  impact: PackageChangeImpact;
  refreshed: PromptSurface[];
  refreshStats: PromptRefreshStats;
  changedPackagePaths: string[];
  indexPackagePaths: string[];
  incremental: boolean;
};

export type PackageFileRefreshOptions = {
  refreshConcurrency?: number;
};

type NormalizedPackageChangePaths = {
  changedPackagePaths: string[];
  diagnostics: ValidationIssue[];
  incremental: boolean;
};

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

async function fingerprint(path: string): Promise<FileFingerprint> {
  const [metadata, content] = await Promise.all([stat(path), readFile(path)]);
  return {
    path,
    hash: createHash("sha256").update(content).digest("hex"),
    mtimeMs: metadata.mtimeMs
  };
}

function sameManifest(left: PlanPackageManifest, right: PlanPackageManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changed(left: FileFingerprint | undefined, right: FileFingerprint | undefined): boolean {
  return left?.hash !== right?.hash;
}

function normalizeConcurrency(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function promptRefreshStats(options: {
  requested: number;
  refreshed: number;
  concurrency: number | null;
  changedPathCount: number;
  mode: PromptRefreshStats["mode"];
  startedAt: number;
}): PromptRefreshStats {
  return {
    requested: options.requested,
    refreshed: options.refreshed,
    concurrency: options.concurrency,
    elapsedMs: elapsedMs(options.startedAt),
    changedPathCount: options.changedPathCount,
    refreshedRefs: options.refreshed,
    mode: options.mode
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const concurrency = normalizeConcurrency(limit);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;

  async function worker(): Promise<void> {
    while (nextIndex < items.length && !firstError) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        firstError = error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) {
    throw firstError;
  }
  return results;
}

export function normalizePackageChangedPaths(
  changedPaths: string[] | undefined,
  aliases?: ReadonlyMap<string, string[]>
): NormalizedPackageChangePaths {
  if (!changedPaths || changedPaths.length === 0) {
    return {
      changedPackagePaths: ["manifest.json"],
      diagnostics: [
        issue(
          "package_change_paths_empty",
          "Package file refresh did not receive changed paths; falling back to a full refresh."
        )
      ],
      incremental: false
    };
  }

  const changedPackagePaths: string[] = [];
  const diagnostics: ValidationIssue[] = [];

  for (const rawPath of changedPaths) {
    const normalized = normalizePackageWatchPath(rawPath);
    if (normalized === "manifest.json" || normalized === "package/manifest.json") {
      changedPackagePaths.push("manifest.json");
      diagnostics.push(
        issue(
          "package_change_manifest_requires_full_refresh",
          "Manifest changes require a full package refresh.",
          normalized
        )
      );
      continue;
    }

    if (normalized === "policy/project-prompt.md") {
      changedPackagePaths.push("policy/project-prompt.md");
      diagnostics.push(
        issue(
          "package_change_non_package_prompt",
          "Project prompt changes are not package prompt changes; falling back to a full refresh.",
          normalized
        )
      );
      continue;
    }

    const packagePath = normalized.startsWith("package/")
      ? normalized.slice("package/".length)
      : normalized;
    const paths = aliases?.get(packagePath);
    if (paths) {
      changedPackagePaths.push(...paths);
      continue;
    }
    if (isOrphanPromptWatchPath(packagePath)) {
      changedPackagePaths.push(packagePath);
      continue;
    }
    if (isPackageNodesPath(packagePath)) {
      changedPackagePaths.push(packagePath);
      diagnostics.push(
        issue(
          "package_change_coarse_path_requires_full_refresh",
          "Directory-level package changes require a full package refresh.",
          normalized
        )
      );
      continue;
    }

    changedPackagePaths.push(packagePath || "manifest.json");
    diagnostics.push(
      issue(
        "package_change_unknown_path_requires_full_refresh",
        "Unknown package watcher path requires a full package refresh.",
        normalized
      )
    );
  }

  return {
    changedPackagePaths: [...new Set(changedPackagePaths)],
    diagnostics,
    incremental: diagnostics.length === 0
  };
}

function ownersForPaths(
  owners: ReadonlyMap<string, PromptOwner[]>,
  paths: string[]
): PromptOwner[] {
  return paths.flatMap((path) => owners.get(path) ?? []);
}

export function changedPackagePaths(
  previous: PackageFileSnapshot,
  next: PackageFileSnapshot
): string[] {
  const paths = new Set([...Object.keys(previous.promptFiles), ...Object.keys(next.promptFiles)]);
  const changedPaths = [...paths].filter((path) =>
    changed(previous.promptFiles[path], next.promptFiles[path])
  );
  return changed(previous.manifestFile, next.manifestFile)
    ? ["manifest.json", ...changedPaths]
    : changedPaths;
}

export function changedPackagePromptOwners(
  previous: PackageFileSnapshot,
  next: PackageFileSnapshot,
  paths = changedPackagePaths(previous, next)
): string[] {
  const nextOwners = packagePromptOwners(next.manifest);
  const refs = new Set(ownersForPaths(nextOwners, paths).map((owner) => owner.ref));
  if (!sameManifest(previous.manifest, next.manifest)) {
    const previousPaths = new Map(
      [...packagePromptOwners(previous.manifest)].flatMap(([path, owners]) =>
        owners.map((owner) => [owner.ref, path] as const)
      )
    );
    for (const [path, owners] of nextOwners) {
      for (const { ref } of owners) {
        if (previousPaths.has(ref) && previousPaths.get(ref) !== path) refs.add(ref);
      }
    }
  }
  return [...refs];
}

export async function createPackageFileSnapshotFromLoadedPackage(input: {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  graph?: CompiledExecutionGraph;
  manifestFingerprint?: FileFingerprint;
  promptFingerprintMode?: PromptFingerprintMode;
}): Promise<PackageFileSnapshot> {
  return createPackageFileSnapshotFromPackageRoot({
    packageDir: input.workspace.packageDir,
    manifestFile: input.workspace.manifestFile,
    manifest: input.manifest,
    graph: input.graph,
    manifestFingerprint: input.manifestFingerprint,
    promptFingerprintMode: input.promptFingerprintMode
  });
}

export async function createPackageFileSnapshotFromPackageRoot(input: {
  packageDir: string;
  manifestFile: string;
  manifest: PlanPackageManifest;
  graph?: CompiledExecutionGraph;
  manifestFingerprint?: FileFingerprint;
  promptFingerprintMode?: PromptFingerprintMode;
}): Promise<PackageFileSnapshot> {
  const mode = input.promptFingerprintMode ?? "content";
  const owners = packagePromptOwners(input.manifest);
  const targets = await resolvePackagePromptTargets(input.packageDir, owners.keys(), {
    includeOrphans: true,
    manifestPaths: originalPromptPaths(owners)
  });
  const captured = await capturePackagePrompts(targets, mode, owners, {
    includeOrphanFingerprints: true
  });
  const graph =
    input.graph ??
    compilePackageGraphFromPrompts(
      input.manifest,
      owners,
      targets.paths.keys(),
      captured.diagnostics
    );
  return {
    manifest: input.manifest,
    graph,
    manifestFile: input.manifestFingerprint ?? (await fingerprint(input.manifestFile)),
    promptFiles: captured.fingerprints,
    promptTargets: targets,
    ...(mode === "content"
      ? {
          promptMarkdown: captured.markdown,
          promptReadFailures: captured.failures
        }
      : {})
  };
}

export async function createPackageFileMetadataSnapshot(
  projectRoot: PackageWorkspaceRef
): Promise<PackageFileSnapshot> {
  const loaded = await loadPackage(projectRoot, { fingerprintManifest: true });
  return createPackageFileSnapshotFromLoadedPackage({
    ...loaded,
    promptFingerprintMode: "stat"
  });
}

export async function createPackageFileSnapshot(
  projectRoot: PackageWorkspaceRef
): Promise<PackageFileSnapshot> {
  return createPackageFileSnapshotFromLoadedPackage(
    await loadPackage(projectRoot, { fingerprintManifest: true })
  );
}

export async function detectPackageFileChanges(
  projectRoot: PackageWorkspaceRef,
  previous: PackageFileSnapshot
): Promise<{
  snapshot: PackageFileSnapshot | null;
  observedSnapshot?: PackageFileSnapshot;
  impact: PackageChangeImpact;
  indexPackagePaths: string[];
}> {
  try {
    const snapshot = await createPackageFileSnapshot(projectRoot);
    const paths = changedPackagePaths(previous, snapshot);
    const manifestChanged = !sameManifest(previous.manifest, snapshot.manifest);
    const manifestImpact = manifestChanged
      ? affectedTasksForPackageFileChange({
          kind: "manifest",
          before: previous.manifest,
          after: snapshot.manifest,
          graph: snapshot.graph
        })
      : null;
    const diagnostics = snapshot.graph.diagnostics.errors;
    const changedOwners = ownersForPaths(packagePromptOwners(snapshot.manifest), [
      ...paths,
      ...diagnostics.flatMap(({ path }) => (path ? [path] : []))
    ]);
    const ok = diagnostics.length === 0;
    const repaired = ok && previous.graph.diagnostics.errors.length > 0;
    const indexPackagePaths = repaired && paths.length === 0 ? ["manifest.json"] : paths;
    return {
      snapshot: ok ? snapshot : null,
      observedSnapshot: snapshot,
      indexPackagePaths:
        !ok && indexPackagePaths.length === 0 ? ["manifest.json"] : indexPackagePaths,
      impact: {
        ok,
        affectedTasks: [
          ...new Set([
            ...(manifestImpact?.affectedTasks ?? []),
            ...changedOwners.map((owner) => owner.taskId)
          ])
        ],
        diagnostics,
        fullRefresh: !ok || repaired || manifestChanged || paths.length > 0,
        graph: snapshot.graph
      }
    };
  } catch (error) {
    return {
      snapshot: null,
      indexPackagePaths: ["manifest.json"],
      impact: {
        ok: false,
        affectedTasks: [],
        diagnostics: [
          issue(
            "package_change_detection_failed",
            error instanceof Error ? error.message : String(error)
          )
        ],
        fullRefresh: true
      }
    };
  }
}

export async function refreshChangedPackagePrompts(
  projectRoot: PackageWorkspaceRef,
  previous: PackageFileSnapshot
): Promise<PackageFileSyncResult> {
  const startedAt = performance.now();
  const detected = await detectPackageFileChanges(projectRoot, previous);
  const context =
    detected.snapshot && detected.impact.fullRefresh
      ? await createPromptRenderContextForPackageSnapshot(projectRoot, detected.snapshot)
      : undefined;
  const result = context ? await refreshPrompts({ projectRoot, context }) : { prompts: [] };
  const refreshedCount = result.prompts.length;
  return {
    ...detected,
    refreshed: result.prompts,
    refreshStats: promptRefreshStats({
      requested: refreshedCount,
      refreshed: refreshedCount,
      concurrency: detected.impact.fullRefresh ? null : 1,
      changedPathCount: detected.indexPackagePaths.length,
      mode: "full",
      startedAt
    }),
    changedPackagePaths: detected.indexPackagePaths,
    incremental: false
  };
}

async function refreshFullWithDiagnostics(
  projectRoot: PackageWorkspaceRef,
  previous: PackageFileSnapshot,
  diagnostics: ValidationIssue[],
  changedPackagePaths: string[],
  startedAt: number
): Promise<PackageFileSyncResult> {
  const full = await refreshChangedPackagePrompts(projectRoot, previous);
  return {
    ...full,
    impact: {
      ...full.impact,
      diagnostics: [...diagnostics, ...full.impact.diagnostics]
    },
    refreshStats: {
      ...full.refreshStats,
      elapsedMs: elapsedMs(startedAt),
      changedPathCount: changedPackagePaths.length,
      mode: "full"
    },
    changedPackagePaths,
    indexPackagePaths: full.indexPackagePaths,
    incremental: false
  };
}

export async function refreshChangedPackagePromptsForPaths(
  projectRoot: PackageWorkspaceRef,
  previous: PackageFileSnapshot,
  changedPaths: string[],
  options: PackageFileRefreshOptions = {}
): Promise<PackageFileSyncResult> {
  const startedAt = performance.now();
  const previousTargets = previous.promptTargets;
  const owners = packagePromptOwners(previous.manifest);
  const aliases = previousTargets && promptWatchAliases(previousTargets);
  const normalized = normalizePackageChangedPaths(changedPaths, aliases);
  const fallback = (diagnostics: ValidationIssue[]) =>
    refreshFullWithDiagnostics(
      projectRoot,
      previous,
      diagnostics,
      normalized.changedPackagePaths,
      startedAt
    );
  if (
    !normalized.incremental ||
    !previousTargets ||
    !aliases ||
    !previous.promptMarkdown ||
    previous.graph.diagnostics.errors.length > 0
  ) {
    return fallback(normalized.diagnostics);
  }

  const unknownPaths = normalized.changedPackagePaths.filter((path) => !owners.has(path));
  if (unknownPaths.length > 0) {
    return fallback(
      unknownPaths.map((path) =>
        issue(
          "package_change_prompt_not_in_graph",
          `Prompt '${path}' is not referenced by the current package graph; falling back to a full refresh.`,
          path
        )
      )
    );
  }

  try {
    const loaded = await loadPackage(projectRoot, { fingerprintManifest: true });
    const { workspace } = loaded;
    if (changed(previous.manifestFile, loaded.manifestFingerprint)) return fallback([]);

    const manifestPaths = originalPromptPaths(owners);
    const targets = await resolvePackagePromptTargets(
      workspace.packageDir,
      normalized.changedPackagePaths,
      { manifestPaths }
    );
    const resolvedAliases = promptWatchAliases(targets);
    const pending = new Set<string>();
    for (const alias of resolvedAliases.keys()) {
      for (const path of aliases.get(alias) ?? []) {
        if (!targets.paths.has(path)) pending.add(path);
      }
    }
    if (pending.size > 0) {
      const extra = await resolvePackagePromptTargets(workspace.packageDir, pending, {
        manifestPaths
      });
      targets.paths = new Map([...targets.paths, ...extra.paths]);
      targets.diagnostics.push(...extra.diagnostics);
      targets.failures = new Map([...targets.failures, ...extra.failures]);
    }
    const captured = await capturePackagePrompts(targets, "content", owners);
    if (captured.diagnostics.length > 0) {
      return fallback(
        captured.diagnostics.map(({ path, message }) =>
          issue("package_change_incremental_refresh_failed", message, path)
        )
      );
    }
    const snapshot: PackageFileSnapshot = {
      ...previous,
      manifestFile: loaded.manifestFingerprint ?? previous.manifestFile,
      promptFiles: { ...previous.promptFiles, ...captured.fingerprints },
      promptTargets: {
        ...targets,
        paths: new Map([...previousTargets.paths, ...targets.paths])
      },
      promptMarkdown: new Map([...previous.promptMarkdown, ...captured.markdown])
    };
    const paths = normalized.changedPackagePaths.filter((path) =>
      changed(previous.promptFiles[path], snapshot.promptFiles[path])
    );
    const affected = ownersForPaths(owners, paths);
    const refsToRefresh = [
      ...new Set(
        affected.flatMap(({ kind, ref, taskId }) =>
          kind === "task" ? (snapshot.graph.blocksByTask.get(taskId) ?? []) : [ref]
        )
      )
    ];
    const refreshConcurrency = normalizeConcurrency(
      options.refreshConcurrency ?? DEFAULT_PROMPT_REFRESH_CONCURRENCY
    );
    let context: Promise<PromptRenderContext> | undefined;
    const refreshed = await mapWithConcurrency(refsToRefresh, refreshConcurrency, (ref) =>
      refreshPrompt({
        projectRoot,
        ref,
        context: () =>
          (context ??= createPromptRenderContextForPackageSnapshot(workspace, snapshot))
      })
    );
    return {
      snapshot,
      impact: {
        ok: true,
        affectedTasks: [...new Set(affected.map((owner) => owner.taskId))],
        diagnostics: [],
        fullRefresh: false,
        graph: snapshot.graph
      },
      refreshed,
      refreshStats: promptRefreshStats({
        requested: refsToRefresh.length,
        refreshed: refreshed.length,
        concurrency: refreshConcurrency,
        changedPathCount: normalized.changedPackagePaths.length,
        mode: "incremental",
        startedAt
      }),
      changedPackagePaths: normalized.changedPackagePaths,
      indexPackagePaths: paths,
      incremental: true
    };
  } catch (error) {
    return fallback([
      issue(
        "package_change_incremental_refresh_failed",
        error instanceof Error ? error.message : String(error),
        normalized.changedPackagePaths[0]
      )
    ]);
  }
}
