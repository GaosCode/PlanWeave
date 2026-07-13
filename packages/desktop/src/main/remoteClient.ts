import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
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
  RemoteTask,
  RemoteCoordinationSnapshot,
  RemoteConsensusBaseline,
  RemoteAttachment,
  RemoteAssignment,
  RemoteMergeQueue
} from "../shared/remoteTypes.js"
import { updateRemoteSession, type RemoteProfileWithCredentials } from "./remoteProfiles.js"
import { readTeamCache, updateTeamCache, type TeamCache } from "./teamCache.js"

const DEFAULT_TIMEOUT_MS = 15_000

type EventCallback = (payload: RemoteEventPayload) => void

type RemoteClientState = {
  profile: RemoteProfileWithCredentials
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

async function authorizedFetch(profile: RemoteProfileWithCredentials, url: string, init: RequestInit): Promise<Response> {
  let response = await fetch(url, init)
  if ((response.status === 401 || response.status === 403) && profile.resumeToken && profile.projectId) {
    const resumed = await fetch(`${profile.serverUrl}/api/v1/resume`, { method: "POST", headers: { "content-type": "application/json", "accept": "application/json" }, body: JSON.stringify({ projectId: profile.projectId, deviceId: profile.deviceId, resumeToken: profile.resumeToken }) })
    if (resumed.ok) {
      const body = await resumed.json() as { session: { id: string } }
      profile.apiKey = body.session.id
      await updateRemoteSession(profile.id, body.session.id)
      const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${profile.apiKey}`)
      response = await fetch(url, { ...init, headers })
    }
  }
  return response
}

async function cachedTeamRead<T>(profile: RemoteProfileWithCredentials, projectId: string, field: Exclude<keyof TeamCache, "updatedAt">, load: () => Promise<T>): Promise<T> {
  try {
    const value = await load();
    await updateTeamCache(profile.id, projectId, { [field]: value });
    return value;
  } catch (error) {
    const cached = await readTeamCache(profile.id, projectId);
    if (cached?.[field] !== undefined) return cached[field] as T;
    throw error;
  }
}

export function getRemoteConnectionStatus(profileId: string): RemoteConnectionStatus {
  const state = connections.get(connectionKey(profileId))
  if (!state) return "disconnected"
  if (state.closing) return "disconnected"
  if (state.ws && state.ws.readyState === 1 /* OPEN */) return "connected"
  return "connecting"
}

export async function connectRemote(
  profile: RemoteProfileWithCredentials,
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

  let snapshot: RemoteProjectSnapshot
  try { snapshot = await httpGet<RemoteProjectSnapshot>(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/snapshot`) }
  catch (error) { const cached = await readTeamCache(profile.id, projectId); if (!cached?.projectSnapshot) throw error; snapshot = cached.projectSnapshot as RemoteProjectSnapshot }
  state.lastEventId = snapshot.lastEventId
  startEventPolling(state)
  void establishConnection(state).catch(() => scheduleReconnect(state))
}

async function establishConnection(state: RemoteClientState): Promise<void> {
  const { profile, projectId } = state

  const wsUrl = profile.serverUrl.replace(/^http/, "ws")
  const url = new URL(wsUrl)
  url.pathname = "/events"
  url.searchParams.set("projectId", projectId)
  url.searchParams.set("afterEventId", state.lastEventId ?? "0")

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${profile.apiKey}`,
    "X-Device-Id": profile.deviceId,
    "X-PlanWeave-Project-Id": projectId
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
          if (!advanceEventCursor(state, event.eventId)) return
          const payload: RemoteEventPayload = {
            profileId: state.profile.id,
            projectId: event.projectId,
            eventId: event.eventId,
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
      if (state.ws !== ws) return
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
        if (!advanceEventCursor(state, event.eventId)) continue
        const payload: RemoteEventPayload = { profileId: state.profile.id, projectId: event.projectId, eventId: event.eventId, eventType: event.type, aggregateType: event.aggregateType, aggregateId: event.aggregateId, aggregateVersion: event.aggregateVersion, occurredAt: event.occurredAt }
        for (const callback of state.eventCallbacks) {
          try { callback(payload) } catch { /* best-effort */ }
        }
      }
    }).catch(() => undefined)
  }, 2_000)
}

function scheduleReconnect(state: RemoteClientState): void {
  if (state.closing || state.reconnectTimer || state.ws) return
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    if (state.closing) return
    void establishConnection(state).catch(() => {
      scheduleReconnect(state)
    })
  }, 5_000)
}

function advanceEventCursor(state: RemoteClientState, eventId: string): boolean {
  if (!/^\d+$/.test(eventId)) return false
  if (state.lastEventId !== null && BigInt(eventId) <= BigInt(state.lastEventId)) return false
  state.lastEventId = eventId
  return true
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

async function httpGet<T>(profile: RemoteProfileWithCredentials, path: string): Promise<T> {
  const url = `${profile.serverUrl}${path}`
  const response = await authorizedFetch(profile, url, {
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

async function httpPost<T>(profile: RemoteProfileWithCredentials, path: string, body: unknown): Promise<T> {
  const url = `${profile.serverUrl}${path}`
  const response = await authorizedFetch(profile, url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${profile.apiKey}`,
      "X-Device-Id": profile.deviceId,
      "X-Request-Id": randomUUID(),
      "Idempotency-Key": randomUUID(),
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

async function httpPostBytes<T>(profile: RemoteProfileWithCredentials, path: string, bytes: Buffer, headers: Record<string, string> = {}): Promise<T> {
  const url = `${profile.serverUrl}${path}`
  const response = await authorizedFetch(profile, url, { method: "POST", headers: { "Authorization": `Bearer ${profile.apiKey}`, "X-Device-Id": profile.deviceId, "X-Request-Id": randomUUID(), "Idempotency-Key": randomUUID(), "Accept": "application/json", ...headers }, body: new Uint8Array(bytes) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`)
  return await response.json() as T
}

export async function getRemoteProjectSnapshot(profile: RemoteProfileWithCredentials, projectId: string): Promise<RemoteProjectSnapshot> {
  return cachedTeamRead(profile, projectId, "projectSnapshot", async () => {
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
  })
}

export async function getRemotePlanningRooms(profile: RemoteProfileWithCredentials, projectId: string): Promise<Array<{ id: string; name: string; archivedAt: string | null }>> {
  return cachedTeamRead(profile, projectId, "rooms", () => httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/rooms`))
}

export async function getRemoteMessages(profile: RemoteProfileWithCredentials, projectId: string, roomId: string): Promise<RemoteMessage[]> {
  return httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/rooms/${encodeURIComponent(roomId)}/messages`)
}

export async function sendRemoteMessage(profile: RemoteProfileWithCredentials, projectId: string, roomId: string, body: string): Promise<RemoteMessage> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/rooms/${encodeURIComponent(roomId)}/messages`, { body })
}

export async function getRemoteProposals(profile: RemoteProfileWithCredentials, projectId: string): Promise<RemoteProposal[]> {
  return httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/proposals`)
}

export async function approveRemoteProposal(
  profile: RemoteProfileWithCredentials,
  projectId: string,
  proposalId: string,
  decision: "approve" | "reject",
  reason?: string
): Promise<RemoteApproval> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/approve`, { decision, reason })
}

export async function getRemoteMembers(profile: RemoteProfileWithCredentials, projectId: string): Promise<RemoteMember[]> {
  return httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/members`)
}

export async function getRemoteTasks(profile: RemoteProfileWithCredentials, projectId: string): Promise<RemoteTask[]> {
  return cachedTeamRead(profile, projectId, "tasks", () => httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`))
}

export async function createRemoteTask(profile: RemoteProfileWithCredentials, projectId: string, input: { taskId: string; title: string; description: string; baselineId: string; requirementIds: string[]; dependencyIds: string[]; parallel: boolean; locks: string[]; ownershipScopes: string[]; acceptanceChecks: string[]; reviewers: string[] }): Promise<RemoteTask> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, input)
}

export async function claimRemoteTask(profile: RemoteProfileWithCredentials, projectId: string, taskId: string, branchName: string, baseCommit: string): Promise<unknown> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/claim`, { branchName, baseCommit, leaseDurationSeconds: 3600 })
}

export async function getRemoteMergeStatus(profile: RemoteProfileWithCredentials, projectId: string): Promise<RemoteMergeStatus> {
  const state = connections.get(connectionKey(profile.id))
  return {
    aheadCount: 0,
    behindCount: 0,
    hasConflicts: false,
    lastSyncedEventId: state?.lastEventId ?? null
  }
}

export async function getRemoteCoordination(profile: RemoteProfileWithCredentials, projectId: string): Promise<RemoteCoordinationSnapshot> {
  return cachedTeamRead(profile, projectId, "coordination", () => httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/coordination`))
}

export async function createRemoteBaseline(profile: RemoteProfileWithCredentials, projectId: string, input: Omit<RemoteConsensusBaseline, "id" | "projectId" | "revision" | "status" | "createdByUserId" | "createdAt" | "frozenAt">): Promise<RemoteConsensusBaseline> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/baselines`, input)
}

export async function decideRemoteBaseline(profile: RemoteProfileWithCredentials, projectId: string, baselineId: string, decision: "approve" | "reject", reason?: string): Promise<unknown> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/baselines/${encodeURIComponent(baselineId)}/decision`, { decision, reason })
}

export async function freezeRemoteBaseline(profile: RemoteProfileWithCredentials, projectId: string, baselineId: string): Promise<RemoteConsensusBaseline> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/baselines/${encodeURIComponent(baselineId)}/freeze`, {})
}

export async function uploadRemoteAttachment(profile: RemoteProfileWithCredentials, projectId: string, filePath: string): Promise<RemoteAttachment> {
  const bytes = await readFile(filePath)
  return httpPostBytes(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/attachments`, bytes, { "Content-Type": "application/octet-stream", "X-PlanWeave-File-Name": encodeURIComponent(basename(filePath)) })
}

export async function getRemoteAttachments(profile: RemoteProfileWithCredentials, projectId: string): Promise<RemoteAttachment[]> {
  return httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/attachments`)
}

export async function getRemoteAttachmentBytes(profile: RemoteProfileWithCredentials, projectId: string, attachmentId: string): Promise<Uint8Array> {
  const url = `${profile.serverUrl}/api/v1/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`
  const response = await authorizedFetch(profile, url, { method: "GET", headers: { "Authorization": `Bearer ${profile.apiKey}`, "X-Device-Id": profile.deviceId, "X-Request-Id": randomUUID() } })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`)
  return new Uint8Array(await response.arrayBuffer())
}

export async function registerRemoteAgent(profile: RemoteProfileWithCredentials, projectId: string, input: { kind: string; name: string; version: string | null; capabilities: string[] }): Promise<unknown> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/agent-profile`, input)
}

export async function preferRemoteTask(profile: RemoteProfileWithCredentials, projectId: string, taskId: string, note: string): Promise<unknown> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/preference`, { note })
}

export async function getRemoteAssignments(profile: RemoteProfileWithCredentials, projectId: string): Promise<RemoteAssignment[]> {
  return cachedTeamRead(profile, projectId, "assignments", () => httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/assignments?mine=1`))
}

export async function heartbeatRemoteAssignment(profile: RemoteProfileWithCredentials, projectId: string, assignmentId: string, expectedVersion: number): Promise<unknown> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/assignments/${encodeURIComponent(assignmentId)}/heartbeat`, { expectedVersion, leaseDurationSeconds: 3600 })
}

export async function submitRemoteAssignmentEvidence(profile: RemoteProfileWithCredentials, projectId: string, assignmentId: string, input: { expectedVersion: number; headCommit: string; baseCommit: string; localChecks: Array<{ name: string; passed: boolean; output?: string }>; agentReport: string }): Promise<{ submission: { id: string } }> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/assignments/${encodeURIComponent(assignmentId)}/submit`, input)
}

export async function uploadRemoteSubmissionBundle(profile: RemoteProfileWithCredentials, projectId: string, submissionId: string, bundlePath: string): Promise<unknown> {
  return httpPostBytes(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/submissions/${encodeURIComponent(submissionId)}/bundle`, await readFile(bundlePath), { "Content-Type": "application/x-git-bundle" })
}

export async function getRemoteMergeQueue(profile: RemoteProfileWithCredentials, projectId: string): Promise<RemoteMergeQueue> {
  return cachedTeamRead(profile, projectId, "mergeQueue", () => httpGet(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/merge-queue`))
}

export async function postRemoteAgentReview(profile: RemoteProfileWithCredentials, projectId: string, entryId: string, verdict: "approve" | "reject", report: string): Promise<unknown> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/merge-queue/${encodeURIComponent(entryId)}/agent-review`, { verdict, report })
}

export async function decideRemoteMerge(profile: RemoteProfileWithCredentials, projectId: string, entryId: string, decision: "approve" | "reject"): Promise<unknown> {
  return httpPost(profile, `/api/v1/projects/${encodeURIComponent(projectId)}/merge-queue/${encodeURIComponent(entryId)}/review`, { decision })
}
