import {
  appendRunSessionEvent,
  createRunSession,
  getRunSession,
  listRunSessions,
  updateRunSession,
  RunSessionStateVersionConflictError,
  withRunSessionScopeLock
} from "../runSessions/repository.js";
import type { RunSessionState, RunSessionTrigger } from "../runSessions/types.js";
import { z } from "zod";
import type { WorkspaceExecutionScope, WorkspaceExecutionSessionState } from "./contracts.js";
import {
  workspaceExecutionScopeSchema,
  workspaceExecutionSessionStateSchema
} from "./contracts.js";
import type { ValidatedWorkspaceAuthorityBinding } from "./authorityBinding.js";
import { WorkspaceExecutionError } from "./errors.js";
import type { PackageWorkspaceRef } from "../types.js";

export type WorkspaceExecutionSessionStorage =
  | { kind: "package"; packageWorkspace: PackageWorkspaceRef }
  | { kind: "namespace"; namespace: string };

export type WorkspaceExecutionSessionRecord = Omit<RunSessionState, "projectRoot">;

const workspaceExecutionSessionRecordSchema = z
  .object({
    stateVersion: z.number().int().positive(),
    sessionId: z.string().regex(/^SESSION-\d{4,}$/),
    kind: z.literal("run"),
    trigger: z.enum(["manual", "desktop", "api"]),
    canvasId: z.string().trim().min(1).max(256),
    scope: workspaceExecutionScopeSchema,
    phase: z.enum(["created", "running", "blocked", "completed", "failed", "stopped"]),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    reset: z.null(),
    autoRun: z.null(),
    latestRecordId: z.null(),
    latestRecordPath: z.null(),
    workspaceExecution: workspaceExecutionSessionStateSchema,
    error: z.string().nullable()
  })
  .strict();

export function parseWorkspaceExecutionSessionRecord(
  value: unknown
): WorkspaceExecutionSessionRecord {
  return workspaceExecutionSessionRecordSchema.parse(value);
}

export type WorkspaceExecutionSessionCreateInput = {
  kind: "run";
  trigger: RunSessionTrigger;
  scope: WorkspaceExecutionScope;
  phase: RunSessionState["phase"];
  workspaceExecution: WorkspaceExecutionSessionState;
};

export interface WorkspaceExecutionSessionRepositoryPort {
  create(
    storage: WorkspaceExecutionSessionStorage,
    input: WorkspaceExecutionSessionCreateInput
  ): Promise<WorkspaceExecutionSessionRecord>;
  get(
    storage: WorkspaceExecutionSessionStorage,
    sessionId: string
  ): Promise<{ session: WorkspaceExecutionSessionRecord }>;
  list(storage: WorkspaceExecutionSessionStorage): Promise<{
    sessions: WorkspaceExecutionSessionRecord[];
    diagnostics: unknown[];
  }>;
  update(
    storage: WorkspaceExecutionSessionStorage,
    sessionId: string,
    patch: Partial<WorkspaceExecutionSessionRecord>,
    options: { expectedStateVersion: number }
  ): Promise<WorkspaceExecutionSessionRecord>;
  appendEvent(
    storage: WorkspaceExecutionSessionStorage,
    sessionId: string,
    type: string,
    data: Record<string, unknown>
  ): Promise<unknown>;
  withScopeLock<T>(
    storage: WorkspaceExecutionSessionStorage,
    scope: WorkspaceExecutionScope,
    operation: () => Promise<T>
  ): Promise<T>;
}

export class WorkspaceExecutionSessionVersionConflictError extends Error {}

function packageWorkspace(storage: WorkspaceExecutionSessionStorage): PackageWorkspaceRef {
  if (storage.kind !== "package") {
    throw new WorkspaceExecutionError("workspace_execution_session_storage_unavailable");
  }
  return storage.packageWorkspace;
}

function record(session: RunSessionState): WorkspaceExecutionSessionRecord {
  const { projectRoot: _projectRoot, ...value } = session;
  return value;
}

export function createPackageWorkspaceExecutionSessionRepository(): WorkspaceExecutionSessionRepositoryPort {
  return {
    async create(storage, input) {
      return record(await createRunSession({ projectRoot: packageWorkspace(storage), ...input }));
    },
    async get(storage, sessionId) {
      const detail = await getRunSession(packageWorkspace(storage), sessionId);
      return { session: record(detail.session) };
    },
    async list(storage) {
      const listed = await listRunSessions(packageWorkspace(storage));
      return { ...listed, sessions: listed.sessions.map(record) };
    },
    async update(storage, sessionId, patch, options) {
      try {
        return record(await updateRunSession(packageWorkspace(storage), sessionId, patch, options));
      } catch (error) {
        if (error instanceof RunSessionStateVersionConflictError) {
          throw new WorkspaceExecutionSessionVersionConflictError(error.message, {
            cause: error
          });
        }
        throw error;
      }
    },
    appendEvent(storage, sessionId, type, data) {
      return appendRunSessionEvent(packageWorkspace(storage), sessionId, type, data);
    },
    withScopeLock(storage, scope, operation) {
      return withRunSessionScopeLock(packageWorkspace(storage), scope, operation);
    }
  };
}

export function packageSessionStorageForBinding(
  binding: ValidatedWorkspaceAuthorityBinding
): WorkspaceExecutionSessionStorage {
  if (binding.kind === "local") {
    return { kind: "package", packageWorkspace: binding.packageWorkspace };
  }
  if (binding.contentAuthority.kind === "package_snapshot") {
    return {
      kind: "package",
      packageWorkspace: binding.contentAuthority.packageWorkspace
    };
  }
  throw new WorkspaceExecutionError("workspace_execution_session_storage_unavailable");
}
