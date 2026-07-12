import { randomUUID } from "node:crypto"
import type { WebSocket as WsWebSocket } from "ws"
import type {
  RemoteProfile,
  RemoteProjectSnapshot,
  RemoteMessage,
  RemoteProposal,
  RemoteApproval,
  RemoteMember,
  RemoteMergeStatus,
  RemoteEventPayload,
  RemoteConnectionStatus,
  RemoteTask
} from "../shared/remoteTypes.js"

const DEFAULT_TIMEOUT_MS = 15_000

type EventCallback = (payload: RemoteEventPayload) => void

type RemoteClientState = {
  profile: RemoteProfile
  projectId: string
  ws: WsWebSocket | null
  lastEventId: string | null
  eventCallbacks: Set<EventCallback>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  pollTimer: ReturnType<typeof setInterval> | null
  closing: boolean
}

const connections = new Map<string, RemoteClientState>()

function connectionKey(profileId: string): string {
  return profileId
}

export function getRemoteConnectionStatus(profileId: string): RemoteConnectionStatus {
  const state = connections.get(connectionKey(profileId))
  if (!state) return "disconnected"
  if (state.closing) return "disconnected"
  if (state.ws && state.ws.readyState === 1 /* OPEN */) return "connected"
  return "connecting"
}

export async function connectRemote(
  profile: RemoteProfile,
  projectId: string,
  onEvent: EventCallback
): Promise<void> {
  const key = connectionKey(profile.id)
  const existing = connections.get(key)
  if (existing) {
    if (!existing.closing && existing.projectId === projectId) {
      existing.eventCallbacks.add(onEvent)
      return
    }
    await disconnectRemote(profile.id)
  }

  const state: RemoteClientState = {
    profile,
    projectId,
    ws: null,
    lastEventId: null,
    eventCallbacks: new Set([onEvent]),
    reconnectTimer: null,
    pollTimer: null,
    closing: false
  }
  connections.set(key, state)

  const snapshot = await httpGet<RemoteProjectSnapshot>(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/snapshot`)
  state.lastEventId = snapshot.lastEventId
  startEventPolling(state)
  void establishConnection(state).catch(() => undefined)
}

async function establishConnection(state: RemoteClientState): Promise<void> {
  const { profile, projectId } = state

  const wsUrl = profile.serverUrl.replace(/^http/, "ws")
  const url = new URL(wsUrl)
  url.pathname = "/events"

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${profile.apiKey}`,
    "X-Device-Id": profile.deviceId
  }

  let ws: WsWebSocket
  try {
    const { WebSocket } = await import("ws")
    ws = new WebSocket(url.toString(), { headers })
  } catch {
    throw new Error("WebSocket constructor unavailable. Ensure the 'ws' package is installed.")
  }

  state.ws = ws

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`WebSocket connection to ${profile.serverUrl} timed out`))
    }, DEFAULT_TIMEOUT_MS)

    ws.on("open", () => {
      clearTimeout(timeout)
      resolve()
    })

    ws.on("error", (error) => {
      clearTimeout(timeout)
      reject(error instanceof Error ? error : new Error(String(error)))
    })

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const raw = Array.isArray(data) ? Buffer.concat(data as Buffer[]).toString("utf8") : (data as Buffer).toString("utf8")
        const message = JSON.parse(raw) as { kind: string; event?: { eventId: string; projectId: string; type: string; aggregateType: string; aggregateId: string; aggregateVersion: number; occurredAt: string } }
        if (message.kind === "event" && message.event) {
          const event = message.event
          state.lastEventId = event.eventId
          const payload: RemoteEventPayload = {
            profileId: state.profile.id,
            projectId: event.projectId,
            eventType: event.type,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            aggregateVersion: event.aggregateVersion,
            occurredAt: event.occurredAt
          }
          for (const cb of state.eventCallbacks) {
            try {
              cb(payload)
            } catch {
              /* best-effort */
            }
          }
        }
      } catch {
        /* skip malformed messages */
      }
    })

    ws.on("close", (_code: number, _reason: Buffer) => {
      state.ws = null
      if (state.closing) {
        connections.delete(connectionKey(state.profile.id))
        return
      }
      scheduleReconnect(state)
    })

    ws.on("error", () => {
      /* close handler fires next */
    })
  })
}

function startEventPolling(state: RemoteClientState): void {
  if (state.pollTimer) return
  state.pollTimer = setInterval(() => {
    if (state.closing) return
    void httpGet<{ items: Array<{ eventId: string; projectId: string; type: string; aggregateType: string; aggregateId: string; aggregateVersion: number; occurredAt: string }> }>(state.profile, `/api/v1/projects/${encodeURIComponent(state.projectId)}/events?afterEventId=${encodeURIComponent(state.lastEventId ?? "0")}&limit=100`).then((page) => {
      for (const event of page.items) {
        state.lastEventId = event.eventId
        const payload: RemoteEventPayload = { profileId: state.profile.id, projectId: event.projectId, eventType: event.type, aggregateType: event.aggregateType, aggregateId: event.aggregateId, aggregateVersion: event.aggregateVersion, occurredAt: event.occurredAt }
        for (const callback of state.eventCallbacks) callback(payload)
      }
    }).catch(() => undefined)
  }, 2_000)
}

function scheduleReconnect(state: RemoteClientState): void {
  if (state.closing) return
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    if (state.closing) return
    void establishConnection(state).catch(() => {
      scheduleReconnect(state)
    })
  }, 5_000)
}

export async function disconnectRemote(profileId: string): Promise<void> {
  const state = connections.get(connectionKey(profileId))
  if (!state) return

  state.closing = true
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer)
    state.pollTimer = null
  }
  if (state.ws) {
    state.ws.close()
    state.ws = null
  }
  connections.delete(connectionKey(profileId))
}

export function isRemoteConnected(profileId: string): boolean {
  return getRemoteConnectionStatus(profileId) === "connected"
}

async function httpGet<T>(profile: RemoteProfile, path: string): Promise<T> {
  const url = `${profile.serverUrl}${path}`
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${profile.apiKey}`,
      "X-Device-Id": profile.deviceId,
      "X-Request-Id": randomUUID(),
      "Accept": "application/json"
    }
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`HTTP ${response.status} from ${url}: ${body}`)
  }

  return (await response.json()) as T
}

async function httpPost<T>(profile: RemoteProfile, path: string, body: unknown): Promise<T> {
  const url = `${profile.serverUrl}${path}`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${profile.apiKey}`,
      "X-Device-Id": profile.deviceId,
      "X-Request-Id": randomUUID(),
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`HTTP ${response.status} from ${url}: ${errorBody}`)
  }

  return (await response.json()) as T
}

export async function getRemoteProjectSnapshot(profile: RemoteProfile, projectId: string): Promise<RemoteProjectSnapshot> {
  const serverSnapshot = await httpGet<{ project: RemoteProjectSnapshot["project"]; lastEventId: string }>(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/snapshot`)
  const project = serverSnapshot.project
  const lastEventId = serverSnapshot.lastEventId

  let members: RemoteMember[] = []
  try {
    members = await httpGet<RemoteMember[]>(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/members`)
  } catch {
    /* members endpoint may not exist yet */
  }

  let planningRooms: RemoteProjectSnapshot["planningRooms"] = []
  try {
    planningRooms = await httpGet<RemoteProjectSnapshot["planningRooms"]>(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/rooms`)
  } catch {
    /* rooms endpoint may not exist yet */
  }

  let proposals: RemoteProposal[] = []
  try {
    proposals = await httpGet<RemoteProposal[]>(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/proposals`)
  } catch {
    /* proposals endpoint may not exist yet */
  }

  const state = connections.get(connectionKey(profile.id))
  const mergeStatus: RemoteMergeStatus = {
    aheadCount: 0,
    behindCount: 0,
    hasConflicts: false,
    lastSyncedEventId: state?.lastEventId ?? null
  }

  return {
    project,
    lastEventId: lastEventId ?? "0",
    planningRooms,
    members,
    proposals,
    mergeStatus
  }
}

export async function getRemotePlanningRooms(profile: RemoteProfile, projectId: string): Promise<Array<{ id: string; name: string; archivedAt: string | null }>> {
  return httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/rooms`)
}

export async function getRemoteMessages(profile: RemoteProfile, projectId: string, roomId: string): Promise<RemoteMessage[]> {
  return httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/rooms/${encodeURIComponent(roomId)}/messages`)
}

export async function sendRemoteMessage(profile: RemoteProfile, projectId: string, roomId: string, body: string): Promise<RemoteMessage> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/rooms/${encodeURIComponent(roomId)}/messages`, { body })
}

export async function getRemoteProposals(profile: RemoteProfile, projectId: string): Promise<RemoteProposal[]> {
  return httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/proposals`)
}

export async function approveRemoteProposal(
  profile: RemoteProfile,
  projectId: string,
  proposalId: string,
  decision: "approve" | "reject",
  reason?: string
): Promise<RemoteApproval> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/approve`, { decision, reason })
}

export async function getRemoteMembers(profile: RemoteProfile, projectId: string): Promise<RemoteMember[]> {
  return httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/members`)
}

export async function getRemoteTasks(profile: RemoteProfile, projectId: string): Promise<RemoteTask[]> {
  return httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`)
}

export async function claimRemoteTask(profile: RemoteProfile, projectId: string, taskId: string, branchName: string, baseCommit: string): Promise<unknown> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/claim`, { branchName, baseCommit, leaseDurationSeconds: 3600 })
}

export async function getRemoteMergeStatus(profile: RemoteProfile, projectId: string): Promise<RemoteMergeStatus> {
  const state = connections.get(connectionKey(profile.id))
  return {
    aheadCount: 0,
    behindCount: 0,
    hasConflicts: false,
    lastSyncedEventId: state?.lastEventId ?? null
  }
}
