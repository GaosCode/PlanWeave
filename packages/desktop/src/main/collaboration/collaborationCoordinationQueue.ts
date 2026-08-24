import type { CollaborationOperationDiagnosticEntry } from "../../shared/collaborationOperationDiagnostics.js";
import type { CollaborationBoundaryErrorKind } from "@planweave-ai/collaboration-protocol/errors";

export type CollaborationCoordinationQueueSnapshot = {
  active: CollaborationOperationDiagnosticEntry | null;
  queued: CollaborationOperationDiagnosticEntry[];
  recent: CollaborationOperationDiagnosticEntry[];
  depth: number;
};

export type CollaborationCoordinationQueue = {
  run<T>(name: string, operation: () => Promise<T>): Promise<T>;
  getDiagnostics(): CollaborationCoordinationQueueSnapshot;
};

export type CollaborationCoordinationQueueOptions = {
  now?: () => Date;
  onChange?: () => void;
  recentLimit?: number;
};

export function runCollaborationDiagnosticsNotification(
  notification: (() => void) | undefined
): void {
  try {
    notification?.();
  } catch {
    console.warn("Collaboration diagnostics notification failed.");
  }
}

type CollaborationDiagnosticErrorCode = NonNullable<
  CollaborationOperationDiagnosticEntry["errorCode"]
>;

const DIAGNOSTIC_ERROR_BY_KIND: Record<
  CollaborationBoundaryErrorKind,
  CollaborationDiagnosticErrorCode
> = {
  auth: "collaboration_auth",
  forbidden: "collaboration_forbidden",
  conflict: "collaboration_conflict",
  rate_limited: "collaboration_rate_limited",
  offline: "collaboration_offline",
  protocol: "collaboration_protocol",
  validation: "collaboration_validation",
  timeout: "collaboration_timeout",
  aborted: "collaboration_aborted",
  payload_too_large: "collaboration_payload_too_large",
  not_found: "collaboration_not_found",
  insecure_transport: "collaboration_insecure_transport",
  unknown: "collaboration_unknown"
};

export function collaborationDiagnosticErrorCode(error: unknown): CollaborationDiagnosticErrorCode {
  if (error && typeof error === "object" && "kind" in error) {
    const kind = (error as { kind?: unknown }).kind;
    if (typeof kind === "string" && Object.hasOwn(DIAGNOSTIC_ERROR_BY_KIND, kind)) {
      return DIAGNOSTIC_ERROR_BY_KIND[kind as CollaborationBoundaryErrorKind];
    }
  }
  return "operation_failed";
}

export function createCollaborationCoordinationQueue(
  options: CollaborationCoordinationQueueOptions = {}
): CollaborationCoordinationQueue {
  const now = options.now ?? (() => new Date());
  const recentLimit = options.recentLimit ?? 20;
  let sequence = 0;
  let operationQueue: Promise<unknown> = Promise.resolve();
  let active: CollaborationOperationDiagnosticEntry | null = null;
  const queued: CollaborationOperationDiagnosticEntry[] = [];
  const recent: CollaborationOperationDiagnosticEntry[] = [];

  const emitChange = (): void => runCollaborationDiagnosticsNotification(options.onChange);
  const timestamp = (): string => now().toISOString();
  const snapshot = (): CollaborationCoordinationQueueSnapshot => ({
    active: active ? { ...active } : null,
    queued: queued.map((entry) => ({ ...entry })),
    recent: recent.map((entry) => ({ ...entry })),
    depth: (active ? 1 : 0) + queued.length
  });

  return {
    run<T>(name: string, operation: () => Promise<T>): Promise<T> {
      sequence += 1;
      const entry: CollaborationOperationDiagnosticEntry = {
        operationId: `coordination-${sequence}`,
        name,
        phase: "queued",
        queuedAt: timestamp(),
        startedAt: null,
        finishedAt: null,
        errorCode: null
      };
      queued.push(entry);
      emitChange();

      const next = operationQueue
        .catch(() => undefined)
        .then(async () => {
          const queuedIndex = queued.indexOf(entry);
          if (queuedIndex >= 0) queued.splice(queuedIndex, 1);
          entry.phase = "running";
          entry.startedAt = timestamp();
          active = entry;
          emitChange();
          try {
            const result = await operation();
            entry.phase = "succeeded";
            return result;
          } catch (error) {
            entry.phase = "failed";
            entry.errorCode = collaborationDiagnosticErrorCode(error);
            throw error;
          } finally {
            entry.finishedAt = timestamp();
            active = null;
            recent.unshift({ ...entry });
            if (recent.length > recentLimit) recent.length = recentLimit;
            emitChange();
          }
        });
      operationQueue = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
    getDiagnostics: snapshot
  };
}
