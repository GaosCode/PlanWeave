import { hostname } from "node:os";
import type { ManagementAuthorizationStatus } from "@planweave-ai/agent-host-protocol/operator-control";
import { randomBytes } from "node:crypto";
import { OperatorControlError } from "../../shared/operatorControl.js";
import type { OperatorManagementView } from "../../shared/operatorManagement.js";
import type { OperatorProfileStore } from "./operatorProfileStore.js";
import type { OperatorCredentialVault, StoredManagementDevice } from "./operatorCredentialVault.js";
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

  private readonly access = new Map<string, ManagementAuthorizationStatus>();

  async ensureAccess(profileId: string): Promise<void> {
    const status = this.access.get(profileId);
    if (status && new Date(status.renewAfter).getTime() > Date.now()) return;
    if (await this.options.vault.getManagementDevice(profileId)) await this.check(profileId);
  }

  private checkQueue: Promise<unknown> = Promise.resolve();
  private readonly checks = new Map<string, Promise<OperatorManagementView>>();

  check(profileId: string): Promise<OperatorManagementView> {
    const existing = this.checks.get(profileId);
    if (existing) return existing;
    const next = this.checkQueue
      .then(() => this.checkOnce(profileId))
      .finally(() => this.checks.delete(profileId));
    this.checkQueue = next.catch(() => undefined);
    this.checks.set(profileId, next);
    return next;
  }

  private async checkOnce(profileId: string): Promise<OperatorManagementView> {
    let client: OperatorControlClient | undefined;
    try {
      const profile = await this.options.profiles.get(profileId);
      if (!profile) throw failure("operator_profile_not_found");
      client = await this.options.client(profileId);
      let device = await this.options.vault.getManagementDevice(profileId);
      const operatorId =
        (await this.options.vault.getMetadata(profileId))?.operatorId ?? profile.operatorId;
      if (
        device &&
        (device.origin !== new URL(profile.serverBaseUrl).origin ||
          device.operatorId !== operatorId)
      ) {
        await this.options.vault.setManagementDevice(profileId, undefined);
        device = undefined;
      }
      let authorization: ManagementAuthorizationStatus;
      if (!device) {
        authorization = await client.maintainManagementAuthorization();
        device = {
          secret: `pw_device_${randomBytes(32).toString("base64url")}`,
          origin: new URL(profile.serverBaseUrl).origin,
          operatorId: authorization.operatorId,
          deviceId: null,
          pendingToken: `pw_operator_${randomBytes(32).toString("base64url")}`
        };
        // Persist before enrollment: a lost response must not strand an authorized device.
        await this.options.vault.setManagementDevice(profileId, device);
      }
      if (!device.deviceId) {
        let enrolled: Awaited<ReturnType<OperatorControlClient["enrollManagementDevice"]>>;
        try {
          enrolled = await client.enrollManagementDevice(device.secret, hostname().slice(0, 128));
        } catch (error) {
          if (errorCode(error) !== "operator_unauthorized") throw error;
          await this.refreshDevice(profileId, device, client);
          // Enrollment may have succeeded before an interrupted response and an expired access token.
          enrolled = await client.enrollManagementDevice(device.secret, hostname().slice(0, 128));
        }
        if (enrolled.operatorId !== device.operatorId) throw failure("operator_response_invalid");
        device = { ...device, deviceId: enrolled.deviceId };
        await this.options.vault.setManagementDevice(profileId, device);
      }
      if (device.pendingToken) authorization = await this.refreshDevice(profileId, device, client);
      else {
        try {
          authorization = await client.maintainManagementAuthorization();
          if (new Date(authorization.renewAfter).getTime() <= Date.now())
            authorization = await this.refreshDevice(profileId, device, client);
        } catch (error) {
          if (
            !["operator_unauthorized", "operator_server_admin_required"].includes(errorCode(error))
          )
            throw error;
          authorization = await this.refreshDevice(profileId, device, client);
        }
      }
      this.access.set(profileId, authorization);
      return {
        profileId,
        authorization,
        errorCode: null,
        deviceId: device.deviceId,
        devices: await client.listManagementDevices()
      };
    } catch (error) {
      this.access.delete(profileId);
      return { profileId, authorization: null, errorCode: errorCode(error) };
    } finally {
      client?.dispose();
    }
  }

  private async refreshDevice(
    profileId: string,
    device: StoredManagementDevice,
    client: OperatorControlClient
  ): Promise<ManagementAuthorizationStatus> {
    const pending = {
      ...device,
      pendingToken: device.pendingToken ?? `pw_operator_${randomBytes(32).toString("base64url")}`
    };
    await this.options.vault.setManagementDevice(profileId, pending);
    let response: Awaited<ReturnType<OperatorControlClient["refreshManagementDevice"]>>;
    try {
      response = await client.refreshManagementDevice(pending.secret, pending.pendingToken);
    } catch (error) {
      // A saved pending token can expire while Desktop is closed. Retry with a fresh token
      // only after Server explicitly rejects it; network failures retain the same retry key.
      if (errorCode(error) !== "operator_management_token_conflict") throw error;
      pending.pendingToken = `pw_operator_${randomBytes(32).toString("base64url")}`;
      await this.options.vault.setManagementDevice(profileId, pending);
      response = await client.refreshManagementDevice(pending.secret, pending.pendingToken);
    }
    const { deviceId, ...authorization } = response;
    if (authorization.operatorId !== device.operatorId) throw failure("operator_response_invalid");
    await this.options.vault.setOperatorToken(profileId, pending.pendingToken, device.operatorId);
    await this.options.vault.setManagementDevice(profileId, {
      ...pending,
      deviceId,
      pendingToken: null
    });
    return authorization;
  }

  async revoke(profileId: string, deviceId: string): Promise<OperatorManagementView> {
    await this.ensureAccess(profileId);
    const client = await this.options.client(profileId);
    try {
      await client.revokeManagementDevice(deviceId);
    } finally {
      client.dispose();
    }
    this.access.delete(profileId);
    return this.check(profileId);
  }

  async reauthorize(profileId: string, recoveryCode?: string): Promise<OperatorManagementView> {
    if (!recoveryCode && (await this.options.vault.getManagementDevice(profileId))) {
      const current = await this.check(profileId);
      if (current.authorization) return current;
    }
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
        await this.options.vault.setManagementDevice(profileId, undefined);
        return this.check(profileId);
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
    this.access.delete(profileId);
  }
}
