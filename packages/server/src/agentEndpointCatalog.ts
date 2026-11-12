import {
  agentEndpointCapabilitiesSchema,
  assertRemoteAgentEndpointRedacted,
  remoteAgentEndpointListSchema,
  remoteAgentEndpointSchema,
  type AgentEndpointErrorCode,
  type AgentEndpointUnavailableReason,
  type RemoteAgentEndpoint,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  CANVAS_RUNTIME_EXECUTION_CAPABILITY,
  ACP_TASK_RESTORE_CAPABILITY,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol";
import { createHash } from "node:crypto";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { EndpointAvailabilityPolicy } from "./remoteAgent/dispatchTarget.js";
import {
  endpointMappingScope,
  endpointOccupiesHostCapacity
} from "./remoteAgent/dispatchTarget.js";
import type { AgentHost } from "./hosts.js";

/**
 * Server-scoped Host fleet inventory for Agent Endpoint catalog projection.
 * Exclusive workspace bindings are not an Agent grant or execution-catalog filter.
 */
export interface AgentEndpointHostPort {
  listActiveHosts(limit: number, offset: number): AgentHost[];
}

export interface AgentEndpointHostReader {
  get(hostId: string): AgentHost | undefined;
}

export type EndpointIdentity = Pick<
  ResolvedAgentEndpoint,
  "endpointId" | "hostId" | "profileId" | "agentId"
>;

export interface EndpointIdentityReader {
  getByEndpointId(endpointId: string): EndpointIdentity | undefined;
}

/** Runtime availability overlay. Not an Agent class or grant switch. */
export type AgentEndpointRuntimeScope = "owner_canvas" | "workspace_canvas";

export interface AgentEndpointCapacityPort {
  activeCountsForHosts(hostIds: readonly string[]): ReadonlyMap<string, number>;
}

export type ResolvedAgentEndpoint = {
  endpointId: string;
  hostId: string;
  profileId: string;
  agentId: string;
  displayName: string;
  hostDisplayName: string;
  capabilities: string[];
  resolvedAt: string;
};

type CatalogErrorCode = Extract<
  AgentEndpointErrorCode,
  "agent_endpoint_unknown" | "agent_endpoint_unavailable" | "agent_endpoint_incompatible"
>;

export class AgentEndpointCatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    readonly unavailableReason?: AgentEndpointUnavailableReason
  ) {
    super(code);
    this.name = "AgentEndpointCatalogError";
  }
}

export function agentEndpointCatalogErrorCode(error: unknown): CatalogErrorCode | undefined {
  return error instanceof AgentEndpointCatalogError ? error.code : undefined;
}

export type AgentEndpointCatalogOptions = {
  hosts: AgentEndpointHostPort;
  hostReader: AgentEndpointHostReader;
  identities: EndpointIdentityReader;
  capacities: AgentEndpointCapacityPort;
  hostOfflineAfterMs: number;
  clock?: () => Date;
};

type InternalCandidate = {
  endpointId: string;
  host: AgentHost;
  profile: NonNullable<AgentHost["readinessObservation"]>["acpProfiles"][number];
  duplicateProfile: boolean;
};

function supportsRequiredCapability(candidate: InternalCandidate, capability: string): boolean {
  if (!candidate.host.capabilities.includes(capability)) return false;
  return (
    capability === CANVAS_RUNTIME_EXECUTION_CAPABILITY ||
    capability === ACP_TASK_RESTORE_CAPABILITY ||
    candidate.profile.capabilities.includes(capability)
  );
}

const ACTIVE_HOST_PAGE_SIZE = 100;
const MAX_ACTIVE_HOSTS_PER_SNAPSHOT = 12_800;
const MAX_ENDPOINTS_PER_SNAPSHOT = 12_800;

function hashEndpointId(parts: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts), "utf8").digest("base64url");
  return opaqueIdentifierSchema.parse(`aep_${digest}`);
}

/** Server-scoped stable endpoint identity (Phase B). */
export function endpointIdFor(input: {
  hostId: string;
  profileId: string;
  agentId: string;
}): string {
  return hashEndpointId([input.hostId, input.profileId, input.agentId]);
}

/** Retired workspace-scoped endpoint identity. Not used for dispatch resolve. */
export function legacyEndpointIdFor(input: {
  workspaceId: string;
  hostId: string;
  profileId: string;
  agentId: string;
}): string {
  return hashEndpointId([input.workspaceId, input.hostId, input.profileId, input.agentId]);
}

function unavailableReason(
  host: AgentHost,
  profile: InternalCandidate["profile"],
  activeReservations: number,
  now: Date,
  hostOfflineAfterMs: number,
  duplicateProfile: boolean,
  enforceCapacity: boolean,
  requireWorkspaceCanvasExecution: boolean
): AgentEndpointUnavailableReason | undefined {
  if (host.revokedAt !== undefined) return "host_revoked";
  const credentialExpiry =
    host.credentialExpiresAt === undefined ? undefined : Date.parse(host.credentialExpiresAt);
  if (
    credentialExpiry !== undefined &&
    (!Number.isFinite(credentialExpiry) || credentialExpiry <= now.getTime())
  ) {
    return "host_credential_expired";
  }
  const lastSeenAt = host.lastSeenAt === undefined ? undefined : Date.parse(host.lastSeenAt);
  if (
    lastSeenAt === undefined ||
    !Number.isFinite(lastSeenAt) ||
    lastSeenAt < now.getTime() - hostOfflineAfterMs
  ) {
    return "host_offline";
  }
  if (duplicateProfile || profile.status === "invalid") return "profile_invalid";
  if (profile.status === "missing") return "profile_missing";
  if (!profile.capabilities.every((capability) => host.capabilities.includes(capability))) {
    return "profile_invalid";
  }
  if (
    requireWorkspaceCanvasExecution &&
    !host.capabilities.includes(CANVAS_RUNTIME_EXECUTION_CAPABILITY)
  ) {
    return "host_capability_missing";
  }
  if (enforceCapacity && activeReservations >= host.capacity) return "at_capacity";
  return undefined;
}

export class AgentEndpointCatalog {
  private readonly clock: () => Date;

  constructor(private readonly options: AgentEndpointCatalogOptions) {
    if (!Number.isInteger(options.hostOfflineAfterMs) || options.hostOfflineAfterMs < 1_000) {
      throw new Error("host_offline_after_invalid");
    }
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Project Host availability from the closed capacity policy.
   * `workspaceId` is required when policy.kind is `workspace`.
   * Workspace mapping is not an Agent grant or execution-catalog filter.
   */
  listProjected(
    policy: EndpointAvailabilityPolicy,
    workspaceIdInput?: string
  ): RemoteAgentEndpointList {
    const mappingScope = endpointMappingScope(policy);
    const occupyHostCapacity = endpointOccupiesHostCapacity(policy);
    if (mappingScope === "workspace_canvas") {
      if (workspaceIdInput === undefined) {
        throw new Error("agent_endpoint_workspace_required");
      }
      workspaceIdSchema.parse(workspaceIdInput);
    } else if (workspaceIdInput !== undefined) {
      workspaceIdSchema.parse(workspaceIdInput);
    }
    const items = this.projectFleet(occupyHostCapacity, policy.kind !== "owner_fleet");
    return remoteAgentEndpointListSchema.parse({
      schemaVersion: "agent-endpoint-list/v1",
      items
    });
  }

  /**
   * Server-scoped fleet catalog for owner-canvas availability.
   * Hosts remain visible when workspace mappings are absent; Host capacity does not apply.
   */
  listVisibleFleet(): RemoteAgentEndpointList {
    return this.listProjected({ kind: "owner_fleet" });
  }

  /**
   * Workspace-canvas availability overlay of the fleet.
   * Collaboration Host capacity applies; exclusive bind and workspace mapping
   * are not Agent grant or execution-catalog filters.
   */
  listVisible(workspaceIdInput: string): RemoteAgentEndpointList {
    return this.listProjected({ kind: "workspace" }, workspaceIdInput);
  }

  resolveForRun(
    endpointIdInput: string,
    workspaceIdInput: string,
    requiredCapabilitiesInput: readonly string[],
    policy: EndpointAvailabilityPolicy
  ): ResolvedAgentEndpoint {
    const endpointId = opaqueIdentifierSchema.parse(endpointIdInput);
    workspaceIdSchema.parse(workspaceIdInput);
    const requiredCapabilities = agentEndpointCapabilitiesSchema.parse(requiredCapabilitiesInput);
    const candidate = this.findCandidateForResolve(endpointId);
    if (!candidate) throw new AgentEndpointCatalogError("agent_endpoint_unknown");
    if (
      this.unavailableReasonForResolve(candidate, policy, endpointOccupiesHostCapacity(policy)) !==
      undefined
    ) {
      throw new AgentEndpointCatalogError("agent_endpoint_unavailable");
    }
    if (
      !requiredCapabilities.every((capability) => supportsRequiredCapability(candidate, capability))
    ) {
      throw new AgentEndpointCatalogError("agent_endpoint_incompatible");
    }
    return this.toResolved(candidate);
  }

  resolveForSnapshot(
    endpointIdInput: string,
    workspaceIdInput: string,
    requiredCapabilitiesInput: readonly string[]
  ): ResolvedAgentEndpoint {
    const endpointId = opaqueIdentifierSchema.parse(endpointIdInput);
    workspaceIdSchema.parse(workspaceIdInput);
    const requiredCapabilities = agentEndpointCapabilitiesSchema.parse(requiredCapabilitiesInput);
    const candidate = this.findCandidateForResolve(endpointId);
    if (!candidate) throw new AgentEndpointCatalogError("agent_endpoint_unknown");
    if (
      !requiredCapabilities.every((capability) => supportsRequiredCapability(candidate, capability))
    ) {
      throw new AgentEndpointCatalogError("agent_endpoint_incompatible");
    }
    return this.toResolved(candidate);
  }

  resolveForReservedRun(
    endpointIdInput: string,
    workspaceIdInput: string,
    requiredCapabilitiesInput: readonly string[],
    expectedHostIdInput: string,
    policy: EndpointAvailabilityPolicy
  ): ResolvedAgentEndpoint {
    const endpointId = opaqueIdentifierSchema.parse(endpointIdInput);
    workspaceIdSchema.parse(workspaceIdInput);
    const expectedHostId = opaqueIdentifierSchema.parse(expectedHostIdInput);
    const requiredCapabilities = agentEndpointCapabilitiesSchema.parse(requiredCapabilitiesInput);
    const candidate = this.findCandidateForResolve(endpointId, expectedHostId);
    if (!candidate) {
      throw new AgentEndpointCatalogError("agent_endpoint_unknown");
    }
    const unavailable = this.unavailableReasonForResolve(candidate, policy, false);
    if (unavailable !== undefined) {
      throw new AgentEndpointCatalogError("agent_endpoint_unavailable", unavailable);
    }
    if (
      !requiredCapabilities.every((capability) => supportsRequiredCapability(candidate, capability))
    ) {
      throw new AgentEndpointCatalogError("agent_endpoint_incompatible");
    }
    return this.toResolved(candidate);
  }

  private unavailableReasonForResolve(
    candidate: InternalCandidate,
    policy: EndpointAvailabilityPolicy,
    enforceCapacity: boolean
  ): AgentEndpointUnavailableReason | undefined {
    const activeReservations = enforceCapacity
      ? (this.options.capacities.activeCountsForHosts([candidate.host.id]).get(candidate.host.id) ??
        0)
      : 0;
    return unavailableReason(
      candidate.host,
      candidate.profile,
      activeReservations,
      this.clock(),
      this.options.hostOfflineAfterMs,
      candidate.duplicateProfile,
      enforceCapacity,
      policy.kind !== "owner_fleet"
    );
  }

  private findCandidateForResolve(
    endpointId: string,
    expectedHostId?: string
  ): InternalCandidate | undefined {
    const identity = this.options.identities.getByEndpointId(endpointId);
    if (
      !identity ||
      identity.endpointId !== endpointId ||
      endpointIdFor(identity) !== endpointId ||
      (expectedHostId !== undefined && identity.hostId !== expectedHostId)
    ) {
      return undefined;
    }
    const host = this.options.hostReader.get(identity.hostId);
    if (!host || host.id !== identity.hostId) return undefined;
    if (!host.readinessObservation) {
      if (expectedHostId !== undefined) {
        throw new AgentEndpointCatalogError("agent_endpoint_unknown", "host_offline");
      }
      return undefined;
    }

    let profile: InternalCandidate["profile"] | undefined;
    for (const observed of host.readinessObservation.acpProfiles) {
      if (observed.profileId !== identity.profileId || observed.agentId !== identity.agentId)
        continue;
      if (profile) return { endpointId, host, profile, duplicateProfile: true };
      profile = observed;
    }
    return profile ? { endpointId, host, profile, duplicateProfile: false } : undefined;
  }

  private toResolved(candidate: InternalCandidate): ResolvedAgentEndpoint {
    return {
      endpointId: candidate.endpointId,
      hostId: candidate.host.id,
      profileId: candidate.profile.profileId,
      agentId: candidate.profile.agentId,
      displayName: candidate.profile.displayName,
      hostDisplayName: candidate.host.displayName,
      capabilities: [...candidate.profile.capabilities],
      resolvedAt: this.clock().toISOString()
    };
  }

  private projectFleet(
    enforceCapacity: boolean,
    requireWorkspaceCanvasExecution: boolean
  ): RemoteAgentEndpoint[] {
    const hosts = this.listAllActiveHosts();
    const activeCounts = this.options.capacities.activeCountsForHosts(hosts.map((host) => host.id));
    const now = this.clock();
    const items: RemoteAgentEndpoint[] = [];
    for (const host of hosts) {
      const profiles = host.readinessObservation?.acpProfiles ?? [];
      const identityCounts = new Map<string, number>();
      for (const profile of profiles) {
        const identity = `${profile.profileId}\u0000${profile.agentId}`;
        identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
      }
      const emitted = new Set<string>();
      for (const profile of profiles) {
        const identity = `${profile.profileId}\u0000${profile.agentId}`;
        if (emitted.has(identity)) continue;
        emitted.add(identity);
        const reason = unavailableReason(
          host,
          profile,
          activeCounts.get(host.id) ?? 0,
          now,
          this.options.hostOfflineAfterMs,
          identityCounts.get(identity) !== 1,
          enforceCapacity,
          requireWorkspaceCanvasExecution
        );
        const endpoint = remoteAgentEndpointSchema.parse({
          schemaVersion: "agent-endpoint/v1",
          endpointId: endpointIdFor({
            hostId: host.id,
            profileId: profile.profileId,
            agentId: profile.agentId
          }),
          agentId: profile.agentId,
          profileId: profile.profileId,
          displayName: profile.displayName,
          hostDisplayName: host.displayName,
          status: reason === undefined ? "available" : "unavailable",
          ...(reason === undefined ? {} : { unavailableReason: reason }),
          capabilities: profile.capabilities
        });
        assertRemoteAgentEndpointRedacted(endpoint);
        items.push(endpoint);
        if (items.length > MAX_ENDPOINTS_PER_SNAPSHOT) {
          throw new Error("agent_endpoint_snapshot_limit_exceeded");
        }
      }
    }
    return items;
  }

  private listAllActiveHosts(): AgentHost[] {
    const hosts: AgentHost[] = [];
    const seenHostIds = new Set<string>();
    let offset = 0;
    while (offset <= MAX_ACTIVE_HOSTS_PER_SNAPSHOT) {
      const limit = Math.min(ACTIVE_HOST_PAGE_SIZE, MAX_ACTIVE_HOSTS_PER_SNAPSHOT - offset + 1);
      const page = this.options.hosts.listActiveHosts(limit, offset);
      if (page.length > limit) throw new Error("agent_endpoint_host_page_invalid");
      for (const host of page) {
        if (seenHostIds.has(host.id)) throw new Error("agent_endpoint_host_page_unstable");
        seenHostIds.add(host.id);
        hosts.push(host);
        if (hosts.length > MAX_ACTIVE_HOSTS_PER_SNAPSHOT) {
          throw new Error("agent_endpoint_host_limit_exceeded");
        }
      }
      if (page.length < limit) return hosts;
      offset += page.length;
    }
    throw new Error("agent_endpoint_host_page_invalid");
  }
}
