import { createHash } from "node:crypto";
import { ipcMain } from "electron";
import { existsSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import type { DesktopCanvasReference, DesktopPackageFileChangeEvent } from "@planweave-ai/runtime";
import type { WebContents } from "electron";
import { desktopBridgeInvokeChannels, packageFileChangedChannel } from "../shared/ipcChannels.js";

type PackageFileFingerprint = {
  mtimeMs: number;
  size: number;
  hash?: string;
};

type PackageFingerprintSnapshot = Map<string, PackageFileFingerprint>;
type TaskCanvasWorkspace = Awaited<ReturnType<typeof resolveTaskCanvasWorkspace>>;

type PackageWatchBackend = {
  kind: "native" | "polling";
  watchers: FSWatcher[];
  pollTimer: NodeJS.Timeout | null;
  lastSnapshot: PackageFingerprintSnapshot | null;
};

type PackageWatchSubscriber = {
  webContents: WebContents;
  onDestroyed: () => void;
};

type PackageWatch = {
  backend: PackageWatchBackend;
  subscribers: Map<number, PackageWatchSubscriber>;
  changedPaths: Set<string>;
  timer: NodeJS.Timeout | null;
  closed: boolean;
};

const packageWatches = new Map<string, PackageWatch>();
const pendingPackageWatchStarts = new Map<string, Promise<PackageWatch>>();
const pendingPackageWatchSubscribers = new Map<string, Map<number, WebContents>>();
const packageWatchDebounceMs = 150;
const packageWatchPollIntervalMs = 1000;

function watchKey(projectRoot: string, canvasId?: string | null): string {
  return `${projectRoot}::${canvasId ?? "default"}`;
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function shouldNotifyPackagePath(path: string): boolean {
  return path === "package/manifest.json" || path === "policy/project-prompt.md" || /^package\/nodes\/.+\.md$/.test(path);
}

function isMissingPathError(caught: unknown): boolean {
  return caught instanceof Error && "code" in caught && caught.code === "ENOENT";
}

async function fingerprintIfPresent(path: string, hashContent = false): Promise<PackageFileFingerprint | null> {
  try {
    const [metadata, content] = await Promise.all([stat(path), hashContent ? readFile(path) : Promise.resolve(null)]);
    if (!metadata.isFile()) {
      return null;
    }
    return {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      hash: content ? createHash("sha256").update(content).digest("hex") : undefined
    };
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return null;
    }
    throw caught;
  }
}

async function collectMarkdownFingerprints(
  rootPath: string,
  relativeRoot: string,
  snapshot: PackageFingerprintSnapshot
): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return;
    }
    throw caught;
  }

  for (const entry of entries) {
    const path = join(rootPath, entry.name);
    const relativePath = toPosixPath(join(relativeRoot, entry.name));
    if (entry.isDirectory()) {
      await collectMarkdownFingerprints(path, relativePath, snapshot);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const fingerprint = await fingerprintIfPresent(path, true);
      if (fingerprint) {
        snapshot.set(relativePath, fingerprint);
      }
    }
  }
}

async function collectWatchedPackageFingerprints(workspace: TaskCanvasWorkspace): Promise<PackageFingerprintSnapshot> {
  const snapshot: PackageFingerprintSnapshot = new Map();
  const manifestFingerprint = await fingerprintIfPresent(workspace.manifestFile);
  if (manifestFingerprint) {
    snapshot.set("package/manifest.json", manifestFingerprint);
  }
  const projectPromptFingerprint = await fingerprintIfPresent(workspace.projectPromptFile, true);
  if (projectPromptFingerprint) {
    snapshot.set("policy/project-prompt.md", projectPromptFingerprint);
  }
  await collectMarkdownFingerprints(join(workspace.packageDir, "nodes"), "package/nodes", snapshot);
  return snapshot;
}

function changedFingerprint(left: PackageFileFingerprint | undefined, right: PackageFileFingerprint | undefined): boolean {
  return left?.mtimeMs !== right?.mtimeMs || left?.size !== right?.size || left?.hash !== right?.hash;
}

function diffWatchedPackageSnapshots(
  previous: PackageFingerprintSnapshot,
  next: PackageFingerprintSnapshot
): string[] {
  const paths = new Set([...previous.keys(), ...next.keys()]);
  return [...paths].filter((path) => changedFingerprint(previous.get(path), next.get(path)));
}

function warnPollingSnapshotFailure(workspaceRoot: string, caught: unknown): void {
  console.warn(`PlanWeave package polling watch failed for '${workspaceRoot}': ${caught instanceof Error ? caught.message : String(caught)}`);
}

function watchRoot(rootPath: string, relativeRoot: string, coarsePath: string, recordChange: (path: string) => void): FSWatcher | null {
  if (!existsSync(rootPath)) {
    return null;
  }
  const onChange = (_eventType: string, filename: string | Buffer | null) => {
    if (!filename) {
      recordChange(coarsePath);
      return;
    }
    recordChange(toPosixPath(join(relativeRoot, filename.toString())));
  };
  return watch(rootPath, { recursive: true }, onChange);
}

function startNativePackageWatchBackend(
  workspace: TaskCanvasWorkspace,
  recordChange: (path: string) => void
): PackageWatchBackend | null {
  const watchers: FSWatcher[] = [];
  const roots = [
    { rootPath: workspace.packageDir, relativeRoot: "package", coarsePath: "package/manifest.json" },
    { rootPath: dirname(workspace.projectPromptFile), relativeRoot: "policy", coarsePath: "policy/project-prompt.md" },
    { rootPath: join(workspace.packageDir, "nodes"), relativeRoot: "package/nodes", coarsePath: "package/manifest.json" }
  ];
  try {
    for (const root of roots) {
      const watcher = watchRoot(root.rootPath, root.relativeRoot, root.coarsePath, recordChange);
      if (watcher) {
        watchers.push(watcher);
      }
    }
  } catch {
    for (const watcher of watchers) {
      watcher.close();
    }
    return null;
  }
  if (watchers.length === 0) {
    return null;
  }
  return {
    kind: "native",
    watchers,
    pollTimer: null,
    lastSnapshot: null
  };
}

async function startPollingPackageWatchBackend(
  workspace: TaskCanvasWorkspace,
  recordChange: (path: string) => void
): Promise<PackageWatchBackend> {
  let lastSnapshot: PackageFingerprintSnapshot = new Map();
  try {
    lastSnapshot = await collectWatchedPackageFingerprints(workspace);
  } catch (caught) {
    warnPollingSnapshotFailure(workspace.workspaceRoot, caught);
    setTimeout(() => recordChange("package/manifest.json"), 0);
  }
  const backend: PackageWatchBackend = {
    kind: "polling",
    watchers: [],
    pollTimer: null,
    lastSnapshot
  };
  const poll = async () => {
    try {
      const nextSnapshot = await collectWatchedPackageFingerprints(workspace);
      const previousSnapshot = backend.lastSnapshot ?? new Map();
      for (const changedPath of diffWatchedPackageSnapshots(previousSnapshot, nextSnapshot)) {
        recordChange(changedPath);
      }
      backend.lastSnapshot = nextSnapshot;
    } catch (caught) {
      warnPollingSnapshotFailure(workspace.workspaceRoot, caught);
      recordChange("package/manifest.json");
    }
  };
  backend.pollTimer = setInterval(() => {
    void poll();
  }, packageWatchPollIntervalMs);
  return backend;
}

async function startPackageWatchBackend(
  workspace: TaskCanvasWorkspace,
  recordChange: (path: string) => void
): Promise<PackageWatchBackend> {
  return startNativePackageWatchBackend(workspace, recordChange) ?? (await startPollingPackageWatchBackend(workspace, recordChange));
}

function addPendingPackageWatchSubscriber(key: string, webContents: WebContents): void {
  const subscribers = pendingPackageWatchSubscribers.get(key) ?? new Map<number, WebContents>();
  subscribers.set(webContents.id, webContents);
  pendingPackageWatchSubscribers.set(key, subscribers);
}

function removePendingPackageWatchSubscriber(key: string, webContentsId: number): void {
  const subscribers = pendingPackageWatchSubscribers.get(key);
  if (!subscribers) {
    return;
  }
  subscribers.delete(webContentsId);
  if (subscribers.size === 0) {
    pendingPackageWatchSubscribers.delete(key);
  }
}

function hasPendingPackageWatchSubscribers(key: string): boolean {
  return (pendingPackageWatchSubscribers.get(key)?.size ?? 0) > 0;
}

function hasPendingPackageWatchSubscriber(key: string, webContentsId: number): boolean {
  return pendingPackageWatchSubscribers.get(key)?.has(webContentsId) ?? false;
}

function closePackageWatch(activeWatch: PackageWatch): void {
  if (activeWatch.closed) {
    return;
  }
  activeWatch.closed = true;
  for (const subscriber of activeWatch.subscribers.values()) {
    subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  }
  activeWatch.subscribers.clear();
  for (const watcher of activeWatch.backend.watchers) {
    watcher.close();
  }
  if (activeWatch.backend.pollTimer) {
    clearInterval(activeWatch.backend.pollTimer);
  }
  if (activeWatch.timer) {
    clearTimeout(activeWatch.timer);
  }
}

async function getOrCreatePackageWatch(
  key: string,
  projectRoot: string,
  canvasId: string | null | undefined
): Promise<PackageWatch> {
  const activeWatch = packageWatches.get(key);
  if (activeWatch) {
    return activeWatch;
  }
  const pendingStart = pendingPackageWatchStarts.get(key);
  if (pendingStart) {
    return pendingStart;
  }
  const start = (async () => {
    const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
    const recordChange = (path: string) => {
      const currentWatch = packageWatches.get(key);
      if (!currentWatch) {
        return;
      }
      currentWatch.changedPaths.add(path);
      if (currentWatch.timer) {
        clearTimeout(currentWatch.timer);
      }
      currentWatch.timer = setTimeout(() => flushPackageFileChange(projectRoot, canvasId), packageWatchDebounceMs);
    };
    const backend = await startPackageWatchBackend(workspace, recordChange);
    const createdWatch: PackageWatch = {
      backend,
      subscribers: new Map(),
      changedPaths: new Set(),
      timer: null,
      closed: false
    };
    if (!hasPendingPackageWatchSubscribers(key)) {
      closePackageWatch(createdWatch);
      return createdWatch;
    }
    packageWatches.set(key, createdWatch);
    return createdWatch;
  })();
  pendingPackageWatchStarts.set(key, start);
  try {
    return await start;
  } finally {
    pendingPackageWatchStarts.delete(key);
  }
}

function flushPackageFileChange(projectRoot: string, canvasId?: string | null): void {
  const activeWatch = packageWatches.get(watchKey(projectRoot, canvasId));
  if (!activeWatch) {
    return;
  }
  activeWatch.timer = null;
  const paths = [...activeWatch.changedPaths].filter(shouldNotifyPackagePath);
  activeWatch.changedPaths.clear();
  if (paths.length === 0) {
    return;
  }
  const payload: DesktopPackageFileChangeEvent = {
    projectRoot,
    canvasId: canvasId ?? null,
    paths,
    changedPathCount: paths.length,
    backendKind: activeWatch.backend.kind,
    triggeredAt: new Date().toISOString()
  };
  for (const subscriber of activeWatch.subscribers.values()) {
    if (!subscriber.webContents.isDestroyed()) {
      subscriber.webContents.send(packageFileChangedChannel, payload);
    }
  }
}

async function startPackageWatch(projectRoot: string, canvasId: string | null | undefined, webContents: WebContents): Promise<void> {
  const key = watchKey(projectRoot, canvasId);
  addPendingPackageWatchSubscriber(key, webContents);
  let activeWatch: PackageWatch;
  try {
    activeWatch = await getOrCreatePackageWatch(key, projectRoot, canvasId);
  } catch (caught) {
    removePendingPackageWatchSubscriber(key, webContents.id);
    throw caught;
  }
  if (!hasPendingPackageWatchSubscriber(key, webContents.id) || webContents.isDestroyed()) {
    removePendingPackageWatchSubscriber(key, webContents.id);
    if (activeWatch.subscribers.size === 0 && !hasPendingPackageWatchSubscribers(key)) {
      closePackageWatch(activeWatch);
      if (packageWatches.get(key) === activeWatch) {
        packageWatches.delete(key);
      }
    }
    return;
  }
  if (!activeWatch.subscribers.has(webContents.id)) {
    const onDestroyed = () => stopPackageWatch(projectRoot, canvasId, webContents);
    activeWatch.subscribers.set(webContents.id, { webContents, onDestroyed });
    webContents.once("destroyed", onDestroyed);
  }
  removePendingPackageWatchSubscriber(key, webContents.id);
}

function stopPackageWatch(projectRoot: string, canvasId: string | null | undefined, webContents: WebContents): void {
  const key = watchKey(projectRoot, canvasId);
  removePendingPackageWatchSubscriber(key, webContents.id);
  const activeWatch = packageWatches.get(key);
  if (!activeWatch) {
    return;
  }
  const subscriber = activeWatch.subscribers.get(webContents.id);
  if (!subscriber) {
    if (activeWatch.subscribers.size === 0 && !hasPendingPackageWatchSubscribers(key)) {
      closePackageWatch(activeWatch);
      packageWatches.delete(key);
    }
    return;
  }
  activeWatch.subscribers.delete(webContents.id);
  subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  if (activeWatch.subscribers.size > 0) {
    return;
  }
  if (hasPendingPackageWatchSubscribers(key)) {
    return;
  }
  closePackageWatch(activeWatch);
  packageWatches.delete(key);
}

export function registerPackageWatchHandlers(): void {
  ipcMain.handle(desktopBridgeInvokeChannels.watchPackageFiles, (event, ref: DesktopCanvasReference) => startPackageWatch(ref.projectRoot, ref.canvasId, event.sender));
  ipcMain.handle(desktopBridgeInvokeChannels.unwatchPackageFiles, (event, ref: DesktopCanvasReference) => stopPackageWatch(ref.projectRoot, ref.canvasId, event.sender));
}
