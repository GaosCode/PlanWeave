import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as json from "../json.js";
import { readState, writeState } from "../state.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  materializeArtifactBytes,
  readVerifiedArtifactReference
} from "../autoRun/artifactReferenceContract.js";
import {
  claimNext,
  getExecutionStatus,
  markBlockDiverged,
  resolveBlockDivergence,
  submitBlockResult
} from "../taskManager/index.js";
import {
  submitBlockResultFromBytes,
  submitVerifiedBlockResult
} from "../taskManager/blockSubmission.js";
import type { RuntimeState, TaskResultIndex } from "../types.js";
import { readBlockRunIndexView } from "../autoRun/blockRunIndex.js";
import { prepareBlockRun } from "../autoRun/executorShared.js";
import { snapshotDirectory } from "./support/snapshotDirectory.js";
import { basicManifest, createTestWorkspace, writeReport } from "./promptTestHelpers.js";

describe("submitBlockResult", () => {
  it("preserves Unicode task, block, and custom run IDs through the Results root alias", async () => {
    const taskId = "任务 β";
    const blockId = "实现 Ω";
    const runId = "交付 + 1";
    const ref = `${taskId}#${blockId}`;
    const manifest = basicManifest();
    const task = manifest.nodes[0];
    if (task.type !== "task") throw new Error("Expected task fixture");
    task.id = taskId;
    task.prompt = `nodes/${taskId}/prompt.md`;
    for (const block of task.blocks) {
      block.prompt = `nodes/${taskId}/blocks/${block.id}.prompt.md`;
    }
    task.blocks[0].id = blockId;
    task.blocks[1].depends_on = [blockId];
    const { root, init } = await createTestWorkspace(manifest);
    const { resultsDir } = init.workspace;
    const actualResultsDir = `${resultsDir}-backing`;
    await rename(resultsDir, actualResultsDir);
    await symlink(actualResultsDir, resultsDir, process.platform === "win32" ? "junction" : "dir");

    await expect(claimNext({ projectRoot: root })).resolves.toMatchObject({ ref });
    const report = "Unicode identity payload\n";
    const options = {
      projectRoot: root,
      ref,
      runId,
      reportPath: await writeReport(root, "unicode-report.md", report)
    };
    const first = await submitBlockResult(options);
    expect(first).toEqual({ ref, runId, status: "completed" });
    await expect(submitBlockResult(options)).resolves.toEqual(first);
    const runRoot = join(actualResultsDir, taskId, "blocks", blockId, "runs");
    await expect(readFile(join(runRoot, runId, "report.md"), "utf8")).resolves.toBe(report);
    await expect(readJsonFile(join(runRoot, runId, "metadata.json"))).resolves.toMatchObject({
      ref,
      taskId,
      blockId,
      runId
    });
    expect((await readBlockRunIndexView(runRoot, { limit: 10 })).entries).toMatchObject([
      { runId }
    ]);
    await expect(readJsonFile(join(actualResultsDir, taskId, "index.json"))).resolves.toMatchObject(
      {
        latestRunByBlock: { [ref]: runId },
        counts: { runs: 1 }
      }
    );
  });

  it("rejects a run root linked to a similarly named sibling before allocating a run", async () => {
    const { root, init } = await createTestWorkspace();
    const { resultsDir, stateFile } = init.workspace;
    await claimNext({ projectRoot: root });
    const runRoot = join(resultsDir, "T-001", "blocks", "B-001", "runs");
    const outside = `${resultsDir}-outside`;
    const sentinel = join(outside, "sentinel");
    await mkdir(outside);
    await writeFile(sentinel, "outside results");
    await mkdir(dirname(runRoot), { recursive: true });
    await symlink(outside, runRoot, process.platform === "win32" ? "junction" : "dir");
    const historicalState = await readState(stateFile);
    await writeState(stateFile, { ...historicalState, tasks: {} });
    const before = await readFile(stateFile);
    const reportPath = await writeReport(root, "boundary.md");

    await expect(
      submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath })
    ).rejects.toThrow(/Results path .*outside/i);
    expect(await readFile(stateFile)).toEqual(before);
    expect(await readdir(outside)).toEqual(["sentinel"]);
    expect(await readFile(sentinel, "utf8")).toBe("outside results");
    await expect(access(join(resultsDir, "T-001", "index.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it.each([
    "",
    "../outside",
    "RUN\\outside",
    ".internal",
    "C:outside"
  ])("rejects an unsafe submission directory identity (%s) before reserving a run", async (runId) => {
    const { root, init } = await createTestWorkspace();
    const ref = "T-001#B-001";
    await claimNext({ projectRoot: root });
    const before = (await readState(init.workspace.stateFile)).blocks[ref];
    await expect(
      submitBlockResult({
        projectRoot: root,
        ref,
        runId,
        reportPath: await writeReport(root, "unsafe.md")
      })
    ).rejects.toThrow("single directory name");
    expect((await readState(init.workspace.stateFile)).blocks[ref]).toEqual(before);
    await expect(
      access(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { source: "explicit", runId: "CON.txt" },
    { source: "explicit", runId: "RUN-end." },
    { source: "reserved", runId: "AUX.txt" },
    { source: "completed", runId: "RUN-previous." }
  ] as const)("rejects an unsafe $source run ID ($runId) without creating Results directories", async ({
    source,
    runId
  }) => {
    const { root, init } = await createTestWorkspace();
    const { resultsDir, stateFile } = init.workspace;
    const ref = "T-001#B-001";
    await claimNext({ projectRoot: root });
    if (source !== "explicit") {
      const state = await readState(stateFile);
      state.blocks[ref] =
        source === "reserved"
          ? { ...state.blocks[ref], submissionRunId: runId }
          : { ...state.blocks[ref], status: "completed", lastRunId: runId };
      await writeState(stateFile, state);
    }
    const outside = `${resultsDir}-outside`;
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "outside Results");
    const beforeState = await readFile(stateFile);
    const beforeResults = await snapshotDirectory(resultsDir);
    const beforeOutside = await snapshotDirectory(outside);
    expect(beforeResults).toEqual([]);

    await expect(
      submitBlockResult({
        projectRoot: root,
        ref,
        ...(source === "explicit" ? { runId } : {}),
        reportPath: await writeReport(root, "unsafe-run-id.md")
      })
    ).rejects.toMatchObject({
      code: "results_path_outside",
      message: expect.stringContaining(runId)
    });
    expect(await snapshotDirectory(resultsDir)).toEqual(beforeResults);
    expect(await readFile(stateFile)).toEqual(beforeState);
    expect(await snapshotDirectory(outside)).toEqual(beforeOutside);
  });

  it("submits a prepared manual claim without runId into the same RUN and counts it once", async () => {
    const { root, init } = await createTestWorkspace();
    const claim = await claimNext({ projectRoot: root });
    if (claim.kind !== "block") throw new Error("Expected block claim");
    const run = await prepareBlockRun({
      projectRoot: root,
      claim,
      executorName: "manual",
      adapter: "manual",
      profile: { adapter: "manual" },
      prompt: "manual implementation"
    });
    const options = {
      projectRoot: root,
      ref: claim.ref,
      reportPath: await writeReport(root, "manual-prepared.md")
    };
    const result = await submitBlockResult(options);
    expect(result.runId).toBe(run.runId);
    expect(await submitBlockResult(options)).toEqual(result);
    expect(
      (await readdir(join(run.runDir, ".."))).filter((name) => /^RUN-\d+$/.test(name))
    ).toEqual([run.runId]);
    const blockIndex = await readBlockRunIndexView(join(run.runDir, ".."), { limit: 10 });
    expect(blockIndex.entries.map((entry) => entry.runId)).toEqual([run.runId]);
    expect(blockIndex.latestArtifact?.runId).toBe(run.runId);
    expect(await readJsonFile(run.metadataPath)).toMatchObject({
      ref: claim.ref,
      runId: run.runId,
      executor: "manual",
      submissionAttemptId: (await readState(init.workspace.stateFile)).blocks[claim.ref]
        .submissionAttemptId
    });
    expect(
      await readJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).toMatchObject({
      latestRunByBlock: { [claim.ref]: run.runId },
      counts: { runs: 1 }
    });
  });

  it("does not attach a stale executor claim to a newly claimed submission attempt", async () => {
    const { root, init } = await createTestWorkspace();
    const claim = await claimNext({ projectRoot: root });
    if (claim.kind !== "block") throw new Error("Expected block claim");
    await markBlockDiverged({ projectRoot: root, ref: claim.ref, reason: "superseded executor" });
    await resolveBlockDivergence({ projectRoot: root, ref: claim.ref, reason: "retry work" });
    const current = await claimNext({
      projectRoot: root,
      scope: { kind: "block", blockRef: claim.ref }
    });
    if (current.kind !== "block") throw new Error("Expected current block claim");
    const before = await readFile(init.workspace.stateFile, "utf8");
    const preparation = {
      projectRoot: root,
      claim,
      executorName: "manual",
      adapter: "manual" as const,
      profile: { adapter: "manual" as const },
      prompt: "stale executor"
    };
    await expect(prepareBlockRun(preparation)).rejects.toThrow("attempt conflicts");
    expect(await readFile(init.workspace.stateFile, "utf8")).toBe(before);
    const run = await prepareBlockRun({ ...preparation, claim: current });
    expect(run.runId).toBe("RUN-001");
    const result = await submitBlockResult({
      projectRoot: root,
      ref: claim.ref,
      reportPath: await writeReport(root, "current.md")
    });
    expect(result.runId).toBe(run.runId);
  });

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

  it.each([
    undefined,
    "RUN-002"
  ])("keeps a new execution with identical bytes separate (runId=%s)", async (runId) => {
    const { root, init } = await createTestWorkspace();
    const ref = "T-001#B-001";
    const reportPath = await writeReport(root, "same.md", "same report\n");
    await claimNext({ projectRoot: root });
    const first = await submitBlockResult({ projectRoot: root, ref, reportPath, runId: "RUN-001" });
    const runs = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const original = await readFile(join(runs, first.runId, "metadata.json"), "utf8");
    await markBlockDiverged({ projectRoot: root, ref, reason: "new execution" });
    await resolveBlockDivergence({ projectRoot: root, ref, reason: "retry work" });
    await claimNext({ projectRoot: root, scope: { kind: "block", blockRef: ref } });
    await expect(
      submitBlockResult({ projectRoot: root, ref, reportPath, runId: "RUN-001" })
    ).rejects.toThrow("conflicts with submission");
    await expect(access(join(runs, "RUN-002"))).rejects.toThrow();
    const second = await submitBlockResult({ projectRoot: root, ref, reportPath, runId });
    expect(second.runId).toBe("RUN-002");
    expect(await submitBlockResult({ projectRoot: root, ref, reportPath, runId })).toEqual(second);
    expect(await readFile(join(runs, "RUN-001", "metadata.json"), "utf8")).toBe(original);
    const firstMetadata = JSON.parse(original) as { submissionAttemptId: string };
    const secondMetadata = await readJsonFile<{ submissionAttemptId: string }>(
      join(runs, "RUN-002", "metadata.json")
    );
    expect(secondMetadata).toMatchObject({ ref, runId: "RUN-002" });
    expect(secondMetadata.submissionAttemptId).toBeTruthy();
    expect(secondMetadata.submissionAttemptId).not.toBe(firstMetadata.submissionAttemptId);
    expect(
      (await getExecutionStatus({ projectRoot: root })).blocks.find((block) => block.ref === ref)
    ).toMatchObject({ lastRunId: "RUN-002" });
    expect(
      await readJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).toMatchObject({ latestRunByBlock: { [ref]: "RUN-002" }, counts: { runs: 2 } });
  });

  it("rejects a different report for an explicit completed run without changing history", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const options = {
      projectRoot: root,
      ref: "T-001#B-001",
      runId: "RUN-001",
      reportPath: await writeReport(root, "same.md")
    };
    await submitBlockResult(options);
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    const original = await readFile(join(runDir, "metadata.json"), "utf8");
    await expect(
      submitBlockResult({
        ...options,
        reportPath: await writeReport(root, "other.md", "other report\n")
      })
    ).rejects.toThrow("conflicts with submission");
    expect(await readFile(join(runDir, "metadata.json"), "utf8")).toBe(original);
    expect(await readFile(join(runDir, "report.md"), "utf8")).toBe("report\n");
  });

  it.each([
    undefined,
    "RUN-001"
  ])("rejects executor preparation without overwriting a submission-owned run (runId=%s)", async (runId) => {
    const { root, init } = await createTestWorkspace();
    const ref = "T-001#B-001";
    const claim = await claimNext({ projectRoot: root });
    if (claim.kind !== "block") throw new Error("Expected block claim");
    let checkedReservation = false;
    let reservedMetadata: string | undefined;
    const originalWrite = json.writeJsonFile;
    const spy = vi
      .spyOn(json, "writeJsonFile")
      .mockImplementation(async (path, value, writeOptions) => {
        if (
          !checkedReservation &&
          path === init.workspace.stateFile &&
          (value as RuntimeState).blocks[ref].submissionRunId
        ) {
          checkedReservation = true;
          const metadataPath = join(
            init.workspace.resultsDir,
            "T-001",
            "blocks",
            "B-001",
            "runs",
            "RUN-001",
            "metadata.json"
          );
          reservedMetadata = await readFile(metadataPath, "utf8");
          await expect(
            prepareBlockRun({
              projectRoot: root,
              claim,
              executorName: "concurrent-executor",
              adapter: "manual",
              profile: { adapter: "manual" },
              prompt: "independent executor evidence"
            })
          ).rejects.toThrow("identity conflicts with executor preparation");
          expect(await readFile(metadataPath, "utf8")).toBe(reservedMetadata);
        }
        await originalWrite(path, value, writeOptions);
      });
    let result: Awaited<ReturnType<typeof submitBlockResult>>;
    try {
      result = await submitBlockResult({
        projectRoot: root,
        ref,
        reportPath: await writeReport(root, "manual.md"),
        runId
      });
    } finally {
      spy.mockRestore();
    }
    expect(checkedReservation).toBe(true);
    expect(reservedMetadata).toBeDefined();
    expect(result.runId).toBe("RUN-001");
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    expect((await readdir(runRoot)).filter((name) => !name.startsWith("."))).toEqual(["RUN-001"]);
    expect(
      JSON.parse(await readFile(join(runRoot, "RUN-001", "metadata.json"), "utf8"))
    ).toMatchObject({ submissionAttemptId: claim.submissionAttemptId });
  });

  it.each([
    "empty",
    "foreign-file"
  ] as const)("preserves the first metadata error and only releases an empty owned directory (%s)", async (contents) => {
    const { root, init } = await createTestWorkspace();
    const ref = "T-001#B-001";
    await claimNext({ projectRoot: root });
    const options = {
      projectRoot: root,
      ref,
      reportPath: await writeReport(root, "metadata-retry.md")
    };
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const runDir = join(runRoot, "RUN-001");
    const metadataPath = join(runDir, "metadata.json");
    const failure = Object.assign(new Error("initial metadata ENOSPC"), { code: "ENOSPC" });
    const originalWrite = json.writeJsonFile;
    const spy = vi
      .spyOn(json, "writeJsonFile")
      .mockImplementation(async (path, value, writeOptions) => {
        if (path === metadataPath) {
          await originalWrite(path, value, {
            ...writeOptions,
            rename: async () => {
              if (contents === "foreign-file")
                await writeFile(join(runDir, "foreign.txt"), "foreign evidence");
              throw failure;
            }
          });
        } else await originalWrite(path, value, writeOptions);
      });
    try {
      await expect(submitBlockResult(options)).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
    expect((await readState(init.workspace.stateFile)).blocks[ref]).not.toHaveProperty(
      "submissionRunId"
    );
    if (contents === "foreign-file") {
      expect(failure.cause).toMatchObject({ code: "ENOTEMPTY" });
      expect(await readdir(runDir)).toEqual(["foreign.txt"]);
      expect(await readFile(join(runDir, "foreign.txt"), "utf8")).toBe("foreign evidence");
      await expect(submitBlockResult(options)).rejects.toThrow("Submission identity is ambiguous");
      return;
    }
    await expect(access(runDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await submitBlockResult(options)).toEqual({
      ref,
      runId: "RUN-001",
      status: "completed"
    });
    expect((await readdir(runRoot)).filter((name) => /^RUN-\d+$/.test(name))).toEqual(["RUN-001"]);
    expect(
      await readJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).toMatchObject({ latestRunByBlock: { [ref]: "RUN-001" }, counts: { runs: 1 } });
  });

  it.each([
    undefined,
    "RUN-REPORT-LATER"
  ])("retries the same claim after the initial reservation state write fails (runId=%s)", async (explicitRunId) => {
    const { root, init } = await createTestWorkspace();
    const ref = "T-001#B-001";
    const runId = explicitRunId ?? "RUN-001";
    await claimNext({ projectRoot: root });
    const options = {
      projectRoot: root,
      ref,
      runId: explicitRunId,
      reportPath: await writeReport(root, "reservation-retry.md")
    };
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const failure = Object.assign(new Error("reservation ENOSPC"), { code: "ENOSPC" });
    const originalWrite = json.writeJsonFile;
    const spy = vi
      .spyOn(json, "writeJsonFile")
      .mockImplementation(async (path, value, writeOptions) => {
        if (
          path === init.workspace.stateFile &&
          (value as RuntimeState).blocks[ref].submissionRunId
        )
          throw failure;
        await originalWrite(path, value, writeOptions);
      });
    try {
      await expect(submitBlockResult(options)).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
    expect((await readState(init.workspace.stateFile)).blocks[ref]).not.toHaveProperty(
      "submissionRunId"
    );
    expect(await readJsonFile(join(runRoot, runId, "metadata.json"))).toMatchObject({
      runId: runId,
      submissionAttemptId: (await readState(init.workspace.stateFile)).blocks[ref]
        .submissionAttemptId
    });
    const retryOptions = { projectRoot: root, ref, reportPath: options.reportPath };
    const result = await submitBlockResult(retryOptions);
    expect(result).toEqual({ ref, runId: runId, status: "completed" });
    expect(await submitBlockResult(retryOptions)).toEqual(result);
    expect(
      (await readdir(runRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
    ).toEqual([runId]);
    expect(await readFile(join(runRoot, runId, "report.md"), "utf8")).toBe("report\n");
    const blockIndex = await readBlockRunIndexView(runRoot, { limit: 10 });
    expect(blockIndex.entries.map((entry) => entry.runId)).toEqual([runId]);
    expect(blockIndex.latestArtifact?.runId).toBe(runId);
    expect((await readState(init.workspace.stateFile)).blocks[ref]).toMatchObject({
      status: "completed",
      lastRunId: runId,
      submissionRunId: runId
    });
    expect(
      await readJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).toMatchObject({ latestRunByBlock: { [ref]: runId }, counts: { runs: 1 } });
  });

  it.each([
    "report",
    "metadata",
    "index"
  ] as const)("recovers the real %s write boundary without duplicate RUNs", async (stage) => {
    const { root, init } = await createTestWorkspace();
    const ref = "T-001#B-001";
    await claimNext({ projectRoot: root });
    const bytes = Buffer.from("durable retry report\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const artifact = {
      bytes,
      reference: {
        version: "planweave.runner/v1" as const,
        kind: "implementation" as const,
        relativePath: "report.md",
        sha256: hash,
        sizeBytes: bytes.length,
        mediaType: "text/markdown" as const
      }
    };
    const options = {
      projectRoot: root,
      ref,
      reportPath: await writeReport(root, "retry.md", bytes.toString())
    };
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const runDir = join(runRoot, "RUN-001");
    const taskIndex = join(init.workspace.resultsDir, "T-001", "index.json");
    const failure = new Error(`failure after ${stage} persisted`);
    const originalWrite = json.writeJsonFile;
    const spy = vi
      .spyOn(json, "writeJsonFile")
      .mockImplementation(async (path, value, writeOptions) => {
        const finalMetadata =
          path === join(runDir, "metadata.json") &&
          typeof value === "object" &&
          value !== null &&
          "reportHash" in value;
        const finalState =
          path === init.workspace.stateFile &&
          (value as RuntimeState).blocks[ref].status === "completed";
        if (
          (stage === "report" && finalMetadata) ||
          (stage === "metadata" && path === taskIndex) ||
          (stage === "index" && finalState)
        )
          throw failure;
        await originalWrite(path, value, writeOptions);
      });
    try {
      await expect(submitVerifiedBlockResult(options, artifact)).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
    expect(await readFile(join(runDir, "report.md"))).toEqual(bytes);
    const interruptedMetadata = await readJsonFile<Record<string, unknown>>(
      join(runDir, "metadata.json")
    );
    expect(interruptedMetadata).toMatchObject({ runId: "RUN-001", submissionReportHash: hash });
    expect(interruptedMetadata.reportHash).toBe(stage === "report" ? undefined : hash);
    const interruptedState = await readState(init.workspace.stateFile);
    expect(interruptedState.blocks[ref]).toMatchObject({
      status: "in_progress",
      submissionRunId: "RUN-001",
      lastRunId: null,
      submissionAttemptId: interruptedMetadata.submissionAttemptId
    });
    if (stage === "index")
      expect(await readJsonFile(taskIndex)).toMatchObject({
        latestRunByBlock: { [ref]: "RUN-001" },
        counts: { runs: 1 }
      });
    else await expect(access(taskIndex)).rejects.toThrow();
    const conflict = Buffer.from("different retry report\n");
    await expect(submitBlockResultFromBytes(options, conflict)).rejects.toThrow(
      "conflicts with submission"
    );
    expect(await readFile(join(runDir, "report.md"))).toEqual(bytes);
    const recovered = await submitVerifiedBlockResult(options, artifact);
    expect(recovered).toEqual({ ref, runId: "RUN-001", status: "completed" });
    const finishedMetadata = await readFile(join(runDir, "metadata.json"), "utf8");
    expect(await submitVerifiedBlockResult(options, artifact)).toEqual(recovered);
    expect(await readdir(runRoot)).toEqual(expect.arrayContaining(["RUN-001"]));
    expect((await readdir(runRoot)).filter((name) => /^RUN-\d+$/.test(name))).toEqual(["RUN-001"]);
    expect(await readFile(join(runDir, "metadata.json"), "utf8")).toBe(finishedMetadata);
    expect(await readJsonFile(taskIndex)).toMatchObject({
      latestRunByBlock: { [ref]: "RUN-001" },
      counts: { runs: 1 }
    });
    expect((await readState(init.workspace.stateFile)).blocks[ref]).toMatchObject({
      status: "completed",
      lastRunId: "RUN-001"
    });
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
      submissionAttemptId: (await readState(init.workspace.stateFile)).blocks["T-001#B-001"]
        .submissionAttemptId,
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
      reportPath: await writeReport(root, "retry.md"),
      runId: "RUN-001"
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
      submissionAttemptId: (await readState(init.workspace.stateFile)).blocks["T-001#B-001"]
        .submissionAttemptId,
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
      reportPath: await writeReport(root, "retry.md"),
      runId: "RUN-001"
    });

    expect(result).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    await expect(access(join(runRoot, "RUN-002"))).rejects.toThrow();
    await expect(
      readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).resolves.toMatchObject({
      latestRunByBlock: { "T-001#B-001": "RUN-001" }
    });
  });

  it("requires a persisted reservation to recover an ambiguous legacy run", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const legacyState = await readState(init.workspace.stateFile);
    const attemptId = legacyState.blocks["T-001#B-001"].submissionAttemptId;
    delete legacyState.blocks["T-001#B-001"].submissionAttemptId;
    await writeState(init.workspace.stateFile, legacyState);
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const runDir = join(runRoot, "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "report\n");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      reportHash: createHash("sha256").update("report\n").digest("hex")
    });
    const options = {
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "retry.md")
    };
    await expect(submitBlockResult(options)).rejects.toThrow("identity is ambiguous");
    expect(
      (await getExecutionStatus({ projectRoot: root })).blocks.find(
        (block) => block.ref === options.ref
      )
    ).toMatchObject({ status: "in_progress", lastRunId: null });
    await expect(access(join(runRoot, "RUN-002"))).rejects.toThrow();
    await expect(submitBlockResult({ ...options, runId: "RUN-001" })).rejects.toThrow(
      "identity is ambiguous"
    );
    legacyState.blocks[options.ref].submissionAttemptId = attemptId;
    legacyState.blocks[options.ref].submissionRunId = "RUN-001";
    await writeState(init.workspace.stateFile, legacyState);
    expect(await submitBlockResult({ ...options, runId: "RUN-001" })).toEqual({
      ref: options.ref,
      runId: "RUN-001",
      status: "completed"
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

  it("replays a legacy completed manual submission using its exact lastRunId evidence", async () => {
    const { root, init } = await createTestWorkspace();
    const ref = "T-001#B-001";
    await claimNext({ projectRoot: root });
    const options = { projectRoot: root, ref, reportPath: await writeReport(root, "legacy.md") };
    const first = await submitBlockResult(options);
    const state = await readState(init.workspace.stateFile);
    delete state.blocks[ref].submissionAttemptId;
    delete state.blocks[ref].submissionRunId;
    await writeState(init.workspace.stateFile, state);
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const metadataPath = join(runRoot, first.runId, "metadata.json");
    const metadata = await readJsonFile<Record<string, unknown>>(metadataPath);
    delete metadata.submissionAttemptId;
    delete metadata.submissionReportHash;
    await writeJsonFile(metadataPath, metadata);
    const original = await readFile(metadataPath, "utf8");
    expect(await submitBlockResult(options)).toEqual(first);
    expect(await readFile(metadataPath, "utf8")).toBe(original);
    expect((await readdir(runRoot)).filter((name) => /^RUN-\d+$/.test(name))).toEqual(["RUN-001"]);
    expect((await readState(init.workspace.stateFile)).blocks[ref]).toMatchObject({
      status: "completed",
      lastRunId: "RUN-001"
    });
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
      submissionAttemptId: (await readState(init.workspace.stateFile)).blocks["T-001#B-001"]
        .submissionAttemptId,
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
      submissionAttemptId: (await readState(init.workspace.stateFile)).blocks["T-001#B-001"]
        .submissionAttemptId,
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
      submissionAttemptId: (await readState(init.workspace.stateFile)).blocks["T-001#B-001"]
        .submissionAttemptId,
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
