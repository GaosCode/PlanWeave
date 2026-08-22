import type { CollaborationPresenceSession } from "./collaborationPresenceSession.js";

export type CollaborationCanvasRealtimeFacadeOptions = {
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>;
  assertOpen: () => void;
  presence: CollaborationPresenceSession;
};

/** Queue-aware facade for ephemeral canvas presence. */
export class CollaborationCanvasRealtimeFacade {
  constructor(private readonly options: CollaborationCanvasRealtimeFacadeOptions) {}

  startPresence(input: unknown): Promise<void> {
    return this.run(() => this.options.presence.start(input));
  }

  stopPresence(): Promise<void> {
    return this.run(() => this.options.presence.stop());
  }

  publishPresence(input: unknown): Promise<void> {
    return this.run(() => this.options.presence.publish(input));
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      return operation();
    });
  }
}
