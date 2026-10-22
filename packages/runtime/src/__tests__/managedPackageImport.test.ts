import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLatestAutoRunSummaryWithDiagnostics } from "../desktop/runApi.js";
import { getDesktopProjectSnapshot } from "../desktop/graphApi.js";
import {
  listPendingImportRecoveries,
  rollbackPendingImportRecovery
} from "../desktop/importRecoveryApi.js";
import { importTransactionIdentityDigest } from "../package/importTransactionContent.js";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { selectTaskCanvas } from "../desktop/canvasSelectionApi.js";
import { authoritativeImportReservationFile, initialManifest } from "../initWorkspace.js";
import {
  listPendingImportTransactions,
  rollbackPendingImportTransaction
} from "../package/importRecovery.js";
import { importManagedPackage } from "../package/managedPackageImport.js";
import { createManagedProjectId } from "../projectId.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    rename: vi.fn(actual.rename),
    stat: vi.fn(actual.stat)
  };
});

let home: string;
let draftRoot: string;
const name = "Lifecycle import";

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "planweave-managed-import-")));
  draftRoot = join(home, "draft");
  await mkdir(draftRoot);
  await writeFile(join(draftRoot, "manifest.json"), JSON.stringify(initialManifest("Incoming")));
  vi.stubEnv("PLANWEAVE_HOME", home);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

it("imports through a Home directory alias without inventing an outside migration path", async () => {
  const alias = `${home}-alias`;
  await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    vi.stubEnv("PLANWEAVE_HOME", alias);
    const imported = await runImport();
    expect(imported.validation.ok).toBe(true);
    const selected = await resolveTaskCanvasWorkspace(imported.workspace.rootPath, "default");
    expect(await readFile(selected.manifestFile, "utf8")).toBe(
      await readFile(join(draftRoot, "manifest.json"), "utf8")
    );
    const view = await getDesktopProjectSnapshot({
      projectRoot: imported.workspace.rootPath,
      canvasId: "default"
    });
    expect(view.graph).toEqual(
      expect.objectContaining({ projectId: imported.workspace.id, tasks: expect.any(Array) })
    );
  } finally {
    await rm(alias, { recursive: true, force: true });
  }
});

function runImport(overwrite = false, projectName = name) {
  return importManagedPackage({ name: projectName, draftRoot, overwrite });
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(path, entry.name), key);
      else files[key] = (await readFile(join(path, entry.name))).toString("base64");
    }
  }
  await visit(root, "");
  return files;
}

async function failNextCommitCheckpoint(): Promise<() => boolean> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let injected = false;
  vi.mocked(rename).mockImplementation(async (source, destination) => {
    if (
      !injected &&
      String(destination).includes("/package-import/") &&
      String(destination).endsWith("/recovery.json")
    ) {
      const journal = JSON.parse(await actual.readFile(source, "utf8"));
      if (journal.state === "committed") {
        injected = true;
        throw Object.assign(new Error("commit checkpoint denied"), { code: "EIO" });
      }
    }
    return actual.rename(source, destination);
  });
  return () => injected;
}

/** The barrier fires only when the real advisory mkdir observes a held lock. */
async function whileQueued<T>(options: {
  root: string;
  kind: "project" | "package";
  action: () => Promise<T>;
  change: () => Promise<void>;
}): Promise<T> {
  const holder = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    const root=process.argv[1], kind=process.argv[2], source=process.argv[3];
    const lock=kind==='project'
      ? (await import(source+'fs/withProjectMutationLock.ts')).withProjectMutationLock
      : (await import(source+'package/packageFileConsistency.ts')).withPackageFileConsistency;
    await lock(kind==='project'?root:[root],async()=>{
      const released=new Promise(resolve=>process.once('message',resolve));
      process.send('held');
      await released;
    });
    process.disconnect();
  `,
      options.root,
      options.kind,
      new URL("../", import.meta.url).href
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  let stderr = "";
  holder.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let failHolder!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    failHolder = reject;
  });
  const exited = new Promise<number | null>((resolve) => {
    holder.once("error", (error) => {
      failHolder(error);
      resolve(null);
    });
    holder.once("exit", (code) => {
      if (code !== 0) failHolder(new Error(`Lock holder exited ${code}: ${stderr}`));
      resolve(code);
    });
  });
  void failed.catch(() => undefined);
  const holderDeadline = setTimeout(() => {
    failHolder(new Error(`Lock holder timed out: ${stderr}`));
    holder.kill("SIGKILL");
  }, 8_000);
  try {
    await Promise.race([
      new Promise<void>((resolve) => holder.once("message", () => resolve())),
      failed
    ]);
  } catch (error) {
    clearTimeout(holderDeadline);
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    await exited;
    throw error;
  }
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const lockPath = join(
    userInfo().homedir,
    ".cache",
    "planweave",
    `${options.kind}-locks`,
    createHash("sha256")
      .update(await realpath(options.root))
      .digest("hex")
  );
  let contended!: () => void;
  const queued = new Promise<void>((resolve) => {
    contended = resolve;
  });
  vi.mocked(mkdir).mockImplementation(async (...args: Parameters<typeof mkdir>) => {
    try {
      return await actual.mkdir(...args);
    } catch (error) {
      if (
        args[0] === lockPath &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      )
        contended();
      throw error;
    }
  });
  const operation = options.action();
  void operation.catch(() => undefined);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queued,
      failed,
      operation.then(() => {
        throw new Error("Import completed before reaching held lock.");
      }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Import did not contend on held lock.")),
          5_000
        );
      })
    ]);
    await options.change();
  } finally {
    clearTimeout(deadline);
    try {
      if (holder.connected) holder.send("release");
      expect(await exited, stderr).toBe(0);
      await operation.catch(() => undefined);
    } finally {
      clearTimeout(holderDeadline);
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      await exited;
      vi.mocked(mkdir).mockImplementation(actual.mkdir);
    }
  }
  return operation;
}

describe("managed package import lifecycle", () => {
  it("overwrites the canonical default package while preserving active canvas, state, results and registration", async () => {
    const { workspace } = await runImport();
    const active = await createTaskCanvas(workspace.rootPath, { name: "Active" });
    await selectTaskCanvas(workspace.rootPath, active.canvasId);
    const activeWorkspace = await resolveTaskCanvasWorkspace(workspace, active.canvasId);
    await writeFile(join(workspace.resultsDir, "retained.txt"), "default result");
    await writeFile(join(activeWorkspace.resultsDir, "retained.txt"), "active result");
    const before = await snapshot(workspace.workspaceRoot);
    await writeFile(join(draftRoot, "fingerprint.md"), "new package");

    await runImport(true);

    const after = await snapshot(workspace.workspaceRoot);
    const prefix = "canvases/default/package/";
    expect(
      Object.fromEntries(Object.entries(after).filter(([path]) => !path.startsWith(prefix)))
    ).toEqual(
      Object.fromEntries(Object.entries(before).filter(([path]) => !path.startsWith(prefix)))
    );
    expect(await readFile(join(workspace.packageDir, "fingerprint.md"), "utf8")).toBe(
      "new package"
    );
  });

  it.each([
    "project",
    "package"
  ] as const)("rejects an identical replacement instance after waiting on the %s lock", async (kind) => {
    const { workspace } = await runImport();
    const before = await snapshot(workspace.workspaceRoot);
    let replacementInode: number | undefined;
    await expect(
      whileQueued({
        root: kind === "project" ? workspace.workspaceRoot : workspace.packageDir,
        kind,
        action: () => runImport(true),
        change: async () => {
          const moved = join(home, "retired-instance");
          await rename(workspace.workspaceRoot, moved);
          await cp(moved, workspace.workspaceRoot, { recursive: true });
          replacementInode = (await stat(workspace.workspaceRoot)).ino;
          expect(await snapshot(workspace.workspaceRoot)).toEqual(before);
        }
      })
    ).rejects.toThrow("workspace identity changed");
    expect((await stat(workspace.workspaceRoot)).ino).toBe(replacementInode);
    expect(await snapshot(workspace.workspaceRoot)).toEqual(before);
    expect((await runImport(true)).validation.ok).toBe(true);
  });

  it.each([
    "project",
    "package"
  ] as const)("rechecks authoritative reservation after waiting on the %s lock", async (kind) => {
    const { workspace } = await runImport();
    let reserved: Record<string, string> = {};
    const reservation = join(workspace.workspaceRoot, authoritativeImportReservationFile);
    await expect(
      whileQueued({
        root: kind === "project" ? workspace.workspaceRoot : workspace.packageDir,
        kind,
        action: () => runImport(true),
        change: async () => {
          await writeFile(reservation, "another-owner");
          reserved = await snapshot(workspace.workspaceRoot);
        }
      })
    ).rejects.toThrow("reserved by an authoritative content import");
    expect(await snapshot(workspace.workspaceRoot)).toEqual(reserved);
    await rm(reservation);
    expect((await runImport(true)).validation.ok).toBe(true);
  });

  it("allows another name to finish while one project admission is blocked", async () => {
    const { workspace } = await runImport();
    await whileQueued({
      root: workspace.workspaceRoot,
      kind: "project",
      action: () => runImport(true),
      change: async () => {
        expect((await runImport(false, "Independent import")).validation.ok).toBe(true);
      }
    });
  });

  it.each(
    [false, true].flatMap((existing) =>
      ["install", "validation"].map((phase) => ({ existing, phase }))
    )
  )("rolls back $phase failure and permits retry (existing=$existing)", async ({
    existing,
    phase
  }) => {
    const current = existing ? (await runImport()).workspace : null;
    const root = join(home, "projects", createManagedProjectId(name));
    const target = current?.packageDir ?? root;
    const before = current ? await snapshot(root) : null;
    await writeFile(join(draftRoot, "fingerprint.md"), "incoming");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let injected = false;
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (!injected && destination === target && String(source).includes(".planweave-import-")) {
        injected = true;
        if (phase === "install")
          throw Object.assign(new Error("installation denied"), { code: "EACCES" });
        await actual.rename(source, destination);
        await writeFile(
          join(current ? target : join(target, "canvases", "default", "package"), "manifest.json"),
          "{}"
        );
        return;
      }
      return actual.rename(source, destination);
    });
    await expect(runImport(existing)).rejects.toThrow(
      phase === "install" ? "installation denied" : "became invalid after install"
    );
    expect(injected).toBe(true);
    if (current) expect(await snapshot(root)).toEqual(before);
    else await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listPendingImportTransactions(current ? root : home)).toEqual([]);
    expect((await runImport(existing)).validation.ok).toBe(true);
  });

  it("does not treat a project lookup permission failure as a missing project", async () => {
    const { workspace } = await runImport();
    const before = await snapshot(workspace.workspaceRoot);
    vi.mocked(stat).mockRejectedValueOnce(
      Object.assign(new Error("metadata denied"), { code: "EACCES" })
    );
    await expect(runImport(true)).rejects.toThrow("metadata denied");
    expect(await snapshot(workspace.workspaceRoot)).toEqual(before);
    expect((await runImport(true)).validation.ok).toBe(true);
  });

  it("reports a failed commit checkpoint and keeps explicit recovery available before retry", async () => {
    const { workspace } = await runImport();
    const before = await snapshot(workspace.workspaceRoot);
    await writeFile(join(draftRoot, "fingerprint.md"), "uncommitted package");
    const injected = await failNextCommitCheckpoint();
    await expect(runImport(true)).rejects.toThrow("commit checkpoint denied");
    expect(injected()).toBe(true);
    const pending = await listPendingImportTransactions(workspace.workspaceRoot);
    expect(pending).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(pending[0].recoveryRoot, "recovery.json"), "utf8")).state
    ).toBe("active");
    await expect(runImport(true)).rejects.toThrow(
      `pending transaction '${pending[0].transactionId}'`
    );
    await rollbackPendingImportTransaction({
      workspaceRoot: workspace.workspaceRoot,
      transactionId: pending[0].transactionId
    });
    expect(await snapshot(workspace.workspaceRoot)).toEqual(before);
    expect((await runImport(true)).validation.ok).toBe(true);
    expect(await listPendingImportTransactions(workspace.workspaceRoot)).toEqual([]);
  });

  it("keeps a failed new installation identity intact through retry and public recovery", async () => {
    await failNextCommitCheckpoint();
    const root = join(home, "projects", createManagedProjectId(name));
    await expect(runImport()).rejects.toThrow("commit checkpoint denied");
    const [pending] = await listPendingImportTransactions(home);
    const before = await importTransactionIdentityDigest(root);
    await expect(runImport(true)).rejects.toThrow(`pending transaction '${pending.transactionId}'`);
    expect(await importTransactionIdentityDigest(root)).toBe(before);
    expect(await listPendingImportRecoveries(root)).toEqual([pending]);
    expect(
      (await getDesktopProjectSnapshot({ projectRoot: root, canvasId: "default" }))
        .pendingImportRecoveries
    ).toEqual([pending]);
    for (let read = 0; read < 2; read += 1) {
      expect((await getLatestAutoRunSummaryWithDiagnostics(root, "default")).state).toBeNull();
    }
    const afterReads = await importTransactionIdentityDigest(root);
    await rollbackPendingImportRecovery(root, pending.transactionId);
    expect(afterReads).toBe(before);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await runImport()).validation.ok).toBe(true);
  });

  it("routes Home recovery through the project API and snapshot without exposing another project", async () => {
    const root = join(home, "projects", createManagedProjectId(name));
    const otherName = "Other failed import";
    const otherRoot = join(home, "projects", createManagedProjectId(otherName));
    await failNextCommitCheckpoint();
    await expect(runImport()).rejects.toThrow("commit checkpoint denied");
    const [own] = await listPendingImportTransactions(home);
    await failNextCommitCheckpoint();
    await expect(runImport(false, otherName)).rejects.toThrow("commit checkpoint denied");
    const other = (await listPendingImportTransactions(home)).find(
      (entry) => entry.transactionId !== own.transactionId
    )!;
    const otherBefore = await importTransactionIdentityDigest(otherRoot);
    expect(await listPendingImportRecoveries(root)).toEqual([own]);
    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: "default" });
    expect(snapshot.pendingImportRecoveries).toEqual([own]);
    await expect(rollbackPendingImportRecovery(root, other.transactionId)).rejects.toThrow(
      "does not belong to project"
    );
    expect(await importTransactionIdentityDigest(otherRoot)).toBe(otherBefore);
    await rollbackPendingImportRecovery(root, own.transactionId);
    expect(await listPendingImportRecoveries(otherRoot)).toEqual([other]);
    await rollbackPendingImportRecovery(otherRoot, other.transactionId);
    expect(await listPendingImportTransactions(home)).toEqual([]);
  });

  it.each([
    false,
    true
  ])("rejects a symlinked draft before publishing (existing=%s)", async (existing) => {
    const current = existing ? (await runImport()).workspace : null;
    const outside = join(home, "outside.md");
    await writeFile(outside, "outside");
    await symlink(outside, join(draftRoot, "linked.md"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = join(home, "projects", createManagedProjectId(name));
    const target = current?.packageDir ?? root;
    const before = current ? await snapshot(root) : null;
    let published = false;
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (destination === target) published = true;
      return actual.rename(source, destination);
    });
    await expect(runImport(existing)).rejects.toThrow("non-regular");
    expect(published).toBe(false);
    if (current) expect(await snapshot(root)).toEqual(before);
    else await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outside, "utf8")).toBe("outside");
  });
});
