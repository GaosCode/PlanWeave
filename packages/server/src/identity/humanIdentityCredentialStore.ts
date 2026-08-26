import { randomUUID } from "node:crypto";
import {
  humanIdentityTokenSchema,
  humanPrincipalMergeIdSchema,
  identityCredentialIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { digestsEqual, hashHumanToken, mintHumanIdentityToken } from "./crypto.js";
import { isHumanIdentityUniqueViolation } from "./errors.js";
import { HumanPrincipalIdentity, sqlPlaceholders } from "./humanPrincipalIdentity.js";
import { consolidateCanonicalAuthorization } from "./humanPrincipalAuthorizationMerge.js";
import {
  HUMAN_IDENTITY_DEFAULT_TTL_MS,
  HUMAN_MAX_IDENTITY_CREDENTIALS_PER_PRINCIPAL
} from "./limits.js";

export class HumanIdentityCredentialError extends Error {
  constructor(
    readonly code:
      | "identity_credential_invalid"
      | "identity_credential_expired"
      | "identity_credential_revoked"
      | "identity_limit_exceeded"
      | "identity_merge_same_principal"
      | "identity_merge_unproven"
      | "identity_merge_conflict"
      | "identity_principal_missing",
    message?: string
  ) {
    super(message ?? code);
    this.name = "HumanIdentityCredentialError";
  }
}

export type HumanIdentityCredentialRecord = {
  identityCredentialId: string;
  humanPrincipalId: string;
  issuedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
};

type IdentityRow = {
  identity_credential_id: string;
  human_principal_id: string;
  token_sha256: string;
  issued_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
};

function toRecord(row: IdentityRow): HumanIdentityCredentialRecord {
  return {
    identityCredentialId: row.identity_credential_id,
    humanPrincipalId: row.human_principal_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason
  };
}

export class HumanIdentityCredentialStore {
  private readonly identity: HumanPrincipalIdentity;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date,
    private readonly ttlMs: number = HUMAN_IDENTITY_DEFAULT_TTL_MS
  ) {
    this.identity = new HumanPrincipalIdentity(database);
  }

  resolveCanonicalHumanPrincipalId(humanPrincipalId: string): string {
    try {
      return this.identity.resolveCanonical(humanPrincipalId);
    } catch {
      throw new HumanIdentityCredentialError("identity_merge_conflict");
    }
  }

  authenticate(identityToken: string): HumanIdentityCredentialRecord | undefined {
    const parsed = humanIdentityTokenSchema.safeParse(identityToken);
    if (!parsed.success) return undefined;
    const digest = hashHumanToken(parsed.data);
    const row = this.database
      .prepare("SELECT * FROM human_identity_credentials WHERE token_sha256=?")
      .get(digest) as IdentityRow | undefined;
    if (!row || !digestsEqual(row.token_sha256, digest)) return undefined;
    if (row.revoked_at !== null) return undefined;
    if (Date.parse(row.expires_at) <= this.clock().getTime()) return undefined;
    this.database
      .prepare(
        `UPDATE human_identity_credentials SET last_used_at=?
         WHERE identity_credential_id=? AND revoked_at IS NULL`
      )
      .run(this.clock().toISOString(), row.identity_credential_id);
    const updated = this.database
      .prepare("SELECT * FROM human_identity_credentials WHERE identity_credential_id=?")
      .get(row.identity_credential_id) as IdentityRow;
    return toRecord(updated);
  }

  issue(
    humanPrincipalId: string,
    options?: { excludeCredentialId?: string }
  ): {
    record: HumanIdentityCredentialRecord;
    identityToken: string;
  } {
    const hid = this.resolveCanonicalHumanPrincipalId(humanPrincipalId);
    this.requirePrincipal(hid);
    const activeCount = this.countActiveCredentials(hid, options?.excludeCredentialId);
    if (activeCount >= HUMAN_MAX_IDENTITY_CREDENTIALS_PER_PRINCIPAL) {
      throw new HumanIdentityCredentialError("identity_limit_exceeded");
    }
    const identityCredentialId = identityCredentialIdSchema.parse(
      `identity-credential-${randomUUID()}`
    );
    const identityToken = mintHumanIdentityToken();
    const issuedAt = this.clock().toISOString();
    const expiresAt = new Date(this.clock().getTime() + this.ttlMs).toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO human_identity_credentials(
            identity_credential_id,human_principal_id,token_sha256,issued_at,expires_at
          ) VALUES(?,?,?,?,?)`
        )
        .run(identityCredentialId, hid, hashHumanToken(identityToken), issuedAt, expiresAt);
    } catch (error) {
      if (isHumanIdentityUniqueViolation(error)) {
        throw new HumanIdentityCredentialError("identity_credential_invalid");
      }
      throw error;
    }
    const row = this.database
      .prepare("SELECT * FROM human_identity_credentials WHERE identity_credential_id=?")
      .get(identityCredentialId) as IdentityRow;
    return { record: toRecord(row), identityToken };
  }

  renew(identityToken: string): {
    record: HumanIdentityCredentialRecord;
    identityToken: string;
  } {
    return inWriteTransaction(this.database, () => {
      const current = this.requireUsable(identityToken);
      const next = this.issue(current.humanPrincipalId, {
        excludeCredentialId: current.identityCredentialId
      });
      this.revokeRecord(current.identityCredentialId, "renewed");
      return next;
    });
  }

  revoke(identityToken: string, reason: string): HumanIdentityCredentialRecord {
    return inWriteTransaction(this.database, () => {
      const current = this.requireUsable(identityToken);
      return this.revokeRecord(current.identityCredentialId, reason);
    });
  }

  merge(
    sourceIdentityToken: string,
    canonicalIdentityToken: string
  ): {
    canonicalHumanPrincipalId: string;
    alreadyEquivalent: boolean;
    mergeId?: string;
    sourceHumanPrincipalId?: string;
    mergedAt?: string;
  } {
    return inWriteTransaction(this.database, () =>
      this.mergeLocked(sourceIdentityToken, canonicalIdentityToken)
    );
  }

  private mergeLocked(
    sourceIdentityToken: string,
    canonicalIdentityToken: string
  ): {
    canonicalHumanPrincipalId: string;
    alreadyEquivalent: boolean;
    mergeId?: string;
    sourceHumanPrincipalId?: string;
    mergedAt?: string;
  } {
    const source = this.requireUsable(sourceIdentityToken);
    const canonical = this.requireUsable(canonicalIdentityToken);
    const sourceCanonical = this.resolveCanonicalHumanPrincipalId(source.humanPrincipalId);
    const targetCanonical = this.resolveCanonicalHumanPrincipalId(canonical.humanPrincipalId);
    if (source.humanPrincipalId === canonical.humanPrincipalId) {
      throw new HumanIdentityCredentialError("identity_merge_same_principal");
    }
    if (sourceCanonical === targetCanonical) {
      return {
        alreadyEquivalent: true,
        canonicalHumanPrincipalId: targetCanonical
      };
    }
    this.assertCombinedCredentialLimit(sourceCanonical, targetCanonical);
    const existingAlias = this.database
      .prepare(
        "SELECT canonical_human_principal_id FROM human_principal_aliases WHERE alias_human_principal_id=?"
      )
      .get(sourceCanonical) as { canonical_human_principal_id: string } | undefined;
    if (existingAlias && existingAlias.canonical_human_principal_id !== targetCanonical) {
      throw new HumanIdentityCredentialError("identity_merge_conflict");
    }
    const mergeId = humanPrincipalMergeIdSchema.parse(`identity-merge-${randomUUID()}`);
    const mergedAt = this.clock().toISOString();
    this.database
      .prepare(
        `INSERT INTO human_principal_merges(
          merge_id,source_human_principal_id,canonical_human_principal_id,
          source_identity_credential_id,canonical_identity_credential_id,merged_at
        ) VALUES(?,?,?,?,?,?)`
      )
      .run(
        mergeId,
        sourceCanonical,
        targetCanonical,
        source.identityCredentialId,
        canonical.identityCredentialId,
        mergedAt
      );
    this.database
      .prepare(
        `INSERT INTO human_principal_aliases(
          alias_human_principal_id,canonical_human_principal_id,merge_id
        ) VALUES(?,?,?)`
      )
      .run(sourceCanonical, targetCanonical, mergeId);
    consolidateCanonicalAuthorization(this.database, targetCanonical, mergedAt);
    return {
      alreadyEquivalent: false,
      mergeId,
      sourceHumanPrincipalId: sourceCanonical,
      canonicalHumanPrincipalId: targetCanonical,
      mergedAt
    };
  }

  private countActiveCredentials(humanPrincipalId: string, excludeCredentialId?: string): number {
    const ids = this.identity.equivalentIds(humanPrincipalId);
    const inSql = sqlPlaceholders(ids);
    const now = this.clock().toISOString();
    const row = (
      excludeCredentialId === undefined
        ? this.database
            .prepare(
              `SELECT COUNT(*) AS count FROM human_identity_credentials
               WHERE human_principal_id IN (${inSql}) AND revoked_at IS NULL AND expires_at>?`
            )
            .get(...ids, now)
        : this.database
            .prepare(
              `SELECT COUNT(*) AS count FROM human_identity_credentials
               WHERE human_principal_id IN (${inSql}) AND revoked_at IS NULL AND expires_at>?
                 AND identity_credential_id!=?`
            )
            .get(...ids, now, excludeCredentialId)
    ) as { count: number };
    return Number(row.count);
  }

  private assertCombinedCredentialLimit(sourceCanonical: string, targetCanonical: string): void {
    const combined = [
      ...new Set([
        ...this.identity.equivalentIds(sourceCanonical),
        ...this.identity.equivalentIds(targetCanonical)
      ])
    ];
    const inSql = sqlPlaceholders(combined);
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM human_identity_credentials
         WHERE human_principal_id IN (${inSql}) AND revoked_at IS NULL AND expires_at>?`
      )
      .get(...combined, this.clock().toISOString()) as { count: number };
    if (Number(row.count) > HUMAN_MAX_IDENTITY_CREDENTIALS_PER_PRINCIPAL) {
      throw new HumanIdentityCredentialError("identity_limit_exceeded");
    }
  }

  private requireUsable(identityToken: string): HumanIdentityCredentialRecord {
    const parsed = humanIdentityTokenSchema.safeParse(identityToken);
    if (!parsed.success) {
      throw new HumanIdentityCredentialError("identity_credential_invalid");
    }
    const digest = hashHumanToken(parsed.data);
    const row = this.database
      .prepare("SELECT * FROM human_identity_credentials WHERE token_sha256=?")
      .get(digest) as IdentityRow | undefined;
    if (!row || !digestsEqual(row.token_sha256, digest)) {
      throw new HumanIdentityCredentialError("identity_credential_invalid");
    }
    if (row.revoked_at !== null) {
      throw new HumanIdentityCredentialError("identity_credential_revoked");
    }
    if (Date.parse(row.expires_at) <= this.clock().getTime()) {
      throw new HumanIdentityCredentialError("identity_credential_expired");
    }
    return toRecord(row);
  }

  private requirePrincipal(humanPrincipalId: string): void {
    const found = this.database
      .prepare("SELECT 1 FROM human_principals WHERE human_principal_id=?")
      .get(humanPrincipalId);
    if (!found) throw new HumanIdentityCredentialError("identity_principal_missing");
  }

  private revokeRecord(
    identityCredentialId: string,
    reason: string
  ): HumanIdentityCredentialRecord {
    const revokedAt = this.clock().toISOString();
    const updated = this.database
      .prepare(
        `UPDATE human_identity_credentials
         SET revoked_at=?, revoked_reason=?
         WHERE identity_credential_id=? AND revoked_at IS NULL`
      )
      .run(revokedAt, reason, identityCredentialId);
    if (updated.changes !== 1) {
      throw new HumanIdentityCredentialError("identity_credential_revoked");
    }
    const row = this.database
      .prepare("SELECT * FROM human_identity_credentials WHERE identity_credential_id=?")
      .get(identityCredentialId) as IdentityRow;
    return toRecord(row);
  }
}
