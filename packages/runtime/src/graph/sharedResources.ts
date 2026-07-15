import type { ManifestBlock } from "../types.js";

/** Normalize soft shared-resource hints without granting them scheduling semantics. */
export function sharedResourcesForBlock(block: ManifestBlock): string[] {
  if (block.type !== "implementation") {
    return [];
  }
  return [...new Set(block.parallel.sharedResources ?? [])];
}
