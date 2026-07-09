import { z } from "zod";
import type { DesktopAutoRunLogEvent, DesktopAutoRunPhase } from "./types.js";

export const desktopAutoRunPhaseSchema = z.enum([
  "idle",
  "running",
  "pausing",
  "paused",
  "manual",
  "completed",
  "blocked",
  "failed",
  "stopped"
]);

const reservedEventKeys = new Set([
  "timestamp",
  "runId",
  "type",
  "phase",
  "stepCount",
  "currentRef"
]);

/** Wire schema for one NDJSON line written by `appendAutoRunEvent`. */
export const autoRunNdjsonEventSchema = z
  .object({
    timestamp: z.string(),
    runId: z.string(),
    type: z.string(),
    phase: desktopAutoRunPhaseSchema.optional(),
    stepCount: z.number().finite().optional(),
    currentRef: z.union([z.string(), z.null()]).optional()
  })
  .passthrough();

export type AutoRunNdjsonParseError = {
  line: number;
  message: string;
  path: string;
  rawLine: string;
};

export type ParsedAutoRunNdjsonLine =
  | { ok: true; event: DesktopAutoRunLogEvent }
  | { ok: false; parseError: AutoRunNdjsonParseError };

export function isTerminalAutoRunPhase(
  phase: DesktopAutoRunPhase | string | null | undefined
): phase is DesktopAutoRunPhase {
  return (
    phase === "completed" ||
    phase === "blocked" ||
    phase === "failed" ||
    phase === "stopped" ||
    phase === "manual"
  );
}

export function isFailedAutoRunTerminalPhase(
  phase: DesktopAutoRunPhase | string | null | undefined
): boolean {
  return phase === "blocked" || phase === "failed";
}

function eventData(record: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!reservedEventKeys.has(key)) {
      data[key] = value;
    }
  }
  return data;
}

/**
 * Validate one NDJSON event line with Zod.
 * Invalid JSON / schema failures / runId mismatches become explicit parse errors (never silent skips).
 */
export function parseAutoRunNdjsonLine(
  rawLine: string,
  lineNumber: number,
  path: string,
  expectedRunId: string
): ParsedAutoRunNdjsonLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      parseError: {
        line: lineNumber,
        message: `Line ${lineNumber} is not valid JSON: ${detail}`,
        path,
        rawLine
      }
    };
  }

  const result = autoRunNdjsonEventSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      parseError: {
        line: lineNumber,
        message: `Line ${lineNumber} failed Auto Run event schema validation: ${detail}`,
        path,
        rawLine
      }
    };
  }

  if (result.data.runId !== expectedRunId) {
    return {
      ok: false,
      parseError: {
        line: lineNumber,
        message: `Line ${lineNumber} runId "${result.data.runId}" does not match requested runId "${expectedRunId}"`,
        path,
        rawLine
      }
    };
  }

  const event: DesktopAutoRunLogEvent = {
    line: lineNumber,
    timestamp: result.data.timestamp,
    runId: result.data.runId,
    type: result.data.type,
    data: eventData(result.data as Record<string, unknown>)
  };
  if (result.data.phase !== undefined) {
    event.phase = result.data.phase;
  }
  if (result.data.stepCount !== undefined) {
    event.stepCount = result.data.stepCount;
  }
  if (result.data.currentRef !== undefined) {
    event.currentRef = result.data.currentRef;
  }
  return { ok: true, event };
}
