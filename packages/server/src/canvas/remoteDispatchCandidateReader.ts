import { createHash } from "node:crypto";
import {
  compileTaskGraph,
  decodeCanvasReplicaDocument,
  executorRunnerEvidenceForManifest,
  projectCanvasReplicaDocument,
  parseRemoteReviewResultBytes,
  remoteBlockDispatchCandidateSchema,
  renderRemoteDispatchPromptProjection,
  RemoteBlockRuntimeError,
  type RemoteBlockDispatchCandidate
} from "@planweave-ai/runtime";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import { readStableCanvasRuntimeEvidence } from "./contentFingerprint.js";
import type {
  RemoteDispatchCandidateReaderPort,
  RemoteRuntimeLocator
} from "../remoteBlockCoordinatorPorts.js";

export type ServerDispatchDependencyEvidence = {
  state: "completed" | "failed" | "cancelled";
  reportArtifactRef?: string;
  reportBytes?: Uint8Array;
  reportMediaType?: string;
};

function assertMarkdownArtifact(
  evidence: ServerDispatchDependencyEvidence,
  dependencyRef: string
): asserts evidence is ServerDispatchDependencyEvidence & {
  reportArtifactRef: string;
  reportBytes: Uint8Array;
  reportMediaType: "text/markdown";
} {
  if (
    !evidence.reportArtifactRef ||
    !evidence.reportBytes ||
    evidence.reportMediaType !== "text/markdown"
  ) {
    throw new RemoteBlockRuntimeError(
      "remote_block_not_dispatchable",
      `Dependency '${dependencyRef}' has no verified Markdown result artifact.`
    );
  }
  const digest = createHash("sha256").update(evidence.reportBytes).digest("hex");
  if (evidence.reportArtifactRef !== `artifact:sha256:${digest}`) {
    throw new RemoteBlockRuntimeError(
      "remote_block_not_dispatchable",
      `Dependency '${dependencyRef}' result artifact digest does not match its identity.`
    );
  }
}

export interface ServerDispatchDependencyReader {
  read(
    scope: RemoteRuntimeLocator & { blockRef: string }
  ):
    | ServerDispatchDependencyEvidence
    | undefined
    | Promise<ServerDispatchDependencyEvidence | undefined>;
}

/** Projects a durable dispatch candidate without consulting any Host Runtime. */
export class ServerCanvasDispatchCandidateReader implements RemoteDispatchCandidateReaderPort {
  constructor(
    private readonly content: ContentAuthorityStore,
    private readonly dependencies?: ServerDispatchDependencyReader
  ) {}

  async read(
    input: RemoteRuntimeLocator & { blockRef: string }
  ): Promise<RemoteBlockDispatchCandidate> {
    const scope = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId
    };
    const evidence = readStableCanvasRuntimeEvidence(this.content, scope);
    if (!evidence) throw new Error("canvas_content_head_changed");
    const authoritative = this.content.readVersion(scope, evidence.target.content);
    const document = decodeCanvasReplicaDocument(authoritative.content);
    const projected = projectCanvasReplicaDocument(document);
    const graph = compileTaskGraph(document.manifest);
    const block = graph.blocksByRef.get(input.blockRef);
    const taskId = graph.blockTaskByRef.get(input.blockRef);
    const task = taskId ? graph.tasksById.get(taskId) : undefined;
    if (!block || !task || !taskId) {
      throw new RemoteBlockRuntimeError(
        "remote_block_not_found",
        `Block '${input.blockRef}' does not exist.`
      );
    }
    if (block.type !== "implementation" && block.type !== "review") {
      throw new RemoteBlockRuntimeError(
        "remote_block_not_executable",
        `Remote dispatch supports implementation and review blocks; '${input.blockRef}' is not executable remotely.`
      );
    }
    const effectiveExecutor =
      block.executor ?? task.executor ?? document.manifest.execution.defaultExecutor ?? "default";
    const runner = executorRunnerEvidenceForManifest(document.manifest, effectiveExecutor);
    if (runner.runnerKind !== "acp" || !runner.agentId) {
      throw new RemoteBlockRuntimeError(
        "remote_block_executor_not_acp",
        `Executor '${effectiveExecutor}' for '${input.blockRef}' is not an ACP agent profile.`
      );
    }
    const taskPrompt = document.promptMarkdownByPath[task.prompt];
    const blockPrompt = document.promptMarkdownByPath[block.prompt];
    if (taskPrompt === undefined || blockPrompt === undefined) {
      throw new Error("canvas_replica_prompt_missing");
    }
    const taskProjection = projected.tasks.find((item) => item.taskId === taskId);
    const requiredCapabilities = graph.requiredCapabilitiesByBlockRef.get(input.blockRef) ?? [];
    const sharedResources = graph.sharedResourcesByBlockRef.get(input.blockRef) ?? [];
    const directDependencies = new Set(graph.blockDependenciesByRef.get(input.blockRef) ?? []);
    const dependencyTasks = new Set(graph.taskDependenciesByTask.get(taskId) ?? []);
    const dependencies = graph.blockRefsInManifestOrder.flatMap((dependencyRef) => {
      if (directDependencies.has(dependencyRef)) {
        const dependency = graph.blocksByRef.get(dependencyRef);
        return [
          {
            ref: dependencyRef,
            requirement:
              dependency?.type === "review" && dependency.review.required
                ? ("passed" as const)
                : ("completed" as const)
          }
        ];
      }
      const dependencyTaskId = graph.blockTaskByRef.get(dependencyRef);
      const dependency = graph.blocksByRef.get(dependencyRef);
      return dependencyTaskId !== undefined &&
        dependencyTasks.has(dependencyTaskId) &&
        dependency !== undefined &&
        (dependency.type === "implementation" ||
          (dependency.type === "review" && dependency.review.required))
        ? [
            {
              ref: dependencyRef,
              requirement:
                dependency.type === "review" ? ("passed" as const) : ("completed" as const)
            }
          ]
        : [];
    });
    const dependencySummaries: Array<{
      blockRef: string;
      outcome: "completed" | "passed";
      summary: string;
      reportArtifactRef?: string;
    }> = [];
    const inputArtifacts: Array<{
      artifactRef: string;
      logicalName: string;
      mediaType: "text/markdown";
    }> = [];
    for (const descriptor of dependencies) {
      const dependencyRef = descriptor.ref;
      const dependency = graph.blocksByRef.get(dependencyRef);
      const dependencyEvidence = await this.dependencies?.read({
        ...scope,
        blockRef: dependencyRef
      });
      if (!dependency || dependencyEvidence?.state !== "completed") {
        throw new RemoteBlockRuntimeError(
          "remote_block_not_dispatchable",
          `Dependency '${dependencyRef}' is not completed for '${input.blockRef}'.`
        );
      }
      let outcome: "completed" | "passed" = "completed";
      assertMarkdownArtifact(dependencyEvidence, dependencyRef);
      if (dependency.type === "review") {
        const dependencyTaskId = graph.blockTaskByRef.get(dependencyRef);
        if (!dependencyTaskId) throw new Error("canvas_replica_dependency_task_missing");
        const result = parseRemoteReviewResultBytes({
          ref: dependencyRef,
          taskId: dependencyTaskId,
          bytes: dependencyEvidence.reportBytes
        });
        if (descriptor.requirement === "passed" && result.verdict !== "passed") {
          throw new RemoteBlockRuntimeError(
            "remote_block_not_dispatchable",
            `Required review dependency '${dependencyRef}' has not passed for '${input.blockRef}'.`
          );
        }
        outcome = result.verdict === "passed" ? "passed" : "completed";
      }
      dependencySummaries.push({
        blockRef: dependencyRef,
        outcome,
        summary:
          outcome === "passed"
            ? `Review dependency '${dependencyRef}' passed.`
            : `${dependency.type === "review" ? "Review" : "Implementation"} dependency '${dependencyRef}' completed.`,
        ...(dependencyEvidence.reportArtifactRef
          ? { reportArtifactRef: dependencyEvidence.reportArtifactRef }
          : {})
      });
      if (dependency.type === "implementation" && dependencyEvidence.reportArtifactRef) {
        const [dependencyTaskId, dependencyBlockId] = dependencyRef.split("#");
        inputArtifacts.push({
          artifactRef: dependencyEvidence.reportArtifactRef,
          logicalName: `dependency-${dependencyTaskId}-${dependencyBlockId}-report`,
          mediaType: "text/markdown"
        });
      }
    }
    return remoteBlockDispatchCandidateSchema.parse({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      taskId,
      blockRef: input.blockRef,
      blockType: block.type,
      sourceRevision: evidence.sourceRevision,
      graphFingerprint: evidence.target.graphFingerprint,
      renderedPrompt: renderRemoteDispatchPromptProjection({
        ref: input.blockRef,
        taskId,
        blockTitle: block.title,
        blockType: block.type,
        taskPrompt,
        blockPrompt,
        planGraphContext: [
          `PlanGraph version: ${projected.graphVersion}`,
          `Current claim: ${input.blockRef} (${block.type})`,
          `Task: ${task.id}: ${task.title}`,
          ...(taskProjection?.blocks ?? []).map(
            (item) => `${item.ref} [${item.type}] ${item.title}`
          )
        ].join("\n"),
        acceptance: task.acceptance,
        requiredCapabilities,
        sharedResources
      }),
      acceptance: task.acceptance,
      dependencySummaries,
      inputArtifacts,
      effectiveExecutor,
      agentId: runner.agentId,
      agentProfileId: effectiveExecutor,
      session: {},
      requiredCapabilities
    });
  }
}
