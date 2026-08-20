import { randomUUID } from "node:crypto";
import { authorizeHumanAction } from "./policy.js";
import { HUMAN_AUTH_ERROR_MESSAGES, type HumanAuthErrorCode } from "./errors.js";
import {
  toDeviceView,
  toInvitationView,
  toMembershipView,
  toPrincipalView,
  humanBootstrapRequestSchema,
  humanConsumeInvitationRequestSchema,
  humanCreateInvitationRequestSchema,
  humanDeviceListQuerySchema,
  humanInvitationListQuerySchema,
  humanRevokeInvitationsRequestSchema,
  humanPageQuerySchema,
  humanUpdateDisplayNameRequestSchema,
  type HumanDeviceView,
  type HumanInvitationView,
  type HumanRevokeInvitationsResponse,
  type HumanMembershipView,
  type HumanPrincipalView
} from "./dtos.js";
import { HumanIdentityError, type HumanIdentityRepository } from "./repository.js";
import {
  humanProjectIdSchema,
  humanPrincipalIdSchema,
  humanDeviceCredentialIdSchema,
  projectInvitationIdSchema,
  localAdministrativeProofSchema,
  type HumanAuthContext,
  type LocalAdministrativeProof
} from "./schemas.js";

export class HumanMembershipServiceError extends Error {
  constructor(
    readonly code: HumanAuthErrorCode,
    message: string = HUMAN_AUTH_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "HumanMembershipServiceError";
  }
}

function deny(code: HumanAuthErrorCode): never {
  throw new HumanMembershipServiceError(code);
}

function mapIdentityError(error: unknown): never {
  if (error instanceof HumanIdentityError) {
    throw new HumanMembershipServiceError(error.code, error.message);
  }
  if (error instanceof HumanMembershipServiceError) throw error;
  throw error;
}

export type HumanMembershipServiceOptions = {
  repository: HumanIdentityRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  workspaceForProject(projectId: string): string | undefined;
  clock?: () => Date;
};

export type CollaborationScopeAuthority = {
  hasScope(input: { workspaceId: string; projectId: string; canvasId?: string }): boolean;
  /** True only when the project has one active logical scope in the collaboration registry. */
  hasProject(projectId: string): boolean;
};

/**
 * Thin application service: authenticate subject → centralized policy → repository → display DTOs.
 */
export class HumanMembershipService {
  private readonly repository: HumanIdentityRepository;
  private readonly collaborationScopeAuthority: CollaborationScopeAuthority;
  private readonly workspaceForProject: (projectId: string) => string | undefined;
  private readonly clock: () => Date;

  constructor(options: HumanMembershipServiceOptions) {
    this.repository = options.repository;
    this.collaborationScopeAuthority = options.collaborationScopeAuthority;
    this.workspaceForProject = options.workspaceForProject;
    this.clock = options.clock ?? (() => new Date());
  }

  private requireProject(projectId: string): string {
    const pid = humanProjectIdSchema.parse(projectId);
    if (!this.collaborationScopeAuthority.hasProject(pid)) deny("human_cross_project_forbidden");
    return pid;
  }

  private requireWorkspace(projectId: string): string {
    const workspaceId = this.workspaceForProject(projectId);
    if (!workspaceId) deny("human_cross_project_forbidden");
    return workspaceId;
  }

  /**
   * Owner bootstrap after the HTTP layer has accepted the local-admin boundary
   * (loopback-only administrative surface). Network human/host credentials cannot call this.
   */
  bootstrapOwner(
    projectId: string,
    request: unknown,
    issuedAt?: string
  ): {
    workspaceId: string;
    principal: HumanPrincipalView;
    membership: HumanMembershipView;
    device: HumanDeviceView;
    deviceToken?: string;
    created: boolean;
  } {
    try {
      const pid = this.requireProject(projectId);
      const workspaceId = this.requireWorkspace(pid);
      const body = humanBootstrapRequestSchema.parse(request);
      const humanPrincipalId = body.humanPrincipalId ?? humanPrincipalIdSchema.parse(randomUUID());
      const proof = localAdministrativeProofSchema.parse({
        kind: "local_administrative_proof",
        projectId: pid,
        humanPrincipalId,
        displayName: body.displayName,
        issuedAt: issuedAt ?? this.clock().toISOString()
      } satisfies LocalAdministrativeProof);

      const existingOwner = this.repository
        .listActiveMembers(pid, 100, 0)
        .find((member) => member.role === "owner");

      const decision = authorizeHumanAction({
        action: "bootstrap_owner",
        subject: { kind: "local_administrative_proof", proof },
        facts: {
          targetProjectId: pid,
          targetHumanPrincipalId: humanPrincipalId,
          existingOwnerPrincipalId: existingOwner?.humanPrincipalId
        }
      });
      if (!decision.allowed) deny(decision.code);

      const result = this.repository.bootstrapOwner(proof, {
        deviceLabel: body.deviceLabel,
        deviceTtlMs: body.deviceTtlMs
      });
      return {
        workspaceId,
        principal: toPrincipalView(result.principal),
        membership: toMembershipView(result.membership, result.principal.displayName),
        device: toDeviceView(result.device),
        deviceToken: result.deviceToken,
        created: result.created
      };
    } catch (error) {
      mapIdentityError(error);
    }
  }

  createInvitation(
    context: HumanAuthContext,
    projectId: string,
    request: unknown
  ): { invitation: HumanInvitationView; invitationToken: string } {
    try {
      const pid = this.requireProject(projectId);
      const body = humanCreateInvitationRequestSchema.parse(request ?? {});
      const decision = authorizeHumanAction({
        action: "create_invitation",
        subject: { kind: "human", context },
        facts: { targetProjectId: pid }
      });
      if (!decision.allowed) deny(decision.code);

      const result = this.repository.createInvitation({
        projectId: pid,
        createdByHumanPrincipalId: context.humanPrincipalId,
        ttlMs: body.ttlMs
      });
      return {
        invitation: toInvitationView(result.invitation),
        invitationToken: result.invitationToken
      };
    } catch (error) {
      mapIdentityError(error);
    }
  }

  listInvitations(
    context: HumanAuthContext,
    projectId: string,
    query: unknown
  ): { items: HumanInvitationView[]; nextCursor: number | null } {
    try {
      const pid = this.requireProject(projectId);
      const page = humanInvitationListQuerySchema.parse(query);
      // Listing invitations is an owner management surface (same as create/revoke).
      const decision = authorizeHumanAction({
        action: "create_invitation",
        subject: { kind: "human", context },
        facts: { targetProjectId: pid }
      });
      if (!decision.allowed) deny(decision.code);

      const rows = this.repository.listInvitations(pid, page.limit, page.cursor, {
        openOnly: page.openOnly
      });
      const items = rows.map(toInvitationView);
      const nextCursor = items.length === page.limit ? page.cursor + items.length : null;
      return { items, nextCursor };
    } catch (error) {
      mapIdentityError(error);
    }
  }

  revokeInvitation(
    context: HumanAuthContext,
    projectId: string,
    invitationId: string
  ): HumanInvitationView {
    try {
      const pid = this.requireProject(projectId);
      const id = projectInvitationIdSchema.parse(invitationId);
      const decision = authorizeHumanAction({
        action: "revoke_invitation",
        subject: { kind: "human", context },
        facts: { targetProjectId: pid }
      });
      if (!decision.allowed) deny(decision.code);

      // Idempotent: already-revoked invitation returns current state without re-write conflict.
      const existing = this.repository.getInvitation(id);
      if (!existing || existing.projectId !== pid) {
        deny("human_invitation_invalid");
      }
      if (existing.revokedAt !== undefined) {
        return toInvitationView(existing);
      }
      if (existing.consumedAt !== undefined) {
        deny("human_invitation_consumed");
      }

      return toInvitationView(this.repository.revokeInvitation(id, pid));
    } catch (error) {
      mapIdentityError(error);
    }
  }

  revokeInvitations(
    context: HumanAuthContext,
    projectId: string,
    request: unknown
  ): HumanRevokeInvitationsResponse {
    try {
      const pid = this.requireProject(projectId);
      const { invitationIds } = humanRevokeInvitationsRequestSchema.parse(request);
      const decision = authorizeHumanAction({
        action: "revoke_invitation",
        subject: { kind: "human", context },
        facts: { targetProjectId: pid }
      });
      if (!decision.allowed) deny(decision.code);

      return {
        items: this.repository.revokeInvitations(invitationIds, pid).map(toInvitationView)
      };
    } catch (error) {
      mapIdentityError(error);
    }
  }

  consumeInvitation(
    projectId: string,
    request: unknown
  ): {
    workspaceId: string;
    principal: HumanPrincipalView;
    membership: HumanMembershipView;
    device: HumanDeviceView;
    deviceToken: string;
    invitation: HumanInvitationView;
    principalCreated: boolean;
  } {
    try {
      const pid = this.requireProject(projectId);
      const workspaceId = this.requireWorkspace(pid);
      const body = humanConsumeInvitationRequestSchema.parse(request);

      const matched = this.repository.findInvitationByToken(body.invitationToken);
      if (!matched) {
        deny("human_invitation_invalid");
      }

      const decision = authorizeHumanAction({
        action: "join_project",
        subject: {
          kind: "invitation_bearer",
          invitation: matched,
          projectId: pid,
          now: this.clock()
        },
        facts: { targetProjectId: pid }
      });
      if (!decision.allowed) deny(decision.code);

      const result = this.repository.consumeInvitation({
        invitationToken: body.invitationToken,
        projectId: pid,
        displayName: body.displayName,
        deviceLabel: body.deviceLabel,
        deviceTtlMs: body.deviceTtlMs,
        existingDeviceToken: body.existingDeviceToken
      });

      return {
        workspaceId,
        principal: toPrincipalView(result.principal),
        membership: toMembershipView(result.membership, result.principal.displayName),
        device: toDeviceView(result.device),
        deviceToken: result.deviceToken,
        invitation: toInvitationView(result.invitation),
        principalCreated: result.principalCreated
      };
    } catch (error) {
      mapIdentityError(error);
    }
  }

  listMembers(
    context: HumanAuthContext,
    projectId: string,
    query: unknown
  ): { items: HumanMembershipView[]; nextCursor: number | null } {
    try {
      const pid = this.requireProject(projectId);
      const page = humanPageQuerySchema.parse(query);
      const decision = authorizeHumanAction({
        action: "view_members",
        subject: { kind: "human", context },
        facts: { targetProjectId: pid }
      });
      if (!decision.allowed) deny(decision.code);

      const rows = this.repository.listActiveMembers(pid, page.limit, page.cursor);
      const items = rows.map((membership) => {
        const principal = this.repository.getPrincipal(membership.humanPrincipalId);
        return toMembershipView(membership, principal?.displayName ?? membership.humanPrincipalId);
      });
      const nextCursor = items.length === page.limit ? page.cursor + items.length : null;
      return { items, nextCursor };
    } catch (error) {
      mapIdentityError(error);
    }
  }

  updateOwnDisplayName(
    context: HumanAuthContext,
    projectId: string,
    request: unknown
  ): HumanPrincipalView {
    try {
      const pid = this.requireProject(projectId);
      const body = humanUpdateDisplayNameRequestSchema.parse(request);
      const decision = authorizeHumanAction({
        action: "update_own_profile",
        subject: { kind: "human", context },
        facts: {
          targetProjectId: pid,
          targetHumanPrincipalId: context.humanPrincipalId
        }
      });
      if (!decision.allowed) deny(decision.code);

      return toPrincipalView(
        this.repository.updateHumanDisplayName(context.humanPrincipalId, body.displayName)
      );
    } catch (error) {
      mapIdentityError(error);
    }
  }

  removeMember(
    context: HumanAuthContext,
    projectId: string,
    targetHumanPrincipalId: string
  ): HumanMembershipView {
    try {
      const pid = this.requireProject(projectId);
      const target = humanPrincipalIdSchema.parse(targetHumanPrincipalId);
      const membership = this.repository.getActiveMembership(pid, target);
      if (!membership) deny("human_membership_required");

      const decision = authorizeHumanAction({
        action: "remove_member",
        subject: { kind: "human", context },
        facts: {
          targetProjectId: pid,
          targetHumanPrincipalId: target,
          targetMembershipRole: membership.role,
          activeOwnerCount: this.repository.countActiveOwners(pid)
        }
      });
      if (!decision.allowed) deny(decision.code);

      const removed = this.repository.removeMember(pid, target);
      const principal = this.repository.getPrincipal(removed.humanPrincipalId);
      return toMembershipView(removed, principal?.displayName ?? removed.humanPrincipalId);
    } catch (error) {
      mapIdentityError(error);
    }
  }

  promoteOwner(
    context: HumanAuthContext,
    projectId: string,
    targetHumanPrincipalId: string
  ): HumanMembershipView {
    try {
      const pid = this.requireProject(projectId);
      const target = humanPrincipalIdSchema.parse(targetHumanPrincipalId);
      const decision = authorizeHumanAction({
        action: "promote_owner",
        subject: { kind: "human", context },
        facts: { targetProjectId: pid, targetHumanPrincipalId: target }
      });
      if (!decision.allowed) deny(decision.code);

      const membership = this.repository.promoteToOwner(pid, target);
      const principal = this.repository.getPrincipal(membership.humanPrincipalId);
      return toMembershipView(membership, principal?.displayName ?? membership.humanPrincipalId);
    } catch (error) {
      mapIdentityError(error);
    }
  }

  demoteOwner(
    context: HumanAuthContext,
    projectId: string,
    targetHumanPrincipalId: string
  ): HumanMembershipView {
    try {
      const pid = this.requireProject(projectId);
      const target = humanPrincipalIdSchema.parse(targetHumanPrincipalId);
      const membership = this.repository.getActiveMembership(pid, target);
      if (!membership) deny("human_membership_required");

      const decision = authorizeHumanAction({
        action: "demote_owner",
        subject: { kind: "human", context },
        facts: {
          targetProjectId: pid,
          targetHumanPrincipalId: target,
          targetMembershipRole: membership.role,
          activeOwnerCount: this.repository.countActiveOwners(pid)
        }
      });
      if (!decision.allowed) deny(decision.code);

      const demoted = this.repository.demoteOwner(pid, target);
      const principal = this.repository.getPrincipal(demoted.humanPrincipalId);
      return toMembershipView(demoted, principal?.displayName ?? demoted.humanPrincipalId);
    } catch (error) {
      mapIdentityError(error);
    }
  }

  listDevices(
    context: HumanAuthContext,
    projectId: string,
    query: unknown
  ): { items: HumanDeviceView[]; nextCursor: number | null } {
    try {
      const pid = this.requireProject(projectId);
      const page = humanDeviceListQuerySchema.parse(query);

      if (page.scope === "project") {
        const decision = authorizeHumanAction({
          action: "list_project_devices",
          subject: { kind: "human", context },
          facts: { targetProjectId: pid }
        });
        if (!decision.allowed) deny(decision.code);
        const rows = this.repository.listDevicesForProjectMembers(pid, page.limit, page.cursor);
        const items = rows.map(toDeviceView);
        const nextCursor = items.length === page.limit ? page.cursor + items.length : null;
        return { items, nextCursor };
      }

      const decision = authorizeHumanAction({
        action: "list_own_devices",
        subject: { kind: "human", context },
        facts: { targetProjectId: pid }
      });
      if (!decision.allowed) deny(decision.code);
      const rows = this.repository.listDevicesForPrincipal(
        context.humanPrincipalId,
        pid,
        page.limit,
        page.cursor
      );
      const items = rows.map(toDeviceView);
      const nextCursor = items.length === page.limit ? page.cursor + items.length : null;
      return { items, nextCursor };
    } catch (error) {
      mapIdentityError(error);
    }
  }

  revokeDevice(
    context: HumanAuthContext,
    projectId: string,
    deviceCredentialId: string
  ): HumanDeviceView {
    try {
      const pid = this.requireProject(projectId);
      const deviceId = humanDeviceCredentialIdSchema.parse(deviceCredentialId);
      const device = this.repository.getDevice(deviceId);
      if (!device) deny("human_input_invalid");
      if (device.mintedForProjectId !== pid) deny("human_cross_project_forbidden");

      const isOwn = device.humanPrincipalId === context.humanPrincipalId;
      if (isOwn) {
        const decision = authorizeHumanAction({
          action: "revoke_own_device",
          subject: { kind: "human", context },
          facts: {
            targetProjectId: pid,
            targetDeviceCredentialId: deviceId,
            targetDeviceOwnerPrincipalId: device.humanPrincipalId
          }
        });
        if (!decision.allowed) deny(decision.code);
      } else {
        const targetMembership = this.repository.getActiveMembership(pid, device.humanPrincipalId);
        const decision = authorizeHumanAction({
          action: "revoke_member_device",
          subject: { kind: "human", context },
          facts: {
            targetProjectId: pid,
            targetDeviceCredentialId: deviceId,
            targetDeviceOwnerPrincipalId: device.humanPrincipalId,
            targetDeviceOwnerMembershipActive: targetMembership !== undefined
          }
        });
        if (!decision.allowed) deny(decision.code);
      }

      // Idempotent revoke: already revoked returns current view.
      if (device.revokedAt !== undefined) {
        return toDeviceView(device);
      }

      if (isOwn) {
        return toDeviceView(this.repository.revokeDevice(deviceId, pid, context.humanPrincipalId));
      }
      return toDeviceView(this.repository.revokeDevice(deviceId, pid));
    } catch (error) {
      mapIdentityError(error);
    }
  }
}
