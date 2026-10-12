import type { AuthoritativeRefreshResult } from "./CollaborationReadModelController.js";

/** Serializes one generation and retires callers without waiting for its transport requests. */
export class AuthoritativeRefreshQueue {
  private retired = false;
  private releaseRetired!: (result: AuthoritativeRefreshResult) => void;
  private readonly retirement = new Promise<AuthoritativeRefreshResult>((resolve) => {
    this.releaseRetired = resolve;
  });
  private tail: Promise<AuthoritativeRefreshResult> = Promise.resolve({ status: "retired" });

  enqueue(action: () => Promise<AuthoritativeRefreshResult>): Promise<AuthoritativeRefreshResult> {
    const work = this.tail
      .catch(() => undefined)
      .then<AuthoritativeRefreshResult>(() => (this.retired ? { status: "retired" } : action()));
    // Promise.race retains rejection handlers for transport work that outlives retirement.
    this.tail = Promise.race([work, this.retirement]);
    return this.tail;
  }

  retire(): void {
    this.retired = true;
    this.releaseRetired({ status: "retired" });
  }
}
