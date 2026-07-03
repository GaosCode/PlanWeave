import type { PathLike } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsFailures = vi.hoisted(() => ({
  access: new Map<string, NodeJS.ErrnoException[]>(),
  open: new Map<string, NodeJS.ErrnoException[]>(),
  readdir: new Map<string, NodeJS.ErrnoException[]>(),
  readFile: new Map<string, NodeJS.ErrnoException[]>(),
  stat: new Map<string, NodeJS.ErrnoException[]>()
}));

function pathKey(path: PathLike): string {
  return path.toString();
}

function shiftFailure(map: Map<string, NodeJS.ErrnoException[]>, path: PathLike): NodeJS.ErrnoException | null {
  const failures = map.get(pathKey(path));
  if (!failures || failures.length === 0) {
    return null;
  }
  const failure = failures.shift() ?? null;
  if (failures.length === 0) {
    map.delete(pathKey(path));
  }
  return failure;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (path: PathLike, ...args: unknown[]) => {
      const failure = shiftFailure(fsFailures.access, path);
      if (failure) {
        throw failure;
      }
      return actual.access(path, ...(args as Parameters<typeof actual.access> extends [PathLike, ...infer Rest] ? Rest : never));
    },
    open: async (path: PathLike, ...args: unknown[]) => {
      const failure = shiftFailure(fsFailures.open, path);
      if (failure) {
        throw failure;
      }
      return actual.open(path, ...(args as Parameters<typeof actual.open> extends [PathLike, ...infer Rest] ? Rest : never));
    },
    readdir: async (path: PathLike, ...args: unknown[]) => {
      const failure = shiftFailure(fsFailures.readdir, path);
      if (failure) {
        throw failure;
      }
      return actual.readdir(path, ...(args as Parameters<typeof actual.readdir> extends [PathLike, ...infer Rest] ? Rest : never));
    },
    readFile: async (path: PathLike, ...args: unknown[]) => {
      const failure = shiftFailure(fsFailures.readFile, path);
      if (failure) {
        throw failure;
      }
      return actual.readFile(path, ...(args as Parameters<typeof actual.readFile> extends [PathLike, ...infer Rest] ? Rest : never));
    },
    stat: async (path: PathLike, ...args: unknown[]) => {
      const failure = shiftFailure(fsFailures.stat, path);
      if (failure) {
        throw failure;
      }
      return actual.stat(path, ...(args as Parameters<typeof actual.stat> extends [PathLike, ...infer Rest] ? Rest : never));
    }
  };
});

import { getRunRecord, listBlockRunRecords } from "../desktop/index.js";
import { getReviewPipeline } from "../desktop/reviewPipelineApi.js";
import { nextPersistedAutoRunId, readPersistedAutoRunEventLog, readPersistedAutoRunState } from "../desktop/runStateRepository.js";
import { initWorkspace } from "../initWorkspace.js";
import { readProjectPrompt, readProjectPromptPolicy } from "../projectPromptPolicy.js";
import { canonicalProjectCanvasNode, projectCanvasWorkspace, projectGraphPath } from "../projectGraph/index.js";
import { writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { nextRunId } from "../autoRun/executorShared.js";
import { readNewTmuxText, tmuxPathExists } from "../autoRun/tmuxExecutor.js";
import { createRunSession } from "../runSessions/index.js";
import { validateCanvasPackageForDoctor } from "../taskManager/projectDoctorCanvas.js";
import { getAutoRunStatus } from "../taskManager/autoRun.js";
import { renderPrompt, runDoctor, submitBlockResult, submitFeedback, submitReviewResult, claimNext } from "../taskManager/index.js";
import { createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

function nodeFileError(code: string, path?: string): NodeJS.ErrnoException {
  const error = new Error(`${code} failure${path ? `: ${path}` : ""}`) as NodeJS.ErrnoException;
  error.code = code;
  if (path) {
    error.path = path;
  }
  return error;
}

function failOnce(kind: keyof typeof fsFailures, path: string, code: string): NodeJS.ErrnoException {
  const failure = nodeFileError(code, path);
  fsFailures[kind].set(path, [...(fsFailures[kind].get(path) ?? []), failure]);
  return failure;
}

function failSequence(kind: keyof typeof fsFailures, path: string, codes: string[]): NodeJS.ErrnoException[] {
  const failures = codes.map((code) => nodeFileError(code, path));
  fsFailures[kind].set(path, [...(fsFailures[kind].get(path) ?? []), ...failures]);
  return failures;
}

async function completeImplementation(root: string): Promise<void> {
  await claimNext({ projectRoot: root });
  await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "implementation.md") });
  await claimNext({ projectRoot: root });
}

beforeEach(() => {
  for (const failures of Object.values(fsFailures)) {
    failures.clear();
  }
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("filesystem I/O failure visibility", () => {
  it("does not treat an unreadable task result index as an empty index during submit-result", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const indexPath = join(init.workspace.resultsDir, "T-001", "index.json");
    const expected = failOnce("stat", indexPath, "EACCES");
    failOnce("access", indexPath, "EACCES");

    await expect(submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "blocked.md") })).rejects.toBe(expected);
  });

  it("does not allocate a review attempt id when the attempts directory read fails after missing-path probing", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const attemptRoot = join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts");
    const [, expected] = failSequence("readdir", attemptRoot, ["ENOENT", "EIO"]);

    await expect(
      submitReviewResult({
        projectRoot: root,
        ref: "T-001#R-001",
        resultPath: await writeReviewResult(root, "passed", "Looks good.")
      })
    ).rejects.toBe(expected);
  });

  it("does not allocate a feedback submission id when the submissions directory read fails after missing-path probing", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix the edge case.")
    });
    await claimNext({ projectRoot: root });
    const submissionRoot = join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "submissions");
    const [, expected] = failSequence("readdir", submissionRoot, ["ENOENT", "EIO"]);

    await expect(submitFeedback({ projectRoot: root, reportPath: await writeReport(root, "feedback.md", "Fixed.\n") })).rejects.toBe(expected);
  });

  it("does not initialize over an inaccessible existing project metadata file", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    process.env.PLANWEAVE_HOME = home;
    const initialized = await initWorkspace({ projectRoot: root });
    const expected = failOnce("stat", initialized.workspace.projectFile, "EACCES");
    failOnce("access", initialized.workspace.projectFile, "EACCES");

    await expect(initWorkspace({ projectRoot: root })).rejects.toBe(expected);
  });

  it("does not skip package backup when a reset source cannot be inspected", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    process.env.PLANWEAVE_HOME = home;
    const initialized = await initWorkspace({ projectRoot: root });
    const expected = failOnce("stat", initialized.workspace.packageDir, "EIO");
    failOnce("access", initialized.workspace.packageDir, "EIO");

    await expect(initWorkspace({ projectRoot: root, resetPackage: true })).rejects.toBe(expected);
  });

  it("does not show an inaccessible run record directory as an empty run list", async () => {
    const { root, init } = await createTestWorkspace();
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const expected = failOnce("readdir", runRoot, "EACCES");

    await expect(listBlockRunRecords(root, "T-001#B-001")).rejects.toBe(expected);
  });

  it("does not hide unreadable run record output as empty output", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "run.md", "done\n") });
    const stdoutPath = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "stdout.md");
    const expected = failOnce("readFile", stdoutPath, "EIO");
    failOnce("access", stdoutPath, "EIO");

    await expect(getRunRecord(root, "T-001#B-001::RUN-001")).rejects.toBe(expected);
  });

  it("reports canvas workspace stat failures as workspace_read_failed instead of workspace_missing", async () => {
    const { root, init } = await createTestWorkspace();
    const canvasWorkspace = projectCanvasWorkspace(init.workspace, canonicalProjectCanvasNode({ id: "default", title: "Default" }));
    failOnce("access", canvasWorkspace.workspaceRoot, "EACCES");
    const expected = failOnce("stat", canvasWorkspace.workspaceRoot, "EACCES");

    const report = await validateCanvasPackageForDoctor({ canvasId: "default", workspace: canvasWorkspace });

    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "workspace_read_failed",
          message: expected.message,
          canvasId: "default",
          source: "canvas_package",
          path: "."
        })
      ])
    );
    expect(report.errors.map((error) => error.code)).not.toContain("workspace_missing");
  });

  it("does not show an inaccessible Auto Run run directory as no latest run", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "auto-run.md", "done\n") });
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const expected = failOnce("readdir", runRoot, "EACCES");

    await expect(getAutoRunStatus({ projectRoot: root })).rejects.toBe(expected);
  });

  it("does not hide unreadable Auto Run output as an empty output summary", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "auto-run-output.md", "done\n") });
    const stdoutPath = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "stdout.md");
    await writeFile(stdoutPath, "streamed output\n", "utf8");
    const expected = failOnce("readFile", stdoutPath, "EIO");
    failOnce("access", stdoutPath, "EIO");

    await expect(getAutoRunStatus({ projectRoot: root })).rejects.toBe(expected);
  });

  it("does not let doctor repair classify unreadable run metadata as a missing run", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "doctor.md", "done\n") });
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "planned", lastRunId: null }
      },
      feedback: {}
    });
    const metadataPath = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json");
    const expected = failOnce("stat", metadataPath, "EACCES");
    failOnce("access", metadataPath, "EACCES");

    await expect(runDoctor({ projectRoot: root, repair: true })).rejects.toBe(expected);
  });

  it("does not render unreadable latest implementation reports as unavailable prompt text", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const reportPath = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "report.md");
    const expected = failOnce("readFile", reportPath, "EIO");

    await expect(renderPrompt({ projectRoot: root, ref: "T-001#R-001" })).rejects.toBe(expected);
  });

  it("keeps missing latest implementation reports as unavailable prompt text", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const reportPath = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "report.md");
    failOnce("readFile", reportPath, "ENOENT");

    await expect(renderPrompt({ projectRoot: root, ref: "T-001#R-001" })).resolves.toContain("T-001#B-001 RUN-001: (unavailable)");
  });

  it("treats ENOTDIR prompt source reads as missing when missing prompts are allowed", async () => {
    const { root } = await createTestWorkspace();
    const globalPromptPath = join(resolvePlanweaveHome(), "config", "global-prompt.md");
    failOnce("readFile", globalPromptPath, "ENOTDIR");

    await expect(renderPrompt({ projectRoot: root, ref: "T-001#B-001", allowMissingPromptSources: true })).resolves.not.toContain("ENOTDIR failure");
  });

  it("treats ENOTDIR project prompt policy and project prompt reads as missing", async () => {
    const { root, init } = await createTestWorkspace();
    const policyPath = join(init.workspace.workspaceRoot, "policy", "prompt-policy.json");
    failOnce("readFile", policyPath, "ENOTDIR");
    await expect(readProjectPromptPolicy(root)).resolves.toEqual({ includeGlobalPrompt: true });

    failOnce("readFile", init.workspace.projectPromptFile, "ENOTDIR");
    await expect(readProjectPrompt(root)).resolves.toBe("");
  });

  it("does not create run sessions from an inaccessible run-sessions directory snapshot", async () => {
    const { root, init } = await createTestWorkspace();
    await createRunSession({ projectRoot: root, kind: "run" });
    const sessionsRoot = join(init.workspace.resultsDir, "run-sessions");
    const expected = failOnce("readdir", sessionsRoot, "EACCES");

    await expect(createRunSession({ projectRoot: root, kind: "run" })).rejects.toBe(expected);
  });

  it("does not allocate RUN-001 when executor run directory listing fails", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "planweave-run-root-"));
    const expected = failOnce("readdir", runRoot, "EIO");

    await expect(nextRunId(runRoot)).rejects.toBe(expected);
  });

  it("does not show unreadable review pipeline prompts as empty prompt text", async () => {
    const { root, init } = await createTestWorkspace();
    const reviewPromptPath = join(init.workspace.packageDir, "nodes", "T-001", "blocks", "R-001.prompt.md");
    const expected = failOnce("readFile", reviewPromptPath, "EIO");

    await expect(getReviewPipeline(root, "T-001")).rejects.toBe(expected);
  });

  it("does not treat unreadable persisted Auto Run state as no state", async () => {
    const { init } = await createTestWorkspace();
    const statePath = join(init.workspace.resultsDir, "auto-runs", "DESKTOP-RUN-0001", "state.json");
    const expected = failOnce("readFile", statePath, "EIO");

    await expect(readPersistedAutoRunState(init.workspace, "DESKTOP-RUN-0001")).rejects.toBe(expected);
  });

  it("does not allocate an Auto Run id when a registered project graph cannot be inspected", async () => {
    const { init } = await createTestWorkspace();
    const expected = failOnce("stat", projectGraphPath(init.workspace), "EACCES");

    await expect(nextPersistedAutoRunId(init.workspace)).rejects.toBe(expected);
  });

  it("treats ENOTDIR Auto Run roots as missing while allocating a desktop run id", async () => {
    const { init } = await createTestWorkspace();
    failOnce("readdir", join(init.workspace.resultsDir, "auto-runs"), "ENOTDIR");
    failOnce("readdir", join(init.workspace.planweaveHome, "projects"), "ENOTDIR");

    await expect(nextPersistedAutoRunId(init.workspace)).resolves.toBe("DESKTOP-RUN-0001");
  });

  it("treats ENOTDIR Auto Run event logs as missing diagnostics", async () => {
    const { init } = await createTestWorkspace();
    const eventLogPath = join(init.workspace.resultsDir, "auto-runs", "DESKTOP-RUN-0001", "events.ndjson");
    failOnce("readFile", eventLogPath, "ENOTDIR");

    await expect(readPersistedAutoRunEventLog(init.workspace, "DESKTOP-RUN-0001")).resolves.toMatchObject({
      runId: "DESKTOP-RUN-0001",
      events: [],
      diagnostics: [
        expect.objectContaining({
          code: "auto_run_event_log_missing",
          path: eventLogPath
        })
      ]
    });
  });

  it("does not treat tmux done file stat failures as a missing done file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-io-"));
    const donePath = join(dir, "done.json");
    const expected = failOnce("stat", donePath, "EACCES");

    await expect(tmuxPathExists(donePath)).rejects.toBe(expected);
  });

  it("keeps missing tmux output empty but surfaces output stat failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-output-"));
    const outputPath = join(dir, "stdout.md");
    failOnce("stat", outputPath, "ENOENT");
    await expect(readNewTmuxText(outputPath, 0)).resolves.toEqual({ text: "", offset: 0, limitExceeded: false });

    const expected = failOnce("stat", outputPath, "EIO");
    await expect(readNewTmuxText(outputPath, 0)).rejects.toBe(expected);
  });

  it("keeps tmux output deletion races empty but surfaces output open failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-tmux-output-race-"));
    const outputPath = join(dir, "stdout.md");
    await writeFile(outputPath, "partial output\n", "utf8");
    failOnce("open", outputPath, "ENOTDIR");
    await expect(readNewTmuxText(outputPath, 0)).resolves.toEqual({ text: "", offset: 0, limitExceeded: false });

    const expected = failOnce("open", outputPath, "EACCES");
    await expect(readNewTmuxText(outputPath, 0)).rejects.toBe(expected);
  });
});
