import type { AttachmentMaintenanceCursor, CommentAttachmentService } from "./service.js";

export const COMMENT_ATTACHMENT_MAINTENANCE_INTERVAL_MS = 60_000;
export const COMMENT_ATTACHMENT_MAINTENANCE_MAX_BACKOFF_MS = 300_000;
export const COMMENT_ATTACHMENT_MAINTENANCE_CANDIDATE_LIMIT = 100;

/** Two keyset pages share a fixed candidate/physical-delete budget and one in-flight sweep. */
export class CommentAttachmentMaintenance {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private cursor: AttachmentMaintenanceCursor = {};
  private delay = COMMENT_ATTACHMENT_MAINTENANCE_INTERVAL_MS;
  private failure: { error: unknown } | undefined;
  private stopped = false;
  private readonly cancellation = new AbortController();

  constructor(private readonly attachments: CommentAttachmentService) {}

  start(): void {
    if (!this.stopped && !this.timer && !this.running) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.cancellation.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async close(): Promise<void> {
    this.stop();
    await this.running;
    if (this.failure) throw this.failure.error;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.sweep().finally(() => {
        this.running = undefined;
        this.schedule();
      });
    }, this.delay);
    this.timer.unref?.();
  }

  private async sweep(): Promise<void> {
    try {
      const result = await this.attachments.cleanupMaintenanceBatch(
        this.cursor,
        COMMENT_ATTACHMENT_MAINTENANCE_CANDIDATE_LIMIT,
        this.cancellation.signal
      );
      this.cursor = result.cursor;
      if (result.failures.length) {
        for (const failure of result.failures) this.report(failure.phase, failure.error);
        this.failure = {
          error: new AggregateError(
            result.failures.map((failure) => failure.error),
            "comment_attachment_maintenance_failed"
          )
        };
        this.delay = Math.min(this.delay * 2, COMMENT_ATTACHMENT_MAINTENANCE_MAX_BACKOFF_MS);
      } else {
        this.failure = undefined;
        this.delay = COMMENT_ATTACHMENT_MAINTENANCE_INTERVAL_MS;
      }
    } catch (error) {
      this.report("scan", error);
      this.failure = { error };
      this.delay = Math.min(this.delay * 2, COMMENT_ATTACHMENT_MAINTENANCE_MAX_BACKOFF_MS);
    }
  }

  private report(phase: string, error: unknown): void {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Za-z_]{1,64}$/.test(error.code)
        ? error.code
        : "unavailable";
    console.error("comment_attachment_maintenance_failed", {
      phase,
      code,
      errorName: error instanceof Error ? error.name : "unknown"
    });
  }
}
