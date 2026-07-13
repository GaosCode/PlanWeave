export function contextUsagePercent(usedTokens: number, contextWindowTokens: number): number {
  return Math.round((usedTokens / contextWindowTokens) * 100);
}

export function clampedContextUsagePercent(
  usedTokens: number,
  contextWindowTokens: number
): number {
  return Math.min(100, Math.max(0, contextUsagePercent(usedTokens, contextWindowTokens)));
}

export function displayConfigurationValue(value: string | boolean, booleanLabels: {
  false: string;
  true: string;
}): string {
  if (typeof value === "boolean") {
    return value ? booleanLabels.true : booleanLabels.false;
  }
  return value;
}
