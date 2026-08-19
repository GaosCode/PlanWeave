import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  opaqueIdentifierSchema,
  timestampSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  workspaceConnectionProfileSchema,
  type WorkspaceConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const storedWorkspaceConnectionProfileSchema = workspaceConnectionProfileSchema.extend({
  workspaceDisplayName: z.string().trim().min(1).max(128),
  membershipRole: z.enum(["owner", "member"]).nullable(),
  membershipActive: z.boolean(),
  updatedAt: timestampSchema
});

const lastServerConnectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("remote"),
      profileId: opaqueIdentifierSchema
    })
    .strict()
]);

const workspaceConnectionProfilesDocumentSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(storedWorkspaceConnectionProfileSchema),
    activeProfileId: opaqueIdentifierSchema.nullable(),
    lastConnection: lastServerConnectionSchema.optional()
  })
  .strict()
  .superRefine((document, ctx) => {
    const seen = new Set<string>();
    for (const [index, profile] of document.profiles.entries()) {
      if (seen.has(profile.profileId)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate workspace connection profile id",
          path: ["profiles", index, "profileId"]
        });
      }
      seen.add(profile.profileId);
    }
    if (
      document.activeProfileId !== null &&
      !document.profiles.some((profile) => profile.profileId === document.activeProfileId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "active workspace connection profile is missing",
        path: ["activeProfileId"]
      });
    }
  });

export type StoredWorkspaceConnectionProfile = z.infer<
  typeof storedWorkspaceConnectionProfileSchema
>;
export type LastServerConnection = z.infer<typeof lastServerConnectionSchema>;
export type WorkspaceConnectionProfilesDocument = z.infer<
  typeof workspaceConnectionProfilesDocumentSchema
>;

function defaultDocument(): WorkspaceConnectionProfilesDocument {
  return {
    version: 1,
    profiles: [],
    activeProfileId: null
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function nowIso(): string {
  return new Date().toISOString();
}

export type WorkspaceConnectionProfileStorePaths = {
  profilesPath: string;
};

export function workspaceConnectionProfileStorePaths(
  profilesPath: string = join(desktopHomePaths().collaborationDir, "workspace-profiles.json")
): WorkspaceConnectionProfileStorePaths {
  return { profilesPath };
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
 * Durable Workspace connection profiles (no credentials).
 * Local-only projects never appear here until the user explicitly redeems/connects.
 */
export class WorkspaceConnectionProfileStore {
  private readonly paths: WorkspaceConnectionProfileStorePaths;
  private loaded: WorkspaceConnectionProfilesDocument | null = null;

  constructor(
    paths: WorkspaceConnectionProfileStorePaths = workspaceConnectionProfileStorePaths()
  ) {
    this.paths = paths;
  }

  get profilesPath(): string {
    return this.paths.profilesPath;
  }

  async read(): Promise<WorkspaceConnectionProfilesDocument> {
    if (this.loaded) {
      return this.loaded;
    }
    let raw: string;
    try {
      raw = await readFile(this.paths.profilesPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        this.loaded = defaultDocument();
        return this.loaded;
      }
      throw new Error("Failed to read workspace connection profiles.");
    }
    try {
      this.loaded = workspaceConnectionProfilesDocumentSchema.parse(JSON.parse(raw));
      return this.loaded;
    } catch {
      throw new Error("Invalid workspace connection profiles JSON.");
    }
  }

  async write(
    document: WorkspaceConnectionProfilesDocument
  ): Promise<WorkspaceConnectionProfilesDocument> {
    const parsed = workspaceConnectionProfilesDocumentSchema.parse(document);
    await writePrivateJson(this.paths.profilesPath, parsed);
    this.loaded = parsed;
    return parsed;
  }

  async list(): Promise<StoredWorkspaceConnectionProfile[]> {
    const document = await this.read();
    return [...document.profiles];
  }

  async get(profileId: string): Promise<StoredWorkspaceConnectionProfile | null> {
    const document = await this.read();
    return document.profiles.find((profile) => profile.profileId === profileId) ?? null;
  }

  async upsert(input: {
    profile: WorkspaceConnectionProfile;
    workspaceDisplayName: string;
    membershipRole?: "owner" | "member" | null;
    membershipActive?: boolean;
  }): Promise<StoredWorkspaceConnectionProfile> {
    const document = await this.read();
    const stored: StoredWorkspaceConnectionProfile = {
      ...workspaceConnectionProfileSchema.parse(input.profile),
      workspaceDisplayName: input.workspaceDisplayName.trim(),
      membershipRole: input.membershipRole ?? null,
      membershipActive: input.membershipActive ?? true,
      updatedAt: nowIso()
    };
    const index = document.profiles.findIndex((entry) => entry.profileId === stored.profileId);
    if (index >= 0) {
      document.profiles[index] = stored;
    } else {
      document.profiles.push(stored);
    }
    await this.write(document);
    return stored;
  }

  async remove(profileId: string): Promise<boolean> {
    const document = await this.read();
    const next = document.profiles.filter((profile) => profile.profileId !== profileId);
    if (next.length === document.profiles.length) {
      return false;
    }
    document.profiles = next;
    if (document.activeProfileId === profileId) {
      document.activeProfileId = null;
    }
    if (
      document.lastConnection?.kind === "remote" &&
      document.lastConnection.profileId === profileId
    ) {
      document.lastConnection = { kind: "local" };
    }
    await this.write(document);
    return true;
  }

  async getActiveProfileId(): Promise<string | null> {
    const document = await this.read();
    return document.activeProfileId;
  }

  async setActiveProfileId(profileId: string | null): Promise<void> {
    const document = await this.read();
    if (profileId === null) {
      document.activeProfileId = null;
      await this.write(document);
      return;
    }
    if (!document.profiles.some((profile) => profile.profileId === profileId)) {
      throw new Error(`Unknown workspace connection profile: ${profileId}`);
    }
    document.activeProfileId = profileId;
    await this.write(document);
  }

  async getLastConnection(): Promise<LastServerConnection | undefined> {
    const document = await this.read();
    return document.lastConnection;
  }

  async setLastConnection(lastConnection: LastServerConnection): Promise<void> {
    const document = await this.read();
    await this.write({ ...document, lastConnection });
  }
}
