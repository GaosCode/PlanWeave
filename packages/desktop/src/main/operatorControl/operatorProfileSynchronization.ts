import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { operatorTokenSchema } from "@planweave-ai/agent-host-protocol";
import { OperatorControlError, type OperatorControlProfile } from "../../shared/operatorControl.js";
import type { OperatorCredentialVault } from "./operatorCredentialVault.js";
import type { OperatorProfileOperation } from "./operatorProfileOperations.js";
import type { OperatorProfileStore } from "./operatorProfileStore.js";

/** Local Server profile reconciliation, executed within the service persistence queue. */
export class OperatorProfileSynchronization {
  constructor(
    private readonly profiles: OperatorProfileStore,
    private readonly vault: OperatorCredentialVault
  ) {}

  async matches(profile: OperatorControlProfile): Promise<boolean> {
    const existing = await this.profiles.get(profile.profileId);
    if (!existing) return false;
    const { updatedAt: _updatedAt, displayName: _storedName, ...stored } = existing;
    const { displayName: _profileName, ...configuration } = profile;
    return isDeepStrictEqual(stored, configuration);
  }

  async ensureDeployment(
    profile: OperatorControlProfile,
    rawOperatorId: string,
    operation: OperatorProfileOperation
  ): Promise<string> {
    operation.assertCurrent();
    const operatorId = rawOperatorId.trim();
    if (!operatorId) {
      throw new OperatorControlError({
        kind: "validation",
        code: "deployment_operator_id_required"
      });
    }
    const existingToken = await this.vault.getOperatorToken(profile.profileId);
    operation.assertCurrent();
    if (existingToken) {
      if ((await this.vault.persistenceFor(profile.profileId)) !== "persisted") {
        throw new Error("deployment_operator_credential_persistence_required");
      }
      operation.assertCurrent();
      await this.profiles.upsert(profile, operation.assertCurrent);
      return existingToken;
    }
    const operatorToken = `pw_operator_${randomBytes(32).toString("base64url")}`;
    const persistence = await this.vault.setOperatorToken(
      profile.profileId,
      operatorToken,
      operatorId,
      operation.assertCurrent
    );
    operation.assertCurrent();
    if (persistence !== "persisted") {
      await this.vault.clear(profile.profileId, operation.assertCurrent);
      throw new Error("deployment_operator_credential_persistence_required");
    }
    try {
      await this.profiles.upsert(profile, operation.assertCurrent);
    } catch (error) {
      operation.assertCurrent();
      await this.vault.clear(profile.profileId, operation.assertCurrent);
      throw error;
    }
    return operatorToken;
  }

  async ensureMainOwned(
    profile: OperatorControlProfile,
    rawOperatorId: string,
    rawOperatorToken: string,
    operation: OperatorProfileOperation
  ): Promise<void> {
    operation.assertCurrent();
    if (!profile.endpoint) throw new Error("operator_deployment_endpoint_required");
    const operatorId = rawOperatorId.trim();
    const operatorToken = operatorTokenSchema.parse(rawOperatorToken);
    if (!operatorId) throw new Error("deployment_operator_id_required");
    const existingToken = await this.vault.getOperatorToken(profile.profileId);
    operation.assertCurrent();
    const existingIdentity = await this.vault.getMetadata(profile.profileId);
    operation.assertCurrent();
    // Reconciliation must preserve a recovered credential for the same operator.
    if (!existingToken || existingIdentity?.operatorId !== operatorId) {
      await this.vault.setOperatorToken(
        profile.profileId,
        operatorToken,
        operatorId,
        operation.assertCurrent
      );
    }
    operation.assertCurrent();
    await this.profiles.upsert(profile, operation.assertCurrent);
    operation.assertCurrent();
    if ((await this.profiles.getActiveProfileId()) === null) {
      operation.assertCurrent();
      await this.profiles.setActiveProfileId(profile.profileId, operation.assertCurrent);
    }
  }
}
