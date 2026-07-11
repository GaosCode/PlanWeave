import {
  normalizedOutputBody,
  normalizedRunnerEventSchema,
  type NormalizedRunnerEvent
} from "../autoRun/normalizedEventContract.js";
import type { RunnerEventReplayDiagnostic } from "../autoRun/runnerEventReplay.js";
import type { AgentFamily, RunnerTransport } from "../types/executor.js";
import type { DesktopAutoRunLogEvent } from "./types.js";

export type LegacyDesktopRunnerEventContext = {
  projectId: string;
  canvasId: string;
  taskId: string;
  blockId: string;
  claimRef: string;
  runSessionId: string | null;
  executorRunId: string | null;
  runnerKind: RunnerTransport;
  agentId: AgentFamily;
};

export type LegacyDesktopRunnerEventAdaptation = {
  events: NormalizedRunnerEvent[];
  diagnostics: RunnerEventReplayDiagnostic[];
};

function normalizedBody(event: DesktopAutoRunLogEvent): NormalizedRunnerEvent["body"] {
  const outputSummary = event.data.outputSummary;
  if (typeof outputSummary === "string") {
    return normalizedOutputBody("stdout", outputSummary);
  }
  if (event.phase === "completed") {
    return {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "succeeded",
        exitCode: 0,
        finishedAt: event.timestamp ?? new Date(0).toISOString(),
        diagnostic: null,
        artifactValidated: true
      }
    };
  }
  if (event.phase === "failed" || event.phase === "blocked") {
    return {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "failed",
        exitCode: null,
        finishedAt: event.timestamp ?? new Date(0).toISOString(),
        diagnostic: `Legacy Desktop Auto Run phase '${event.phase}'.`,
        artifactValidated: false
      }
    };
  }
  if (event.phase === "stopped") {
    return {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "cancelled",
        exitCode: null,
        finishedAt: event.timestamp ?? new Date(0).toISOString(),
        diagnostic: "Legacy Desktop Auto Run was stopped.",
        artifactValidated: false
      }
    };
  }
  return {
    kind: "lifecycle",
    state: event.phase === "running" ? "running" : "ready",
    message: `Legacy Desktop Auto Run event '${event.type ?? "unknown"}'.`
  };
}

/**
 * Compatibility adapter only: persisted file order is authoritative and becomes normalized
 * sequence 1..n. Legacy `line` is checked for duplicate/out-of-order diagnostics but is never
 * reused as the normalized cursor.
 */
export function adaptLegacyDesktopRunnerEvents(
  legacyEvents: readonly DesktopAutoRunLogEvent[],
  context: LegacyDesktopRunnerEventContext
): LegacyDesktopRunnerEventAdaptation {
  const events: NormalizedRunnerEvent[] = [];
  const diagnostics: RunnerEventReplayDiagnostic[] = [];
  const seenLines = new Set<number>();
  let previousLine = 0;
  for (let index = 0; index < legacyEvents.length; index += 1) {
    const event = legacyEvents[index];
    if (seenLines.has(event.line)) {
      diagnostics.push({
        code: "duplicate_sequence",
        line: event.line,
        message: `Duplicate legacy line ${event.line}; persisted occurrence order was retained.`
      });
    } else if (event.line <= previousLine) {
      diagnostics.push({
        code: "out_of_order_sequence",
        line: event.line,
        message: `Legacy line ${event.line} follows line ${previousLine}; persisted order was retained.`
      });
    } else if (previousLine > 0 && event.line !== previousLine + 1) {
      diagnostics.push({
        code: "sequence_gap",
        line: event.line,
        message: `Legacy line gap between ${previousLine} and ${event.line}.`
      });
    }
    seenLines.add(event.line);
    previousLine = event.line;
    const raw = {
      version: "planweave.runner-event/v1",
      sequence: index + 1,
      timestamp: event.timestamp ?? new Date(0).toISOString(),
      identity: {
        projectId: context.projectId,
        canvasId: context.canvasId,
        taskId: context.taskId,
        blockId: context.blockId,
        claimRef: context.claimRef,
        runId: event.runId ?? context.executorRunId ?? "legacy-desktop-run",
        runOwner: event.runId ? "desktop" : "executor",
        runSessionId: context.runSessionId,
        desktopRunId: event.runId,
        executorRunId: context.executorRunId
      },
      runner: {
        version: "planweave.runner/v1",
        runnerKind: context.runnerKind,
        agentId: context.agentId
      },
      body: normalizedBody(event)
    };
    events.push(normalizedRunnerEventSchema.parse(raw));
  }
  return { events, diagnostics };
}
