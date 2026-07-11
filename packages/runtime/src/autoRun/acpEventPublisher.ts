import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

export type AcpEventSubscription = { unsubscribe(): void; closed: Promise<void> };
export type AcpEventSubscriber = (event: NormalizedRunnerEvent) => void | Promise<void>;
export type AcpEventPublisherDiagnosticSink = (
  code: "subscriber_backpressure" | "subscriber_callback_failed",
  message: string
) => void | Promise<void>;

type Subscriber = { after: number; pending: number; closed: boolean; resolve: () => void; chain: Promise<void>; receive: AcpEventSubscriber };

export class AcpEventPublisher {
  private readonly events: NormalizedRunnerEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private terminal = false;
  readonly diagnostics: Array<{ code: "subscriber_backpressure" | "subscriber_callback_failed"; message: string }> = [];
  private diagnosticSink: AcpEventPublisherDiagnosticSink | null;
  private diagnosticChain = Promise.resolve();
  constructor(
    private readonly maxPendingPerSubscriber = 256,
    diagnosticSink?: AcpEventPublisherDiagnosticSink
  ) { this.diagnosticSink = diagnosticSink ?? null; }

  setDiagnosticSink(sink: AcpEventPublisherDiagnosticSink): void {
    const previous = this.diagnosticSink;
    this.diagnosticSink = previous
      ? async (code, message) => { await previous(code, message); await sink(code, message); }
      : sink;
  }

  seed(events: readonly NormalizedRunnerEvent[]): void {
    if (this.events.length > 0) throw new Error("ACP event publisher can only be seeded once.");
    this.events.push(...events);
    this.terminal = events.some((event) => event.body.kind === "terminal");
  }

  publish(event: NormalizedRunnerEvent): void {
    const previous = this.events.at(-1);
    if (previous && event.sequence <= previous.sequence) return;
    this.events.push(event);
    for (const subscriber of this.subscribers) this.enqueue(subscriber, event);
    if (event.body.kind === "terminal") {
      this.terminal = true;
      this.closeAll();
    }
  }

  subscribe(afterSequence: number, receive: AcpEventSubscriber): AcpEventSubscription {
    let resolve = (): void => undefined;
    const closed = new Promise<void>((done) => { resolve = done; });
    const subscriber: Subscriber = { after: afterSequence, pending: 0, closed: false, resolve, chain: Promise.resolve(), receive };
    this.subscribers.add(subscriber);
    for (const event of this.events) if (event.sequence > afterSequence) this.enqueue(subscriber, event);
    if (this.terminal) this.close(subscriber);
    return { unsubscribe: () => this.close(subscriber), closed };
  }

  private enqueue(subscriber: Subscriber, event: NormalizedRunnerEvent): void {
    if (subscriber.closed || event.sequence <= subscriber.after) return;
    if (subscriber.pending >= this.maxPendingPerSubscriber) {
      this.close(subscriber);
      this.reportDiagnostic("subscriber_backpressure", `Subscriber exceeded ${this.maxPendingPerSubscriber} pending events and was unsubscribed.`);
      return;
    }
    subscriber.after = event.sequence;
    subscriber.pending += 1;
    subscriber.chain = subscriber.chain
      .then(() => subscriber.receive(event))
      .catch((error: unknown) => {
        this.close(subscriber);
        this.reportDiagnostic(
          "subscriber_callback_failed",
          `Subscriber callback failed: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => { subscriber.pending -= 1; });
  }

  private close(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.subscribers.delete(subscriber);
    void subscriber.chain.finally(subscriber.resolve);
  }

  private closeAll(): void { for (const subscriber of [...this.subscribers]) this.close(subscriber); }
  private reportDiagnostic(code: "subscriber_backpressure" | "subscriber_callback_failed", message: string): void {
    this.diagnostics.push({ code, message });
    if (!this.diagnosticSink) return;
    this.diagnosticChain = this.diagnosticChain.then(() => this.diagnosticSink?.(code, message)).then(() => undefined);
  }
  async drainDiagnostics(): Promise<void> { await this.diagnosticChain; }
  get subscriberCount(): number { return this.subscribers.size; }
}
