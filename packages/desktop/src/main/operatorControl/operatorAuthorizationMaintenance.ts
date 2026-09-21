/** Bounded background rounds; foreground requests never consume these worker slots. */
export class OperatorAuthorizationMaintenance {
  private started = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: {
      profiles(): Promise<string[]>;
      check(profileId: string): Promise<void>;
      onError(error: unknown): void;
    }
  ) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(1_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.round()
        .catch((error) => {
          if (!this.stopped) this.options.onError(error);
        })
        .finally(() => {
          if (!this.stopped) this.schedule(5 * 60_000);
        });
    }, delay);
    this.timer.unref();
  }

  private async round(): Promise<void> {
    const profiles = await this.options.profiles();
    let cursor = 0;
    const worker = async () => {
      while (!this.stopped && cursor < profiles.length) {
        const profileId = profiles[cursor++];
        try {
          await this.options.check(profileId);
        } catch (error) {
          if (!this.stopped) this.options.onError(error);
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }
}
