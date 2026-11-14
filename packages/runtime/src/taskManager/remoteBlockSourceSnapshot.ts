import { resolveResultsPath } from "./resultPaths.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  dependencyResultSummarySchema,
  type DependencyResultSummary,
  type DispatchInputArtifact
} from "@planweave-ai/agent-host-protocol/browser";
import { readVerifiedArtifactReference } from "../autoRun/artifactReferenceContract.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { sha256Hex, stableJson } from "../plangraph/hash.js";
import { loadPlanGraphPackage } from "../plangraph/packageRepository.js";
import { readImplementationRunMetadataFile } from "./implementationRunMetadata.js";
import { renderPromptSurface } from "./promptRenderer.js";
import { RemoteBlockRuntimeError } from "./remoteBlockRuntimeContracts.js";
import type { RuntimeContext } from "./runtimeContext.js";

type DependencyGeneration = {
  ref: string;
  type: "implementation" | "review";
  status: string | null;
  lastRunId: string | null;
  latestReviewAttemptId: string | null;
  completionReason: string | null;
  passedWorkRevision: string | null;
  expectedReportDigest: string | null;
  actualReportDigest: string | null;
  verification: "verified" | "invalid" | "not_applicable";
  requirement: "completed" | "passed";
  source: "direct_block" | "task_dependency";
};

export type RemoteDispatchAuthoritativeDependency = {
  ref: string;
  source: "direct_block" | "task_dependency";
  requirement: "completed" | "passed";
};

export type RemoteBlockSourceSnapshot = {
  sourceRevision: string;
  graphFingerprint: string;
  renderedPrompt: string;
  dependencySummaries: DependencyResultSummary[];
  inputArtifacts: DispatchInputArtifact[];
  dependencyGenerations: DependencyGeneration[];
};

export type MaterializedRemoteInputArtifact = Omit<DispatchInputArtifact, "mediaType"> & {
  mediaType: "text/markdown";
  bytes: Uint8Array;
};

export function remoteDispatchAuthoritativeDependencies(
  context: RuntimeContext,
  ref: string
): RemoteDispatchAuthoritativeDependency[] {
  const taskId = context.graph.blockTaskByRef.get(ref);
  if (!taskId) {
    return [];
  }
  const directRefs = new Set(context.graph.blockDependenciesByRef.get(ref) ?? []);
  const taskDependencyRefs = new Set<string>();
  const dependencyTasks = new Set(context.graph.taskDependenciesByTask.get(taskId) ?? []);
  for (const dependencyRef of context.graph.blockRefsInManifestOrder) {
    const dependencyTaskId = context.graph.blockTaskByRef.get(dependencyRef);
    const dependency = context.graph.blocksByRef.get(dependencyRef);
    if (
      dependencyTaskId &&
      dependencyTasks.has(dependencyTaskId) &&
      dependency &&
      (dependency.type === "implementation" ||
        (dependency.type === "review" && dependency.review.required))
    ) {
      taskDependencyRefs.add(dependencyRef);
    }
  }
  const dependencies: RemoteDispatchAuthoritativeDependency[] = [];
  for (const dependencyRef of context.graph.blockRefsInManifestOrder) {
    if (directRefs.has(dependencyRef)) {
      dependencies.push({
        ref: dependencyRef,
        source: "direct_block",
        requirement: "completed"
      });
      continue;
    }
    if (taskDependencyRefs.has(dependencyRef)) {
      const dependency = context.graph.blocksByRef.get(dependencyRef);
      dependencies.push({
        ref: dependencyRef,
        source: "task_dependency",
        requirement: dependency?.type === "review" ? "passed" : "completed"
      });
    }
  }
  return dependencies;
}

async function implementationGeneration(
  context: RuntimeContext,
  ref: string,
  descriptor: RemoteDispatchAuthoritativeDependency
): Promise<{ generation: DependencyGeneration; bytes: Buffer | null }> {
  const state = context.state.blocks[ref];
  const { taskId, blockId } = parseBlockRef(ref);
  const runId = state?.lastRunId ?? null;
  let expectedReportDigest: string | null = null;
  let actualReportDigest: string | null = null;
  let bytes: Buffer | null = null;
  let metadataMatches = false;
  if (runId) {
    const runDir = await resolveResultsPath(
      context.workspace.resultsDir,
      taskId,
      "blocks",
      blockId,
      "runs",
      runId
    );
    const [metadataPath, reportPath] = await Promise.all([
      resolveResultsPath(runDir, "metadata.json"),
      resolveResultsPath(runDir, "report.md")
    ]);
    try {
      const metadata = await readImplementationRunMetadataFile(metadataPath);
      expectedReportDigest = metadata.reportHash ?? null;
      try {
        bytes = metadata.artifactReference
          ? (
              await readVerifiedArtifactReference({
                rootDir: runDir,
                value: metadata.artifactReference
              })
            ).bytes
          : await readFile(reportPath);
        actualReportDigest = createHash("sha256").update(bytes).digest("hex");
        metadataMatches =
          metadata.ref === ref &&
          metadata.runId === runId &&
          metadata.reportHash === actualReportDigest;
      } catch {
        try {
          const unverifiedBytes = await readFile(reportPath);
          actualReportDigest = createHash("sha256").update(unverifiedBytes).digest("hex");
        } catch {
          actualReportDigest = null;
        }
      }
    } catch {
      try {
        const unverifiedBytes = await readFile(reportPath);
        actualReportDigest = createHash("sha256").update(unverifiedBytes).digest("hex");
      } catch {
        actualReportDigest = null;
      }
    }
  }
  const verified =
    state?.status === "completed" && runId !== null && bytes !== null && metadataMatches;
  return {
    generation: {
      ref,
      type: "implementation",
      status: state?.status ?? null,
      lastRunId: runId,
      latestReviewAttemptId: state?.latestReviewAttemptId ?? null,
      completionReason: state?.completionReason ?? null,
      passedWorkRevision: state?.passedWorkRevision ?? null,
      expectedReportDigest,
      actualReportDigest,
      verification: verified ? "verified" : "invalid",
      requirement: descriptor.requirement,
      source: descriptor.source
    },
    bytes: verified ? bytes : null
  };
}

function reviewGeneration(
  context: RuntimeContext,
  ref: string,
  descriptor: RemoteDispatchAuthoritativeDependency
): DependencyGeneration {
  const state = context.state.blocks[ref];
  return {
    ref,
    type: "review",
    status: state?.status ?? null,
    lastRunId: state?.lastRunId ?? null,
    latestReviewAttemptId: state?.latestReviewAttemptId ?? null,
    completionReason: state?.completionReason ?? null,
    passedWorkRevision: state?.passedWorkRevision ?? null,
    expectedReportDigest: null,
    actualReportDigest: null,
    verification: "not_applicable",
    requirement: descriptor.requirement,
    source: descriptor.source
  };
}

export async function remoteBlockSourceSnapshotWithArtifacts(
  context: RuntimeContext,
  ref: string
): Promise<{
  snapshot: RemoteBlockSourceSnapshot;
  materializedInputArtifacts: MaterializedRemoteInputArtifact[];
}> {
  const loaded = await loadPlanGraphPackage(context.workspace, {
    snapshot: {
      workspace: context.workspace,
      manifest: context.manifest,
      compiledGraph: context.graph
    }
  });
  const renderedPrompt = (
    await renderPromptSurface({
      projectRoot: context.workspace,
      ref,
      includeSubmissionInstructions: false,
      renderMode: "remote-dispatch"
    })
  ).markdown;
  const dependencyGenerations: DependencyGeneration[] = [];
  const dependencySummaries: DependencyResultSummary[] = [];
  const inputArtifacts: DispatchInputArtifact[] = [];
  const materializedInputArtifacts: MaterializedRemoteInputArtifact[] = [];

  for (const dependencyDescriptor of remoteDispatchAuthoritativeDependencies(context, ref)) {
    const { ref: dependencyRef } = dependencyDescriptor;
    const dependency = context.graph.blocksByRef.get(dependencyRef);
    if (!dependency) {
      continue;
    }
    if (dependency.type === "review") {
      const generation = reviewGeneration(context, dependencyRef, dependencyDescriptor);
      dependencyGenerations.push(generation);
      if (
        generation.status !== "completed" ||
        (generation.requirement === "passed" && generation.completionReason !== "passed")
      ) {
        continue;
      }
      const outcome = generation.completionReason === "passed" ? "passed" : "completed";
      dependencySummaries.push(
        dependencyResultSummarySchema.parse({
          blockRef: dependencyRef,
          outcome,
          summary:
            outcome === "passed"
              ? `Review dependency '${dependencyRef}' passed.`
              : `Review dependency '${dependencyRef}' completed.`
        })
      );
      continue;
    }
    const { generation, bytes } = await implementationGeneration(
      context,
      dependencyRef,
      dependencyDescriptor
    );
    dependencyGenerations.push(generation);
    if (!bytes || generation.verification !== "verified" || !generation.actualReportDigest) {
      continue;
    }
    const { taskId, blockId } = parseBlockRef(dependencyRef);
    const artifactRef = `artifact:sha256:${generation.actualReportDigest}`;
    dependencySummaries.push(
      dependencyResultSummarySchema.parse({
        blockRef: dependencyRef,
        outcome: "completed",
        summary: `Implementation dependency '${dependencyRef}' completed.`,
        reportArtifactRef: artifactRef
      })
    );
    const inputArtifact = {
      artifactRef,
      logicalName: `dependency-${taskId}-${blockId}-report`,
      mediaType: "text/markdown"
    } as const;
    inputArtifacts.push(inputArtifact);
    materializedInputArtifacts.push({ ...inputArtifact, bytes: new Uint8Array(bytes) });
  }

  const taskId = context.graph.blockTaskByRef.get(ref);
  const dependencyTasks = new Set(
    taskId ? (context.graph.taskDependenciesByTask.get(taskId) ?? []) : []
  );
  const taskDependencies = context.graph.taskNodesInManifestOrder
    .filter((dependencyTaskId) => dependencyTasks.has(dependencyTaskId))
    .map((dependencyTaskId) => ({
      taskId: dependencyTaskId,
      status: context.state.tasks[dependencyTaskId]?.status ?? null,
      openFeedbackCount: context.state.tasks[dependencyTaskId]?.openFeedbackCount ?? null
    }));
  const promptDigest = sha256Hex(renderedPrompt);
  return {
    snapshot: {
      sourceRevision: `src-${sha256Hex(
        stableJson({
          graphVersion: loaded.graph.graphVersion,
          ref,
          promptDigest,
          dependencyGenerations,
          taskDependencies
        })
      )}`,
      graphFingerprint: loaded.graph.packageFingerprint,
      renderedPrompt,
      dependencySummaries,
      inputArtifacts,
      dependencyGenerations
    },
    materializedInputArtifacts
  };
}

export async function remoteBlockSourceSnapshot(
  context: RuntimeContext,
  ref: string
): Promise<RemoteBlockSourceSnapshot> {
  return (await remoteBlockSourceSnapshotWithArtifacts(context, ref)).snapshot;
}

export function assertRemoteBlockSnapshotDependencies(
  snapshot: RemoteBlockSourceSnapshot,
  targetRef: string
): void {
  for (const generation of snapshot.dependencyGenerations) {
    if (generation.type === "implementation" && generation.verification !== "verified") {
      throw new RemoteBlockRuntimeError(
        "remote_block_not_dispatchable",
        `Implementation dependency '${generation.ref}' has no verified result artifact.`
      );
    }
    if (
      generation.type === "review" &&
      (generation.status !== "completed" ||
        (generation.requirement === "passed" && generation.completionReason !== "passed"))
    ) {
      throw new RemoteBlockRuntimeError(
        "remote_block_not_dispatchable",
        `Required review dependency '${generation.ref}' has not passed for '${targetRef}'.`
      );
    }
  }
}
