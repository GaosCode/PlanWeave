import { access, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linkProjectSourceRoot,
  removeProject,
  renameProject,
  unlinkProjectSourceRoot
} from "../desktop/projectApi.js";
import * as projectLocks from "../fs/withProjectMutationLock.js";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import * as json from "../json.js";
import * as projectMetadata from "../projectMetadata.js";
import { createManagedProjectId } from "../projectId.js";
import type { ProjectMetadata } from "../types.js";

const owners: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;

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

async function fixture() {
  const owner = await mkdtemp(join(tmpdir(), "pw-project-metadata-lifecycle-"));
  owners.push(owner);
  const homeA = join(owner, "home-a");
  const homeB = join(owner, "home-b");
  const sourceDirectory = join(owner, "source");
  await Promise.all([mkdir(homeA), mkdir(homeB), mkdir(sourceDirectory)]);
  const sourceRoot = await realpath(sourceDirectory);
  process.env.PLANWEAVE_HOME = homeA;
  const managed = await initManagedWorkspace({ name: "Metadata Lifecycle", projectGraph: true });
  return { homeA, homeB, sourceRoot, managed };
}

function pauseFirstMetadataRead(projectFile: string) {
  const entered = deferred();
  const release = deferred();
  const realRead = projectMetadata.readProjectMetadataFile;
  let paused = false;
  vi.spyOn(projectMetadata, "readProjectMetadataFile").mockImplementation(async (path) => {
    const metadata = await realRead(path);
    if (path === projectFile && !paused) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return metadata;
  });
  return { entered: entered.promise, release: release.resolve };
}

async function metadata(projectFile: string): Promise<ProjectMetadata> {
  return JSON.parse(await readFile(projectFile, "utf8")) as ProjectMetadata;
}

describe("project metadata mutation lifecycle", () => {
  it("does not recreate a removed managed registry after a queued unlink", async () => {
    const f = await fixture();
    await linkProjectSourceRoot(f.managed.project.id, f.sourceRoot);
    const gate = pauseFirstMetadataRead(f.managed.workspace.projectFile);
    const unlink = observe(unlinkProjectSourceRoot(f.managed.project.id));
    try {
      await bounded(gate.entered, "unlink metadata read");
      await bounded(removeProject(f.managed.project.id), "project removal");
      gate.release();
      expect((await bounded(unlink.outcome, "queued unlink")).status).toBe("rejected");
      await expect(access(f.managed.workspace.workspaceRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      gate.release();
      await unlink.outcome;
    }
  });

  it("does not write an old managed registry after rename overtakes a queued unlink", async () => {
    const f = await fixture();
    await linkProjectSourceRoot(f.managed.project.id, f.sourceRoot);
    const nextName = "Metadata Lifecycle Renamed";
    const nextId = createManagedProjectId(nextName);
    const gate = pauseFirstMetadataRead(f.managed.workspace.projectFile);
    const unlink = observe(unlinkProjectSourceRoot(f.managed.project.id));
    try {
      await bounded(gate.entered, "unlink metadata read");
      await bounded(renameProject(f.managed.project.id, nextName), "managed rename");
      gate.release();
      expect((await bounded(unlink.outcome, "queued unlink")).status).toBe("rejected");
      await expect(access(f.managed.workspace.workspaceRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect((await metadata(join(f.homeA, "projects", nextId, "project.json"))).sourceRoot).toBe(
        f.sourceRoot
      );
    } finally {
      gate.release();
      await unlink.outcome;
    }
  });

  it("does not recreate an external registry after remove overtakes its rename", async () => {
    const f = await fixture();
    const externalRoot = join(f.homeA, "..", "external-source");
    await mkdir(externalRoot);
    const external = await initWorkspace({ projectRoot: externalRoot, projectGraph: true });
    const gate = pauseFirstMetadataRead(external.workspace.projectFile);
    const renaming = observe(renameProject(external.project.id, "Deleted External Project"));
    try {
      await bounded(gate.entered, "external rename metadata read");
      await bounded(removeProject(external.project.id), "external registry removal");
      gate.release();
      expect((await bounded(renaming.outcome, "queued external rename")).status).toBe("rejected");
      await expect(access(external.workspace.workspaceRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(access(externalRoot)).resolves.toBeUndefined();
    } finally {
      gate.release();
      await renaming.outcome;
    }
  });

  it("renames an external registry while its source directory is temporarily unavailable", async () => {
    const f = await fixture();
    const externalRoot = join(f.homeA, "..", "offline-external-source");
    const movedRoot = join(f.homeA, "..", "offline-external-source-moved");
    await mkdir(externalRoot);
    const external = await initWorkspace({ projectRoot: externalRoot, projectGraph: true });
    await rename(externalRoot, movedRoot);
    await expect(access(externalRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const nextName = "Offline External Display Name";
    await expect(renameProject(external.project.id, nextName)).resolves.toMatchObject({
      projectId: external.project.id,
      name: nextName,
      kind: "external",
      rootPath: external.project.rootPath,
      workspaceRoot: external.workspace.workspaceRoot
    });
    await expect(metadata(external.workspace.projectFile)).resolves.toMatchObject({
      id: external.project.id,
      name: nextName,
      rootPath: external.project.rootPath,
      kind: "external"
    });
    await expect(access(movedRoot)).resolves.toBeUndefined();
  });

  it("serializes a managed link with relocation before writing its old project file", async () => {
    const f = await fixture();
    const nextName = "Linked Metadata Renamed";
    const nextId = createManagedProjectId(nextName);
    const entered = deferred();
    const release = deferred();
    const realWrite = json.writeJsonFile;
    let paused = false;
    vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value, options) => {
      if (path === f.managed.workspace.projectFile && !paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return realWrite(path, value, options);
    });
    const linking = observe(linkProjectSourceRoot(f.managed.project.id, f.sourceRoot));
    let renaming: ReturnType<typeof observe<Awaited<ReturnType<typeof renameProject>>>> | undefined;
    try {
      await bounded(entered.promise, "link metadata write");
      renaming = observe(renameProject(f.managed.project.id, nextName));
      await Promise.race([renaming.outcome, delay(300)]);
      release.resolve();
      expect((await bounded(linking.outcome, "managed link")).status).toBe("fulfilled");
      expect((await bounded(renaming.outcome, "managed rename")).status).toBe("fulfilled");
      await expect(access(f.managed.workspace.workspaceRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect((await metadata(join(f.homeA, "projects", nextId, "project.json"))).sourceRoot).toBe(
        f.sourceRoot
      );
    } finally {
      release.resolve();
      await Promise.allSettled([linking.outcome, renaming?.outcome]);
    }
  });

  it.each([
    "link",
    "unlink"
  ] as const)("holds the captured Home and project parent lock for a %s mutation", async (operation) => {
    const f = await fixture();
    if (operation === "unlink") await linkProjectSourceRoot(f.managed.project.id, f.sourceRoot);
    process.env.PLANWEAVE_HOME = f.homeB;
    const other = await initManagedWorkspace({ name: "Metadata Lifecycle", projectGraph: true });
    process.env.PLANWEAVE_HOME = f.homeA;
    const beforeB = await readFile(other.workspace.projectFile, "utf8");
    const entered = deferred();
    const release = deferred();
    const holding = projectLocks.withProjectMutationLock(
      f.managed.workspace.workspaceRoot,
      async () => {
        entered.resolve();
        await release.promise;
      }
    );
    let mutation:
      | ReturnType<typeof observe<Awaited<ReturnType<typeof linkProjectSourceRoot>>>>
      | undefined;
    try {
      await bounded(entered.promise, "parent lock holder");
      mutation = observe(
        operation === "link"
          ? linkProjectSourceRoot(f.managed.project.id, f.sourceRoot)
          : unlinkProjectSourceRoot(f.managed.project.id)
      );
      process.env.PLANWEAVE_HOME = f.homeB;
      await delay(75);
      expect(mutation.isSettled()).toBe(false);
      expect(await readFile(other.workspace.projectFile, "utf8")).toBe(beforeB);
      release.resolve();
      await bounded(holding, "parent lock holder release");
      expect((await bounded(mutation.outcome, "metadata mutation")).status).toBe("fulfilled");
      expect((await metadata(f.managed.workspace.projectFile)).sourceRoot).toBe(
        operation === "link" ? f.sourceRoot : null
      );
      expect(await readFile(other.workspace.projectFile, "utf8")).toBe(beforeB);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, mutation?.outcome]);
    }
  });
});
