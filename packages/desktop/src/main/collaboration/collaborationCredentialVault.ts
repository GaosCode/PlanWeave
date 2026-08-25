import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  humanDeviceTokenSchema,
  humanIdentityTokenSchema,
  opaqueIdentifierSchema,
  timestampSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import type {
  CollaborationCredentialPersistence,
  CollaborationCredentialStorage
} from "../../shared/collaboration.js";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import { decryptSafeStorageString } from "../safeStorageAccess.js";

export type CollaborationSafeStoragePort = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type StoredCredentialMetadata = {
  deviceCredentialId: string | null;
  identityCredentialId: string | null;
  humanPrincipalId: string | null;
  updatedAt: string;
};

const persistedCredentialRecordV1Schema = z
  .object({
    encryptedDeviceToken: z.string().trim().min(1),
    deviceCredentialId: opaqueIdentifierSchema.nullable(),
    humanPrincipalId: opaqueIdentifierSchema.nullable(),
    updatedAt: timestampSchema
  })
  .strict();

const persistedCredentialRecordSchema = persistedCredentialRecordV1Schema
  .extend({
    encryptedIdentityToken: z.string().trim().min(1).nullable(),
    identityCredentialId: opaqueIdentifierSchema.nullable()
  })
  .strict();

const credentialsDocumentV1Schema = z
  .object({
    version: z.literal(1),
    credentials: z.record(opaqueIdentifierSchema, persistedCredentialRecordV1Schema)
  })
  .strict();

const credentialsDocumentV2Schema = z
  .object({
    version: z.literal(2),
    credentials: z.record(opaqueIdentifierSchema, persistedCredentialRecordSchema)
  })
  .strict();

export const collaborationCredentialsDocumentSchema = z
  .union([credentialsDocumentV2Schema, credentialsDocumentV1Schema])
  .transform((document) => {
    if (document.version === 2) return document;
    return credentialsDocumentV2Schema.parse({
      version: 2,
      credentials: Object.fromEntries(
        Object.entries(document.credentials).map(([profileId, record]) => [
          profileId,
          {
            ...record,
            encryptedIdentityToken: null,
            identityCredentialId: null
          }
        ])
      )
    });
  });

export type CollaborationCredentialsDocument = z.infer<
  typeof collaborationCredentialsDocumentSchema
>;
type CredentialsDocument = CollaborationCredentialsDocument;

type SessionCredential = {
  deviceToken: string;
  identityToken: string | null;
  deviceCredentialId: string | null;
  identityCredentialId: string | null;
  humanPrincipalId: string | null;
  updatedAt: string;
};

function defaultDocument(): CredentialsDocument {
  return { version: 2, credentials: {} };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function nowIso(): string {
  return new Date().toISOString();
}

export type CollaborationCredentialVaultPaths = {
  credentialsPath: string;
};

export function collaborationCredentialVaultPaths(
  credentialsPath: string = desktopHomePaths().collaborationCredentialsFile
): CollaborationCredentialVaultPaths {
  return { credentialsPath };
}

async function ensurePrivateFileParent(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateFileParent(path);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  const written = await stat(path);
  if ((written.mode & 0o777) !== 0o600) {
    await chmod(path, 0o600);
  }
}

/**
 * Main-process vault for human device tokens.
 *
 * - When configured encryption is available: encrypt and persist per profile.
 * - When unavailable: keep token in process memory only (session-only).
 * - Never exposes plaintext/ciphertext/path to callers that cross into renderer.
 */
export class CollaborationCredentialVault {
  private readonly paths: CollaborationCredentialVaultPaths;
  private readonly safeStorage: CollaborationSafeStoragePort;
  private readonly sessionTokens = new Map<string, SessionCredential>();
  private document: CredentialsDocument | null = null;
  private loaded = false;

  constructor(options?: {
    paths?: CollaborationCredentialVaultPaths;
    safeStorage?: CollaborationSafeStoragePort;
  }) {
    this.paths = options?.paths ?? collaborationCredentialVaultPaths();
    this.safeStorage = options?.safeStorage ?? {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("safeStorage is not configured");
      },
      decryptString: () => {
        throw new Error("safeStorage is not configured");
      }
    };
  }

  get credentialsPath(): string {
    return this.paths.credentialsPath;
  }

  storageAvailability(): CollaborationCredentialStorage {
    return this.safeStorage.isEncryptionAvailable() ? "available" : "unavailable";
  }

  private encrypt(token: string): string {
    return this.safeStorage.encryptString(token).toString("base64");
  }

  private decryptDeviceToken(encryptedBase64: string): string | null {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return null;
    }
    const plain = decryptSafeStorageString(
      this.safeStorage,
      Buffer.from(encryptedBase64, "base64"),
      "collaboration credential"
    ).trim();
    const parsed = humanDeviceTokenSchema.safeParse(plain);
    return parsed.success ? parsed.data : null;
  }

  private decryptIdentityToken(encryptedBase64: string): string | null {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return null;
    }
    const plain = decryptSafeStorageString(
      this.safeStorage,
      Buffer.from(encryptedBase64, "base64"),
      "collaboration identity credential"
    ).trim();
    const parsed = humanIdentityTokenSchema.safeParse(plain);
    return parsed.success ? parsed.data : null;
  }

  private async load(): Promise<CredentialsDocument> {
    if (this.loaded && this.document) {
      return this.document;
    }
    let raw: string;
    try {
      raw = await readFile(this.paths.credentialsPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        this.document = defaultDocument();
        this.loaded = true;
        return this.document;
      }
      throw new Error("Failed to read collaboration credentials.");
    }
    try {
      this.document = collaborationCredentialsDocumentSchema.parse(JSON.parse(raw));
      this.loaded = true;
      return this.document;
    } catch {
      throw new Error("Invalid collaboration credentials JSON.");
    }
  }

  private async persist(document: CredentialsDocument): Promise<void> {
    const parsed = collaborationCredentialsDocumentSchema.parse(document);
    await writePrivateJson(this.paths.credentialsPath, parsed);
    this.document = parsed;
    this.loaded = true;
  }

  async getDeviceToken(profileId: string): Promise<string | undefined> {
    const session = this.sessionTokens.get(profileId);
    if (session) {
      return session.deviceToken;
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    const document = await this.load();
    const record = document.credentials[profileId];
    if (!record) {
      return undefined;
    }
    const token = this.decryptDeviceToken(record.encryptedDeviceToken);
    if (!token) {
      // Corrupt or rotated ciphertext: drop durable entry so status is honest.
      delete document.credentials[profileId];
      await this.persist(document);
      return undefined;
    }
    const identityToken =
      record.encryptedIdentityToken === null
        ? null
        : this.decryptIdentityToken(record.encryptedIdentityToken);
    // Cache decrypted token in memory for the process lifetime (still encrypted on disk).
    this.sessionTokens.set(profileId, {
      deviceToken: token,
      identityToken,
      deviceCredentialId: record.deviceCredentialId,
      identityCredentialId: record.identityCredentialId,
      humanPrincipalId: record.humanPrincipalId,
      updatedAt: record.updatedAt
    });
    return token;
  }

  async getIdentityToken(profileId: string): Promise<string | undefined> {
    const session = this.sessionTokens.get(profileId);
    if (session) {
      return session.identityToken ?? undefined;
    }
    await this.getDeviceToken(profileId);
    return this.sessionTokens.get(profileId)?.identityToken ?? undefined;
  }

  async getMetadata(profileId: string): Promise<StoredCredentialMetadata | null> {
    const session = this.sessionTokens.get(profileId);
    if (session) {
      return {
        deviceCredentialId: session.deviceCredentialId,
        identityCredentialId: session.identityCredentialId,
        humanPrincipalId: session.humanPrincipalId,
        updatedAt: session.updatedAt
      };
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return null;
    }
    const document = await this.load();
    const record = document.credentials[profileId];
    if (!record) {
      return null;
    }
    return {
      deviceCredentialId: record.deviceCredentialId,
      identityCredentialId: record.identityCredentialId,
      humanPrincipalId: record.humanPrincipalId,
      updatedAt: record.updatedAt
    };
  }

  async persistenceFor(profileId: string): Promise<CollaborationCredentialPersistence> {
    const session = this.sessionTokens.get(profileId);
    if (session) {
      if (this.safeStorage.isEncryptionAvailable()) {
        const document = await this.load();
        if (document.credentials[profileId]) {
          return "persisted";
        }
      }
      return "session-only";
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return "missing";
    }
    const document = await this.load();
    const record = document.credentials[profileId];
    return record ? "persisted" : "missing";
  }

  async hasCredential(profileId: string): Promise<boolean> {
    return (await this.persistenceFor(profileId)) !== "missing";
  }

  async setDeviceToken(
    profileId: string,
    deviceToken: string,
    metadata: {
      deviceCredentialId?: string | null;
      humanPrincipalId?: string | null;
      identityToken?: string | null;
      identityCredentialId?: string | null;
    } = {}
  ): Promise<CollaborationCredentialPersistence> {
    const token = humanDeviceTokenSchema.parse(deviceToken);
    const updatedAt = nowIso();
    const deviceCredentialId = metadata.deviceCredentialId?.trim() || null;
    const humanPrincipalId = metadata.humanPrincipalId?.trim() || null;
    const existing = this.sessionTokens.get(profileId);
    const document = await this.load();
    const previous = document.credentials[profileId];
    const preservedIdentityToken =
      existing?.identityToken ??
      (previous?.encryptedIdentityToken
        ? this.decryptIdentityToken(previous.encryptedIdentityToken)
        : null);
    const identityToken =
      metadata.identityToken === undefined
        ? preservedIdentityToken
        : metadata.identityToken === null
          ? null
          : humanIdentityTokenSchema.parse(metadata.identityToken);
    const identityCredentialId =
      metadata.identityCredentialId === undefined
        ? (existing?.identityCredentialId ?? previous?.identityCredentialId ?? null)
        : metadata.identityCredentialId?.trim() || null;

    this.sessionTokens.set(profileId, {
      deviceToken: token,
      identityToken,
      deviceCredentialId,
      identityCredentialId,
      humanPrincipalId,
      updatedAt
    });

    if (!this.safeStorage.isEncryptionAvailable()) {
      // Never write plaintext tokens to disk.
      if (document.credentials[profileId]) {
        delete document.credentials[profileId];
        await this.persist(document);
      }
      return "session-only";
    }

    document.credentials[profileId] = {
      encryptedDeviceToken: this.encrypt(token),
      encryptedIdentityToken: identityToken === null ? null : this.encrypt(identityToken),
      deviceCredentialId,
      identityCredentialId,
      humanPrincipalId,
      updatedAt
    };
    await this.persist(document);
    return "persisted";
  }

  async clear(profileId: string): Promise<void> {
    this.sessionTokens.delete(profileId);
    const document = await this.load();
    if (document.credentials[profileId]) {
      delete document.credentials[profileId];
      await this.persist(document);
    }
  }

  /** True when any in-memory session-only credential exists while storage is unavailable. */
  async hasAnySessionOnlyCredential(): Promise<boolean> {
    if (this.safeStorage.isEncryptionAvailable()) {
      return false;
    }
    return this.sessionTokens.size > 0;
  }

  /** Drop all in-memory tokens (e.g. app shutdown). Durable ciphertext remains when available. */
  clearSessionMemory(): void {
    this.sessionTokens.clear();
  }
}
