import { appendFile, chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseWorkspaceExecutionSessionRecord,
  WorkspaceExecutionSessionVersionConflictError,
  type WorkspaceExecutionSessionCreateInput,
  type WorkspaceExecutionSessionRecord,
  type WorkspaceExecutionSessionRepositoryPort,
  type WorkspaceExecutionSessionStorage
} from "@planweave-ai/runtime";

function namespaceDirectory(root: string, storage: WorkspaceExecutionSessionStorage): string {
  if (storage.kind !== "namespace" || !/^wxs:sha256:[a-f0-9]{64}$/.test(storage.namespace)) {
    throw new Error("workspace_execution_desktop_namespace_required");
  }
  return join(root, storage.namespace.slice("wxs:sha256:".length));
}

function sessionFile(root: string, storage: WorkspaceExecutionSessionStorage, sessionId: string) {
  if (!/^SESSION-\d{4,}$/.test(sessionId))
    throw new Error("workspace_execution_session_id_invalid");
  return join(namespaceDirectory(root, storage), `${sessionId}.json`);
}

async function readSession(
  root: string,
  storage: WorkspaceExecutionSessionStorage,
  sessionId: string
): Promise<WorkspaceExecutionSessionRecord> {
  return parseWorkspaceExecutionSessionRecord(
    JSON.parse(await readFile(sessionFile(root, storage, sessionId), "utf8"))
  );
}

async function writeSession(
  root: string,
  storage: WorkspaceExecutionSessionStorage,
  session: WorkspaceExecutionSessionRecord
): Promise<void> {
  const directory = namespaceDirectory(root, storage);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = sessionFile(root, storage, session.sessionId);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, target);
}

export class DesktopWorkspaceExecutionSessionRepository
  implements WorkspaceExecutionSessionRepositoryPort
{
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async create(
    storage: WorkspaceExecutionSessionStorage,
    input: WorkspaceExecutionSessionCreateInput
  ): Promise<WorkspaceExecutionSessionRecord> {
    return this.withQueue(`${namespaceDirectory(this.root, storage)}\u0000allocation`, async () => {
      const sessions = (await this.list(storage)).sessions;
      const sequence =
        sessions.reduce((max, session) => {
          const value = Number(session.sessionId.slice("SESSION-".length));
          return Number.isSafeInteger(value) ? Math.max(max, value) : max;
        }, 0) + 1;
      const now = this.clock().toISOString();
      const session = parseWorkspaceExecutionSessionRecord({
        stateVersion: 1,
        sessionId: `SESSION-${String(sequence).padStart(4, "0")}`,
        kind: "run",
        trigger: input.trigger,
        canvasId: input.workspaceExecution.binding.canvasId,
        scope: input.scope,
        phase: input.phase,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        reset: null,
        autoRun: null,
        latestRecordId: null,
        latestRecordPath: null,
        workspaceExecution: input.workspaceExecution,
        error: null
      });
      await writeSession(this.root, storage, session);
      return session;
    });
  }

  async get(storage: WorkspaceExecutionSessionStorage, sessionId: string) {
    return { session: await readSession(this.root, storage, sessionId) };
  }

  async list(storage: WorkspaceExecutionSessionStorage) {
    const directory = namespaceDirectory(this.root, storage);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: [], diagnostics: [] };
      }
      throw error;
    }
    const sessions = await Promise.all(
      names
        .filter((name) => /^SESSION-\d{4,}\.json$/.test(name))
        .map((name) => readSession(this.root, storage, name.slice(0, -5)))
    );
    return {
      sessions: sessions.sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
      diagnostics: []
    };
  }

  async update(
    storage: WorkspaceExecutionSessionStorage,
    sessionId: string,
    patch: Partial<WorkspaceExecutionSessionRecord>,
    options: { expectedStateVersion: number }
  ): Promise<WorkspaceExecutionSessionRecord> {
    return this.withQueue(`${sessionFile(this.root, storage, sessionId)}\u0000update`, async () => {
      const current = await readSession(this.root, storage, sessionId);
      if (current.stateVersion !== options.expectedStateVersion) {
        throw new WorkspaceExecutionSessionVersionConflictError(
          "workspace_execution_session_version_conflict"
        );
      }
      const next = parseWorkspaceExecutionSessionRecord({
        ...current,
        ...patch,
        sessionId: current.sessionId,
        stateVersion: current.stateVersion + 1,
        updatedAt: this.clock().toISOString()
      });
      await writeSession(this.root, storage, next);
      return next;
    });
  }

  async appendEvent(
    storage: WorkspaceExecutionSessionStorage,
    sessionId: string,
    type: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const directory = namespaceDirectory(this.root, storage);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await appendFile(
      join(directory, `${sessionId}.events.jsonl`),
      `${JSON.stringify({ type, ...data })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  async withScopeLock<T>(
    storage: WorkspaceExecutionSessionStorage,
    scope: WorkspaceExecutionSessionCreateInput["scope"],
    operation: () => Promise<T>
  ): Promise<T> {
    const key = `${namespaceDirectory(this.root, storage)}\u0000${JSON.stringify(scope)}`;
    return this.withQueue(key, operation);
  }

  private async withQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }
}
