import { z } from "zod";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

const CLOSE_MESSAGE_MAX_LENGTH = 512;

export const acpEventSubscriptionCloseReasonSchema = z.enum([
  "terminal",
  "explicit_unsubscribe",
  "subscriber_backpressure",
  "subscriber_callback_failed",
  "owner_disposed",
  "not_subscribable"
]);
export type AcpEventSubscriptionCloseReason = z.infer<typeof acpEventSubscriptionCloseReasonSchema>;

/** Single source of truth: which close reasons may reconnect. */
const CLOSE_REASON_RECOVERABLE: Record<AcpEventSubscriptionCloseReason, boolean> = {
  terminal: false,
  explicit_unsubscribe: false,
  subscriber_backpressure: true,
  subscriber_callback_failed: true,
  owner_disposed: false,
  not_subscribable: false
};

const CLOSE_REASON_DEFAULT_MESSAGE: Record<AcpEventSubscriptionCloseReason, string> = {
  terminal: "ACP event subscription closed after terminal event.",
  explicit_unsubscribe: "ACP event subscription was unsubscribed.",
  subscriber_backpressure: "ACP event subscriber exceeded pending capacity and was closed.",
  subscriber_callback_failed: "ACP event subscriber callback failed and was closed.",
  owner_disposed: "ACP event subscription owner was disposed.",
  not_subscribable: "Runner record is not live-subscribable."
};

export const acpEventSubscriptionCloseResultSchema = z
  .object({
    reason: acpEventSubscriptionCloseReasonSchema,
    lastSequence: z.number().int().nonnegative(),
    recoverable: z.boolean(),
    message: z.string().max(CLOSE_MESSAGE_MAX_LENGTH)
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = CLOSE_REASON_RECOVERABLE[value.reason];
    if (value.recoverable !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recoverable"],
        message: `recoverable must be ${String(expected)} for reason "${value.reason}"`
      });
    }
  });
export type AcpEventSubscriptionCloseResult = z.infer<typeof acpEventSubscriptionCloseResultSchema>;

export type AcpEventSubscription = {
  unsubscribe(): void;
  closed: Promise<AcpEventSubscriptionCloseResult>;
};
export type AcpEventSubscriber = (event: NormalizedRunnerEvent) => void | Promise<void>;
export type AcpEventPublisherDiagnosticSink = (
  code: "subscriber_backpressure" | "subscriber_callback_failed",
  message: string
) => void | Promise<void>;

type AcpEventPublisherDiagnostic = {
  code: "subscriber_backpressure" | "subscriber_callback_failed" | "diagnostic_sink_failed";
  message: string;
};

type Subscriber = {
  after: number;
  pending: number;
  closed: boolean;
  closeOnTerminal: boolean;
  resolve: (result: AcpEventSubscriptionCloseResult) => void;
  chain: Promise<void>;
  receive: AcpEventSubscriber;
  closeResult: AcpEventSubscriptionCloseResult | null;
};

export function acpEventSubscriptionCloseRecoverable(
  reason: AcpEventSubscriptionCloseReason
): boolean {
  return CLOSE_REASON_RECOVERABLE[reason];
}

export function createAcpEventSubscriptionCloseResult(
  reason: AcpEventSubscriptionCloseReason,
  lastSequence: number,
  message?: string
): AcpEventSubscriptionCloseResult {
  const safeSequence = Number.isFinite(lastSequence) && lastSequence >= 0 ? Math.floor(lastSequence) : 0;
  const rawMessage =
    message && message.trim().length > 0
      ? message.trim()
      : CLOSE_REASON_DEFAULT_MESSAGE[reason];
  return acpEventSubscriptionCloseResultSchema.parse({
    reason,
    lastSequence: safeSequence,
    recoverable: CLOSE_REASON_RECOVERABLE[reason],
    message: sanitizeCloseMessage(rawMessage)
  });
}

function sanitizeCloseMessage(message: string): string {
  const withoutControl = message.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (withoutControl.length <= CLOSE_MESSAGE_MAX_LENGTH) return withoutControl;
  return withoutControl.slice(0, CLOSE_MESSAGE_MAX_LENGTH);
}

export class AcpEventPublisher {
  private readonly events: NormalizedRunnerEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private terminal = false;
  readonly diagnostics: AcpEventPublisherDiagnostic[] = [];
  private diagnosticSink: AcpEventPublisherDiagnosticSink | null;
  private diagnosticChain = Promise.resolve();
  constructor(
    private readonly maxPendingPerSubscriber = 256,
    diagnosticSink?: AcpEventPublisherDiagnosticSink
  ) {
    this.diagnosticSink = diagnosticSink ?? null;
  }

  setDiagnosticSink(sink: AcpEventPublisherDiagnosticSink): void {
    const previous = this.diagnosticSink;
    this.diagnosticSink = previous
      ? async (code, message) => {
          await previous(code, message);
          await sink(code, message);
        }
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
      this.closeTerminalSubscribers();
    }
  }

  subscribe(
    afterSequence: number,
    receive: AcpEventSubscriber,
    options: { keepOpenAfterTerminal?: boolean } = {}
  ): AcpEventSubscription {
    let resolve = (_result: AcpEventSubscriptionCloseResult): void => undefined;
    const closed = new Promise<AcpEventSubscriptionCloseResult>((done) => {
      resolve = done;
    });
    const subscriber: Subscriber = {
      after: afterSequence,
      pending: 0,
      closed: false,
      closeOnTerminal: options.keepOpenAfterTerminal !== true,
      resolve,
      chain: Promise.resolve(),
      receive,
      closeResult: null
    };
    this.subscribers.add(subscriber);
    for (const event of this.events)
      if (event.sequence > afterSequence) this.enqueue(subscriber, event);
    if (this.terminal && subscriber.closeOnTerminal) {
      this.close(subscriber, "terminal");
    }
    return {
      unsubscribe: () => this.close(subscriber, "explicit_unsubscribe"),
      closed
    };
  }

  private enqueue(subscriber: Subscriber, event: NormalizedRunnerEvent): void {
    if (subscriber.closed || event.sequence <= subscriber.after) return;
    if (subscriber.pending >= this.maxPendingPerSubscriber) {
      this.close(
        subscriber,
        "subscriber_backpressure",
        `Subscriber exceeded ${this.maxPendingPerSubscriber} pending events and was unsubscribed.`
      );
      this.reportDiagnostic(
        "subscriber_backpressure",
        `Subscriber exceeded ${this.maxPendingPerSubscriber} pending events and was unsubscribed.`
      );
      return;
    }
    subscriber.after = event.sequence;
    subscriber.pending += 1;
    subscriber.chain = subscriber.chain
      .then(() => subscriber.receive(event))
      .catch((error: unknown) => {
        this.close(
          subscriber,
          "subscriber_callback_failed",
          `Subscriber callback failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.reportDiagnostic(
          "subscriber_callback_failed",
          `Subscriber callback failed: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        subscriber.pending -= 1;
      });
  }

  private close(
    subscriber: Subscriber,
    reason: AcpEventSubscriptionCloseReason,
    message?: string
  ): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.subscribers.delete(subscriber);
    const result = createAcpEventSubscriptionCloseResult(reason, subscriber.after, message);
    subscriber.closeResult = result;
    void subscriber.chain.finally(() => {
      subscriber.resolve(result);
    });
  }

  private closeTerminalSubscribers(): void {
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.closeOnTerminal) this.close(subscriber, "terminal");
    }
  }
  private reportDiagnostic(
    code: "subscriber_backpressure" | "subscriber_callback_failed",
    message: string
  ): void {
    this.diagnostics.push({ code, message });
    if (!this.diagnosticSink) return;
    this.diagnosticChain = this.diagnosticChain.then(async () => {
      try {
        await this.diagnosticSink?.(code, message);
      } catch {
        this.diagnostics.push({
          code: "diagnostic_sink_failed",
          message: "ACP event publisher diagnostic sink failed; later diagnostics remain enabled."
        });
      }
    });
  }
  async drainDiagnostics(): Promise<void> {
    await this.diagnosticChain;
  }
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
