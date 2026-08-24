import { z } from "zod";

export const collaborationOperationPhaseSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed"
]);

export const collaborationDiagnosticErrorCodeSchema = z.enum([
  "operation_failed",
  "collaboration_auth",
  "collaboration_forbidden",
  "collaboration_conflict",
  "collaboration_rate_limited",
  "collaboration_offline",
  "collaboration_protocol",
  "collaboration_validation",
  "collaboration_timeout",
  "collaboration_aborted",
  "collaboration_payload_too_large",
  "collaboration_not_found",
  "collaboration_insecure_transport",
  "collaboration_unknown"
]);

const diagnosticTimestampSchema = z.string().datetime({ offset: true });

export const collaborationOperationDiagnosticEntrySchema = z
  .object({
    operationId: z.string().min(1).max(96),
    name: z.string().min(1).max(128),
    phase: collaborationOperationPhaseSchema,
    queuedAt: diagnosticTimestampSchema,
    startedAt: diagnosticTimestampSchema.nullable(),
    finishedAt: diagnosticTimestampSchema.nullable(),
    errorCode: collaborationDiagnosticErrorCodeSchema.nullable()
  })
  .strict()
  .superRefine((entry, context) => {
    const invalid = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    if (entry.phase === "queued") {
      if (entry.startedAt || entry.finishedAt || entry.errorCode)
        invalid("queued_operation_invalid");
      return;
    }
    if (!entry.startedAt) invalid("started_operation_missing_timestamp");
    if (entry.phase === "running") {
      if (entry.finishedAt || entry.errorCode) invalid("running_operation_invalid");
      return;
    }
    if (!entry.finishedAt) invalid("settled_operation_missing_timestamp");
    if (entry.phase === "succeeded" && entry.errorCode) invalid("successful_operation_has_error");
    if (entry.phase === "failed" && !entry.errorCode) invalid("failed_operation_missing_error");
  });

export const collaborationStartupDiagnosticSchema = z
  .object({
    phase: z.enum(["restoring", "ready", "failed"]),
    startedAt: diagnosticTimestampSchema,
    settledAt: diagnosticTimestampSchema.nullable(),
    errorCode: collaborationDiagnosticErrorCodeSchema.nullable()
  })
  .strict()
  .superRefine((startup, context) => {
    if (startup.phase === "restoring" && (startup.settledAt || startup.errorCode)) {
      context.addIssue({ code: "custom", message: "restoring_startup_invalid" });
    }
    if (startup.phase === "ready" && (!startup.settledAt || startup.errorCode)) {
      context.addIssue({ code: "custom", message: "ready_startup_invalid" });
    }
    if (startup.phase === "failed" && (!startup.settledAt || !startup.errorCode)) {
      context.addIssue({ code: "custom", message: "failed_startup_invalid" });
    }
  });

export const collaborationOperationDiagnosticsSchema = z
  .object({
    schemaVersion: z.literal("planweave.collaboration.operations/v1"),
    capturedAt: diagnosticTimestampSchema,
    startup: collaborationStartupDiagnosticSchema,
    coordinationQueue: z
      .object({
        active: collaborationOperationDiagnosticEntrySchema.nullable(),
        queued: z.array(collaborationOperationDiagnosticEntrySchema),
        recent: z.array(collaborationOperationDiagnosticEntrySchema),
        depth: z.number().int().nonnegative()
      })
      .strict()
      .superRefine((queue, context) => {
        const expectedDepth = (queue.active ? 1 : 0) + queue.queued.length;
        if (queue.depth !== expectedDepth) {
          context.addIssue({ code: "custom", message: "coordination_queue_depth_invalid" });
        }
        if (queue.active && queue.active.phase !== "running") {
          context.addIssue({ code: "custom", message: "coordination_queue_active_invalid" });
        }
        if (queue.queued.some((entry) => entry.phase !== "queued")) {
          context.addIssue({ code: "custom", message: "coordination_queue_queued_invalid" });
        }
        if (queue.recent.some((entry) => entry.phase !== "succeeded" && entry.phase !== "failed")) {
          context.addIssue({ code: "custom", message: "coordination_queue_recent_invalid" });
        }
      })
  })
  .strict();

export type CollaborationOperationDiagnosticEntry = z.infer<
  typeof collaborationOperationDiagnosticEntrySchema
>;
export type CollaborationStartupDiagnostic = z.infer<typeof collaborationStartupDiagnosticSchema>;
export type CollaborationOperationDiagnostics = z.infer<
  typeof collaborationOperationDiagnosticsSchema
>;
