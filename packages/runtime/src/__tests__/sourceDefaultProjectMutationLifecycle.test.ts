import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkProjectSourceRoot, renameProject } from "../desktop/projectApi.js";
import {
  clearSourceDefaultProject,
  getSourceDefaultProject,
  resolveSourceDefaultProjectRoot,
  setSourceDefaultProject
} from "../desktop/sourceDefaultProject.js";
import { initManagedWorkspace } from "../initWorkspace.js";
import * as json from "../json.js";
import { createManagedProjectId } from "../projectId.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const owners: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation((from, to) => actual.rename(from, to));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  await Promise.all(owners.splice(0).map((owner) => rm(owner, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason })
  );
}

async function fixture() {
  const owner = await mkdtemp(join(tmpdir(), "pw-source-default-lifecycle-"));
  owners.push(owner);
  const home = join(owner, "home");
  const sourceA = join(owner, "source-a");
  const sourceB = join(owner, "source-b");
  await Promise.all([mkdir(home), mkdir(sourceA), mkdir(sourceB)]);
  process.env.PLANWEAVE_HOME = home;
  const first = await initManagedWorkspace({ name: "Default First", projectGraph: true });
  const second = await initManagedWorkspace({ name: "Default Second", projectGraph: true });
  await linkProjectSourceRoot(first.project.id, sourceA);
  await linkProjectSourceRoot(second.project.id, sourceB);
  return { home, sourceA, sourceB, first, second };
}

function pauseNextDefaultsWrite(home: string) {
  const entered = deferred();
  const release = deferred();
  const defaultsPath = join(home, "source-defaults.json");
  const realWrite = json.writeJsonFile;
  let paused = false;
  vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value, options) => {
    if (path === defaultsPath && !paused) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return realWrite(path, value, options);
  });
  return { entered: entered.promise, release: release.resolve };
}

describe("source default project mutation lifecycle", () => {
  it("does not restore an old project id when set races a managed rename", async () => {
    const f = await fixture();
    await setSourceDefaultProject(f.sourceA, f.first.project.id);
    const nextName = "Default First Renamed";
    const nextId = createManagedProjectId(nextName);
    const nextRoot = join(f.home, "projects", nextId);
    const gate = pauseNextDefaultsWrite(f.home);
    const setting = observe(setSourceDefaultProject(f.sourceA, f.first.project.id));
    let renaming: ReturnType<typeof observe<Awaited<ReturnType<typeof renameProject>>>> | undefined;
    try {
      await bounded(gate.entered, "old project default write");
      renaming = observe(renameProject(f.first.project.id, nextName));
      await Promise.race([renaming, delay(300)]);
      gate.release();
      expect((await bounded(setting, "old project default set")).status).toBe("fulfilled");
      expect((await bounded(renaming, "managed rename")).status).toBe("fulfilled");
      await expect(getSourceDefaultProject(f.sourceA)).resolves.toMatchObject({
        projectId: nextId,
        projectRoot: nextRoot
      });
      await expect(resolveSourceDefaultProjectRoot(f.sourceA)).resolves.toBe(nextRoot);
    } finally {
      gate.release();
      await Promise.allSettled([setting, renaming]);
    }
  });

  it("preserves defaults for two sources when their writes overlap", async () => {
    const f = await fixture();
    const gate = pauseNextDefaultsWrite(f.home);
    const first = observe(setSourceDefaultProject(f.sourceA, f.first.project.id));
    let second:
      | ReturnType<typeof observe<Awaited<ReturnType<typeof setSourceDefaultProject>>>>
      | undefined;
    try {
      await bounded(gate.entered, "first source default write");
      second = observe(setSourceDefaultProject(f.sourceB, f.second.project.id));
      await Promise.race([second, delay(300)]);
      gate.release();
      expect((await bounded(first, "first source default")).status).toBe("fulfilled");
      expect((await bounded(second, "second source default")).status).toBe("fulfilled");
      await expect(getSourceDefaultProject(f.sourceA)).resolves.toMatchObject({
        projectId: f.first.project.id
      });
      await expect(getSourceDefaultProject(f.sourceB)).resolves.toMatchObject({
        projectId: f.second.project.id
      });
    } finally {
      gate.release();
      await Promise.allSettled([first, second]);
    }
  });

  it("does not erase another source's new default when clear overlaps set", async () => {
    const f = await fixture();
    await setSourceDefaultProject(f.sourceA, f.first.project.id);
    const gate = pauseNextDefaultsWrite(f.home);
    const clearing = observe(clearSourceDefaultProject(f.sourceA));
    let setting:
      | ReturnType<typeof observe<Awaited<ReturnType<typeof setSourceDefaultProject>>>>
      | undefined;
    try {
      await bounded(gate.entered, "source default clear write");
      setting = observe(setSourceDefaultProject(f.sourceB, f.second.project.id));
      await Promise.race([setting, delay(300)]);
      gate.release();
      expect((await bounded(clearing, "source default clear")).status).toBe("fulfilled");
      expect((await bounded(setting, "other source default set")).status).toBe("fulfilled");
      await expect(getSourceDefaultProject(f.sourceA)).resolves.toBeNull();
      await expect(getSourceDefaultProject(f.sourceB)).resolves.toMatchObject({
        projectId: f.second.project.id
      });
    } finally {
      gate.release();
      await Promise.allSettled([clearing, setting]);
    }
  });

  it("keeps a renamed project and source default aligned when the index lock release fails", async () => {
    const f = await fixture();
    await setSourceDefaultProject(f.sourceA, f.first.project.id);
    const nextName = "Default First After Release Failure";
    const nextId = createManagedProjectId(nextName);
    const nextRoot = join(f.home, "projects", nextId);
    const indexLockPath = join(f.home, "locks", "source-defaults.lock");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let injected = false;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (
        !injected &&
        from === indexLockPath &&
        typeof to === "string" &&
        to.startsWith(`${indexLockPath}.release-`)
      ) {
        injected = true;
        throw Object.assign(new Error("simulated source default lock release failure"), {
          code: "EIO"
        });
      }
      return actual.rename(from, to);
    });

    await expect(renameProject(f.first.project.id, nextName)).rejects.toThrow(
      "simulated source default lock release failure"
    );
    expect(injected).toBe(true);
    await expect(access(f.first.workspace.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(nextRoot)).resolves.toBeUndefined();
    await expect(getSourceDefaultProject(f.sourceA)).resolves.toMatchObject({
      projectId: nextId,
      projectRoot: nextRoot
    });
    await expect(resolveSourceDefaultProjectRoot(f.sourceA)).resolves.toBe(nextRoot);
  });
});
