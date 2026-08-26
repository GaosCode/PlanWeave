import { humanPrincipalIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { SqliteDatabase } from "../sqlite.js";

export function sqlPlaceholders(ids: readonly string[]): string {
  if (ids.length < 1) throw new Error("identity_equivalent_ids_empty");
  return ids.map(() => "?").join(",");
}

/**
 * Server-global Human Principal identity. Alias resolution is the authority
 * for "same person" checks across membership, ACL, picker, sessions, Work,
 * Comment, credentials, and Remote Agent access.
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

  /**
   * Persist this id for current authorization targets (membership grants, owners,
   * assignment/reviewer principals, pending-upload owners, dispatch callers).
   * Audit fields such as grantedBy and comment author keep the historical id.
   */
  canonicalizeTarget(humanPrincipalId: string): string {
    return this.resolveCanonical(humanPrincipalId);
  }

  areEquivalent(left: string | null, right: string): boolean {
    if (left === null) return false;
    return this.resolveCanonical(left) === this.resolveCanonical(right);
  }

  equivalentIds(humanPrincipalId: string): string[] {
    const canonical = this.resolveCanonical(humanPrincipalId);
    const rows = this.database
      .prepare(
        `WITH RECURSIVE equivalent(id) AS (
           SELECT ?
           UNION
           SELECT alias_human_principal_id
           FROM human_principal_aliases
           JOIN equivalent
             ON human_principal_aliases.canonical_human_principal_id = equivalent.id
         )
         SELECT id FROM equivalent ORDER BY id`
      )
      .all(canonical) as Array<{ id: string }>;
    return rows.map((row) => humanPrincipalIdSchema.parse(row.id));
  }
}
