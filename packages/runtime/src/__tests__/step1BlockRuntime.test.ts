import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNext,
  createExecutionGraphSession,
  drainGraphReadQueue,
  getExecutionStatus,
  initWorkspace,
  renderPrompt,
  runAutoRunStep,
  submitFeedback,
  submitBlockResult,
  submitReviewResult,
  validatePackage
} from "../index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { AutoRunStepResult, PlanPackageManifest } from "../types.js";

async function createWorkspaceFromExample(): Promise<{ home: string; root: string; packageDir: string; resultsDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
  const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
  process.env.PLANWEAVE_HOME = home;
  const init = await initWorkspace({ projectRoot: root });
  await cp(join(process.cwd(), "examples/basic-plan-package/package"), init.workspace.packageDir, {
    recursive: true,
    force: true
  });
  await writeFile(join(home, "config", "global-prompt.md"), "Global execution rules.\n", "utf8");
  await writeFile(init.workspace.projectPromptFile, "Project execution rules.\n", "utf8");
  return { home, root, packageDir: init.workspace.packageDir, resultsDir: init.workspace.resultsDir };
}

async function writeReview(path: string, verdict: "passed" | "needs_changes", content: string): Promise<void> {
  await writeJsonFile(path, {
    reviewBlockRef: "T-001#R-001",
    taskId: "T-001",
    verdict,
    content
  });
}

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("STEP-1 block runtime", () => {
  it("runs implementation, review feedback, focused re-review, and completion", async () => {
    const { home, root, resultsDir } = await createWorkspaceFromExample();

    expect((await validatePackage({ projectRoot: root })).ok).toBe(true);
    expect(await claimNext({ projectRoot: root })).toMatchObject({
      kind: "block",
      ref: "T-001#B-001",
      blockType: "implementation"
    });
    const implementationPrompt = await renderPrompt({ projectRoot: root, ref: "T-001#B-001" });
    expect(implementationPrompt).toContain("Global execution rules.");
    expect(implementationPrompt).toContain("Project execution rules.");
    expect(implementationPrompt).toContain("Create a small implementation report");

    const implementationReport = join(home, "implementation-1.md");
    await writeFile(implementationReport, "First implementation.\n", "utf8");
    expect(await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: implementationReport })).toMatchObject({
      ref: "T-001#B-001",
      runId: "RUN-001",
      status: "completed"
    });

    expect(await claimNext({ projectRoot: root })).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      blockType: "review"
    });
    const reviewPrompt = await renderPrompt({ projectRoot: root, ref: "T-001#R-001" });
    expect(reviewPrompt).toContain("Required Review Result JSON");
    expect(reviewPrompt).toContain("First implementation.");

    const firstReview = join(home, "review-1.json");
    await writeReview(firstReview, "needs_changes", "Needs a test adjustment.");
    expect(await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath: firstReview })).toMatchObject({
      ref: "T-001#R-001",
      reviewAttemptId: "REV-001",
      verdict: "needs_changes",
      feedbackId: "FE-001",
      status: "in_progress"
    });

    expect(await claimNext({ projectRoot: root })).toEqual({
      kind: "feedback",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      content: "Needs a test adjustment.",
      effectiveExecutor: "manual"
    });
    const feedbackReport = join(home, "feedback-1.md");
    await writeFile(feedbackReport, "Handled requested test adjustment.\n", "utf8");
    expect(await submitFeedback({ projectRoot: root, reportPath: feedbackReport })).toMatchObject({
      status: "accepted",
      nextCommand: "planweave claim-next",
      feedbackId: "FE-001",
      submissionId: "FS-001"
    });

    expect(await claimNext({ projectRoot: root })).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      reason: "feedback_resolved"
    });
    const focusedPrompt = await renderPrompt({ projectRoot: root, ref: "T-001#R-001" });
    expect(focusedPrompt).toContain("Focused Re-review Context");
    expect(focusedPrompt).toContain("Handled requested test adjustment.");

    const secondReview = join(home, "review-2.json");
    await writeReview(secondReview, "passed", "Passed.");
    expect(await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath: secondReview })).toMatchObject({
      ref: "T-001#R-001",
      reviewAttemptId: "REV-002",
      verdict: "passed",
      status: "completed"
    });

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.counts.tasks.implemented).toBe(1);
    expect(status.counts.blocks.completed).toBe(2);
    expect(status.counts.feedback.resolved).toBe(1);
    expect(
      await readFile(join(resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-001", "review-result.json"), "utf8")
    ).toContain("needs_changes");
    expect(
      await readFile(join(resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-002", "review-result.json"), "utf8")
    ).toContain("passed");
  });

  it("stops strict completion at max feedback cycles", async () => {
    const { home, root } = await createWorkspaceFromExample();
    await claimNext({ projectRoot: root });
    const implementationReport = join(home, "implementation-1.md");
    await writeFile(implementationReport, "First implementation.\n", "utf8");
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: implementationReport });
    await claimNext({ projectRoot: root });
    const firstReview = join(home, "review-1.json");
    await writeReview(firstReview, "needs_changes", "Needs changes.");
    await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath: firstReview });
    await claimNext({ projectRoot: root });
    const feedbackReport = join(home, "feedback-1.md");
    await writeFile(feedbackReport, "Handled feedback.\n", "utf8");
    await submitFeedback({ projectRoot: root, reportPath: feedbackReport });
    await claimNext({ projectRoot: root });

    const secondReview = join(home, "review-2.json");
    await writeReview(secondReview, "needs_changes", "Still not enough.");
    expect(await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath: secondReview })).toMatchObject({
      verdict: "needs_changes",
      feedbackId: "FE-002",
      status: "in_progress"
    });
    await claimNext({ projectRoot: root });
    const secondFeedbackReport = join(home, "feedback-2.md");
    await writeFile(secondFeedbackReport, "Handled second feedback.\n", "utf8");
    await submitFeedback({ projectRoot: root, reportPath: secondFeedbackReport });
    await claimNext({ projectRoot: root });

    const thirdReview = join(home, "review-3.json");
    await writeReview(thirdReview, "needs_changes", "Still not enough.");
    expect(await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath: thirdReview })).toMatchObject({
      verdict: "needs_changes",
      status: "completed"
    });

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.counts.tasks.implemented).toBe(0);
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")?.status).toBe("completed");
  });

  it("uses a review hook when configured and blocks on hook failure", async () => {
    const { home, root, packageDir } = await createWorkspaceFromExample();
    const manifestPath = join(packageDir, "manifest.json");
    const manifest = await readJsonFile<PlanPackageManifest>(manifestPath);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    const review = task.blocks.find((block) => block.id === "R-001");
    if (review?.type !== "review") {
      throw new Error("Fixture review block missing.");
    }
    review.review.hook = {
      id: "rewrite-feedback",
      type: "executable",
      command: "node",
      args: ["-e", "process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({action:'use_feedback',feedbackPrompt:'Hooked feedback'})))"],
      executionPolicy: "trusted-local"
    };
    await writeJsonFile(manifestPath, manifest);

    await claimNext({ projectRoot: root });
    const implementationReport = join(home, "implementation-1.md");
    await writeFile(implementationReport, "First implementation.\n", "utf8");
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: implementationReport });
    await claimNext({ projectRoot: root });
    const firstReview = join(home, "review-1.json");
    await writeReview(firstReview, "needs_changes", "Original feedback.");
    await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath: firstReview });
    expect(await claimNext({ projectRoot: root })).toEqual({
      kind: "feedback",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      content: "Hooked feedback",
      effectiveExecutor: "manual"
    });

    const brokenHome = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const brokenRoot = await mkdtemp(join(tmpdir(), "planweave-project-"));
    process.env.PLANWEAVE_HOME = brokenHome;
    const init = await initWorkspace({ projectRoot: brokenRoot });
    await cp(join(process.cwd(), "examples/basic-plan-package/package"), init.workspace.packageDir, { recursive: true, force: true });
    const brokenManifestPath = join(init.workspace.packageDir, "manifest.json");
    const brokenManifest = await readJsonFile<PlanPackageManifest>(brokenManifestPath);
    const brokenTask = brokenManifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (brokenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    const brokenReview = brokenTask.blocks.find((block) => block.id === "R-001");
    if (brokenReview?.type !== "review") {
      throw new Error("Fixture review block missing.");
    }
    brokenReview.review.hook = {
      id: "broken-feedback",
      type: "executable",
      command: "node",
      args: ["-e", "console.log('not json')"],
      executionPolicy: "trusted-local"
    };
    await writeJsonFile(brokenManifestPath, brokenManifest);
    await claimNext({ projectRoot: brokenRoot });
    const brokenReport = join(brokenHome, "implementation-1.md");
    await writeFile(brokenReport, "First implementation.\n", "utf8");
    await submitBlockResult({ projectRoot: brokenRoot, ref: "T-001#B-001", reportPath: brokenReport });
    await claimNext({ projectRoot: brokenRoot });
    const brokenReviewResult = join(brokenHome, "review-1.json");
    await writeReview(brokenReviewResult, "needs_changes", "Original feedback.");
    expect(await submitReviewResult({ projectRoot: brokenRoot, ref: "T-001#R-001", resultPath: brokenReviewResult })).toMatchObject({
      status: "blocked"
    });
    expect(await claimNext({ projectRoot: brokenRoot })).toMatchObject({
      kind: "blocked",
      ref: "T-001#R-001"
    });
  });

  it("drains graph read queue and exposes the auto-run executor boundary", async () => {
    const { home, root, packageDir } = await createWorkspaceFromExample();
    let session = await createExecutionGraphSession(root);
    expect(session.graph.blocksByRef.has("T-001#B-001")).toBe(true);

    const blockPromptPath = join(packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md");
    await writeFile(blockPromptPath, "Updated block prompt.\n", "utf8");
    session.readQueue.fileChanges.push({ path: blockPromptPath, type: "changed" });
    const drained = await drainGraphReadQueue(session);
    expect(drained.refreshed).toBe(true);
    expect(drained.dirtyPromptRefs).toContain("T-001#B-001");

    const autoRunReport = join(home, "auto-run-report.md");
    await writeFile(autoRunReport, "Auto-run implementation report.\n", "utf8");
    const step = await runAutoRunStep({
      projectRoot: root,
      session,
      executor: {
        async runBlock({ claim, prompt }) {
          expect(claim.ref).toBe("T-001#B-001");
          expect(prompt).toContain("Updated block prompt.");
          expect(prompt).not.toContain("planweave submit-result");
          return { kind: "block", reportPath: autoRunReport };
        },
        async runFeedback() {
          throw new Error("feedback should not run in this step");
        }
      }
    });
    expect(step.kind).toBe("submitted");
    expect(step.claim).toMatchObject({ kind: "block", ref: "T-001#B-001" });
  });

  it("runs one auto-run step with a configured codex-exec profile and records executor artifacts", async () => {
    const { home, root, packageDir, resultsDir } = await createWorkspaceFromExample();
    const manifestPath = join(packageDir, "manifest.json");
    const manifest = await readJsonFile<PlanPackageManifest>(manifestPath);
    manifest.execution.defaultExecutor = "fake-codex";
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => process.stdout.write('Auto report for ' + input.split('\\n')[0] + '\\n'));"]
      }
    };
    await writeJsonFile(manifestPath, manifest);

    const step = await runAutoRunStep({ projectRoot: root });

    expect(step.kind).toBe("submitted");
    expect(step).toMatchObject({
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "block", executor: "fake-codex", adapter: "codex-exec" },
      submitResult: { runId: "RUN-001" }
    });
    const runDir = join(resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    expect(await readFile(join(runDir, "prompt.md"), "utf8")).toContain("# T-001#B-001");
    expect(await readFile(join(runDir, "stdout.md"), "utf8")).toContain("Auto report for # T-001#B-001");
    expect(await readFile(join(runDir, "stderr.log"), "utf8")).toBe("");
    expect(await readFile(join(runDir, "metadata.json"), "utf8")).toContain('"executor": "fake-codex"');
  });

  it("stops a manual auto-run step after writing a prompt artifact without submitting the block", async () => {
    const { home, root, packageDir, resultsDir } = await createWorkspaceFromExample();
    const manifestPath = join(packageDir, "manifest.json");
    const manifest = await readJsonFile<PlanPackageManifest>(manifestPath);
    manifest.execution.defaultExecutor = "manual";
    manifest.executors = {
      manual: {
        adapter: "manual"
      }
    };
    await writeJsonFile(manifestPath, manifest);

    const step = (await runAutoRunStep({ projectRoot: root })) as AutoRunStepResult;

    expect(step.kind).toBe("manual");
    expect(step).toMatchObject({
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "manual", executor: "manual", adapter: "manual" }
    });
    const status = await getExecutionStatus({ projectRoot: root });
    const promptPath = join(resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "prompt.md");
    expect(await readFile(promptPath, "utf8")).toContain("# T-001#B-001");
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("in_progress");
  });
});
