import { humanPrincipalIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { SqliteDatabase } from "../sqlite.js";

/**
 * Server-global Human Principal identity. Alias resolution is the single
 * authority for "same person" checks across Remote Agent access and management.
 */
export class HumanPrincipalIdentity {
  constructor(private readonly database: SqliteDatabase) {}

  resolveCanonical(humanPrincipalId: string): string {
    const id = humanPrincipalIdSchema.parse(humanPrincipalId);
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const alias = this.database
        .prepare(
          `SELECT canonical_human_principal_id
           FROM human_principal_aliases WHERE alias_human_principal_id=?`
        )
        .get(current) as { canonical_human_principal_id: string } | undefined;
      if (!alias) return current;
      current = humanPrincipalIdSchema.parse(alias.canonical_human_principal_id);
    }
    throw new Error("identity_alias_cycle");
  }

  areEquivalent(left: string | null, right: string): boolean {
    if (left === null) return false;
    return this.resolveCanonical(left) === this.resolveCanonical(right);
  }

  equivalentIds(humanPrincipalId: string): string[] {
    const canonical = this.resolveCanonical(humanPrincipalId);
    const aliases = this.database
      .prepare(
        `SELECT alias_human_principal_id
         FROM human_principal_aliases WHERE canonical_human_principal_id=?
         ORDER BY alias_human_principal_id`
      )
      .all(canonical) as Array<{ alias_human_principal_id: string }>;
    const ids = [
      canonical,
      ...aliases.map((row) => humanPrincipalIdSchema.parse(row.alias_human_principal_id))
    ];
    return [...new Set(ids)];
  }
}
