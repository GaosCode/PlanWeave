import type { RemoteProfile, RemoteEventPayload } from "../shared/remoteTypes.js"

export type RemoteEventSyncState = {
  profileId: string
  projectId: string
  lastEventId: string | null
  invalidated: boolean
}

const eventSyncStates = new Map<string, RemoteEventSyncState>()

function syncKey(profileId: string, projectId: string): string {
  return `${profileId}::${projectId}`
}

export function registerRemoteEventSync(profileId: string, projectId: string): RemoteEventSyncState {
  const key = syncKey(profileId, projectId)
  const existing = eventSyncStates.get(key)
  if (existing) {
    return existing
  }
  const state: RemoteEventSyncState = {
    profileId,
    projectId,
    lastEventId: null,
    invalidated: false
  }
  eventSyncStates.set(key, state)
  return state
}

export function handleRemoteEvent(payload: RemoteEventPayload): void {
  const key = syncKey(payload.profileId, payload.projectId)
  const state = eventSyncStates.get(key)
  if (!state) return

  state.lastEventId = payload.eventId
  state.invalidated = true
}

export function isRemoteInvalidated(profileId: string, projectId: string): boolean {
  return eventSyncStates.get(syncKey(profileId, projectId))?.invalidated ?? false
}

export function clearRemoteInvalidation(profileId: string, projectId: string): void {
  const state = eventSyncStates.get(syncKey(profileId, projectId))
  if (state) {
    state.invalidated = false
  }
}

export function getRemoteLastEventId(profileId: string, projectId: string): string | null {
  return eventSyncStates.get(syncKey(profileId, projectId))?.lastEventId ?? null
}

export function unregisterRemoteEventSync(profileId: string, projectId: string): void {
  eventSyncStates.delete(syncKey(profileId, projectId))
}

export function shouldUseRemoteWatch(projectRoot: string, profileId?: string | null): boolean {
  return Boolean(profileId)
}
