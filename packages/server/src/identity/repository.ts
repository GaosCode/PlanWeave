import { randomUUID } from "node:crypto";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { DeviceCredentialStore } from "./deviceCredentialStore.js";
import { HumanIdentityError } from "./errors.js";
import { HumanPrincipalIdentity } from "./humanPrincipalIdentity.js";
import { InvitationStore } from "./invitationStore.js";
import { HUMAN_MAX_MEMBERS_PER_PROJECT, HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT } from "./limits.js";
import { MembershipStore } from "./membershipStore.js";
import { projectWorkspaceMemberships } from "./workspaceMembershipProjection.js";
import {
  evaluateDeviceUsability,
  evaluateInvitationUsability,
  humanDeviceTokenSchema,
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  isActiveMembership,
  localAdministrativeProofSchema,
  type HumanDeviceCredentialMetadata,
  type HumanPrincipal,
  type LocalAdministrativeProof,
  type ProjectInvitationMetadata,
  type ProjectMembership
} from "./schemas.js";
import { WorkspaceIdentityRepository } from "./workspaceRepository.js";
import { assertNoPendingSnapshotRestore } from "../authorizationFence.js";
import type { AuthorizationChangeScope } from "../authorizationChangeSignal.js";

export { HumanIdentityError } from "./errors.js";

export type BootstrapOwnerResult = {
  principal: HumanPrincipal;
  membership: ProjectMembership;
  device: HumanDeviceCredentialMetadata;
  /**
   * Plaintext device secret. Returned on first bootstrap and on recovery re-bootstrap
   * when no usable device remains. Omitted when an existing usable device is reused.
   */
  deviceToken?: string;
  created: boolean;
};

export type CreateInvitationResult = {
  invitation: ProjectInvitationMetadata;
  /** Plaintext invitation secret; returned exactly once at creation. */
  invitationToken: string;
};

export type ConsumeInvitationResult = {
  principal: HumanPrincipal;
  membership: ProjectMembership;
  device: HumanDeviceCredentialMetadata;
  /** Plaintext device secret for the newly minted credential; returned once. */
  deviceToken: string;
  invitation: ProjectInvitationMetadata;
  /** True when a new principal row was created for this consumption. */
  principalCreated: boolean;
};

export type AuthenticatedHumanDevice = {
  principal: HumanPrincipal;
  device: HumanDeviceCredentialMetadata;
  membership?: ProjectMembership;
};

export type MembershipTransition = {
  type: "member_joined" | "member_removed" | "owner_promoted" | "owner_demoted";
  membership: ProjectMembership;
  principal: HumanPrincipal;
};

export type InvitationTransition = {
  type: "invitation_created" | "invitation_revoked" | "invitation_consumed";
  invitation: ProjectInvitationMetadata;
};

export type HumanIdentityRepositoryOptions = {
  onMembershipTransitionInTransaction?: (transition: MembershipTransition) => void;
  onInvitationTransitionInTransaction?: (transition: InvitationTransition) => void;
  onAuthorizationChangeAfterCommit?: (change: AuthorizationChangeScope) => void;
};

/**
 * SQLite repositories for human principals, project memberships, invitations, and devices.
 * Stores only token digests and safe metadata. Plaintext secrets leave this layer at most once.
 */
export class HumanIdentityRepository {
  private readonly memberships: MembershipStore;
  private readonly devices: DeviceCredentialStore;
  private readonly invitations: InvitationStore;
  private readonly workspaceIdentity: WorkspaceIdentityRepository;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly options: HumanIdentityRepositoryOptions = {}
  ) {
    this.memberships = new MembershipStore(database, clock);
    this.devices = new DeviceCredentialStore(database, clock);
    this.invitations = new InvitationStore(database, clock);
    this.workspaceIdentity = new WorkspaceIdentityRepository(database);
  }

  getPrincipal(humanPrincipalId: string): HumanPrincipal | undefined {
    return this.memberships.getPrincipal(humanPrincipalId);
  }

  getMembership(membershipId: string): ProjectMembership | undefined {
    return this.memberships.getMembership(membershipId);
  }

  getActiveMembership(projectId: string, humanPrincipalId: string): ProjectMembership | undefined {
    return this.memberships.getActiveMembership(projectId, humanPrincipalId);
  }

  areEquivalent(left: string, right: string): boolean {
    return new HumanPrincipalIdentity(this.database).areEquivalent(left, right);
  }

  countActiveOwners(projectId: string): number {
    return this.memberships.countActiveOwners(projectId);
  }

  countActiveMembers(projectId: string): number {
    return this.memberships.countActiveMembers(projectId);
  }

  listActiveMembers(projectId: string, limit = 100, offset = 0): ProjectMembership[] {
    return this.memberships.listActiveMembers(projectId, limit, offset);
  }

  updateHumanDisplayName(humanPrincipalId: string, displayName: string): HumanPrincipal {
    return inWriteTransaction(this.database, () => {
      const principal = this.memberships.updatePrincipalDisplayName(humanPrincipalId, displayName);
      this.database
        .prepare("UPDATE workspace_principals SET display_name=? WHERE human_principal_id=?")
        .run(principal.displayName, principal.humanPrincipalId);
      return principal;
    });
  }

  getInvitation(invitationId: string): ProjectInvitationMetadata | undefined {
    return this.invitations.getInvitation(invitationId);
  }

  /**
   * Lookup invitation metadata by plaintext bearer. Uses constant-time digest compare.
   * Returns undefined for unknown tokens without distinguishing prior validity.
   */
  findInvitationByToken(invitationToken: string): ProjectInvitationMetadata | undefined {
    return this.invitations.findInvitationByToken(invitationToken);
  }

  getDevice(deviceCredentialId: string): HumanDeviceCredentialMetadata | undefined {
    return this.devices.getDevice(deviceCredentialId);
  }

  listDevicesForPrincipal(
    humanPrincipalId: string,
    projectId: string,
    limit = 100,
    offset = 0
  ): HumanDeviceCredentialMetadata[] {
    return this.devices.listDevicesForPrincipal(humanPrincipalId, projectId, limit, offset);
  }

  /**
   * Devices belonging to active members of a project (owner project-device inventory).
   * Does not include digests in higher layers; this returns repository metadata only.
   */
  listDevicesForProjectMembers(
    projectId: string,
    limit = 100,
    offset = 0
  ): HumanDeviceCredentialMetadata[] {
    return this.devices.listDevicesForProjectMembers(projectId, limit, offset);
  }

  listInvitations(
    projectId: string,
    limit = 100,
    offset = 0,
    options: { openOnly?: boolean } = {}
  ): ProjectInvitationMetadata[] {
    return this.invitations.listInvitations(projectId, limit, offset, options);
  }

  /**
   * Local-admin owner bootstrap. Concurrent first owners for different principals conflict.
   * Same principal re-bootstrap is idempotent: does not re-mint when a usable device remains;
   * if every device is revoked/expired, mints a recovery device token (still one owner).
   */
  bootstrapOwner(
    proofInput: unknown,
    options: { deviceLabel?: string; deviceTtlMs?: number } = {}
  ): BootstrapOwnerResult {
    const proof = localAdministrativeProofSchema.parse(proofInput);
    return inWriteTransaction(this.database, () => {
      this.assertNoPendingProjectRestore(proof.projectId);
      const result = this.bootstrapOwnerLocked(proof, options);
      if (result.created) {
        this.options.onMembershipTransitionInTransaction?.({
          type: "member_joined",
          membership: result.membership,
          principal: result.principal
        });
      }
      return result;
    });
  }

  createInvitation(input: {
    projectId: string;
    createdByHumanPrincipalId: string;
    ttlMs?: number;
  }): CreateInvitationResult {
    return inWriteTransaction(this.database, () => {
      const result = this.createInvitationLocked(input);
      this.options.onInvitationTransitionInTransaction?.({
        type: "invitation_created",
        invitation: result.invitation
      });
      return result;
    });
  }

  revokeInvitation(invitationId: string, projectId: string): ProjectInvitationMetadata {
    return inWriteTransaction(this.database, () => {
      const invitation = this.invitations.revokeInvitation(invitationId, projectId);
      this.options.onInvitationTransitionInTransaction?.({
        type: "invitation_revoked",
        invitation
      });
      return invitation;
    });
  }

  revokeInvitations(
    invitationIds: readonly string[],
    projectId: string
  ): ProjectInvitationMetadata[] {
    return inWriteTransaction(this.database, () => {
      const invitations = invitationIds.map((invitationId) => {
        const invitation = this.invitations.getInvitation(invitationId);
        if (!invitation || invitation.projectId !== projectId) {
          throw new HumanIdentityError("human_invitation_invalid");
        }
        if (invitation.consumedAt !== undefined) {
          throw new HumanIdentityError("human_invitation_consumed");
        }
        return invitation;
      });

      return invitations.map((invitation) => {
        if (invitation.revokedAt !== undefined) return invitation;
        const revoked = this.invitations.revokeInvitation(invitation.invitationId, projectId);
        this.options.onInvitationTransitionInTransaction?.({
          type: "invitation_revoked",
          invitation: revoked
        });
        return revoked;
      });
    });
  }

  /**
   * Consume a one-time invitation.
   *
   * - Without a valid existing device token: create a new principal (no display-name lookup;
   *   avoids account enumeration) and mint a device for the join project.
   * - With a valid existing device token: attach membership to that principal and mint a new
   *   device scoped to this project. Does not grant implicit access to any other project.
   */
  consumeInvitation(input: {
    invitationToken: string;
    projectId: string;
    displayName: string;
    deviceLabel?: string;
    deviceTtlMs?: number;
    existingDeviceToken?: string;
  }): ConsumeInvitationResult {
    return inWriteTransaction(this.database, () => {
      this.assertNoPendingProjectRestore(input.projectId);
      const result = this.consumeInvitationLocked(input);
      this.options.onMembershipTransitionInTransaction?.({
        type: "member_joined",
        membership: result.membership,
        principal: result.principal
      });
      this.options.onInvitationTransitionInTransaction?.({
        type: "invitation_consumed",
        invitation: result.invitation
      });
      return result;
    });
  }

  /**
   * Authenticate a human device bearer. Constant-time digest check after hash lookup.
   * Optionally resolve active membership for the immutable project that minted the device.
   */
  authenticateDevice(
    deviceToken: string,
    projectId?: string,
    options: { recordLastUsed?: boolean } = {}
  ): AuthenticatedHumanDevice | undefined {
    const device = this.devices.findDeviceByToken(deviceToken);
    if (!device) return undefined;
    const principal = this.getPrincipal(device.humanPrincipalId);
    if (!principal) return undefined;

    const usability = evaluateDeviceUsability({
      device,
      humanPrincipalId: principal.humanPrincipalId,
      now: this.clock()
    });
    if (!usability.usable) return undefined;

    const workspaceId = this.workspaceIdentity.workspaceForLegacyProject(device.mintedForProjectId);
    if (!workspaceId) return undefined;
    try {
      this.workspaceIdentity.assertReadCutover(workspaceId);
    } catch {
      return undefined;
    }

    let membership: ProjectMembership | undefined;
    if (projectId !== undefined) {
      const pid = humanProjectIdSchema.parse(projectId);
      if (device.mintedForProjectId !== pid) return undefined;
      const targetWorkspace = this.workspaceIdentity.workspaceForLegacyProject(pid);
      if (targetWorkspace !== workspaceId) return undefined;
      try {
        this.workspaceIdentity.assertReadCutover(targetWorkspace);
      } catch {
        return undefined;
      }
      membership = this.getActiveMembership(pid, principal.humanPrincipalId);
      if (!membership) return undefined;
      const workspaceDevice = this.database
        .prepare(
          `SELECT d.revoked_at,d.expires_at,m.revoked_at AS membership_revoked_at
           FROM workspace_device_sessions d
           JOIN workspace_memberships m
             ON m.workspace_id=d.workspace_id AND m.human_principal_id=d.human_principal_id
           WHERE d.workspace_id=? AND d.device_session_id=? AND d.human_principal_id=?
             AND m.revoked_at IS NULL`
        )
        .get(workspaceId, device.deviceCredentialId, principal.humanPrincipalId);
      if (!workspaceDevice || workspaceDevice.revoked_at || workspaceDevice.membership_revoked_at) {
        return undefined;
      }
      if (
        workspaceDevice.expires_at !== null &&
        Date.parse(String(workspaceDevice.expires_at)) <= this.clock().getTime()
      ) {
        return undefined;
      }
    }

    const authenticatedDevice =
      options.recordLastUsed === false
        ? device
        : this.devices.recordLastUsed(device.deviceCredentialId);
    return { principal, device: authenticatedDevice, membership };
  }

  revokeDevice(
    deviceCredentialId: string,
    projectId: string,
    ownerHumanPrincipalId?: string
  ): HumanDeviceCredentialMetadata {
    const revoked = inWriteTransaction(this.database, () => {
      const revoked = this.devices.revokeDevice(
        deviceCredentialId,
        projectId,
        ownerHumanPrincipalId
      );
      const workspaceId = this.workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
      this.syncWorkspaceProject(workspaceId, projectId);
      return revoked;
    });
    const workspaceId = this.workspaceIdentity.workspaceForLegacyProject(projectId);
    if (!workspaceId) throw new Error("workspace_not_found");
    this.options.onAuthorizationChangeAfterCommit?.({
      workspaceId,
      projectId,
      humanPrincipalId: revoked.humanPrincipalId,
      deviceSessionId: revoked.deviceCredentialId
    });
    return revoked;
  }

  /**
   * Soft-revoke membership. Last active owner cannot be removed.
   * Revokes devices minted for this project for the removed principal only.
   * Other projects' memberships and devices are untouched.
   */
  removeMember(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    const membership = inWriteTransaction(this.database, () => {
      this.assertNoPendingProjectRestore(projectId);
      const removed = this.memberships.removeMember(projectId, targetHumanPrincipalId);
      this.devices.revokeProjectDevicesForPrincipal(
        removed.membership.humanPrincipalId,
        removed.membership.projectId,
        removed.revokedAt
      );
      const principal = this.getPrincipal(removed.membership.humanPrincipalId);
      if (!principal) throw new HumanIdentityError("human_input_invalid");
      const workspaceId = this.workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
      this.syncWorkspaceProject(workspaceId, projectId);
      this.options.onMembershipTransitionInTransaction?.({
        type: "member_removed",
        membership: removed.membership,
        principal
      });
      return removed.membership;
    });
    const workspaceId = this.workspaceIdentity.workspaceForLegacyProject(projectId);
    if (!workspaceId) throw new Error("workspace_not_found");
    this.options.onAuthorizationChangeAfterCommit?.({
      workspaceId,
      projectId,
      humanPrincipalId: membership.humanPrincipalId
    });
    return membership;
  }

  promoteToOwner(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    const before = this.getActiveMembership(projectId, targetHumanPrincipalId);
    const membership = inWriteTransaction(this.database, () => {
      this.assertNoPendingProjectRestore(projectId);
      const membership = this.memberships.promoteToOwner(projectId, targetHumanPrincipalId);
      if (before && membership.revision !== before.revision) {
        const principal = this.getPrincipal(membership.humanPrincipalId);
        if (!principal) throw new HumanIdentityError("human_input_invalid");
        this.options.onMembershipTransitionInTransaction?.({
          type: "owner_promoted",
          membership,
          principal
        });
      }
      const workspaceId = this.workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
      this.syncWorkspaceProject(workspaceId, projectId);
      return membership;
    });
    if (before && membership.revision !== before.revision) {
      const workspaceId = this.workspaceIdentity.workspaceForLegacyProject(projectId);
      if (!workspaceId) throw new Error("workspace_not_found");
      this.options.onAuthorizationChangeAfterCommit?.({
        workspaceId,
        projectId,
        humanPrincipalId: membership.humanPrincipalId
      });
    }
    return membership;
  }

  demoteOwner(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    const membership = inWriteTransaction(this.database, () => {
      this.assertNoPendingProjectRestore(projectId);
      const membership = this.memberships.demoteOwner(projectId, targetHumanPrincipalId);
      const principal = this.getPrincipal(membership.humanPrincipalId);
      if (!principal) throw new HumanIdentityError("human_input_invalid");
      const workspaceId = this.workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
      this.syncWorkspaceProject(workspaceId, projectId);
      this.options.onMembershipTransitionInTransaction?.({
        type: "owner_demoted",
        membership,
        principal
      });
      return membership;
    });
    const workspaceId = this.workspaceIdentity.workspaceForLegacyProject(projectId);
    if (!workspaceId) throw new Error("workspace_not_found");
    this.options.onAuthorizationChangeAfterCommit?.({
      workspaceId,
      projectId,
      humanPrincipalId: membership.humanPrincipalId
    });
    return membership;
  }

  private bootstrapOwnerLocked(
    proof: LocalAdministrativeProof,
    options: { deviceLabel?: string; deviceTtlMs?: number }
  ): BootstrapOwnerResult {
    const projectId = proof.projectId;
    const workspaceId = this.workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
    this.workspaceIdentity.assertReadCutover(workspaceId);
    this.assertPrincipalWorkspace(proof.humanPrincipalId, workspaceId);
    const existingOwners = this.memberships.listActiveOwners(projectId);

    const samePrincipal = existingOwners.find((membership) =>
      this.areEquivalent(membership.humanPrincipalId, proof.humanPrincipalId)
    );
    if (existingOwners.length > 0 && !samePrincipal) {
      throw new HumanIdentityError("human_bootstrap_conflict");
    }

    if (samePrincipal) {
      const principal =
        this.getPrincipal(proof.humanPrincipalId) ??
        this.memberships.insertPrincipal(proof.humanPrincipalId, proof.displayName);
      const usable = this.devices.findUsableDeviceForProject(proof.humanPrincipalId, projectId);
      if (usable) {
        this.syncWorkspaceProject(workspaceId, projectId);
        return {
          principal,
          membership: samePrincipal,
          device: usable,
          created: false
        };
      }
      // Recovery: owner membership exists but no active usable device remains.
      // Local-admin re-bootstrap mints a one-shot token without creating a second owner.
      const recovered = this.devices.insertDevice({
        humanPrincipalId: principal.humanPrincipalId,
        mintedForProjectId: projectId,
        label: options.deviceLabel,
        deviceTtlMs: options.deviceTtlMs
      });
      this.syncWorkspaceProject(workspaceId, projectId);
      return {
        principal,
        membership: samePrincipal,
        device: recovered.device,
        deviceToken: recovered.deviceToken,
        created: false
      };
    }

    const principal =
      this.getPrincipal(proof.humanPrincipalId) ??
      this.memberships.insertPrincipal(proof.humanPrincipalId, proof.displayName);

    const membership = this.memberships.insertMembership({
      projectId,
      humanPrincipalId: principal.humanPrincipalId,
      role: "owner"
    });
    const minted = this.devices.insertDevice({
      humanPrincipalId: principal.humanPrincipalId,
      mintedForProjectId: projectId,
      label: options.deviceLabel,
      deviceTtlMs: options.deviceTtlMs
    });
    this.syncWorkspaceProject(workspaceId, projectId);

    return {
      principal,
      membership,
      device: minted.device,
      deviceToken: minted.deviceToken,
      created: true
    };
  }

  private createInvitationLocked(input: {
    projectId: string;
    createdByHumanPrincipalId: string;
    ttlMs?: number;
  }): CreateInvitationResult {
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const createdBy = humanPrincipalIdSchema.parse(input.createdByHumanPrincipalId);
    const creatorMembership = this.getActiveMembership(projectId, createdBy);
    if (!creatorMembership || creatorMembership.role !== "owner") {
      throw new HumanIdentityError("human_role_insufficient");
    }

    if (
      this.invitations.countOpenInvitations(projectId) >= HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT
    ) {
      throw new HumanIdentityError("human_limit_exceeded");
    }
    return this.invitations.insertInvitation({
      ...input,
      projectId,
      createdByHumanPrincipalId: createdBy
    });
  }

  private consumeInvitationLocked(input: {
    invitationToken: string;
    projectId: string;
    displayName: string;
    deviceLabel?: string;
    deviceTtlMs?: number;
    existingDeviceToken?: string;
  }): ConsumeInvitationResult {
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const workspaceId = this.workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
    this.workspaceIdentity.assertReadCutover(workspaceId);
    const invitation = this.invitations.findInvitationByToken(input.invitationToken);
    if (!invitation) throw new HumanIdentityError("human_invitation_invalid");
    const usability = evaluateInvitationUsability({
      invitation,
      projectId,
      now: this.clock()
    });
    if (!usability.usable) {
      throw new HumanIdentityError(usability.code);
    }

    let principal: HumanPrincipal;
    let principalCreated = false;

    if (input.existingDeviceToken !== undefined) {
      const existingToken = humanDeviceTokenSchema.safeParse(input.existingDeviceToken);
      if (!existingToken.success) {
        // Invalid link proof: do not fall through to create, and do not reveal accounts.
        throw new HumanIdentityError("human_auth_unauthenticated");
      }
      const existingDevice = this.devices.findDeviceByToken(existingToken.data);
      if (!existingDevice) throw new HumanIdentityError("human_auth_unauthenticated");
      const existingPrincipal = this.getPrincipal(existingDevice.humanPrincipalId);
      if (!existingPrincipal) {
        throw new HumanIdentityError("human_auth_unauthenticated");
      }
      const deviceUsability = evaluateDeviceUsability({
        device: existingDevice,
        humanPrincipalId: existingPrincipal.humanPrincipalId,
        now: this.clock()
      });
      if (!deviceUsability.usable) {
        throw new HumanIdentityError(deviceUsability.code);
      }
      const sourceWorkspace = this.workspaceIdentity.workspaceForLegacyProject(
        existingDevice.mintedForProjectId
      );
      if (!sourceWorkspace || sourceWorkspace !== workspaceId) {
        throw new HumanIdentityError("human_identity_workspace_mismatch");
      }
      this.workspaceIdentity.assertReadCutover(sourceWorkspace);
      this.assertPrincipalWorkspace(existingPrincipal.humanPrincipalId, workspaceId);
      principal = existingPrincipal;
    } else {
      const displayName = humanDisplayNameSchema.parse(input.displayName);
      principal = this.memberships.insertPrincipal(randomUUID(), displayName);
      principalCreated = true;
    }

    const existingMembership = this.getActiveMembership(projectId, principal.humanPrincipalId);
    if (existingMembership) {
      // Already a member: still consume the invite if open, but do not double-join.
      // Reject to keep invitation single-purpose and avoid silent no-ops that could hide bugs.
      throw new HumanIdentityError("human_input_invalid", "Principal is already an active member.");
    }

    if (this.countActiveMembers(projectId) >= HUMAN_MAX_MEMBERS_PER_PROJECT) {
      throw new HumanIdentityError("human_limit_exceeded");
    }

    const membership = this.memberships.insertMembership({
      projectId,
      humanPrincipalId: principal.humanPrincipalId,
      role: "member"
    });

    const minted = this.devices.insertDevice({
      humanPrincipalId: principal.humanPrincipalId,
      mintedForProjectId: projectId,
      label: input.deviceLabel,
      deviceTtlMs: input.deviceTtlMs
    });

    const consumed = this.invitations.markConsumed(
      invitation.invitationId,
      principal.humanPrincipalId
    );
    this.syncWorkspaceProject(workspaceId, projectId);

    return {
      principal,
      membership,
      device: minted.device,
      deviceToken: minted.deviceToken,
      invitation: consumed,
      principalCreated
    };
  }

  private syncWorkspaceProject(workspaceId: string, projectId: string): void {
    this.workspaceIdentity.assertReadCutover(workspaceId);
    const principals = this.database
      .prepare(
        `SELECT DISTINCT p.human_principal_id,p.display_name,p.created_at
         FROM human_principals p JOIN project_memberships m
           ON m.human_principal_id=p.human_principal_id WHERE m.project_id=?`
      )
      .all(projectId);
    for (const principal of principals) {
      this.assertPrincipalWorkspace(String(principal.human_principal_id), workspaceId);
      const existingPrincipal = this.database
        .prepare(
          `SELECT display_name,created_at,revoked_at FROM workspace_principals
           WHERE workspace_id=? AND human_principal_id=?`
        )
        .get(workspaceId, principal.human_principal_id);
      if (existingPrincipal) {
        if (
          existingPrincipal.display_name !== principal.display_name ||
          existingPrincipal.created_at !== principal.created_at ||
          existingPrincipal.revoked_at !== null
        ) {
          throw new Error("workspace_principal_projection_conflict");
        }
      } else {
        this.database
          .prepare(
            `INSERT INTO workspace_principals(
              workspace_id,human_principal_id,display_name,created_at,revoked_at
            ) VALUES(?,?,?,?,NULL)`
          )
          .run(
            workspaceId,
            principal.human_principal_id,
            principal.display_name,
            principal.created_at
          );
      }
    }
    projectWorkspaceMemberships(this.database, workspaceId, projectId);
    const devices = this.database
      .prepare("SELECT * FROM human_device_credentials WHERE minted_for_project_id=?")
      .all(projectId);
    for (const device of devices) {
      this.database
        .prepare(
          `INSERT INTO workspace_device_sessions(
            workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,
            expires_at,revoked_at,last_used_at
          ) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id,device_session_id) DO UPDATE SET
            expires_at=excluded.expires_at,revoked_at=excluded.revoked_at,last_used_at=excluded.last_used_at`
        )
        .run(
          workspaceId,
          device.device_credential_id,
          device.human_principal_id,
          device.token_sha256,
          device.created_at,
          device.expires_at,
          device.revoked_at,
          device.last_used_at
        );
    }
  }

  private assertNoPendingProjectRestore(projectId: string): void {
    const workspaceId = this.workspaceIdentity.workspaceForLegacyProject(projectId);
    if (workspaceId) assertNoPendingSnapshotRestore(this.database, { workspaceId, projectId });
  }

  private assertPrincipalWorkspace(humanPrincipalId: string, workspaceId: string): void {
    const bound = this.workspaceIdentity.workspaceIdsForHumanPrincipal(humanPrincipalId);
    if (bound.some((candidate) => candidate !== workspaceId)) {
      throw new HumanIdentityError("human_identity_workspace_mismatch");
    }
  }
}

export function isActiveProjectMembership(membership: ProjectMembership): boolean {
  return isActiveMembership(membership);
}
