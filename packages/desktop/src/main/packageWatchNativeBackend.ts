import { existsSync, watch, type FSWatcher } from "node:fs";
import {
  isOrphanPromptWatchPath,
  isPackageNodesPath,
  loadPackagePromptReferenceInventory,
  normalizePackageWatchPath,
  promptWatchAliases,
  resolvePackagePromptTargets
} from "@planweave-ai/runtime";
import type { PackageWatchBackendHandle } from "./packageWatchBackend.js";
import {
  packageWatchEventPaths,
  watchAliasAncestors,
  type PackageWatchRoot,
  type TaskCanvasWorkspace,
  watchedRootsForWorkspace
} from "./packageWatchPaths.js";
import { systemWatchScheduler, type WatchScheduler, type WatchTimer } from "./watchRuntime.js";

export async function startNativePackageWatchBackend(
  workspace: TaskCanvasWorkspace,
  recordChange: (path: string) => void,
  onError?: (error: unknown) => void,
  scheduler: WatchScheduler = systemWatchScheduler
): Promise<PackageWatchBackendHandle | null> {
  const watchers: FSWatcher[] = [];
  let closed = false;
  let references: ReadonlyMap<string, string> = new Map();
  let aliases = new Map<string, string[]>();
  let ancestors = new Map<string, Set<string>>();
  const pendingEvents = new Set<string>();
  let flushTimer: WatchTimer | undefined;
  let running = false;

  async function updateAliases(reloadManifest: boolean): Promise<void> {
    if (reloadManifest) {
      try {
        references = (await loadPackagePromptReferenceInventory(workspace)).paths;
      } catch (error) {
        console.warn(
          "PlanWeave native package watcher could not load prompt references:",
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    const targets = await resolvePackagePromptTargets(workspace.packageDir, references.keys(), {
      manifestPaths: references,
      resolveWatchLinks: true
    });
    aliases = promptWatchAliases(targets);
    ancestors = watchAliasAncestors(aliases);
  }

  function notify(event: string): void {
    for (const path of packageWatchEventPaths("package", event, aliases)) recordChange(path);
    for (const child of ancestors.get(event) ?? []) recordChange(`package/${child}`);
  }

  function scheduleRebuild(): void {
    if (closed || running || flushTimer || pendingEvents.size === 0) return;
    flushTimer = scheduler.schedule(0, async () => {
      flushTimer = undefined;
      running = true;
      const events = [...pendingEvents];
      pendingEvents.clear();
      try {
        await updateAliases(events.some((name) => name === "" || name === "manifest.json"));
        if (!closed) {
          for (const event of events) {
            if (event && event !== "manifest.json") notify(event);
          }
        }
      } catch (error) {
        if (!closed) onError?.(error);
      } finally {
        running = false;
        scheduleRebuild();
      }
    });
  }

  function onChange(
    scope: PackageWatchRoot["scope"],
    eventType: string,
    filename: string | Buffer | null
  ): void {
    if (closed) return;
    if (scope === "policy") {
      for (const path of packageWatchEventPaths(scope, filename, aliases)) recordChange(path);
      return;
    }
    const name = normalizePackageWatchPath(filename?.toString() ?? "");
    notify(name);
    const manifestEvent = !name || name === "manifest.json";
    if (
      eventType === "rename" &&
      isPackageNodesPath(name) &&
      !isOrphanPromptWatchPath(name) &&
      !ancestors.has(name)
    ) {
      recordChange("package/manifest.json");
    }
    if (manifestEvent || ancestors.has(name) || (eventType === "rename" && aliases.has(name))) {
      pendingEvents.add(name);
      scheduleRebuild();
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    flushTimer?.cancel();
    pendingEvents.clear();
    for (const watcher of watchers) {
      watcher.removeAllListeners("error");
      watcher.close();
    }
    watchers.length = 0;
  }

  try {
    await updateAliases(true);
    for (const { rootPath, scope } of watchedRootsForWorkspace(workspace)) {
      if (!existsSync(rootPath)) continue;
      const watcher = watch(rootPath, { recursive: true }, (eventType, filename) =>
        onChange(scope, eventType, filename)
      );
      watcher.on("error", (error) => onError?.(error));
      watchers.push(watcher);
    }
    if (watchers.length === 0) return null;
  } catch {
    close();
    return null;
  }

  return { kind: "native", close };
}
