import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsStore } from "../../../desktop/src/main/desktopSettingsStore.js";
import { linkProjectSourceRoot, renameProject } from "../desktop/projectApi.js";
import { setSourceDefaultProject } from "../desktop/sourceDefaultProject.js";
import * as projectLocks from "../fs/withProjectMutationLock.js";
import { initManagedWorkspace } from "../initWorkspace.js";
import { createManagedProjectId } from "../projectId.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    )
    .finally(() => {
      settled = true;
    });
  return { outcome, isSettled: () => settled };
}

async function tree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      entries[`${entry.name}/`] = "directory";
      for (const [name, bytes] of Object.entries(await tree(path))) {
        entries[`${entry.name}/${name}`] = bytes;
      }
    } else {
      entries[entry.name] = (await readFile(path)).toString("base64");
    }
  }
  return entries;
}

async function fixture(sameIdInB: boolean, targetConflict: boolean) {
  const owner = await mkdtemp(join(tmpdir(), "pw-rename-home-admission-"));
  directories.push(owner);
  const homeA = join(owner, "home-a");
  const homeB = join(owner, "home-b");
  const sourceRoot = join(owner, "source");
  await Promise.all([mkdir(homeA), mkdir(homeB), mkdir(sourceRoot)]);
  const settings = new DesktopSettingsStore({
    settingsFile: join(owner, "settings.json"),
    planweaveHomeBaseline: homeA
  });
  await settings.mergePatch({ planweaveHome: homeA });
  const holder = await initManagedWorkspace({ name: "Admission Holder", projectGraph: true });
  const target = await initManagedWorkspace({ name: "Queued Project", projectGraph: true });
  await linkProjectSourceRoot(target.project.id, sourceRoot);
  await setSourceDefaultProject(sourceRoot, target.project.id);
  await writeFile(join(target.workspace.resultsDir, "history.txt"), "A history\n");
  if (targetConflict) {
    await initManagedWorkspace({ name: "Queued Project Renamed", projectGraph: true });
  }
  await settings.mergePatch({ planweaveHome: homeB });
  const other = await initManagedWorkspace({
    name: sameIdInB ? "Queued Project" : "Unrelated B Project",
    projectGraph: true
  });
  await linkProjectSourceRoot(other.project.id, sourceRoot);
  await setSourceDefaultProject(sourceRoot, other.project.id);
  await writeFile(join(other.workspace.resultsDir, "history.txt"), "B history\n");
  const projectsBeforeB = await tree(join(homeB, "projects"));
  const defaultsBeforeB = await readFile(join(homeB, "source-defaults.json"), "utf8");
  const targetBeforeA = await tree(target.workspace.workspaceRoot);
  const defaultsBeforeA = await readFile(join(homeA, "source-defaults.json"), "utf8");
  await settings.mergePatch({ planweaveHome: homeA });
  return {
    homeA,
    homeB,
    settings,
    holder,
    target,
    sourceRoot,
    projectsBeforeB,
    defaultsBeforeB,
    targetBeforeA,
    defaultsBeforeA
  };
}

describe("managed project rename Home admission", () => {
  it.each([
    { sameIdInB: true, targetConflict: false, holderFails: false },
    { sameIdInB: false, targetConflict: false, holderFails: false },
    { sameIdInB: true, targetConflict: true, holderFails: false },
    { sameIdInB: true, targetConflict: false, holderFails: true }
  ])("keeps queued rename in A with $sameIdInB same id in B, target conflict $targetConflict, prior failure $holderFails", async (testCase) => {
    const f = await fixture(testCase.sameIdInB, testCase.targetConflict);
    const entered = deferred();
    const release = deferred();
    const holding = projectLocks.withProjectMutationLock(
      f.holder.workspace.workspaceRoot,
      async () => {
        entered.resolve();
        await release.promise;
      }
    );
    const realProjectLock = projectLocks.withProjectMutationLock;
    const holderWaiting = deferred();
    let renameLockRequests = 0;
    vi.spyOn(projectLocks, "withProjectMutationLock").mockImplementation((roots, fn, options) => {
      if (options?.operation === "rename-project") {
        renameLockRequests += 1;
        holderWaiting.resolve();
      }
      return realProjectLock(roots, fn, options);
    });
    let first: ReturnType<typeof observe<Awaited<ReturnType<typeof renameProject>>>> | undefined;
    let queued: typeof first;
    try {
      await entered.promise;
      first = observe(renameProject(f.holder.project.id, "Admission Holder Renamed"));
      await holderWaiting.promise;
      queued = observe(renameProject(f.target.project.id, "Queued Project Renamed"));
      await delay(10);
      expect(first.isSettled()).toBe(false);
      expect(queued.isSettled()).toBe(false);
      expect(renameLockRequests).toBe(1);
      if (testCase.holderFails) {
        await mkdir(join(f.homeA, "projects", createManagedProjectId("Admission Holder Renamed")));
      }
      await f.settings.mergePatch({ planweaveHome: f.homeB });
      release.resolve();
      await holding;
      const firstResult = await first.outcome;
      expect(firstResult.status).toBe(testCase.holderFails ? "rejected" : "fulfilled");
      if (firstResult.status === "rejected") {
        expect(firstResult.reason).toBeInstanceOf(Error);
        expect(String(firstResult.reason)).toContain("already exists");
      }
      const result = await queued.outcome;
      const nextId = createManagedProjectId("Queued Project Renamed");
      const nextRoot = join(f.homeA, "projects", nextId);
      if (testCase.targetConflict) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(String(result.reason)).toContain("already exists");
        expect(await tree(f.target.workspace.workspaceRoot)).toEqual(f.targetBeforeA);
        expect(await readFile(join(f.homeA, "source-defaults.json"), "utf8")).toBe(
          f.defaultsBeforeA
        );
      } else {
        expect(result).toMatchObject({
          status: "fulfilled",
          value: { projectId: nextId, rootPath: nextRoot }
        });
        await expect(readFile(f.target.workspace.projectFile)).rejects.toMatchObject({
          code: "ENOENT"
        });
        expect(
          await readFile(join(nextRoot, "canvases", "default", "results", "history.txt"), "utf8")
        ).toBe("A history\n");
        const defaults = JSON.parse(await readFile(join(f.homeA, "source-defaults.json"), "utf8"));
        expect(Object.values(defaults.defaults)).toEqual([
          expect.objectContaining({ projectId: nextId, projectRoot: nextRoot })
        ]);
      }
      expect(await tree(join(f.homeB, "projects"))).toEqual(f.projectsBeforeB);
      expect(await readFile(join(f.homeB, "source-defaults.json"), "utf8")).toBe(f.defaultsBeforeB);
    } finally {
      release.resolve();
      await Promise.allSettled([
        holding,
        ...(first ? [first.outcome] : []),
        ...(queued ? [queued.outcome] : [])
      ]);
    }
  });
});
