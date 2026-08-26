import {
  DEFAULT_HOST_OFFLINE_AFTER_MS,
  isAgentHostOnline,
  operatorHostAvailability,
  type AgentHost,
  type AgentHostRepository
} from "../hosts.js";
import type { HumanIdentityRepository } from "../identity/repository.js";
import { isActiveMembership } from "../identity/schemas.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { WORK_ELIGIBLE_HOST_BATCH_MAX } from "./limits.js";
import {
  assignmentHostFactsSchema,
  assignmentMembershipFactsSchema,
  workItemPackageFactsSchema,
  type AssignmentHostFacts,
  type AssignmentMembershipFacts,
  type WorkItemPackageFacts,
  type WorkItemRef
} from "./schemas.js";
import type { WorkItemPackagePort } from "./workItemFacts.js";

/**
 * Live membership facts for assignment targets. Identity membership rows are the truth source.
 */
export type AssignmentMembershipPort = {
  getMembershipFacts(
    workspaceId: string,
    projectId: string,
    humanPrincipalId: string
  ): AssignmentMembershipFacts | undefined;
  listActiveMemberFacts(
    workspaceId: string,
    projectId: string,
    limit: number,
    offset: number
  ): AssignmentMembershipFacts[];
};

/**
 * Live Host facts for exact Host assignment and eligibility display.
 * Host presence/capabilities are never stored on the assignment row.
 */
export type AssignmentHostPort = {
  getHostFacts(
    workspaceId: string,
    projectId: string,
    hostId: string
  ): AssignmentHostFacts | undefined;
  listHostFacts(
    workspaceId: string,
    projectId: string,
    options?: {
      requiredCapabilities?: readonly string[];
      limit?: number;
      offset?: number;
    }
  ): AssignmentHostFacts[];
  /** One inventory projection for batch eligibility; capability filtering stays in the service. */
  listEligibleHostProjections(workspaceId: string, projectId: string): AssignmentHostFacts[];
};

export type AssignmentMembershipPortFromIdentityOptions =
  | {
      identity: HumanIdentityRepository;
      workspaceIdentity?: never;
    }
  | {
      identity?: never;
      workspaceIdentity: WorkspaceIdentityRepository;
    };

export function createIdentityMembershipPort(
  options: AssignmentMembershipPortFromIdentityOptions
): AssignmentMembershipPort {
  if (options.workspaceIdentity) {
    const { workspaceIdentity } = options;
    return {
      getMembershipFacts(workspaceId, projectId, humanPrincipalId) {
        const membership = workspaceIdentity.findActiveMembership(workspaceId, humanPrincipalId);
        if (!membership) return undefined;
        return assignmentMembershipFactsSchema.parse({
          projectId,
          humanPrincipalId: membership.humanPrincipalId,
          membershipActive: true,
          displayName: membership.displayName
        });
      },
      listActiveMemberFacts(workspaceId, projectId, limit, offset) {
        return workspaceIdentity
          .listMembershipViews(workspaceId)
          .filter((membership) => membership.revokedAt === null)
          .slice(offset, offset + limit)
          .map((membership) =>
            assignmentMembershipFactsSchema.parse({
              projectId,
              humanPrincipalId: membership.humanPrincipalId,
              membershipActive: true,
              displayName: membership.displayName
            })
          );
      }
    };
  }
  const { identity } = options;
  return {
    getMembershipFacts(_workspaceId, projectId, humanPrincipalId) {
      const membership = identity.getActiveMembership(projectId, humanPrincipalId);
      const principal = identity.getPrincipal(humanPrincipalId);
      if (membership) {
        return assignmentMembershipFactsSchema.parse({
          projectId: membership.projectId,
          humanPrincipalId: membership.humanPrincipalId,
          membershipActive: isActiveMembership(membership),
          displayName: principal?.displayName
        });
      }
      // Principal without active membership → inactive facts for availability projection.
      if (principal) {
        return assignmentMembershipFactsSchema.parse({
          projectId,
          humanPrincipalId,
          membershipActive: false,
          displayName: principal.displayName
        });
      }
      return undefined;
    },
    listActiveMemberFacts(_workspaceId, projectId, limit, offset) {
      return identity.listActiveMembers(projectId, limit, offset).map((membership) => {
        const principal = identity.getPrincipal(membership.humanPrincipalId);
        return assignmentMembershipFactsSchema.parse({
          projectId: membership.projectId,
          humanPrincipalId: membership.humanPrincipalId,
          membershipActive: true,
          displayName: principal?.displayName ?? membership.humanPrincipalId
        });
      });
    }
  };
}

export type AssignmentHostPortFromRepositoryOptions = {
  hosts: AgentHostRepository;
  /**
   * Hosts without a project binding table default to authorized when not revoked.
   * Callers may override when a project↔host authorization model is introduced.
   */
  isHostAuthorizedForProject?: (workspaceId: string, projectId: string, host: AgentHost) => boolean;
  /** Hosts with lastSeenAt after this threshold (ms ago) count as online. Default 60s. */
  hostOfflineAfterMs?: number;
  clock?: () => Date;
  /** Optional active-dispatch counter for capacityRemaining; omit capacity when unknown. */
  countActiveDispatches?: (hostId: string) => number;
};

export function createHostAssignmentPort(
  options: AssignmentHostPortFromRepositoryOptions
): AssignmentHostPort {
  const clock = options.clock ?? (() => new Date());
  const hostOfflineAfterMs = options.hostOfflineAfterMs ?? DEFAULT_HOST_OFFLINE_AFTER_MS;
  const isAuthorized =
    options.isHostAuthorizedForProject ??
    ((_workspaceId: string, _projectId: string, host: AgentHost) => host.revokedAt === undefined);

  function toFacts(
    workspaceId: string,
    projectId: string,
    host: AgentHost,
    hostWorkspaceIds?: readonly string[]
  ): AssignmentHostFacts {
    const online = isAgentHostOnline(host, { now: clock(), hostOfflineAfterMs });
    const availability = operatorHostAvailability(host, workspaceId, online);
    const active = options.countActiveDispatches?.(host.id);
    return assignmentHostFactsSchema.parse({
      workspaceId,
      projectId,
      hostId: host.id,
      exists: true,
      revoked: host.revokedAt !== undefined,
      authorizedForProject:
        (hostWorkspaceIds === undefined
          ? options.hosts.workspaceForHost(host.id) === workspaceId
          : hostWorkspaceIds.length === 1 && hostWorkspaceIds[0] === workspaceId) &&
        isAuthorized(workspaceId, projectId, host),
      online,
      ready: availability.status === "available",
      capabilities: [...host.capabilities],
      displayName: host.displayName,
      ...(active !== undefined ? { capacityRemaining: Math.max(0, host.capacity - active) } : {})
    });
  }

  return {
    getHostFacts(workspaceId, projectId, hostId) {
      const host = options.hosts.get(hostId);
      if (!host) {
        return assignmentHostFactsSchema.parse({
          workspaceId,
          projectId,
          hostId,
          exists: false,
          revoked: false,
          authorizedForProject: false,
          online: false,
          ready: false,
          capabilities: []
        });
      }
      return toFacts(workspaceId, projectId, host);
    },
    listHostFacts(workspaceId, projectId, listOptions = {}) {
      const limit = listOptions.limit ?? 100;
      const offset = listOptions.offset ?? 0;
      // Pull a page of hosts; filter capabilities in application (Host list is already ordered).
      const hosts = options.hosts
        .list(Math.min(limit + offset, 100), 0)
        .slice(offset, offset + limit);
      const required = listOptions.requiredCapabilities ?? [];
      return hosts
        .map((host) => toFacts(workspaceId, projectId, host))
        .filter((facts) => {
          if (!facts.exists || facts.revoked || !facts.authorizedForProject || !facts.ready) {
            return false;
          }
          if (required.length === 0) return true;
          const available = new Set(facts.capabilities);
          return required.every((capability) => available.has(capability));
        });
    },
    listEligibleHostProjections(workspaceId, projectId) {
      const hosts = options.hosts.list(WORK_ELIGIBLE_HOST_BATCH_MAX, 0);
      const workspaceIdsByHost = options.hosts.workspaceIdsForHosts(hosts.map((host) => host.id));
      return hosts
        .map((host) => toFacts(workspaceId, projectId, host, workspaceIdsByHost.get(host.id) ?? []))
        .filter(
          (facts) => facts.exists && !facts.revoked && facts.authorizedForProject && facts.ready
        );
    }
  };
}

/**
 * Route WorkItemRef resolution across multiple canvas package ports.
 * Missing canvas returns exists:false facts without inventing package content.
 */
export function createRoutedWorkItemPackagePort(
  resolveCanvas: (canvasId: string) => WorkItemPackagePort | undefined
): WorkItemPackagePort {
  return {
    resolveWorkItem(workItem: WorkItemRef): WorkItemPackageFacts {
      const port = resolveCanvas(workItem.canvasId);
      if (!port) {
        return workItemPackageFactsSchema.parse({
          canvasId: workItem.canvasId,
          kind: workItem.kind,
          exists: false,
          taskId: workItem.kind === "task" ? workItem.taskId : undefined,
          blockRef: workItem.kind === "block" ? workItem.blockRef : undefined,
          requiredCapabilities: []
        });
      }
      return port.resolveWorkItem(workItem);
    },
    resolveWorkItems(workItems) {
      const results = new Array<WorkItemPackageFacts>(workItems.length);
      const byCanvas = new Map<string, Array<{ index: number; workItem: WorkItemRef }>>();
      workItems.forEach((workItem, index) => {
        const group = byCanvas.get(workItem.canvasId) ?? [];
        group.push({ index, workItem });
        byCanvas.set(workItem.canvasId, group);
      });
      for (const [canvasId, group] of byCanvas) {
        const port = resolveCanvas(canvasId);
        if (!port) {
          for (const { index, workItem } of group) {
            results[index] = workItemPackageFactsSchema.parse({
              canvasId: workItem.canvasId,
              kind: workItem.kind,
              exists: false,
              taskId: workItem.kind === "task" ? workItem.taskId : undefined,
              blockRef: workItem.kind === "block" ? workItem.blockRef : undefined,
              requiredCapabilities: []
            });
          }
          continue;
        }
        const resolved = port.resolveWorkItems(group.map(({ workItem }) => workItem));
        if (resolved.length !== group.length) throw new Error("work_item_batch_length_mismatch");
        group.forEach(({ index }, resultIndex) => {
          results[index] = resolved[resultIndex]!;
        });
      }
      return results;
    }
  };
}
