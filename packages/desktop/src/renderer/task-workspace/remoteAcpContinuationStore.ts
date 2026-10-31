import type { AcpConversationEvent } from "@planweave-ai/agent-host-protocol/browser";
import { projectRemoteAcpReplay, projectRemoteAcpTelemetry } from "@planweave-ai/runtime/browser";
import type { DesktopRemoteAcpConversationPage } from "../../shared/remoteAcpConversation";

type Turn = DesktopRemoteAcpConversationPage["turns"][number];
type Interaction = {
  turnId: string;
  request: Extract<AcpConversationEvent["payload"], { kind: "interaction" }>["request"];
};
type Replay = ReturnType<typeof projectRemoteAcpReplay>;
type TurnView = Turn & {
  history: "compacted" | "unknown";
  timeline: Replay["timeline"];
  projected: Replay["events"];
};
type TurnProjection = {
  executionAttemptId: string;
  sessionId: string;
  replay: Replay;
  interactions: Interaction[];
  telemetry: ReturnType<typeof projectRemoteAcpTelemetry>;
};
type TurnRecord = {
  events: Map<number, AcpConversationEvent>;
  turn: Turn | null;
  projection: TurnProjection | null;
  view: TurnView | null;
};
export type RemoteAcpContinuationProjection = {
  turns: TurnView[];
  interactions: Interaction[];
  telemetry: ReturnType<typeof projectRemoteAcpTelemetry> | null;
};
type Snapshot = {
  page: DesktopRemoteAcpConversationPage;
  projection: RemoteAcpContinuationProjection;
};

function equalData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalData(value, right[index]))
    );
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const previous = left as Record<string, unknown>;
  const incoming = right as Record<string, unknown>;
  const keys = Object.keys(previous);
  return (
    keys.length === Object.keys(incoming).length &&
    keys.every((key) => Object.hasOwn(incoming, key) && equalData(previous[key], incoming[key]))
  );
}

function equalPageMetadata(
  left: DesktopRemoteAcpConversationPage,
  right: DesktopRemoteAcpConversationPage
) {
  const { events: leftEvents, turns: leftTurns, ...previous } = left;
  const { events: rightEvents, turns: rightTurns, ...incoming } = right;
  void leftEvents;
  void rightEvents;
  void leftTurns;
  void rightTurns;
  return equalData(previous, incoming);
}

export class RemoteAcpContinuationStore {
  readonly compactedTurns = new Set<string>();
  private readonly records = new Map<string, TurnRecord>();
  snapshot: Snapshot | null = null;

  accept(page: DesktopRemoteAcpConversationPage): Snapshot {
    for (const turnId of page.retention?.compactedTurnIds ?? []) {
      if (this.compactedTurns.has(turnId)) continue;
      this.compactedTurns.add(turnId);
      this.records.delete(turnId);
    }
    for (const event of page.events) {
      if (this.compactedTurns.has(event.turnId)) continue;
      const record = this.record(event.turnId);
      if (equalData(record.events.get(event.sequence), event)) continue;
      record.events.set(event.sequence, event);
      record.projection = null;
      record.view = null;
    }
    const previous = this.snapshot;
    let turns = previous?.projection.turns ?? [];
    let turnsChanged = turns.length !== page.turns.length;
    if (turnsChanged) turns = [];
    for (const [index, turn] of page.turns.entries()) {
      const view = this.project(turn);
      if (view === turns[index]) continue;
      if (!turnsChanged) {
        turns = turns.slice();
        turnsChanged = true;
      }
      turns[index] = view;
    }
    if (previous && !turnsChanged && equalPageMetadata(previous.page, page)) return previous;
    let projection = previous?.projection;
    if (!projection || turnsChanged) {
      const interactions: Interaction[] = [];
      let telemetry: RemoteAcpContinuationProjection["telemetry"] = null;
      for (const turn of turns) {
        const record = this.records.get(turn.turnId)!;
        if (turn.projected.length) telemetry = record.projection!.telemetry;
        if (turn.status === "queued" || turn.status === "running")
          interactions.push(...record.projection!.interactions);
      }
      projection = { turns, interactions, telemetry };
    }
    this.snapshot = { page: { ...page, events: [] }, projection };
    return this.snapshot;
  }

  private record(turnId: string): TurnRecord {
    let record = this.records.get(turnId);
    if (!record) {
      record = { events: new Map(), turn: null, projection: null, view: null };
      this.records.set(turnId, record);
    }
    return record;
  }

  private project(turn: Turn): TurnView {
    const record = this.record(turn.turnId);
    if (
      !record.projection ||
      record.projection.executionAttemptId !== turn.executionAttemptId ||
      record.projection.sessionId !== turn.sessionId
    ) {
      const pending = new Map<string, Interaction>();
      const events = [];
      for (const event of record.events.values()) {
        const payload = event.payload;
        if (payload.kind === "interaction")
          pending.set(payload.request.requestId, { turnId: turn.turnId, request: payload.request });
        if (payload.kind === "interaction_settled") pending.delete(payload.requestId);
        if (payload.kind === "runner")
          events.push({
            eventVersion: 2 as const,
            cursor: event.sequence,
            sourceSequence: event.sequence,
            timestamp: event.timestamp,
            fragment: payload.fragment
          });
      }
      const replay = projectRemoteAcpReplay({
        executionAttemptId: turn.executionAttemptId,
        eventProtocolVersion: 2,
        events
      });
      record.projection = {
        executionAttemptId: turn.executionAttemptId,
        sessionId: turn.sessionId,
        replay,
        interactions: [...pending.values()],
        telemetry: projectRemoteAcpTelemetry(replay.events)
      };
      record.view = null;
    }
    if (!record.view || !equalData(record.turn, turn)) {
      record.turn = turn;
      record.view = {
        ...turn,
        history: this.compactedTurns.has(turn.turnId) ? "compacted" : "unknown",
        timeline: record.projection.replay.timeline,
        projected: record.projection.replay.events
      };
    }
    return record.view;
  }
}
