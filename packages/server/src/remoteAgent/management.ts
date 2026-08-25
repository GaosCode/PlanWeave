import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  humanPrincipalIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import { RemoteAgentAuthorizationError } from "./errors.js";
import {
  toRemoteAgentManagementAgentView,
  type RemoteAgentManagementAgentView
} from "./managementDtos.js";
import { HumanPrincipalIdentity } from "../identity/humanPrincipalIdentity.js";
import { RemoteAgentRepository } from "./repository.js";
import {
  remoteAgentAccessModeSchema,
  remoteAgentGrantRevisionSchema,
  remoteAgentPolicyRevisionSchema,
  type RemoteAgentRecord,
  type RemoteAgentWorkspaceGrantRecord
} from "./schema.js";

const getInputSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    actorHumanPrincipalId: humanPrincipalIdSchema.optional()
  })
  .strict();

const repairOwnershipInputSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    ownerHumanPrincipalId: humanPrincipalIdSchema
  })
  .strict();

const actorEndpointInputSchema = z
  .object({
    endpointId: opaqueIdentifierSchema,
    actorHumanPrincipalId: humanPrincipalIdSchema
  })
  .strict();

const setAccessModeInputSchema = actorEndpointInputSchema
  .extend({
    accessMode: remoteAgentAccessModeSchema,
    expectedPolicyRevision: remoteAgentPolicyRevisionSchema.optional()
  })
  .strict();

const grantWorkspaceInputSchema = actorEndpointInputSchema
  .extend({
    workspaceId: workspaceIdSchema,
    expectedGrantRevision: remoteAgentGrantRevisionSchema.optional()
  })
  .strict();

const revokeGrantInputSchema = actorEndpointInputSchema
  .extend({
    workspaceId: workspaceIdSchema
  })
  .strict();

export type RemoteAgentManagementGetInput = z.input<typeof getInputSchema>;
export type RemoteAgentManagementRepairOwnershipInput = z.input<typeof repairOwnershipInputSchema>;
export type RemoteAgentManagementSetAccessModeInput = z.input<typeof setAccessModeInputSchema>;
export type RemoteAgentManagementGrantWorkspaceInput = z.input<typeof grantWorkspaceInputSchema>;
export type RemoteAgentManagementRevokeGrantInput = z.input<typeof revokeGrantInputSchema>;
export type RemoteAgentManagementRevokeAgentInput = z.input<typeof actorEndpointInputSchema>;

export class RemoteAgentManagementService {
  constructor(
    private readonly repository: RemoteAgentRepository,
    private readonly identity: HumanPrincipalIdentity
  ) {}

  listOwned(ownerHumanPrincipalId: string): RemoteAgentRecord[] {
    const actor = humanPrincipalIdSchema.parse(ownerHumanPrincipalId);
    const owned = this.repository.listByOwnerHumanPrincipalIds(this.identity.equivalentIds(actor));
    const seen = new Set<string>();
    return owned.filter((agent) => {
      if (seen.has(agent.endpointId)) return false;
      seen.add(agent.endpointId);
      return true;
    });
  }

  listOwnershipRepairRequired(): RemoteAgentRecord[] {
    return this.repository.listOwnershipRepairRequired();
  }

  /** Owner agents plus repair-required rows. Grants are active-only. */
  listManaged(ownerHumanPrincipalId: string): RemoteAgentManagementAgentView[] {
    const owned = this.listOwned(ownerHumanPrincipalId);
    const seen = new Set(owned.map((agent) => agent.endpointId));
    const agents = [...owned];
    for (const agent of this.listOwnershipRepairRequired()) {
      if (seen.has(agent.endpointId)) continue;
      seen.add(agent.endpointId);
      agents.push(agent);
    }
    return agents.map((agent) =>
      toRemoteAgentManagementAgentView(agent, this.repository.listGrants(agent.endpointId))
    );
  }

  get(input: RemoteAgentManagementGetInput): RemoteAgentRecord {
    const parsed = getInputSchema.parse(input);
    const agent = this.requireExisting(parsed.endpointId);
    if (agent.ownershipRepairRequired) return agent;
    if (
      parsed.actorHumanPrincipalId === undefined ||
      !this.identity.areEquivalent(agent.ownerHumanPrincipalId, parsed.actorHumanPrincipalId)
    ) {
      throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    }
    return agent;
  }

  repairOwnership(input: RemoteAgentManagementRepairOwnershipInput): RemoteAgentRecord {
    const parsed = repairOwnershipInputSchema.parse(input);
    const agent = this.requireExisting(parsed.endpointId);
    if (!agent.ownershipRepairRequired) {
      throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    }
    return this.repository.repairOwnership({
      endpointId: parsed.endpointId,
      ownerHumanPrincipalId: parsed.ownerHumanPrincipalId
    });
  }

  setAccessMode(input: RemoteAgentManagementSetAccessModeInput): RemoteAgentRecord {
    const parsed = setAccessModeInputSchema.parse(input);
    this.requireOwnedMutable(parsed.endpointId, parsed.actorHumanPrincipalId);
    return this.repository.setAccessMode({
      endpointId: parsed.endpointId,
      accessMode: parsed.accessMode,
      ...(parsed.expectedPolicyRevision === undefined
        ? {}
        : { expectedPolicyRevision: parsed.expectedPolicyRevision })
    });
  }

  grantWorkspace(input: RemoteAgentManagementGrantWorkspaceInput): RemoteAgentWorkspaceGrantRecord {
    const parsed = grantWorkspaceInputSchema.parse(input);
    this.requireOwnedMutable(parsed.endpointId, parsed.actorHumanPrincipalId);
    return this.repository.grantWorkspace({
      endpointId: parsed.endpointId,
      workspaceId: parsed.workspaceId,
      grantedByHumanPrincipalId: parsed.actorHumanPrincipalId,
      ...(parsed.expectedGrantRevision === undefined
        ? {}
        : { expectedGrantRevision: parsed.expectedGrantRevision })
    });
  }

  revokeGrant(input: RemoteAgentManagementRevokeGrantInput): RemoteAgentWorkspaceGrantRecord {
    const parsed = revokeGrantInputSchema.parse(input);
    this.requireOwnedMutable(parsed.endpointId, parsed.actorHumanPrincipalId);
    return this.repository.revokeGrant({
      endpointId: parsed.endpointId,
      workspaceId: parsed.workspaceId
    });
  }

  revokeAgent(input: RemoteAgentManagementRevokeAgentInput): RemoteAgentRecord {
    const parsed = actorEndpointInputSchema.parse(input);
    this.requireOwnedMutable(parsed.endpointId, parsed.actorHumanPrincipalId);
    return this.repository.revokeAgent(parsed.endpointId);
  }

  private requireExisting(endpointId: string): RemoteAgentRecord {
    const agent = this.repository.getByEndpointId(endpointId);
    if (!agent) throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    return agent;
  }

  private requireOwnedMutable(
    endpointId: string,
    actorHumanPrincipalId: string
  ): RemoteAgentRecord {
    const agent = this.requireExisting(endpointId);
    if (agent.ownershipRepairRequired) {
      throw new RemoteAgentAuthorizationError("remote_agent_owner_required");
    }
    if (!this.identity.areEquivalent(agent.ownerHumanPrincipalId, actorHumanPrincipalId)) {
      throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    }
    return agent;
  }
}
