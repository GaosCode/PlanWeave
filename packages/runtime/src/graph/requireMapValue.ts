/**
 * Require a key that initialization / mutation invariants guarantee is present.
 * Missing key means corrupt in-memory graph state, not a user-authored diagnostic.
 * Empty array values are legitimate and are returned as-is.
 */
export function requireMapValue<K, V>(map: Map<K, V>, key: K, indexName: string): V {
  if (!map.has(key)) {
    throw new Error(
      `Internal graph invariant violated: missing key '${String(key)}' in ${indexName}.`
    );
  }
  return map.get(key) as V;
}
