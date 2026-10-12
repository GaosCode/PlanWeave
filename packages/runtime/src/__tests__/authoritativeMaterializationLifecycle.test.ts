import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as locks from "../fs/advisoryDirectoryLock.js";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { captureAuthorizedCanvasContent } from "../desktop/authorizedCanvasContent.js";
import {
  materializeAuthoritativeCanvasWorkspace,
  recoverPendingAuthoritativeCanvasMaterialization,
  withAuthoritativeCanvasWorkspaceLock
} from "../desktop/contentVersionMaterializer.js";
import { initWorkspace, initManagedWorkspace } from "../initWorkspace.js";
import * as initialization from "../initWorkspace.js";
import { createManagedProjectId } from "../projectId.js";
import { createManagedProjectFromAuthoritativeContent } from "../desktop/contentVersionMaterializer.js";
import { removeProject } from "../desktop/projectApi.js";
import type { ProjectWorkspace } from "../types.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettings;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".planweave.lock") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(await tree(path)))
        files[`${entry.name}/${name}`] = bytes;
    } else files[entry.name] = (await readFile(path)).toString("base64");
  }
  return files;
}

async function artifacts(workspace: ProjectWorkspace) {
  return {
    package: await tree(workspace.packageDir),
    state: await readFile(workspace.stateFile, "utf8"),
    results: await tree(workspace.resultsDir),
    receipt: await readFile(join(workspace.workspaceRoot, "authority-content-target.json"), "utf8"),
    desktop: await tree(join(workspace.workspaceRoot, "desktop"))
  };
}

describe("authoritative materialization captured owner lifetime", () => {
  it.each([
    false,
    true
  ])("serializes managed import and rollback before replacement (reserved=%s)", async (reserved) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const { content } = await captureAuthorizedCanvasContent({
      projectRoot: fixture.init.workspace
    });
    const name = "Concurrent managed import";
    const id = createManagedProjectId(name);
    const root = join(fixture.home, "projects", id);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initialize = initialization.initManagedWorkspace;
    let captured = false;
    vi.spyOn(initialization, "initManagedWorkspace").mockImplementation(async (options) => {
      const result = await initialize(options);
      if (options.name === name && !captured) {
        captured = true;
        entered();
        await held;
      }
      return result;
    });
    const creation = createManagedProjectFromAuthoritativeContent({
      authorityProjectId: "different-authority-layout-owner",
      projectName: name,
      content,
      ...(reserved ? { reservationToken: "test-reservation" } : {})
    });
    const outcome = creation.then(
      () => "created",
      () => "rejected"
    );
    await started;
    const replacement = withProjectMutationLock(root, async () => {
      await removeProject(id);
      return initManagedWorkspace({ name, projectGraph: true });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(
        await Promise.race([
          replacement.then(() => "replaced"),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("waiting"), 50);
          })
        ])
      ).toBe("waiting");
      release();
      expect(await outcome).toBe("rejected");
      const fresh = await replacement;
      expect(JSON.parse(await readFile(fresh.workspace.manifestFile, "utf8")).nodes).toEqual([]);
      expect(await readFile(fresh.workspace.projectFile, "utf8")).toContain(
        fresh.workspace.projectCreatedAt
      );
    } finally {
      clearTimeout(timer);
      release();
      await Promise.allSettled([creation, replacement]);
    }
  });
  it("does not let a queued removal delete a recreated project", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const old = fixture.init.workspace;
    let entered!: () => void;
    let release!: () => void;
    let queued!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const removalQueued = new Promise<void>((resolve) => {
      queued = resolve;
    });
    let watchRemoval = false;
    const lock = locks.withAdvisoryDirectoryLock;
    vi.spyOn(locks, "withAdvisoryDirectoryLock").mockImplementation((options, operation) => {
      const pending = lock(options, operation);
      if (watchRemoval && options.operation === "project-mutation") queued();
      return pending;
    });
    const replacement = withProjectMutationLock(old.workspaceRoot, async () => {
      entered();
      await held;
      await removeProject(old.id);
      return (await initWorkspace({ projectRoot: fixture.root })).workspace;
    });
    await started;
    watchRemoval = true;
    const removal = removeProject(old.id);
    try {
      await removalQueued;
      release();
      await expect(removal).rejects.toThrow(/identity changed/);
      const fresh = await replacement;
      expect(JSON.parse(await readFile(fresh.manifestFile, "utf8")).nodes).toEqual([]);
      expect(await readFile(fresh.projectFile, "utf8")).toContain(fresh.projectCreatedAt);
    } finally {
      release();
      await Promise.allSettled([replacement, removal]);
    }
  });
  it.each([
    "resetPackage",
    "resetResults",
    "recreate"
  ] as const)("rejects every old authority writer after %s without changing new artifacts", async (retirement) => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const old = fixture.init.workspace;
    const { content } = await captureAuthorizedCanvasContent({ projectRoot: old });
    if (retirement === "recreate") await removeProject(old.id);
    const fresh = (
      await initWorkspace({
        projectRoot: fixture.root,
        ...(retirement === "recreate" ? {} : { [retirement]: true })
      })
    ).workspace;
    await writeFile(join(fresh.resultsDir, "new-result.txt"), "new generation\n");
    await writeFile(join(fresh.workspaceRoot, "authority-content-target.json"), "new receipt\n");
    const staged = join(fresh.workspaceRoot, "new-staged-result.txt");
    await writeFile(staged, "committed new result\n");
    const transaction = await ImportTransaction.create({ workspaceRoot: fresh.workspaceRoot });
    await transaction.replacePath(join(fresh.resultsDir, "new-result.txt"), staged);
    await transaction.markCommitted();
    const before = await artifacts(fresh);
    await expect(
      materializeAuthoritativeCanvasWorkspace({ workspace: old, content })
    ).rejects.toThrow(/identity changed/);
    await expect(recoverPendingAuthoritativeCanvasMaterialization(old)).rejects.toThrow(
      /identity changed/
    );
    await expect(
      withAuthoritativeCanvasWorkspaceLock(old, () =>
        writeFile(join(old.workspaceRoot, "authority-content-target.json"), "retired receipt\n")
      )
    ).rejects.toThrow(/identity changed/);
    expect(await artifacts(fresh)).toEqual(before);
  });

  it("does not admit a retired workspace through a reentrant authority boundary", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const old = fixture.init.workspace;
    const { content } = await captureAuthorizedCanvasContent({ projectRoot: old });
    const fresh = (await initWorkspace({ projectRoot: fixture.root, resetResults: true }))
      .workspace;
    await mkdir(join(fresh.workspaceRoot, "desktop"), { recursive: true });
    await writeFile(join(fresh.workspaceRoot, "authority-content-target.json"), "new receipt\n");
    const before = await artifacts(fresh);
    await withAuthoritativeCanvasWorkspaceLock(fresh, async () => {
      await expect(
        materializeAuthoritativeCanvasWorkspace({ workspace: old, content })
      ).rejects.toThrow(/identity changed/);
      await expect(recoverPendingAuthoritativeCanvasMaterialization(old)).rejects.toThrow(
        /identity changed/
      );
    });
    expect(await artifacts(fresh)).toEqual(before);
  });

  it("serializes project removal after an admitted authority operation", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const workspace = fixture.init.workspace;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const operation = withAuthoritativeCanvasWorkspaceLock(workspace, async () => {
      entered();
      await held;
      await writeFile(join(workspace.resultsDir, "admitted-result.txt"), "admitted\n");
    });
    await started;
    const removal = removeProject(workspace.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        removal.then(() => "removed"),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("waiting"), 50);
        })
      ]);
      expect(outcome).toBe("waiting");
      expect(await readFile(workspace.manifestFile, "utf8")).toContain("Test Plan");
    } finally {
      clearTimeout(timer);
      release();
      await Promise.allSettled([operation, removal]);
    }
    await expect(readFile(workspace.projectFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
