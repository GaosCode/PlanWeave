import { constants } from "node:fs";
import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FINAL_ARTIFACT_MARKER,
  FINAL_ARTIFACT_MAX_CONTENT_BYTES,
  FinalArtifactContractError,
  encodeFinalArtifactEnvelope,
  extractFinalArtifactEnvelope,
  feedbackArtifactEnvelope,
  finalArtifactPromptInstruction,
  implementationArtifactEnvelope,
  materializeFinalArtifact,
  reviewArtifactEnvelope
} from "../autoRun/finalArtifactContract.js";
import {
  ArtifactReferenceVerificationError,
  createArtifactReference,
  materializeArtifactBytes,
  readVerifiedArtifactReference,
  verifyArtifactReference
} from "../autoRun/artifactReferenceContract.js";
import { artifactReferenceSchema } from "../autoRun/runnerContractSchemas.js";
import { readJsonFile } from "../json.js";
import {
  runTerminalAgentProtocolBlock,
  runTerminalAgentProtocolFeedback
} from "../autoRun/terminalAgentExecutor.js";
import type { CliProcessExecutor } from "../autoRun/cliProcess.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { getRunRecord } from "../desktop/index.js";

const expected = { kind: "implementation", ref: "T-001#B-001", taskId: "T-001" } as const;

describe("final artifact envelope codec", () => {
  it("has the no-follow and exclusive-open flags required by atomic materialization", () => {
    expect(typeof constants.O_NOFOLLOW).toBe("number");
    expect(typeof constants.O_EXCL).toBe("number");
  });

  it("uses one newline-terminated marker line and materializes the validated envelope", async () => {
    const envelope = implementationArtifactEnvelope({
      ref: expected.ref,
      taskId: expected.taskId,
      reportMarkdown: "implemented\n"
    });
    const framed = encodeFinalArtifactEnvelope(envelope);
    expect(framed.startsWith(FINAL_ARTIFACT_MARKER)).toBe(true);
    expect(framed.endsWith("\n")).toBe(true);
    expect(extractFinalArtifactEnvelope(`human output\n${framed}`, expected)).toEqual(envelope);

    const { init } = await createTestWorkspace();
    const path = join(init.workspace.resultsDir, "materialized.md");
    const reference = await materializeFinalArtifact({
      envelope,
      expected,
      rootDir: init.workspace.resultsDir,
      relativePath: "materialized.md"
    });
    await expect(readFile(path, "utf8")).resolves.toBe("implemented\n");
    await expect(
      verifyArtifactReference({ rootDir: init.workspace.resultsDir, reference })
    ).resolves.toEqual(reference);
  });

  it.each([
    [
      { kind: "implementation", ref: "T-001#B-001", taskId: "T-001" } as const,
      { kind: "implementation", ref: "T-001#B-001", taskId: "T-001", reportMarkdown: "" }
    ],
    [
      { kind: "review", ref: "T-002#R-003", taskId: "T-002" } as const,
      {
        kind: "review",
        ref: "T-002#R-003",
        taskId: "T-002",
        reviewResult: {
          reviewBlockRef: "T-002#R-003",
          taskId: "T-002",
          verdict: "passed|needs_changes",
          content: ""
        }
      }
    ],
    [
      {
        kind: "feedback",
        feedbackId: "FE-004",
        sourceReviewBlockRef: "T-003#R-002",
        taskId: "T-003"
      } as const,
      {
        kind: "feedback",
        feedbackId: "FE-004",
        sourceReviewBlockRef: "T-003#R-002",
        taskId: "T-003",
        reportMarkdown: ""
      }
    ]
  ])("generates a runner-only %s instruction with exact identity", (identity, artifact) => {
    const instruction = finalArtifactPromptInstruction(identity);
    const markerLine = instruction
      .split("\n")
      .find((line) => line.startsWith("Use this exact envelope and identity: "));
    expect(instruction).toContain("final response MUST contain exactly one");
    expect(instruction).toContain("transport may omit the trailing newline");
    expect(instruction).toContain("Do not use a Markdown fence");
    expect(markerLine).toBeDefined();
    const markerIndex = markerLine!.indexOf(FINAL_ARTIFACT_MARKER);
    expect(JSON.parse(markerLine!.slice(markerIndex + FINAL_ARTIFACT_MARKER.length))).toEqual({
      version: "planweave.runner-artifact/v1",
      artifact
    });
  });

  it("accepts a unique complete marker after provider text with or without a trailing newline", () => {
    const envelope = implementationArtifactEnvelope({
      ref: expected.ref,
      taskId: expected.taskId,
      reportMarkdown: "live provider report"
    });
    const marker = encodeFinalArtifactEnvelope(envelope).trimEnd();

    expect(extractFinalArtifactEnvelope(marker, expected)).toEqual(envelope);
    expect(extractFinalArtifactEnvelope(`provider prefix ${marker}`, expected)).toEqual(envelope);
    expect(extractFinalArtifactEnvelope(`provider prefix\n${marker}\n`, expected)).toEqual(envelope);
  });

  it("keeps descriptor-verified bytes authoritative after the source path changes", async () => {
    const { init } = await createTestWorkspace();
    const rootDir = init.workspace.resultsDir;
    const reference = await materializeArtifactBytes({
      rootDir,
      relativePath: "report.md",
      kind: "implementation",
      content: "verified report\n"
    });
    const verified = await readVerifiedArtifactReference({ rootDir, value: reference });
    await writeFile(join(rootDir, "replacement.md"), "replacement data\n");
    await rename(join(rootDir, "replacement.md"), join(rootDir, "report.md"));

    expect(verified.reference).toEqual(reference);
    expect(verified.bytes.toString("utf8")).toBe("verified report\n");
    await expect(
      readVerifiedArtifactReference({ rootDir, value: reference })
    ).rejects.toBeInstanceOf(ArtifactReferenceVerificationError);
  });

  it.each([
    ["missing", "human output\n"],
    [
      "multiple",
      `${encodeFinalArtifactEnvelope(implementationArtifactEnvelope({ ref: expected.ref, taskId: expected.taskId, reportMarkdown: "a" }))}${encodeFinalArtifactEnvelope(implementationArtifactEnvelope({ ref: expected.ref, taskId: expected.taskId, reportMarkdown: "b" }))}`
    ],
    ["malformed", `${FINAL_ARTIFACT_MARKER}{bad}\n`],
    ["truncated", `${FINAL_ARTIFACT_MARKER}{\"version\":`],
    [
      "malformed",
      `${encodeFinalArtifactEnvelope(implementationArtifactEnvelope({ ref: expected.ref, taskId: expected.taskId, reportMarkdown: "valid" })).trimEnd()} trailing text\n`
    ],
    [
      "malformed",
      `${encodeFinalArtifactEnvelope(implementationArtifactEnvelope({ ref: expected.ref, taskId: expected.taskId, reportMarkdown: "valid" })).trimEnd()} \n`
    ],
    [
      "malformed",
      `${FINAL_ARTIFACT_MARKER}\t${JSON.stringify(implementationArtifactEnvelope({ ref: expected.ref, taskId: expected.taskId, reportMarkdown: "valid" }))}\r\n`
    ]
  ])("fails closed on %s framing", (code, output) => {
    expect(() => extractFinalArtifactEnvelope(output, expected)).toThrowError(
      expect.objectContaining<Partial<FinalArtifactContractError>>({ code })
    );
  });

  it("rejects mismatched review identity and oversized content", () => {
    expect(() =>
      implementationArtifactEnvelope({
        ref: expected.ref,
        taskId: expected.taskId,
        reportMarkdown: ""
      })
    ).toThrow();
    expect(() =>
      reviewArtifactEnvelope({
        ref: "T-001#R-001",
        taskId: "T-001",
        reviewResult: {
          reviewBlockRef: "T-002#R-001",
          taskId: "T-002",
          verdict: "passed",
          content: "wrong"
        }
      })
    ).toThrow("identity");
    expect(() =>
      implementationArtifactEnvelope({
        ref: expected.ref,
        taskId: expected.taskId,
        reportMarkdown: "x".repeat(FINAL_ARTIFACT_MAX_CONTENT_BYTES + 1)
      })
    ).toThrow("exceeds");
  });

  it("rejects whitespace-only implementation, review, and feedback reports", () => {
    expect(() =>
      implementationArtifactEnvelope({
        ref: expected.ref,
        taskId: expected.taskId,
        reportMarkdown: "   \n\t"
      })
    ).toThrow("blank");
    expect(() =>
      reviewArtifactEnvelope({
        ref: "T-001#R-001",
        taskId: "T-001",
        reviewResult: {
          reviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          verdict: "passed",
          content: "  \n\t"
        }
      })
    ).toThrow("blank");
    expect(() =>
      feedbackArtifactEnvelope({
        feedbackId: "FE-001",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        reportMarkdown: "\n\t"
      })
    ).toThrow("blank");
  });

  it.each([
    "/tmp/report.md",
    "../report.md",
    "a/../report.md",
    "./report.md",
    "a//b",
    "a\\b"
  ])("rejects unsafe artifact paths: %s", (relativePath) => {
    expect(
      artifactReferenceSchema.safeParse({
        version: "planweave.runner/v1",
        kind: "implementation",
        relativePath,
        sha256: "a".repeat(64),
        sizeBytes: 1,
        mediaType: "text/markdown"
      }).success
    ).toBe(false);
  });

  it("binds media type to kind and detects size/digest tampering on reopen", async () => {
    expect(
      artifactReferenceSchema.safeParse({
        version: "planweave.runner/v1",
        kind: "review",
        relativePath: "review-result.json",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        mediaType: "text/markdown"
      }).success
    ).toBe(false);
    const { init } = await createTestWorkspace();
    const path = join(init.workspace.resultsDir, "report.md");
    await writeFile(path, "original", "utf8");
    const reference = await createArtifactReference({
      rootDir: init.workspace.resultsDir,
      relativePath: "report.md",
      kind: "implementation"
    });
    await expect(
      verifyArtifactReference({
        rootDir: init.workspace.resultsDir,
        reference: { ...reference, sizeBytes: reference.sizeBytes + 1 }
      })
    ).rejects.toThrow("size");
    await writeFile(path, "tampered", "utf8");
    await expect(
      verifyArtifactReference({ rootDir: init.workspace.resultsDir, reference })
    ).rejects.toThrow("digest");
  });

  it("rejects target and parent symlink escapes before write and during reopen verification", async () => {
    const { init } = await createTestWorkspace();
    const outside = join(init.workspace.rootPath, "outside.md");
    await writeFile(outside, "outside-safe", "utf8");
    await symlink(outside, join(init.workspace.resultsDir, "linked.md"));
    const envelope = implementationArtifactEnvelope({
      ref: expected.ref,
      taskId: expected.taskId,
      reportMarkdown: "must-not-write"
    });
    await expect(
      materializeFinalArtifact({
        envelope,
        expected,
        rootDir: init.workspace.resultsDir,
        relativePath: "linked.md"
      })
    ).resolves.toMatchObject({ relativePath: "linked.md" });
    await expect(readFile(outside, "utf8")).resolves.toBe("outside-safe");

    const realPath = join(init.workspace.resultsDir, "real.md");
    await writeFile(realPath, "verified", "utf8");
    const reference = await createArtifactReference({
      rootDir: init.workspace.resultsDir,
      relativePath: "real.md",
      kind: "implementation"
    });
    await rename(realPath, join(init.workspace.resultsDir, "saved.md"));
    await symlink(outside, realPath);
    await expect(
      verifyArtifactReference({ rootDir: init.workspace.resultsDir, reference })
    ).rejects.toThrow("without following symbolic links");

    const outsideDir = join(init.workspace.rootPath, "outside-dir");
    await mkdir(outsideDir);
    const nestedLink = join(init.workspace.resultsDir, "linked-parent");
    await symlink(outsideDir, nestedLink);
    await expect(
      materializeFinalArtifact({
        envelope,
        expected,
        rootDir: init.workspace.resultsDir,
        relativePath: "linked-parent/report.md"
      })
    ).rejects.toThrow("one normalized file name");
    await unlink(nestedLink);
  });

  it("never follows a target symlink inserted immediately before atomic publication", async () => {
    const { init } = await createTestWorkspace();
    const outside = join(init.workspace.rootPath, "outside-race.md");
    await writeFile(outside, "outside-safe", "utf8");
    const target = join(init.workspace.resultsDir, "race.md");
    await expect(
      materializeArtifactBytes(
        {
          rootDir: init.workspace.resultsDir,
          relativePath: "race.md",
          kind: "implementation",
          content: "must-not-escape"
        },
        { beforeCommit: async () => symlink(outside, target) }
      )
    ).resolves.toMatchObject({ relativePath: "race.md" });
    await expect(readFile(outside, "utf8")).resolves.toBe("outside-safe");
    await expect(readFile(target, "utf8")).resolves.toBe("must-not-escape");
    expect(
      (await readdir(init.workspace.resultsDir)).some((name) =>
        name.startsWith(".planweave-artifact-")
      )
    ).toBe(false);
  });

  it("removes the descriptor-backed temporary file when publication is interrupted", async () => {
    const { init } = await createTestWorkspace();
    await expect(
      materializeArtifactBytes(
        {
          rootDir: init.workspace.resultsDir,
          relativePath: "interrupted.md",
          kind: "implementation",
          content: "not published"
        },
        {
          beforeCommit: () => {
            throw new Error("interrupt publication");
          }
        }
      )
    ).rejects.toThrow("interrupt publication");
    expect(
      (await readdir(init.workspace.resultsDir)).some((name) =>
        name.startsWith(".planweave-artifact-")
      )
    ).toBe(false);
  });

  it("rejects a replaceable nested parent before opening or invoking race hooks", async () => {
    const { init } = await createTestWorkspace();
    const outsideDir = join(init.workspace.rootPath, "outside-race-dir");
    await mkdir(outsideDir);
    await symlink(outsideDir, join(init.workspace.resultsDir, "replaceable-parent"));
    let hookInvoked = false;
    await expect(
      materializeArtifactBytes(
        {
          rootDir: init.workspace.resultsDir,
          relativePath: "replaceable-parent/race.md",
          kind: "implementation",
          content: "must-not-escape"
        },
        {
          beforeCommit: () => {
            hookInvoked = true;
          }
        }
      )
    ).rejects.toThrow("one normalized file name");
    expect(hookInvoked).toBe(false);
    await expect(readFile(join(outsideDir, "race.md"), "utf8")).rejects.toThrow();
  });
});

describe("terminal artifact materialization ordering", () => {
  const profile = {
    adapter: "agent",
    agent: "codex",
    runner: { transport: "cli" },
    command: "fake-codex",
    args: []
  } as const;
  const protocol = {
    adapter: "codex-exec",
    reviewResultMode: "stdout-json",
    buildInvocation: ({ prompt }: { prompt: string }) => ({
      command: "fake-codex",
      args: [],
      stdin: prompt
    })
  } as const;

  it("marks process-success/review-malformed metadata failed, never succeeded", async () => {
    const { init } = await createTestWorkspace();
    const executeProcess: CliProcessExecutor = async () => ({
      stdout: "{malformed",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      tmux: null
    });
    await expect(
      runTerminalAgentProtocolBlock({
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#R-001",
          taskId: "T-001",
          blockId: "R-001",
          blockType: "review",
          effectiveExecutor: "codex"
        },
        prompt: "review",
        executorName: "codex",
        profile,
        protocol,
        executeProcess
      })
    ).rejects.toThrow("invalid review artifact");
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "R-001",
        "runs",
        "RUN-001",
        "metadata.json"
      )
    );
    expect(metadata).toMatchObject({ outcome: "failed", exitCode: 0 });
    expect(metadata.failureReason).toContain("invalid review artifact");
  });

  it("marks metadata succeeded only after a valid review artifact is materialized", async () => {
    const { init } = await createTestWorkspace();
    const executeProcess: CliProcessExecutor = async () => ({
      stdout: JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "passed",
        content: "approved"
      }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      tmux: null
    });
    const result = await runTerminalAgentProtocolBlock({
      projectRoot: init.workspace,
      claim: {
        kind: "block",
        ref: "T-001#R-001",
        taskId: "T-001",
        blockId: "R-001",
        blockType: "review",
        effectiveExecutor: "codex"
      },
      prompt: "review",
      executorName: "codex",
      profile,
      protocol,
      executeProcess
    });
    if (result.kind !== "review") {
      throw new Error("Expected review result.");
    }
    await expect(readJsonFile(result.resultPath)).resolves.toMatchObject({ verdict: "passed" });
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "R-001",
        "runs",
        "RUN-001",
        "metadata.json"
      )
    );
    expect(metadata).toMatchObject({ outcome: "succeeded", failureReason: null });
    expect(metadata.artifactReference).toMatchObject({
      kind: "review",
      relativePath: "review-result.json",
      mediaType: "application/json"
    });
  });

  it("stores a verified implementation reference before returning the existing report path", async () => {
    const { init } = await createTestWorkspace();
    const executeProcess: CliProcessExecutor = async () => ({
      stdout: "implemented\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      tmux: null
    });
    const result = await runTerminalAgentProtocolBlock({
      projectRoot: init.workspace,
      claim: {
        kind: "block",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        blockType: "implementation",
        effectiveExecutor: "codex"
      },
      prompt: "implement",
      executorName: "codex",
      profile,
      protocol,
      executeProcess
    });
    expect(result).toMatchObject({
      kind: "block",
      reportPath: expect.stringContaining("report.md")
    });
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-001",
        "metadata.json"
      )
    );
    expect(metadata).toMatchObject({
      outcome: "succeeded",
      artifactReference: {
        kind: "implementation",
        relativePath: "report.md",
        mediaType: "text/markdown"
      }
    });
    await writeFile(result.reportPath, "tampered!!!\n", "utf8");
    await expect(getRunRecord(init.workspace, "T-001#B-001::RUN-001")).rejects.toThrow("corrupt");
  });

  it("records metadata failure when implementation materialization itself fails", async () => {
    const { init } = await createTestWorkspace();
    const executeProcess: CliProcessExecutor = async (request) => {
      await mkdir(join(dirname(request.stdoutPath), "report.md"));
      return { stdout: "implemented", stderr: "", exitCode: 0, timedOut: false, tmux: null };
    };
    await expect(
      runTerminalAgentProtocolBlock({
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          blockType: "implementation",
          effectiveExecutor: "codex"
        },
        prompt: "implement",
        executorName: "codex",
        profile,
        protocol,
        executeProcess
      })
    ).rejects.toThrow("invalid implementation artifact");
    await expect(
      readJsonFile<Record<string, unknown>>(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toMatchObject({ outcome: "failed" });
  });

  it("materializes implementation through the codec and fails oversized content before success", async () => {
    const { init } = await createTestWorkspace();
    const executeProcess: CliProcessExecutor = async () => ({
      stdout: "x".repeat(FINAL_ARTIFACT_MAX_CONTENT_BYTES + 1),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      tmux: null
    });
    await expect(
      runTerminalAgentProtocolBlock({
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          blockType: "implementation",
          effectiveExecutor: "codex"
        },
        prompt: "implement",
        executorName: "codex",
        profile,
        protocol,
        executeProcess
      })
    ).rejects.toThrow("invalid implementation artifact");
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-001",
        "metadata.json"
      )
    );
    expect(metadata).toMatchObject({ outcome: "failed", exitCode: 0 });
    expect(metadata.failureReason).toContain("exceeds");
  });

  it("materializes feedback before recording terminal success", async () => {
    const { init } = await createTestWorkspace();
    const executeProcess: CliProcessExecutor = async () => ({
      stdout: "feedback handled\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      tmux: null
    });
    const result = await runTerminalAgentProtocolFeedback({
      projectRoot: init.workspace.rootPath,
      executionCwd: init.workspace.sourceRoot ?? init.workspace.rootPath,
      planweaveHome: init.workspace.planweaveHome,
      workspaceResultsDir: init.workspace.resultsDir,
      claim: {
        kind: "feedback",
        feedbackId: "FE-001",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        content: "address feedback",
        effectiveExecutor: "codex"
      },
      executorName: "codex",
      profile,
      protocol,
      executeProcess
    });
    if (result.kind !== "feedback") {
      throw new Error("Expected feedback result.");
    }
    await expect(readFile(result.reportPath, "utf8")).resolves.toBe("feedback handled\n");
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(init.workspace.resultsDir, "feedback-runs", "RUN-001", "metadata.json")
    );
    expect(metadata).toMatchObject({ outcome: "succeeded", failureReason: null });
    expect(metadata.artifactReference).toMatchObject({
      kind: "feedback",
      relativePath: "feedback-report.md",
      mediaType: "text/markdown"
    });
  });
});
