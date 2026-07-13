import { mkdir, readFile, rename, writeFile, unlink, readdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { desktopHomePaths } from "./planweaveHomePaths.js"
import type { RemoteProfile } from "../shared/remoteTypes.js"

const PROFILE_ID_RE = /^[0-9a-f]{16}$/
export type RemoteProfileWithCredentials = RemoteProfile & { apiKey: string; resumeToken?: string }

function profileDir(): string {
  return join(desktopHomePaths().planweaveHome, "desktop", "remote-profiles")
}

function profilePath(profileId: string): string {
  if (!PROFILE_ID_RE.test(profileId)) throw new Error("Invalid remote profile id")
  return join(profileDir(), `${profileId}.json`)
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(tempPath, path)
}

function publicProfile(profile: RemoteProfileWithCredentials): RemoteProfile {
  const { apiKey: _apiKey, resumeToken: _resumeToken, ...metadata } = profile
  return metadata
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
  let resumeToken: string | undefined
  if (input.projectId && input.userId) {
    const response = await fetch(`${serverUrl}/api/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: input.projectId, userId: input.userId, displayName: input.userId, deviceId: input.deviceId, joinToken: input.apiKey }) })
    const body = await response.json().catch(() => null) as { session?: { id: string }; resumeToken?: string; userId?: string; deviceId?: string; error?: { message?: string } } | null
    if (!response.ok || !body?.session) throw new Error(body?.error?.message ?? `Team join failed with HTTP ${response.status}`)
    sessionToken = body.session.id
    resumeToken = body.resumeToken
    if (!body.userId || !body.deviceId) throw new Error("Team join response omitted server-issued identity")
    input.userId = body.userId
    input.deviceId = body.deviceId
  }
  const profile: RemoteProfileWithCredentials = {
    id,
    name: input.name.trim(),
    serverUrl,
    deviceId: input.deviceId.trim(),
    apiKey: sessionToken,
    ...(resumeToken ? { resumeToken } : {}),
    projectId: input.projectId?.trim(),
    userId: input.userId?.trim(),
    createdAt: new Date().toISOString()
  }
  await writeJsonAtomically(profilePath(id), profile)
  return publicProfile(profile)
}

export async function updateRemoteSession(id: string, sessionToken: string): Promise<RemoteProfileWithCredentials> {
  const current = await getRemoteProfileWithCredentials(id)
  if (!current) throw new Error(`Remote profile '${id}' not found`)
  const updated = { ...current, apiKey: sessionToken }
  await writeJsonAtomically(profilePath(id), updated)
  return updated
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
  const current = await getRemoteProfileWithCredentials(id)
  if (!current) {
    throw new Error(`Remote profile '${id}' not found`)
  }
  const updated: RemoteProfileWithCredentials = {
    ...current,
    name: input.name !== undefined ? input.name.trim() || current.name : current.name,
    serverUrl: input.serverUrl !== undefined ? normalizeUrl(input.serverUrl) : current.serverUrl,
    deviceId: input.deviceId !== undefined ? input.deviceId.trim() || current.deviceId : current.deviceId,
    apiKey: input.apiKey !== undefined ? input.apiKey.trim() || current.apiKey : current.apiKey
  }
  await writeJsonAtomically(profilePath(id), updated)
  return publicProfile(updated)
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
  const profile = await getRemoteProfileWithCredentials(id)
  return profile ? publicProfile(profile) : null
}

export async function getRemoteProfileWithCredentials(id: string): Promise<RemoteProfileWithCredentials | null> {
  try {
    const raw = await readFile(profilePath(id), "utf8")
    return JSON.parse(raw) as RemoteProfileWithCredentials
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
          return publicProfile(JSON.parse(raw) as RemoteProfileWithCredentials)
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
