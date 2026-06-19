import { afterEach, describe, expect, it } from "vitest";
import { claimNext, getExecutionStatus, submitBlockResult, submitReviewResult } from "../index.js";
import { runReviewHookProcess } from "../taskManager/reviewHook.js";
import type { ReviewHookDefinition } from "../types.js";
import { basicManifest, createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

const reviewRef = "T-001#R-001";

function executableHook(script: string): ReviewHookDefinition {
  return {
    id: "test-review-hook",
    type: "executable",
    command: process.execPath,
    args: ["-e", script],
    executionPolicy: "trusted-local"
  };
}

async function submitNeedsChangesWithHook(hook: ReviewHookDefinition): Promise<{ blockedReason: string | null; feedbackContent: string | null }> {
  const { root } = await createTestWorkspace(basicManifest({ reviewHook: hook }));
  await claimNext({ projectRoot: root });
  const reportPath = await writeReport(root, "implementation.md", "Implementation report.\n");
  await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath });
  await claimNext({ projectRoot: root });
  const resultPath = await writeReviewResult(root, "needs_changes", "Original feedback.", reviewRef);
  await submitReviewResult({ projectRoot: root, ref: reviewRef, resultPath });
  const status = await getExecutionStatus({ projectRoot: root });
  const reviewBlock = status.blocks.find((block) => block.ref === reviewRef);
  if (!reviewBlock) {
    throw new Error("Review block missing from execution status.");
  }
  const feedbackClaim = await claimNext({ projectRoot: root });
  return {
    blockedReason: reviewBlock.reason,
    feedbackContent: feedbackClaim.kind === "feedback" ? feedbackClaim.content : null
  };
}

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("review hook execution boundary", () => {
  it("uses valid hook JSON as rewritten feedback", async () => {
    const hook = executableHook(
      "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const parsed = JSON.parse(input); process.stdout.write(JSON.stringify({ action: 'use_feedback', feedbackPrompt: 'Hooked ' + parsed.reviewBlockRef })); });"
    );

    await expect(submitNeedsChangesWithHook(hook)).resolves.toEqual({
      blockedReason: null,
      feedbackContent: "Hooked T-001#R-001"
    });
  });

  it("blocks when hook output is not JSON", async () => {
    const hook = executableHook("process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('not json'));");

    await expect(submitNeedsChangesWithHook(hook)).resolves.toMatchObject({
      blockedReason: expect.stringContaining("Review hook failed: Review hook returned invalid JSON"),
      feedbackContent: null
    });
  });

  it("blocks when hook JSON fails the output schema", async () => {
    const hook = executableHook(
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ action: 'use_feedback' })));"
    );

    await expect(submitNeedsChangesWithHook(hook)).resolves.toMatchObject({
      blockedReason: expect.stringContaining("Review hook failed: Review hook output schema invalid"),
      feedbackContent: null
    });
  });

  it("blocks before parsing when hook stdout exceeds the byte limit", async () => {
    const hook = executableHook(
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(Buffer.alloc(1048577, 65)));"
    );

    await expect(submitNeedsChangesWithHook(hook)).resolves.toMatchObject({
      blockedReason: expect.stringContaining("Review hook failed: Review hook stdout exceeded 1048576 bytes."),
      feedbackContent: null
    });
  });

  it("blocks when hook stderr exceeds the byte limit", async () => {
    const hook = executableHook(
      "process.stdin.resume(); process.stdin.on('end', () => { const chunk = Buffer.alloc(65536, 66); const writeMore = () => { for (let index = 0; index < 64; index += 1) { process.stderr.write(chunk); } setImmediate(writeMore); }; writeMore(); });"
    );

    await expect(submitNeedsChangesWithHook(hook)).resolves.toMatchObject({
      blockedReason: expect.stringContaining("Review hook failed: Review hook stderr exceeded 1048576 bytes."),
      feedbackContent: null
    });
  });

  it("blocks on non-zero exit with bounded stderr detail", async () => {
    const hook = executableHook("process.stdin.resume(); process.stdin.on('end', () => { console.error('hook exploded'); process.exit(7); });");

    await expect(submitNeedsChangesWithHook(hook)).resolves.toMatchObject({
      blockedReason: "Review hook failed: hook exploded",
      feedbackContent: null
    });
  });

  it("preserves stderr detail when non-zero exit exactly reaches the byte limit", async () => {
    await expect(
      runReviewHookProcess({
        command: process.execPath,
        args: ["-e", "process.stderr.write('12345678'); process.exit(7);"],
        cwd: process.cwd(),
        stdin: "{}",
        limits: {
          timeoutMs: 1000,
          stdoutLimitBytes: 1024,
          stderrLimitBytes: 8
        }
      })
    ).rejects.toThrow("12345678");
  });

  it("times out hook processes through the shared process boundary", async () => {
    await expect(
      runReviewHookProcess({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 5000);"],
        cwd: process.cwd(),
        stdin: "{}",
        limits: {
          timeoutMs: 25,
          stdoutLimitBytes: 1024,
          stderrLimitBytes: 1024
        }
      })
    ).rejects.toThrow("Review hook timed out after 25ms.");
  });
});
