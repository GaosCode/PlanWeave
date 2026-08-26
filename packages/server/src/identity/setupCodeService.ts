import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  assertSetupRedeemPurposeMatch,
  assertSetupViewRedacted,
  evaluateSetupCodeUsability,
  setupCodeGrantPageSchema,
  setupCodeIssueRequestSchema,
  setupCodeIssueResponseSchema,
  setupCodeListQuerySchema,
  setupCodeRedeemDeviceResponseSchema,
  setupCodeRedeemHostResponseSchema,
  setupCodeRedeemOperatorResponseSchema,
  setupCodeRedeemRequestSchema,
  setupCodeRevokeRequestSchema,
  setupCodeRevocationSchema,
  type SetupCodeGrantPage,
  type SetupCodeIssueResponse,
  type SetupCodeRedeemResponse,
  type SetupCodeRevocation
} from "@planweave-ai/collaboration-protocol/setup";
import {
  collaborationServerOriginSchema,
  isPrivateNetworkHostname,
  workspaceConnectionProfileSchema,
  type WorkspaceConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import {
  humanDeviceTokenSchema,
  operatorCredentialTokenSchema,
  workspaceIdSchema,
  workspaceNameSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { canonicalizeJson } from "@planweave-ai/agent-host-protocol";
import { AgentHostRepository } from "../hosts.js";
import type { OperatorPrincipal } from "../operatorAuth.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { mintHumanDeviceToken, hashHumanToken } from "./crypto.js";
import { OperatorSessionStore } from "./operatorSessionStore.js";
import { mintOperatorCredentialToken } from "./setupCodeCrypto.js";
import {
  SetupCodeStore,
  toSetupCodeGrantView,
  type SetupCodeHostEnrollmentOutcome
} from "./setupCodeStore.js";
import { WorkspaceIdentityRepository } from "./workspaceRepository.js";
import { DeviceCredentialStore } from "./deviceCredentialStore.js";
import { evaluateDeviceUsability } from "./schemas.js";
import { MembershipStore } from "./membershipStore.js";
import { HumanIdentityCredentialStore } from "./humanIdentityCredentialStore.js";
import { HUMAN_IDENTITY_DEFAULT_TTL_MS } from "./limits.js";

const DEFAULT_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_OPERATOR_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_HOST_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export class SetupCodeError extends Error {
  constructor(
    readonly code:
      | "setup_code_invalid"
      | "setup_code_expired"
      | "setup_code_revoked"
      | "setup_code_redeemed"
      | "setup_code_purpose_mismatch"
      | "setup_code_workspace_mismatch"
      | "setup_code_issuer_revoked"
      | "setup_code_not_found"
      | "setup_code_already_revoked"
      | "setup_code_already_redeemed"
      | "setup_code_workspace_archived"
      | "setup_code_malformed"
      | "setup_code_forbidden_capability"
      | "setup_code_existing_identity_invalid"
      | "setup_code_existing_identity_conflict"
      | "workspace_not_found"
      | "workspace_identity_read_cutover_incomplete",
    message?: string
  ) {
    super(message ?? code);
    this.name = "SetupCodeError";
  }
}

export type SetupCodeServiceOptions = {
  database: SqliteDatabase;
  serverBaseUrl: string;
  allowInsecureTransport?: boolean;
  clock?: () => Date;
  deviceSessionTtlMs?: number;
  operatorSessionTtlMs?: number;
  hostCredentialTtlMs?: number;
  identityCredentialTtlMs?: number;
  onWorkspaceDeviceMembershipCreated?: (input: {
    workspaceId: string;
    humanPrincipalId: string;
    role: "owner" | "member";
  }) => void;
};

export class SetupCodeService {
  private readonly database: SqliteDatabase;
  private readonly clock: () => Date;
  private readonly store: SetupCodeStore;
  private readonly workspaceIdentity: WorkspaceIdentityRepository;
  private readonly operators: OperatorSessionStore;
  private readonly hosts: AgentHostRepository;
  private readonly serverBaseUrl: string;
  private readonly allowInsecureTransport: boolean;
  private readonly deviceSessionTtlMs: number;
  private readonly operatorSessionTtlMs: number;
  private readonly hostCredentialTtlMs: number;
  private readonly identityCredentials: HumanIdentityCredentialStore;
  private readonly onWorkspaceDeviceMembershipCreated: SetupCodeServiceOptions["onWorkspaceDeviceMembershipCreated"];

  constructor(options: SetupCodeServiceOptions) {
    this.database = options.database;
    this.clock = options.clock ?? (() => new Date());
    this.store = new SetupCodeStore(options.database, this.clock);
    this.workspaceIdentity = new WorkspaceIdentityRepository(options.database);
    this.operators = new OperatorSessionStore(options.database, this.clock);
    this.hosts = new AgentHostRepository(options.database, this.clock);
    this.serverBaseUrl = collaborationServerOriginSchema.parse(options.serverBaseUrl);
    this.allowInsecureTransport = options.allowInsecureTransport === true;
    this.deviceSessionTtlMs = options.deviceSessionTtlMs ?? DEFAULT_DEVICE_TTL_MS;
    this.operatorSessionTtlMs = options.operatorSessionTtlMs ?? DEFAULT_OPERATOR_SESSION_TTL_MS;
    this.hostCredentialTtlMs = options.hostCredentialTtlMs ?? DEFAULT_HOST_CREDENTIAL_TTL_MS;
    this.identityCredentials = new HumanIdentityCredentialStore(
      options.database,
      this.clock,
      options.identityCredentialTtlMs ?? HUMAN_IDENTITY_DEFAULT_TTL_MS
    );
    this.onWorkspaceDeviceMembershipCreated = options.onWorkspaceDeviceMembershipCreated;
    this.assertTransportPolicy(this.serverBaseUrl, this.allowInsecureTransport);
  }

  issue(principal: OperatorPrincipal, rawRequest: unknown): SetupCodeIssueResponse {
    const request = setupCodeIssueRequestSchema.parse(rawRequest);
    this.authorizeWorkspace(principal, request.workspaceId);
    const workspaceId = workspaceIdSchema.parse(request.workspaceId);
    this.assertWorkspaceUsable(workspaceId);
    const now = this.clock();
    const credentialExpiresAt =
      request.purpose === "host_enrollment"
        ? new Date(now.getTime() + this.hostCredentialTtlMs).toISOString()
        : null;
    const { grant, setupCode } = inWriteTransaction(this.database, () =>
      this.store.insertGrant({
        workspaceId,
        purpose: request.purpose,
        ttlMs: request.ttlMs,
        issuer: {
          operatorId: principal.operatorId,
          operatorSessionId: principal.operatorSessionId
        },
        credentialExpiresAt
      })
    );
    const response = setupCodeIssueResponseSchema.parse({
      schemaVersion: "workspace-setup/v1",
      grant: toSetupCodeGrantView(grant, now),
      setupCode,
      displayOnce: true
    });
    assertSetupViewRedacted({
      schemaVersion: response.schemaVersion,
      grant: response.grant,
      displayOnce: response.displayOnce
    });
    return response;
  }

  list(principal: OperatorPrincipal, workspaceId: string, rawQuery: unknown): SetupCodeGrantPage {
    const parsedWorkspaceId = workspaceIdSchema.parse(workspaceId);
    this.authorizeWorkspace(principal, parsedWorkspaceId);
    this.assertWorkspaceUsable(parsedWorkspaceId);
    const query = setupCodeListQuerySchema.parse(rawQuery ?? {});
    const grants = this.store.listForWorkspace(parsedWorkspaceId, {
      cursor: query.cursor,
      limit: query.limit + 1,
      openOnly: query.openOnly
    });
    const now = this.clock();
    const page = setupCodeGrantPageSchema.parse({
      schemaVersion: "workspace-setup/v1",
      items: grants.slice(0, query.limit).map((grant) => toSetupCodeGrantView(grant, now)),
      nextCursor: grants.length > query.limit ? query.cursor + query.limit : null
    });
    assertSetupViewRedacted(page);
    return page;
  }

  revoke(principal: OperatorPrincipal, rawRequest: unknown): SetupCodeRevocation {
    const request = setupCodeRevokeRequestSchema.parse(rawRequest);
    const grant = this.store.getById(request.setupCodeId);
    if (!grant) throw new SetupCodeError("setup_code_not_found");
    this.authorizeWorkspace(principal, grant.workspaceId);
    try {
      const revocation = inWriteTransaction(this.database, () =>
        this.store.revoke(request.setupCodeId, request.reason)
      );
      return setupCodeRevocationSchema.parse(revocation);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "setup_code_already_revoked") {
          throw new SetupCodeError("setup_code_already_revoked");
        }
        if (error.message === "setup_code_already_redeemed") {
          throw new SetupCodeError("setup_code_already_redeemed");
        }
        if (error.message === "setup_code_not_found") {
          throw new SetupCodeError("setup_code_not_found");
        }
      }
      throw error;
    }
  }

  redeem(rawRequest: unknown): SetupCodeRedeemResponse {
    let request: ReturnType<typeof setupCodeRedeemRequestSchema.parse>;
    try {
      request = setupCodeRedeemRequestSchema.parse(rawRequest);
    } catch {
      throw new SetupCodeError("setup_code_malformed");
    }
    this.rejectForbiddenFields(rawRequest);
    return inWriteTransaction(this.database, () => this.redeemLocked(request));
  }

  get identityCredentialStore(): HumanIdentityCredentialStore {
    return this.identityCredentials;
  }

  private redeemLocked(
    request: ReturnType<typeof setupCodeRedeemRequestSchema.parse>
  ): SetupCodeRedeemResponse {
    const found = this.store.findByToken(request.setupCode);
    if (!found) throw new SetupCodeError("setup_code_invalid");
    try {
      assertSetupRedeemPurposeMatch(found, request);
    } catch {
      throw new SetupCodeError("setup_code_purpose_mismatch");
    }
    if (request.purpose === "host_enrollment") {
      const outcome = this.store.findHostEnrollmentOutcome(found.setupCodeId);
      if (outcome) return this.resumeHostEnrollment(found, request, outcome);
    }
    this.assertWorkspaceUsable(found.workspaceId);
    this.assertIssuerUsable(found);
    const usability = evaluateSetupCodeUsability({
      grant: found,
      workspaceId: found.workspaceId,
      purpose: request.purpose,
      now: this.clock(),
      requireDisplayed: true
    });
    if (!usability.usable) {
      if (usability.state === "expired") throw new SetupCodeError("setup_code_expired");
      if (usability.state === "revoked") throw new SetupCodeError("setup_code_revoked");
      if (usability.state === "redeemed") throw new SetupCodeError("setup_code_redeemed");
      if (usability.state === "workspace_mismatch") {
        throw new SetupCodeError("setup_code_workspace_mismatch");
      }
      if (usability.state === "purpose_mismatch") {
        throw new SetupCodeError("setup_code_purpose_mismatch");
      }
      throw new SetupCodeError("setup_code_invalid");
    }

    if (request.purpose === "device_session") {
      return this.redeemDevice(found, request);
    }
    if (request.purpose === "operator_session") {
      return this.redeemOperator(found, request.displayName);
    }
    return this.redeemHost(found, request);
  }

  private redeemDevice(
    grant: NonNullable<ReturnType<SetupCodeStore["findByToken"]>>,
    request: Extract<
      ReturnType<typeof setupCodeRedeemRequestSchema.parse>,
      { purpose: "device_session" }
    >
  ) {
    void request.deviceLabel;
    const now = this.clock();
    const workspace = this.workspaceIdentity.workspaceView(grant.workspaceId);
    const displayName = request.displayName;
    const humanPrincipalId = this.resolveRedeemedHumanPrincipal(
      request.existingIdentityToken,
      request.existingDeviceToken,
      displayName
    );
    const membershipId = `membership-${randomUUID()}`;
    const deviceSessionId = `device-session-${randomUUID()}`;
    const deviceToken = humanDeviceTokenSchema.parse(mintHumanDeviceToken());
    const credentialSha256 = hashHumanToken(deviceToken);
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.deviceSessionTtlMs).toISOString();
    const existingMembership = this.workspaceIdentity.findActiveMembership(
      grant.workspaceId,
      humanPrincipalId
    );
    const activeMembers = this.countActiveMembers(grant.workspaceId);
    const role = existingMembership?.role ?? (activeMembers === 0 ? "owner" : "member");

    this.database
      .prepare(
        `INSERT OR IGNORE INTO workspace_principals(
          workspace_id,human_principal_id,display_name,created_at,revoked_at
        ) VALUES(?,?,?,?,NULL)`
      )
      .run(grant.workspaceId, humanPrincipalId, displayName, issuedAt);
    if (!existingMembership) {
      this.database
        .prepare(
          `INSERT INTO workspace_memberships(
            workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
          ) VALUES(?,?,?,?,1,?,?,NULL)`
        )
        .run(grant.workspaceId, membershipId, humanPrincipalId, role, issuedAt, issuedAt);
    }
    this.database
      .prepare(
        `INSERT INTO workspace_device_sessions(
          workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,
          expires_at,revoked_at,last_used_at
        ) VALUES(?,?,?,?,?,?,NULL,NULL)`
      )
      .run(
        grant.workspaceId,
        deviceSessionId,
        humanPrincipalId,
        credentialSha256,
        issuedAt,
        expiresAt
      );
    if (!existingMembership) {
      this.onWorkspaceDeviceMembershipCreated?.({
        workspaceId: grant.workspaceId,
        humanPrincipalId,
        role
      });
    }
    this.store.markRedeemed(grant.setupCodeId, deviceSessionId);

    const identity = this.identityCredentials.issue(humanPrincipalId);
    const connectionProfile = this.connectionProfile(grant.workspaceId, workspace.displayName);
    const response = setupCodeRedeemDeviceResponseSchema.parse({
      schemaVersion: "workspace-setup/v1",
      purpose: "device_session",
      workspaceId: grant.workspaceId,
      workspaceDisplayName: workspace.displayName,
      connectionProfile,
      humanPrincipalId,
      membershipId: existingMembership?.membershipId ?? membershipId,
      role,
      deviceSessionId,
      deviceToken,
      deviceExpiresAt: expiresAt,
      identityCredentialId: identity.record.identityCredentialId,
      identityToken: identity.identityToken,
      identityExpiresAt: identity.record.expiresAt
    });
    assertSetupViewRedacted({
      schemaVersion: response.schemaVersion,
      purpose: response.purpose,
      workspaceId: response.workspaceId,
      workspaceDisplayName: response.workspaceDisplayName,
      connectionProfile: response.connectionProfile,
      humanPrincipalId: response.humanPrincipalId,
      membershipId: response.membershipId,
      role: response.role,
      deviceSessionId: response.deviceSessionId,
      deviceExpiresAt: response.deviceExpiresAt,
      identityCredentialId: response.identityCredentialId,
      identityExpiresAt: response.identityExpiresAt
    });
    return response;
  }

  private redeemOperator(
    grant: NonNullable<ReturnType<SetupCodeStore["findByToken"]>>,
    displayName: string
  ) {
    void displayName;
    const now = this.clock();
    const workspace = this.workspaceIdentity.workspaceView(grant.workspaceId);
    const operatorId = `operator-${randomUUID()}`;
    const operatorSessionId = `operator-session-${randomUUID()}`;
    const operatorToken = operatorCredentialTokenSchema.parse(mintOperatorCredentialToken());
    const credentialSha256 = createHash("sha256").update(operatorToken).digest("hex");
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.operatorSessionTtlMs).toISOString();
    this.operators.create({
      workspaceId: grant.workspaceId,
      operatorSessionId,
      operatorId,
      credentialSha256,
      issuedAt,
      expiresAt
    });
    this.store.markRedeemed(grant.setupCodeId, operatorSessionId);
    const connectionProfile = this.connectionProfile(grant.workspaceId, workspace.displayName);
    const response = setupCodeRedeemOperatorResponseSchema.parse({
      schemaVersion: "workspace-setup/v1",
      purpose: "operator_session",
      workspaceId: grant.workspaceId,
      workspaceDisplayName: workspace.displayName,
      connectionProfile,
      operatorId,
      operatorSessionId,
      operatorToken,
      sessionExpiresAt: expiresAt
    });
    assertSetupViewRedacted({
      schemaVersion: response.schemaVersion,
      purpose: response.purpose,
      workspaceId: response.workspaceId,
      workspaceDisplayName: response.workspaceDisplayName,
      connectionProfile: response.connectionProfile,
      operatorId: response.operatorId,
      operatorSessionId: response.operatorSessionId,
      sessionExpiresAt: response.sessionExpiresAt
    });
    return response;
  }

  private redeemHost(
    grant: NonNullable<ReturnType<SetupCodeStore["findByToken"]>>,
    request: Extract<
      ReturnType<typeof setupCodeRedeemRequestSchema.parse>,
      { purpose: "host_enrollment" }
    >
  ) {
    const now = this.clock();
    const workspace = this.workspaceIdentity.workspaceView(grant.workspaceId);
    const credentialExpiresAt =
      grant.credentialExpiresAt ?? new Date(now.getTime() + this.hostCredentialTtlMs).toISOString();
    if (Date.parse(credentialExpiresAt) <= now.getTime()) {
      throw new SetupCodeError("setup_code_expired");
    }
    const registration = this.hosts.registerWithCredential(
      request.displayName,
      request.hostCredentialToken,
      request.capabilities,
      request.capacity,
      credentialExpiresAt
    );
    this.hosts.bindToWorkspace(registration.host.id, grant.workspaceId);
    const enrollmentId = `enrollment-setup-${grant.setupCodeId}`;
    this.database
      .prepare(
        `INSERT INTO workspace_host_enrollments(
          workspace_id,enrollment_id,enrollment_code_sha256,credential_expires_at,expires_at,
          used_at,host_id,revoked_at,created_at
        ) VALUES(?,?,?,?,?,?,?,NULL,?)`
      )
      .run(
        grant.workspaceId,
        enrollmentId,
        grant.codeSha256,
        credentialExpiresAt,
        grant.expiresAt,
        now.toISOString(),
        registration.host.id,
        grant.issuedAt
      );
    this.store.insertHostEnrollmentOutcome({
      setupCodeId: grant.setupCodeId,
      enrollmentAttemptId: request.enrollmentAttemptId,
      requestSha256: this.hostEnrollmentRequestSha256(request),
      enrollmentId,
      hostId: registration.host.id,
      credentialExpiresAt,
      createdAt: now.toISOString()
    });
    this.store.markRedeemed(grant.setupCodeId, registration.host.id);
    const connectionProfile = this.connectionProfile(grant.workspaceId, workspace.displayName);
    const response = setupCodeRedeemHostResponseSchema.parse({
      schemaVersion: "workspace-setup/v1",
      purpose: "host_enrollment",
      workspaceId: grant.workspaceId,
      workspaceDisplayName: workspace.displayName,
      connectionProfile,
      enrollmentAttemptId: request.enrollmentAttemptId,
      enrollmentId,
      hostId: registration.host.id,
      hostCredentialExpiresAt: credentialExpiresAt
    });
    assertSetupViewRedacted(response);
    return response;
  }

  private resumeHostEnrollment(
    grant: NonNullable<ReturnType<SetupCodeStore["findByToken"]>>,
    request: Extract<
      ReturnType<typeof setupCodeRedeemRequestSchema.parse>,
      { purpose: "host_enrollment" }
    >,
    outcome: SetupCodeHostEnrollmentOutcome
  ) {
    if (
      grant.redeemedAt === null ||
      grant.redemptionSubjectId !== outcome.hostId ||
      outcome.enrollmentAttemptId !== request.enrollmentAttemptId ||
      outcome.requestSha256 !== this.hostEnrollmentRequestSha256(request)
    ) {
      throw new SetupCodeError("setup_code_redeemed");
    }
    this.assertWorkspaceUsable(grant.workspaceId);
    const workspace = this.workspaceIdentity.workspaceView(grant.workspaceId);
    const response = setupCodeRedeemHostResponseSchema.parse({
      schemaVersion: "workspace-setup/v1",
      purpose: "host_enrollment",
      workspaceId: grant.workspaceId,
      workspaceDisplayName: workspace.displayName,
      connectionProfile: this.connectionProfile(grant.workspaceId, workspace.displayName),
      enrollmentAttemptId: outcome.enrollmentAttemptId,
      enrollmentId: outcome.enrollmentId,
      hostId: outcome.hostId,
      hostCredentialExpiresAt: outcome.credentialExpiresAt
    });
    assertSetupViewRedacted(response);
    return response;
  }

  private hostEnrollmentRequestSha256(
    request: Extract<
      ReturnType<typeof setupCodeRedeemRequestSchema.parse>,
      { purpose: "host_enrollment" }
    >
  ): string {
    return createHash("sha256")
      .update(
        canonicalizeJson({
          enrollmentAttemptId: request.enrollmentAttemptId,
          credentialTokenSha256: createHash("sha256")
            .update(request.hostCredentialToken)
            .digest("hex"),
          displayName: request.displayName,
          capabilities: request.capabilities,
          capacity: request.capacity
        })
      )
      .digest("hex");
  }

  private connectionProfile(workspaceId: string, displayName: string): WorkspaceConnectionProfile {
    const profileId = `profile-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 24)}`;
    return workspaceConnectionProfileSchema.parse({
      schemaVersion: "workspace-identity/v1",
      profileId,
      displayName: workspaceNameSchema.parse(displayName),
      serverBaseUrl: this.serverBaseUrl,
      workspaceId,
      allowInsecureTransport: this.allowInsecureTransport
    });
  }

  private authorizeWorkspace(principal: OperatorPrincipal, workspaceId: string): void {
    if (principal.serverAdmin) return;
    if (principal.workspaceId !== workspaceId) {
      throw new Error("operator_workspace_forbidden");
    }
  }

  private assertWorkspaceUsable(workspaceId: string): void {
    if (!this.workspaceIdentity.workspaceExists(workspaceId)) {
      throw new SetupCodeError("workspace_not_found");
    }
    try {
      this.workspaceIdentity.assertReadCutover(workspaceId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "workspace_identity_read_cutover_incomplete"
      ) {
        throw new SetupCodeError("workspace_identity_read_cutover_incomplete");
      }
      throw error;
    }
    const view = this.workspaceIdentity.workspaceView(workspaceId);
    if (view.archivedAt !== null) {
      throw new SetupCodeError("setup_code_workspace_archived");
    }
  }

  private assertIssuerUsable(grant: NonNullable<ReturnType<SetupCodeStore["findByToken"]>>): void {
    if (!grant.issuer) return;
    const session =
      this.operators.findBySessionId(grant.workspaceId, grant.issuer.operatorSessionId) ??
      this.operators.findBySessionIdAcrossWorkspaces(grant.issuer.operatorSessionId);
    if (!session || session.revokedAt !== null) {
      throw new SetupCodeError("setup_code_issuer_revoked");
    }
    if (session.operatorId !== grant.issuer.operatorId) {
      throw new SetupCodeError("setup_code_issuer_revoked");
    }
  }

  private countActiveMembers(workspaceId: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM workspace_memberships
         WHERE workspace_id=? AND revoked_at IS NULL`
      )
      .get(workspaceId) as { count: number };
    return Number(row.count);
  }

  private resolveRedeemedHumanPrincipal(
    existingIdentityToken: string | undefined,
    existingDeviceToken: string | undefined,
    displayName: string
  ): string {
    const principals = new MembershipStore(this.database, this.clock);
    if (existingIdentityToken !== undefined) {
      const identity = this.identityCredentials.authenticate(existingIdentityToken);
      if (!identity) throw new SetupCodeError("setup_code_existing_identity_invalid");
      const existingId = this.identityCredentials.resolveCanonicalHumanPrincipalId(
        identity.humanPrincipalId
      );
      principals.insertPrincipal(existingId, displayName);
      return existingId;
    }
    if (existingDeviceToken !== undefined) {
      const existingId = this.lookupExistingHumanPrincipal(existingDeviceToken);
      if (!existingId) throw new SetupCodeError("setup_code_existing_identity_invalid");
      const canonical = this.identityCredentials.resolveCanonicalHumanPrincipalId(existingId);
      principals.insertPrincipal(canonical, displayName);
      return canonical;
    }
    const humanPrincipalId = `human-${randomUUID()}`;
    principals.insertPrincipal(humanPrincipalId, displayName);
    return humanPrincipalId;
  }

  lookupExistingHumanPrincipal(deviceToken: string): string | undefined {
    const workspaceSession = this.workspaceIdentity.authenticateWorkspaceDeviceSession(deviceToken);
    if (workspaceSession) return workspaceSession.humanPrincipalId;
    const device = new DeviceCredentialStore(this.database, this.clock).findDeviceByToken(
      deviceToken
    );
    if (!device) return undefined;
    const usability = evaluateDeviceUsability({
      device,
      humanPrincipalId: device.humanPrincipalId,
      now: this.clock()
    });
    return usability.usable ? device.humanPrincipalId : undefined;
  }

  private rejectForbiddenFields(rawRequest: unknown): void {
    if (!rawRequest || typeof rawRequest !== "object") return;
    const forbidden = [
      "projectRoot",
      "project_root",
      "command",
      "args",
      "executable",
      "environment",
      "env",
      "directory",
      "path",
      "upload",
      "download",
      "sync",
      "billing",
      "subscription",
      "license",
      "entitlement",
      "crdt",
      "ssh",
      "vps",
      "watch"
    ];
    for (const key of Object.keys(rawRequest as Record<string, unknown>)) {
      if (forbidden.includes(key)) {
        throw new SetupCodeError("setup_code_forbidden_capability");
      }
    }
  }

  private assertTransportPolicy(serverBaseUrl: string, allowInsecureTransport: boolean): void {
    const url = new URL(serverBaseUrl);
    if (url.protocol !== "https:" && !allowInsecureTransport) {
      throw new Error("setup_server_base_url_requires_https");
    }
    if (
      allowInsecureTransport &&
      url.protocol === "http:" &&
      !isPrivateNetworkHostname(url.hostname)
    ) {
      throw new Error("setup_server_base_url_insecure_non_loopback");
    }
  }
}

/** Test helper: create a random host credential token. */
export function mintHostCredentialTokenForTests(): string {
  return `pw_host_${randomBytes(32).toString("base64url")}`;
}
