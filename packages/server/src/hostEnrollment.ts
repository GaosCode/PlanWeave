import { createHash, randomBytes } from "node:crypto";
import {
  canonicalizeJson,
  hostEnrollmentCompletedSchema,
  hostEnrollmentRequestSchema,
  hostCredentialPolicySchema,
  opaqueIdentifierSchema,
  type HostEnrollmentCompleted,
  type HostEnrollmentErrorCode,
  type HostEnrollmentRequest,
  type HostCredentialPolicy
} from "@planweave-ai/agent-host-protocol";
import { humanPrincipalIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { AgentHostRepository } from "./hosts.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import {
  copyHostRemoteAgentDefaults,
  writeHostRemoteAgentDefaults
} from "./remoteAgent/hostDefaults.js";
import { remoteAgentAccessModeSchema, type RemoteAgentAccessMode } from "./remoteAgent/schema.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

type EnrollmentGrantRow = {
  code_hash: string;
  expires_at: string;
  credential_expires_at: string;
  credential_lifetime_days: number | null;
  revoked_at: string | null;
  used_at: string | null;
  used_attempt_id: string | null;
  used_request_hash: string | null;
  host_id: string | null;
  created_at: string;
  owner_human_principal_id: string | null;
  access_mode: string | null;
  create_workspace_grant: number;
};

type HostEnrollmentExchangeResult = {
  completed: HostEnrollmentCompleted;
  supersededHostId?: string;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class HostEnrollmentError extends Error {
  constructor(readonly code: HostEnrollmentErrorCode) {
    super("Agent Host enrollment was rejected.");
    this.name = "HostEnrollmentError";
  }
}

export class HostEnrollmentService {
  private readonly hosts: AgentHostRepository;
  private readonly workspaceIdentity: WorkspaceIdentityRepository;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly onHostSuperseded?: (hostId: string) => void
  ) {
    this.hosts = new AgentHostRepository(database, clock);
    this.workspaceIdentity = new WorkspaceIdentityRepository(database);
  }

  createGrant(options: {
    workspaceId?: string;
    expiresAt: Date;
    credentialPolicy: HostCredentialPolicy;
    ownerHumanPrincipalId?: string;
    accessMode?: RemoteAgentAccessMode;
    createWorkspaceGrant?: boolean;
  }): {
    enrollmentCode: string;
    workspaceId?: string;
    expiresAt: string;
    credentialExpiresAt: string;
    credentialPolicy: HostCredentialPolicy;
  } {
    const workspaceId =
      options.workspaceId === undefined
        ? undefined
        : opaqueIdentifierSchema.parse(options.workspaceId);
    if (workspaceId !== undefined) {
      if (!this.workspaceIdentity.workspaceExists(workspaceId)) {
        throw new Error("workspace_not_found");
      }
      this.workspaceIdentity.assertReadCutover(workspaceId);
    }
    const ownerHumanPrincipalId =
      options.ownerHumanPrincipalId === undefined
        ? undefined
        : humanPrincipalIdSchema.parse(options.ownerHumanPrincipalId);
    const accessMode =
      options.accessMode === undefined
        ? undefined
        : remoteAgentAccessModeSchema.parse(options.accessMode);
    const createWorkspaceGrant = options.createWorkspaceGrant === true;
    if ((ownerHumanPrincipalId === undefined) !== (accessMode === undefined)) {
      throw new Error(
        ownerHumanPrincipalId === undefined
          ? "host_enrollment_access_mode_requires_owner"
          : "host_enrollment_owner_access_mode_required"
      );
    }
    if (createWorkspaceGrant && workspaceId === undefined) {
      throw new Error("host_enrollment_workspace_grant_requires_workspace");
    }
    if (createWorkspaceGrant && ownerHumanPrincipalId === undefined) {
      throw new Error("host_enrollment_workspace_grant_requires_owner");
    }
    if (ownerHumanPrincipalId !== undefined) {
      const owner = this.database
        .prepare("SELECT 1 FROM human_principals WHERE human_principal_id=?")
        .get(ownerHumanPrincipalId);
      if (!owner) throw new Error("host_enrollment_owner_not_found");
    }
    const now = this.clock();
    const credentialPolicy = hostCredentialPolicySchema.parse(options.credentialPolicy);
    const credentialExpiresAt = new Date(
      now.getTime() + credentialPolicy.lifetimeDays * 24 * 60 * 60_000
    );
    if (
      options.expiresAt.getTime() <= now.getTime() ||
      credentialExpiresAt.getTime() <= options.expiresAt.getTime()
    ) {
      throw new Error("host_enrollment_grant_expiry_invalid");
    }
    const enrollmentCode = `pw_enroll_${randomBytes(32).toString("base64url")}`;
    const codeHash = hash(enrollmentCode);
    inWriteTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO agent_host_enrollment_grants(
            code_hash,expires_at,credential_expires_at,credential_lifetime_days,created_at,
            owner_human_principal_id,access_mode,create_workspace_grant
          ) VALUES(?,?,?,?,?,?,?,?)`
        )
        .run(
          codeHash,
          options.expiresAt.toISOString(),
          credentialExpiresAt.toISOString(),
          credentialPolicy.lifetimeDays,
          now.toISOString(),
          ownerHumanPrincipalId ?? null,
          accessMode ?? null,
          createWorkspaceGrant ? 1 : 0
        );
      if (workspaceId !== undefined) {
        this.workspaceIdentity.bindEnrollmentToWorkspace(codeHash, workspaceId);
      }
    });
    return {
      enrollmentCode,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      expiresAt: options.expiresAt.toISOString(),
      credentialExpiresAt: credentialExpiresAt.toISOString(),
      credentialPolicy
    };
  }

  revokeGrant(enrollmentCode: string): void {
    const codeHash = hash(enrollmentCode);
    const updated = this.database
      .prepare(
        "UPDATE agent_host_enrollment_grants SET revoked_at=? WHERE code_hash=? AND revoked_at IS NULL"
      )
      .run(this.clock().toISOString(), codeHash);
    if (updated.changes !== 1) throw new Error("host_enrollment_grant_not_found_or_revoked");
    this.workspaceIdentity.synchronizeEnrollment(codeHash);
  }

  /** Explicitly authorize an enrollment grant for one workspace. */
  bindGrantToWorkspace(enrollmentCode: string, workspaceId: string): void {
    this.workspaceIdentity.bindEnrollmentToWorkspace(hash(enrollmentCode), workspaceId);
  }

  exchange(input: unknown): HostEnrollmentCompleted {
    const request = hostEnrollmentRequestSchema.parse(input);
    const result = inWriteTransaction(this.database, () => this.exchangeLocked(request));
    if (result.supersededHostId) this.onHostSuperseded?.(result.supersededHostId);
    return result.completed;
  }

  private exchangeLocked(request: HostEnrollmentRequest): HostEnrollmentExchangeResult {
    const row = this.database
      .prepare("SELECT * FROM agent_host_enrollment_grants WHERE code_hash=?")
      .get(hash(request.enrollmentCode)) as EnrollmentGrantRow | undefined;
    if (!row) throw new HostEnrollmentError("invalid");
    if (row.credential_lifetime_days === null) throw new HostEnrollmentError("invalid");
    const credentialPolicy = hostCredentialPolicySchema.parse({
      lifetimeDays: row.credential_lifetime_days,
      renewal: "automatic"
    });
    const workspaceId = this.workspaceIdentity.workspaceForEnrollment(row.code_hash);
    const now = this.clock();
    if (row.revoked_at) throw new HostEnrollmentError("revoked");
    if (Date.parse(row.expires_at) <= now.getTime()) throw new HostEnrollmentError("expired");
    const requestHash = hash(
      canonicalizeJson({
        enrollmentAttemptId: request.enrollmentAttemptId,
        installationId: request.installationId,
        supersedesHostId: request.supersedesHostId ?? null,
        credentialTokenHash: hash(request.credentialToken),
        displayName: request.displayName,
        capabilities: request.capabilities,
        capacity: request.capacity
      })
    );
    if (row.used_at) {
      if (
        row.used_attempt_id !== request.enrollmentAttemptId ||
        row.used_request_hash !== requestHash ||
        !row.host_id
      ) {
        throw new HostEnrollmentError("conflict");
      }
      return {
        completed: hostEnrollmentCompletedSchema.parse({
          type: "host.enrollment.completed",
          protocolVersion: 1,
          enrollmentAttemptId: request.enrollmentAttemptId,
          hostId: row.host_id,
          ...(workspaceId === undefined ? {} : { workspaceId }),
          credentialExpiresAt: row.credential_expires_at,
          credentialPolicy
        })
      };
    }
    let registration: ReturnType<AgentHostRepository["registerInstallationGeneration"]>;
    try {
      registration = this.hosts.registerInstallationGeneration({
        installationId: request.installationId,
        supersedesHostId: request.supersedesHostId,
        displayName: request.displayName,
        token: request.credentialToken,
        capabilities: request.capabilities,
        capacity: request.capacity,
        credentialExpiresAt: row.credential_expires_at,
        credentialPolicy
      });
    } catch (error) {
      if (error instanceof Error && error.message === "agent_host_installation_conflict") {
        throw new HostEnrollmentError("conflict");
      }
      throw error;
    }
    if (workspaceId !== undefined) {
      this.hosts.bindToWorkspace(registration.host.id, workspaceId);
    }
    const updated = this.database
      .prepare(
        `UPDATE agent_host_enrollment_grants
         SET used_at=?,used_attempt_id=?,used_request_hash=?,host_id=?
         WHERE code_hash=? AND used_at IS NULL`
      )
      .run(
        now.toISOString(),
        request.enrollmentAttemptId,
        requestHash,
        registration.host.id,
        row.code_hash
      );
    if (updated.changes !== 1) throw new HostEnrollmentError("conflict");
    this.workspaceIdentity.synchronizeEnrollment(row.code_hash);
    this.persistHostRemoteAgentDefaults({
      hostId: registration.host.id,
      supersededHostId: registration.supersededHostId,
      grant: row,
      workspaceId,
      updatedAt: now.toISOString()
    });
    return {
      completed: hostEnrollmentCompletedSchema.parse({
        type: "host.enrollment.completed",
        protocolVersion: 1,
        enrollmentAttemptId: request.enrollmentAttemptId,
        hostId: registration.host.id,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        credentialExpiresAt: row.credential_expires_at,
        credentialPolicy
      }),
      ...(registration.supersededHostId ? { supersededHostId: registration.supersededHostId } : {})
    };
  }

  private persistHostRemoteAgentDefaults(input: {
    hostId: string;
    supersededHostId?: string;
    grant: EnrollmentGrantRow;
    workspaceId?: string;
    updatedAt: string;
  }): void {
    const ownerHumanPrincipalId = input.grant.owner_human_principal_id;
    const accessMode =
      input.grant.access_mode === null
        ? undefined
        : remoteAgentAccessModeSchema.parse(input.grant.access_mode);
    const createWorkspaceGrant = Number(input.grant.create_workspace_grant) === 1;
    if (ownerHumanPrincipalId !== null && accessMode !== undefined) {
      writeHostRemoteAgentDefaults(this.database, {
        hostId: input.hostId,
        ownerHumanPrincipalId,
        accessMode,
        createWorkspaceGrant,
        grantWorkspaceId: createWorkspaceGrant ? (input.workspaceId ?? null) : null,
        updatedAt: input.updatedAt
      });
      return;
    }
    if (input.supersededHostId === undefined) return;
    copyHostRemoteAgentDefaults(this.database, {
      fromHostId: input.supersededHostId,
      toHostId: input.hostId,
      updatedAt: input.updatedAt
    });
  }
}
