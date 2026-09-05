import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeAcpConversation } from "../acpConversationAuthorization.js";
import { AgentEndpointCatalog, endpointIdFor } from "../agentEndpointCatalog.js";
import { AgentHostRepository } from "../hosts.js";
import { RemoteAgentAccessPolicy } from "../remoteAgent/accessPolicy.js";
import { RemoteAgentRepository } from "../remoteAgent/repository.js";
import type { RemoteOperation } from "../remoteOperations.js";
import { createRemoteAcpEventV2Fixture } from "./support/remoteAcpEventV2Fixture.js";
import {
  ensureTestHumanPrincipal,
  ownHostRemoteAgents,
  persistedTestAgentAccess
} from "./support/remoteAgentOwnerFixture.js";

const fixtures: Awaited<ReturnType<typeof createRemoteAcpEventV2Fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

async function setup() {
  const f = await createRemoteAcpEventV2Fixture();
  fixtures.push(f);
  const database = f.server.database;
  const owner = ownHostRemoteAgents({
    database,
    hostId: f.host.id,
    accessMode: "workspace_restricted",
    grantWorkspaceId: f.operation.workspaceId
  });
  const agents = new RemoteAgentRepository(database, f.clock);
  const endpointId = endpointIdFor({ hostId: f.host.id, profileId: "codex-acp", agentId: "codex" });
  agents.registerOrRestoreFromProfile({
    hostId: f.host.id,
    profileId: "codex-acp",
    agentId: "codex",
    displayName: "Codex",
    now: f.clock().toISOString(),
    ownerHumanPrincipalId: owner,
    accessMode: "workspace_restricted"
  });
  agents.grantWorkspace({
    endpointId,
    workspaceId: f.operation.workspaceId,
    grantedByHumanPrincipalId: owner
  });
  const agentAccess = persistedTestAgentAccess({
    database,
    hostId: f.host.id,
    workspaceId: f.operation.workspaceId,
    callerHumanPrincipalId: owner
  });
  const original = agentAccess.authorized.remoteAgent;
  const operation: RemoteOperation = {
    ...f.operation,
    state: "completed",
    agentAccess,
    endpointSelection: {
      ...original,
      schemaVersion: "endpoint-selection/v1",
      displayName: "Codex",
      hostDisplayName: "Host",
      capabilities: ["acp.codex"],
      resolvedAt: f.clock().toISOString(),
      authority: {
        schemaVersion: "endpoint-authority/v2",
        kind: "workspace_canvas",
        workspaceId: f.operation.workspaceId,
        responsibilityRevision: 0,
        reviewerRevision: 0
      }
    }
  };
  const authorizeTarget = vi.fn(() => {
    throw new Error("block_revision_changed");
  });
  const policy = new RemoteAgentAccessPolicy({
    database,
    agents,
    clock: f.clock,
    authorizeTarget,
    catalog: new AgentEndpointCatalog({
      hosts: new AgentHostRepository(database, f.clock),
      capacities: { activeCountsForHosts: () => new Map() },
      hostOfflineAfterMs: 60_000
    })
  });
  return { ...f, database, operation, owner, agents, policy, authorizeTarget, original };
}

describe("remote ACP session authorization", () => {
  it("uses current Agent access for a historical session without reauthorizing its Block revisions", async () => {
    const f = await setup();
    expect(() => authorizeAcpConversation(f.operation, f.owner, f.policy)).not.toThrow();
    expect(f.authorizeTarget).not.toHaveBeenCalled();
    expect(f.operation.endpointSelection?.authority.executionTargetRevision).toBeUndefined();
    expect(f.operation.state).toBe("completed");
  });

  it("rejects a revoked grant and a revoked Agent even for the original caller", async () => {
    const f = await setup();
    f.agents.revokeGrant({
      endpointId: f.original.endpointId,
      workspaceId: f.operation.workspaceId
    });
    expect(() => authorizeAcpConversation(f.operation, f.owner, f.policy)).toThrow(
      "remote_agent_workspace_scope_forbidden"
    );
    f.agents.revokeAgent(f.original.endpointId);
    expect(() => authorizeAcpConversation(f.operation, f.owner, f.policy)).toThrow(
      "remote_agent_revoked"
    );
  });

  it("reauthorizes the current caller instead of trusting the saved caller", async () => {
    const f = await setup();
    const stranger = ensureTestHumanPrincipal(f.database, "stranger");
    expect(() => authorizeAcpConversation(f.operation, stranger, f.policy)).toThrow(
      "remote_agent_not_found"
    );
  });

  it("rejects changing the original Host, profile, endpoint, or workspace", async () => {
    const f = await setup();
    for (const operation of [
      { ...f.operation, attempt: { ...f.operation.attempt, hostId: "another-host" } },
      {
        ...f.operation,
        endpointSelection: { ...f.operation.endpointSelection!, profileId: "other-profile" }
      },
      {
        ...f.operation,
        endpointSelection: { ...f.operation.endpointSelection!, endpointId: "other-endpoint" }
      },
      { ...f.operation, workspaceId: "another-workspace" }
    ]) {
      expect(() => authorizeAcpConversation(operation, f.owner, f.policy)).toThrow(
        "identity_mismatch"
      );
    }
  });
});
