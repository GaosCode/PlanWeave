import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  agentHostIdSchema,
  humanPrincipalIdSchema,
  timestampSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import { endpointIdFor } from "../agentEndpointCatalog.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { RemoteAgentAuthorizationError } from "./errors.js";
import {
  remoteAgentAccessModeSchema,
  remoteAgentGrantRevisionSchema,
  remoteAgentPolicyRevisionSchema,
  remoteAgentRecordSchema,
  remoteAgentWorkspaceGrantRecordSchema,
  type RemoteAgentAccessMode,
  type RemoteAgentRecord,
  type RemoteAgentWorkspaceGrantRecord
} from "./schema.js";

export class RemoteAgentRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RemoteAgentRepositoryError";
  }
}

const registerOrRestoreInputSchema = z
  .object({
    hostId: agentHostIdSchema,
    profileId: opaqueIdentifierSchema,
    agentId: opaqueIdentifierSchema,
    displayName: z.string().trim().min(1).max(128),
    now: timestampSchema,
    ownerHumanPrincipalId: humanPrincipalIdSchema.optional(),
    accessMode: remoteAgentAccessModeSchema.optional()
  })
  .strict();

const repairOwnershipInputSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    ownerHumanPrincipalId: humanPrincipalIdSchema
  })
  .strict();

const setAccessModeInputSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    accessMode: remoteAgentAccessModeSchema,
    expectedPolicyRevision: remoteAgentPolicyRevisionSchema.optional()
  })
  .strict();

const grantWorkspaceInputSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    workspaceId: workspaceIdSchema,
    grantedByHumanPrincipalId: humanPrincipalIdSchema,
    expectedGrantRevision: remoteAgentGrantRevisionSchema.optional()
  })
  .strict();

const revokeGrantInputSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    workspaceId: workspaceIdSchema
  })
  .strict();

export type RegisterOrRestoreRemoteAgentInput = z.input<typeof registerOrRestoreInputSchema>;
export type RepairRemoteAgentOwnershipInput = z.input<typeof repairOwnershipInputSchema>;
export type SetRemoteAgentAccessModeInput = z.input<typeof setAccessModeInputSchema>;
export type GrantRemoteAgentWorkspaceInput = z.input<typeof grantWorkspaceInputSchema>;
export type RevokeRemoteAgentGrantInput = z.input<typeof revokeGrantInputSchema>;

function sqliteToggle(value: unknown): boolean {
  const flag = Number(value);
  if (flag !== 0 && flag !== 1) {
    throw new RemoteAgentRepositoryError("remote_agent_row_invalid");
  }
  return flag === 1;
}

function mapAgentRow(row: Record<string, unknown>): RemoteAgentRecord {
  return remoteAgentRecordSchema.parse({
    endpointId: row.endpoint_id,
    hostId: row.host_id,
    profileId: row.profile_id,
    agentId: row.agent_id,
    ownerHumanPrincipalId: row.owner_human_principal_id,
    displayName: row.display_name,
    accessMode: row.access_mode,
    policyRevision: Number(row.policy_revision),
    ownershipRepairRequired: sqliteToggle(row.ownership_repair_required),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at
  });
}

function mapGrantRow(row: Record<string, unknown>): RemoteAgentWorkspaceGrantRecord {
  return remoteAgentWorkspaceGrantRecordSchema.parse({
    endpointId: row.endpoint_id,
    workspaceId: row.workspace_id,
    grantRevision: Number(row.grant_revision),
    grantedByHumanPrincipalId: row.granted_by_human_principal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at
  });
}

function requireAgent(row: Record<string, unknown> | undefined): RemoteAgentRecord {
  if (!row) throw new RemoteAgentAuthorizationError("remote_agent_not_found");
  return mapAgentRow(row);
}

function requireGrant(row: Record<string, unknown> | undefined): RemoteAgentWorkspaceGrantRecord {
  if (!row) throw new RemoteAgentRepositoryError("remote_agent_row_invalid");
  return mapGrantRow(row);
}

function assertMutableAgent(agent: RemoteAgentRecord): void {
  if (agent.revokedAt !== null) {
    throw new RemoteAgentAuthorizationError("remote_agent_revoked");
  }
  if (agent.ownershipRepairRequired) {
    throw new RemoteAgentAuthorizationError("remote_agent_owner_required");
  }
}

function exists(database: SqliteDatabase, sql: string, ...values: unknown[]): boolean {
  return database.prepare(sql).get(...values) !== undefined;
}

export class RemoteAgentRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  getByEndpointId(endpointId: string): RemoteAgentRecord | undefined {
    const parsed = opaqueIdentifierSchema.parse(endpointId);
    const row = this.database
      .prepare("SELECT * FROM remote_agents WHERE endpoint_id=?")
      .get(parsed);
    return row ? mapAgentRow(row) : undefined;
  }

  listByHostId(hostId: string): RemoteAgentRecord[] {
    const parsed = agentHostIdSchema.parse(hostId);
    return this.database
      .prepare(
        `SELECT * FROM remote_agents WHERE host_id=?
         ORDER BY profile_id, agent_id, endpoint_id`
      )
      .all(parsed)
      .map(mapAgentRow);
  }

  listByOwnerHumanPrincipalId(ownerHumanPrincipalId: string): RemoteAgentRecord[] {
    const parsed = humanPrincipalIdSchema.parse(ownerHumanPrincipalId);
    return this.database
      .prepare(
        `SELECT * FROM remote_agents
         WHERE owner_human_principal_id=? AND ownership_repair_required=0
         ORDER BY display_name, endpoint_id`
      )
      .all(parsed)
      .map(mapAgentRow);
  }

  listOwnershipRepairRequired(): RemoteAgentRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM remote_agents
         WHERE ownership_repair_required=1 AND revoked_at IS NULL
         ORDER BY display_name, endpoint_id`
      )
      .all()
      .map(mapAgentRow);
  }

  registerOrRestoreFromProfile(input: RegisterOrRestoreRemoteAgentInput): RemoteAgentRecord {
    const parsed = registerOrRestoreInputSchema.parse(input);
    const endpointId = endpointIdFor({
      hostId: parsed.hostId,
      profileId: parsed.profileId,
      agentId: parsed.agentId
    });
    return inWriteTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          `SELECT * FROM remote_agents
           WHERE endpoint_id=? OR (host_id=? AND profile_id=? AND agent_id=?)`
        )
        .get(endpointId, parsed.hostId, parsed.profileId, parsed.agentId);
      if (existing) {
        const current = mapAgentRow(existing);
        this.database
          .prepare("UPDATE remote_agents SET display_name=?, updated_at=? WHERE endpoint_id=?")
          .run(parsed.displayName, parsed.now, current.endpointId);
        return requireAgent(
          this.database
            .prepare("SELECT * FROM remote_agents WHERE endpoint_id=?")
            .get(current.endpointId)
        );
      }
      if (!exists(this.database, "SELECT 1 FROM agent_hosts WHERE id=?", parsed.hostId)) {
        throw new RemoteAgentRepositoryError("remote_agent_host_not_found");
      }
      const ownerHumanPrincipalId = parsed.ownerHumanPrincipalId ?? null;
      let accessMode: RemoteAgentAccessMode;
      let ownershipRepairRequired: 0 | 1;
      if (ownerHumanPrincipalId === null) {
        if (parsed.accessMode === "unrestricted") {
          throw new RemoteAgentRepositoryError("remote_agent_unrestricted_requires_owner");
        }
        accessMode = "workspace_restricted";
        ownershipRepairRequired = 1;
      } else {
        if (parsed.accessMode === undefined) {
          throw new RemoteAgentRepositoryError("remote_agent_access_mode_required");
        }
        if (
          !exists(
            this.database,
            "SELECT 1 FROM human_principals WHERE human_principal_id=?",
            ownerHumanPrincipalId
          )
        ) {
          throw new RemoteAgentRepositoryError("remote_agent_owner_not_found");
        }
        accessMode = parsed.accessMode;
        ownershipRepairRequired = 0;
      }
      this.database
        .prepare(
          `INSERT INTO remote_agents(
             endpoint_id, host_id, profile_id, agent_id, owner_human_principal_id,
             display_name, access_mode, policy_revision, ownership_repair_required,
             created_at, updated_at, revoked_at
           ) VALUES (?,?,?,?,?,?,?,1,?,?,?,NULL)`
        )
        .run(
          endpointId,
          parsed.hostId,
          parsed.profileId,
          parsed.agentId,
          ownerHumanPrincipalId,
          parsed.displayName,
          accessMode,
          ownershipRepairRequired,
          parsed.now,
          parsed.now
        );
      return requireAgent(
        this.database.prepare("SELECT * FROM remote_agents WHERE endpoint_id=?").get(endpointId)
      );
    });
  }

  repairOwnership(input: RepairRemoteAgentOwnershipInput): RemoteAgentRecord {
    const parsed = repairOwnershipInputSchema.parse(input);
    return inWriteTransaction(this.database, () => {
      const agent = requireAgent(
        this.database
          .prepare("SELECT * FROM remote_agents WHERE endpoint_id=?")
          .get(parsed.endpointId)
      );
      if (
        !exists(
          this.database,
          "SELECT 1 FROM human_principals WHERE human_principal_id=?",
          parsed.ownerHumanPrincipalId
        )
      ) {
        throw new RemoteAgentRepositoryError("remote_agent_owner_not_found");
      }
      const now = this.clock().toISOString();
      this.database
        .prepare(
          `UPDATE remote_agents
           SET owner_human_principal_id=?, ownership_repair_required=0,
               policy_revision=policy_revision+1, updated_at=?
           WHERE endpoint_id=?`
        )
        .run(parsed.ownerHumanPrincipalId, now, agent.endpointId);
      return requireAgent(
        this.database
          .prepare("SELECT * FROM remote_agents WHERE endpoint_id=?")
          .get(agent.endpointId)
      );
    });
  }

  setAccessMode(input: SetRemoteAgentAccessModeInput): RemoteAgentRecord {
    const parsed = setAccessModeInputSchema.parse(input);
    return inWriteTransaction(this.database, () => {
      const agent = requireAgent(
        this.database
          .prepare("SELECT * FROM remote_agents WHERE endpoint_id=?")
          .get(parsed.endpointId)
      );
      assertMutableAgent(agent);
      if (
        parsed.expectedPolicyRevision !== undefined &&
        parsed.expectedPolicyRevision !== agent.policyRevision
      ) {
        throw new RemoteAgentAuthorizationError("remote_agent_policy_revision_conflict");
      }
      const now = this.clock().toISOString();
      this.database
        .prepare(
          `UPDATE remote_agents
           SET access_mode=?, policy_revision=policy_revision+1, updated_at=?
           WHERE endpoint_id=?`
        )
        .run(parsed.accessMode, now, agent.endpointId);
      return requireAgent(
        this.database
          .prepare("SELECT * FROM remote_agents WHERE endpoint_id=?")
          .get(agent.endpointId)
      );
    });
  }

  revokeAgent(endpointId: string): RemoteAgentRecord {
    const parsed = opaqueIdentifierSchema.parse(endpointId);
    return inWriteTransaction(this.database, () => {
      const agent = requireAgent(
        this.database.prepare("SELECT * FROM remote_agents WHERE endpoint_id=?").get(parsed)
      );
      if (agent.revokedAt === null) {
        const now = this.clock().toISOString();
        this.database
          .prepare("UPDATE remote_agents SET revoked_at=?, updated_at=? WHERE endpoint_id=?")
          .run(now, now, agent.endpointId);
      }
      return requireAgent(
        this.database
          .prepare("SELECT * FROM remote_agents WHERE endpoint_id=?")
          .get(agent.endpointId)
      );
    });
  }

  grantWorkspace(input: GrantRemoteAgentWorkspaceInput): RemoteAgentWorkspaceGrantRecord {
    const parsed = grantWorkspaceInputSchema.parse(input);
    return inWriteTransaction(this.database, () => {
      const agent = requireAgent(
        this.database
          .prepare("SELECT * FROM remote_agents WHERE endpoint_id=?")
          .get(parsed.endpointId)
      );
      assertMutableAgent(agent);
      if (
        !exists(this.database, "SELECT 1 FROM workspaces WHERE workspace_id=?", parsed.workspaceId)
      ) {
        throw new RemoteAgentRepositoryError("remote_agent_workspace_not_found");
      }
      if (
        !exists(
          this.database,
          "SELECT 1 FROM human_principals WHERE human_principal_id=?",
          parsed.grantedByHumanPrincipalId
        )
      ) {
        throw new RemoteAgentRepositoryError("remote_agent_grantor_not_found");
      }
      const current = this.database
        .prepare(
          `SELECT * FROM remote_agent_workspace_grants
           WHERE endpoint_id=? AND workspace_id=?`
        )
        .get(agent.endpointId, parsed.workspaceId);
      if (parsed.expectedGrantRevision !== undefined) {
        const currentRevision = current ? Number(current.grant_revision) : undefined;
        if (currentRevision !== parsed.expectedGrantRevision) {
          throw new RemoteAgentAuthorizationError("remote_agent_grant_revision_conflict");
        }
      }
      const now = this.clock().toISOString();
      if (!current) {
        this.database
          .prepare(
            `INSERT INTO remote_agent_workspace_grants(
               endpoint_id, workspace_id, grant_revision, granted_by_human_principal_id,
               created_at, updated_at, revoked_at
             ) VALUES (?,?,1,?,?,?,NULL)`
          )
          .run(agent.endpointId, parsed.workspaceId, parsed.grantedByHumanPrincipalId, now, now);
      } else {
        this.database
          .prepare(
            `UPDATE remote_agent_workspace_grants
             SET grant_revision=grant_revision+1,
                 granted_by_human_principal_id=?,
                 updated_at=?,
                 revoked_at=NULL
             WHERE endpoint_id=? AND workspace_id=?`
          )
          .run(parsed.grantedByHumanPrincipalId, now, agent.endpointId, parsed.workspaceId);
      }
      return requireGrant(
        this.database
          .prepare(
            `SELECT * FROM remote_agent_workspace_grants
             WHERE endpoint_id=? AND workspace_id=?`
          )
          .get(agent.endpointId, parsed.workspaceId)
      );
    });
  }

  revokeGrant(input: RevokeRemoteAgentGrantInput): RemoteAgentWorkspaceGrantRecord {
    const parsed = revokeGrantInputSchema.parse(input);
    return inWriteTransaction(this.database, () => {
      const current = this.database
        .prepare(
          `SELECT * FROM remote_agent_workspace_grants
           WHERE endpoint_id=? AND workspace_id=?`
        )
        .get(parsed.endpointId, parsed.workspaceId);
      if (!current) {
        throw new RemoteAgentAuthorizationError("remote_agent_workspace_grant_missing");
      }
      const grant = mapGrantRow(current);
      if (grant.revokedAt === null) {
        const now = this.clock().toISOString();
        this.database
          .prepare(
            `UPDATE remote_agent_workspace_grants
             SET revoked_at=?, updated_at=?
             WHERE endpoint_id=? AND workspace_id=?`
          )
          .run(now, now, grant.endpointId, grant.workspaceId);
      }
      return requireGrant(
        this.database
          .prepare(
            `SELECT * FROM remote_agent_workspace_grants
             WHERE endpoint_id=? AND workspace_id=?`
          )
          .get(grant.endpointId, grant.workspaceId)
      );
    });
  }

  listGrants(endpointId: string): RemoteAgentWorkspaceGrantRecord[] {
    const parsed = opaqueIdentifierSchema.parse(endpointId);
    return this.database
      .prepare(
        `SELECT * FROM remote_agent_workspace_grants
         WHERE endpoint_id=?
         ORDER BY workspace_id`
      )
      .all(parsed)
      .map(mapGrantRow);
  }

  listActiveGrantsForWorkspace(workspaceId: string): RemoteAgentWorkspaceGrantRecord[] {
    const parsed = workspaceIdSchema.parse(workspaceId);
    return this.database
      .prepare(
        `SELECT * FROM remote_agent_workspace_grants
         WHERE workspace_id=? AND revoked_at IS NULL
         ORDER BY endpoint_id`
      )
      .all(parsed)
      .map(mapGrantRow);
  }
}
