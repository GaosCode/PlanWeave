import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { activeAgentRunRegistry } from "./activeAgentRunRegistry.js";
import { acpEventReadModels } from "./acpEventReadModel.js";
import type { AcpEventSubscriber, AcpEventSubscription } from "./acpEventPublisher.js";
import { projectAcpConversation, type AcpConversationItem } from "./acpConversationProjection.js";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";
import {
  replayNormalizedRunnerEvents,
  type RunnerEventCursor,
  type RunnerEventReplayDiagnostic
} from "./runnerEventReplay.js";
import {
  acpSessionIdSchema,
  blockIdSchema,
  canvasIdSchema,
  claimRefSchema,
  desktopRunIdSchema,
  executorRunIdSchema,
  projectIdSchema,
  runnerRunIdSchema,
  runSessionIdSchema,
  taskIdSchema
} from "./runnerContractSchemas.js";

export type RunnerRecordReadModel = {
  events: NormalizedRunnerEvent[];
  conversation: AcpConversationItem[];
  diagnostics: RunnerEventReplayDiagnostic[];
  cursor: RunnerEventCursor;
  terminal: boolean;
  interaction: {
    persisted: boolean;
    active: boolean;
    stale: boolean;
  };
};

export type RunnerRecordReadConsumer = {
  snapshot: RunnerRecordReadModel | null;
  subscription: AcpEventSubscription | null;
};

function diagnostic(code: RunnerEventReplayDiagnostic["code"], message: string): RunnerEventReplayDiagnostic {
  return { code, line: null, message };
}

export async function readRunnerRecordReadModel(options: {
  runDir: string;
  metadata: Record<string, unknown>;
}): Promise<RunnerRecordReadModel | null> {
  return (await consumeRunnerRecordReadModel(options)).snapshot;
}

const runnerRecordMetadataSchema = z
  .object({
    runId: runnerRunIdSchema,
    claimRef: claimRefSchema.optional(),
    ref: claimRefSchema.optional(),
    projectId: projectIdSchema.optional(),
    canvasId: canvasIdSchema.optional(),
    taskId: taskIdSchema.optional(),
    blockId: blockIdSchema.optional(),
    runSessionId: runSessionIdSchema.nullable().optional(),
    desktopRunId: desktopRunIdSchema.nullable().optional(),
    executorRunId: executorRunIdSchema.nullable().optional(),
    sessionId: acpSessionIdSchema.nullable().optional()
  })
  .passthrough();

type SelectedRecordIdentity = z.infer<typeof runnerRecordMetadataSchema> & {
  claimRef: z.infer<typeof claimRefSchema>;
  taskId: z.infer<typeof taskIdSchema>;
  blockId: z.infer<typeof blockIdSchema>;
};

function selectedRecordIdentity(metadata: Record<string, unknown>): SelectedRecordIdentity {
  const parsed = runnerRecordMetadataSchema.parse(metadata);
  if (parsed.claimRef && parsed.ref && parsed.claimRef !== parsed.ref) {
    throw new Error("ACP run metadata claimRef and ref must match.");
  }
  const claimRef = parsed.claimRef ?? parsed.ref;
  if (!claimRef) throw new Error("ACP run metadata requires a canonical claimRef/ref.");
  const [rawTaskId, rawBlockId] = claimRef.split("#");
  const taskId = taskIdSchema.parse(rawTaskId);
  const blockId = blockIdSchema.parse(rawBlockId);
  if (
    (parsed.taskId !== undefined && parsed.taskId !== taskId) ||
    (parsed.blockId !== undefined && parsed.blockId !== blockId) ||
    (parsed.executorRunId !== undefined &&
      parsed.executorRunId !== null &&
      String(parsed.executorRunId) !== String(parsed.runId))
  ) {
    throw new Error("ACP run metadata identity fields are inconsistent.");
  }
  return { ...parsed, claimRef, taskId, blockId };
}

function identityMismatch(
  events: readonly NormalizedRunnerEvent[],
  selected: SelectedRecordIdentity,
  cursor: RunnerEventCursor
): RunnerEventReplayDiagnostic | null {
  const canonical = cursor.canonicalIdentity?.identity;
  if (
    canonical &&
    (canonical.runId !== selected.runId ||
      canonical.claimRef !== selected.claimRef ||
      canonical.taskId !== selected.taskId ||
      canonical.blockId !== selected.blockId ||
      (selected.projectId !== undefined && canonical.projectId !== selected.projectId) ||
      (selected.canvasId !== undefined && canonical.canvasId !== selected.canvasId) ||
      (selected.runSessionId !== undefined && canonical.runSessionId !== selected.runSessionId) ||
      (selected.desktopRunId !== undefined && canonical.desktopRunId !== selected.desktopRunId) ||
      (selected.executorRunId !== undefined && canonical.executorRunId !== selected.executorRunId))
  ) {
    return diagnostic(
      "identity_mismatch",
      `Runner event identity does not match selected record '${selected.claimRef}'/'${selected.runId}'.`
    );
  }
  const mismatch = events.find((event) =>
    event.identity.runId !== selected.runId ||
    event.identity.claimRef !== selected.claimRef ||
    event.identity.taskId !== selected.taskId ||
    event.identity.blockId !== selected.blockId ||
    (selected.projectId !== undefined && event.identity.projectId !== selected.projectId) ||
    (selected.canvasId !== undefined && event.identity.canvasId !== selected.canvasId) ||
    (selected.runSessionId !== undefined && event.identity.runSessionId !== selected.runSessionId) ||
    (selected.desktopRunId !== undefined && event.identity.desktopRunId !== selected.desktopRunId) ||
    (selected.executorRunId !== undefined && event.identity.executorRunId !== selected.executorRunId) ||
    (selected.sessionId !== undefined &&
      event.correlation !== undefined &&
      event.correlation.sessionId !== selected.sessionId)
  );
  return mismatch
    ? diagnostic(
        "identity_mismatch",
        `Runner event identity does not match selected record '${selected.claimRef}'/'${selected.runId}'.`
      )
    : null;
}

function failedIdentitySnapshot(options: {
  diagnostics?: readonly RunnerEventReplayDiagnostic[];
  cursor?: RunnerEventCursor;
  terminal?: boolean;
  message: string;
}): RunnerRecordReadConsumer {
  return {
    snapshot: {
      events: [],
      conversation: [],
      diagnostics: [
        ...(options.diagnostics ?? []),
        diagnostic("identity_mismatch", options.message)
      ],
      cursor: options.cursor ?? {
        version: "planweave.runner-event-cursor/v1",
        runId: "invalid",
        afterSequence: 0,
        canonicalIdentity: null,
        terminal: false
      },
      terminal: options.terminal ?? false,
      interaction: { persisted: false, active: false, stale: false }
    },
    subscription: null
  };
}

function activeInteraction(
  runDir: string,
  selected: SelectedRecordIdentity,
  cursor: RunnerEventCursor,
  events: readonly NormalizedRunnerEvent[]
): boolean {
  const canonical = cursor.canonicalIdentity?.identity;
  if (!canonical?.executorRunId) return false;
  const sessionIds = new Set(
    events.flatMap((event) => event.correlation?.sessionId ? [event.correlation.sessionId] : [])
  );
  const sessionId = selected.sessionId ?? (sessionIds.size === 1 ? [...sessionIds][0] : undefined);
  if (!sessionId) return false;
  try {
    const registered = activeAgentRunRegistry.lookupExact({
      scope: runDir,
      executorRunId: canonical.executorRunId,
      claimRef: canonical.claimRef,
      ...(canonical.desktopRunId ? { desktopRunId: canonical.desktopRunId } : {}),
      ...(canonical.runSessionId ? { runSessionId: canonical.runSessionId } : {}),
      sessionId
    });
    if (!registered) return false;
    if (
      (registered.identity.runSessionId ?? null) !== canonical.runSessionId ||
      (registered.identity.desktopRunId ?? null) !== canonical.desktopRunId
    ) {
      return false;
    }
    const persistedRequestIds = new Set<string>(
      events.flatMap((event) => event.body.kind === "interaction"
        ? [event.body.interaction.requestId]
        : [])
    );
    return [...registered.control.pendingRequests.keys()].some((requestId) =>
      persistedRequestIds.has(requestId)
    );
  } catch {
    return false;
  }
}

export async function consumeRunnerRecordReadModel(options: {
  runDir: string;
  metadata: Record<string, unknown>;
  cursor?: RunnerEventCursor;
  subscriber?: AcpEventSubscriber;
}): Promise<RunnerRecordReadConsumer> {
  if (options.metadata.runnerKind !== "acp") {
    return { snapshot: null, subscription: null };
  }
  let selected: SelectedRecordIdentity;
  try {
    selected = selectedRecordIdentity(options.metadata);
  } catch {
    return failedIdentitySnapshot({
      message: "ACP run metadata identity is invalid or internally inconsistent."
    });
  }

  const activeModel = acpEventReadModels.get(options.runDir);
  if (activeModel) {
    let replay: ReturnType<typeof activeModel.replay>;
    try {
      replay = activeModel.replay(options.cursor ?? 0);
    } catch {
      return failedIdentitySnapshot({
        cursor: typeof options.cursor === "object" ? options.cursor : undefined,
        message: "Runner event cursor identity does not match the active record."
      });
    }
    const mismatch = identityMismatch(replay.events, selected, replay.cursor);
    if (mismatch || replay.diagnostics.some((item) => item.code === "identity_mismatch")) {
      return failedIdentitySnapshot({
        diagnostics: replay.diagnostics,
        cursor: replay.cursor,
        terminal: replay.terminal,
        message: mismatch?.message ?? "Runner event stream contains inconsistent identities."
      });
    }
    const persisted = replay.events.some((event) => event.body.kind === "interaction");
    const active = activeInteraction(options.runDir, selected, replay.cursor, replay.events);
    return {
      snapshot: {
        ...replay,
        interaction: { persisted, active, stale: persisted && !active }
      },
      subscription:
        options.subscriber && !replay.terminal
          ? activeModel.subscribe(replay.cursor.afterSequence, options.subscriber)
          : null
    };
  }

  let content = "";
  const boundaryDiagnostics: RunnerEventReplayDiagnostic[] = [];
  try {
    content = await readFile(join(options.runDir, "events.ndjson"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      boundaryDiagnostics.push(diagnostic("missing_log", "Normalized ACP event log does not exist."));
    } else {
      throw error;
    }
  }
  const replay = replayNormalizedRunnerEvents({
    content,
    runId: selected.runId,
    ...(options.cursor ? { cursor: options.cursor } : {})
  });
  const mismatch = identityMismatch(replay.events, selected, replay.nextCursor);
  if (mismatch || replay.diagnostics.some((item) => item.code === "identity_mismatch")) {
    return failedIdentitySnapshot({
      diagnostics: [...boundaryDiagnostics, ...replay.diagnostics],
      cursor: replay.nextCursor,
      terminal: replay.terminal,
      message: mismatch?.message ?? "Runner event stream contains inconsistent identities."
    });
  }
  const persisted = replay.events.some((event) => event.body.kind === "interaction");
  const active = activeInteraction(options.runDir, selected, replay.nextCursor, replay.events);
  return {
    snapshot: {
      events: replay.events,
      conversation: projectAcpConversation(replay.events),
      diagnostics: [...boundaryDiagnostics, ...replay.diagnostics],
      cursor: replay.nextCursor,
      terminal: replay.terminal,
      interaction: { persisted, active, stale: persisted && !active }
    },
    subscription: null
  };
}

export async function readRunnerRecordReadModelForArtifact(
  artifactPath: string | null
): Promise<RunnerRecordReadModel | null> {
  if (!artifactPath) return null;
  const runDir = dirname(artifactPath);
  const metadata = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8")) as unknown;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error(`Runner metadata at '${join(runDir, "metadata.json")}' must be an object.`);
  }
  return readRunnerRecordReadModel({ runDir, metadata: metadata as Record<string, unknown> });
}
