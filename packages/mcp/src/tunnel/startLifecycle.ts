/** Owns startup work until all cancellation continuations have settled. */
export class StartLifecycle<T> {
  private pending: Promise<T> | null = null;
  private stopping: Promise<T> | null = null;
  private controller: AbortController | null = null;

  start(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping) return this.stopping.then(() => this.start(work));
    if (this.pending) return this.pending;
    const controller = new AbortController();
    this.controller = controller;
    const pending = work(controller.signal).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  stop(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return this.stopping;
    this.controller?.abort();
    const pending = this.pending;
    const stopping = (async () => {
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        failure = error;
      }
      const result = await work();
      if (failure !== undefined) throw failure;
      return result;
    })().finally(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  owns(signal: AbortSignal): boolean {
    return this.controller?.signal === signal && !signal.aborted;
  }
}
