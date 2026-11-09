import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import type { RuntimeArtifactGrantRepository } from "./runtimeArtifactGrantRepository.js";

export const RUNTIME_ARTIFACT_RETENTION_GRACE_MS = 24 * 60 * 60_000;
const LEASE_BATCH_SIZE = 100;
const GRANT_BATCH_SIZE = 200;
const eligibilityTime =
  "MAX(expires_at, CASE WHEN status='active' THEN expires_at ELSE updated_at END)";

type Candidate = { runtimeLeaseId: string; eligibleAt: string };

export class RuntimeArtifactRetention {
  private cursor: Candidate | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly grants: Pick<RuntimeArtifactGrantRepository, "canRetireLease">,
    private readonly clock: () => Date = () => new Date()
  ) {}

  compactBatch(): { selected: number; compacted: number; skipped: number; grantsDeleted: number } {
    const cutoff = new Date(
      this.clock().getTime() - RUNTIME_ARTIFACT_RETENTION_GRACE_MS
    ).toISOString();
    let candidates = this.candidates(cutoff);
    if (candidates.length === 0 && this.cursor) {
      this.cursor = undefined;
      candidates = this.candidates(cutoff);
    }
    const result = { selected: candidates.length, compacted: 0, skipped: 0, grantsDeleted: 0 };
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const allowance = Math.floor(
        (GRANT_BATCH_SIZE - result.grantsDeleted) / (candidates.length - index)
      );
      const batch = inWriteTransaction(this.database, () => {
        const eligible = this.database
          .prepare(
            `SELECT 1 FROM canvas_runtime_leases WHERE runtime_lease_id=? AND ${eligibilityTime}<=?`
          )
          .get(candidate.runtimeLeaseId, cutoff);
        if (!eligible || !this.grants.canRetireLease(candidate.runtimeLeaseId)) {
          return { compacted: 0, grantsDeleted: 0 };
        }
        const deleted = this.database
          .prepare(
            `DELETE FROM canvas_runtime_artifact_grants WHERE grant_id IN (
             SELECT grant_id FROM canvas_runtime_artifact_grants WHERE runtime_lease_id=?
             ORDER BY grant_id LIMIT ?
           )`
          )
          .run(candidate.runtimeLeaseId, allowance).changes;
        const compacted = this.database
          .prepare(
            `DELETE FROM canvas_runtime_leases WHERE runtime_lease_id=?
             AND NOT EXISTS (SELECT 1 FROM canvas_runtime_artifact_grants WHERE runtime_lease_id=?)`
          )
          .run(candidate.runtimeLeaseId, candidate.runtimeLeaseId).changes;
        return { compacted, grantsDeleted: deleted };
      });
      this.cursor = candidate;
      result.compacted += batch.compacted;
      result.grantsDeleted += batch.grantsDeleted;
      if (batch.compacted === 0) result.skipped++;
    }
    return result;
  }

  private candidates(cutoff: string): Candidate[] {
    const after = this.cursor;
    const sameTime =
      after && after.eligibleAt <= cutoff
        ? this.database
            .prepare(
              `SELECT runtime_lease_id,${eligibilityTime} AS eligible_at FROM canvas_runtime_leases
           WHERE ${eligibilityTime}=? AND runtime_lease_id>?
           ORDER BY runtime_lease_id LIMIT ?`
            )
            .all(after.eligibleAt, after.runtimeLeaseId, LEASE_BATCH_SIZE)
        : [];
    const later =
      sameTime.length === LEASE_BATCH_SIZE
        ? []
        : this.database
            .prepare(
              `SELECT runtime_lease_id,${eligibilityTime} AS eligible_at FROM canvas_runtime_leases
       WHERE ${eligibilityTime}<=? ${after ? `AND ${eligibilityTime}>?` : ""}
       ORDER BY ${eligibilityTime},runtime_lease_id LIMIT ?`
            )
            .all(cutoff, ...(after ? [after.eligibleAt] : []), LEASE_BATCH_SIZE - sameTime.length);
    return [...sameTime, ...later].map((row) => ({
      runtimeLeaseId: String(row.runtime_lease_id),
      eligibleAt: String(row.eligible_at)
    }));
  }
}
