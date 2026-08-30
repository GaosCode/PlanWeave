import { z } from "zod";
import { acpTimelineItemSchema } from "../autoRun/acpConversationProjection.js";
import {
  projectRemoteAcpProjectedTimeline,
  projectRemoteAcpReplay,
  type ProjectedRemoteAcpEvent
} from "../autoRun/remoteAcpEventProjection.js";
import {
  workspaceExecutionEventSchema,
  workspaceExecutionHandleSchema,
  workspaceExecutionScopeSchema,
  type WorkspaceExecutionEvent
} from "./contracts.js";

const identifierSchema = z.string().trim().min(1).max(256);

export const workspaceExecutionSessionViewSchema = z
  .object({
    sessionId: z.string().regex(/^SESSION-\d{4,}$/),
    stateVersion: z.number().int().positive(),
    phase: z.enum(["created", "running", "blocked", "completed", "failed", "stopped"]),
    scope: workspaceExecutionScopeSchema,
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    error: z.string().nullable(),
    interactionStatus: z
      .array(
        z
          .object({
            key: z.string().regex(/^wxi:sha256:[a-f0-9]{64}$/),
            status: z.enum(["pending", "settled", "expired"])
          })
          .strict()
      )
      .max(10_000),
    evidence: z
      .object({
        status: z.enum(["pending", "complete", "incomplete"]),
        diagnostics: z
          .array(
            z
              .object({
                code: identifierSchema,
                message: z.string().trim().min(1).max(4_096),
                observedAt: z.string().datetime()
              })
              .strict()
          )
          .max(100)
      })
      .strict()
  })
  .strict();

export const workspaceExecutionCoordinatorViewSchema = z
  .object({
    version: z.literal("planweave.workspace-execution-view/v1"),
    handle: workspaceExecutionHandleSchema,
    session: workspaceExecutionSessionViewSchema,
    events: z.array(workspaceExecutionEventSchema).max(50_000)
  })
  .strict();

export const workspaceExecutionTimelineSchema = z
  .object({
    version: z.literal("planweave.workspace-execution-timeline/v1"),
    events: z.array(workspaceExecutionEventSchema).max(50_000),
    executionAttemptIds: z.array(identifierSchema).max(10_000),
    pendingInteractions: z.array(identifierSchema).max(10_000),
    runnerTimeline: z.array(acpTimelineItemSchema).max(50_000),
    terminalOutcome: z.enum(["completed", "failed", "cancelled"]).nullable(),
    cursor: z.number().int().nonnegative()
  })
  .strict();

export type WorkspaceExecutionCoordinatorView = z.infer<
  typeof workspaceExecutionCoordinatorViewSchema
>;
export type WorkspaceExecutionTimeline = z.infer<typeof workspaceExecutionTimelineSchema>;

function eventCursor(event: WorkspaceExecutionEvent): number {
  return event.source.target === "remote" ? event.source.cursor : event.source.sequence;
}

export function projectWorkspaceExecutionTimeline(
  inputs: readonly unknown[]
): WorkspaceExecutionTimeline {
  const byId = new Map<string, WorkspaceExecutionEvent>();
  for (const input of inputs) {
    const event = workspaceExecutionEventSchema.parse(input);
    byId.set(event.eventId, event);
  }
  const events = [...byId.values()].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      eventCursor(left) - eventCursor(right) ||
      left.eventId.localeCompare(right.eventId)
  );
  const attempts = new Set<string>();
  const pending = new Set<string>();
  let terminalOutcome: WorkspaceExecutionTimeline["terminalOutcome"] = null;
  const projectedRunnerEvents: ProjectedRemoteAcpEvent[] = [];
  let cursor = 0;
  let currentRemoteAttemptId: string | null = null;
  for (const event of events) {
    if (event.source.target === "local") {
      cursor = Math.max(cursor, event.source.sequence);
    } else if (event.type === "attempt_changed") {
      currentRemoteAttemptId = event.data.executionAttemptId;
      cursor = event.source.cursor;
    } else if (event.source.executionAttemptId !== null) {
      currentRemoteAttemptId ??= event.source.executionAttemptId;
      if (event.source.executionAttemptId === currentRemoteAttemptId) {
        cursor = Math.max(cursor, event.source.cursor);
      }
    } else if (currentRemoteAttemptId === null) {
      cursor = Math.max(cursor, event.source.cursor);
    }
    if (event.source.target === "remote" && event.source.executionAttemptId) {
      attempts.add(event.source.executionAttemptId);
    }
    if (event.type === "attempt_changed") attempts.add(event.data.executionAttemptId);
    if (event.type === "interaction_required") pending.add(event.data.actionId);
    if (event.type === "interaction_resolved") pending.delete(event.data.actionId);
    if (event.type === "run_terminal") terminalOutcome = event.data.outcome;
    if (
      event.type === "runner_event" &&
      event.source.target === "remote" &&
      event.source.executionAttemptId
    ) {
      const replay =
        event.data.eventProtocolVersion === 1
          ? projectRemoteAcpReplay({
              executionAttemptId: event.source.executionAttemptId,
              eventProtocolVersion: 1,
              events: [event.data.event]
            })
          : projectRemoteAcpReplay({
              executionAttemptId: event.source.executionAttemptId,
              eventProtocolVersion: 2,
              events: [event.data.event]
            });
      projectedRunnerEvents.push(...replay.events);
    }
  }
  return workspaceExecutionTimelineSchema.parse({
    version: "planweave.workspace-execution-timeline/v1",
    events,
    executionAttemptIds: [...attempts],
    pendingInteractions: [...pending],
    runnerTimeline: projectRemoteAcpProjectedTimeline(projectedRunnerEvents),
    terminalOutcome,
    cursor
  });
}
