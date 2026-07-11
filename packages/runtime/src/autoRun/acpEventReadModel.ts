import { projectAcpConversation, type AcpConversationItem } from "./acpConversationProjection.js";
import { AcpEventStore, type AcpEventStoreOptions } from "./acpEventStore.js";
import type { AcpEventSubscriber, AcpEventSubscription } from "./acpEventPublisher.js";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";
import {
  replayNormalizedRunnerEvents,
  type RunnerEventCursor,
  type RunnerEventReplayDiagnostic
} from "./runnerEventReplay.js";

export type AcpEventReadSnapshot = {
  events: NormalizedRunnerEvent[];
  conversation: AcpConversationItem[];
  diagnostics: RunnerEventReplayDiagnostic[];
  terminal: boolean;
  cursor: RunnerEventCursor;
};

export class AcpEventReadModel {
  constructor(readonly store: AcpEventStore) {}

  replay(cursor: RunnerEventCursor | number = 0): AcpEventReadSnapshot {
    const replay = replayNormalizedRunnerEvents({
      content: this.store.normalizedContent(),
      runId: this.store.runId,
      canonicalIdentity: this.store.canonicalIdentity(),
      ...(typeof cursor === "number" ? { afterSequence: cursor } : { cursor })
    });
    if (replay.diagnostics.some((diagnostic) => diagnostic.code === "identity_mismatch")) {
      throw new Error("ACP event cursor canonical identity does not match the read model.");
    }
    const storeSnapshot = this.store.snapshot();
    return {
      events: replay.events,
      conversation: projectAcpConversation(replay.events),
      diagnostics: [...storeSnapshot.diagnostics, ...replay.diagnostics],
      terminal: replay.terminal,
      cursor: replay.nextCursor
    };
  }

  subscribe(afterSequence: number, subscriber: AcpEventSubscriber): AcpEventSubscription {
    return this.store.publisher.subscribe(afterSequence, subscriber);
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
