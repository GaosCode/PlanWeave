import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { activeAgentRunRegistry } from "./activeAgentRunRegistry.js";
import { acpEventReadModels } from "./acpEventReadModel.js";
import type { AcpEventSubscription } from "./acpEventPublisher.js";
import type { AcpEventReadModel } from "./acpEventReadModel.js";
import { AcpProjectionAccumulator } from "./acpConversationProjection.js";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";
import { isLegacyUnsupportedSessionUpdateDiagnostic } from "./acpLegacyDiagnosticCompatibility.js";
import { projectPersistedRetentionDiagnostics } from "./acpEventRetentionPolicy.js";
import { redactRunnerEventText } from "./runnerEventRedaction.js";
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
  runnerRequestActionIdentitySchema,
  runnerRunIdSchema,
  runnerSessionActionIdentitySchema,
  runSessionIdSchema,
  taskIdSchema
} from "./runnerContractSchemas.js";
import { projectAcpActualSessionConfiguration } from "./acpSessionConfiguration.js";
import { subscribePersistedRunnerEvents } from "./persistedRunnerEventSubscription.js";
import {
  desktopAgentPromptIdentitySchema,
  runnerRecordReadModelSchema,
  type DesktopAgentPromptIdentity,
  type RunnerRecordReadModel
} from "./runnerRecordReadModelContract.js";

export {
  desktopAgentPromptIdentitySchema,
  runnerRecordReadModelSchema
} from "./runnerRecordReadModelContract.js";
export type {
  DesktopAgentPromptIdentity,
  RunnerRecordReadModel
} from "./runnerRecordReadModelContract.js";

export type RunnerRecordReadConsumer = {
  snapshot: RunnerRecordReadModel | null;
  subscription: AcpEventSubscription | null;
};

export type RunnerRecordReadSubscriber = (snapshot: RunnerRecordReadModel) => void | Promise<void>;

function diagnostic(
  code: RunnerEventReplayDiagnostic["code"],
  message: string
): RunnerEventReplayDiagnostic {
  return { code, line: null, message };
}

function mergeReplayDiagnostics(
  existing: readonly RunnerEventReplayDiagnostic[],
  incoming: readonly RunnerEventReplayDiagnostic[]
): RunnerEventReplayDiagnostic[] {
  const merged = new Map<string, RunnerEventReplayDiagnostic>();
  for (const item of [...existing, ...incoming]) {
    merged.set(`${item.code}\0${item.line ?? ""}\0${item.message}`, item);
  }
  return [...merged.values()];
}

function visibleEvents(events: readonly NormalizedRunnerEvent[]): NormalizedRunnerEvent[] {
  return events.filter((event) => !isLegacyUnsupportedSessionUpdateDiagnostic(event));
}

export async function readRunnerRecordReadModel(options: {
  runDir: string;
  metadata: Record<string, unknown>;
  promptIdentity?: DesktopAgentPromptIdentity;
  promptContinuationAvailable?: boolean;
  promptInFlight?: boolean;
  promptUnavailableReason?: string;
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
    sessionId: acpSessionIdSchema.nullable().optional(),
    status: z.enum(["running", "completed", "failed", "cancelled", "timed_out"]).optional()
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
  const mismatch = events.find(
    (event) =>
      event.identity.runId !== selected.runId ||
      event.identity.claimRef !== selected.claimRef ||
      event.identity.taskId !== selected.taskId ||
      event.identity.blockId !== selected.blockId ||
      (selected.projectId !== undefined && event.identity.projectId !== selected.projectId) ||
      (selected.canvasId !== undefined && event.identity.canvasId !== selected.canvasId) ||
      (selected.runSessionId !== undefined &&
        event.identity.runSessionId !== selected.runSessionId) ||
      (selected.desktopRunId !== undefined &&
        event.identity.desktopRunId !== selected.desktopRunId) ||
      (selected.executorRunId !== undefined &&
        event.identity.executorRunId !== selected.executorRunId) ||
      (selected.sessionId != null &&
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
      timeline: [],
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
      actualConfiguration: {
        available: false,
        reason:
          "Actual ACP session configuration is unavailable because runner identity validation failed."
      },
      intervention: {
        prompt: {
          available: false,
          reason: "Exact Desktop record identity is unavailable.",
          identity: null,
          inFlight: false
        },
        cancel: {
          available: false,
          reason: "Exact live Desktop ACP session identity is unavailable.",
          identity: null
        }
      },
      interaction: { persisted: false, active: false, stale: false, activeRequests: [] }
    },
    subscription: null
  };
}

function interactionState(
  runDir: string,
  selected: SelectedRecordIdentity,
  cursor: RunnerEventCursor,
  events: readonly NormalizedRunnerEvent[],
  knownSessionIds?: ReadonlySet<string>,
  promptIdentity?: DesktopAgentPromptIdentity,
  promptContinuationAvailable = false,
  promptInFlight = false,
  promptUnavailableReason?: string
): Pick<RunnerRecordReadModel, "interaction" | "intervention"> {
  const persistedRequestIds = new Set<string>(
    events.flatMap((event) =>
      event.body.kind === "interaction" ? [event.body.interaction.requestId] : []
    )
  );
  const persisted = persistedRequestIds.size > 0;
  const canonical = cursor.canonicalIdentity?.identity;
  if (!canonical?.executorRunId) {
    return unavailableIntervention(
      persisted,
      "Exact runner identity is unavailable.",
      promptIdentity,
      promptContinuationAvailable,
      promptInFlight,
      promptUnavailableReason
    );
  }
  const sessionIds =
    knownSessionIds ??
    new Set(
      events.flatMap((event) => (event.correlation?.sessionId ? [event.correlation.sessionId] : []))
    );
  const sessionId = selected.sessionId ?? (sessionIds.size === 1 ? [...sessionIds][0] : undefined);
  if (!sessionId)
    return unavailableIntervention(
      persisted,
      "Exact ACP session identity is unavailable.",
      promptIdentity,
      promptContinuationAvailable,
      promptInFlight,
      promptUnavailableReason
    );
  try {
    const registered = activeAgentRunRegistry.lookupExact({
      scope: runDir,
      executorRunId: canonical.executorRunId,
      claimRef: canonical.claimRef,
      ...(canonical.desktopRunId ? { desktopRunId: canonical.desktopRunId } : {}),
      ...(canonical.runSessionId ? { runSessionId: canonical.runSessionId } : {}),
      sessionId
    });
    if (!registered)
      return unavailableIntervention(
        persisted,
        "No live owned ACP session is available.",
        promptIdentity,
        promptContinuationAvailable,
        promptInFlight,
        promptUnavailableReason
      );
    if (
      (registered.identity.runSessionId ?? null) !== canonical.runSessionId ||
      (registered.identity.desktopRunId ?? null) !== canonical.desktopRunId
    ) {
      return unavailableIntervention(
        persisted,
        "Live ACP session identity does not match the selected record.",
        promptIdentity,
        promptContinuationAvailable,
        promptInFlight,
        promptUnavailableReason
      );
    }
    if (!canonical.desktopRunId || !canonical.runSessionId) {
      return unavailableIntervention(
        persisted,
        "Exact Desktop run/session identity is unavailable.",
        promptIdentity,
        promptContinuationAvailable,
        promptInFlight,
        promptUnavailableReason
      );
    }
    const sessionIdentity = runnerSessionActionIdentitySchema.parse({
      scope: runDir,
      executorRunId: canonical.executorRunId,
      desktopRunId: canonical.desktopRunId,
      runSessionId: canonical.runSessionId,
      claimRef: canonical.claimRef,
      sessionId
    });
    const activeRequests = [...registered.control.pendingRequests.values()]
      .filter((request) => persistedRequestIds.has(request.requestId))
      .map((request) => {
        const identity = runnerRequestActionIdentitySchema.parse({
          ...sessionIdentity,
          requestId: request.requestId
        });
        const base = {
          requestId: request.requestId,
          interactionId: request.interactionId,
          requestedAt: request.requestedAt,
          summary: redactRunnerEventText(request.summary).text,
          identity
        };
        if (request.kind === "permission") {
          const available = registered.control.interventionCapabilities.permission;
          return {
            ...base,
            kind: request.kind,
            permissionOptions: [...request.permissionOptions],
            availability: {
              available,
              reason: available
                ? null
                : "Permission intervention is not negotiated for this Desktop ACP session."
            }
          };
        }
        if (request.kind === "elicitation") {
          const available = registered.control.interventionCapabilities.elicitationPreview;
          return {
            ...base,
            kind: request.kind,
            elicitationSchema: request.elicitationSchema,
            availability: {
              available,
              reason: available
                ? null
                : "Preview elicitation is not negotiated for this Desktop ACP session."
            }
          };
        }
        return {
          ...base,
          kind: request.kind,
          availability: {
            available: false,
            reason: "Authentication intervention is not supported by the Desktop runner."
          }
        };
      });
    const cancelAvailable =
      registered.control.interventionCapabilities.cancel &&
      (registered.lifecycleState === "running" ||
        registered.lifecycleState === "waiting_interaction");
    const livePromptInFlight = activeAgentRunRegistry.promptInFlight(registered);
    const livePromptAccepting = activeAgentRunRegistry.promptAccepting(registered);
    const promptBlockedByInteraction =
      registered.lifecycleState === "waiting_interaction" ||
      registered.control.pendingRequests.size > 0;
    const promptAvailable =
      promptIdentity !== undefined &&
      registered.lifecycleState === "running" &&
      livePromptAccepting &&
      !promptBlockedByInteraction &&
      !livePromptInFlight;
    const livePromptReason = promptAvailable
      ? null
      : promptIdentity === undefined
        ? (promptUnavailableReason ?? "Exact Desktop record identity is unavailable.")
        : !livePromptAccepting
          ? "The owned ACP session is finishing and no longer accepts conversation turns."
          : promptBlockedByInteraction
            ? "Resolve the pending ACP permission or elicitation before sending a prompt."
            : livePromptInFlight
              ? "An ACP conversation turn is already queued or in progress."
              : `ACP session is not prompt-capable in state '${registered.lifecycleState}'.`;
    return {
      intervention: {
        prompt: promptIdentity
          ? {
              available: promptAvailable,
              reason: livePromptReason,
              identity: promptIdentity,
              inFlight: livePromptInFlight
            }
          : { available: false, reason: livePromptReason, identity: null, inFlight: false },
        cancel: {
          available: cancelAvailable,
          reason: cancelAvailable
            ? null
            : registered.control.interventionCapabilities.cancel
              ? `ACP session is not cancellable in state '${registered.lifecycleState}'.`
              : "ACP session cancellation is not negotiated for this Desktop session.",
          identity: sessionIdentity
        }
      },
      interaction: {
        persisted,
        active: activeRequests.length > 0,
        stale: persisted && activeRequests.length === 0,
        activeRequests
      }
    };
  } catch {
    return unavailableIntervention(
      persisted,
      "Live ACP session identity could not be verified.",
      promptIdentity,
      promptContinuationAvailable,
      promptInFlight,
      promptUnavailableReason
    );
  }
}

function unavailableIntervention(
  persisted: boolean,
  reason: string,
  promptIdentity?: DesktopAgentPromptIdentity,
  promptContinuationAvailable = false,
  promptInFlight = false,
  promptUnavailableReason?: string
): Pick<RunnerRecordReadModel, "interaction" | "intervention"> {
  return {
    intervention: {
      prompt:
        promptIdentity && promptContinuationAvailable
          ? {
              available: !promptInFlight,
              reason: promptInFlight ? "An ACP conversation turn is already in progress." : null,
              identity: promptIdentity,
              inFlight: promptInFlight
            }
          : {
              available: false,
              reason: promptUnavailableReason ?? reason,
              identity: promptIdentity ?? null,
              inFlight: false
            },
      cancel: { available: false, reason, identity: null }
    },
    interaction: {
      persisted,
      active: false,
      stale: persisted,
      activeRequests: []
    }
  };
}

function activeSnapshot(options: {
  model: AcpEventReadModel;
  runDir: string;
  selected: SelectedRecordIdentity;
  cursor?: RunnerEventCursor;
  promptIdentity?: DesktopAgentPromptIdentity;
  promptContinuationAvailable?: boolean;
  promptInFlight?: boolean;
  promptUnavailableReason?: string;
}): RunnerRecordReadModel {
  const replay = options.model.replay(options.cursor ?? 0);
  const mismatch = identityMismatch([], options.selected, replay.cursor);
  if (mismatch || replay.diagnostics.some((item) => item.code === "identity_mismatch")) {
    throw new Error(mismatch?.message ?? "Runner event stream contains inconsistent identities.");
  }
  const completeProjection = options.model.completeProjection();
  const snapshot: RunnerRecordReadModel = {
    ...replay,
    events: visibleEvents(replay.events),
    conversation: completeProjection.conversation,
    timeline: completeProjection.timeline,
    ...interactionState(
      options.runDir,
      options.selected,
      replay.cursor,
      options.model.interactionEventsSnapshot(),
      options.model.knownSessionIds(),
      options.promptIdentity,
      options.promptContinuationAvailable,
      options.promptInFlight,
      options.promptUnavailableReason
    )
  };
  return snapshot;
}

function subscribeActiveModel(options: {
  model: AcpEventReadModel;
  runDir: string;
  selected: SelectedRecordIdentity;
  cursor?: RunnerEventCursor;
  promptIdentity?: DesktopAgentPromptIdentity;
  promptContinuationAvailable?: boolean;
  promptInFlight?: boolean;
  promptUnavailableReason?: string;
  afterSequence: number;
  subscriber: RunnerRecordReadSubscriber;
}): AcpEventSubscription {
  let updateChain = Promise.resolve();
  const emit = (): Promise<void> => {
    updateChain = updateChain.then(() => options.subscriber(activeSnapshot(options)));
    return updateChain;
  };
  const eventSubscription = options.model.subscribe(options.afterSequence, emit, {
    keepOpenAfterTerminal: options.promptIdentity !== undefined
  });
  const unsubscribeInteraction = activeAgentRunRegistry.subscribeInteractionChanges((handle) => {
    if (
      handle.identity.scope !== options.runDir ||
      handle.identity.executorRunId !== options.selected.runId ||
      handle.identity.claimRef !== options.selected.claimRef
    ) {
      return;
    }
    void emit().catch(() => eventSubscription.unsubscribe());
  });
  return {
    unsubscribe: () => {
      unsubscribeInteraction();
      eventSubscription.unsubscribe();
    },
    closed: eventSubscription.closed.then(async (closeResult) => {
      unsubscribeInteraction();
      await updateChain.catch(() => undefined);
      return closeResult;
    })
  };
}

export async function consumeRunnerRecordReadModel(options: {
  runDir: string;
  metadata: Record<string, unknown>;
  cursor?: RunnerEventCursor;
  subscriber?: RunnerRecordReadSubscriber;
  promptIdentity?: DesktopAgentPromptIdentity;
  promptContinuationAvailable?: boolean;
  promptInFlight?: boolean;
  promptUnavailableReason?: string;
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
    let snapshot: RunnerRecordReadModel;
    try {
      snapshot = activeSnapshot({
        model: activeModel,
        runDir: options.runDir,
        selected,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.promptIdentity ? { promptIdentity: options.promptIdentity } : {}),
        promptContinuationAvailable: options.promptContinuationAvailable,
        promptInFlight: options.promptInFlight,
        promptUnavailableReason: options.promptUnavailableReason
      });
    } catch {
      return failedIdentitySnapshot({
        cursor: typeof options.cursor === "object" ? options.cursor : undefined,
        message: "Runner event cursor identity does not match the active record."
      });
    }
    if (
      !options.subscriber ||
      (snapshot.terminal && snapshot.intervention.prompt.identity === null)
    ) {
      return { snapshot, subscription: null };
    }
    const subscription = subscribeActiveModel({
      model: activeModel,
      runDir: options.runDir,
      selected,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      afterSequence: snapshot.cursor.afterSequence,
      subscriber: options.subscriber,
      ...(options.promptIdentity ? { promptIdentity: options.promptIdentity } : {}),
      promptContinuationAvailable: options.promptContinuationAvailable,
      promptInFlight: options.promptInFlight,
      promptUnavailableReason: options.promptUnavailableReason
    });
    let authoritativeSnapshot: RunnerRecordReadModel;
    try {
      authoritativeSnapshot = activeSnapshot({
        model: activeModel,
        runDir: options.runDir,
        selected,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.promptIdentity ? { promptIdentity: options.promptIdentity } : {}),
        promptContinuationAvailable: options.promptContinuationAvailable,
        promptInFlight: options.promptInFlight,
        promptUnavailableReason: options.promptUnavailableReason
      });
    } catch {
      subscription.unsubscribe();
      return failedIdentitySnapshot({
        cursor: snapshot.cursor,
        message: "Runner event identity changed during subscription registration."
      });
    }
    if (
      authoritativeSnapshot.terminal &&
      authoritativeSnapshot.intervention.prompt.identity === null
    ) {
      subscription.unsubscribe();
      return { snapshot: authoritativeSnapshot, subscription: null };
    }
    return { snapshot: authoritativeSnapshot, subscription };
  }

  let content = "";
  let completeContentByteOffset = 0;
  const boundaryDiagnostics: RunnerEventReplayDiagnostic[] = [];
  try {
    const persistedContent = await readFile(join(options.runDir, "events.ndjson"));
    content = persistedContent.toString("utf8");
    const finalNewline = persistedContent.lastIndexOf(0x0a);
    completeContentByteOffset = finalNewline < 0 ? 0 : finalNewline + 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      boundaryDiagnostics.push(
        diagnostic("missing_log", "Normalized ACP event log does not exist.")
      );
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
  const completeReplay = options.cursor
    ? replayNormalizedRunnerEvents({ content, runId: selected.runId })
    : replay;
  // Authoritative read-model seam: project persisted retention_boundary events into diagnostics
  // so reopen/cursor consumers match live store diagnosticsSnapshot() without UI-specific fallbacks.
  const retentionDiagnostics = projectPersistedRetentionDiagnostics(completeReplay.events);
  const projection = new AcpProjectionAccumulator();
  for (const event of visibleEvents(completeReplay.events)) projection.append(event);
  const allEvents = [...completeReplay.events];
  const diagnostics = [...boundaryDiagnostics, ...replay.diagnostics, ...retentionDiagnostics];
  let followedDiagnostics = diagnostics;
  const snapshot = runnerRecordReadModelSchema.parse({
    events: visibleEvents(replay.events),
    ...projection.snapshot(),
    diagnostics,
    cursor: replay.nextCursor,
    terminal: replay.terminal,
    actualConfiguration: projectAcpActualSessionConfiguration(completeReplay.events),
    ...interactionState(
      options.runDir,
      selected,
      completeReplay.nextCursor,
      completeReplay.events,
      undefined,
      options.promptIdentity,
      options.promptContinuationAvailable,
      options.promptInFlight,
      options.promptUnavailableReason
    )
  });
  const persistedSubscriber = options.subscriber;
  const canFollowPersistedLog =
    persistedSubscriber !== undefined && selected.status === "running" && !snapshot.terminal;
  const persistedAuthority = canFollowPersistedLog
    ? selectedRecordCanonicalIdentity(selected, completeReplay.nextCursor)
    : null;
  const subscription =
    persistedAuthority && persistedSubscriber
      ? subscribePersistedRunnerEvents({
          canonicalIdentity: persistedAuthority,
          cursor: completeReplay.nextCursor,
          eventsPath: join(options.runDir, "events.ndjson"),
          initialByteOffset: completeContentByteOffset,
          onUpdate: async (update) => {
            allEvents.push(...update.events);
            for (const event of visibleEvents(update.events)) projection.append(event);
            const projected = projection.snapshot();
            followedDiagnostics = mergeReplayDiagnostics(followedDiagnostics, [
              ...update.diagnostics,
              ...projectPersistedRetentionDiagnostics(allEvents)
            ]);
            await persistedSubscriber(
              runnerRecordReadModelSchema.parse({
                events: visibleEvents(update.events),
                ...projected,
                diagnostics: followedDiagnostics,
                cursor: update.cursor,
                terminal: update.terminal,
                actualConfiguration: projectAcpActualSessionConfiguration(allEvents),
                ...interactionState(
                  options.runDir,
                  selected,
                  update.cursor,
                  allEvents,
                  undefined,
                  options.promptIdentity,
                  options.promptContinuationAvailable,
                  options.promptInFlight,
                  options.promptUnavailableReason
                )
              })
            );
          }
        })
      : null;
  return {
    snapshot,
    subscription
  };
}

function selectedRecordCanonicalIdentity(
  selected: SelectedRecordIdentity,
  cursor: RunnerEventCursor
) {
  const canonical = cursor.canonicalIdentity;
  if (!canonical) {
    throw new Error(`Persisted ACP record '${selected.claimRef}' has no canonical event identity.`);
  }
  return canonical;
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
