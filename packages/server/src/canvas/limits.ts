import {
  CANVAS_COMMAND_MAX_FRAME_BYTES,
  CANVAS_COMMAND_MAX_JOURNAL_DELTA_ENTRIES,
  CANVAS_COMMAND_MAX_JOURNAL_RETAINED
} from "@planweave-ai/collaboration-protocol/core/limits";

/** Server-side canvas command journal retention (bounded by contract max). */
export const CANVAS_COMMAND_JOURNAL_RETAINED_DEFAULT = Math.min(
  1_024,
  CANVAS_COMMAND_MAX_JOURNAL_RETAINED
) as number;

/** Keep a small number of historical snapshots per canvas for reconnect. */
export const CANVAS_COMMAND_SNAPSHOT_RETAINED_DEFAULT = 16 as const;
export const CANVAS_COMMAND_OPERATION_RECONCILE_BATCH_SIZE = 100 as const;
export const CANVAS_COMMAND_OPERATION_RECEIPT_MAX_OUTCOME_BYTES = 4_096 as const;
export const CANVAS_COMMAND_OPERATION_MAINTENANCE_INTERVAL_MS = 1_000 as const;

/** Snapshot head after every accepted mutation in v1 (cheap metadata only). */
export const CANVAS_COMMAND_SNAPSHOT_EVERY_REVISION = 1 as const;

export const CANVAS_COMMAND_HTTP_BODY_MAX_BYTES = CANVAS_COMMAND_MAX_FRAME_BYTES;
export const CANVAS_COMMAND_WS_MAX_FRAME_BYTES = CANVAS_COMMAND_MAX_FRAME_BYTES;
export const CANVAS_COMMAND_RECONNECT_DELTA_MAX = CANVAS_COMMAND_MAX_JOURNAL_DELTA_ENTRIES;

export const CANVAS_COMMAND_RATE_WINDOW_MS = 60_000 as const;
export const CANVAS_COMMAND_RATE_MAX_REQUESTS = 120 as const;
