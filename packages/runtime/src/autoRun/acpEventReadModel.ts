import {
  AcpProjectionAccumulator,
  projectAcpConversation,
  type AcpConversationItem,
  type AcpTimelineItem
} from "./acpConversationProjection.js";
import { AcpEventStore, type AcpEventStoreOptions } from "./acpEventStore.js";
import type { AcpEventSubscriber, AcpEventSubscription } from "./acpEventPublisher.js";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";
import { runnerEventCursorSchema, type RunnerEventCursor, type RunnerEventReplayDiagnostic } from "./runnerEventReplay.js";

export type AcpEventReadSnapshot = {
  events: NormalizedRunnerEvent[];
  conversation: AcpConversationItem[];
  diagnostics: RunnerEventReplayDiagnostic[];
  terminal: boolean;
  cursor: RunnerEventCursor;
};

export class AcpEventReadModel {
  private readonly projection = new AcpProjectionAccumulator();
  private readonly interactionEvents: NormalizedRunnerEvent[] = [];
  private readonly sessionIds = new Set<string>();
  private projectedSequence = 0;
  private terminal = false;

  constructor(readonly store: AcpEventStore) {}

  private syncProjection(): void {
    const events = this.store.eventsAfterSequence(this.projectedSequence);
    for (const event of events) {
      this.projection.append(event);
      if (event.body.kind === "interaction") this.interactionEvents.push(event);
      if (event.correlation?.sessionId) this.sessionIds.add(event.correlation.sessionId);
      this.projectedSequence = event.sequence;
      if (event.body.kind === "terminal") this.terminal = true;
    }
  }

  completeProjection(): { conversation: AcpConversationItem[]; timeline: AcpTimelineItem[] } {
    this.syncProjection();
    return this.projection.snapshot();
  }

  interactionEventsSnapshot(): NormalizedRunnerEvent[] {
    this.syncProjection();
    return [...this.interactionEvents];
  }

  knownSessionIds(): ReadonlySet<string> {
    this.syncProjection();
    return new Set(this.sessionIds);
  }

  replay(cursor: RunnerEventCursor | number = 0): AcpEventReadSnapshot {
    this.syncProjection();
    const parsedCursor = typeof cursor === "number" ? null : runnerEventCursorSchema.parse(cursor);
    if (parsedCursor && parsedCursor.runId !== this.store.runId) {
      throw new Error("Runner event cursor runId does not match the requested run.");
    }
    const canonicalIdentity = this.store.canonicalIdentity();
    if (parsedCursor?.canonicalIdentity &&
      JSON.stringify(parsedCursor.canonicalIdentity) !== JSON.stringify(canonicalIdentity)) {
      throw new Error("ACP event cursor canonical identity does not match the read model.");
    }
    const afterSequence = typeof cursor === "number" ? cursor : cursor.afterSequence;
    const events = this.store.eventsAfterSequence(afterSequence);
    const highWaterSequence = Math.max(afterSequence, this.projectedSequence);
    return {
      events,
      conversation: projectAcpConversation(events),
      diagnostics: this.store.diagnosticsSnapshot(),
      terminal: this.terminal || parsedCursor?.terminal === true,
      cursor: {
        version: "planweave.runner-event-cursor/v1",
        runId: this.store.runId,
        afterSequence: highWaterSequence,
        canonicalIdentity,
        terminal: this.terminal || parsedCursor?.terminal === true
      }
    };
  }

  subscribe(
    afterSequence: number,
    subscriber: AcpEventSubscriber,
    options?: { keepOpenAfterTerminal?: boolean }
  ): AcpEventSubscription {
    return this.store.publisher.subscribe(afterSequence, subscriber, options);
  }
}

export class AcpEventReadModelRegistry {
  private readonly models = new Map<string, AcpEventReadModel>();
  constructor(private readonly createStore: (options: AcpEventStoreOptions) => AcpEventStore = (options) => new AcpEventStore(options)) {}

  async create(options: AcpEventStoreOptions): Promise<AcpEventReadModel> {
    if (this.models.has(options.runDir)) throw new Error(`ACP event read model already exists for '${options.runDir}'.`);
    const model = new AcpEventReadModel(this.createStore(options));
    await model.store.open();
    this.models.set(options.runDir, model);
    return model;
  }

  get(runDir: string): AcpEventReadModel | null { return this.models.get(runDir) ?? null; }
  release(runDir: string): boolean { return this.models.delete(runDir); }
}

export const acpEventReadModels = new AcpEventReadModelRegistry();
