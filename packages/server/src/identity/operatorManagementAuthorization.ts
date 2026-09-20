import { createHash, randomBytes } from "node:crypto";
import {
  managementAuthorizationStatusSchema,
  managementRecoveryCodeSchema,
  managementTokenSchema,
  type ManagementAuthorizationStatus
} from "@planweave-ai/agent-host-protocol/operator-control";
import type { OperatorCredential, OperatorPrincipal } from "../operatorAuth.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { OperatorSessionStore, hashOperatorSessionToken } from "./operatorSessionStore.js";

const digestCode = (code: string) => createHash("sha256").update(code).digest("hex");

/** Delegation remains anchored to the exact configured authority, never just an operator ID. */
export class OperatorManagementAuthorization {
  private readonly sessions: OperatorSessionStore;
  constructor(
    private readonly database: SqliteDatabase,
    private readonly credentials: readonly OperatorCredential[],
    private readonly ttlMs: number,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.sessions = new OperatorSessionStore(database, clock);
  }

  delegatedCredential(sessionDigest: string): OperatorCredential | undefined {
    const row = this.database
      .prepare(
        "SELECT authority_sha256,authority_revoked_at FROM operator_management_sessions WHERE credential_sha256=?"
      )
      .get(sessionDigest);
    if (!row) return undefined;
    const authority = this.credentials.find(
      (c) => c.serverAdmin && c.tokenSha256 === row.authority_sha256
    );
    const root = authority && this.sessions.findByCredentialDigest(authority.tokenSha256);
    return root && root.revokedAt === row.authority_revoked_at ? authority : undefined;
  }

  maintain(principal: OperatorPrincipal): ManagementAuthorizationStatus {
    if (!principal.serverAdmin) throw new Error("operator_server_admin_required");
    return inWriteTransaction(this.database, () => {
      const session = this.sessions.findBySessionId(
        principal.workspaceId,
        principal.operatorSessionId
      );
      if (!session || !this.activeAdministrator(principal)) {
        throw new Error("operator_unauthorized");
      }
      const now = this.clock();
      const expiresAt =
        new Date(session.expiresAt).getTime() - now.getTime() <= this.ttlMs / 3
          ? new Date(now.getTime() + this.ttlMs).toISOString()
          : session.expiresAt;
      if (expiresAt !== session.expiresAt) {
        this.database
          .prepare(`UPDATE workspace_operator_sessions SET expires_at=?
          WHERE credential_sha256=? AND revoked_at IS NULL AND expires_at>?`)
          .run(expiresAt, session.credentialSha256, now.toISOString());
      }
      return this.status(session.operatorId, expiresAt);
    });
  }

  authorize(
    principal: OperatorPrincipal,
    operatorId: string,
    newToken: string
  ): ManagementAuthorizationStatus {
    return inWriteTransaction(this.database, () => {
      if (!this.activeAdministrator(principal)) throw new Error("operator_server_admin_required");
      return this.issue(operatorId, newToken);
    });
  }

  createRecoveryCode(operatorId: string): { recoveryCode: string; expiresAt: string } {
    const authority = this.authority(operatorId);
    const root = this.sessions.findByCredentialDigest(authority.tokenSha256)!;
    const recoveryCode = `pw_recover_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(this.clock().getTime() + 10 * 60_000).toISOString();
    this.database
      .prepare(`INSERT INTO operator_management_recovery_codes
      (code_sha256,authority_sha256,authority_revoked_at,expires_at) VALUES(?,?,?,?)`)
      .run(digestCode(recoveryCode), authority.tokenSha256, root.revokedAt, expiresAt);
    return { recoveryCode, expiresAt };
  }

  recover(
    operatorId: string,
    recoveryCode: string,
    newToken: string
  ): ManagementAuthorizationStatus {
    managementRecoveryCodeSchema.parse(recoveryCode);
    managementTokenSchema.parse(newToken);
    return inWriteTransaction(this.database, () => {
      const authority = this.authority(operatorId);
      const row = this.database
        .prepare(`SELECT authority_sha256,authority_revoked_at,expires_at,redeemed_credential_sha256
        FROM operator_management_recovery_codes WHERE code_sha256=?`)
        .get(digestCode(recoveryCode));
      if (
        !row ||
        row.authority_sha256 !== authority.tokenSha256 ||
        row.authority_revoked_at !==
          this.sessions.findByCredentialDigest(authority.tokenSha256)?.revokedAt ||
        typeof row.expires_at !== "string" ||
        row.expires_at <= this.clock().toISOString() ||
        (row.redeemed_credential_sha256 !== null &&
          row.redeemed_credential_sha256 !== hashOperatorSessionToken(newToken))
      ) {
        throw new Error("operator_recovery_invalid");
      }
      // Retrying a lost response can only recover the same client-generated credential.
      const status = this.issue(operatorId, newToken);
      this.database
        .prepare(`UPDATE operator_management_recovery_codes SET redeemed_credential_sha256=?
        WHERE code_sha256=?`)
        .run(hashOperatorSessionToken(newToken), digestCode(recoveryCode));
      return status;
    });
  }

  private activeAdministrator(principal: OperatorPrincipal): boolean {
    const session = this.sessions.findBySessionId(
      principal.workspaceId,
      principal.operatorSessionId
    );
    if (
      !session ||
      session.operatorId !== principal.operatorId ||
      !this.sessions.authenticateDigest(session.credentialSha256)
    )
      return false;
    const authority =
      this.credentials.find((c) => c.serverAdmin && c.tokenSha256 === session.credentialSha256) ??
      this.delegatedCredential(session.credentialSha256);
    return authority?.operatorId === session.operatorId;
  }

  private authority(operatorId: string): OperatorCredential {
    const authority = this.credentials.find((c) => c.serverAdmin && c.operatorId === operatorId);
    const root = authority && this.sessions.findByCredentialDigest(authority.tokenSha256);
    if (!authority || !root) throw new Error("operator_management_authority_unavailable");
    return authority;
  }

  private issue(operatorId: string, newToken: string): ManagementAuthorizationStatus {
    managementTokenSchema.parse(newToken);
    const authority = this.authority(operatorId);
    const root = this.sessions.findByCredentialDigest(authority.tokenSha256)!;
    const digest = hashOperatorSessionToken(newToken);
    const existing = this.sessions.findByCredentialDigest(digest);
    if (existing) {
      if (
        existing.operatorId !== operatorId ||
        this.delegatedCredential(digest)?.tokenSha256 !== authority.tokenSha256 ||
        !this.sessions.authenticateDigest(digest)
      )
        throw new Error("operator_management_token_conflict");
      return this.status(operatorId, existing.expiresAt);
    }
    const issuedAt = this.clock().toISOString();
    const expiresAt = new Date(this.clock().getTime() + this.ttlMs).toISOString();
    this.sessions.create({
      workspaceId: root.workspaceId,
      operatorId,
      credentialSha256: digest,
      issuedAt,
      expiresAt
    });
    this.database
      .prepare(
        "INSERT INTO operator_management_sessions(credential_sha256,authority_sha256,authority_revoked_at) VALUES(?,?,?)"
      )
      .run(digest, authority.tokenSha256, root.revokedAt);
    return this.status(operatorId, expiresAt);
  }

  private status(operatorId: string, expiresAt: string): ManagementAuthorizationStatus {
    return managementAuthorizationStatusSchema.parse({
      operatorId,
      expiresAt,
      renewAfter: new Date(new Date(expiresAt).getTime() - this.ttlMs / 3).toISOString()
    });
  }
}
