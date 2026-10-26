import { canonicalizeJson } from "@planweave-ai/agent-host-protocol";
import type { OperatorRegisterLocalAgentHostInput } from "../../shared/operatorControl.js";
import type { OperatorControlClient } from "./OperatorControlClient.js";
import { buildHostBootstrapHandoffPayload } from "./hostBootstrapHandoff.js";
import type { LocalAgentHostProvisioner } from "./localAgentHostProvisioner.js";
import {
  localAgentHostErrorFromUnknown,
  type OperatorLocalHostOperations
} from "./operatorLocalHostOperations.js";
import type { OperatorProfileOperation } from "./operatorProfileOperations.js";

const unknownEnrollmentOutcomeCodes = new Set([
  "agent_host_enrollment_timeout",
  "agent_host_enrollment_canceled",
  "agent_host_enrollment_exchange_failed",
  "agent_host_enrollment_response_malformed",
  "agent_host_enrollment_response_too_large"
]);

type PendingEnrollment = { profileId: string; scope: string } & (
  | { state: "recoverable"; handoff: string; isCurrent(): boolean }
  | { state: "invalidated" }
);

/** Keeps an unacknowledged one-click enrollment bound to its main-process authority. */
export class OperatorLocalHostEnrollment {
  private pending: PendingEnrollment | undefined;

  constructor(
    private readonly provisioner: LocalAgentHostProvisioner,
    private readonly mutations: OperatorLocalHostOperations
  ) {}

  clear(): void {
    this.pending = undefined;
  }

  invalidate(profileId: string): void {
    if (this.pending?.profileId === profileId) {
      // Retain a conflict marker, but release the secret belonging to the old authority.
      this.pending = { profileId, scope: this.pending.scope, state: "invalidated" };
    }
  }

  async register(
    client: OperatorControlClient,
    input: OperatorRegisterLocalAgentHostInput,
    operation: OperatorProfileOperation
  ) {
    return this.mutations.run(operation, () => this.registerCurrent(client, input, operation));
  }

  private async registerCurrent(
    client: OperatorControlClient,
    input: OperatorRegisterLocalAgentHostInput,
    operation: OperatorProfileOperation
  ) {
    if (!(await this.provisioner.status(input.profileId)).supported) {
      throw new Error("local_agent_host_unavailable");
    }
    const profile = client.connectionProfile;
    if (profile.endpoint?.tlsTrust === "configured_ca") {
      throw new Error("local_agent_host_custom_ca_unsupported");
    }
    // Each click refreshes the grant expiry; ownership, policy and destination define the retry.
    const { expiresAt: _expiresAt, ...request } = input.request;
    const scope = canonicalizeJson({ profile, request });
    if (
      this.pending &&
      (this.pending.state === "invalidated" ||
        this.pending.scope !== scope ||
        !this.pending.isCurrent())
    ) {
      if (this.pending.state === "recoverable" && !this.pending.isCurrent())
        this.invalidate(this.pending.profileId);
      throw new Error("agent_host_handoff_pending_conflict");
    }
    if (!this.pending) {
      const grant = await client.createEnrollmentGrant(input.request);
      operation.assertCurrent();
      this.pending = {
        state: "recoverable",
        profileId: input.profileId,
        scope,
        handoff: buildHostBootstrapHandoffPayload(profile, grant),
        isCurrent: operation.isCurrent
      };
    }
    const pending = this.pending;
    try {
      const result = await this.provisioner.register(
        input.profileId,
        pending.handoff,
        input.exposedProfileIds
      );
      if (this.pending === pending) this.clear();
      return result;
    } catch (error) {
      const failure = localAgentHostErrorFromUnknown(error);
      if (!unknownEnrollmentOutcomeCodes.has(failure.code) && this.pending === pending) {
        this.clear();
      }
      throw failure;
    }
  }
}
