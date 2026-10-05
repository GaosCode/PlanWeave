import type {
  CommentDisplayProjection,
  CommentListCursor,
  CommentListPage
} from "@planweave-ai/collaboration-protocol/activity/comments";

export type CommentPaginationSnapshot = {
  items: CommentDisplayProjection[];
  nextCursor: CommentListCursor | null;
  loading: boolean;
  loadingMore: boolean;
};

export function emptyCommentPaginationSnapshot(): CommentPaginationSnapshot {
  return { items: [], nextCursor: null, loading: false, loadingMore: false };
}

function compareOrder(left: CommentDisplayProjection, right: CommentDisplayProjection): number {
  const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (time !== 0) return time;
  return left.commentId === right.commentId ? 0 : left.commentId < right.commentId ? -1 : 1;
}

/** One open thread's raw page range; the Server owns keyset cursors and tombstone slots. */
export class CommentPaginationSession {
  private snapshot = emptyCommentPaginationSnapshot();
  private rawItems: CommentDisplayProjection[] = [];
  private readonly confirmed = new Map<string, CommentDisplayProjection>();
  private pageDepth = 0;
  private requestedDepth = 1;
  private dirtyVersion: number;
  private appliedVersion: number;
  private resetRequested = false;
  private started = false;
  private retired = false;
  private generation = 0;
  private requestIdentity = 0;
  private active: Promise<void> | null = null;

  constructor(
    private readonly options: {
      initialVersion: number;
      listPage(cursor?: CommentListCursor): Promise<CommentListPage>;
      onChange(snapshot: CommentPaginationSnapshot): void;
      onError(error: unknown): void;
      onRequestStart(): void;
    }
  ) {
    this.dirtyVersion = options.initialVersion;
    this.appliedVersion = options.initialVersion;
  }

  start(): Promise<void> {
    this.started = true;
    return this.drain();
  }

  invalidate(version: number): Promise<void> {
    if (version <= this.dirtyVersion || this.retired) return this.active ?? Promise.resolve();
    this.dirtyVersion = version;
    return this.started ? this.drain() : Promise.resolve();
  }

  loadMore(): Promise<void> {
    if (this.retired || this.snapshot.nextCursor === null) return this.active ?? Promise.resolve();
    this.requestedDepth = Math.max(this.requestedDepth, this.pageDepth + 1);
    return this.drain();
  }

  refresh(): Promise<void> {
    if (this.retired) return Promise.resolve();
    this.generation += 1;
    this.requestIdentity += 1;
    this.resetRequested = true;
    this.requestedDepth = 1;
    this.started = true;
    return this.drain();
  }

  confirm(projection: CommentDisplayProjection): void {
    if (this.retired) return;
    const previous = this.confirmed.get(projection.commentId);
    if (!previous || projection.revision >= previous.revision) {
      this.confirmed.set(projection.commentId, projection);
    }
    this.publish(this.rawItems, this.snapshot.nextCursor);
  }

  dispose(): void {
    this.retired = true;
    this.generation += 1;
    this.requestIdentity += 1;
  }

  private needsWork(): boolean {
    return (
      !this.retired &&
      this.started &&
      (this.resetRequested ||
        this.pageDepth === 0 ||
        this.dirtyVersion > this.appliedVersion ||
        (this.requestedDepth > this.pageDepth && this.snapshot.nextCursor !== null))
    );
  }

  private drain(): Promise<void> {
    if (this.retired || !this.started) return Promise.resolve();
    if (this.active) return this.active;
    // Install the flight before callbacks can synchronously request another operation.
    const completion = Promise.resolve().then(() => this.run());
    this.active = completion.finally(() => {
      this.active = null;
    });
    return this.active;
  }

  private async run(): Promise<void> {
    try {
      while (this.needsWork()) {
        const generation = this.generation;
        const request = ++this.requestIdentity;
        const current = () =>
          !this.retired && generation === this.generation && request === this.requestIdentity;
        const version = this.dirtyVersion;
        const reset = this.resetRequested;
        this.resetRequested = false;
        const replace = reset || this.pageDepth === 0 || version > this.appliedVersion;
        const limit =
          reset || this.pageDepth === 0
            ? 1
            : this.pageDepth + (this.snapshot.nextCursor === null ? 1 : 0);
        this.snapshot = { ...this.snapshot, loading: replace, loadingMore: !replace };
        this.options.onRequestStart();
        this.options.onChange(this.snapshot);
        try {
          let items: CommentDisplayProjection[];
          let cursor: CommentListCursor | null;
          let depth: number;
          if (replace) {
            items = [];
            cursor = null;
            depth = 0;
            for (let pageIndex = 0; pageIndex < limit; pageIndex += 1) {
              const page = await this.options.listPage(cursor ?? undefined);
              if (!current()) break;
              items.push(...page.items);
              cursor = page.nextCursor;
              depth += 1;
              if (cursor === null) break;
            }
          } else {
            const page = await this.options.listPage(this.snapshot.nextCursor ?? undefined);
            items = [...this.rawItems, ...page.items];
            cursor = page.nextCursor;
            depth = this.pageDepth + 1;
          }
          if (!current()) continue;
          this.pageDepth = depth;
          this.appliedVersion = version;
          this.requestedDepth = cursor === null ? depth : Math.max(this.requestedDepth, depth);
          this.publish(items, cursor);
        } catch (error) {
          if (!current()) continue;
          this.options.onError(error);
          break;
        }
      }
    } finally {
      if (!this.retired) {
        this.snapshot = { ...this.snapshot, loading: false, loadingMore: false };
        this.options.onChange(this.snapshot);
      }
    }
  }

  private publish(items: CommentDisplayProjection[], cursor: CommentListCursor | null): void {
    const existing = new Map(this.snapshot.items.map((item) => [item.commentId, item]));
    const raw = new Map<string, CommentDisplayProjection>();
    for (const item of items) {
      const known = raw.get(item.commentId) ?? existing.get(item.commentId);
      raw.set(item.commentId, known && known.revision > item.revision ? known : item);
    }
    this.rawItems = [...raw.values()].sort(compareOrder);
    const visible = new Map(raw);
    for (const [id, confirmed] of this.confirmed) {
      const loaded = raw.get(id);
      if (loaded && loaded.revision >= confirmed.revision) {
        this.confirmed.delete(id);
      } else {
        visible.set(id, confirmed);
      }
    }
    this.snapshot = {
      ...this.snapshot,
      items: [...visible.values()].sort(compareOrder),
      nextCursor: cursor
    };
    this.options.onChange(this.snapshot);
  }
}
