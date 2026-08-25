import { writeHostRemoteAgentDefaults } from "../../remoteAgent/hostDefaults.js";
import {
  persistedRemoteAgentAccessSnapshotSchema,
  type PersistedRemoteAgentAccessSnapshot,
  type RemoteAgentAccessMode
} from "../../remoteAgent/schema.js";
import type { SqliteDatabase } from "../../sqlite.js";

export const TEST_REMOTE_AGENT_OWNER_ID = "test-remote-agent-owner";

export function ensureTestHumanPrincipal(
  database: SqliteDatabase,
  humanPrincipalId = TEST_REMOTE_AGENT_OWNER_ID,
  displayName = "Test Remote Agent Owner"
): string {
  const existing = database
    .prepare("SELECT 1 FROM human_principals WHERE human_principal_id=?")
    .get(humanPrincipalId);
  if (!existing) {
    database
      .prepare(
        "INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES(?,?,?)"
      )
      .run(humanPrincipalId, displayName, new Date().toISOString());
  }
  return humanPrincipalId;
}

export function ownHostRemoteAgents(input: {
  database: SqliteDatabase;
  hostId: string;
  ownerHumanPrincipalId?: string;
  accessMode?: RemoteAgentAccessMode;
  grantWorkspaceId?: string | null;
}): string {
  const ownerHumanPrincipalId = ensureTestHumanPrincipal(
    input.database,
    input.ownerHumanPrincipalId ?? TEST_REMOTE_AGENT_OWNER_ID
  );
  const grantWorkspaceId = input.grantWorkspaceId ?? null;
  writeHostRemoteAgentDefaults(input.database, {
    hostId: input.hostId,
    ownerHumanPrincipalId,
    accessMode: input.accessMode ?? "unrestricted",
    createWorkspaceGrant: grantWorkspaceId !== null,
    grantWorkspaceId,
    updatedAt: new Date().toISOString()
  });
  return ownerHumanPrincipalId;
}

export function persistedTestAgentAccess(input: {
  database: SqliteDatabase;
  hostId: string;
  workspaceId: string;
  callerHumanPrincipalId: string;
}): PersistedRemoteAgentAccessSnapshot {
  const agent = input.database
    .prepare(
      `SELECT endpoint_id, host_id, profile_id, agent_id, owner_human_principal_id, policy_revision, access_mode
       FROM remote_agents WHERE host_id=? AND revoked_at IS NULL ORDER BY endpoint_id LIMIT 1`
    )
    .get(input.hostId) as
    | {
        endpoint_id: string;
        host_id: string;
        profile_id: string;
        agent_id: string;
        owner_human_principal_id: string | null;
        policy_revision: number;
        access_mode: string;
      }
    | undefined;
  if (!agent || !agent.owner_human_principal_id) {
    throw new Error("expected_owned_test_remote_agent");
  }
  const grant = input.database
    .prepare(
      `SELECT grant_revision FROM remote_agent_workspace_grants
       WHERE endpoint_id=? AND workspace_id=? AND revoked_at IS NULL`
    )
    .get(agent.endpoint_id, input.workspaceId) as { grant_revision: number } | undefined;
  return persistedRemoteAgentAccessSnapshotSchema.parse({
    callerHumanPrincipalId: input.callerHumanPrincipalId,
    authorized: {
      remoteAgent: {
        endpointId: agent.endpoint_id,
        hostId: agent.host_id,
        profileId: agent.profile_id,
        agentId: agent.agent_id
      },
      runtimeAuthority: { kind: "workspace_canvas", workspaceId: input.workspaceId },
      agentAccessAuthority: {
        kind: "agent_owner",
        ownerHumanPrincipalId: agent.owner_human_principal_id,
        policyRevision: agent.policy_revision,
        ...(agent.access_mode === "workspace_restricted" && grant
          ? { workspaceId: input.workspaceId, grantRevision: grant.grant_revision }
          : {})
      },
      resolvedAt: new Date().toISOString()
    }
  });
}
