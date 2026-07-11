import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  materializeArtifactBytes,
  readVerifiedArtifactReference
} from "../autoRun/artifactReferenceContract.js";
import { claimNext, getExecutionStatus, submitBlockResult } from "../taskManager/index.js";
import {
  submitBlockResultFromBytes,
  submitVerifiedBlockResult
} from "../taskManager/blockSubmission.js";
import type { TaskResultIndex } from "../types.js";
import { createTestWorkspace, writeReport } from "./promptTestHelpers.js";

describe("submitBlockResult", () => {
  it("stores implementation reports under the block run history", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });

    const result = await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "report.md")
    });

    expect(result).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    await expect(
      access(
        join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "report.md")
      )
    ).resolves.toBeUndefined();
  });

  it("does not accept review blocks", async () => {
    const { root } = await createTestWorkspace();

    await expect(
      submitBlockResult({
        projectRoot: root,
        ref: "T-001#R-001",
        reportPath: await writeReport(root, "review.md")
      })
    ).rejects.toThrow("submit-result only accepts implementation blocks");
  });

  it("recovers an already persisted run when state was not updated", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const runDir = join(runRoot, "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      submittedAt: "2026-05-25T00:00:00.000Z",
      reportHash: createHash("sha256").update("report\n").digest("hex"),
      sourceReportPath: "/tmp/original-report.md"
    });
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-001" },
      counts: { runs: 1 }
    });

    const result = await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "retry.md")
    });

    expect(result).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    await expect(access(join(runRoot, "RUN-002"))).rejects.toThrow();
    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
      status: "completed",
      lastRunId: "RUN-001"
    });
    expect(status.currentRefs).toEqual([]);
    await expect(
      readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).resolves.toMatchObject({
      latestRunByBlock: { "T-001#B-001": "RUN-001" },
      counts: { runs: 1 }
    });
  });

  it("recovers a persisted run without creating a duplicate when the task index was not updated", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const runDir = join(runRoot, "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      submittedAt: "2026-05-25T00:00:00.000Z",
      reportHash: createHash("sha256").update("report\n").digest("hex"),
      sourceReportPath: "/tmp/original-report.md"
    });

    const result = await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "retry.md")
    });

    expect(result).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    await expect(access(join(runRoot, "RUN-002"))).rejects.toThrow();
    await expect(
      readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).resolves.toMatchObject({
      latestRunByBlock: { "T-001#B-001": "RUN-001" }
    });
  });

  it("returns the same run id when the same report is submitted again", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const reportPath = await writeReport(root, "same-report.md", "same report\n");

    const first = await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath });
    const second = await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath });

    expect(first).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    expect(second).toEqual(first);
  });

  it("fails closed when a completed run's canonical report was changed", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const reportPath = await writeReport(root, "same-report.md", "same report\n");
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath });
    await writeFile(
      join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "report.md"),
      "tampered report\n",
      "utf8"
    );

    await expect(
      submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath })
    ).rejects.toThrow("does not match its submitted hash");
  });

  it("persists verified bytes into a pre-created run after the source path changes", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "runner placeholder\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      outcome: "succeeded"
    });
    const sourcePath = await writeReport(root, "verified.md", "verified report\n");
    const verifiedBytes = await readFile(sourcePath);
    await writeFile(sourcePath, "replaced source\n", "utf8");

    const result = await submitBlockResultFromBytes(
      {
        projectRoot: root,
        ref: "T-001#B-001",
        reportPath: sourcePath,
        runId: "RUN-001"
      },
      verifiedBytes
    );

    expect(result).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    await expect(readFile(join(runDir, "report.md"), "utf8")).resolves.toBe("verified report\n");
    await expect(
      readJsonFile<Record<string, unknown>>(join(runDir, "metadata.json"))
    ).resolves.toMatchObject({
      reportHash: createHash("sha256").update(verifiedBytes).digest("hex")
    });
    expect(await getExecutionStatus({ projectRoot: root })).toMatchObject({ currentRefs: [] });
  });

  it("atomically replaces a final symlink without writing through to its target", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    const reference = await materializeArtifactBytes({
      rootDir: runDir,
      relativePath: "report.md",
      kind: "implementation",
      content: "verified report\n"
    });
    const verified = await readVerifiedArtifactReference({ rootDir: runDir, value: reference });
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      outcome: "succeeded",
      artifactReference: reference
    });
    const outsidePath = join(root, "outside.md");
    await writeFile(outsidePath, "outside unchanged\n", "utf8");

    const submissionOptions = {
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: join(runDir, "report.md"),
      runId: "RUN-001"
    };
    const first = await submitVerifiedBlockResult(submissionOptions, verified, {
      async beforeCommit() {
        await unlink(join(runDir, "report.md"));
        await symlink(outsidePath, join(runDir, "report.md"));
      }
    });
    const second = await submitVerifiedBlockResult(submissionOptions, verified);

    expect(first).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    expect(second).toEqual(first);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("outside unchanged\n");
    expect((await lstat(join(runDir, "report.md"))).isFile()).toBe(true);
    await expect(readFile(join(runDir, "report.md"), "utf8")).resolves.toBe("verified report\n");
  });

  it("fails closed on a completed canonical symlink without advancing in-progress state", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    const reference = await materializeArtifactBytes({
      rootDir: runDir,
      relativePath: "report.md",
      kind: "implementation",
      content: "verified report\n"
    });
    const verified = await readVerifiedArtifactReference({ rootDir: runDir, value: reference });
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      outcome: "succeeded",
      reportHash: reference.sha256,
      artifactReference: reference
    });
    const outsidePath = join(root, "outside.md");
    await writeFile(outsidePath, "verified report\n", "utf8");
    await unlink(join(runDir, "report.md"));
    await symlink(outsidePath, join(runDir, "report.md"));

    await expect(
      submitVerifiedBlockResult(
        {
          projectRoot: root,
          ref: "T-001#B-001",
          reportPath: join(runDir, "report.md"),
          runId: "RUN-001"
        },
        verified
      )
    ).rejects.toThrow("safely opened without following symbolic links");
    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.currentRefs).toEqual(["T-001#B-001"]);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
      status: "in_progress",
      lastRunId: null
    });
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("verified report\n");
  });
});
