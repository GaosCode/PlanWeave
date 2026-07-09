import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportCanvasPackageFiles,
  packageFileEntrySchema,
  readPackageFiles,
  replacePackageFiles,
  safePackageFilePath,
  toArchivePath
} from "../package/packageFiles.js";

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
    await mkdir(join(root, "nodes", "T-001"), { recursive: true });
    await writeFile(join(root, "manifest.json"), '{"version":"plan-package/v1"}', "utf8");
    await writeFile(join(root, "nodes", "T-001", "prompt.md"), "# Task\n", "utf8");

    const files = await readPackageFiles(root);
    expect(files.map((file) => file.path)).toEqual(["manifest.json", "nodes/T-001/prompt.md"]);
    expect(files.every((file) => packageFileEntrySchema.safeParse(file).success)).toBe(true);

    const exported = await exportCanvasPackageFiles({ packageDir: root });
    expect(exported).toEqual(files);

    const target = await mkdtemp(join(tmpdir(), "planweave-package-files-out-"));
    await replacePackageFiles(target, files);
    await expect(readFile(join(target, "manifest.json"), "utf8")).resolves.toBe(
      '{"version":"plan-package/v1"}'
    );
    await expect(readFile(join(target, "nodes", "T-001", "prompt.md"), "utf8")).resolves.toBe(
      "# Task\n"
    );
  });
});
