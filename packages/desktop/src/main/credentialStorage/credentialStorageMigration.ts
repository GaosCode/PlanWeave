import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { operatorTokenSchema } from "@planweave-ai/agent-host-protocol";
import { humanDeviceTokenSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { humanCreateInvitationResponseSchema } from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  collaborationCredentialsDocumentSchema,
  type CollaborationCredentialsDocument,
  type CollaborationSafeStoragePort
} from "../collaboration/collaborationCredentialVault.js";
import {
  collaborationInvitationDocumentSchema,
  type CollaborationInvitationDocument
} from "../collaboration/collaborationInvitationVault.js";
import {
  operatorCredentialsDocumentSchema,
  type OperatorCredentialsDocument
} from "../operatorControl/operatorCredentialVault.js";
import { LOCAL_OPERATOR_PROFILE_ID } from "../operatorControl/localOperatorBackend.js";
import {
  readTunnelClientConfig,
  writeTunnelClientConfig,
  type TunnelClientConfigStorePaths
} from "../mcpTunnel/tunnelClientStore.js";
import { decryptSafeStorageString } from "../safeStorageAccess.js";
import type { CredentialStoragePaths } from "./credentialStoragePaths.js";
import type { CredentialStorageMode } from "../../shared/credentialStorageSettings.js";

type MigrationCounts = {
  collaborationCredentials: number;
  invitations: number;
  coordinatorCredentials: number;
  operatorCredentials: number;
  mcpRuntimeApiKey: number;
};

export type CredentialStorageMigrationReceipt = {
  counts: MigrationCounts;
  rollbackSharedFiles(): Promise<void>;
};

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readDocument<T>(
  path: string,
  parse: (input: unknown) => T,
  label: string
): Promise<T | null> {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new Error(`credential_storage_migration_${label}_invalid`, { cause: error });
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  });
  const temporaryPath = `${path}.${process.pid}.migration.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, path);
  if (((await stat(path)).mode & 0o777) !== 0o600) await chmod(path, 0o600);
}

function decrypt(
  storage: CollaborationSafeStoragePort,
  encryptedBase64: string,
  label: string
): string {
  return decryptSafeStorageString(storage, Buffer.from(encryptedBase64, "base64"), label);
}

function encrypt(storage: CollaborationSafeStoragePort, plainText: string): string {
  return storage.encryptString(plainText).toString("base64");
}

async function migrateCollaborationCredentials(options: {
  sourcePath: string;
  targetPath: string;
  sourceStorage: CollaborationSafeStoragePort;
  targetStorage: CollaborationSafeStoragePort;
}): Promise<number> {
  const source = await readDocument(
    options.sourcePath,
    (input) => collaborationCredentialsDocumentSchema.parse(input),
    "collaboration_credentials"
  );
  if (!source) return 0;
  const target =
    (await readDocument(
      options.targetPath,
      (input) => collaborationCredentialsDocumentSchema.parse(input),
      "target_collaboration_credentials"
    )) ?? ({ version: 2, credentials: {} } satisfies CollaborationCredentialsDocument);
  let changed = 0;
  for (const [profileId, sourceRecord] of Object.entries(source.credentials)) {
    const targetRecord = target.credentials[profileId];
    if (
      targetRecord &&
      targetRecord.deviceCredentialId === sourceRecord.deviceCredentialId &&
      targetRecord.humanPrincipalId === sourceRecord.humanPrincipalId &&
      targetRecord.updatedAt === sourceRecord.updatedAt
    ) {
      continue;
    }
    const sourceToken = humanDeviceTokenSchema.parse(
      decrypt(options.sourceStorage, sourceRecord.encryptedDeviceToken, "collaboration credential")
    );
    const encryptedIdentityToken =
      sourceRecord.encryptedIdentityToken === null
        ? null
        : encrypt(
            options.targetStorage,
            decrypt(
              options.sourceStorage,
              sourceRecord.encryptedIdentityToken,
              "collaboration identity credential"
            )
          );
    target.credentials[profileId] = {
      ...sourceRecord,
      encryptedDeviceToken: encrypt(options.targetStorage, sourceToken),
      encryptedIdentityToken
    };
    changed += 1;
  }
  if (changed > 0) await writePrivateJson(options.targetPath, target);
  return changed;
}

async function migrateInvitations(options: {
  sourcePath: string;
  targetPath: string;
  sourceStorage: CollaborationSafeStoragePort;
  targetStorage: CollaborationSafeStoragePort;
}): Promise<number> {
  const source = await readDocument(
    options.sourcePath,
    (input) => collaborationInvitationDocumentSchema.parse(input),
    "collaboration_invitations"
  );
  if (!source) return 0;
  const target =
    (await readDocument(
      options.targetPath,
      (input) => collaborationInvitationDocumentSchema.parse(input),
      "target_collaboration_invitations"
    )) ?? ({ version: 1, invitations: {} } satisfies CollaborationInvitationDocument);
  let changed = 0;
  for (const [profileId, sourceInvitations] of Object.entries(source.invitations)) {
    target.invitations[profileId] ??= {};
    for (const [invitationId, sourceRecord] of Object.entries(sourceInvitations)) {
      if (target.invitations[profileId]?.[invitationId]) continue;
      const sourceInvitation = humanCreateInvitationResponseSchema.parse(
        JSON.parse(
          decrypt(
            options.sourceStorage,
            sourceRecord.encryptedInvitation,
            "collaboration invitation"
          )
        )
      );
      target.invitations[profileId]![invitationId] = {
        encryptedInvitation: encrypt(options.targetStorage, JSON.stringify(sourceInvitation))
      };
      changed += 1;
    }
  }
  if (changed > 0) await writePrivateJson(options.targetPath, target);
  return changed;
}

async function migrateOperatorCredentials(options: {
  sourcePath: string;
  targetPath: string;
  sourceStorage: CollaborationSafeStoragePort;
  targetStorage: CollaborationSafeStoragePort;
  label: string;
}): Promise<number> {
  const source = await readDocument(
    options.sourcePath,
    (input) => operatorCredentialsDocumentSchema.parse(input),
    options.label
  );
  if (!source) return 0;
  const target =
    (await readDocument(
      options.targetPath,
      (input) => operatorCredentialsDocumentSchema.parse(input),
      `target_${options.label}`
    )) ?? ({ version: 1, credentials: {} } satisfies OperatorCredentialsDocument);
  let changed = 0;
  for (const [profileId, sourceRecord] of Object.entries(source.credentials)) {
    const targetRecord = target.credentials[profileId];
    if (
      targetRecord &&
      targetRecord.operatorId === sourceRecord.operatorId &&
      targetRecord.updatedAt === sourceRecord.updatedAt
    ) {
      continue;
    }
    const sourceToken = operatorTokenSchema.parse(
      decrypt(options.sourceStorage, sourceRecord.encryptedOperatorToken, options.label)
    );
    target.credentials[profileId] = {
      ...sourceRecord,
      encryptedOperatorToken: encrypt(options.targetStorage, sourceToken)
    };
    changed += 1;
  }
  if (changed > 0) await writePrivateJson(options.targetPath, target);
  return changed;
}

async function restoreLocalOperatorCredentialFromCoordinator(options: {
  coordinatorPath: string;
  operatorPath: string;
}): Promise<number> {
  const coordinator = await readDocument(
    options.coordinatorPath,
    (input) => operatorCredentialsDocumentSchema.parse(input),
    "target_coordinator_credentials"
  );
  const coordinatorRecord = coordinator?.credentials[LOCAL_OPERATOR_PROFILE_ID];
  if (!coordinatorRecord) return 0;
  const operator =
    (await readDocument(
      options.operatorPath,
      (input) => operatorCredentialsDocumentSchema.parse(input),
      "target_operator_credentials"
    )) ?? ({ version: 1, credentials: {} } satisfies OperatorCredentialsDocument);
  const operatorRecord = operator.credentials[LOCAL_OPERATOR_PROFILE_ID];
  if (
    operatorRecord?.operatorId === coordinatorRecord.operatorId &&
    operatorRecord.updatedAt === coordinatorRecord.updatedAt
  ) {
    return 0;
  }
  operator.credentials[LOCAL_OPERATOR_PROFILE_ID] = coordinatorRecord;
  await writePrivateJson(options.operatorPath, operator);
  return 1;
}

async function migrateMcpRuntimeApiKey(options: {
  paths: TunnelClientConfigStorePaths;
  sourceMode: CredentialStorageMode;
  targetMode: CredentialStorageMode;
  sourceStorage: CollaborationSafeStoragePort;
  targetStorage: CollaborationSafeStoragePort;
}): Promise<number> {
  const config = await readTunnelClientConfig(options.paths);
  const keys = { ...(config.encryptedRuntimeApiKeys ?? {}) };
  const legacySystemCiphertext = config.encryptedRuntimeApiKey;
  const sourceCiphertext =
    keys[options.sourceMode] ?? (options.sourceMode === "system" ? legacySystemCiphertext : null);
  if (!sourceCiphertext) return 0;
  const targetCiphertext =
    keys[options.targetMode] ?? (options.targetMode === "system" ? legacySystemCiphertext : null);
  if (targetCiphertext) {
    if (!keys[options.targetMode]) {
      keys[options.targetMode] = targetCiphertext;
      await writeTunnelClientConfig({ ...config, encryptedRuntimeApiKeys: keys }, options.paths);
    }
    return 0;
  }
  const sourceKey = decrypt(options.sourceStorage, sourceCiphertext, "MCP runtime API key").trim();
  if (!sourceKey) throw new Error("credential_storage_migration_mcp_runtime_api_key_invalid");
  if (!keys[options.sourceMode]) keys[options.sourceMode] = sourceCiphertext;
  keys[options.targetMode] = encrypt(options.targetStorage, sourceKey);
  await writeTunnelClientConfig({ ...config, encryptedRuntimeApiKeys: keys }, options.paths);
  return 1;
}

export async function migrateCredentialStorage(options: {
  sourceMode: CredentialStorageMode;
  targetMode: CredentialStorageMode;
  sourcePaths: CredentialStoragePaths;
  targetPaths: CredentialStoragePaths;
  sourceStorage: CollaborationSafeStoragePort;
  targetStorage: CollaborationSafeStoragePort;
  mcpTunnelPaths: TunnelClientConfigStorePaths;
}): Promise<CredentialStorageMigrationReceipt> {
  if (!options.sourceStorage.isEncryptionAvailable()) {
    throw new Error("credential_storage_migration_source_unavailable");
  }
  if (!options.targetStorage.isEncryptionAvailable()) {
    throw new Error("credential_storage_migration_target_unavailable");
  }
  const counts: MigrationCounts = {
    collaborationCredentials: await migrateCollaborationCredentials({
      sourcePath: options.sourcePaths.collaborationCredentialsFile,
      targetPath: options.targetPaths.collaborationCredentialsFile,
      sourceStorage: options.sourceStorage,
      targetStorage: options.targetStorage
    }),
    invitations: await migrateInvitations({
      sourcePath: options.sourcePaths.collaborationInvitationsFile,
      targetPath: options.targetPaths.collaborationInvitationsFile,
      sourceStorage: options.sourceStorage,
      targetStorage: options.targetStorage
    }),
    coordinatorCredentials: await migrateOperatorCredentials({
      sourcePath: options.sourcePaths.coordinatorCredentialsFile,
      targetPath: options.targetPaths.coordinatorCredentialsFile,
      sourceStorage: options.sourceStorage,
      targetStorage: options.targetStorage,
      label: "coordinator credential"
    }),
    operatorCredentials: await migrateOperatorCredentials({
      sourcePath: options.sourcePaths.operatorCredentialsFile,
      targetPath: options.targetPaths.operatorCredentialsFile,
      sourceStorage: options.sourceStorage,
      targetStorage: options.targetStorage,
      label: "operator credential"
    }),
    mcpRuntimeApiKey: await migrateMcpRuntimeApiKey({
      paths: options.mcpTunnelPaths,
      sourceMode: options.sourceMode,
      targetMode: options.targetMode,
      sourceStorage: options.sourceStorage,
      targetStorage: options.targetStorage
    })
  };
  counts.operatorCredentials += await restoreLocalOperatorCredentialFromCoordinator({
    coordinatorPath: options.targetPaths.coordinatorCredentialsFile,
    operatorPath: options.targetPaths.operatorCredentialsFile
  });
  return { counts, rollbackSharedFiles: async () => undefined };
}
