import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { randomBytes, randomUUID } from "node:crypto";
import {
  hostEnrollmentCompletedSchema,
  parseAgentHostSetupHandoff,
  type HostEnrollmentCompleted,
  type HostEnrollmentRequest
} from "@planweave-ai/agent-host-protocol";
import { setupCodeTokenSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { AgentHostConfig } from "../config/schema.js";
import type {
  ActiveHostCredential,
  PendingHostEnrollment
} from "../credentials/credentialContract.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import {
  createPendingPortableHandoffProvenance,
  portableHandoffEndpointBindingMatches,
  portableHandoffPendingWorkspaceId
} from "../credentials/handoffProvenance.js";
import type { HttpAgentHostSetupCodeRedeem } from "./httpSetupCodeRedeem.js";
import { ensureHostInstallationIdentity } from "../state/hostInstallationIdentity.js";

export interface AgentHostEnrollmentExchange {
  exchange(request: HostEnrollmentRequest, signal?: AbortSignal): Promise<HostEnrollmentCompleted>;
}

export class AgentHostEnrollmentService {
  constructor(
    private readonly config: AgentHostConfig,
    private readonly credentials: FileHostCredentialStore,
    private readonly exchange: AgentHostEnrollmentExchange,
    private readonly clock: () => Date = () => new Date(),
    private readonly setupRedeem?: HttpAgentHostSetupCodeRedeem
  ) {}

  async enroll(
    code: string,
    options: { replaceExisting?: boolean; signal?: AbortSignal } = {}
  ): Promise<ActiveHostCredential> {
    if (setupCodeTokenSchema.safeParse(code).success) {
      return this.enrollWithSetupCode(code, options);
    }
    const pending: PendingHostEnrollment = {
      kind: "host_enrollment_code",
      enrollmentAttemptId: `enroll-${randomUUID()}`,
      enrollmentCode: code,
      credentialToken: `pw_host_${randomBytes(32).toString("base64url")}`,
      createdAt: this.clock().toISOString()
    };
    await this.credentials.begin(pending, options.replaceExisting === true);
    return this.completeEnrollmentCode(pending, options.signal);
  }

  async resume(signal?: AbortSignal): Promise<ActiveHostCredential> {
    const pending = (await this.credentials.read())?.pending;
    if (!pending) throw new Error("agent_host_enrollment_not_pending");
    if (pending.kind === "setup_code") return this.completeSetupCode(pending, signal);
    return this.completeEnrollmentCode(pending, signal);
  }

  async enrollPortableHandoff(
    encodedHandoff: string,
    options: {
      restartPendingEnrollment?: boolean;
      replaceExisting?: boolean;
      signal?: AbortSignal;
    } = {}
  ): Promise<ActiveHostCredential> {
    const acceptedAt = this.clock();
    const handoff = parseAgentHostSetupHandoff(encodedHandoff, acceptedAt);
    const provenance = createPendingPortableHandoffProvenance(handoff, acceptedAt);
    const pending: PendingHostEnrollment = {
      kind: "host_enrollment_code",
      enrollmentAttemptId: `enroll-${randomUUID()}`,
      enrollmentCode: handoff.enrollmentCode,
      credentialToken: `pw_host_${randomBytes(32).toString("base64url")}`,
      createdAt: acceptedAt.toISOString(),
      provenance,
      expectedCredentialExpiresAt: handoff.credentialExpiresAt,
      expectedCredentialPolicy: handoff.credentialPolicy
    };
    if (
      (portableHandoffPendingWorkspaceId(provenance, this.config) ?? null) !==
      (handoff.workspaceId ?? null)
    ) {
      throw new Error("agent_host_handoff_config_conflict");
    }
    await this.credentials.begin(
      pending,
      options.replaceExisting === true,
      options.restartPendingEnrollment === true
    );
    return this.completeEnrollmentCode(pending, options.signal);
  }

  private async enrollWithSetupCode(
    setupCode: string,
    options: { replaceExisting?: boolean; signal?: AbortSignal }
  ): Promise<ActiveHostCredential> {
    if (!this.setupRedeem) throw new Error("agent_host_setup_code_exchange_unavailable");
    const pending: PendingHostEnrollment = {
      kind: "setup_code",
      enrollmentAttemptId: `enroll-${randomUUID()}`,
      setupCode,
      credentialToken: `pw_host_${randomBytes(32).toString("base64url")}`,
      createdAt: this.clock().toISOString()
    };
    await this.credentials.begin(pending, options.replaceExisting === true);
    return this.completeSetupCode(pending, options.signal);
  }

  private async completeEnrollmentCode(
    pending: Extract<PendingHostEnrollment, { kind: "host_enrollment_code" }>,
    signal?: AbortSignal
  ): Promise<ActiveHostCredential> {
    const document = await this.credentials.read();
    if (
      !document?.pending ||
      document.pending.kind !== "host_enrollment_code" ||
      document.pending.enrollmentAttemptId !== pending.enrollmentAttemptId
    ) {
      throw new Error("agent_host_enrollment_not_pending");
    }
    const installationId = await ensureHostInstallationIdentity(this.config.dataDirectory);
    const portableWorkspaceId = pending.provenance
      ? portableHandoffPendingWorkspaceId(pending.provenance, this.config)
      : undefined;
    if (pending.provenance) {
      if (portableWorkspaceId) {
        // Legacy collaboration workspace binding resolved from config.
      } else if (this.config.workspaces.length > 0) {
        throw new Error("agent_host_handoff_provenance_invalid");
      } else if (!portableHandoffEndpointBindingMatches(pending.provenance, this.config)) {
        throw new Error("agent_host_handoff_provenance_invalid");
      }
    }
    const response = hostEnrollmentCompletedSchema.parse(
      await this.exchange.exchange(
        {
          type: "host.enrollment.request",
          protocolVersion: agentHostProtocolVersion,
          enrollmentCode: pending.enrollmentCode,
          enrollmentAttemptId: pending.enrollmentAttemptId,
          installationId,
          ...(document.active ? { supersedesHostId: document.active.hostId } : {}),
          credentialToken: pending.credentialToken,
          displayName: this.config.host.displayName,
          capabilities: this.config.host.capabilities,
          capacity: this.config.host.capacity
        },
        signal
      )
    );
    if (portableWorkspaceId && response.workspaceId !== portableWorkspaceId) {
      throw new Error("agent_host_enrollment_response_mismatch");
    }
    return this.credentials.promote(response, this.clock());
  }

  private async completeSetupCode(
    pending: Extract<PendingHostEnrollment, { kind: "setup_code" }>,
    signal?: AbortSignal
  ): Promise<ActiveHostCredential> {
    if (!this.setupRedeem) throw new Error("agent_host_setup_code_exchange_unavailable");
    const response = await this.setupRedeem.redeem(
      {
        schemaVersion: "workspace-setup/v1",
        setupCode: pending.setupCode,
        purpose: "host_enrollment",
        displayName: this.config.host.displayName,
        capabilities: this.config.host.capabilities,
        capacity: this.config.host.capacity,
        enrollmentAttemptId: pending.enrollmentAttemptId,
        hostCredentialToken: pending.credentialToken
      },
      signal
    );
    return this.credentials.promoteSetup(response, this.clock());
  }
}
