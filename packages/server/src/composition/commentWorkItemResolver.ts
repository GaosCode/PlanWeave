import { decodeCanvasReplicaDocument } from "@planweave-ai/runtime";
import type { ContentAuthorityStore } from "../canvas/contentAuthorityStore.js";
import type { CanvasScopeKey } from "../canvas/repository.js";
import { manifestWorkItemFacts, type WorkItemPackagePort } from "../work/workItemFacts.js";
import {
  workItemPackageFactsSchema,
  workItemRefSchema,
  type WorkItemPackageFacts,
  type WorkItemRef
} from "../work/schemas.js";

const maxVersions = 64;
const maxIndexBytes = 4 * 1024 * 1024;

type Index = { port: WorkItemPackagePort; weight: number };

function itemKey(item: WorkItemRef): string {
  return JSON.stringify(
    item.kind === "task" ? [item.kind, item.taskId] : [item.kind, item.blockRef]
  );
}

/** Retains only facts; the validated replica and compiled graph die after construction. */
function buildIndex(content: unknown, canvasId: string): Index {
  const document = decodeCanvasReplicaDocument(content);
  const facts = new Map<string, WorkItemPackageFacts>();
  let weight = document.manifest.edges.length * 32;
  for (const { workItem, facts: fact } of manifestWorkItemFacts(document.manifest, canvasId)) {
    const key = itemKey(workItem);
    facts.set(key, fact);
    weight += Buffer.byteLength(key + JSON.stringify(fact), "utf8");
  }
  const resolveWorkItem = (input: WorkItemRef): WorkItemPackageFacts => {
    const item = workItemRefSchema.parse(input);
    const fact = item.canvasId === canvasId ? facts.get(itemKey(item)) : undefined;
    if (fact) return workItemPackageFactsSchema.parse(fact);
    return {
      canvasId: item.canvasId,
      kind: item.kind,
      exists: false,
      ...(item.kind === "task" ? { taskId: item.taskId } : { blockRef: item.blockRef }),
      requiredCapabilities: []
    };
  };
  return {
    weight,
    port: { resolveWorkItem, resolveWorkItems: (items) => items.map(resolveWorkItem) }
  };
}

/** One bounded cache per composition, never containing request authorization or current heads. */
export function createCommentWorkItemResolver(input: {
  contentVersions: Pick<ContentAuthorityStore, "head" | "readVersion">;
  hasScope(scope: CanvasScopeKey): boolean;
}): (scope: CanvasScopeKey) => WorkItemPackagePort | undefined {
  const cache = new Map<string, Index>();
  let weight = 0;
  return (scope) => {
    if (!input.hasScope(scope)) return undefined;
    const head = input.contentVersions.head(scope);
    if (!head) return undefined;
    const key = JSON.stringify([
      scope.workspaceId,
      scope.projectId,
      scope.canvasId,
      head.content.versionId,
      head.content.canonicalDigest
    ]);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.port;
    }
    // Repository read, decode, and index construction are synchronous: no request can
    // interleave this miss or publish a partially verified index. Throws retain nothing.
    const content = input.contentVersions.readVersion(scope, head.content).content;
    const index = buildIndex(content, scope.canvasId);
    if (index.weight <= maxIndexBytes) {
      while (cache.size >= maxVersions || weight + index.weight > maxIndexBytes) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        weight -= cache.get(oldest)!.weight;
        cache.delete(oldest);
      }
      cache.set(key, index);
      weight += index.weight;
    }
    return index.port;
  };
}
