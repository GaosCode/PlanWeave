import type { RemoteProfile } from "./remoteProfile.js";
import {
  generateIdempotencyKey,
  loadCredentials,
  updateProfileAssignment,
  updateProfileSession
} from "./remoteProfile.js";

export type RemoteClientOptions = {
  serverUrl: string;
  profileName: string;
  sessionToken: string | null;
  deviceSecret: string;
  deviceId: string;
  userId: string;
  projectId: string;
};

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};

export class RemoteApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly requestId: string,
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "RemoteApiError";
  }
}

function isApiError(body: unknown): body is ApiErrorResponse {
  if (typeof body !== "object" || body === null) return false;
  const err = (body as ApiErrorResponse).error;
  return typeof err?.code === "string" && typeof err?.message === "string";
}

async function request<T>(options: RemoteClientOptions, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${options.serverUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": generateIdempotencyKey()
  };
  if (options.sessionToken) {
    headers["authorization"] = `Bearer ${options.sessionToken}`;
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(30_000)
  };
  if (body !== undefined && method !== "GET") {
    fetchOptions.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RemoteApiError(`Failed to reach server at ${options.serverUrl}: ${message}`, "network_error", "", true);
  }

  const responseBody = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    if (isApiError(responseBody)) {
      throw new RemoteApiError(
        responseBody.error.message,
        responseBody.error.code,
        responseBody.error.requestId,
        responseBody.error.retryable,
        responseBody.error.details
      );
    }
    throw new RemoteApiError(
      `Server returned ${response.status}`,
      "internal_error",
      "",
      response.status >= 500
    );
  }

  return responseBody as T;
}

export function createRemoteClient(options: RemoteClientOptions) {
  return {
    get options() { return options; },

    async createSession(): Promise<{ sessionId: string; issuedAt: string; expiresAt: string }> {
      const key = generateIdempotencyKey();
      const result = await request<{ session: { id: string; issuedAt: string; expiresAt: string } }>(
        options, "POST", "/api/v1/sessions",
        {
          idempotencyKey: key,
          deviceId: options.deviceId,
          userId: options.userId,
          deviceRefId: options.deviceId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        }
      );
      const session = {
        sessionId: result.session.id,
        issuedAt: result.session.issuedAt,
        expiresAt: result.session.expiresAt
      };
      await updateProfileSession(options.profileName, {
        sessionId: session.sessionId,
        sessionExpiresAt: session.expiresAt
      });
      return session;
    },

    async claimTask(params: {
      taskId: string;
      branchName: string;
      baseCommit: string;
      leaseDurationSeconds: number;
      currentAssignmentId: string | null;
      currentAssignmentVersion: number | null;
    }): Promise<{
      assignment: { id: string; version: number; branchName: string; baseCommit: string; leaseExpiresAt: string; status: string };
      task: { id: string; taskId: string; title: string; version: number; status: string };
      replayed: boolean;
    }> {
      const key = generateIdempotencyKey();
      const payload: Record<string, unknown> = {
        idempotencyKey: key,
        deviceId: options.deviceId,
        actorId: options.userId,
        taskId: params.taskId,
        branchName: params.branchName,
        baseCommit: params.baseCommit,
        leaseDurationSeconds: params.leaseDurationSeconds,
        commandType: "claim_task"
      };
      if (params.currentAssignmentVersion !== null) {
        payload.expectedVersion = params.currentAssignmentVersion;
      }
      const result = await request<{
        replayed: boolean;
        assignment: { id: string; version: number; branchName: string; baseCommit: string; leaseExpiresAt: string; status: string };
        task: { id: string; taskId: string; title: string; version: number; status: string };
      }>(options, "POST", `/api/v1/projects/${options.projectId}/tasks/${encodeURIComponent(params.taskId)}/claim`, payload);

      await updateProfileAssignment(options.profileName, {
        assignmentId: result.assignment.id,
        assignmentVersion: result.assignment.version,
        taskId: params.taskId
      });

      return result;
    },

    async heartbeat(params: {
      assignmentId: string;
      assignmentVersion: number;
      leaseDurationSeconds: number;
    }): Promise<{
      assignment: { id: string; version: number; status: string; leaseExpiresAt: string };
      newLeaseExpiresAt: string;
      replayed: boolean;
    }> {
      const key = generateIdempotencyKey();
      const result = await request<{
        replayed: boolean;
        assignment: { id: string; version: number; status: string; leaseExpiresAt: string };
        newLeaseExpiresAt: string;
      }>(options, "POST", `/api/v1/projects/${options.projectId}/assignments/${encodeURIComponent(params.assignmentId)}/heartbeat`, {
        idempotencyKey: key,
        deviceId: options.deviceId,
        actorId: options.userId,
        aggregateId: params.assignmentId,
        expectedVersion: params.assignmentVersion,
        leaseDurationSeconds: params.leaseDurationSeconds,
        commandType: "heartbeat"
      });

      await updateProfileAssignment(options.profileName, {
        assignmentId: result.assignment.id,
        assignmentVersion: result.assignment.version,
        taskId: options.profileName // placeholder, actual taskId stays
      });

      return result;
    },

    async submit(params: {
      assignmentId: string;
      assignmentVersion: number;
      headCommit: string;
      baseCommit: string;
    }): Promise<{
      submission: { id: string; version: number; headCommit: string; status: string };
      assignment: { id: string; version: number; status: string };
      replayed: boolean;
    }> {
      const key = generateIdempotencyKey();
      return request(options, "POST", `/api/v1/projects/${options.projectId}/assignments/${encodeURIComponent(params.assignmentId)}/submit`, {
        idempotencyKey: key,
        deviceId: options.deviceId,
        actorId: options.userId,
        aggregateId: params.assignmentId,
        expectedVersion: params.assignmentVersion,
        headCommit: params.headCommit,
        baseCommit: params.baseCommit,
        commandType: "submit"
      });
    },

    async revokeDevice(): Promise<{ deviceId: string; status: string }> {
      const key = generateIdempotencyKey();
      return request(options, "POST", `/api/v1/devices/${encodeURIComponent(options.deviceId)}/revoke`, {
        idempotencyKey: key,
        deviceId: options.deviceId,
        actorUserId: options.userId,
        id: options.deviceId
      });
    },

    async getEvents(params: {
      afterEventId?: string;
      limit?: number;
    }): Promise<{ items: unknown[]; nextCursor: string | null }> {
      const query = new URLSearchParams();
      if (params.afterEventId !== undefined) query.set("afterEventId", params.afterEventId);
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      else query.set("limit", "50");
      return request(options, "GET", `/api/v1/projects/${options.projectId}/events?${query.toString()}`);
    },

    async getSnapshot(): Promise<{ project: { id: string; version: number; name: string }; lastEventId: string }> {
      return request(options, "GET", `/api/v1/projects/${options.projectId}/snapshot`);
    },

    async getMergeQueueStatus(): Promise<{ submissions: Array<{ submissionId: string; taskId: string; status: string; headCommit: string; baseCommit: string; createdAt: string }> }> {
      return request(options, "GET", `/api/v1/projects/${options.projectId}/merge-queue`);
    }
  };
}

export type RemoteClient = ReturnType<typeof createRemoteClient>;

export async function connectRemoteClient(
  profile: RemoteProfile
): Promise<RemoteClient> {
  const creds = await loadCredentials(profile.name);
  const client = createRemoteClient({
    serverUrl: profile.serverUrl,
    profileName: profile.name,
    sessionToken: creds?.sessionToken ?? null,
    deviceSecret: creds?.deviceSecret ?? "",
    deviceId: profile.deviceId,
    userId: profile.userId,
    projectId: profile.projectId
  });

  if (!creds?.sessionToken) {
    const session = await client.createSession();
    await updateProfileSession(profile.name, {
      sessionId: session.sessionId,
      sessionExpiresAt: session.expiresAt
    });
    const recred = await loadCredentials(profile.name);
    return createRemoteClient({
      serverUrl: profile.serverUrl,
      profileName: profile.name,
      sessionToken: recred?.sessionToken ?? null,
      deviceSecret: recred?.deviceSecret ?? "",
      deviceId: profile.deviceId,
      userId: profile.userId,
      projectId: profile.projectId
    });
  }

  return client;
}
