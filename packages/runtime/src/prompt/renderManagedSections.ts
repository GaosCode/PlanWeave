export type ManagedSectionContext = Record<string, unknown>;

export async function renderManagedSections(_context: ManagedSectionContext): Promise<Record<string, string>> {
  throw new Error("Managed prompt sections were removed in the block-level prompt renderer.");
}
