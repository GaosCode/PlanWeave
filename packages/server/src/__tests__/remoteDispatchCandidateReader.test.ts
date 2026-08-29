import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ServerCanvasDispatchCandidateReader } from "../canvas/remoteDispatchCandidateReader.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { remoteManifest, setup } from "./support/remoteBlockCoordinatorFixture.js";

function markdownEvidence(bytes: Uint8Array) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    state: "completed" as const,
    reportArtifactRef: `artifact:sha256:${digest}`,
    reportBytes: bytes,
    reportMediaType: "text/markdown"
  };
}

function reviewEvidence(ref: string, taskId: string, verdict: "passed" | "needs_changes") {
  return markdownEvidence(
    Buffer.from(
      JSON.stringify({
        reviewBlockRef: ref,
        taskId,
        verdict,
        content: verdict === "passed" ? "approved" : "revise implementation"
      })
    )
  );
}

describe("ServerCanvasDispatchCandidateReader", () => {
  it("uses the shared implementation final-artifact projection", async () => {
    const fixture = await setup(false);
    const reader = new ServerCanvasDispatchCandidateReader(
      new ContentVersionRepository(fixture.server.database)
    );

    const candidate = await reader.read({ ...fixture.locator, blockRef: "T-001#B-001" });
    expect(candidate.renderedPrompt).toContain("PLANWEAVE RUNNER-ONLY FINAL ARTIFACT CONTRACT");
    expect(candidate.renderedPrompt).toContain(
      '"kind":"implementation","ref":"T-001#B-001","taskId":"T-001"'
    );
  });

  it("fails closed for missing, failed, and unverifiable implementation dependencies", async () => {
    const fixture = await setup(false);
    const evidence = new Map<string, ReturnType<typeof markdownEvidence> | { state: "failed" }>();
    const reader = new ServerCanvasDispatchCandidateReader(
      new ContentVersionRepository(fixture.server.database),
      { read: ({ blockRef }) => evidence.get(blockRef) }
    );

    await expect(reader.read({ ...fixture.locator, blockRef: "T-001#R-001" })).rejects.toThrow(
      "not completed"
    );
    evidence.set("T-001#B-001", { state: "failed" });
    await expect(reader.read({ ...fixture.locator, blockRef: "T-001#R-001" })).rejects.toThrow(
      "not completed"
    );
    evidence.set("T-001#B-001", {
      ...markdownEvidence(Buffer.from("implementation report")),
      reportMediaType: "text/plain"
    });
    await expect(reader.read({ ...fixture.locator, blockRef: "T-001#R-001" })).rejects.toThrow(
      "verified Markdown"
    );
  });

  it("rejects an implementation artifact whose digest does not match its durable identity", async () => {
    const fixture = await setup(false);
    const evidence = markdownEvidence(Buffer.from("implementation report"));
    const reader = new ServerCanvasDispatchCandidateReader(
      new ContentVersionRepository(fixture.server.database),
      {
        read: () => ({ ...evidence, reportArtifactRef: `artifact:sha256:${"0".repeat(64)}` })
      }
    );

    await expect(reader.read({ ...fixture.locator, blockRef: "T-001#R-001" })).rejects.toThrow(
      "digest does not match"
    );
  });

  it("projects a verified implementation artifact into a review dispatch", async () => {
    const fixture = await setup(false);
    const evidence = markdownEvidence(Buffer.from("implementation report"));
    const reader = new ServerCanvasDispatchCandidateReader(
      new ContentVersionRepository(fixture.server.database),
      { read: () => evidence }
    );

    const candidate = await reader.read({ ...fixture.locator, blockRef: "T-001#R-001" });
    expect(candidate.inputArtifacts).toEqual([
      {
        artifactRef: evidence.reportArtifactRef,
        logicalName: "dependency-T-001-B-001-report",
        mediaType: "text/markdown"
      }
    ]);
    expect(candidate.renderedPrompt).toContain("Required Review Result JSON");
    expect(candidate.renderedPrompt).toContain("PLANWEAVE_FINAL_ARTIFACT");
    expect(candidate.renderedPrompt).toContain("PLANWEAVE RUNNER-ONLY FINAL ARTIFACT CONTRACT");
    expect(candidate.renderedPrompt).toContain(
      '"kind":"review","ref":"T-001#R-001","taskId":"T-001"'
    );
  });

  it("requires an authoritative passed review for downstream task dispatch", async () => {
    const manifest = remoteManifest(true);
    manifest.edges = [{ from: "T-002", to: "T-001", type: "depends_on" }];
    const fixture = await setup(false, manifest);
    const implementation = markdownEvidence(Buffer.from("implementation report"));
    let review = reviewEvidence("T-001#R-001", "T-001", "needs_changes");
    const reader = new ServerCanvasDispatchCandidateReader(
      new ContentVersionRepository(fixture.server.database),
      {
        read: ({ blockRef }) => (blockRef === "T-001#R-001" ? review : implementation)
      }
    );

    await expect(reader.read({ ...fixture.locator, blockRef: "T-002#B-001" })).rejects.toThrow(
      "has not passed"
    );
    review = reviewEvidence("T-001#R-001", "T-001", "passed");
    const candidate = await reader.read({ ...fixture.locator, blockRef: "T-002#B-001" });
    expect(candidate.dependencySummaries).toContainEqual(
      expect.objectContaining({ blockRef: "T-001#R-001", outcome: "passed" })
    );
  });

  it("requires a directly depended-on required review to have a verified passed artifact", async () => {
    const manifest = remoteManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (!task || task.type !== "task") throw new Error("test_task_missing");
    task.blocks.push({
      id: "B-002",
      type: "implementation",
      title: "Consume approved review",
      prompt: "nodes/T-001/blocks/B-002.prompt.md",
      depends_on: ["R-001"]
    });
    const fixture = await setup(false, manifest);
    let review: ReturnType<typeof markdownEvidence> | { state: "completed" } = reviewEvidence(
      "T-001#R-001",
      "T-001",
      "needs_changes"
    );
    const reader = new ServerCanvasDispatchCandidateReader(
      new ContentVersionRepository(fixture.server.database),
      { read: () => review }
    );

    await expect(reader.read({ ...fixture.locator, blockRef: "T-001#B-002" })).rejects.toThrow(
      "has not passed"
    );
    review = { state: "completed" };
    await expect(reader.read({ ...fixture.locator, blockRef: "T-001#B-002" })).rejects.toThrow(
      "verified Markdown"
    );
    review = reviewEvidence("T-001#R-001", "T-001", "passed");
    const candidate = await reader.read({ ...fixture.locator, blockRef: "T-001#B-002" });
    expect(candidate.dependencySummaries).toContainEqual(
      expect.objectContaining({ blockRef: "T-001#R-001", outcome: "passed" })
    );
  });
});
