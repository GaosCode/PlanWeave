import type { WorkItemPackageFacts, WorkItemRef } from "./schemas.js";
import type { WorkItemPackagePort } from "./workItemFacts.js";

export type WorkRuntimeProjectScope = {
  workspaceId: string;
  projectId: string;
};

export type WorkRuntimeCanvasScope = WorkRuntimeProjectScope & {
  canvasId: string;
};

export type WorkRuntimePackageLease = {
  package: WorkItemPackagePort;
  release(): void | Promise<void>;
};

export type WorkRuntimeFactsLease = WorkRuntimePackageLease & {
  evidence: { sourceRevision: string; graphFingerprint: string };
};

export type WorkRuntimeFactsRequest = {
  scope: WorkRuntimeCanvasScope;
  workItems: readonly WorkItemRef[];
};

export interface WorkRuntimePackageFactsPort {
  acquireFacts(input: WorkRuntimeFactsRequest): Promise<WorkRuntimeFactsLease | undefined>;
}

export type WorkRuntimeUnavailableCode =
  | "runtime_not_attached"
  | "host_offline"
  | "canvas_runtime_host_ambiguous"
  | "content_out_of_sync";

export class WorkRuntimeUnavailableError extends Error {
  constructor(readonly code: WorkRuntimeUnavailableCode) {
    super(code);
    this.name = "WorkRuntimeUnavailableError";
  }
}

function workItemKey(workItem: WorkItemRef): string {
  return workItem.kind === "task"
    ? `task:${workItem.canvasId}:${workItem.taskId}`
    : `block:${workItem.canvasId}:${workItem.blockRef}`;
}

/** Acquire one immutable Runtime facts snapshot per exact canvas for one application call. */
export async function withWorkRuntimeFacts<T>(
  port: WorkRuntimePackageFactsPort,
  scope: WorkRuntimeProjectScope,
  workItems: readonly WorkItemRef[],
  use: (packagePort: WorkItemPackagePort) => T | Promise<T>
): Promise<T> {
  const groups = new Map<string, WorkItemRef[]>();
  for (const workItem of workItems) {
    const group = groups.get(workItem.canvasId) ?? [];
    group.push(workItem);
    groups.set(workItem.canvasId, group);
  }
  const leases: WorkRuntimeFactsLease[] = [];
  const facts = new Map<string, WorkItemPackageFacts>();
  try {
    for (const [canvasId, canvasWorkItems] of groups) {
      const lease = await port.acquireFacts({
        scope: { ...scope, canvasId },
        workItems: canvasWorkItems
      });
      if (!lease) throw new WorkRuntimeUnavailableError("runtime_not_attached");
      leases.push(lease);
      const resolved = lease.package.resolveWorkItems(canvasWorkItems);
      if (resolved.length !== canvasWorkItems.length) {
        throw new Error("runtime_package_batch_result_mismatch");
      }
      canvasWorkItems.forEach((item, index) => {
        facts.set(workItemKey(item), resolved[index]!);
      });
    }
    const snapshot: WorkItemPackagePort = {
      resolveWorkItem(item) {
        const fact = facts.get(workItemKey(item));
        if (!fact) throw new Error("runtime_package_fact_not_requested");
        return fact;
      },
      resolveWorkItems(items) {
        return items.map((item) => {
          const fact = facts.get(workItemKey(item));
          if (!fact) throw new Error("runtime_package_fact_not_requested");
          return fact;
        });
      }
    };
    return await use(snapshot);
  } finally {
    for (const lease of leases.reverse()) await lease.release();
  }
}
