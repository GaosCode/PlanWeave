import { writeHostRemoteAgentDefaults } from "../../remoteAgent/hostDefaults.js";
import type { RemoteAgentAccessMode } from "../../remoteAgent/schema.js";
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
