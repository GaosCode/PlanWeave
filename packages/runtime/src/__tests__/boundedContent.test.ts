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
