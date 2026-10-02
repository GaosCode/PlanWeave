export type CanvasRuntimeActiveRequest = { controller: AbortController; committed: boolean };

type RuntimeWork = { active: CanvasRuntimeActiveRequest; completion: Promise<void> };

export class CanvasRuntimeLifecycle {
  private readonly work = new Map<string | symbol, RuntimeWork>();
  private readonly failures: unknown[] = [];
  private accepting = true;
  private stopping: Promise<void> | undefined;

  start(): void {
    if (this.work.size > 0) throw new Error("canvas_runtime_shutdown_pending");
    if (this.failures.length > 0) {
      throw new AggregateError(this.failures, "canvas_runtime_persistence_failed");
    }
    this.stopping = undefined;
    this.accepting = true;
  }

  get(requestId: string): CanvasRuntimeActiveRequest | undefined {
    return this.work.get(requestId)?.active;
  }

  run(
    key: string | symbol,
    operation: (active: CanvasRuntimeActiveRequest) => Promise<void>
  ): Promise<void> {
    const existing = this.work.get(key);
    if (existing) return existing.completion;
    if (!this.accepting) return Promise.reject(new Error("canvas_runtime_stopped"));
    const active = { controller: new AbortController(), committed: false };
    const completion = Promise.resolve().then(() => operation(active));
    this.work.set(key, { active, completion });
    void completion.then(
      () => this.work.delete(key),
      (error: unknown) => {
        this.failures.push(error);
        this.work.delete(key);
      }
    );
    return completion;
  }

  disconnect(): void {
    for (const { active } of this.work.values()) active.controller.abort("host_disconnected");
  }

  stop(): Promise<void> {
    this.accepting = false;
    this.disconnect();
    this.stopping ??= (async () => {
      while (this.work.size > 0) {
        await Promise.allSettled([...this.work.values()].map(({ completion }) => completion));
      }
      if (this.failures.length > 0) {
        throw new AggregateError(this.failures, "canvas_runtime_persistence_failed");
      }
    })();
    return this.stopping;
  }
}
