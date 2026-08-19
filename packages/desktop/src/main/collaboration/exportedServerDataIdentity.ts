import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  opaqueIdentifierSchema,
  timestampSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

export const EXPORTED_SERVER_DATA_PROFILE_ID = "planweave-exported-server-data";
export const EXPORTED_SERVER_DATA_IDENTITY_SCHEMA_VERSION =
  "exported-server-data-identity/v1" as const;

export const exportedServerDataIdentitySchema = z
  .object({
    schemaVersion: z.literal(EXPORTED_SERVER_DATA_IDENTITY_SCHEMA_VERSION),
    workspaceId: opaqueIdentifierSchema,
    workspaceDisplayName: z.string().trim().min(1).max(128),
    membershipRole: z.enum(["owner", "member"]).nullable(),
    updatedAt: timestampSchema
  })
  .strict();
export type ExportedServerDataIdentity = z.infer<typeof exportedServerDataIdentitySchema>;

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  const written = await stat(path);
  if ((written.mode & 0o777) !== 0o600) {
    await chmod(path, 0o600);
  }
}

export function isExportedServerDataProfileId(profileId: string): boolean {
  return profileId === EXPORTED_SERVER_DATA_PROFILE_ID;
}

export class ExportedServerDataIdentityStore {
  constructor(private readonly identityPath: string) {}

  static defaultPath(): string {
    return desktopHomePaths().exportedServerDataIdentityFile;
  }

  async read(): Promise<ExportedServerDataIdentity | null> {
    try {
      return exportedServerDataIdentitySchema.parse(
        JSON.parse(await readFile(this.identityPath, "utf8"))
      );
    } catch (error) {
      if (isMissingFileError(error)) return null;
      return null;
    }
  }

  async write(identity: ExportedServerDataIdentity): Promise<void> {
    await writePrivateJson(this.identityPath, exportedServerDataIdentitySchema.parse(identity));
  }
}
