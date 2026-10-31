import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPackageFiles,
  replacePackageFiles,
  replacePackageFilesWithFileSystem,
  type PackageFileEntry,
  type PackageFileSystem
} from "../package/packageFiles.js";

const temporaryParents: string[] = [];
const files: PackageFileEntry[] = [
  { path: "manifest.json", content: "published manifest", encoding: "utf8" },
  { path: "nodes/task.md", content: "published task", encoding: "utf8" }
];
const nodeFileSystem: PackageFileSystem = {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
};

afterEach(async () => {
  await Promise.all(
    temporaryParents.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function createTarget() {
  const parent = await mkdtemp(join(tmpdir(), "planweave-replacement-policy-"));
  temporaryParents.push(parent);
  return { parent, target: join(parent, "package") };
}

async function temporaryEntries(parent: string) {
  return (await readdir(parent)).filter((name) => name.startsWith(".package."));
}

describe("non-overwriting package replacement", () => {
  it.each([
    "missing",
    "empty directory",
    "empty directory symlink",
    "dangling symlink"
  ])("publishes to a %s without changing a symlink referent", async (kind) => {
    const { parent, target } = await createTarget();
    const referent = join(parent, "referent");
    if (kind === "empty directory") await mkdir(target);
    if (kind === "empty directory symlink") await mkdir(referent);
    if (kind.endsWith("symlink")) {
      await symlink(referent, target, process.platform === "win32" ? "junction" : "dir");
    }

    await replacePackageFiles(target, files, { overwrite: false });

    expect(await readPackageFiles(target)).toEqual(files);
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    if (kind === "empty directory symlink") expect(await readdir(referent)).toEqual([]);
    if (kind === "dangling symlink") await expect(lstat(referent)).rejects.toThrow("ENOENT");
    expect(await temporaryEntries(parent)).toEqual([]);
  });

  it.each([
    "non-empty directory",
    "file",
    "non-empty directory symlink",
    "file symlink"
  ])("rejects a %s and preserves the target and referent bytes", async (kind) => {
    const { parent, target } = await createTarget();
    const referent = join(parent, "referent");
    const oldTarget = kind.endsWith("symlink") ? referent : target;
    const isDirectory = kind.startsWith("non-empty directory");
    if (isDirectory) await mkdir(oldTarget);
    const oldFile = isDirectory ? join(oldTarget, "keep.bin") : oldTarget;
    const oldBytes = Buffer.from([0, 255, 128, 10]);
    await writeFile(oldFile, oldBytes);
    if (kind.endsWith("symlink")) {
      await symlink(
        referent,
        target,
        process.platform === "win32" && isDirectory ? "junction" : isDirectory ? "dir" : "file"
      );
    }
    const originalLink = kind.endsWith("symlink") ? await readlink(target) : null;

    await expect(replacePackageFiles(target, files, { overwrite: false })).rejects.toThrow(
      isDirectory ? /not empty.*overwrite was not allowed/i : /not a directory/i
    );

    expect(await readFile(oldFile)).toEqual(oldBytes);
    if (isDirectory) expect(await readdir(oldTarget)).toEqual(["keep.bin"]);
    if (originalLink !== null) expect(await readlink(target)).toBe(originalLink);
    expect(await temporaryEntries(parent)).toEqual([]);
  });

  it("preserves a publication when the next target uses a parent directory alias", async () => {
    const { parent, target } = await createTarget();
    const alias = join(parent, "alias");
    await mkdir(join(parent, "real"));
    await symlink(join(parent, "real"), alias, process.platform === "win32" ? "junction" : "dir");
    const publishedTarget = join(parent, "real", "package");
    await replacePackageFiles(publishedTarget, files, { overwrite: false });

    await expect(
      replacePackageFiles(join(alias, "package"), [{ ...files[0]!, content: "late writer" }], {
        overwrite: false
      })
    ).rejects.toThrow(/not empty.*overwrite was not allowed/i);

    expect(await readPackageFiles(publishedTarget)).toEqual(files);
    expect(await readdir(join(parent, "real"))).toEqual(["package"]);
    await expect(lstat(target)).rejects.toThrow("ENOENT");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "propagates real directory read permission errors and releases the lock for retry",
    async () => {
      const { parent, target } = await createTarget();
      await mkdir(target);
      await writeFile(join(target, "keep.bin"), Buffer.from([255, 0, 127]));
      await chmod(target, 0o300);
      let failure: unknown;
      try {
        await replacePackageFiles(target, files, { overwrite: false });
      } catch (error) {
        failure = error;
      } finally {
        await chmod(target, 0o700);
      }

      expect(failure).toMatchObject({ code: "EACCES" });
      expect(await readFile(join(target, "keep.bin"))).toEqual(Buffer.from([255, 0, 127]));
      expect(await readdir(target)).toEqual(["keep.bin"]);
      expect(await temporaryEntries(parent)).toEqual([]);
      await unlink(join(target, "keep.bin"));
      await replacePackageFiles(target, files, { overwrite: false });
      expect(await readPackageFiles(target)).toEqual(files);
    }
  );

  it("keeps the rejection and lock cleanup diagnostics without staging a replacement", async () => {
    const { parent, target } = await createTarget();
    await mkdir(target);
    await writeFile(join(target, "keep.bin"), "keep");
    const failingFileSystem: PackageFileSystem = {
      ...nodeFileSystem,
      unlink: async (path) => {
        if (path === join(parent, ".package.replace.lock")) {
          throw new Error("injected policy lock cleanup failure");
        }
        await unlink(path);
      }
    };

    const failure = await replacePackageFilesWithFileSystem(target, files, failingFileSystem, {
      overwrite: false
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: expect.stringMatching(/not empty.*overwrite was not allowed/)
    });
    expect(failure).toMatchObject({
      message: expect.stringContaining("injected policy lock cleanup failure")
    });
    expect(await readFile(join(target, "keep.bin"), "utf8")).toBe("keep");
    expect(await readdir(target)).toEqual(["keep.bin"]);
    expect(await temporaryEntries(parent)).toEqual([".package.replace.lock"]);
    await unlink(join(parent, ".package.replace.lock"));
    await expect(replacePackageFiles(target, files, { overwrite: false })).rejects.toThrow(
      /not empty/
    );
    expect(await temporaryEntries(parent)).toEqual([]);
  });

  it("restores the admitted empty directory if installation fails after the backup move", async () => {
    const { parent, target } = await createTarget();
    await mkdir(target);
    const before = await lstat(target);
    const failingFileSystem: PackageFileSystem = {
      ...nodeFileSystem,
      rename: async (source, destination) => {
        if (String(source).includes(".package.staging-") && destination === target) {
          throw new Error("injected non-overwrite install failure");
        }
        await rename(source, destination);
      }
    };

    await expect(
      replacePackageFilesWithFileSystem(target, files, failingFileSystem, { overwrite: false })
    ).rejects.toThrow(/original package was restored.*injected non-overwrite install failure/i);

    const restored = await lstat(target);
    expect([restored.dev, restored.ino]).toEqual([before.dev, before.ino]);
    expect(await readdir(target)).toEqual([]);
    expect(await temporaryEntries(parent)).toEqual([]);
    await replacePackageFiles(target, files, { overwrite: false });
    expect(await readPackageFiles(target)).toEqual(files);
  });
});
