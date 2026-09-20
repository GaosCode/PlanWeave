import { createHash, randomUUID } from "node:crypto";
import {
  managementDeviceEnrollmentSchema,
  managementDeviceRefreshSchema,
  managementDeviceSchema,
  managementDevicesSchema,
  type ManagementAuthorizationStatus
} from "@planweave-ai/agent-host-protocol/operator-control";
import type { OperatorCredential, OperatorPrincipal } from "../operatorAuth.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { OperatorSessionStore, hashOperatorSessionToken } from "./operatorSessionStore.js";

export const managementAccessTtlMs = 60 * 60_000;
const digest = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Device secrets authorize refresh only; ordinary API authentication uses short-lived sessions. */
export class OperatorManagementDevices {
  private readonly sessions: OperatorSessionStore;
  constructor(
    private readonly database: SqliteDatabase,
    private readonly credentials: readonly OperatorCredential[],
    private readonly administrator: (principal: OperatorPrincipal) => boolean,
    private readonly issue: (operatorId: string, token: string) => ManagementAuthorizationStatus,
    private readonly clock: () => Date
  ) {
    this.sessions = new OperatorSessionStore(database, clock);
  }

  isActive(deviceId: string): boolean {
    const row = this.database
      .prepare("SELECT * FROM operator_management_devices WHERE device_id=?")
      .get(deviceId);
    if (!row || row.revoked_at !== null) return false;
    const root = this.credentials.find(
      (c) =>
        c.serverAdmin && c.tokenSha256 === row.authority_sha256 && c.operatorId === row.operator_id
    );
    return Boolean(
      root &&
        this.sessions.findByCredentialDigest(root.tokenSha256)?.revokedAt ===
          row.authority_revoked_at
    );
  }

  enroll(principal: OperatorPrincipal, input: unknown) {
    const parsed = managementDeviceEnrollmentSchema.parse(input);
    return inWriteTransaction(this.database, () => {
      this.requireAdministrator(principal);
      const secretDigest = digest(parsed.deviceSecret);
      const existing = this.database
        .prepare("SELECT * FROM operator_management_devices WHERE secret_sha256=?")
        .get(secretDigest);
      if (existing) {
        if (
          existing.operator_id !== principal.operatorId ||
          typeof existing.device_id !== "string" ||
          !this.isActive(existing.device_id)
        )
          throw new Error("operator_device_revoked");
        return this.view(existing);
      }
      const authority = this.credentials.find(
        (c) => c.serverAdmin && c.operatorId === principal.operatorId
      );
      const root = authority && this.sessions.findByCredentialDigest(authority.tokenSha256);
      if (!root) throw new Error("operator_management_authority_unavailable");
      const deviceId = randomUUID();
      const now = this.clock().toISOString();
      this.database
        .prepare(`INSERT INTO operator_management_devices
        (device_id,secret_sha256,device_name,operator_id,authority_sha256,authority_revoked_at,created_at,last_used_at)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(
          deviceId,
          secretDigest,
          parsed.deviceName,
          principal.operatorId,
          root.credentialSha256,
          root.revokedAt,
          now,
          now
        );
      return managementDeviceSchema.parse({
        deviceId,
        deviceName: parsed.deviceName,
        operatorId: principal.operatorId,
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null
      });
    });
  }

  refresh(input: unknown) {
    const parsed = managementDeviceRefreshSchema.parse(input);
    return inWriteTransaction(this.database, () => {
      const row = this.database
        .prepare("SELECT * FROM operator_management_devices WHERE secret_sha256=?")
        .get(digest(parsed.deviceSecret));
      if (
        !row ||
        typeof row.device_id !== "string" ||
        typeof row.operator_id !== "string" ||
        !this.isActive(row.device_id)
      )
        throw new Error("operator_device_revoked");
      const tokenDigest = hashOperatorSessionToken(parsed.newToken);
      const existing = this.sessions.findByCredentialDigest(tokenDigest);
      if (existing) {
        const link = this.database
          .prepare("SELECT device_id FROM operator_management_sessions WHERE credential_sha256=?")
          .get(tokenDigest);
        if (link?.device_id !== row.device_id)
          throw new Error("operator_management_token_conflict");
      }
      const status = this.issue(row.operator_id, parsed.newToken);
      this.database
        .prepare("UPDATE operator_management_sessions SET device_id=? WHERE credential_sha256=?")
        .run(row.device_id, tokenDigest);
      this.database
        .prepare("UPDATE operator_management_devices SET last_used_at=? WHERE device_id=?")
        .run(this.clock().toISOString(), row.device_id);
      return { ...status, deviceId: row.device_id };
    });
  }

  list(principal: OperatorPrincipal) {
    this.requireAdministrator(principal);
    return managementDevicesSchema.parse(
      this.database
        .prepare("SELECT * FROM operator_management_devices ORDER BY created_at DESC")
        .all()
        .map((row) => this.view(row))
    );
  }

  revoke(principal: OperatorPrincipal, deviceId: string) {
    return inWriteTransaction(this.database, () => {
      this.requireAdministrator(principal);
      const now = this.clock().toISOString();
      const result = this.database
        .prepare(
          "UPDATE operator_management_devices SET revoked_at=COALESCE(revoked_at,?) WHERE device_id=?"
        )
        .run(now, deviceId);
      if (!result.changes) throw new Error("operator_device_not_found");
      this.database
        .prepare(`UPDATE workspace_operator_sessions SET revoked_at=COALESCE(revoked_at,?)
        WHERE credential_sha256 IN (SELECT credential_sha256 FROM operator_management_sessions WHERE device_id=?)`)
        .run(now, deviceId);
    });
  }

  private requireAdministrator(principal: OperatorPrincipal) {
    if (!this.administrator(principal)) throw new Error("operator_server_admin_required");
  }

  private view(row: Record<string, unknown>) {
    return managementDeviceSchema.parse({
      deviceId: row.device_id,
      deviceName: row.device_name,
      operatorId: row.operator_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at
    });
  }
}
