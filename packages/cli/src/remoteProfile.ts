import { mkdir, open, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const CONFIG_DIR = join(homedir(), ".planweave", "config");
const PROFILES_PATH = join(CONFIG_DIR, "profiles.json");
const CREDENTIALS_DIR = join(CONFIG_DIR, "credentials");

export type RemoteProfile = {
  name: string;
  serverUrl: string;
  projectId: string;
  deviceId: string;
  userId: string;
  sessionId: string | null;
  sessionExpiresAt: string | null;
  currentAssignmentId: string | null;
  currentAssignmentVersion: number | null;
  currentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
};

type ProfilesFile = {
  version: 1;
  profiles: RemoteProfile[];
};

function defaultProfilesFile(): ProfilesFile {
  return { version: 1, profiles: [] };
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

async function ensureCredentialsDir(): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true });
  await chmod(CREDENTIALS_DIR, 0o700);
}

async function readProfilesFile(): Promise<ProfilesFile> {
  try {
    const raw = await readFile(PROFILES_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ProfilesFile;
    if (parsed.version === 1 && Array.isArray(parsed.profiles)) return parsed;
    return defaultProfilesFile();
  } catch {
    return defaultProfilesFile();
  }
}

async function writeProfilesFile(file: ProfilesFile): Promise<void> {
  await ensureConfigDir();
  const tmp = PROFILES_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await writeFile(PROFILES_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
  // best-effort tmp cleanup
  try { const { unlink } = await import("node:fs/promises"); await unlink(tmp); } catch { /* ignore */ }
}

const CREDENTIAL_FILE_MODE = 0o600;

async function readCredentialFile(name: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(CREDENTIALS_DIR, `${name}.json`), "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeCredentialFile(name: string, data: Record<string, unknown>): Promise<void> {
  await ensureCredentialsDir();
  const path = join(CREDENTIALS_DIR, `${name}.json`);
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: CREDENTIAL_FILE_MODE });
  await writeFile(path, JSON.stringify(data, null, 2), { mode: CREDENTIAL_FILE_MODE });
  try { const { unlink } = await import("node:fs/promises"); await unlink(tmp); } catch { /* ignore */ }
}

async function deleteCredentialFile(name: string): Promise<void> {
  try {
    await unlink(join(CREDENTIALS_DIR, `${name}.json`));
  } catch { /* ignore */ }
}

export async function listProfiles(): Promise<RemoteProfile[]> {
  const file = await readProfilesFile();
  return file.profiles;
}

export async function getProfile(name: string): Promise<RemoteProfile | null> {
  const file = await readProfilesFile();
  return file.profiles.find((p) => p.name === name) ?? null;
}

export async function saveProfile(profile: RemoteProfile): Promise<void> {
  const file = await readProfilesFile();
  const index = file.profiles.findIndex((p) => p.name === profile.name);
  if (index >= 0) {
    file.profiles[index] = profile;
  } else {
    file.profiles.push(profile);
  }
  await writeProfilesFile(file);
}

export async function deleteProfile(name: string): Promise<boolean> {
  const file = await readProfilesFile();
  const index = file.profiles.findIndex((p) => p.name === name);
  if (index < 0) return false;
  file.profiles.splice(index, 1);
  await writeProfilesFile(file);
  await deleteCredentialFile(name);
  return true;
}

export async function saveCredentials(profileName: string, credentials: { sessionToken: string; deviceSecret: string }): Promise<void> {
  await writeCredentialFile(profileName, {
    sessionToken: credentials.sessionToken,
    deviceSecret: credentials.deviceSecret,
    updatedAt: new Date().toISOString()
  });
}

export async function loadCredentials(profileName: string): Promise<{ sessionToken: string; deviceSecret: string } | null> {
  const data = await readCredentialFile(profileName);
  if (!data || typeof data.sessionToken !== "string" || typeof data.deviceSecret !== "string") return null;
  return { sessionToken: data.sessionToken, deviceSecret: data.deviceSecret };
}

export async function clearCredentials(profileName: string): Promise<void> {
  await deleteCredentialFile(profileName);
}

export function generateDeviceId(): string {
  return `dev_${randomUUID()}`;
}

export function generateIdempotencyKey(): string {
  return randomUUID();
}

async function unlink(path: string): Promise<void> {
  const { unlink: fsUnlink } = await import("node:fs/promises");
  await fsUnlink(path);
}

export async function updateProfileAssignment(
  profileName: string,
  assignment: { assignmentId: string; assignmentVersion: number; taskId: string } | null
): Promise<void> {
  const profile = await getProfile(profileName);
  if (!profile) throw new Error(`Profile '${profileName}' not found.`);
  profile.currentAssignmentId = assignment?.assignmentId ?? null;
  profile.currentAssignmentVersion = assignment?.assignmentVersion ?? null;
  profile.currentTaskId = assignment?.taskId ?? null;
  profile.updatedAt = new Date().toISOString();
  await saveProfile(profile);
}

export async function updateProfileSession(
  profileName: string,
  session: { sessionId: string; sessionExpiresAt: string } | null
): Promise<void> {
  const profile = await getProfile(profileName);
  if (!profile) throw new Error(`Profile '${profileName}' not found.`);
  profile.sessionId = session?.sessionId ?? null;
  profile.sessionExpiresAt = session?.sessionExpiresAt ?? null;
  profile.updatedAt = new Date().toISOString();
  await saveProfile(profile);
}
