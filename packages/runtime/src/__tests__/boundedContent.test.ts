import { createHash } from "node:crypto";
import {
  readBoundedUtf8File,
  utf8Prefix,
  CONTENT_READ_CHUNK_BYTES,
  type ContentReadHandle
} from "../package/boundedUtf8Reader.js";
import { MAX_CONTENT_BYTES, normalizeContentMaxBytes } from "../package/contentReadPolicy.js";
import { describe, expect, it } from "vitest";
import {
  getPromptSources,
  listPackageFiles,
  readPackageFile,
  readPromptSource,
  readRenderedPrompt
} from "../package/boundedContent.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

describe("bounded package content readers", () => {
  it("lists package files with owners and content refs", async () => {
    const { root } = await createTestWorkspace();

    const result = await listPackageFiles({ projectRoot: root, limit: 2 });

    expect(result.files).toHaveLength(2);
    expect(result.pagination).toMatchObject({
      limit: 2,
      cursor: null,
      total: 4,
      hasMore: true,
      nextCursor: "next:2"
    });
    expect(result.files[0]).toMatchObject({
      path: "manifest.json",
      owner: { kind: "manifest" },
      contentRef: { kind: "package_file", path: "manifest.json" }
    });
    expect(result.files[0].hash).toMatch(/^sha256:/);
    expect(result.files[0].preview.length).toBeGreaterThan(0);
  });

  it("reads package files and prompt sources with bounded content refs", async () => {
    const { root } = await createTestWorkspace();

    const manifest = await readPackageFile({
      projectRoot: root,
      path: "manifest.json",
      maxBytes: 20
    });
    const taskPrompt = await readPromptSource({
      projectRoot: root,
      target: "task",
      taskId: "T-001"
    });
    const blockPrompt = await readPromptSource({
      projectRoot: root,
      target: "block",
      blockRef: "T-001#B-001",
      maxBytes: 10
    });

    expect(manifest.contentRef).toMatchObject({ kind: "package_file", path: "manifest.json" });
    expect(manifest.truncated).toBe(true);
    expect(Buffer.byteLength(manifest.content, "utf8")).toBeLessThanOrEqual(20);
    expect(taskPrompt).toMatchObject({
      contentRef: { kind: "prompt_source", path: "nodes/T-001/prompt.md" },
      content: "# T-001 task prompt\n",
      truncated: false
    });
    expect(blockPrompt.contentRef).toMatchObject({
      kind: "prompt_source",
      path: "nodes/T-001/blocks/B-001.prompt.md"
    });
    expect(blockPrompt.truncated).toBe(true);
    expect(Buffer.byteLength(blockPrompt.content, "utf8")).toBeLessThanOrEqual(10);
  });

  it("reads rendered prompts and source summaries without exposing local paths", async () => {
    const { root } = await createTestWorkspace();

    const rendered = await readRenderedPrompt({
      projectRoot: root,
      ref: "T-001#B-001",
      maxBytes: 80
    });
    const sources = await getPromptSources({ projectRoot: root, ref: "T-001#B-001" });

    expect(rendered.contentRef).toMatchObject({ kind: "rendered_prompt", ref: "T-001#B-001" });
    expect(rendered.content).toContain("T-001#B-001");
    expect(sources).toMatchObject({ ref: "T-001#B-001" });
    expect(sources.sources.length).toBeGreaterThan(0);
    expect(JSON.stringify(sources)).not.toContain(root);
  });

  it("rejects package file paths that escape the package root", async () => {
    const { root } = await createTestWorkspace();

    await expect(readPackageFile({ projectRoot: root, path: "../project.json" })).rejects.toThrow(
      "must stay inside the package directory"
    );
  });
});

function digest(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function memoryHandle(
  bytes: Buffer,
  options: { statSize?: number; chunkSize?: number; failAt?: number; onRead?: () => void } = {}
) {
  let offset = 0;
  let closed = false;
  const buffers = new Set<Buffer>();
  let calls = 0;
  const handle: ContentReadHandle = {
    async stat() {
      return { size: options.statSize ?? bytes.length };
    },
    async read(buffer, start, length) {
      calls++;
      buffers.add(buffer);
      if (options.failAt === calls)
        throw Object.assign(new Error("read denied"), { code: "EACCES" });
      const count = Math.min(length, options.chunkSize ?? length, bytes.length - offset);
      bytes.copy(buffer, start, offset, offset + count);
      offset += count;
      options.onRead?.();
      return { bytesRead: count };
    },
    async close() {
      closed = true;
    }
  };
  return { handle, state: () => ({ closed, buffers, calls, bytesRead: offset }) };
}

describe("UTF-8 input and output budgets", () => {
  it.each([1, 2, 3, 4, 7])("keeps whole code points at %i bytes", async (maxBytes) => {
    for (const content of ["ascii", "中文", "😀😀😀", "e\u0301中😀", ""]) {
      const input = Buffer.from(content);
      const source = memoryHandle(input, { chunkSize: 1 });
      const result = await readBoundedUtf8File("fixture", {
        maxBytes,
        openFile: async () => source.handle
      });
      const expected = utf8Prefix(content, maxBytes);
      expect(result).toMatchObject({
        ...expected,
        hash: digest(content),
        sizeBytes: input.length,
        inputBytes: input.length
      });
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(maxBytes);
      expect(result.content).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect(source.state().closed).toBe(true);
    }
    expect(utf8Prefix("😀😀😀", 7)).toEqual({ content: "😀", truncated: true });
  });

  it("matches replacement decoding and full identity for malformed UTF-8", async () => {
    const bytes = Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xff, 0xc0, 0x80, 0xe4, 0xb8]);
    for (const chunkSize of [1, 2, 3, 4, 7]) {
      const source = memoryHandle(bytes, { chunkSize });
      const result = await readBoundedUtf8File("fixture", {
        maxBytes: 7,
        openFile: async () => source.handle
      });
      const decoded = bytes.toString("utf8");
      expect(result).toMatchObject({
        hash: digest(decoded),
        sizeBytes: Buffer.byteLength(decoded),
        physicalSizeBytes: bytes.length
      });
      expect(result.content).toBe(utf8Prefix(decoded, 7).content);
    }
  });

  it("normalizes preview whitespace while preserving the 220 code-unit boundary", async () => {
    for (const content of [
      "  a\n\t b   ",
      `${"x".repeat(219)}😀tail`,
      `${"x".repeat(219)}  😀tail`,
      `${"x".repeat(218)}😀tail`
    ]) {
      const source = memoryHandle(Buffer.from(content), { chunkSize: 1 });
      const result = await readBoundedUtf8File("fixture", {
        maxBytes: 4,
        openFile: async () => source.handle
      });
      const oldPreview = content.replace(/\s+/g, " ").trim().slice(0, 220);
      expect(result.preview).toBe(oldPreview.replace(/[\uD800-\uDBFF]$/u, ""));
    }
  });

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    MAX_CONTENT_BYTES + 1
  ])("rejects invalid maxBytes %s before file access", async (maxBytes) => {
    expect(() => normalizeContentMaxBytes(maxBytes)).toThrow("maxBytes must");
    await expect(
      readPackageFile({ projectRoot: "/missing", path: "x", maxBytes })
    ).rejects.toMatchObject({ code: "content_max_bytes_invalid" });
    await expect(
      readPromptSource({ projectRoot: "/missing", target: "project", maxBytes })
    ).rejects.toMatchObject({ code: "content_max_bytes_invalid" });
    await expect(
      readRenderedPrompt({ projectRoot: "/missing", ref: "T-001#B-001", maxBytes })
    ).rejects.toMatchObject({ code: "content_max_bytes_invalid" });
  });

  it("closes on exact limit, stat excess, growth, I/O failure and cancellation", async () => {
    const exact = memoryHandle(Buffer.from("1234"));
    expect(
      await readBoundedUtf8File("fixture", {
        maxBytes: 2,
        maxReadBytes: 4,
        openFile: async () => exact.handle
      })
    ).toMatchObject({ content: "12", sizeBytes: 4 });
    expect(exact.state().closed).toBe(true);
    for (const statSize of [5, 4]) {
      const over = memoryHandle(Buffer.from("12345"), { statSize });
      await expect(
        readBoundedUtf8File("fixture", {
          maxBytes: 2,
          maxReadBytes: 4,
          openFile: async () => over.handle
        })
      ).rejects.toMatchObject({ code: "content_file_budget_exceeded" });
      expect(over.state().closed).toBe(true);
      expect(over.state().bytesRead).toBeLessThanOrEqual(5);
    }
    const failure = memoryHandle(Buffer.from("1234"), { failAt: 2, chunkSize: 2 });
    await expect(
      readBoundedUtf8File("fixture", { maxBytes: 2, openFile: async () => failure.handle })
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(failure.state().closed).toBe(true);
    const controller = new AbortController();
    const cancelled = memoryHandle(Buffer.from("1234"), { onRead: () => controller.abort() });
    await expect(
      readBoundedUtf8File("fixture", {
        maxBytes: 2,
        signal: controller.signal,
        openFile: async () => cancelled.handle
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.state().closed).toBe(true);
  });

  it("retains one fixed read buffer and limited output", async () => {
    const source = memoryHandle(Buffer.alloc(8 * CONTENT_READ_CHUNK_BYTES, 97));
    const result = await readBoundedUtf8File("fixture", {
      maxBytes: 7,
      openFile: async () => source.handle
    });
    expect(result.content).toBe("aaaaaaa");
    expect(result.preview).toHaveLength(220);
    expect(source.state().buffers.size).toBe(1);
    expect([...source.state().buffers][0]?.length).toBe(CONTENT_READ_CHUNK_BYTES);
    expect(source.state().calls).toBe(9);
    expect(result.inputBytes).toBe(8 * CONTENT_READ_CHUNK_BYTES);
  });
});
