import { createHash } from "node:crypto";
import { open, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPackageFiles, readPackageFile } from "../package/boundedContent.js";
import { readBoundedUtf8File } from "../package/boundedUtf8Reader.js";
import { MAX_FILE_READ_BYTES, MAX_LIST_READ_BYTES } from "../package/contentReadPolicy.js";
import { loadPackage } from "../package/loadPackage.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

function digest(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

describe("bounded content real file integration", () => {
  it("closes a real growing file after excess input", async () => {
    const { init } = await createTestWorkspace();
    const path = join(init.workspace.packageDir, "growing.txt");
    await writeFile(path, "1234");
    const file = await open(path, "r");
    let closed = false;
    await expect(
      readBoundedUtf8File(path, {
        maxBytes: 2,
        maxReadBytes: 4,
        openFile: async () => ({
          async stat() {
            const metadata = await file.stat();
            await writeFile(path, "12345");
            return metadata;
          },
          read: (...args) => file.read(...args),
          async close() {
            await file.close();
            closed = true;
          }
        })
      })
    ).rejects.toMatchObject({ code: "content_file_budget_exceeded" });
    expect(closed).toBe(true);
  });

  it("keeps physical and decoded sizes distinct in real file content and list APIs", async () => {
    const { root, init } = await createTestWorkspace();
    const path = join(init.workspace.packageDir, "unicode.txt");
    const bytes = Buffer.concat([Buffer.from("中😀"), Buffer.from([0xff])]);
    await writeFile(path, bytes);
    const decoded = await readFile(path, "utf8");
    const result = await readPackageFile({ projectRoot: root, path: "unicode.txt", maxBytes: 4 });
    expect(result).toMatchObject({
      content: "中",
      truncated: true,
      contentRef: { hash: digest(decoded), sizeBytes: Buffer.byteLength(decoded) }
    });
    const listed = (await listPackageFiles({ projectRoot: root })).files.find(
      (file) => file.path === "unicode.txt"
    );
    expect(listed).toMatchObject({
      sizeBytes: bytes.length,
      hash: result.contentRef.hash,
      contentRef: result.contentRef
    });
    await symlink(init.workspace.projectPromptFile, join(init.workspace.packageDir, "escape.txt"));
    await expect(readPackageFile({ projectRoot: root, path: "escape.txt" })).rejects.toMatchObject({
      code: "package_path_outside"
    });
    await expect(readPackageFile({ projectRoot: root, path: "missing.txt" })).rejects.toMatchObject(
      { code: "ENOENT" }
    );
  });

  it("bounds manifest loading only for content entry points", async () => {
    const { root, init } = await createTestWorkspace();
    const path = join(init.workspace.packageDir, "manifest.json");
    const original = await readFile(path, "utf8");
    await writeFile(
      path,
      original + " ".repeat(MAX_FILE_READ_BYTES + 1 - Buffer.byteLength(original))
    );
    await expect(
      readPackageFile({ projectRoot: root, path: "manifest.json" })
    ).rejects.toMatchObject({ code: "content_file_budget_exceeded" });
    await expect(loadPackage(root)).resolves.toMatchObject({
      manifest: { version: "plan-package/v1" }
    });
  });

  it("accepts the real file hard limit and rejects limit plus one and aggregate pages", async () => {
    const { root, init } = await createTestWorkspace();
    for (let index = 0; index < 4; index++) {
      const path = join(init.workspace.packageDir, `large-${index}.txt`);
      await writeFile(path, "");
      await truncate(path, MAX_FILE_READ_BYTES);
    }
    const result = await readPackageFile({ projectRoot: root, path: "large-0.txt", maxBytes: 1 });
    expect(result.contentRef.sizeBytes).toBe(MAX_FILE_READ_BYTES);
    expect(result.content).toBe("\0");
    expect(MAX_LIST_READ_BYTES).toBe(4 * MAX_FILE_READ_BYTES);
    await expect(listPackageFiles({ projectRoot: root })).rejects.toMatchObject({
      code: "content_page_budget_exceeded"
    });
    await truncate(join(init.workspace.packageDir, "large-0.txt"), MAX_FILE_READ_BYTES + 1);
    await expect(readPackageFile({ projectRoot: root, path: "large-0.txt" })).rejects.toMatchObject(
      { code: "content_file_budget_exceeded" }
    );
  }, 20_000);
});
