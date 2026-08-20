import {
  parseResolveWorkItemsResult,
  resolveWorkItemsRequestSchema,
  type WorkItemPackageFacts
} from "@planweave-ai/collaboration-protocol/work/package-facts";
import { loadPlanGraphPackage, resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import type { ContentAuthorityStore } from "../canvas/contentAuthorityStore.js";
import { readStableCanvasContentFingerprint } from "../canvas/contentFingerprint.js";
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
    return factsLease(input, {
      sourceRevision: loaded.graph.graphVersion,
      graphFingerprint: loaded.graph.packageFingerprint,
      facts: request.workItems.map((item) => localFacts(loaded.graph, item))
    });
  }
}

export class LocalFirstWorkRuntimeFactsAdapter implements WorkRuntimePackageFactsPort {
  private remote?: WorkRuntimePackageFactsPort;

  constructor(private readonly local: WorkRuntimePackageFactsPort) {}

  attachRemote(remote: WorkRuntimePackageFactsPort): void {
    this.remote = remote;
  }

  async acquireFacts(input: WorkRuntimeFactsRequest): Promise<WorkRuntimeFactsLease | undefined> {
    const local = await this.local.acquireFacts(input);
    return local ?? this.remote?.acquireFacts(input);
  }
}

export class ContentAlignedWorkRuntimeFactsAdapter implements WorkRuntimePackageFactsPort {
  constructor(
    private readonly delegate: WorkRuntimePackageFactsPort,
    private readonly content: ContentAuthorityStore
  ) {}

  async acquireFacts(input: WorkRuntimeFactsRequest): Promise<WorkRuntimeFactsLease | undefined> {
    const lease = await this.delegate.acquireFacts(input);
    if (!lease) return undefined;
    try {
      const fingerprint = readStableCanvasContentFingerprint(this.content, input.scope);
      if (!fingerprint || fingerprint !== lease.evidence.graphFingerprint) {
        throw new WorkRuntimeUnavailableError("content_out_of_sync");
      }
      return lease;
    } catch (error) {
      await lease.release();
      if (error instanceof WorkRuntimeUnavailableError) throw error;
      if (error instanceof Error && error.message === "canvas_content_head_mismatch") {
        throw new WorkRuntimeUnavailableError("content_out_of_sync");
      }
      throw error;
    }
  }
}
