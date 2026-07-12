import { mkdir, readFile, rename, writeFile, unlink, readdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { desktopHomePaths } from "./planweaveHomePaths.js"
import type { RemoteProfile } from "../shared/remoteTypes.js"

function profileDir(): string {
  return join(desktopHomePaths().planweaveHome, "desktop", "remote-profiles")
}

function profilePath(profileId: string): string {
  return join(profileDir(), `${profileId}.json`)
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(tempPath, path)
}

function isMissingPathError(caught: unknown): boolean {
  return caught instanceof Error && "code" in caught && caught.code === "ENOENT"
}

function normalizeUrl(url: string): string {
  let normalized = url.trim().replace(/\/+$/, "")
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = `https://${normalized}`
  }
  return normalized
}

export async function createRemoteProfile(input: {
  name: string
  serverUrl: string
  deviceId: string
  apiKey: string
  projectId?: string
  userId?: string
}): Promise<RemoteProfile> {
  const id = randomUUID().split("-").join("").slice(0, 16)
  const serverUrl = normalizeUrl(input.serverUrl)
  let sessionToken = input.apiKey.trim()
  if (input.projectId && input.userId) {
    const response = await fetch(`${serverUrl}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: input.projectId, userId: input.userId, displayName: input.userId, deviceId: input.deviceId, joinToken: input.apiKey }) })
    const body = await response.json().catch(() => null) as { session?: { id: string }; error?: { message?: string } } | null
    if (!response.ok || !body?.session) throw new Error(body?.error?.message ?? `Team join failed with HTTP ${response.status}`)
    sessionToken = body.session.id
  }
  const profile: RemoteProfile = {
    id,
    name: input.name.trim(),
    serverUrl,
    deviceId: input.deviceId.trim(),
    apiKey: sessionToken,
    projectId: input.projectId?.trim(),
    userId: input.userId?.trim(),
    createdAt: new Date().toISOString()
  }
  await writeJsonAtomically(profilePath(id), profile)
  return profile
}

export async function updateRemoteProfile(
  id: string,
  input: {
    name?: string
    serverUrl?: string
    deviceId?: string
    apiKey?: string
  }
): Promise<RemoteProfile> {
  const current = await getRemoteProfile(id)
  if (!current) {
    throw new Error(`Remote profile '${id}' not found`)
  }
  const updated: RemoteProfile = {
    ...current,
    name: input.name !== undefined ? input.name.trim() || current.name : current.name,
    serverUrl: input.serverUrl !== undefined ? normalizeUrl(input.serverUrl) : current.serverUrl,
    deviceId: input.deviceId !== undefined ? input.deviceId.trim() || current.deviceId : current.deviceId,
    apiKey: input.apiKey !== undefined ? input.apiKey.trim() || current.apiKey : current.apiKey
  }
  await writeJsonAtomically(profilePath(id), updated)
  return updated
}

export async function deleteRemoteProfile(id: string): Promise<void> {
  try {
    await unlink(profilePath(id))
  } catch (caught) {
    if (!isMissingPathError(caught)) {
      throw caught
    }
  }
}

export async function getRemoteProfile(id: string): Promise<RemoteProfile | null> {
  try {
    const raw = await readFile(profilePath(id), "utf8")
    return JSON.parse(raw) as RemoteProfile
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return null
    }
    throw caught
  }
}

export async function listRemoteProfiles(): Promise<RemoteProfile[]> {
  try {
    const entries = await readdir(profileDir())
    const jsonFiles = entries.filter((entry) => entry.endsWith(".json"))
    const profiles = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const raw = await readFile(join(profileDir(), file), "utf8")
          return JSON.parse(raw) as RemoteProfile
        } catch {
          return null
        }
      })
    )
    return profiles.filter((p): p is RemoteProfile => p !== null)
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return []
    }
    throw caught
  }
}
