import { z } from "zod";
import {
  runnerInteractionIdentitySchema,
  runnerPermissionOptionSchema,
  type RunnerPermissionInteractionRequest,
  type RunnerPermissionOption
} from "./runnerInteractionContract.js";
import type { RunnerPermissionChannelDecision } from "./persistentRunnerInteractionChannel.js";

export const runEventVersionSchema = z.literal("planweave.run-event/v1");

const runnerInteractionEventIdentitySchema = runnerInteractionIdentitySchema.extend({
  recordId: z.string().min(1)
});

const runnerInteractionRequiredPayloadSchema = runnerInteractionEventIdentitySchema
  .extend({
    kind: z.literal("permission"),
    requestedAt: z.string().datetime(),
    summary: z.string().min(1),
    toolCallId: z.string().min(1),
    options: z.array(runnerPermissionOptionSchema).min(1)
  })
  .strict();

const runnerInteractionResolvedPayloadSchema = runnerInteractionEventIdentitySchema
  .extend({
    kind: z.literal("permission"),
    resolvedAt: z.string().datetime(),
    resolutionStage: z.literal("owner_consumed"),
    outcome: z.enum(["approved", "denied", "cancelled", "expired"]),
    selectedOption: runnerPermissionOptionSchema.nullable()
  })
  .strict();

export const runnerInteractionRequiredEventSchema = z
  .object({
    version: runEventVersionSchema,
    type: z.literal("interaction_required"),
    interaction: runnerInteractionRequiredPayloadSchema
  })
  .strict();
export type RunnerInteractionRequiredEvent = z.infer<typeof runnerInteractionRequiredEventSchema>;

export const runnerInteractionResolvedEventSchema = z
  .object({
    version: runEventVersionSchema,
    type: z.literal("interaction_resolved"),
    interaction: runnerInteractionResolvedPayloadSchema
  })
  .strict();
export type RunnerInteractionResolvedEvent = z.infer<typeof runnerInteractionResolvedEventSchema>;

const runTerminalEventFields = {
  version: runEventVersionSchema,
  sessionId: z.string().min(1),
  terminalReason: z.enum([
    "completed",
    "step_limit_reached",
    "manual",
    "blocked",
    "cancelled",
    "failed"
  ])
};

export const runCompletedEventSchema = z
  .object({
    ...runTerminalEventFields,
    type: z.literal("run_completed"),
    ok: z.literal(true)
  })
  .strict();
export const runFailedEventSchema = z
  .object({
    ...runTerminalEventFields,
    type: z.literal("run_failed"),
    ok: z.literal(false)
  })
  .strict();
export const runEventSchema = z.discriminatedUnion("type", [
  runnerInteractionRequiredEventSchema,
  runnerInteractionResolvedEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema
]);
export type RunEvent = z.infer<typeof runEventSchema>;

export interface RunnerInteractionObserver {
  interactionRequired: (event: RunnerInteractionRequiredEvent) => void | Promise<void>;
  interactionResolved: (event: RunnerInteractionResolvedEvent) => void | Promise<void>;
}

function eventIdentity(request: RunnerPermissionInteractionRequest) {
  return {
    recordId: `${request.identity.claimRef}::${request.identity.executorRunId}`,
    ...request.identity
  };
}

export function createRunnerInteractionRequiredEvent(
  request: RunnerPermissionInteractionRequest
): RunnerInteractionRequiredEvent {
  return runnerInteractionRequiredEventSchema.parse({
    version: "planweave.run-event/v1",
    type: "interaction_required",
    interaction: {
      ...eventIdentity(request),
      kind: request.kind,
      requestedAt: request.requestedAt,
      summary: request.summary,
      toolCallId: request.toolCallId,
      options: request.options
    }
  });
}

function resolvedOutcome(decision: RunnerPermissionChannelDecision): {
  outcome: RunnerInteractionResolvedEvent["interaction"]["outcome"];
  selectedOption: RunnerPermissionOption | null;
} {
  if (decision.kind === "expired") {
    return { outcome: "expired", selectedOption: null };
  }
  if (decision.kind === "cancel") {
    return { outcome: "cancelled", selectedOption: null };
  }
  const outcome = decision.option.decision === "approve" ? "approved" : "denied";
  return {
    outcome,
    selectedOption: decision.option
  };
}

export function createRunnerInteractionResolvedEvent(
  request: RunnerPermissionInteractionRequest,
  decision: RunnerPermissionChannelDecision,
  now: Date = new Date()
): RunnerInteractionResolvedEvent {
  return runnerInteractionResolvedEventSchema.parse({
    version: "planweave.run-event/v1",
    type: "interaction_resolved",
    interaction: {
      ...eventIdentity(request),
      kind: request.kind,
      resolvedAt: now.toISOString(),
      resolutionStage: "owner_consumed",
      ...resolvedOutcome(decision)
    }
  });
}

export function createRunTerminalEvent(result: {
  session: { sessionId: string };
  terminalReason:
    | "completed"
    | "step_limit_reached"
    | "manual"
    | "blocked"
    | "cancelled"
    | "failed";
  ok: boolean;
}): RunEvent {
  return runEventSchema.parse({
    version: "planweave.run-event/v1",
    type: result.ok ? "run_completed" : "run_failed",
    sessionId: result.session.sessionId,
    terminalReason: result.terminalReason,
    ok: result.ok
  });
}
