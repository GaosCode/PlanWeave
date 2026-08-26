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
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
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
  constructor(readonly code: CatalogErrorCode) {
    super(code);
    this.name = "AgentEndpointCatalogError";
  }
}

export function agentEndpointCatalogErrorCode(error: unknown): CatalogErrorCode | undefined {
  return error instanceof AgentEndpointCatalogError ? error.code : undefined;
}

export type AgentEndpointCatalogOptions = {
  hosts: AgentEndpointHostPort;
  capacities: AgentEndpointCapacityPort;
  hostOfflineAfterMs: number;
  clock?: () => Date;
};

type InternalCandidate = {
  endpoint: RemoteAgentEndpoint;
  host: AgentHost;
  profile: NonNullable<AgentHost["readinessObservation"]>["acpProfiles"][number];
};

type CandidateScope = "fleet" | "workspace";

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
  workspaceId: string | undefined,
  profile: InternalCandidate["profile"],
  activeReservations: number,
  now: Date,
  hostOfflineAfterMs: number,
  duplicateProfile: boolean,
  scope: CandidateScope,
  enforceCapacity: boolean
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
  if (scope === "workspace" && workspaceId !== undefined) {
    const mappings =
      host.readinessObservation?.workspaceMappings.filter(
        (mapping) => mapping.workspaceId === workspaceId
      ) ?? [];
    if (mappings.length === 0 || mappings[0]?.status === "missing") {
      return "workspace_mapping_missing";
    }
    if (mappings.length !== 1 || mappings[0]?.status === "invalid") {
      return "workspace_mapping_invalid";
    }
  }
  if (duplicateProfile || profile.status === "invalid") return "profile_invalid";
  if (profile.status === "missing") return "profile_missing";
  if (!profile.capabilities.every((capability) => host.capabilities.includes(capability))) {
    return "profile_invalid";
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
   * Project Host availability from the closed mapping+capacity policy.
   * `workspaceId` is required when policy.kind is `workspace`.
   */
  listProjected(
    policy: EndpointAvailabilityPolicy,
    workspaceIdInput?: string
  ): RemoteAgentEndpointList {
    const mappingScope = endpointMappingScope(policy);
    const occupyHostCapacity = endpointOccupiesHostCapacity(policy);
    const workspaceId =
      mappingScope === "workspace_canvas"
        ? workspaceIdSchema.parse(workspaceIdInput)
        : workspaceIdInput === undefined
          ? undefined
          : workspaceIdSchema.parse(workspaceIdInput);
    if (mappingScope === "workspace_canvas" && workspaceId === undefined) {
      throw new Error("agent_endpoint_workspace_required");
    }
    const snapshot = this.currentFleetSnapshot(false);
    const now = this.clock();
    const items = snapshot.candidates.map((candidate) => {
      const reason = unavailableReason(
        candidate.host,
        mappingScope === "workspace_canvas" ? workspaceId : undefined,
        candidate.profile,
        snapshot.activeCounts.get(candidate.host.id) ?? 0,
        now,
        this.options.hostOfflineAfterMs,
        this.profileIdentityCount(candidate.host, candidate.profile) !== 1,
        mappingScope === "workspace_canvas" ? "workspace" : "fleet",
        occupyHostCapacity
      );
      const endpoint = remoteAgentEndpointSchema.parse({
        ...candidate.endpoint,
        status: reason === undefined ? "available" : "unavailable",
        ...(reason === undefined ? {} : { unavailableReason: reason })
      });
      assertRemoteAgentEndpointRedacted(endpoint);
      return endpoint;
    });
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
   * Mapping and collaboration capacity apply; exclusive bind does not filter.
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
    const workspaceId = workspaceIdSchema.parse(workspaceIdInput);
    const requiredCapabilities = agentEndpointCapabilitiesSchema.parse(requiredCapabilitiesInput);
    const candidate = this.findCandidateForResolve(endpointId);
    if (!candidate) throw new AgentEndpointCatalogError("agent_endpoint_unknown");
    if (this.unavailableReasonForResolve(candidate, workspaceId, policy) !== undefined) {
      throw new AgentEndpointCatalogError("agent_endpoint_unavailable");
    }
    if (
      !requiredCapabilities.every(
        (capability) =>
          candidate.host.capabilities.includes(capability) &&
          candidate.profile.capabilities.includes(capability)
      )
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
    const workspaceId = workspaceIdSchema.parse(workspaceIdInput);
    const expectedHostId = opaqueIdentifierSchema.parse(expectedHostIdInput);
    const requiredCapabilities = agentEndpointCapabilitiesSchema.parse(requiredCapabilitiesInput);
    const candidate = this.findCandidateForResolve(endpointId);
    if (!candidate || candidate.host.id !== expectedHostId) {
      throw new AgentEndpointCatalogError("agent_endpoint_unknown");
    }
    const reason = this.unavailableReasonForResolve(candidate, workspaceId, policy);
    if (reason !== undefined && reason !== "at_capacity") {
      throw new AgentEndpointCatalogError("agent_endpoint_unavailable");
    }
    if (
      !requiredCapabilities.every(
        (capability) =>
          candidate.host.capabilities.includes(capability) &&
          candidate.profile.capabilities.includes(capability)
      )
    ) {
      throw new AgentEndpointCatalogError("agent_endpoint_incompatible");
    }
    return this.toResolved(candidate);
  }

  private unavailableReasonForResolve(
    candidate: InternalCandidate,
    workspaceId: string,
    policy: EndpointAvailabilityPolicy
  ): AgentEndpointUnavailableReason | undefined {
    const scope: CandidateScope =
      endpointMappingScope(policy) === "owner_canvas" ? "fleet" : "workspace";
    return unavailableReason(
      candidate.host,
      scope === "workspace" ? workspaceId : undefined,
      candidate.profile,
      this.options.capacities.activeCountsForHosts([candidate.host.id]).get(candidate.host.id) ?? 0,
      this.clock(),
      this.options.hostOfflineAfterMs,
      this.profileIdentityCount(candidate.host, candidate.profile) !== 1,
      scope,
      endpointOccupiesHostCapacity(policy)
    );
  }

  private findCandidateForResolve(endpointId: string): InternalCandidate | undefined {
    return this.currentFleetCandidates(false).find(
      (current) => current.endpoint.endpointId === endpointId
    );
  }

  private toResolved(candidate: InternalCandidate): ResolvedAgentEndpoint {
    return {
      endpointId: candidate.endpoint.endpointId,
      hostId: candidate.host.id,
      profileId: candidate.profile.profileId,
      agentId: candidate.profile.agentId,
      displayName: candidate.profile.displayName,
      hostDisplayName: candidate.host.displayName,
      capabilities: [...candidate.profile.capabilities],
      resolvedAt: this.clock().toISOString()
    };
  }

  private profileIdentityCount(host: AgentHost, profile: InternalCandidate["profile"]): number {
    const identity = `${profile.profileId}\u0000${profile.agentId}`;
    let count = 0;
    for (const observed of host.readinessObservation?.acpProfiles ?? []) {
      if (`${observed.profileId}\u0000${observed.agentId}` === identity) count += 1;
    }
    return count;
  }

  private currentFleetCandidates(enforceCapacity: boolean): InternalCandidate[] {
    return this.currentFleetSnapshot(enforceCapacity).candidates;
  }

  private currentFleetSnapshot(enforceCapacity: boolean): {
    candidates: InternalCandidate[];
    activeCounts: ReadonlyMap<string, number>;
  } {
    const now = this.clock();
    const hosts = this.listAllActiveHosts();
    const activeCounts = this.options.capacities.activeCountsForHosts(hosts.map((host) => host.id));
    const candidates: InternalCandidate[] = [];
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
          undefined,
          profile,
          activeCounts.get(host.id) ?? 0,
          now,
          this.options.hostOfflineAfterMs,
          identityCounts.get(identity) !== 1,
          "fleet",
          enforceCapacity
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
        candidates.push({ endpoint, host, profile });
        if (candidates.length > MAX_ENDPOINTS_PER_SNAPSHOT) {
          throw new Error("agent_endpoint_snapshot_limit_exceeded");
        }
      }
    }
    return { candidates, activeCounts };
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
