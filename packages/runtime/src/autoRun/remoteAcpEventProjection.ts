import type {
  NormalizedAcpEvent,
  RemoteRunnerEventV2
} from "@planweave-ai/agent-host-protocol/browser";
import {
  normalizedOutputBody,
  normalizedRedactedContent,
  normalizedRunnerEventSchema,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import { projectAcpTimeline, type AcpTimelineItem } from "./acpConversationProjection.js";
import { redactRunnerEventText } from "./runnerEventRedaction.js";

export type RemoteAcpReplayDiagnostic =
  | { code: "remote_acp_event_contract_degraded" }
  | { code: "remote_acp_event_retention_gap"; droppedThroughCursor: number };

type RemoteAcpRetentionDiagnostic = Extract<
  RemoteAcpReplayDiagnostic,
  { code: "remote_acp_event_retention_gap" }
>;

export type RemoteAcpReplayInput = {
  executionAttemptId: string;
} & (
  | {
      eventProtocolVersion: 1;
      events: readonly NormalizedAcpEvent[];
      diagnostics?: readonly RemoteAcpReplayDiagnostic[];
    }
  | {
      eventProtocolVersion: 2;
      events: readonly RemoteRunnerEventV2[];
      diagnostics?: readonly RemoteAcpRetentionDiagnostic[];
    }
);

export type ProjectedRemoteAcpEvent = {
  eventProtocolVersion: 1 | 2;
  executionAttemptId: string;
  cursor: number;
  sourceSequence: number;
  timestamp: string;
  kind: string;
  summary: string | null;
  body: NormalizedRunnerEvent["body"];
  engineEvidence:
    | Extract<RemoteRunnerEventV2["fragment"], { kind: "engine_evidence" }>["evidence"]
    | null;
  engineTerminal:
    | Extract<RemoteRunnerEventV2["fragment"], { kind: "engine_terminal" }>["terminal"]
    | null;
};

export type RemoteAcpReplayProjection = {
  eventProtocolVersion: 1 | 2;
  executionAttemptId: string;
  degraded: boolean;
  diagnostics: RemoteAcpReplayDiagnostic[];
  events: ProjectedRemoteAcpEvent[];
  timeline: AcpTimelineItem[];
};

export function mergeRemoteAcpReplayDiagnostics(
  current: readonly RemoteAcpReplayDiagnostic[],
  incoming: readonly RemoteAcpReplayDiagnostic[]
): RemoteAcpReplayDiagnostic[] {
  const diagnostics = new Map(current.map((diagnostic) => [diagnostic.code, diagnostic]));
  for (const diagnostic of incoming) diagnostics.set(diagnostic.code, diagnostic);
  return [...diagnostics.values()];
}

export function remoteAcpEventBody(
  event: NormalizedAcpEvent | RemoteRunnerEventV2,
  seenToolCalls: Set<string>
): NormalizedRunnerEvent["body"] {
  if ("eventVersion" in event) {
    const fragment = event.fragment;
    if (fragment.kind === "runner_body") {
      return normalizedRunnerEventSchema.shape.body.parse(fragment.body);
    }
    if (fragment.kind === "engine_terminal") {
      return {
        kind: "diagnostic",
        code: "remote_engine_terminal",
        message: `Remote engine terminal evidence: ${fragment.terminal.state}.`
      };
    }
    const evidence = fragment.evidence;
    switch (evidence.kind) {
      case "lifecycle":
        return evidence.state === "connecting"
          ? { kind: "lifecycle", state: "initializing", message: "Remote ACP engine connecting." }
          : evidence.state === "running"
            ? { kind: "lifecycle", state: "running", message: "Remote ACP engine running." }
            : {
                kind: "diagnostic",
                code: "remote_engine_cleanup",
                message: "Remote ACP engine cleanup observed."
              };
      case "session_started":
        return {
          kind: "diagnostic",
          code: "remote_session_identity",
          message: `Remote ACP session ${evidence.sessionId} started.`
        };
      case "usage_snapshot":
        return {
          kind: "diagnostic",
          code: "remote_usage_snapshot",
          message: `Remote cumulative token usage: ${evidence.usage.totalTokens}.`
        };
      case "interaction":
        return {
          kind: "diagnostic",
          code: "remote_engine_interaction",
          message: `Remote ${evidence.interaction} interaction ${evidence.state}.`
        };
      case "capability_snapshot":
      case "capabilities":
        return {
          kind: "diagnostic",
          code: "remote_engine_capability",
          message: "Remote ACP engine capability evidence observed."
        };
    }
  }
  switch (event.kind) {
    case "agent_message": {
      // Remote ACP streams as many agent_message events; mark chunks so the canonical
      // conversation projector coalesces them instead of rendering one line per token.
      const content = normalizedRedactedContent(event.text);
      return { kind: "message", role: "assistant", messageId: null, chunk: true, ...content };
    }
    case "plan": {
      const content = normalizedRedactedContent(event.text);
      return { kind: "plan_update", ...content };
    }
    case "diagnostic":
      return normalizedOutputBody(event.severity === "error" ? "stderr" : "stdout", event.message);
    case "tool_call": {
      const callId = event.callId ?? `remote-tool-${event.cursor}`;
      const status = event.status === "running" ? "in_progress" : event.status;
      const title = redactRunnerEventText(event.title).text;
      if (seenToolCalls.has(callId)) {
        return { kind: "tool_update", callId, status, title, content: null };
      }
      seenToolCalls.add(callId);
      return { kind: "tool_call", callId, status, title, content: null };
    }
  }
}

function projectedEventKind(event: NormalizedAcpEvent | RemoteRunnerEventV2): string {
  if (!("eventVersion" in event)) return event.kind;
  if (event.fragment.kind === "runner_body") return event.fragment.body.kind;
  if (event.fragment.kind === "engine_terminal") return "engine_terminal";
  return `engine_${event.fragment.evidence.kind}`;
}

function projectedEventSummary(
  event: NormalizedAcpEvent | RemoteRunnerEventV2,
  body: NormalizedRunnerEvent["body"]
): string | null {
  if (!("eventVersion" in event)) {
    switch (event.kind) {
      case "agent_message":
      case "plan":
        return event.text;
      case "tool_call":
        return event.title;
      case "diagnostic":
        return event.message;
    }
  }
  switch (body.kind) {
    case "message":
    case "plan_update":
    case "output":
    case "terminal_output":
      return body.content;
    case "tool_call":
    case "tool_update":
      return body.title ?? body.content?.content ?? null;
    case "diagnostic":
    case "lifecycle":
      return body.message;
    case "usage_update":
      return `Used tokens: ${body.usedTokens}.`;
    case "session_configuration_snapshot":
      return `Session configuration ${body.phase}.`;
    case "session_mode_update":
      return body.currentModeId;
    case "session_config_options_update":
      return `Session configuration options: ${body.configOptions.length}.`;
    case "interaction":
      return body.interaction.summary;
    case "interaction_result":
      return body.message;
    case "artifact":
      return body.artifact.relativePath;
    case "terminal":
      return body.outcome.diagnostic ?? body.outcome.state;
  }
}

function normalizedRemoteEvent(
  event: NormalizedAcpEvent | RemoteRunnerEventV2,
  executionAttemptId: string,
  seenToolCalls: Set<string>
): { projected: ProjectedRemoteAcpEvent; normalized: NormalizedRunnerEvent } {
  const body = remoteAcpEventBody(event, seenToolCalls);
  const eventProtocolVersion = "eventVersion" in event ? 2 : 1;
  const timestamp = "timestamp" in event ? event.timestamp : new Date(0).toISOString();
  const sourceSequence = "sourceSequence" in event ? event.sourceSequence : event.cursor;
  const normalized = normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence: event.cursor,
    timestamp,
    identity: {
      projectId: "remote",
      canvasId: "remote",
      taskId: "remote",
      blockId: "remote",
      claimRef: "remote#remote",
      runId: executionAttemptId,
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: executionAttemptId
    },
    runner: {
      version: "planweave.runner/v1",
      runnerKind: "acp",
      agentId: "codex"
    },
    body
  });
  return {
    normalized,
    projected: {
      eventProtocolVersion,
      executionAttemptId,
      cursor: event.cursor,
      sourceSequence,
      timestamp,
      kind: projectedEventKind(event),
      summary: projectedEventSummary(event, body),
      body,
      engineEvidence:
        "eventVersion" in event && event.fragment.kind === "engine_evidence"
          ? event.fragment.evidence
          : null,
      engineTerminal:
        "eventVersion" in event && event.fragment.kind === "engine_terminal"
          ? event.fragment.terminal
          : null
    }
  };
}

export function projectRemoteAcpReplay(input: RemoteAcpReplayInput): RemoteAcpReplayProjection {
  const seenToolCalls = new Set<string>();
  const diagnostics = input.diagnostics ?? [];
  const projected = input.events.map((event) =>
    normalizedRemoteEvent(event, input.executionAttemptId, seenToolCalls)
  );
  const events = projected.map((event) => event.projected);
  return {
    eventProtocolVersion: input.eventProtocolVersion,
    executionAttemptId: input.executionAttemptId,
    degraded: diagnostics.some(
      (diagnostic) => diagnostic.code === "remote_acp_event_contract_degraded"
    ),
    diagnostics: [...diagnostics],
    events,
    timeline: projectRemoteAcpProjectedTimeline(events)
  };
}

export function projectRemoteAcpProjectedTimeline(
  events: readonly ProjectedRemoteAcpEvent[]
): AcpTimelineItem[] {
  const seenToolCalls = new Set<string>();
  return projectAcpTimeline(
    events.map((event) => {
      let body = event.body;
      if (body.kind === "tool_call") {
        if (seenToolCalls.has(body.callId)) {
          body = {
            kind: "tool_update",
            callId: body.callId,
            status: body.status,
            title: body.title,
            content: body.content
          };
        } else seenToolCalls.add(body.callId);
      }
      if (
        body.kind !== "message" &&
        body.kind !== "tool_call" &&
        body.kind !== "tool_update" &&
        body.kind !== "plan_update" &&
        body.kind !== "artifact" &&
        body.kind !== "output" &&
        body.kind !== "terminal_output"
      ) {
        body = normalizedOutputBody("stdout", event.summary ?? event.kind);
      }
      return normalizedRunnerEventSchema.parse({
        version: "planweave.runner-event/v1",
        sequence: event.cursor,
        timestamp: event.timestamp,
        identity: {
          projectId: "remote",
          canvasId: "remote",
          taskId: "remote",
          blockId: "remote",
          claimRef: "remote#remote",
          runId: event.executionAttemptId,
          runOwner: "executor",
          runSessionId: null,
          desktopRunId: null,
          executorRunId: event.executionAttemptId
        },
        runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
        body
      });
    })
  );
}

export function projectRemoteAcpTimeline(
  events: readonly (NormalizedAcpEvent | RemoteRunnerEventV2)[]
): AcpTimelineItem[] {
  const seenToolCalls = new Set<string>();
  return projectAcpTimeline(
    events.map((event) => normalizedRemoteEvent(event, "remote", seenToolCalls).normalized)
  );
}
