import { EXCLUSIVE_LOCK, PARALLEL_SAFE_DEPRECATION_MESSAGE } from "../schema/manifest.js";
import type { ManifestBlock, ValidationIssue } from "../types.js";

export { EXCLUSIVE_LOCK, PARALLEL_SAFE_DEPRECATION_MESSAGE };

/**
 * Normalize block parallel policy into effective locks.
 * - absent parallel ⇒ no locks
 * - safe === false ⇒ include reserved exclusive lock
 * - safe === true ⇒ no effect (locks as written)
 */
export function effectiveLocksForBlock(block: ManifestBlock): string[] {
  if (block.type !== "implementation") {
    return [];
  }
  const locks = [...block.parallel.locks];
  if (block.parallel.safe === false && !locks.includes(EXCLUSIVE_LOCK)) {
    locks.push(EXCLUSIVE_LOCK);
  }
  return locks;
}

export function blockUsesDeprecatedParallelSafe(block: ManifestBlock): boolean {
  return block.type === "implementation" && block.parallel.safe !== undefined;
}

export function deprecatedParallelSafeWarning(ref: string): ValidationIssue {
  return {
    code: "parallel_safe_deprecated",
    message: PARALLEL_SAFE_DEPRECATION_MESSAGE,
    path: ref
  };
}

/** Desktop/MCP compat: parallelSafe means "not exclusive" (can co-run with non-conflicting peers). */
export function deriveParallelSafe(locks: readonly string[]): boolean {
  return !locks.includes(EXCLUSIVE_LOCK);
}

export function locksConflict(
  leftLocks: readonly string[],
  rightLocks: readonly string[]
): boolean {
  if (leftLocks.includes(EXCLUSIVE_LOCK) || rightLocks.includes(EXCLUSIVE_LOCK)) {
    return true;
  }
  if (leftLocks.length === 0 || rightLocks.length === 0) {
    return false;
  }
  const right = new Set(rightLocks);
  return leftLocks.some((lock) => right.has(lock));
}

export function withExclusiveLock(locks: readonly string[], exclusive: boolean): string[] {
  const next = locks.filter((lock) => lock !== EXCLUSIVE_LOCK);
  if (exclusive) {
    next.push(EXCLUSIVE_LOCK);
  }
  return next;
}
