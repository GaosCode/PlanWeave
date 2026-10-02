import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  packageFileInventoryEntrySchema,
  readPackageFileInventory,
  readPackageFiles,
  readSelectedPackageFiles
} from "../package/packageFiles.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

let root: string;
let actual: typeof fs;
beforeEach(async () => {
  actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
  root = await fs.mkdtemp(join(tmpdir(), "planweave-file-intents-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function bodyReadPaths(): string[] {
  return vi
    .mocked(fs.readFile)
    .mock.calls.map((call) => String(call[0]))
    .filter((path) => path.startsWith(`${root}${sep}`));
}

describe("package read intents with real filesystem IO", () => {
  it("counts decoded UTF-8 exactly across chunks, malformed bytes and incomplete tails without reading whole bodies", async () => {
    const values = [
      Buffer.from("ascii"),
      Buffer.from("中文🙂"),
      Buffer.alloc(0),
      Buffer.concat([Buffer.alloc(65535, 97), Buffer.from("🙂中"), Buffer.from([255, 226, 130])]),
      Buffer.from([240, 128, 128, 128, 237, 160, 128, 192, 175, 254])
    ];
    for (const [index, value] of values.entries())
      await fs.writeFile(join(root, `${index}.md`), value);
    const lengths: number[] = [];
    const closed = vi.fn();
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        const readCall: readonly unknown[] = readArgs;
        if (typeof readCall[2] === "number") lengths.push(readCall[2]);
        return read(...readArgs);
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed();
      });
      return handle;
    });
    const inventory = await readPackageFileInventory(root);
    expect(inventory).toEqual(
      values.map((value, index) => ({
        path: `${index}.md`,
        contentBytes: Buffer.byteLength(value.toString("utf8"), "utf8"),
        encoding: "utf8"
      }))
    );
    expect(inventory.every((file) => packageFileInventoryEntrySchema.safeParse(file).success)).toBe(
      true
    );
    expect(inventory.every((file) => !("content" in file))).toBe(true);
    expect(bodyReadPaths()).toEqual([]);
    expect(lengths.length).toBeGreaterThan(values.length);
    expect(Math.max(...lengths)).toBe(65536);
    expect(closed).toHaveBeenCalledTimes(values.length);
  });

  it("has no inherited bounded-content budget for large inventory files", async () => {
    const handle = await actual.open(join(root, "large.md"), "w");
    try {
      await handle.truncate(65 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    expect(await readPackageFileInventory(root)).toEqual([
      { path: "large.md", contentBytes: 65 * 1024 * 1024, encoding: "utf8" }
    ]);
    expect(bodyReadPaths()).toEqual([]);
  });

  it("reads only selected bodies, preserves request order and repeats, and leaves unreadable unselected files alone", async () => {
    await fs.mkdir(join(root, "nested"));
    await fs.writeFile(join(root, "a.md"), "A");
    await fs.writeFile(join(root, "nested", "b.md"), "中文");
    await fs.writeFile(join(root, "unselected.md"), Buffer.alloc(2 * 1024 * 1024));
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("unselected.md")) {
        throw Object.assign(new Error(`permission denied: ${root}`), { code: "EACCES" });
      }
      return actual.readFile(...args);
    });
    const files = await readSelectedPackageFiles(root, ["nested/b.md", "a.md", "nested/b.md"]);
    expect(files).toEqual([
      { path: "nested/b.md", content: "中文", encoding: "utf8" },
      { path: "a.md", content: "A", encoding: "utf8" },
      { path: "nested/b.md", content: "中文", encoding: "utf8" }
    ]);
    expect(bodyReadPaths()).toEqual([join(root, "nested", "b.md"), join(root, "a.md")]);
    await expect(readPackageFiles(root)).rejects.toMatchObject({ code: "EACCES" });
    await expect(readSelectedPackageFiles(root, ["unselected.md"])).rejects.toThrow(
      "unselected.md' could not be read (EACCES)"
    );
    try {
      await readSelectedPackageFiles(root, ["unselected.md"]);
    } catch (error) {
      expect(error instanceof Error && error.message.includes(root)).toBe(false);
    }
  });

  it("keeps full and selected bodies untruncated and full archive sorting unchanged", async () => {
    const content = "中🙂".repeat(220000);
    await fs.writeFile(join(root, "z.md"), content);
    await fs.writeFile(join(root, "a.md"), "small");
    const full = await readPackageFiles(root);
    expect(full.map((file) => file.path)).toEqual(["a.md", "z.md"]);
    expect(full[1]?.content).toBe(content);
    expect((await readSelectedPackageFiles(root, ["z.md"]))[0]?.content).toBe(content);
    expect(await readPackageFileInventory(root)).toEqual(
      full.map(({ path, content, encoding }) => ({
        path,
        encoding,
        contentBytes: Buffer.byteLength(content, "utf8")
      }))
    );
  });

  it("preserves ordinary-file archive membership and safe exact paths", async () => {
    await fs.mkdir(join(root, "nested"));
    await fs.writeFile(join(root, "nested", "a.md"), "A");
    await fs.symlink(join(root, "nested", "a.md"), join(root, "link.md"));
    await fs.symlink(join(root, "nested"), join(root, "link-dir"));
    await fs.symlink(tmpdir(), join(root, "outside"));
    expect((await readPackageFiles(root)).map((file) => file.path)).toEqual(["nested/a.md"]);
    expect((await readPackageFileInventory(root)).map((file) => file.path)).toEqual([
      "nested/a.md"
    ]);
    for (const path of [
      "link.md",
      "link-dir/a.md",
      "nested",
      "missing.md",
      "nested/../nested/a.md",
      "nested\\a.md",
      "../escape",
      "outside/escape"
    ]) {
      await expect(readSelectedPackageFiles(root, [path])).rejects.toThrow();
    }
    expect(await readSelectedPackageFiles(root, [])).toEqual([]);
  });

  it("reports selected path-resolution failures without leaking local absolute paths", async () => {
    await fs.writeFile(join(root, "a.md"), "A");
    vi.spyOn(fs, "realpath").mockRejectedValue(
      Object.assign(new Error(`permission denied: ${root}`), { code: "EACCES" })
    );
    await expect(readSelectedPackageFiles(root, ["a.md"])).rejects.toThrow(
      "Package file 'a.md' could not be read (EACCES)."
    );
    expect(bodyReadPaths()).toEqual([]);
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "keeps literal POSIX backslash members and archive collisions distinct (nested=%s)",
    async (nested) => {
      await fs.writeFile(join(root, "a\\b.md"), "literal-backslash");
      if (nested) {
        await fs.mkdir(join(root, "a"));
        await fs.writeFile(join(root, "a", "b.md"), "actual-nested");
      }
      const expected = [
        ...(nested ? [{ path: "a/b.md", content: "actual-nested", encoding: "utf8" }] : []),
        { path: "a/b.md", content: "literal-backslash", encoding: "utf8" }
      ];
      expect(await readPackageFiles(root)).toEqual(expected);
      expect(await readPackageFileInventory(root)).toEqual(
        expected.map(({ path, content, encoding }) => ({
          path,
          encoding,
          contentBytes: Buffer.byteLength(content, "utf8")
        }))
      );
      vi.mocked(fs.readFile).mockClear();
      const first = nested ? "actual-nested" : "literal-backslash";
      expect(await readSelectedPackageFiles(root, ["a/b.md", "a/b.md"])).toEqual([
        { path: "a/b.md", content: first, encoding: "utf8" },
        { path: "a/b.md", content: first, encoding: "utf8" }
      ]);
      expect(bodyReadPaths()).toHaveLength(1);
      vi.mocked(fs.readFile).mockClear();
      expect(await readSelectedPackageFiles(root, ["a/b.md"], "last")).toEqual([
        { path: "a/b.md", content: "literal-backslash", encoding: "utf8" }
      ]);
      expect(bodyReadPaths()).toHaveLength(1);
    }
  );

  it("closes an inventory handle when its body read fails", async () => {
    await fs.writeFile(join(root, "a.md"), "A");
    const closed = vi.fn();
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, "read").mockRejectedValue(
        Object.assign(new Error("read failed"), { code: "EIO" })
      );
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed();
      });
      return handle;
    });
    await expect(readPackageFileInventory(root)).rejects.toMatchObject({ code: "EIO" });
    expect(closed).toHaveBeenCalledOnce();
  });
});
