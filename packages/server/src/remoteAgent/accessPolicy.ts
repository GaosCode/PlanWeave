import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { agentEndpointCapabilitiesSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  humanPrincipalIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import { AgentEndpointCatalog, type ResolvedAgentEndpoint } from "../agentEndpointCatalog.js";
import { activeWorkspacePrincipal } from "../projectRegistryRepository.js";
import type { SqliteDatabase } from "../sqlite.js";
import { controlPlaneForTarget } from "./dispatchTarget.js";
import { RemoteAgentAuthorizationError } from "./errors.js";
import { RemoteAgentRepository } from "./repository.js";
import {
  authorizedRemoteAgentUseSchema,
  remoteAgentUseTargetSchema,
  type AgentAccessAuthority,
  type AuthorizedRemoteAgentUse,
  type RemoteAgentRecord,
  type RemoteAgentUseTarget,
  type RemoteAgentWorkspaceGrantRecord,
  type RuntimeAuthority
} from "./schema.js";

const principalSchema = z.object({ humanPrincipalId: humanPrincipalIdSchema }).strict();

export const evaluateRemoteAgentAccessInputSchema = z
  .object({
    principal: principalSchema,
    endpointId: opaqueIdentifierSchema,
    target: remoteAgentUseTargetSchema
  })
  .strict();

export const authorizeRemoteAgentUseInputSchema = evaluateRemoteAgentAccessInputSchema
  .extend({
    requiredCapabilities: agentEndpointCapabilitiesSchema,
    runtimeWorkspaceId: workspaceIdSchema,
    blockRef: z.string().min(1),
    expectedResponsibilityRevision: z.number().int().nonnegative(),
    expectedReviewerRevision: z.number().int().nonnegative()
  })
  .strict();

export type EvaluateRemoteAgentAccessInput = z.input<typeof evaluateRemoteAgentAccessInputSchema>;
export type AuthorizeRemoteAgentUseInput = z.input<typeof authorizeRemoteAgentUseInputSchema>;

export type EvaluatedRemoteAgentAccess = {
  agent: RemoteAgentRecord;
  runtimeAuthority: RuntimeAuthority;
  agentAccessAuthority: AgentAccessAuthority;
};

export type AuthorizeRemoteAgentTargetPort = (input: {
  workspaceId: string;
  projectId: string;
  canvasId: string;
  blockRef: string;
  expectedResponsibilityRevision: number;
  expectedReviewerRevision: number;
  controlPlane: "collaboration" | "owner";
}) => void;

export type RemoteAgentAccessPolicyOptions = {
  database: SqliteDatabase;
  agents: RemoteAgentRepository;
  catalog: AgentEndpointCatalog;
  authorizeTarget: AuthorizeRemoteAgentTargetPort;
  clock?: () => Date;
};

function runtimeAuthorityFor(target: RemoteAgentUseTarget): RuntimeAuthority {
  return target.kind === "owner_canvas"
    ? { kind: "owner_canvas" }
    : { kind: "workspace_canvas", workspaceId: target.workspaceId };
}

function mappingWorkspaceId(target: RemoteAgentUseTarget, runtimeWorkspaceId: string): string {
  return target.kind === "workspace_canvas" ? target.workspaceId : runtimeWorkspaceId;
}

export class RemoteAgentAccessPolicy {
  private readonly clock: () => Date;

  constructor(private readonly options: RemoteAgentAccessPolicyOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  evaluateAccess(rawInput: EvaluateRemoteAgentAccessInput): EvaluatedRemoteAgentAccess {
    const input = evaluateRemoteAgentAccessInputSchema.parse(rawInput);
    this.requireHumanPrincipal(input.principal.humanPrincipalId);
    this.requireActiveTarget(input.target);
    const agent = this.requirePersistedAgent(input.endpointId);
    if (agent.revokedAt !== null) {
      throw new RemoteAgentAuthorizationError("remote_agent_revoked");
    }
    if (agent.ownershipRepairRequired) {
      throw new RemoteAgentAuthorizationError("remote_agent_ownership_repair_required");
    }
    const runtimeAuthority = runtimeAuthorityFor(input.target);
    return {
      agent,
      runtimeAuthority,
      agentAccessAuthority: this.agentAccessAuthority(
        agent,
        input.principal.humanPrincipalId,
        input.target
      )
    };
  }

  authorizeRemoteAgentUse(rawInput: AuthorizeRemoteAgentUseInput): AuthorizedRemoteAgentUse {
    const input = authorizeRemoteAgentUseInputSchema.parse(rawInput);
    const access = this.evaluateAccess({
      principal: input.principal,
      endpointId: input.endpointId,
      target: input.target
    });
    this.options.authorizeTarget({
      workspaceId: input.runtimeWorkspaceId,
      projectId: input.target.projectId,
      canvasId: input.target.canvasId,
      blockRef: input.blockRef,
      expectedResponsibilityRevision: input.expectedResponsibilityRevision,
      expectedReviewerRevision: input.expectedReviewerRevision,
      controlPlane: controlPlaneForTarget(input.target)
    });
    const resolved = this.resolveAvailability(input, access.agent);
    return authorizedRemoteAgentUseSchema.parse({
      remoteAgent: {
        endpointId: resolved.endpointId,
        hostId: resolved.hostId,
        profileId: resolved.profileId,
        agentId: resolved.agentId
      },
      runtimeAuthority: access.runtimeAuthority,
      agentAccessAuthority: access.agentAccessAuthority,
      resolvedAt: resolved.resolvedAt
    });
  }

  private requireHumanPrincipal(humanPrincipalId: string): void {
    const found = this.options.database
      .prepare("SELECT 1 FROM human_principals WHERE human_principal_id=?")
      .get(humanPrincipalId);
    if (!found) throw new RemoteAgentAuthorizationError("remote_agent_not_found");
  }

  private requireActiveTarget(target: RemoteAgentUseTarget): void {
    if (target.kind !== "workspace_canvas") return;
    const row = this.options.database
      .prepare("SELECT archived_at FROM workspaces WHERE workspace_id=?")
      .get(target.workspaceId) as { archived_at: string | null } | undefined;
    if (!row || row.archived_at !== null) {
      throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    }
  }

  private requirePersistedAgent(endpointId: string): RemoteAgentRecord {
    const agent = this.options.agents.getByEndpointId(endpointId);
    if (!agent) throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    return agent;
  }

  private agentAccessAuthority(
    agent: RemoteAgentRecord,
    humanPrincipalId: string,
    target: RemoteAgentUseTarget
  ): AgentAccessAuthority {
    const isOwner = agent.ownerHumanPrincipalId === humanPrincipalId;
    if (isOwner) {
      return this.ownerAccessAuthority(agent, target);
    }
    if (target.kind === "owner_canvas") {
      throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    }
    const isMember = activeWorkspacePrincipal(
      this.options.database,
      target.workspaceId,
      humanPrincipalId
    );
    if (!isMember) throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    const grant = this.activeGrant(agent.endpointId, target.workspaceId);
    if (!grant) {
      throw new RemoteAgentAuthorizationError("remote_agent_workspace_grant_missing");
    }
    return {
      kind: "workspace_grant",
      workspaceId: target.workspaceId,
      grantRevision: grant.grantRevision,
      policyRevision: agent.policyRevision
    };
  }

  private ownerAccessAuthority(
    agent: RemoteAgentRecord,
    target: RemoteAgentUseTarget
  ): AgentAccessAuthority {
    if (!agent.ownerHumanPrincipalId) {
      throw new RemoteAgentAuthorizationError("remote_agent_ownership_repair_required");
    }
    const ownerAuthority: AgentAccessAuthority = {
      kind: "agent_owner",
      ownerHumanPrincipalId: agent.ownerHumanPrincipalId,
      policyRevision: agent.policyRevision
    };
    if (agent.accessMode === "unrestricted") return ownerAuthority;
    if (target.kind === "owner_canvas") {
      throw new RemoteAgentAuthorizationError("remote_agent_workspace_scope_forbidden");
    }
    const grant = this.activeGrant(agent.endpointId, target.workspaceId);
    if (!grant) {
      throw new RemoteAgentAuthorizationError("remote_agent_workspace_scope_forbidden");
    }
    return {
      ...ownerAuthority,
      workspaceId: target.workspaceId,
      grantRevision: grant.grantRevision
    };
  }

  private activeGrant(
    endpointId: string,
    workspaceId: string
  ): RemoteAgentWorkspaceGrantRecord | undefined {
    return this.options.agents
      .listGrants(endpointId)
      .find((grant) => grant.workspaceId === workspaceId && grant.revokedAt === null);
  }

  private resolveAvailability(
    input: z.infer<typeof authorizeRemoteAgentUseInputSchema>,
    agent: RemoteAgentRecord
  ): ResolvedAgentEndpoint {
    const resolved = this.options.catalog.resolveForRun(
      input.endpointId,
      mappingWorkspaceId(input.target, input.runtimeWorkspaceId),
      input.requiredCapabilities,
      input.target.kind
    );
    if (
      resolved.endpointId !== agent.endpointId ||
      resolved.hostId !== agent.hostId ||
      resolved.profileId !== agent.profileId ||
      resolved.agentId !== agent.agentId
    ) {
      throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    }
    return resolved;
  }
}
