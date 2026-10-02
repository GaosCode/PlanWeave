import type { BigIntStats, PathLike, StatOptions, Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportCanvasPackageFiles,
  packageFileEntrySchema,
  readPackageFiles,
  replacePackageFiles,
  replacePackageFilesWithFileSystem,
  safePackageFilePath,
  toArchivePath,
  type PackageFileEntry,
  type PackageFileSystem
} from "../package/packageFiles.js";

const temporaryParents: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryParents.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const nodePackageFileSystem: PackageFileSystem = {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  unlink,
  writeFile
};

async function createReplacementTarget(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "planweave-package-replace-"));
  temporaryParents.push(parent);
  const root = join(parent, "package");
  await mkdir(join(root, "nodes"), { recursive: true });
  await writeFile(join(root, "manifest.json"), "old manifest", "utf8");
  await writeFile(join(root, "nodes", "old.md"), "old node", "utf8");
  return { parent, root };
}

async function temporaryReplacementEntries(parent: string): Promise<string[]> {
  return (await readdir(parent)).filter((name) => name.startsWith(".package."));
}

async function replacementEntries(parent: string, kind: "staging" | "backup"): Promise<string[]> {
  return (await readdir(parent)).filter((name) => name.startsWith(`.package.${kind}-`));
}

const replacementFiles: PackageFileEntry[] = [
  { path: "manifest.json", content: "new manifest", encoding: "utf8" },
  { path: "nodes/new.md", content: "new node", encoding: "utf8" }
];

describe("packageFiles primitives", () => {
  it("rejects archive paths that escape the package root", () => {
    expect(() => toArchivePath("../manifest.json")).toThrow("Invalid package file path");
    expect(() => toArchivePath("/abs/path")).toThrow("Invalid package file path");
    expect(() => safePackageFilePath("/tmp/package", "../secret")).toThrow(
      "resolves outside the package directory"
    );
  });

  it("normalizes windows separators into archive paths", () => {
    expect(toArchivePath("nodes\\T-001\\prompt.md")).toBe("nodes/T-001/prompt.md");
  });

  it("reads package files sorted by path and round-trips through replace", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-package-files-"));
    temporaryParents.push(root);
    await mkdir(join(root, "nodes", "T-001"), { recursive: true });
    await writeFile(join(root, "manifest.json"), '{"version":"plan-package/v1"}', "utf8");
    await writeFile(join(root, "nodes", "T-001", "prompt.md"), "# Task\n", "utf8");

    const files = await readPackageFiles(root);
    expect(files.map((file) => file.path)).toEqual(["manifest.json", "nodes/T-001/prompt.md"]);
    expect(files.every((file) => packageFileEntrySchema.safeParse(file).success)).toBe(true);

    const exported = await exportCanvasPackageFiles({ packageDir: root });
    expect(exported).toEqual(files);

    const target = await mkdtemp(join(tmpdir(), "planweave-package-files-out-"));
    temporaryParents.push(target);
    await replacePackageFiles(target, files);
    await expect(readFile(join(target, "manifest.json"), "utf8")).resolves.toBe(
      '{"version":"plan-package/v1"}'
    );
    await expect(readFile(join(target, "nodes", "T-001", "prompt.md"), "utf8")).resolves.toBe(
      "# Task\n"
    );
  });

  it("rejects invalid entries before mutating an existing package", async () => {
    const { parent, root } = await createReplacementTarget();
    const before = await readPackageFiles(root);

    await expect(
      // @ts-expect-error Runtime schema validation must reject unsupported encodings from untyped callers.
      replacePackageFiles(root, [{ path: "manifest.json", content: "new", encoding: "utf16" }])
    ).rejects.toThrow(/Invalid package file entry at index 0: encoding/i);
    await expect(
      replacePackageFiles(root, [{ path: "../manifest.json", content: "new", encoding: "utf8" }])
    ).rejects.toThrow("Invalid package file path");
    await expect(
      replacePackageFiles(root, [
        { path: "nodes\\T-001\\prompt.md", content: "first", encoding: "utf8" },
        { path: "nodes/T-001/prompt.md", content: "second", encoding: "utf8" }
      ])
    ).rejects.toThrow("Duplicate package file path 'nodes/T-001/prompt.md' after normalization.");

    expect(await readPackageFiles(root)).toEqual(before);
    expect(await temporaryReplacementEntries(parent)).toEqual([]);
  });

  it("does not create a parent, lock, or staging directory for invalid entries", async () => {
    const parent = await mkdtemp(join(tmpdir(), "planweave-package-replace-"));
    temporaryParents.push(parent);
    const targetParent = join(parent, "not-created");
    const root = join(targetParent, "package");

    await expect(
      // @ts-expect-error Runtime schema validation must reject unsupported encodings from untyped callers.
      replacePackageFiles(root, [{ path: "manifest.json", content: "new", encoding: "utf16" }])
    ).rejects.toThrow(/Invalid package file entry at index 0: encoding/i);

    await expect(lstat(targetParent)).rejects.toThrow("ENOENT");
    expect(await readdir(parent)).toEqual([]);
  });

  it("keeps the original package when staging writes fail", async () => {
    const { parent, root } = await createReplacementTarget();
    const before = await readPackageFiles(root);
    const failingFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      writeFile: async (path, data, options) => {
        if (String(path).includes(".package.staging-")) {
          throw new Error("injected staging write failure");
        }
        await nodePackageFileSystem.writeFile(path, data, options);
      }
    };

    await expect(
      replacePackageFilesWithFileSystem(root, replacementFiles, failingFileSystem)
    ).rejects.toThrow("injected staging write failure");

    expect(await readPackageFiles(root)).toEqual(before);
    expect(await temporaryReplacementEntries(parent)).toEqual([]);
  });

  it("serializes concurrent package replacements with a sibling lock", async () => {
    const { parent, root } = await createReplacementTarget();
    const stagingWriteGate: { release?: () => void } = {};
    const firstStagingWriteReleased = new Promise<void>((resolve) => {
      stagingWriteGate.release = resolve;
    });
    let signalFirstStagingWrite: (() => void) | null = null;
    const firstStagingWriteStarted = new Promise<void>((resolve) => {
      signalFirstStagingWrite = resolve;
    });
    let isFirstStagingWrite = true;
    const firstFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      writeFile: async (path, data, options) => {
        if (isFirstStagingWrite && String(path).includes(".package.staging-")) {
          isFirstStagingWrite = false;
          if (signalFirstStagingWrite === null) {
            throw new Error("Missing first staging write signal.");
          }
          signalFirstStagingWrite();
          await firstStagingWriteReleased;
        }
        await nodePackageFileSystem.writeFile(path, data, options);
      }
    };

    const firstReplacement = replacePackageFilesWithFileSystem(
      root,
      replacementFiles,
      firstFileSystem
    );
    await firstStagingWriteStarted;

    await expect(
      replacePackageFiles(root, [
        { path: "manifest.json", content: "second manifest", encoding: "utf8" }
      ])
    ).rejects.toThrow(/replace\.lock.*already held or stale/i);
    const pendingRead = readPackageFiles(root);

    if (!stagingWriteGate.release) {
      throw new Error("Missing first staging write release.");
    }
    stagingWriteGate.release();
    await expect(firstReplacement).resolves.toBeUndefined();
    expect(await pendingRead).toEqual(replacementFiles);

    expect(await readPackageFiles(root)).toEqual(replacementFiles);
    await expect(lstat(join(parent, ".package.replace.lock"))).rejects.toThrow("ENOENT");
    expect(await temporaryReplacementEntries(parent)).toEqual([]);
  });

  it("fails closed for a pre-existing replacement lock without touching the target", async () => {
    const { parent, root } = await createReplacementTarget();
    const before = await readPackageFiles(root);
    const lockPath = join(parent, ".package.replace.lock");
    const lock = await open(lockPath, "wx");
    await lock.close();

    await expect(replacePackageFiles(root, replacementFiles)).rejects.toThrow(
      /replace\.lock.*already held or stale/i
    );

    expect(await readPackageFiles(root)).toEqual(before);
    expect((await lstat(lockPath)).isFile()).toBe(true);
    expect(await replacementEntries(parent, "staging")).toEqual([]);
    expect(await replacementEntries(parent, "backup")).toEqual([]);
  });

  it("reports lock cleanup failure after completing a replacement", async () => {
    const { parent, root } = await createReplacementTarget();
    const lockCleanupError = new Error("injected lock cleanup failure");
    const failingFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      unlink: async (path) => {
        if (String(path).includes(".package.replace.lock")) {
          throw lockCleanupError;
        }
        await nodePackageFileSystem.unlink(path);
      }
    };

    const error = await replacePackageFilesWithFileSystem(
      root,
      replacementFiles,
      failingFileSystem
    ).then(
      () => null,
      (reason: unknown) => reason
    );
    if (!(error instanceof Error)) {
      throw new Error("Expected lock cleanup failure.");
    }

    const lockPath = join(parent, ".package.replace.lock");
    expect(error.message).toContain("completed");
    expect(error.message).toContain("lock cleanup failed");
    expect(error.message).toContain("injected lock cleanup failure");
    expect(error.message).toContain(lockPath);
    expect(await readPackageFiles(root)).toEqual(replacementFiles);
    expect((await lstat(lockPath)).isFile()).toBe(true);
    expect(await replacementEntries(parent, "staging")).toEqual([]);
    expect(await replacementEntries(parent, "backup")).toEqual([]);
  });

  it("cleans staging and preserves the original package when target inspection fails", async () => {
    const { parent, root } = await createReplacementTarget();
    const before = await readPackageFiles(root);
    const inspectionError = Object.assign(new Error("injected target inspection failure"), {
      code: "EACCES"
    });
    function inspectionLstat(
      path: PathLike,
      options?: StatOptions & { bigint?: false }
    ): Promise<Stats>;
    function inspectionLstat(
      path: PathLike,
      options: StatOptions & { bigint: true }
    ): Promise<BigIntStats>;
    function inspectionLstat(path: PathLike, options?: StatOptions): Promise<Stats | BigIntStats>;
    async function inspectionLstat(
      path: PathLike,
      options?: StatOptions
    ): Promise<Stats | BigIntStats> {
      if (path === root) throw inspectionError;
      return nodePackageFileSystem.lstat(path, options);
    }
    const failingFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      lstat: inspectionLstat
    };

    await expect(
      replacePackageFilesWithFileSystem(root, replacementFiles, failingFileSystem)
    ).rejects.toThrow(
      /Failed to inspect package replacement target.*injected target inspection failure/i
    );

    expect(await readPackageFiles(root)).toEqual(before);
    expect(await temporaryReplacementEntries(parent)).toEqual([]);
  });

  it("does not create a target when the initial staged install rename fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "planweave-package-replace-"));
    temporaryParents.push(parent);
    const root = join(parent, "package");
    const failingFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      rename: async () => {
        throw new Error("injected initial staged install rename failure");
      }
    };

    await expect(
      replacePackageFilesWithFileSystem(root, replacementFiles, failingFileSystem)
    ).rejects.toThrow("injected initial staged install rename failure");

    await expect(lstat(root)).rejects.toThrow("ENOENT");
    expect(await temporaryReplacementEntries(parent)).toEqual([]);
  });

  it("preserves the original package and cleans staging when moving it to backup fails", async () => {
    const { parent, root } = await createReplacementTarget();
    const before = await readPackageFiles(root);
    const backupMoveError = new Error("injected target backup rename failure");
    const failingFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      rename: async (source, destination) => {
        if (source === root) {
          throw backupMoveError;
        }
        await nodePackageFileSystem.rename(source, destination);
      }
    };

    await expect(
      replacePackageFilesWithFileSystem(root, replacementFiles, failingFileSystem)
    ).rejects.toThrow(/Failed to move existing package.*injected target backup rename failure/i);

    expect(await readPackageFiles(root)).toEqual(before);
    expect(await temporaryReplacementEntries(parent)).toEqual([]);
  });

  it("restores the original package and cleans temporary siblings when the staged swap fails", async () => {
    const { parent, root } = await createReplacementTarget();
    const before = await readPackageFiles(root);
    let renameCalls = 0;
    const failingFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      rename: async (source, destination) => {
        renameCalls += 1;
        if (renameCalls === 2) {
          throw new Error("injected staged swap rename failure");
        }
        await nodePackageFileSystem.rename(source, destination);
      }
    };

    await expect(
      replacePackageFilesWithFileSystem(root, replacementFiles, failingFileSystem)
    ).rejects.toThrow(/original package was restored.*injected staged swap rename failure/i);

    expect(await readPackageFiles(root)).toEqual(before);
    expect(await replacementEntries(parent, "backup")).toEqual([]);
    expect(await replacementEntries(parent, "staging")).toEqual([]);
  });

  it("retains the primary failure and cleanup failures after restoring the original package", async () => {
    const { parent, root } = await createReplacementTarget();
    const before = await readPackageFiles(root);
    let renameCalls = 0;
    const failingFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      rename: async (source, destination) => {
        renameCalls += 1;
        if (renameCalls === 2) {
          await nodePackageFileSystem.mkdir(destination);
          throw new Error("injected staged swap rename failure");
        }
        await nodePackageFileSystem.rename(source, destination);
      },
      rm: async (path, options) => {
        if (String(path).includes(".package.staging-")) {
          throw new Error("injected rollback staging cleanup failure");
        }
        await nodePackageFileSystem.rm(path, options);
      },
      unlink: async (path) => {
        if (String(path).includes(".package.replace.lock")) {
          throw new Error("injected rollback lock cleanup failure");
        }
        await nodePackageFileSystem.unlink(path);
      }
    };

    const error = await replacePackageFilesWithFileSystem(
      root,
      replacementFiles,
      failingFileSystem
    ).then(
      () => null,
      (reason: unknown) => reason
    );
    if (!(error instanceof Error)) {
      throw new Error("Expected staged swap failure.");
    }

    expect(error.message).toContain("injected staged swap rename failure");
    expect(error.message).toContain("original package was restored");
    expect(error.message).toContain("temporary cleanup failed");
    expect(error.message).toContain("injected rollback staging cleanup failure");
    expect(error.message).toContain("injected rollback lock cleanup failure");
    expect(await readPackageFiles(root)).toEqual(before);
    expect(await replacementEntries(parent, "backup")).toEqual([]);
    expect(await replacementEntries(parent, "staging")).toHaveLength(1);
    expect((await lstat(join(parent, ".package.replace.lock"))).isFile()).toBe(true);
  });

  it("retains the install and recovery failures when restoring the original package fails", async () => {
    const { parent, root } = await createReplacementTarget();
    const before = await readPackageFiles(root);
    let renameCalls = 0;
    const failingFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      rename: async (source, destination) => {
        renameCalls += 1;
        if (renameCalls === 2) {
          throw new Error("injected staged swap rename failure");
        }
        if (renameCalls === 3) {
          throw new Error("injected original package restore failure");
        }
        await nodePackageFileSystem.rename(source, destination);
      }
    };

    const error = await replacePackageFilesWithFileSystem(
      root,
      replacementFiles,
      failingFileSystem
    ).then(
      () => null,
      (reason: unknown) => reason
    );
    if (!(error instanceof Error)) {
      throw new Error("Expected staged swap and recovery failures.");
    }

    const backups = await replacementEntries(parent, "backup");
    expect(backups).toHaveLength(1);
    expect(error.message).toContain("injected staged swap rename failure");
    expect(error.message).toContain("original package recovery failed");
    expect(error.message).toContain("Failed to restore original package from backup");
    expect(error.message).toContain("injected original package restore failure");
    await expect(lstat(root)).rejects.toThrow("ENOENT");
    expect(await readPackageFiles(join(parent, backups[0]!))).toEqual(before);
    expect(await replacementEntries(parent, "staging")).toEqual([]);
  });

  it("reports backup cleanup failure while retaining the replacement and recoverable backup", async () => {
    const { parent, root } = await createReplacementTarget();
    const before = await readPackageFiles(root);
    const backupCleanupError = new Error("injected backup cleanup failure");
    const failingFileSystem: PackageFileSystem = {
      ...nodePackageFileSystem,
      rm: async (path, options) => {
        if (String(path).includes(".package.backup-")) {
          throw backupCleanupError;
        }
        await nodePackageFileSystem.rm(path, options);
      }
    };

    const error = await replacePackageFilesWithFileSystem(
      root,
      replacementFiles,
      failingFileSystem
    ).then(
      () => null,
      (reason: unknown) => reason
    );
    if (!(error instanceof Error)) {
      throw new Error("Expected backup cleanup failure.");
    }

    const backups = await replacementEntries(parent, "backup");
    expect(backups).toHaveLength(1);
    expect(error.message).toContain("replacement completed but backup cleanup failed");
    expect(error.message).toContain("injected backup cleanup failure");
    expect(error.message).toContain(join(parent, backups[0]!));
    expect(await readPackageFiles(root)).toEqual(replacementFiles);
    expect(await readPackageFiles(join(parent, backups[0]!))).toEqual(before);
    expect(await replacementEntries(parent, "staging")).toEqual([]);
  });

  it("replaces every package file and removes temporary siblings after a successful swap", async () => {
    const { parent, root } = await createReplacementTarget();

    await replacePackageFiles(root, replacementFiles);

    expect(await readPackageFiles(root)).toEqual(replacementFiles);
    await expect(readFile(join(root, "nodes", "old.md"), "utf8")).rejects.toThrow("ENOENT");
    expect(await temporaryReplacementEntries(parent)).toEqual([]);
  });

  it("replaces an existing file target with a package directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "planweave-package-replace-"));
    temporaryParents.push(parent);
    const root = join(parent, "package");
    await writeFile(root, "old file target", "utf8");

    await replacePackageFiles(root, replacementFiles);

    expect(await readPackageFiles(root)).toEqual(replacementFiles);
    expect(await temporaryReplacementEntries(parent)).toEqual([]);
  });

  it("creates a missing target parent before staging in that parent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "planweave-package-replace-"));
    temporaryParents.push(parent);
    const targetParent = join(parent, "missing-parent");
    const root = join(targetParent, "package");

    await replacePackageFiles(root, replacementFiles);

    expect(await readPackageFiles(root)).toEqual(replacementFiles);
    expect(await temporaryReplacementEntries(targetParent)).toEqual([]);
  });
});
