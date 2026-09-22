import {
  OperatorProfileOperations,
  type OperatorProfileOperation
} from "./operatorProfileOperations.js";
import { hostname } from "node:os";
import type { ManagementAuthorizationStatus } from "@planweave-ai/agent-host-protocol/operator-control";
import { randomBytes } from "node:crypto";
import { OperatorControlError, type OperatorControlProfile } from "../../shared/operatorControl.js";
import { LOCAL_OPERATOR_PROFILE_ID } from "./localOperatorBackend.js";
import type { OperatorManagementView } from "../../shared/operatorManagement.js";
import type { OperatorProfileStore } from "./operatorProfileStore.js";
import type { OperatorCredentialVault, StoredManagementDevice } from "./operatorCredentialVault.js";
import type { OperatorControlClient } from "./OperatorControlClient.js";

function failure(code: string): OperatorControlError {
  return new OperatorControlError({ kind: "unauthorized", code });
}
function invalidated(): OperatorControlError {
  return new OperatorControlError({ kind: "offline", code: "operator_operation_invalidated" });
}
function clientBoundTo(profile: OperatorControlProfile, client: OperatorControlClient): boolean {
  if (client.connectionProfile.profileId !== profile.profileId) return false;
  const storedOrigin = new URL(profile.serverBaseUrl).origin;
  const clientOrigin = new URL(client.connectionProfile.serverBaseUrl).origin;
  if (clientOrigin === storedOrigin) return true;
  return (
    profile.profileId === LOCAL_OPERATOR_PROFILE_ID &&
    new URL(client.connectionProfile.serverBaseUrl).hostname === "127.0.0.1"
  );
}
function assertDeviceSecretDestination(
  device: StoredManagementDevice,
  profile: OperatorControlProfile,
  client: OperatorControlClient
): void {
  const storedOrigin = new URL(profile.serverBaseUrl).origin;
  const clientOrigin = new URL(client.connectionProfile.serverBaseUrl).origin;
  if (
    !clientBoundTo(profile, client) ||
    device.origin !== storedOrigin ||
    (clientOrigin !== device.origin && profile.profileId !== LOCAL_OPERATOR_PROFILE_ID)
  ) {
    throw invalidated();
  }
}
function errorCode(error: unknown): string {
  if (!(error instanceof OperatorControlError)) return "operator_management_failed";
  return error.httpStatus === 404 ? "operator_management_upgrade_required" : error.code;
}

/** Runs only in main; replacement credentials never cross the renderer boundary. */
export class OperatorManagementService {
  private readonly operations: OperatorProfileOperations;
  private readonly pendingTokens = new Map<string, string>();
  constructor(
    private readonly options: {
      profiles: OperatorProfileStore;
      vault: OperatorCredentialVault;
      operations?: OperatorProfileOperations;
      client(profileId: string): Promise<{
        client: OperatorControlClient;
        profile: OperatorControlProfile;
      }>;
    }
  ) {
    this.operations = options.operations ?? new OperatorProfileOperations();
  }

  private readonly access = new Map<string, ManagementAuthorizationStatus>();

  async ensureAccess(profileId: string, operation: OperatorProfileOperation): Promise<void> {
    const status = this.access.get(profileId);
    if (status && new Date(status.renewAfter).getTime() > Date.now()) return;
    if (await this.options.vault.getManagementDevice(profileId))
      await this.checkOnce(profileId, operation);
  }

  private readonly checks = new Map<string, Promise<OperatorManagementView>>();

  check(profileId: string): Promise<OperatorManagementView> {
    const existing = this.checks.get(profileId);
    if (existing) return existing;
    const next = this.operations
      .run(profileId, (operation) => this.checkOnce(profileId, operation))
      .catch((error) => ({ profileId, authorization: null, errorCode: errorCode(error) }))
      .finally(() => {
        if (this.checks.get(profileId) === next) this.checks.delete(profileId);
      });
    this.checks.set(profileId, next);
    return next;
  }

  private async checkOnce(
    profileId: string,
    operation: OperatorProfileOperation
  ): Promise<OperatorManagementView> {
    let client: OperatorControlClient | undefined;
    try {
      operation.assertCurrent();
      const bound = await this.options.client(profileId);
      client = bound.client;
      const profile = bound.profile;
      operation.track(client);
      if (!clientBoundTo(profile, client)) throw invalidated();
      let device = await this.options.vault.getManagementDevice(profileId);
      const operatorId =
        (await this.options.vault.getMetadata(profileId))?.operatorId ?? profile.operatorId;
      if (
        device &&
        (device.origin !== new URL(profile.serverBaseUrl).origin ||
          device.operatorId !== operatorId)
      ) {
        await this.options.vault.setManagementDevice(profileId, undefined, operation.assertCurrent);
        device = undefined;
      }
      let authorization: ManagementAuthorizationStatus;
      if (!device) {
        authorization = await client.maintainManagementAuthorization();
        if (operatorId && authorization.operatorId !== operatorId)
          throw failure("operator_response_invalid");
        device = {
          secret: `pw_device_${randomBytes(32).toString("base64url")}`,
          origin: new URL(profile.serverBaseUrl).origin,
          operatorId: authorization.operatorId,
          deviceId: null,
          pendingToken: `pw_operator_${randomBytes(32).toString("base64url")}`
        };
        // Persist before enrollment: a lost response must not strand an authorized device.
        await this.options.vault.setManagementDevice(profileId, device, operation.assertCurrent);
      }
      if (!device.deviceId) {
        let enrolled: Awaited<ReturnType<OperatorControlClient["enrollManagementDevice"]>>;
        try {
          assertDeviceSecretDestination(device, profile, client);
          enrolled = await client.enrollManagementDevice(device.secret, hostname().slice(0, 128));
        } catch (error) {
          if (errorCode(error) !== "operator_unauthorized") throw error;
          await this.refreshDevice(profileId, device, client, operation, profile);
          // Enrollment may have succeeded before an interrupted response and an expired access token.
          assertDeviceSecretDestination(device, profile, client);
          enrolled = await client.enrollManagementDevice(device.secret, hostname().slice(0, 128));
        }
        if (enrolled.operatorId !== device.operatorId) throw failure("operator_response_invalid");
        device = { ...device, deviceId: enrolled.deviceId };
        await this.options.vault.setManagementDevice(profileId, device, operation.assertCurrent);
      }
      if (device.pendingToken)
        authorization = await this.refreshDevice(profileId, device, client, operation, profile);
      else {
        try {
          authorization = await client.maintainManagementAuthorization();
          if (new Date(authorization.renewAfter).getTime() <= Date.now())
            authorization = await this.refreshDevice(profileId, device, client, operation, profile);
        } catch (error) {
          if (
            !["operator_unauthorized", "operator_server_admin_required"].includes(errorCode(error))
          )
            throw error;
          authorization = await this.refreshDevice(profileId, device, client, operation, profile);
        }
      }
      const devices = await client.listManagementDevices();
      operation.assertCurrent();
      this.access.set(profileId, authorization);
      return {
        profileId,
        authorization,
        errorCode: null,
        deviceId: device.deviceId,
        devices
      };
    } catch (error) {
      if (operation.isCurrent()) this.access.delete(profileId);
      return { profileId, authorization: null, errorCode: errorCode(error) };
    } finally {
      client?.dispose();
    }
  }

  private async refreshDevice(
    profileId: string,
    device: StoredManagementDevice,
    client: OperatorControlClient,
    operation: OperatorProfileOperation,
    profile: OperatorControlProfile
  ): Promise<ManagementAuthorizationStatus> {
    const pending = {
      ...device,
      pendingToken: device.pendingToken ?? `pw_operator_${randomBytes(32).toString("base64url")}`
    };
    await this.options.vault.setManagementDevice(profileId, pending, operation.assertCurrent);
    let response: Awaited<ReturnType<OperatorControlClient["refreshManagementDevice"]>>;
    try {
      assertDeviceSecretDestination(pending, profile, client);
      response = await client.refreshManagementDevice(pending.secret, pending.pendingToken);
    } catch (error) {
      // A saved pending token can expire while Desktop is closed. Retry with a fresh token
      // only after Server explicitly rejects it; network failures retain the same retry key.
      if (errorCode(error) !== "operator_management_token_conflict") throw error;
      pending.pendingToken = `pw_operator_${randomBytes(32).toString("base64url")}`;
      await this.options.vault.setManagementDevice(profileId, pending, operation.assertCurrent);
      assertDeviceSecretDestination(pending, profile, client);
      response = await client.refreshManagementDevice(pending.secret, pending.pendingToken);
    }
    const { deviceId, ...authorization } = response;
    if (authorization.operatorId !== device.operatorId) throw failure("operator_response_invalid");
    await this.options.vault.setOperatorToken(
      profileId,
      pending.pendingToken,
      device.operatorId,
      operation.assertCurrent
    );
    await this.options.vault.setManagementDevice(
      profileId,
      {
        ...pending,
        deviceId,
        pendingToken: null
      },
      operation.assertCurrent
    );
    return authorization;
  }

  revoke(profileId: string, deviceId: string): Promise<OperatorManagementView> {
    return this.operations.run(profileId, async (operation) => {
      await this.ensureAccess(profileId, operation);
      const bound = await this.options.client(profileId);
      const client = bound.client;
      operation.track(client);
      try {
        await client.revokeManagementDevice(deviceId);
        operation.assertCurrent();
        this.access.delete(profileId);
        return await this.checkOnce(profileId, operation);
      } finally {
        client.dispose();
      }
    });
  }

  async reauthorize(profileId: string, recoveryCode?: string): Promise<OperatorManagementView> {
    return this.operations.run(profileId, async (operation) => {
      if (!recoveryCode && (await this.options.vault.getManagementDevice(profileId))) {
        const current = await this.checkOnce(profileId, operation);
        if (current.authorization) return current;
      }
      const target = await this.options.profiles.get(profileId);
      if (!target) throw failure("operator_profile_not_found");
      const metadata = await this.options.vault.getMetadata(profileId);
      const operatorId = metadata?.operatorId ?? target.operatorId;
      if (!operatorId) throw failure("operator_management_identity_missing");
      const newToken =
        this.pendingTokens.get(profileId) ?? `pw_operator_${randomBytes(32).toString("base64url")}`;
      operation.assertCurrent();
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
        operation.assertCurrent();
        const source = this.operations.capture(candidate.profileId);
        const assertCurrent = () => {
          operation.assertCurrent();
          source.assertCurrent();
        };
        let client: OperatorControlClient | undefined;
        try {
          const bound = await this.options.client(candidate.profileId);
          client = bound.client;
          if (
            !clientBoundTo(bound.profile, client) ||
            bound.profile.serverBaseUrl !== candidate.serverBaseUrl ||
            bound.profile.operatorId !== candidate.operatorId
          )
            throw failure("operator_operation_invalidated");
          operation.track(client);
          source.track(client);
          const current = await this.options.profiles.get(candidate.profileId);
          if (
            !current ||
            current.serverBaseUrl !== candidate.serverBaseUrl ||
            current.operatorId !== candidate.operatorId
          )
            throw failure("operator_operation_invalidated");
          assertCurrent();
          const authorization: ManagementAuthorizationStatus = recoveryCode
            ? await client.recoverManagement(operatorId, recoveryCode, newToken)
            : await client.authorizeManagement(operatorId, newToken);
          source.assertCurrent();
          if (authorization.operatorId !== operatorId) throw failure("operator_response_invalid");
          await this.options.vault.setOperatorToken(profileId, newToken, operatorId, assertCurrent);
          operation.assertCurrent();
          this.pendingTokens.delete(profileId);
          await this.options.vault.setManagementDevice(profileId, undefined, assertCurrent);
          return await this.checkOnce(profileId, operation);
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
          source.release();
        }
      }
      throw failure("operator_management_recovery_required");
    });
  }

  forget(profileId: string): void {
    this.operations.invalidate(profileId);
    this.checks.delete(profileId);
    this.pendingTokens.delete(profileId);
    this.access.delete(profileId);
  }
}
