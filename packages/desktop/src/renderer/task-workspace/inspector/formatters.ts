/**
 * Percentage of the context window in use, or `null` when the agent did not
 * report a window size.
 *
 * A zero window is a legal state (`acpContextUsageSnapshotSchema` documents it),
 * and dividing by it produced `Infinity`/`NaN` in the UI. Returning `null` lets
 * callers render an explicit "unknown" instead of a number that never existed.
 */
export function contextUsagePercent(
  usedTokens: number,
  contextWindowTokens: number
): number | null {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return null;
  if (!Number.isFinite(usedTokens)) return null;
  return Math.round((usedTokens / contextWindowTokens) * 100);
}

/** Same as {@link contextUsagePercent}, clamped for ring geometry. */
export function clampedContextUsagePercent(
  usedTokens: number,
  contextWindowTokens: number
): number {
  const percent = contextUsagePercent(usedTokens, contextWindowTokens);
  if (percent === null) return 0;
  return Math.min(100, Math.max(0, percent));
}

export function displayConfigurationValue(
  value: string | boolean,
  booleanLabels: {
    false: string;
    true: string;
  }
): string {
  if (typeof value === "boolean") {
    return value ? booleanLabels.true : booleanLabels.false;
  }
  return value;
}
