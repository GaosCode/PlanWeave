import { EXCLUSIVE_LOCK } from "@planweave-ai/runtime";

export const LOCK_OVERFLOW_LIMIT = 3;

export type LockColor = {
  /** Colored dot fill/stroke. */
  dot: string;
  /** Soft halo / highlight ring. */
  halo: string;
};

/** 12-entry OKLCH palette via CSS variables (light/dark defined in index.css). */
const LOCK_PALETTE: LockColor[] = Array.from({ length: 12 }, (_, index) => ({
  dot: `var(--lock-color-${index})`,
  halo: `var(--lock-color-${index}-halo)`
}));

const EXCLUSIVE_COLOR: LockColor = {
  dot: "var(--lock-color-exclusive)",
  halo: "var(--lock-color-exclusive-halo)"
};

function hashLockName(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/** Deterministic color for a lock name. Same name ⇒ same color object values. */
export function lockColor(name: string): LockColor {
  if (name === EXCLUSIVE_LOCK || name === "exclusive") {
    return EXCLUSIVE_COLOR;
  }
  return LOCK_PALETTE[hashLockName(name) % LOCK_PALETTE.length]!;
}
