import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  credentialStoragePreferenceSchema,
  type CredentialStorageMode,
  type CredentialStoragePreference
} from "../../shared/credentialStorageSettings.js";

const DEFAULT_PREFERENCE: CredentialStoragePreference = { version: 1, mode: "application" };

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class CredentialStoragePreferenceStore {
  constructor(readonly path: string) {}

  readSync(): CredentialStoragePreference {
    try {
      return credentialStoragePreferenceSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if (isMissingFileError(error)) return DEFAULT_PREFERENCE;
      throw new Error("credential_storage_preference_invalid", { cause: error });
    }
  }

  async read(): Promise<CredentialStoragePreference> {
    try {
      return credentialStoragePreferenceSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (isMissingFileError(error)) return DEFAULT_PREFERENCE;
      throw new Error("credential_storage_preference_invalid", { cause: error });
    }
  }

  async write(input: { mode: CredentialStorageMode }): Promise<CredentialStoragePreference> {
    const preference = credentialStoragePreferenceSchema.parse({ version: 1, mode: input.mode });
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(preference, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.path);
    return preference;
  }
}
