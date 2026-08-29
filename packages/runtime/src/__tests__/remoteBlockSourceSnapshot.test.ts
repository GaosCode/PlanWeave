import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectGraphPath } from "../projectGraph/index.js";
import { updateProjectPrompt, updateProjectPromptPolicy } from "../projectPromptPolicy.js";
import { readState, writeState } from "../state.js";
import {
  claimDispatchedBlock,
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  renderPromptSurface,
  submitBlockResult
} from "../taskManager/index.js";
import type { PlanPackageManifest } from "../types.js";
import { sameRemoteBlockAuthority } from "../taskManager/remoteBlockSource.js";
import { basicManifest, createTestWorkspace, writeReport } from "./promptTestHelpers.js";

function remoteManifest(
  options: { dependency?: boolean; parallel?: boolean; upstreamTask?: boolean } = {}
): PlanPackageManifest {
  const manifest = basicManifest({
    parallel: options.parallel,
    maxConcurrent: 1,
    includeSecondTask: options.upstreamTask
  });
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  };
  if (options.dependency) {
    const task = manifest.nodes[0];
    if (task.type !== "task") {
      throw new Error("Expected the test manifest to start with a task.");
    }
    task.blocks.splice(1, 0, {
      id: "B-002",
      type: "implementation",
      title: "Consume first implementation",
      prompt: "nodes/T-001/blocks/B-002.prompt.md",
      depends_on: ["B-001"]
    });
    const review = task.blocks.find((block) => block.id === "R-001");
    if (review) {
      review.depends_on = ["B-002"];
    }
  }
  if (options.upstreamTask) {
    manifest.edges = [{ from: "T-002", to: "T-001", type: "depends_on" }];
  }
  return manifest;
}

function activeIdentity(candidate: { sourceRevision: string; graphFingerprint: string }) {
  return {
    operationId: "operation-001",
    controlPlane: "collaboration" as const,
    sourceRevision: candidate.sourceRevision,
    graphFingerprint: candidate.graphFingerprint,
    dispatchId: "dispatch-001",
    executionAttemptId: "attempt-001"
  };
}

function reportInput(bytes: Buffer) {
  return {
    reportArtifactRef: `artifact:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    reportBytes: bytes
  };
}

function claimIdentity(identity: ReturnType<typeof activeIdentity>) {
  const { dispatchId: _dispatchId, executionAttemptId: _attemptId, ...claim } = identity;
  return claim;
}

describe("remote block source authority domains", () => {
  const graphFingerprint = `pkg-${"a".repeat(64)}`;

  it("uses Server snapshot source identity with graph fingerprint fencing", () => {
    expect(
      sameRemoteBlockAuthority(
        { sourceRevision: `src-${"b".repeat(64)}`, graphFingerprint },
        { sourceRevision: `snapshot:${"c".repeat(64)}`, graphFingerprint }
      )
    ).toBe(true);
    expect(
      sameRemoteBlockAuthority(
        { sourceRevision: `src-${"b".repeat(64)}`, graphFingerprint },
        {
          sourceRevision: `snapshot:${"c".repeat(64)}`,
          graphFingerprint: `pkg-${"d".repeat(64)}`
        }
      )
    ).toBe(false);
  });

  it("keeps legacy block-local source revisions exact", () => {
    expect(
      sameRemoteBlockAuthority(
        { sourceRevision: `src-${"b".repeat(64)}`, graphFingerprint },
        { sourceRevision: `src-${"c".repeat(64)}`, graphFingerprint }
      )
    ).toBe(false);
  });
});
describe("remote block runtime inspection", () => {
  it("reads only a currently declared verified dependency artifact", async () => {
    const { root } = await createTestWorkspace(remoteManifest({ dependency: true }));
    await claimDispatchedBlock({ projectRoot: root, ref: "T-001#B-001" });
    const report = Buffer.from("verified dependency artifact\n");
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "verified-dependency.md", report.toString("utf8"))
    });
    const candidate = await createRemoteBlockRuntimePort({ projectRoot: root }).inspect({
      ref: "T-001#B-002"
    });
    const artifact = candidate.inputArtifacts[0];
    if (!artifact?.mediaType) throw new Error("Expected a declared input artifact.");
    const source = createRemoteBlockArtifactSource({ projectRoot: root });

    await expect(
      source.read({
        targetBlockRef: candidate.blockRef,
        sourceRevision: candidate.sourceRevision,
        artifactRef: artifact.artifactRef,
        logicalName: artifact.logicalName,
        mediaType: "text/markdown"
      })
    ).resolves.toMatchObject({
      artifactRef: artifact.artifactRef,
      logicalName: artifact.logicalName,
      mediaType: "text/markdown",
      bytes: new Uint8Array(report)
    });
    await expect(
      source.read({
        targetBlockRef: candidate.blockRef,
        sourceRevision: "src-stale",
        artifactRef: artifact.artifactRef,
        logicalName: artifact.logicalName,
        mediaType: "text/markdown"
      })
    ).rejects.toThrow("remote_block_artifact_source_revision_mismatch");
    await expect(
      source.read({
        targetBlockRef: candidate.blockRef,
        sourceRevision: candidate.sourceRevision,
        artifactRef: artifact.artifactRef,
        logicalName: "dependency-other-report",
        mediaType: "text/markdown"
      })
    ).rejects.toThrow("remote_block_artifact_not_declared");
    await expect(
      source.read({
        targetBlockRef: candidate.blockRef,
        sourceRevision: candidate.sourceRevision,
        artifactRef: `artifact:sha256:${"0".repeat(64)}`,
        logicalName: artifact.logicalName,
        mediaType: "text/markdown"
      })
    ).rejects.toThrow("remote_block_artifact_not_declared");
  });

  it("returns portable ACP envelope inputs and content-addressed dependency evidence", async () => {
    const { root, init } = await createTestWorkspace(remoteManifest({ dependency: true }));
    await claimDispatchedBlock({ projectRoot: root, ref: "T-001#B-001" });
    const dependencyReport =
      "dependency completed at /tmp/private/token.db\n" +
      "retry https://internal.example:8443 and inspect table users_credentials\n" +
      "token=secret-value-123\n";
    const dependencyRun = await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "dependency.md", dependencyReport)
    });

    const port = createRemoteBlockRuntimePort({ projectRoot: root });
    const localSurface = await renderPromptSurface({
      projectRoot: root,
      ref: "T-001#B-002",
      includeSubmissionInstructions: false
    });
    expect(localSurface.markdown).toContain("/tmp/private/token.db");
    const candidate = await port.inspect({ ref: "T-001#B-002" });
    const expectedArtifactRef = `artifact:sha256:${createHash("sha256")
      .update(dependencyReport)
      .digest("hex")}`;

    expect(candidate).toMatchObject({
      canvasId: "default",
      taskId: "T-001",
      blockRef: "T-001#B-002",
      blockType: "implementation",
      effectiveExecutor: "codex-acp",
      agentId: "codex",
      agentProfileId: "codex-acp",
      session: {},
      acceptance: ["Implementation is complete.", "Review passes."],
      dependencySummaries: [
        {
          blockRef: "T-001#B-001",
          outcome: "completed",
          summary: "Implementation dependency 'T-001#B-001' completed.",
          reportArtifactRef: expectedArtifactRef
        }
      ],
      inputArtifacts: [
        {
          artifactRef: expectedArtifactRef,
          logicalName: "dependency-T-001-B-001-report",
          mediaType: "text/markdown"
        }
      ]
    });
    expect(candidate.renderedPrompt).toContain("T-001#B-002");
    const serializedCandidate = JSON.stringify(candidate);
    expect(serializedCandidate).not.toContain(root);
    expect(serializedCandidate).not.toContain("packageDir");
    expect(serializedCandidate).not.toContain("/tmp/private/token.db");
    expect(serializedCandidate).not.toContain("internal.example");
    expect(serializedCandidate).not.toContain("users_credentials");
    expect(serializedCandidate).not.toContain("secret-value-123");

    await writeFile(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        dependencyRun.runId,
        "report.md"
      ),
      "tampered dependency\n",
      "utf8"
    );
    const corrupted = port.inspect({ ref: "T-001#B-002" });
    await expect(corrupted).rejects.toMatchObject({ code: "remote_block_not_dispatchable" });
    await expect(corrupted).rejects.not.toThrow(root);
  });

  it("binds task dependency terminal generations and verified artifacts into remote dispatches", async () => {
    const { root, init } = await createTestWorkspace(remoteManifest({ upstreamTask: true }));
    await claimDispatchedBlock({ projectRoot: root, ref: "T-001#B-001" });
    const upstreamReport =
      "upstream result at /tmp/private/upstream.db\n" +
      "token=upstream-secret via https://internal.example:8443\n";
    const upstreamRun = await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "upstream.md", upstreamReport)
    });
    const initialState = await readState(init.workspace.stateFile);
    initialState.blocks["T-001#R-001"] = {
      ...initialState.blocks["T-001#R-001"],
      status: "completed",
      latestReviewAttemptId: "REV-001",
      completionReason: "passed",
      passedWorkRevision: "work-001"
    };
    await writeState(init.workspace.stateFile, initialState);

    const port = createRemoteBlockRuntimePort({ projectRoot: root });
    const candidate = await port.inspect({ ref: "T-002#B-001" });
    const expectedArtifactRef = `artifact:sha256:${createHash("sha256")
      .update(upstreamReport)
      .digest("hex")}`;
    expect(candidate.dependencySummaries).toEqual([
      {
        blockRef: "T-001#B-001",
        outcome: "completed",
        summary: "Implementation dependency 'T-001#B-001' completed.",
        reportArtifactRef: expectedArtifactRef
      },
      {
        blockRef: "T-001#R-001",
        outcome: "passed",
        summary: "Review dependency 'T-001#R-001' passed."
      }
    ]);
    expect(candidate.inputArtifacts).toEqual([
      {
        artifactRef: expectedArtifactRef,
        logicalName: "dependency-T-001-B-001-report",
        mediaType: "text/markdown"
      }
    ]);
    expect(JSON.stringify(candidate)).not.toContain("/tmp/private/upstream.db");
    expect(JSON.stringify(candidate)).not.toContain("internal.example");
    expect(JSON.stringify(candidate)).not.toContain("upstream-secret");

    const identity = activeIdentity(candidate);
    await port.claim({ ref: "T-002#B-001", ...claimIdentity(identity) });
    await port.activate({ ref: "T-002#B-001", ...identity });

    const replacementState = await readState(init.workspace.stateFile);
    replacementState.blocks["T-001#B-001"] = {
      ...replacementState.blocks["T-001#B-001"],
      status: "in_progress"
    };
    replacementState.currentRefs = [...new Set([...replacementState.currentRefs, "T-001#B-001"])];
    await writeState(init.workspace.stateFile, replacementState);
    const replacementRun = await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "upstream-replacement.md", "replacement result\n")
    });
    const replacementReviewState = await readState(init.workspace.stateFile);
    replacementReviewState.blocks["T-001#R-001"] = {
      ...replacementReviewState.blocks["T-001#R-001"],
      status: "completed",
      latestReviewAttemptId: "REV-002",
      completionReason: "passed",
      passedWorkRevision: "work-002"
    };
    await writeState(init.workspace.stateFile, replacementReviewState);
    expect(replacementRun.runId).not.toBe(upstreamRun.runId);

    await expect(
      port.reconcile({ ref: "T-002#B-001", operationId: identity.operationId })
    ).resolves.toMatchObject({ status: "diverged", ownership: identity });
    await expect(
      port.complete({
        ref: "T-002#B-001",
        ...identity,
        ...reportInput(Buffer.from("stale downstream result\n"))
      })
    ).rejects.toThrow("must be in_progress before submit-result");
    await expect(
      stat(join(init.workspace.resultsDir, "T-002", "blocks", "B-001", "runs"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an inspected claim when same-run dependency bytes are tampered", async () => {
    const { root, init } = await createTestWorkspace(remoteManifest({ dependency: true }));
    await claimDispatchedBlock({ projectRoot: root, ref: "T-001#B-001" });
    const dependencyRun = await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "dependency.md", "original dependency\n")
    });
    const port = createRemoteBlockRuntimePort({ projectRoot: root });
    const candidate = await port.inspect({ ref: "T-001#B-002" });
    await writeFile(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        dependencyRun.runId,
        "report.md"
      ),
      "tampered in place\n",
      "utf8"
    );

    await expect(
      port.claim({ ref: "T-001#B-002", ...claimIdentity(activeIdentity(candidate)) })
    ).rejects.toMatchObject({ code: "remote_block_source_changed" });
    expect((await readState(init.workspace.stateFile)).blocks["T-001#B-002"]).not.toHaveProperty(
      "remoteOwnership"
    );
  });

  it("diverges active ownership after same-run dependency bytes are tampered", async () => {
    const { root, init } = await createTestWorkspace(remoteManifest({ dependency: true }));
    await claimDispatchedBlock({ projectRoot: root, ref: "T-001#B-001" });
    const dependencyRun = await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "dependency.md", "original dependency\n")
    });
    const port = createRemoteBlockRuntimePort({ projectRoot: root });
    const candidate = await port.inspect({ ref: "T-001#B-002" });
    const identity = activeIdentity(candidate);
    await port.claim({ ref: "T-001#B-002", ...claimIdentity(identity) });
    await port.activate({ ref: "T-001#B-002", ...identity });
    await writeFile(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        dependencyRun.runId,
        "report.md"
      ),
      "tampered in place\n",
      "utf8"
    );

    await expect(
      port.reconcile({ ref: "T-001#B-002", operationId: identity.operationId })
    ).resolves.toMatchObject({ status: "diverged", ownership: identity });
    await expect(
      port.complete({
        ref: "T-001#B-002",
        ...identity,
        ...reportInput(Buffer.from("stale result\n"))
      })
    ).rejects.toThrow("must be in_progress before submit-result");
    await expect(
      stat(join(init.workspace.resultsDir, "T-001", "blocks", "B-002", "runs"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "project_prompt",
    "global_policy",
    "project_canvas_context"
  ] as const)("rejects an inspected claim after stable remote prompt source %s changes", async (source) => {
    const { root, init } = await createTestWorkspace(remoteManifest());
    const port = createRemoteBlockRuntimePort({ projectRoot: root });
    const candidate = await port.inspect({ ref: "T-001#B-001" });
    if (source === "project_prompt") {
      await updateProjectPrompt(root, "# Changed remote project policy\n");
    } else if (source === "global_policy") {
      await updateProjectPromptPolicy(root, { includeGlobalPrompt: false });
    } else {
      const graphPath = projectGraphPath(init.workspace);
      const graph = JSON.parse(await readFile(graphPath, "utf8")) as {
        canvases: Array<{ title: string }>;
      };
      graph.canvases[0]!.title = "Changed remote canvas";
      await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    }

    await expect(
      port.claim({ ref: "T-001#B-001", ...claimIdentity(activeIdentity(candidate)) })
    ).rejects.toMatchObject({ code: "remote_block_source_changed" });
    expect((await readState(init.workspace.stateFile)).blocks["T-001#B-001"]).not.toHaveProperty(
      "remoteOwnership"
    );
    const refreshed = await port.inspect({ ref: "T-001#B-001" });
    if (source === "project_prompt") {
      expect(refreshed.renderedPrompt).toContain("Changed remote project policy");
    }
    if (source === "project_canvas_context") {
      expect(refreshed.renderedPrompt).toContain("Changed remote canvas");
    }
  });

  it("rejects review before implementation completes and rejects locally in-progress blocks", async () => {
    const reviewWorkspace = await createTestWorkspace(remoteManifest());
    const reviewPort = createRemoteBlockRuntimePort({ projectRoot: reviewWorkspace.root });
    await expect(reviewPort.inspect({ ref: "T-001#R-001" })).rejects.toMatchObject({
      code: "remote_block_not_dispatchable"
    });

    const localWorkspace = await createTestWorkspace(remoteManifest());
    const localPort = createRemoteBlockRuntimePort({ projectRoot: localWorkspace.root });
    const candidate = await localPort.inspect({ ref: "T-001#B-001" });
    await claimDispatchedBlock({
      projectRoot: localWorkspace.root,
      ref: "T-001#B-001"
    });
    await expect(localPort.inspect({ ref: "T-001#B-001" })).rejects.toMatchObject({
      code: "remote_block_not_dispatchable"
    });
    await expect(
      localPort.claim({
        ref: "T-001#B-001",
        ...claimIdentity(activeIdentity(candidate))
      })
    ).rejects.toMatchObject({ code: "remote_ownership_requires_ready_block" });

    const nonAcpWorkspace = await createTestWorkspace(basicManifest());
    const nonAcpPort = createRemoteBlockRuntimePort({ projectRoot: nonAcpWorkspace.root });
    await expect(nonAcpPort.inspect({ ref: "T-001#B-001" })).rejects.toMatchObject({
      code: "remote_block_executor_not_acp"
    });
  });

  it("keeps optional completed review dependencies dispatchable for local and remote paths", async () => {
    const manifest = remoteManifest();
    const task = manifest.nodes[0];
    if (task.type !== "task") {
      throw new Error("Expected task manifest node.");
    }
    const review = task.blocks.find((block) => block.id === "R-001");
    if (!review || review.type !== "review") {
      throw new Error("Expected review block.");
    }
    review.review.required = false;
    task.blocks.push({
      id: "B-002",
      type: "implementation",
      title: "Continue after optional review",
      prompt: "nodes/T-001/blocks/B-002.prompt.md",
      depends_on: ["R-001"]
    });

    async function completeOptionalReview(root: string, stateFile: string) {
      await claimDispatchedBlock({ projectRoot: root, ref: "T-001#B-001" });
      await submitBlockResult({
        projectRoot: root,
        ref: "T-001#B-001",
        reportPath: await writeReport(root, "implementation.md", "implementation\n")
      });
      const state = await readState(stateFile);
      state.blocks["T-001#R-001"] = {
        ...state.blocks["T-001#R-001"],
        status: "completed",
        latestReviewAttemptId: "REV-001",
        completionReason: "max_cycles_reached",
        passedWorkRevision: null
      };
      await writeState(stateFile, state);
    }

    const remoteWorkspace = await createTestWorkspace(manifest);
    await completeOptionalReview(remoteWorkspace.root, remoteWorkspace.init.workspace.stateFile);
    const candidate = await createRemoteBlockRuntimePort({
      projectRoot: remoteWorkspace.root
    }).inspect({ ref: "T-001#B-002" });
    expect(candidate.dependencySummaries).toContainEqual({
      blockRef: "T-001#R-001",
      outcome: "completed",
      summary: "Review dependency 'T-001#R-001' completed."
    });

    const localWorkspace = await createTestWorkspace(manifest);
    await completeOptionalReview(localWorkspace.root, localWorkspace.init.workspace.stateFile);
    await expect(
      claimDispatchedBlock({ projectRoot: localWorkspace.root, ref: "T-001#B-002" })
    ).resolves.toMatchObject({ kind: "block", ref: "T-001#B-002" });
  });
});
