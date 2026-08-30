import {
  parseResolveWorkItemsResult,
  resolveWorkItemsRequestSchema,
  type WorkItemPackageFacts
} from "@planweave-ai/collaboration-protocol/work/package-facts";
import {
  capturePackageSnapshot,
  loadPlanGraphPackage,
  resolveTaskCanvasWorkspace
} from "@planweave-ai/runtime";
import {
  firstExactRuntimeAuthorityCandidate,
  type RuntimeAuthorityCandidate,
  type RuntimeAuthorityCandidateDiagnostic,
  type RuntimeReadAuthority
} from "../canvas/runtimeAuthorityCandidates.js";
import type { TrustedRuntimeRegistry } from "../runtimeProjectRegistry.js";
import type { WorkItemRef } from "./schemas.js";
import type {
  WorkRuntimeFactsRequest,
  WorkRuntimePackageFactsPort,
  WorkRuntimeFactsLease
} from "./runtimePort.js";
import { WorkRuntimeUnavailableError } from "./runtimePort.js";

function factKey(item: WorkItemRef): string {
  return item.kind === "task"
    ? `task:${item.canvasId}:${item.taskId}`
    : `block:${item.canvasId}:${item.blockRef}`;
}

export function factsLease(
  request: WorkRuntimeFactsRequest,
  resultInput: unknown
): WorkRuntimeFactsLease {
  const result = parseResolveWorkItemsResult({ workItems: request.workItems }, resultInput);
  const byKey = new Map(
    request.workItems.map((item, index) => [factKey(item), result.facts[index]!] as const)
  );
  let released = false;
  const requireFact = (item: WorkItemRef): WorkItemPackageFacts => {
    if (released) throw new Error("runtime_package_scope_released");
    const fact = byKey.get(factKey(item));
    if (!fact) throw new Error("runtime_package_fact_not_requested");
    return fact;
  };
  return {
    package: {
      resolveWorkItem: requireFact,
      resolveWorkItems: (items) => items.map(requireFact)
    },
    evidence: {
      sourceRevision: result.sourceRevision,
      graphFingerprint: result.graphFingerprint
    },
    release() {
      released = true;
    }
  };
}

function localFacts(
  graph: Awaited<ReturnType<typeof loadPlanGraphPackage>>["graph"],
  item: WorkItemRef
): WorkItemPackageFacts {
  if (item.kind === "task") {
    return {
      canvasId: item.canvasId,
      kind: "task",
      exists: graph.tasks.has(item.taskId),
      taskId: item.taskId,
      requiredCapabilities: []
    };
  }
  const block = graph.blocks.get(item.blockRef);
  return block
    ? {
        canvasId: item.canvasId,
        kind: "block",
        exists: true,
        taskId: block.taskId,
        blockRef: item.blockRef,
        blockType: block.type,
        requiredCapabilities: [...block.requiredCapabilities]
      }
    : {
        canvasId: item.canvasId,
        kind: "block",
        exists: false,
        blockRef: item.blockRef,
        requiredCapabilities: []
      };
}

export class LocalFilesystemWorkRuntimeFactsAdapter implements WorkRuntimePackageFactsPort {
  constructor(private readonly registry: TrustedRuntimeRegistry) {}

  async acquireFacts(input: WorkRuntimeFactsRequest): Promise<WorkRuntimeFactsLease | undefined> {
    const request = resolveWorkItemsRequestSchema.parse({ workItems: input.workItems });
    if (request.workItems.some((item) => item.canvasId !== input.scope.canvasId)) {
      throw new Error("work_item_scope_mismatch");
    }
    const location = this.registry.resolveExactCanvasLocation(input.scope);
    if (!location) return undefined;
    const canvas = await resolveTaskCanvasWorkspace(location.projectRoot, input.scope.canvasId);
    if (canvas.packageDir !== location.packageDir)
      throw new Error("runtime_package_location_mismatch");
    const loaded = await loadPlanGraphPackage(canvas);
    if (loaded.promptReadFailuresByPath.size > 0 || loaded.graph.diagnostics.length > 0) {
      throw new WorkRuntimeUnavailableError("content_out_of_sync");
    }
    const captured = await capturePackageSnapshot({
      projectRoot: location.projectRoot,
      canvasId: input.scope.canvasId
    });
    return factsLease(input, {
      sourceRevision: captured.snapshot.sourceRevision,
      graphFingerprint: loaded.graph.packageFingerprint,
      facts: request.workItems.map((item) => localFacts(loaded.graph, item))
    });
  }
}

export class AuthoritySelectingWorkRuntimeFactsAdapter implements WorkRuntimePackageFactsPort {
  private remote?: {
    factCandidates(
      input: WorkRuntimeFactsRequest,
      request: ReturnType<typeof resolveWorkItemsRequestSchema.parse>,
      authority: RuntimeReadAuthority
    ): RuntimeAuthorityCandidate<WorkRuntimeFactsLease>[];
    reportDiagnostic(diagnostic: RuntimeAuthorityCandidateDiagnostic): void;
    diagnosticCode(error: unknown): string;
  };
  constructor(
    private readonly local: WorkRuntimePackageFactsPort,
    private readonly contentAuthority: {
      read(scope: WorkRuntimeFactsRequest["scope"]): RuntimeReadAuthority | undefined;
    }
  ) {}

  attachRemote(remote: NonNullable<AuthoritySelectingWorkRuntimeFactsAdapter["remote"]>): void {
    if (this.remote) throw new Error("remote_work_runtime_facts_already_attached");
    this.remote = remote;
  }

  async acquireFacts(input: WorkRuntimeFactsRequest): Promise<WorkRuntimeFactsLease | undefined> {
    const request = resolveWorkItemsRequestSchema.parse({ workItems: input.workItems });
    const authority = this.contentAuthority.read(input.scope);
    if (!authority) throw new WorkRuntimeUnavailableError("content_out_of_sync");
    const local: RuntimeAuthorityCandidate<WorkRuntimeFactsLease> = {
      id: "local",
      start: () => ({
        response: this.local
          .acquireFacts(input)
          .then((lease) =>
            lease
              ? { kind: "available" as const, evidence: lease.evidence, value: lease }
              : { kind: "unavailable" as const, reason: "runtime_not_attached" as const }
          ),
        cancel: () => false
      })
    };
    const result = await firstExactRuntimeAuthorityCandidate({
      authority,
      candidates: [local, ...(this.remote?.factCandidates(input, request, authority) ?? [])],
      discard: (lease) => lease.release(),
      diagnosticCode: (error) =>
        this.remote?.diagnosticCode(error) ??
        (error instanceof WorkRuntimeUnavailableError
          ? error.code
          : "work_runtime_facts_candidate_unknown"),
      diagnose: (diagnostic) => this.remote?.reportDiagnostic(diagnostic)
    });
    if (result.kind === "available") {
      try {
        const currentAuthority = this.contentAuthority.read(input.scope);
        if (
          currentAuthority &&
          currentAuthority.sourceRevision === authority.sourceRevision &&
          currentAuthority.target.graphFingerprint === authority.target.graphFingerprint &&
          currentAuthority.target.revision === authority.target.revision &&
          currentAuthority.target.content.versionId === authority.target.content.versionId &&
          currentAuthority.target.content.canonicalDigest ===
            authority.target.content.canonicalDigest
        ) {
          return result.value;
        }
        throw new WorkRuntimeUnavailableError("content_out_of_sync");
      } catch (error) {
        await Promise.resolve()
          .then(() => result.value.release())
          .catch((releaseError: unknown) => {
            const diagnostic = {
              candidateId: result.candidateId,
              category: "peer_error" as const,
              code:
                this.remote?.diagnosticCode(releaseError) ??
                (releaseError instanceof WorkRuntimeUnavailableError
                  ? releaseError.code
                  : "work_runtime_facts_candidate_unknown")
            };
            try {
              if (this.remote) this.remote.reportDiagnostic(diagnostic);
              else console.warn("work_runtime_facts_candidate_error", diagnostic);
            } catch {
              // Cleanup diagnostics are observational and cannot replace the authority error.
            }
          });
        throw error;
      }
    }
    if (!this.remote && result.reason === "runtime_not_attached") return undefined;
    throw new WorkRuntimeUnavailableError(result.reason);
  }
}
