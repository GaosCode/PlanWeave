import type { TaskWorkspaceController } from "./contracts";

export type TaskWorkspacePromptSourceReader = () => {
  generation: number;
  markdown: string | Promise<string | null>;
} | null;

export class TaskWorkspacePromptConflict extends Error {}

type PromptWriter = TaskWorkspaceController["saveTaskPrompt"];
type PromptStatus = "idle" | "saving" | "saved" | "error" | "retired";
type PromptSnapshot = {
  baseline: string;
  draft: string;
  composing: boolean;
  pending: boolean;
  error: TaskWorkspacePromptConflict | string | null;
  status: PromptStatus;
};

export class TaskWorkspacePromptDraft {
  private snapshot: PromptSnapshot;
  private sourceGeneration = -1;
  private readSource: TaskWorkspacePromptSourceReader;
  private pendingSource: string | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAuthority: object | null = null;
  private inFlight: Promise<void> | undefined;
  private requested = false;
  private requestedAuthority: object | null = null;
  private authority: object | null = null;
  private writer: PromptWriter;

  constructor(markdown: string, writer: PromptWriter, readSource: TaskWorkspacePromptSourceReader) {
    this.readSource = readSource;
    this.writer = writer;
    this.snapshot = {
      baseline: markdown,
      draft: markdown,
      composing: false,
      pending: false,
      error: null,
      status: "idle"
    };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<PromptSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  activate(authority: object, writer: PromptWriter, readSource: TaskWorkspacePromptSourceReader) {
    if (this.authority && this.authority !== authority) this.deactivate();
    this.authority = authority;
    this.writer = writer;
    this.readSource = readSource;
  }

  deactivate() {
    this.authority = null;
    this.sourceGeneration = -1;
    this.pendingSource = null;
    this.requested = false;
    this.requestedAuthority = null;
    this.clearTimer();
    if (this.snapshot.draft !== this.snapshot.baseline) this.publish({ status: "retired" });
  }

  canRelease() {
    return (
      this.listeners.size === 0 && !this.inFlight && this.snapshot.draft === this.snapshot.baseline
    );
  }

  private async loadSource(authority: object) {
    const read = this.readSource();
    if (!read) return;
    const { generation } = read;
    if (generation >= this.sourceGeneration) {
      this.sourceGeneration = generation;
      this.pendingSource = null;
    }
    const isCurrent = () => generation === this.sourceGeneration && this.authority === authority;
    let markdown: string | null;
    try {
      markdown = await read.markdown;
    } catch (error: unknown) {
      if (!isCurrent()) return;
      throw error;
    }
    if (!isCurrent() || markdown === null) return;
    this.pendingSource = markdown;
    this.reconcileSource();
  }

  acceptSource(authority: object, generation: number, markdown: string) {
    if (this.authority !== authority || generation <= this.sourceGeneration) return;
    this.sourceGeneration = generation;
    this.pendingSource = markdown;
    this.reconcileSource();
  }

  private reconcileSource(clearError = true) {
    if (
      this.inFlight ||
      this.snapshot.composing ||
      this.snapshot.draft !== this.snapshot.baseline ||
      this.pendingSource === null
    )
      return;
    const markdown = this.pendingSource;
    this.pendingSource = null;
    const error = clearError ? null : this.snapshot.error;
    if (this.snapshot.baseline !== markdown || this.snapshot.error !== error)
      this.publish({ baseline: markdown, draft: markdown, error });
  }

  edit = (draft: string) => {
    this.publish({ draft, error: null, status: this.inFlight ? "saving" : "idle" });
    this.reconcileSource();
    this.schedule();
  };

  setComposing = (composing: boolean) => {
    if (this.snapshot.composing === composing) return;
    this.publish({ composing });
    this.reconcileSource();
    this.schedule();
  };

  private clearTimer(authority?: object) {
    if (authority && this.timerAuthority !== authority) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAuthority = null;
  }

  private schedule() {
    this.clearTimer();
    if (
      !this.authority ||
      this.snapshot.composing ||
      (this.snapshot.draft === this.snapshot.baseline && !this.inFlight)
    )
      return;
    const authority = this.authority;
    this.timerAuthority = authority;
    this.timer = setTimeout(() => {
      if (this.authority === authority) void this.save();
    }, 700);
  }

  save = (): Promise<void> => {
    this.clearTimer();
    if (
      this.snapshot.composing ||
      (this.snapshot.draft === this.snapshot.baseline && !this.inFlight)
    )
      return this.inFlight ?? Promise.resolve();
    this.requested = true;
    this.requestedAuthority = this.authority;
    if (this.inFlight) return this.inFlight;
    if (!this.authority) {
      this.publish({ status: "retired" });
      return Promise.resolve();
    }
    const authority = this.authority;
    this.publish({ pending: true });
    this.inFlight = this.drain(authority).finally(() => {
      this.inFlight = undefined;
      this.reconcileSource(this.snapshot.status !== "error");
      this.publish({ pending: false });
      if (
        this.requested &&
        this.authority &&
        this.authority !== authority &&
        this.requestedAuthority === this.authority
      )
        void this.save();
    });
    return this.inFlight;
  };

  private async drain(authority: object) {
    while (
      this.requested &&
      this.requestedAuthority === authority &&
      this.authority === authority
    ) {
      this.requested = false;
      const { baseline, draft, composing } = this.snapshot;
      if (composing || draft === baseline) return;
      this.publish({ error: null, status: "saving" });
      try {
        const result = await this.writer({ baseMarkdown: baseline, markdown: draft });
        if (result === "retired") {
          if (this.requestedAuthority === authority) this.requested = false;
          if (!this.authority || this.authority === authority) this.publish({ status: "retired" });
          return;
        }
        this.publish({ baseline: draft });
        if (this.authority) {
          try {
            await this.loadSource(this.authority);
          } catch (error: unknown) {
            throw new Error(
              `The prompt was saved, but its current source could not be loaded: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        const dirty = this.snapshot.draft !== draft;
        this.publish({
          status:
            this.authority === authority
              ? dirty
                ? "idle"
                : "saved"
              : this.authority
                ? this.snapshot.status
                : "retired"
        });
      } catch (error: unknown) {
        if (this.requestedAuthority === authority) this.requested = false;
        this.clearTimer(authority);
        if (!this.authority || this.authority === authority) {
          this.publish({
            error:
              error instanceof TaskWorkspacePromptConflict
                ? error
                : error instanceof Error
                  ? error.message
                  : String(error),
            status: this.authority === authority ? "error" : "retired"
          });
        }
        return;
      }
    }
  }
}
