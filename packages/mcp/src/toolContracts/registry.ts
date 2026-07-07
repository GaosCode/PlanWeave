import type { PlanweaveToolName } from "../toolTypes.js";

export function buildToolContractRegistry<T>(
  registries: readonly Readonly<Record<string, T | undefined>>[],
  allToolNames: readonly PlanweaveToolName[],
  label: string
): Record<PlanweaveToolName, T> {
  const allowedNames = new Set<string>(allToolNames);
  const contracts: Partial<Record<PlanweaveToolName, T>> = {};
  const duplicates: string[] = [];
  const unexpected: string[] = [];

  for (const registry of registries) {
    for (const [name, contract] of Object.entries(registry)) {
      if (!contract) {
        continue;
      }
      if (!allowedNames.has(name)) {
        unexpected.push(name);
        continue;
      }
      const toolName = name as PlanweaveToolName;
      if (contracts[toolName]) {
        duplicates.push(name);
        continue;
      }
      contracts[toolName] = contract;
    }
  }

  if (unexpected.length > 0) {
    throw new Error(`Unexpected ${label}(s): ${unexpected.join(", ")}`);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate ${label}(s): ${duplicates.join(", ")}`);
  }

  const missing = allToolNames.filter((name) => !contracts[name]);
  if (missing.length > 0) {
    throw new Error(`Missing ${label}(s): ${missing.join(", ")}`);
  }

  return contracts as Record<PlanweaveToolName, T>;
}
