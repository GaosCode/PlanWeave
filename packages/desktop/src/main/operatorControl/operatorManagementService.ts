import type { ManagementAuthorizationStatus } from "@planweave-ai/agent-host-protocol/operator-control";
import { randomBytes } from "node:crypto";
import { OperatorControlError } from "../../shared/operatorControl.js";
import type { OperatorManagementView } from "../../shared/operatorManagement.js";
import type { OperatorProfileStore } from "./operatorProfileStore.js";
import type { OperatorCredentialVault } from "./operatorCredentialVault.js";
import type { OperatorControlClient } from "./OperatorControlClient.js";

function failure(code: string): OperatorControlError {
  return new OperatorControlError({ kind: "unauthorized", code });
}
function errorCode(error: unknown): string {
  if (!(error instanceof OperatorControlError)) return "operator_management_failed";
  return error.httpStatus === 404 ? "operator_management_upgrade_required" : error.code;
}

/** Runs only in main; replacement credentials never cross the renderer boundary. */
export class OperatorManagementService {
  private readonly pendingTokens = new Map<string, string>();
  constructor(
    private readonly options: {
      profiles: OperatorProfileStore;
      vault: OperatorCredentialVault;
      client(profileId: string): Promise<OperatorControlClient>;
    }
  ) {}

  async check(profileId: string): Promise<OperatorManagementView> {
    let client: OperatorControlClient | undefined;
    try {
      client = await this.options.client(profileId);
      const authorization = await client.maintainManagementAuthorization();
      const view = { profileId, authorization, errorCode: null };
      return view;
    } catch (error) {
      const view = { profileId, authorization: null, errorCode: errorCode(error) };
      return view;
    } finally {
      client?.dispose();
    }
  }

  async reauthorize(profileId: string, recoveryCode?: string): Promise<OperatorManagementView> {
    const target = await this.options.profiles.get(profileId);
    if (!target) throw failure("operator_profile_not_found");
    const metadata = await this.options.vault.getMetadata(profileId);
    const operatorId = metadata?.operatorId ?? target.operatorId;
    if (!operatorId) throw failure("operator_management_identity_missing");
    const newToken =
      this.pendingTokens.get(profileId) ?? `pw_operator_${randomBytes(32).toString("base64url")}`;
    this.pendingTokens.set(profileId, newToken);
    const candidates = recoveryCode
      ? [target]
      : (await this.options.profiles.list())
          .filter(
            (profile) =>
              new URL(profile.serverBaseUrl).origin === new URL(target.serverBaseUrl).origin
          )
          .sort((a, b) => Number(b.profileId === profileId) - Number(a.profileId === profileId));
    for (const candidate of candidates) {
      let client: OperatorControlClient | undefined;
      try {
        client = await this.options.client(candidate.profileId);
        const authorization: ManagementAuthorizationStatus = recoveryCode
          ? await client.recoverManagement(operatorId, recoveryCode, newToken)
          : await client.authorizeManagement(operatorId, newToken);
        if (authorization.operatorId !== operatorId) throw failure("operator_response_invalid");
        await this.options.vault.setOperatorToken(profileId, newToken, operatorId);
        this.pendingTokens.delete(profileId);
        const view = { profileId, authorization, errorCode: null };
        return view;
      } catch (error) {
        const code = errorCode(error);
        if (
          !recoveryCode &&
          [
            "operator_unauthorized",
            "operator_credential_missing",
            "operator_credential_invalid",
            "operator_server_admin_required"
          ].includes(code)
        )
          continue;
        throw failure(code);
      } finally {
        client?.dispose();
      }
    }
    throw failure("operator_management_recovery_required");
  }

  forget(profileId: string): void {
    this.pendingTokens.delete(profileId);
  }
}
