import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  operatorControlProfileSchema,
  type OperatorControlProfile
} from "../../shared/operatorControl.js";
import { migrateRetiredPrivateHttpsProfileEndpoints } from "../deploymentEndpointPersistenceMigration.js";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const storedOperatorProfileSchema = operatorControlProfileSchema.extend({
  updatedAt: z.iso.datetime()
});

const operatorProfilesDocumentSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(storedOperatorProfileSchema),
    activeProfileId: z.string().trim().min(1).max(128).nullable()
  })
  .strict()
  .superRefine((document, context) => {
    const seen = new Set<string>();
    for (const [index, profile] of document.profiles.entries()) {
      if (seen.has(profile.profileId)) {
        context.addIssue({
          code: "custom",
          message: "duplicate operator profile id",
          path: ["profiles", index, "profileId"]
        });
      }
      seen.add(profile.profileId);
    }
    if (
      document.activeProfileId !== null &&
      !document.profiles.some((profile) => profile.profileId === document.activeProfileId)
    ) {
      context.addIssue({
        code: "custom",
        message: "active operator profile is missing",
        path: ["activeProfileId"]
      });
    }
  });

export type StoredOperatorProfile = z.infer<typeof storedOperatorProfileSchema>;
export type OperatorProfilesDocument = z.infer<typeof operatorProfilesDocumentSchema>;

export type OperatorProfileStorePaths = { profilesPath: string };

export function operatorProfileStorePaths(
  profilesPath: string = desktopHomePaths().operatorProfilesFile
): OperatorProfileStorePaths {
  return { profilesPath };
}

function defaultDocument(): OperatorProfilesDocument {
  return { version: 1, profiles: [], activeProfileId: null };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function ensurePrivateFileParent(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateFileParent(path);
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  const written = await stat(temporaryPath);
  if ((written.mode & 0o777) !== 0o600) await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

/** Durable operator identity metadata; no credential or transport override is accepted. */
export class OperatorProfileStore {
  private loaded: OperatorProfilesDocument | null = null;
  private loading: Promise<OperatorProfilesDocument> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly paths: OperatorProfileStorePaths = operatorProfileStorePaths()) {}

  get profilesPath(): string {
    return this.paths.profilesPath;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private load(): Promise<OperatorProfilesDocument> {
    if (this.loaded) return Promise.resolve(this.loaded);
    if (this.loading) return this.loading;
    const loading = this.readDocument()
      .then((document) => {
        this.loaded = document;
        return document;
      })
      .finally(() => {
        if (this.loading === loading) this.loading = undefined;
      });
    this.loading = loading;
    return loading;
  }

  private async readDocument(): Promise<OperatorProfilesDocument> {
    let raw: string;
    try {
      raw = await readFile(this.paths.profilesPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return defaultDocument();
      }
      throw new Error("Failed to read operator profiles.");
    }
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new Error("Invalid operator profiles JSON.");
    }
    const migration = migrateRetiredPrivateHttpsProfileEndpoints(input);
    let parsed: OperatorProfilesDocument;
    try {
      parsed = operatorProfilesDocumentSchema.parse(migration.input);
    } catch {
      throw new Error("Invalid operator profiles JSON.");
    }
    if (migration.migrated) await writePrivateJson(this.paths.profilesPath, parsed);
    return parsed;
  }

  private async persist(document: OperatorProfilesDocument): Promise<OperatorProfilesDocument> {
    const parsed = operatorProfilesDocumentSchema.parse(document);
    await writePrivateJson(this.paths.profilesPath, parsed);
    this.loaded = parsed;
    return parsed;
  }

  read(): Promise<OperatorProfilesDocument> {
    return this.exclusive(async () => operatorProfilesDocumentSchema.parse(await this.load()));
  }

  write(document: OperatorProfilesDocument): Promise<OperatorProfilesDocument> {
    return this.exclusive(async () =>
      operatorProfilesDocumentSchema.parse(await this.persist(document))
    );
  }

  async list(): Promise<StoredOperatorProfile[]> {
    return [...(await this.read()).profiles];
  }

  async get(profileId: string): Promise<StoredOperatorProfile | null> {
    const document = await this.read();
    return document.profiles.find((profile) => profile.profileId === profileId) ?? null;
  }

  async upsert(profile: OperatorControlProfile): Promise<StoredOperatorProfile> {
    return this.exclusive(async () => {
      const document = operatorProfilesDocumentSchema.parse(await this.load());
      const stored: StoredOperatorProfile = {
        ...operatorControlProfileSchema.parse(profile),
        updatedAt: new Date().toISOString()
      };
      const index = document.profiles.findIndex((entry) => entry.profileId === stored.profileId);
      if (index >= 0) document.profiles[index] = stored;
      else document.profiles.push(stored);
      await this.persist(document);
      return stored;
    });
  }

  async remove(profileId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const document = operatorProfilesDocumentSchema.parse(await this.load());
      const next = document.profiles.filter((profile) => profile.profileId !== profileId);
      if (next.length === document.profiles.length) return false;
      document.profiles = next;
      if (document.activeProfileId === profileId) document.activeProfileId = null;
      await this.persist(document);
      return true;
    });
  }

  async getActiveProfileId(): Promise<string | null> {
    return (await this.read()).activeProfileId;
  }

  async setActiveProfileId(profileId: string | null): Promise<void> {
    return this.exclusive(async () => {
      const document = operatorProfilesDocumentSchema.parse(await this.load());
      if (
        profileId !== null &&
        !document.profiles.some((profile) => profile.profileId === profileId)
      ) {
        throw new Error(`Unknown operator profile: ${profileId}`);
      }
      document.activeProfileId = profileId;
      await this.persist(document);
    });
  }
}
