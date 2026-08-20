import {
  hostCredentialPolicySchema,
  hostCredentialTokenSchema,
  hostReadinessObservationSchema,
  type HostReadinessObservation,
  type HostCredentialPolicy,
  type HostCredentialRotationResponse,
  type OperatorHostAvailability
} from "@planweave-ai/agent-host-protocol";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  HostCredentialLifecycleRepository,
  type HostCredentialAuthenticationKind,
  type HostCredentialRenewalState
} from "./hostCredentialLifecycleRepository.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import { HostInstallationRepository } from "./hostInstallationRepository.js";
import { toAgentHost, type AgentHost, type HostRow } from "./hostRecord.js";
import { capabilitiesSchema } from "./protocol.js";
import type { SqliteDatabase } from "./sqlite.js";
import { CanvasRuntimeHostBindingRepository } from "./canvas/runtimeHostLocator.js";

export type { AgentHost } from "./hostRecord.js";

export type RegisteredAgentHost = {
  host: AgentHost;
  token: string;
};

export type RegisteredAgentHostGeneration = RegisteredAgentHost & {
  supersededHostId?: string;
};

export const DEFAULT_HOST_OFFLINE_AFTER_MS = 60_000;

/** Server-authoritative readiness derived from liveness and redacted Host observations. */
export function operatorHostAvailability(
  host: AgentHost,
  workspaceId: string,
  online: boolean
): OperatorHostAvailability {
  if (host.revokedAt) return { status: "unavailable", reason: "revoked" };
  if (!online) return { status: "unavailable", reason: "offline" };
  const observation = host.readinessObservation;
  if (!observation) return { status: "unavailable", reason: "readiness_not_reported" };
  const workspace = observation.workspaceMappings.find(
    (mapping) => mapping.workspaceId === workspaceId
  );
  if (!workspace || workspace.status === "missing") {
    return { status: "unavailable", reason: "workspace_mapping_missing" };
  }
  if (workspace.status === "invalid") {
    return { status: "unavailable", reason: "workspace_mapping_invalid" };
  }
  if (observation.acpProfiles.length === 0) {
    return { status: "unavailable", reason: "acp_profile_missing" };
  }
  if (observation.acpProfiles.some((profile) => profile.status === "invalid")) {
    return { status: "unavailable", reason: "acp_profile_invalid" };
  }
  const readyProfiles = observation.acpProfiles.filter((profile) => profile.status === "ready");
  if (readyProfiles.length === 0) {
    return { status: "unavailable", reason: "acp_profile_missing" };
  }
  if (
    !readyProfiles.some((profile) =>
      profile.capabilities.every((capability) => host.capabilities.includes(capability))
    )
  ) {
    return { status: "unavailable", reason: "capability_mismatch" };
  }
  return { status: "available", reason: null };
}

/** Server-scoped fleet readiness without collaboration workspace mapping requirements. */
export function fleetHostAvailability(host: AgentHost, online: boolean): OperatorHostAvailability {
  if (host.revokedAt) return { status: "unavailable", reason: "revoked" };
  if (!online) return { status: "unavailable", reason: "offline" };
  const observation = host.readinessObservation;
  if (!observation) return { status: "unavailable", reason: "readiness_not_reported" };
  if (observation.acpProfiles.length === 0) {
    return { status: "unavailable", reason: "acp_profile_missing" };
  }
  if (observation.acpProfiles.some((profile) => profile.status === "invalid")) {
    return { status: "unavailable", reason: "acp_profile_invalid" };
  }
  const readyProfiles = observation.acpProfiles.filter((profile) => profile.status === "ready");
  if (readyProfiles.length === 0) {
    return { status: "unavailable", reason: "acp_profile_missing" };
  }
  if (
    !readyProfiles.some((profile) =>
      profile.capabilities.every((capability) => host.capabilities.includes(capability))
    )
  ) {
    return { status: "unavailable", reason: "capability_mismatch" };
  }
  return { status: "available", reason: null };
}

/** Operation-specific fleet readiness without collaboration workspace mapping. */
export function fleetHostExecutionProfileAvailability(
  host: AgentHost,
  input: {
    online: boolean;
    agentId: string;
    agentProfileId: string;
    requiredCapabilities: readonly string[];
  }
): OperatorHostAvailability {
  const generic = fleetHostAvailability(host, input.online);
  if (generic.status !== "available") return generic;
  const profile = host.readinessObservation?.acpProfiles.find(
    (candidate) =>
      candidate.profileId === input.agentProfileId && candidate.agentId === input.agentId
  );
  if (!profile || profile.status === "missing") {
    return { status: "unavailable", reason: "acp_profile_missing" };
  }
  if (profile.status === "invalid") {
    return { status: "unavailable", reason: "acp_profile_invalid" };
  }
  if (!input.requiredCapabilities.every((capability) => host.capabilities.includes(capability))) {
    return { status: "unavailable", reason: "capability_mismatch" };
  }
  return { status: "available", reason: null };
}

/** Operation-specific readiness for the exact ACP profile carried by an execution envelope. */
export function hostExecutionProfileAvailability(
  host: AgentHost,
  input: {
    workspaceId: string;
    online: boolean;
    agentId: string;
    agentProfileId: string;
    requiredCapabilities: readonly string[];
    fleetUnbound?: boolean;
  }
): OperatorHostAvailability {
  if (input.fleetUnbound) {
    return fleetHostExecutionProfileAvailability(host, input);
  }
  const generic = operatorHostAvailability(host, input.workspaceId, input.online);
  if (generic.status !== "available") return generic;
  const profile = host.readinessObservation?.acpProfiles.find(
    (candidate) =>
      candidate.profileId === input.agentProfileId && candidate.agentId === input.agentId
  );
  if (!profile || profile.status === "missing") {
    return { status: "unavailable", reason: "acp_profile_missing" };
  }
  if (profile.status === "invalid") {
    return { status: "unavailable", reason: "acp_profile_invalid" };
  }
  if (!input.requiredCapabilities.every((capability) => host.capabilities.includes(capability))) {
    return { status: "unavailable", reason: "capability_mismatch" };
  }
  return { status: "available", reason: null };
}

/** Server-authoritative Host liveness shared by assignment and operator projections. */
export function isAgentHostOnline(
  host: AgentHost,
  options: { now?: Date; hostOfflineAfterMs?: number } = {}
): boolean {
  const now = (options.now ?? new Date()).getTime();
  const hostOfflineAfterMs = options.hostOfflineAfterMs ?? DEFAULT_HOST_OFFLINE_AFTER_MS;
  if (!Number.isFinite(hostOfflineAfterMs) || hostOfflineAfterMs <= 0) {
    throw new Error("host_offline_after_invalid");
  }
  return (
    host.revokedAt === undefined &&
    (host.credentialExpiresAt === undefined || Date.parse(host.credentialExpiresAt) > now) &&
    host.lastSeenAt !== undefined &&
    Date.parse(host.lastSeenAt) >= now - hostOfflineAfterMs
  );
}

export class AgentHostRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.workspaceIdentity = new WorkspaceIdentityRepository(database);
    this.credentials = new HostCredentialLifecycleRepository(database, clock);
    this.installations = new HostInstallationRepository(database);
    this.runtimeBindings = new CanvasRuntimeHostBindingRepository(database, this, clock);
  }

  private readonly workspaceIdentity: WorkspaceIdentityRepository;
  private readonly credentials: HostCredentialLifecycleRepository;
  private readonly installations: HostInstallationRepository;
  readonly runtimeBindings: CanvasRuntimeHostBindingRepository;

  private syncWorkspaceHost(hostId: string): void {
    this.workspaceIdentity.synchronizeHost(hostId);
  }

  /** Explicitly authorize a Host for one workspace. */
  bindToWorkspace(hostId: string, workspaceId: string): void {
    this.workspaceIdentity.bindHostToWorkspace(hostId, workspaceId);
  }

  workspaceForLegacyProject(projectId: string): string | undefined {
    return this.workspaceIdentity.workspaceForLegacyProject(projectId);
  }

  workspaceForHost(hostId: string): string | undefined {
    return this.workspaceIdentity.workspaceForHost(hostId);
  }

  workspaceIdsForHosts(hostIds: readonly string[]): Map<string, readonly string[]> {
    if (hostIds.length === 0) return new Map();
    const uniqueHostIds = [...new Set(hostIds)];
    const placeholders = uniqueHostIds.map(() => "?").join(",");
    const rows = this.database
      .prepare(
        `SELECT host_id,workspace_id FROM workspace_agent_hosts
         WHERE host_id IN (${placeholders}) ORDER BY host_id,workspace_id`
      )
      .all(...uniqueHostIds) as Array<{ host_id: string; workspace_id: string }>;
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const workspaceIds = result.get(row.host_id) ?? [];
      workspaceIds.push(row.workspace_id);
      result.set(row.host_id, workspaceIds);
    }
    return result;
  }

  register(displayName: string): RegisteredAgentHost {
    const token = `pw_host_${randomBytes(32).toString("base64url")}`;
    return this.registerWithCredential(displayName, token, [], 1);
  }

  registerWithCredential(
    displayName: string,
    token: string,
    capabilities: readonly string[],
    capacity: number,
    credentialExpiresAt?: string,
    credentialPolicy?: HostCredentialPolicy
  ): RegisteredAgentHost {
    return this.insertWithCredential({
      id: randomUUID(),
      displayName,
      token,
      capabilities,
      capacity,
      credentialExpiresAt,
      credentialPolicy
    });
  }

  /** Register a fresh execution identity while retiring the prior generation of one installation. */
  registerInstallationGeneration(input: {
    installationId: string;
    supersedesHostId?: string;
    displayName: string;
    token: string;
    capabilities: readonly string[];
    capacity: number;
    credentialExpiresAt: string;
    credentialPolicy: HostCredentialPolicy;
  }): RegisteredAgentHostGeneration {
    const nextHostId = randomUUID();
    const transition = this.installations.replaceCurrentGenerationInCallerTransaction({
      installationId: input.installationId,
      supersedesHostId: input.supersedesHostId,
      nextHostId,
      supersededAt: this.clock().toISOString()
    });
    if (transition.supersededHostId) this.syncWorkspaceHost(transition.supersededHostId);

    const registered = this.insertWithCredential({
      id: nextHostId,
      installationId: transition.installationId,
      displayName: input.displayName,
      token: input.token,
      capabilities: input.capabilities,
      capacity: input.capacity,
      credentialExpiresAt: input.credentialExpiresAt,
      credentialPolicy: input.credentialPolicy
    });
    return {
      ...registered,
      ...(transition.supersededHostId ? { supersededHostId: transition.supersededHostId } : {})
    };
  }

  private insertWithCredential(input: {
    id: string;
    installationId?: string;
    displayName: string;
    token: string;
    capabilities: readonly string[];
    capacity: number;
    credentialExpiresAt?: string;
    credentialPolicy?: HostCredentialPolicy;
  }): RegisteredAgentHost {
    const parsedToken = hostCredentialTokenSchema.parse(input.token);
    const parsedCapabilities = capabilitiesSchema.parse(input.capabilities);
    const parsedPolicy =
      input.credentialPolicy === undefined
        ? undefined
        : hostCredentialPolicySchema.parse(input.credentialPolicy);
    if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 128) {
      throw new Error("agent_host_capacity_invalid");
    }
    if (
      input.credentialExpiresAt !== undefined &&
      (!Number.isFinite(Date.parse(input.credentialExpiresAt)) ||
        Date.parse(input.credentialExpiresAt) <= this.clock().getTime())
    ) {
      throw new Error("agent_host_credential_expiry_invalid");
    }
    const normalizedName = input.displayName.trim();
    if (!normalizedName || normalizedName.length > 128) {
      throw new Error("Host display name must contain between 1 and 128 characters.");
    }
    const createdAt = this.clock().toISOString();
    this.database
      .prepare(
        `INSERT INTO agent_hosts(
           id,display_name,credential_hash,capabilities_json,capacity,credential_expires_at,
           credential_lifetime_days,installation_id,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.id,
        normalizedName,
        createHash("sha256").update(parsedToken).digest("hex"),
        JSON.stringify(parsedCapabilities),
        input.capacity,
        input.credentialExpiresAt ?? null,
        parsedPolicy?.lifetimeDays ?? null,
        input.installationId ?? null,
        createdAt
      );
    const host = this.getRequired(input.id);
    this.syncWorkspaceHost(input.id);
    return { host, token: parsedToken };
  }

  get(hostId: string): AgentHost | undefined {
    const row = this.database.prepare("SELECT * FROM agent_hosts WHERE id=?").get(hostId) as
      | HostRow
      | undefined;
    return row ? toAgentHost(row) : undefined;
  }

  getRequired(hostId: string): AgentHost {
    const host = this.get(hostId);
    if (!host) throw new Error("agent_host_not_found");
    return host;
  }

  list(limit = 100, offset = 0): AgentHost[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
      throw new Error("agent_host_list_limit_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("agent_host_list_offset_invalid");
    }
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_hosts WHERE superseded_at IS NULL
           ORDER BY display_name,id LIMIT ? OFFSET ?`
        )
        .all(limit, offset) as HostRow[]
    ).map(toAgentHost);
  }

  /**
   * Server-scoped fleet inventory: active Host rows from agent_hosts.
   * Revoked or credential-expired Hosts are excluded.
   * Ordered by enrollment time so Owner Fleet pickers keep addition order.
   */
  listActiveHosts(limit = 100, offset = 0): AgentHost[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
      throw new Error("agent_host_list_limit_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("agent_host_list_offset_invalid");
    }
    const nowIso = this.clock().toISOString();
    return (
      this.database
        .prepare(
          `SELECT * FROM agent_hosts
           WHERE revoked_at IS NULL
             AND superseded_at IS NULL
             AND (credential_expires_at IS NULL OR credential_expires_at > ?)
           ORDER BY created_at ASC, id ASC
           LIMIT ? OFFSET ?`
        )
        .all(nowIso, limit, offset) as HostRow[]
    ).map(toAgentHost);
  }

  /**
   * Read authoritative Host rows for Hosts bound to exactly one workspace.
   * The workspace projection is used only as an identity binding; liveness and
   * readiness always come from the canonical agent_hosts row.
   */
  listExclusivelyBoundToWorkspace(workspaceId: string): AgentHost[] {
    if (!this.workspaceIdentity.hasCompletedReadCutover(workspaceId)) return [];
    return (
      this.database
        .prepare(
          `SELECT h.* FROM agent_hosts h
           JOIN (
             SELECT host_id,MIN(workspace_id) AS workspace_id FROM workspace_agent_hosts
             GROUP BY host_id
             HAVING COUNT(*)=1
           ) binding ON binding.host_id=h.id
           WHERE binding.workspace_id=? AND h.superseded_at IS NULL
           ORDER BY h.display_name,h.id`
        )
        .all(workspaceId) as HostRow[]
    ).map(toAgentHost);
  }

  authenticateCredential(
    hostId: string,
    token: string,
    workspaceId?: string
  ): { host: AgentHost; kind: HostCredentialAuthenticationKind } | undefined {
    const kind = this.credentials.authenticate(hostId, token);
    if (!kind) return undefined;
    if (!this.workspaceIdentity.hostUsable(hostId, this.clock(), workspaceId)) return undefined;
    if (kind === "promoted") this.syncWorkspaceHost(hostId);
    return { host: this.getRequired(hostId), kind };
  }

  authenticate(hostId: string, token: string, workspaceId?: string): AgentHost | undefined {
    return this.authenticateCredential(hostId, token, workspaceId)?.host;
  }

  credentialRenewalState(hostId: string): HostCredentialRenewalState {
    return this.credentials.renewalState(hostId);
  }

  requestCredentialRenewal(hostId: string): AgentHost {
    this.credentials.requestRenewal(hostId);
    return this.getRequired(hostId);
  }

  registerCredentialRotation(
    hostId: string,
    rotationId: string,
    nextCredentialToken: string
  ): HostCredentialRotationResponse {
    return this.credentials.registerRotation(hostId, rotationId, nextCredentialToken);
  }

  reportOnline(
    hostId: string,
    capabilities: readonly string[],
    capacity: number,
    readiness?: HostReadinessObservation
  ): AgentHost {
    const parsedCapabilities = capabilitiesSchema.parse(capabilities);
    const now = this.clock().toISOString();
    const updated = this.database
      .prepare(
        `UPDATE agent_hosts SET capabilities_json=?,capacity=?,last_seen_at=?,readiness_json=?
         WHERE id=? AND revoked_at IS NULL
           AND (credential_expires_at IS NULL OR credential_expires_at>?)`
      )
      .run(
        JSON.stringify(parsedCapabilities),
        capacity,
        now,
        readiness === undefined
          ? null
          : JSON.stringify(hostReadinessObservationSchema.parse(readiness)),
        hostId,
        now
      );
    if (updated.changes !== 1) throw new Error("agent_host_not_found_or_revoked");
    const host = this.getRequired(hostId);
    this.runtimeBindings.synchronizeReadiness(hostId, readiness?.runtimeProjects);
    this.syncWorkspaceHost(hostId);
    return host;
  }

  touch(hostId: string, at = new Date(), readiness?: HostReadinessObservation): void {
    const updated = this.database
      .prepare(
        `UPDATE agent_hosts SET last_seen_at=?,readiness_json=COALESCE(?,readiness_json)
         WHERE id=? AND revoked_at IS NULL
           AND (credential_expires_at IS NULL OR credential_expires_at>?)`
      )
      .run(
        at.toISOString(),
        readiness ? JSON.stringify(hostReadinessObservationSchema.parse(readiness)) : null,
        hostId,
        this.clock().toISOString()
      );
    if (updated.changes !== 1) throw new Error("agent_host_not_found_or_revoked");
    this.getRequired(hostId);
    if (readiness !== undefined) {
      this.runtimeBindings.synchronizeReadiness(hostId, readiness.runtimeProjects);
    }
    this.syncWorkspaceHost(hostId);
  }

  revoke(hostId: string): void {
    const updated = this.database
      .prepare("UPDATE agent_hosts SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .run(this.clock().toISOString(), hostId);
    if (updated.changes !== 1) throw new Error("agent_host_not_found_or_revoked");
    this.getRequired(hostId);
    this.syncWorkspaceHost(hostId);
  }

  listAvailable(
    requiredCapabilities: readonly string[],
    onlineAfter: Date
  ): Array<AgentHost & { activeDispatches: number }> {
    const required = new Set(capabilitiesSchema.parse(requiredCapabilities));
    const rows = this.database
      .prepare(
        `SELECT h.*,
          (SELECT COUNT(*) FROM dispatches d
            WHERE d.host_id=h.id AND d.status IN ('leased','running','cancelling','awaiting_writeback')) AS active_dispatches
         FROM agent_hosts h
         WHERE h.revoked_at IS NULL AND h.last_seen_at >= ?
           AND (h.credential_expires_at IS NULL OR h.credential_expires_at>?)
         ORDER BY active_dispatches ASC, h.last_seen_at DESC, h.id ASC`
      )
      .all(onlineAfter.toISOString(), this.clock().toISOString()) as Array<
      HostRow & { active_dispatches: number }
    >;
    return rows
      .map((row) => ({ ...toAgentHost(row), activeDispatches: Number(row.active_dispatches) }))
      .filter(
        (host) =>
          host.activeDispatches < host.capacity &&
          [...required].every((capability) => host.capabilities.includes(capability))
      );
  }
}
