import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AcpCorrelation, RunnerIdentity, RunnerRunIdentity } from "./runnerContractSchemas.js";
import {
  RUNNER_EVENT_RETENTION_MAX_BYTES,
  RUNNER_EVENT_RETENTION_MAX_EVENTS,
  encodeNormalizedRunnerEvent,
  normalizedRunnerEventSchema,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import { redactRunnerEventPayload, redactRunnerEventText } from "./runnerEventRedaction.js";
import {
  replayNormalizedRunnerEvents,
  type CanonicalRunnerEventIdentity,
  type RunnerEventReplayDiagnostic
} from "./runnerEventReplay.js";
import { writeAcpConversationProjection } from "./acpConversationPersistence.js";
import { AcpEventPublisher } from "./acpEventPublisher.js";

export type AcpEventStoreOptions = {
  runDir: string;
  identity: RunnerRunIdentity;
  runner: RunnerIdentity;
  publisher?: AcpEventPublisher;
  maxProtocolBytes?: number;
  maxEventBytes?: number;
  maxEvents?: number;
  appendText?: typeof appendFile;
  writeConversationProjection?: typeof writeAcpConversationProjection;
};

export class AcpEventStoreLimitError extends Error {
  constructor(readonly diagnostic: RunnerEventReplayDiagnostic) {
    super(diagnostic.message);
  }
}

export class AcpEventStoreOpenError extends Error {
  constructor(readonly diagnostics: RunnerEventReplayDiagnostic[]) {
    super(
      `ACP event log cannot be safely reopened: ${diagnostics.map((item) => item.code).join(", ")}.`
    );
  }
}

export class AcpEventStore {
  readonly protocolPath: string;
  readonly eventsPath: string;
  readonly publisher: AcpEventPublisher;
  private sequence = 0;
  private bytes = 0;
  private protocolBytes = 0;
  private readonly events: NormalizedRunnerEvent[] = [];
  private readonly diagnostics: RunnerEventReplayDiagnostic[] = [];
  private writeChain = Promise.resolve();
  private writeFailure: unknown;
  private conversationProjectionDirty = false;
  private conversationProjectionFailureRecorded = false;
  private opened = false;
  private readonly appendText: typeof appendFile;
  private readonly writeConversationProjection: typeof writeAcpConversationProjection;

  constructor(private readonly options: AcpEventStoreOptions) {
    this.protocolPath = join(options.runDir, "protocol.ndjson");
    this.eventsPath = join(options.runDir, "events.ndjson");
    this.appendText = options.appendText ?? appendFile;
    this.writeConversationProjection =
      options.writeConversationProjection ?? writeAcpConversationProjection;
    this.publisher = options.publisher ?? new AcpEventPublisher();
    this.publisher.setDiagnosticSink(async (code, message) => {
      const diagnostic = { code, line: null, message } satisfies RunnerEventReplayDiagnostic;
      this.diagnostics.push(diagnostic);
      try {
        await this.append({ kind: "diagnostic", code, message });
      } catch {
        this.diagnostics.push({
          code: "publisher_failed",
          line: null,
          message:
            "A subscriber diagnostic could not be persisted; later diagnostics remain enabled."
        });
      }
    });
  }

  async open(): Promise<RunnerEventReplayDiagnostic[]> {
    if (this.opened) throw new Error("ACP event store is already open.");
    await mkdir(this.options.runDir, { recursive: true });
    let content: string;
    try {
      content = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.opened = true;
        return [];
      }
      throw error;
    }
    const replay = replayNormalizedRunnerEvents({
      content,
      runId: this.options.identity.runId,
      canonicalIdentity: this.canonicalIdentity()
    });
    if (replay.diagnostics.length > 0 || replay.partialLine !== null) {
      throw new AcpEventStoreOpenError(replay.diagnostics);
    }
    this.events.push(...replay.events);
    this.publisher.seed(replay.events);
    this.sequence = replay.nextCursor.afterSequence;
    this.bytes = Buffer.byteLength(content);
    try {
      this.protocolBytes = (await stat(this.protocolPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.opened = true;
    return replay.diagnostics;
  }

  appendProtocol(direction: string, payload: unknown): Promise<void> {
    const redacted = redactRunnerEventPayload({
      timestamp: new Date().toISOString(),
      direction,
      payload
    });
    const encoded = `${JSON.stringify(redacted)}\n`;
    return this.serial(async () => {
      if (
        this.protocolBytes + Buffer.byteLength(encoded) >
        (this.options.maxProtocolBytes ?? RUNNER_EVENT_RETENTION_MAX_BYTES)
      ) {
        throw new AcpEventStoreLimitError({
          code: "retention_truncation",
          line: null,
          message: "ACP protocol log byte retention limit reached; raw envelope was not persisted."
        });
      }
      await this.appendText(this.protocolPath, encoded, "utf8");
      this.protocolBytes += Buffer.byteLength(encoded);
    });
  }

  append(
    body: NormalizedRunnerEvent["body"],
    correlation?: AcpCorrelation
  ): Promise<NormalizedRunnerEvent> {
    return this.serial(async () => {
      if (
        this.events.length >= (this.options.maxEvents ?? RUNNER_EVENT_RETENTION_MAX_EVENTS) ||
        this.bytes >= (this.options.maxEventBytes ?? RUNNER_EVENT_RETENTION_MAX_BYTES)
      ) {
        throw new AcpEventStoreLimitError({
          code: "retention_truncation",
          line: null,
          message: "ACP normalized event retention limit reached; event was not persisted."
        });
      }
      const event = normalizedRunnerEventSchema.parse({
        version: "planweave.runner-event/v1",
        sequence: this.sequence + 1,
        timestamp: new Date().toISOString(),
        identity: this.options.identity,
        runner: this.options.runner,
        correlation,
        body
      });
      const encoded = encodeNormalizedRunnerEvent(event);
      if (
        this.bytes + Buffer.byteLength(encoded) >
        (this.options.maxEventBytes ?? RUNNER_EVENT_RETENTION_MAX_BYTES)
      ) {
        throw new AcpEventStoreLimitError({
          code: "retention_truncation",
          line: null,
          message: "ACP normalized event byte retention limit reached; event was not persisted."
        });
      }
      await this.appendNormalizedText(encoded);
      this.sequence = event.sequence;
      this.bytes += Buffer.byteLength(encoded);
      this.events.push(event);
      this.conversationProjectionDirty = true;
      try {
        this.publisher.publish(event);
      } catch (error) {
        await this.recordDerivedFailure("publisher_failed", error);
      }
      if (event.body.kind === "terminal") {
        await this.flushConversationProjection();
      }
      return event;
    });
  }

  async sizes(): Promise<{ protocolBytes: number; eventBytes: number }> {
    const size = async (path: string) => {
      try {
        return (await stat(path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    };
    return {
      protocolBytes: await size(this.protocolPath),
      eventBytes: await size(this.eventsPath)
    };
  }

  snapshot(afterSequence = 0): {
    events: NormalizedRunnerEvent[];
    diagnostics: RunnerEventReplayDiagnostic[];
    terminal: boolean;
  } {
    return {
      events: this.events.filter((event) => event.sequence > afterSequence),
      diagnostics: [...this.diagnostics],
      terminal: this.events.some((event) => event.body.kind === "terminal")
    };
  }

  eventsAfterSequence(afterSequence: number): NormalizedRunnerEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("ACP event sequence cursor must be a non-negative safe integer.");
    }
    return this.events.slice(Math.min(afterSequence, this.events.length));
  }

  diagnosticsSnapshot(): RunnerEventReplayDiagnostic[] {
    return [...this.diagnostics];
  }

  normalizedContent(): string {
    return this.events.map(encodeNormalizedRunnerEvent).join("");
  }

  get runId(): string {
    return this.options.identity.runId;
  }
  canonicalIdentity(): CanonicalRunnerEventIdentity {
    return { identity: this.options.identity, runner: this.options.runner };
  }

  async drain(): Promise<void> {
    await this.serial(() => this.flushConversationProjection());
    await this.publisher.drainDiagnostics();
    await this.serial(() => this.flushConversationProjection());
    if (this.writeFailure !== undefined) throw this.writeFailure;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.opened)
      return Promise.reject(new Error("ACP event store must be opened before append."));
    if (this.writeFailure !== undefined) return Promise.reject(this.writeFailure);
    const result = this.writeChain.then(() => {
      if (this.writeFailure !== undefined) throw this.writeFailure;
      return operation();
    });
    this.writeChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async appendNormalizedText(encoded: string): Promise<void> {
    try {
      await this.appendText(this.eventsPath, encoded, "utf8");
    } catch (error) {
      const expectedBefore = this.normalizedContent();
      let actual: string;
      try {
        actual = await readFile(this.eventsPath, "utf8");
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT" && expectedBefore === "") {
          throw error;
        }
        this.poisonNormalizedLog();
      }
      if (actual === expectedBefore) throw error;
      if (actual === `${expectedBefore}${encoded}`) return;
      this.poisonNormalizedLog();
    }
  }

  private async flushConversationProjection(): Promise<void> {
    if (!this.conversationProjectionDirty) return;
    try {
      await this.writeConversationProjection(this.options.runDir, this.events);
      this.conversationProjectionDirty = false;
      this.conversationProjectionFailureRecorded = false;
    } catch (error) {
      if (!this.conversationProjectionFailureRecorded) {
        this.conversationProjectionFailureRecorded = true;
        await this.recordDerivedFailure("conversation_projection_failed", error);
      }
    }
  }

  private poisonNormalizedLog(): never {
    const error = new Error(
      "ACP normalized event append failed after changing the durable log; retry is unsafe."
    );
    this.writeFailure = error;
    this.diagnostics.push({
      code: "corrupt_line",
      line: null,
      message: "ACP normalized event log may contain a partial or foreign append."
    });
    throw error;
  }

  private async recordDerivedFailure(
    code: "conversation_projection_failed" | "publisher_failed",
    error: unknown
  ): Promise<void> {
    void error;
    const message = redactRunnerEventText(
      `A durable ACP event committed, but its derived ${code.replaceAll("_", " ")} update failed.`
    ).text;
    this.diagnostics.push({ code, line: null, message });
    const diagnostic = normalizedRunnerEventSchema.parse({
      version: "planweave.runner-event/v1",
      sequence: this.sequence + 1,
      timestamp: new Date().toISOString(),
      identity: this.options.identity,
      runner: this.options.runner,
      body: { kind: "diagnostic", code, message }
    });
    const encoded = encodeNormalizedRunnerEvent(diagnostic);
    try {
      await this.appendNormalizedText(encoded);
    } catch {
      return;
    }
    this.sequence = diagnostic.sequence;
    this.bytes += Buffer.byteLength(encoded);
    this.events.push(diagnostic);
    if (code !== "publisher_failed") this.publisher.publish(diagnostic);
  }
}
