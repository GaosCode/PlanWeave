type QueueEntry<T> = {
  value: T;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class CollaborationObserverQueue<T> {
  private readonly queue: QueueEntry<T>[] = [];
  private readonly running = new Set<QueueEntry<T>>();
  private readonly queuedKeys = new Set<number>();
  private activeCount = 0;
  private retired = false;

  constructor(
    private readonly options: {
      concurrency: number;
      queueLimit: number;
      key(value: T): number;
      isCurrent(value: T): boolean;
      execute(value: T): Promise<void>;
    }
  ) {}

  hasQueued(key: number): boolean {
    return this.queuedKeys.has(key);
  }

  enqueue(value: T): Promise<void> | null {
    if (this.retired) return Promise.resolve();
    if (this.queue.length >= this.options.queueLimit) return null;
    const key = this.options.key(value);
    this.queuedKeys.add(key);
    const queued = new Promise<void>((resolve, reject) => {
      this.queue.push({ value, resolve, reject });
    });
    this.pump();
    return queued;
  }

  retire(): void {
    this.retired = true;
    for (const entry of this.queue.splice(0)) {
      entry.resolve();
    }
    this.queuedKeys.clear();
    for (const entry of this.running) entry.resolve();
  }

  private pump(): void {
    while (!this.retired && this.activeCount < this.options.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.queuedKeys.delete(this.options.key(entry.value));
      if (!this.options.isCurrent(entry.value)) {
        entry.resolve();
        continue;
      }
      this.activeCount += 1;
      this.running.add(entry);
      void this.options
        .execute(entry.value)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.running.delete(entry);
          this.activeCount -= 1;
          this.pump();
        });
    }
  }
}
