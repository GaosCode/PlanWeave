import { z } from "zod";
import {
  RUNNER_EVENT_MAX_LINE_BYTES,
  RUNNER_EVENT_RETENTION_MAX_BYTES,
  RUNNER_EVENT_RETENTION_MAX_EVENTS,
  normalizedRunnerEventSchema,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import { runnerIdentitySchema, runnerRunIdentitySchema } from "./runnerContractSchemas.js";
import { containsUnredactedRunnerSecret, utf8ByteLength } from "./runnerEventRedaction.js";

const canonicalEventIdentitySchema = z
  .object({ identity: runnerRunIdentitySchema, runner: runnerIdentitySchema })
  .strict();
export type CanonicalRunnerEventIdentity = z.infer<typeof canonicalEventIdentitySchema>;

export const runnerEventCursorSchema = z
  .object({
    version: z.literal("planweave.runner-event-cursor/v1"),
    runId: z.string().min(1),
    afterSequence: z.number().int().nonnegative(),
    canonicalIdentity: canonicalEventIdentitySchema.nullable(),
    terminal: z.boolean()
  })
  .strict()
  .superRefine((cursor, context) => {
    if (cursor.terminal && !cursor.canonicalIdentity) {
      context.addIssue({
        code: "custom",
        path: ["canonicalIdentity"],
        message: "A terminal runner event cursor requires a canonical identity."
      });
    }
  });
export type RunnerEventCursor = z.infer<typeof runnerEventCursorSchema>;

export type RunnerEventReplayDiagnostic = {
  code:
    | "corrupt_line"
    | "partial_line"
    | "duplicate_sequence"
    | "out_of_order_sequence"
    | "initial_sequence_gap"
    | "sequence_gap"
    | "retention_boundary"
    | "identity_mismatch"
    | "line_limit_exceeded"
    | "secret_detected"
    | "retention_limit_reached"
    | "missing_log"
    | "oversized_log"
    | "retention_truncation"
    | "subscriber_backpressure"
    | "subscriber_callback_failed";
  line: number | null;
  message: string;
};

export type RunnerEventReplay = {
  events: NormalizedRunnerEvent[];
  diagnostics: RunnerEventReplayDiagnostic[];
  nextCursor: RunnerEventCursor;
  partialLine: string | null;
  terminal: boolean;
};

type RunnerEventReplayOptions = {
  content: string;
  runId: string;
  cursor?: RunnerEventCursor;
  afterSequence?: number;
  canonicalIdentity?: CanonicalRunnerEventIdentity;
  retainedFromSequence?: number;
};

type RunnerEventStreamRecord = {
  line: string;
  lineNumber: number;
  byteLength: number;
};

function splitRunnerEventStream(content: string): {
  records: RunnerEventStreamRecord[];
  partial: string;
  partialLineNumber: number;
} {
  const records: RunnerEventStreamRecord[] = [];
  let start = 0;
  let lineNumber = 1;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) {
      break;
    }
    const rawLine = content.slice(start, newline);
    const crlf = rawLine.endsWith("\r");
    const line = crlf ? rawLine.slice(0, -1) : rawLine;
    records.push({
      line,
      lineNumber,
      byteLength: utf8ByteLength(line) + (crlf ? 2 : 1)
    });
    start = newline + 1;
    lineNumber += 1;
  }
  return {
    records,
    partial: content.slice(start),
    partialLineNumber: lineNumber
  };
}

function sameCanonicalIdentity(
  left: CanonicalRunnerEventIdentity,
  right: CanonicalRunnerEventIdentity
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventIdentity(event: NormalizedRunnerEvent): CanonicalRunnerEventIdentity {
  return { identity: event.identity, runner: event.runner };
}

function safePartialLine(options: {
  partial: string;
  line: number;
  diagnostics: RunnerEventReplayDiagnostic[];
}): string | null {
  if (!options.partial) {
    return null;
  }
  if (utf8ByteLength(options.partial) > RUNNER_EVENT_MAX_LINE_BYTES) {
    options.diagnostics.push({
      code: "line_limit_exceeded",
      line: options.line,
      message: `Trailing partial line exceeds the ${RUNNER_EVENT_MAX_LINE_BYTES}-byte UTF-8 limit and was discarded.`
    });
    return null;
  }
  if (containsUnredactedRunnerSecret(options.partial)) {
    options.diagnostics.push({
      code: "secret_detected",
      line: options.line,
      message: "Trailing partial line contains credential material and was discarded."
    });
    return null;
  }
  options.diagnostics.push({
    code: "partial_line",
    line: options.line,
    message: "Trailing partial NDJSON line was retained for the next read and not decoded."
  });
  return options.partial;
}

export function replayNormalizedRunnerEvents(options: RunnerEventReplayOptions): RunnerEventReplay {
  const diagnostics: RunnerEventReplayDiagnostic[] = [];
  const cursor = options.cursor ? runnerEventCursorSchema.parse(options.cursor) : null;
  if (cursor && cursor.runId !== options.runId) {
    throw new Error("Runner event cursor runId does not match the requested run.");
  }
  const afterSequence = cursor?.afterSequence ?? options.afterSequence ?? 0;
  const expectedCanonicalIdentity = options.canonicalIdentity
    ? canonicalEventIdentitySchema.parse(options.canonicalIdentity)
    : null;
  const cursorCanonicalIdentity = cursor?.canonicalIdentity ?? null;
  if (
    expectedCanonicalIdentity &&
    cursorCanonicalIdentity &&
    !sameCanonicalIdentity(expectedCanonicalIdentity, cursorCanonicalIdentity)
  ) {
    diagnostics.push({
      code: "identity_mismatch",
      line: null,
      message: "Runner event cursor canonical identity does not match the requested stream."
    });
  }
  let canonicalIdentity = expectedCanonicalIdentity ?? cursorCanonicalIdentity;
  const stream = splitRunnerEventStream(options.content);

  const events: NormalizedRunnerEvent[] = [];
  const seen = new Set<number>();
  let previous: number | null = null;
  let highestSequence = afterSequence;
  let totalBytes = 0;
  let terminal = cursor?.terminal ?? false;
  let retentionReached = false;
  for (let index = 0; index < stream.records.length; index += 1) {
    const { line, lineNumber, byteLength } = stream.records[index];
    const lineBytes = utf8ByteLength(line);
    totalBytes += byteLength;
    if (
      totalBytes > RUNNER_EVENT_RETENTION_MAX_BYTES ||
      index >= RUNNER_EVENT_RETENTION_MAX_EVENTS
    ) {
      diagnostics.push({
        code: "retention_limit_reached",
        line: lineNumber,
        message: "Replay stopped at the configured UTF-8 retention boundary."
      });
      retentionReached = true;
      break;
    }
    if (!line) {
      continue;
    }
    if (lineBytes > RUNNER_EVENT_MAX_LINE_BYTES) {
      diagnostics.push({
        code: "line_limit_exceeded",
        line: lineNumber,
        message: `Line exceeds the ${RUNNER_EVENT_MAX_LINE_BYTES}-byte UTF-8 limit.`
      });
      continue;
    }
    if (containsUnredactedRunnerSecret(line)) {
      diagnostics.push({
        code: "secret_detected",
        line: lineNumber,
        message: "Line contains credential material and was excluded from normalized views."
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      diagnostics.push({
        code: "corrupt_line",
        line: lineNumber,
        message: "Line is not valid JSON and was excluded from normalized views."
      });
      continue;
    }
    const parsed = normalizedRunnerEventSchema.safeParse(raw);
    if (!parsed.success) {
      diagnostics.push({
        code: "corrupt_line",
        line: lineNumber,
        message: "Line failed normalized runner event validation."
      });
      continue;
    }
    const event = parsed.data;
    const candidateIdentity = eventIdentity(event);
    if (event.identity.runId !== options.runId) {
      diagnostics.push({
        code: "identity_mismatch",
        line: lineNumber,
        message: "Event run identity does not match the requested run."
      });
      continue;
    }
    if (canonicalIdentity === null) {
      canonicalIdentity = candidateIdentity;
    } else if (!sameCanonicalIdentity(canonicalIdentity, candidateIdentity)) {
      diagnostics.push({
        code: "identity_mismatch",
        line: lineNumber,
        message: "Event project/canvas/task/claim/run/runner identity drifted within one run."
      });
      continue;
    }
    if (seen.has(event.sequence)) {
      diagnostics.push({
        code: "duplicate_sequence",
        line: lineNumber,
        message: `Duplicate sequence ${event.sequence} was ignored.`
      });
      continue;
    }
    seen.add(event.sequence);
    if (previous !== null && event.sequence <= previous) {
      diagnostics.push({
        code: "out_of_order_sequence",
        line: lineNumber,
        message: `Sequence ${event.sequence} follows ${previous}; persisted order is authoritative.`
      });
      continue;
    }
    if (previous === null && event.sequence > 1) {
      const retainedBoundary = options.retainedFromSequence === event.sequence;
      diagnostics.push({
        code: retainedBoundary ? "retention_boundary" : "initial_sequence_gap",
        line: lineNumber,
        message: retainedBoundary
          ? `Replay begins at retained sequence ${event.sequence}.`
          : `Replay begins at sequence ${event.sequence}; earlier events are unavailable.`
      });
    } else if (previous !== null && event.sequence !== previous + 1) {
      diagnostics.push({
        code: "sequence_gap",
        line: lineNumber,
        message: `Sequence gap between ${previous} and ${event.sequence}.`
      });
    }
    previous = event.sequence;
    highestSequence = Math.max(highestSequence, event.sequence);
    if (event.body.kind === "terminal") {
      terminal = true;
    }
    if (event.sequence > afterSequence) {
      events.push(event);
    }
  }
  let partialLine: string | null = null;
  if (!retentionReached && stream.partial) {
    totalBytes += utf8ByteLength(stream.partial);
    if (totalBytes > RUNNER_EVENT_RETENTION_MAX_BYTES) {
      diagnostics.push({
        code: "retention_limit_reached",
        line: stream.partialLineNumber,
        message: "Replay stopped at the configured UTF-8 retention boundary."
      });
    } else {
      partialLine = safePartialLine({
        partial: stream.partial,
        line: stream.partialLineNumber,
        diagnostics
      });
    }
  }
  return {
    events,
    diagnostics,
    nextCursor: {
      version: "planweave.runner-event-cursor/v1",
      runId: options.runId,
      afterSequence: highestSequence,
      canonicalIdentity,
      terminal
    },
    partialLine,
    terminal
  };
}
