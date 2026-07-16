import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AcpCorrelation, RunnerIdentity, RunnerRunIdentity } from "./runnerContractSchemas.js";
import {
  encodeNormalizedRunnerEvent,
  normalizedDiagnosticBody,
  normalizedRunnerEventSchema,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import { redactAcpProtocolPayload, redactRunnerEventText } from "./runnerEventRedaction.js";
import {
  replayNormalizedRunnerEvents,
  type CanonicalRunnerEventIdentity,
  type RunnerEventReplayDiagnostic
} from "./runnerEventReplay.js";
import { writeAcpConversationProjection } from "./acpConversationPersistence.js";
import { AcpEventPublisher } from "./acpEventPublisher.js";
import {
  createDefaultAcpEventRetentionPolicy,
  projectPersistedRetentionDiagnostics,
  type AcpEventRetentionPolicy,
  type AcpRetentionBudgetSnapshot
} from "./acpEventRetentionPolicy.js";

export type AcpEventStoreOptions = {
  runDir: string;
  identity: RunnerRunIdentity;
  runner: RunnerIdentity;
  publisher?: AcpEventPublisher;
  maxProtocolBytes?: number;
  maxEventBytes?: number;
  maxEvents?: number;
  retentionPolicy?: AcpEventRetentionPolicy;
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
  private readonly policy: AcpEventRetentionPolicy;
  private boundaryWritten = false;
  private protocolSoftExceeded = false;
  private ordinaryEventCount = 0;
  private ordinaryByteCount = 0;
  private hasArtifact = false;
  private hasTerminal = false;

  constructor(private readonly options: AcpEventStoreOptions) {
    this.protocolPath = join(options.runDir, "protocol.ndjson");
    this.eventsPath = join(options.runDir, "events.ndjson");
    this.appendText = options.appendText ?? appendFile;
    this.writeConversationProjection =
      options.writeConversationProjection ?? writeAcpConversationProjection;
    // Default policy inherits legacy maxEvents/maxEventBytes so options remain a single truth source
    // when retentionPolicy is not injected explicitly.
    this.policy =
      options.retentionPolicy ??
      createDefaultAcpEventRetentionPolicy({
        maxEvents: options.maxEvents,
        maxBytes: options.maxEventBytes
      });
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
    // Recompute ordinary budget usage, terminal flag, and boundary from persisted events only.
    // Persisted cursor/sequence represents disk content exclusively.
    let oCount = 0;
    let oBytes = 0;
    let sawBoundary = false;
    let sawArtifact = false;
    let sawTerminal = false;
    for (const ev of this.events) {
      const encodedLen = Buffer.byteLength(encodeNormalizedRunnerEvent(ev));
      if (this.policy.classify(ev.body) === "ordinary") {
        oCount += 1;
        oBytes += encodedLen;
      }
      if (ev.body.kind === "diagnostic" && ev.body.code === "retention_boundary") {
        sawBoundary = true;
      }
      if (ev.body.kind === "terminal") {
        sawTerminal = true;
      }
      if (ev.body.kind === "artifact") {
        sawArtifact = true;
      }
    }
    this.ordinaryEventCount = oCount;
    this.ordinaryByteCount = oBytes;
    this.boundaryWritten = sawBoundary;
    this.hasArtifact = sawArtifact;
    this.hasTerminal = sawTerminal;
    // A durable boundary is the cross-process saturation latch. Once present, reopening must
    // not resume ordinary protocol persistence merely because a dropped frame left a 0-byte file.
    this.protocolSoftExceeded =
      sawBoundary ||
      this.protocolBytes >= this.policy.getProtocolByteLimit(this.options.maxProtocolBytes);
    // Reopen diagnostic contract matches live: project persisted retention boundary diagnostics.
    this.diagnostics.push(...projectPersistedRetentionDiagnostics(this.events));
    this.opened = true;
    return replay.diagnostics;
  }

  appendProtocol(direction: string, payload: unknown): Promise<void> {
    const redacted = redactAcpProtocolPayload({
      timestamp: new Date().toISOString(),
      direction,
      payload
    });
    const encoded = `${JSON.stringify(redacted)}\n`;
    const encodedLen = Buffer.byteLength(encoded);
    return this.serial(async () => {
      const decision = this.policy.decideProtocolAdmission(
        this.protocolBytes,
        encodedLen,
        {
          boundaryWritten: this.boundaryWritten,
          protocolSoftExceeded: this.protocolSoftExceeded
        },
        this.options.maxProtocolBytes
      );
      if (decision.action === "drop") {
        this.protocolSoftExceeded = true;
        if (decision.shouldWriteBoundary) {
          await this.commitRetentionBoundaryIfAllowed("protocol envelope saturation");
        }
        // Drop ordinary protocol; do not throw, do not terminate task. Boundary is observable when committed.
        return;
      }
      await this.appendText(this.protocolPath, encoded, "utf8");
      this.protocolBytes += encodedLen;
    });
  }

  append(body: NormalizedRunnerEvent["body"], correlation?: AcpCorrelation): Promise<void> {
    return this.serial(async () => {
      const isOrdinary = this.policy.classify(body) === "ordinary";

      // Build candidate for projected-length admission (sequence only advances on durable persist).
      const candidate = normalizedRunnerEventSchema.parse({
        version: "planweave.runner-event/v1",
        sequence: this.sequence + 1,
        timestamp: new Date().toISOString(),
        identity: this.options.identity,
        runner: this.options.runner,
        correlation,
        body
      });
      const encoded = encodeNormalizedRunnerEvent(candidate);
      const encodedLen = Buffer.byteLength(encoded);
      const decision = this.policy.decideEventAdmission(body, encodedLen, this.budgetSnapshot());

      if (decision.action === "drop_ordinary") {
        if (decision.shouldWriteBoundary) {
          await this.commitRetentionBoundaryIfAllowed(decision.reason);
        }
        // Drop ordinary event: do not persist, publish, or advance persisted sequence.
        // append is command-style; durable boundary evidence exposes the drop to readers.
        return;
      }

      if (decision.action === "hard_reject") {
        throw new AcpEventStoreLimitError({
          code: "retention_truncation",
          line: null,
          message: decision.reason
        });
      }

      await this.appendNormalizedText(encoded);
      this.sequence = candidate.sequence;
      this.bytes += encodedLen;
      this.events.push(candidate);
      if (isOrdinary) {
        this.ordinaryEventCount += 1;
        this.ordinaryByteCount += encodedLen;
      }
      if (candidate.body.kind === "terminal") {
        this.hasTerminal = true;
      }
      if (candidate.body.kind === "artifact") {
        this.hasArtifact = true;
      }
      this.conversationProjectionDirty = true;
      try {
        this.publisher.publish(candidate);
      } catch (error) {
        await this.recordDerivedFailure("publisher_failed", error);
      }
      if (candidate.body.kind === "terminal") {
        await this.flushConversationProjection();
      }
      return;
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

  private budgetSnapshot(): AcpRetentionBudgetSnapshot {
    return {
      eventCount: this.events.length,
      byteCount: this.bytes,
      ordinaryEventCount: this.ordinaryEventCount,
      ordinaryByteCount: this.ordinaryByteCount,
      boundaryWritten: this.boundaryWritten,
      hasArtifact: this.hasArtifact,
      hasTerminal: this.hasTerminal
    };
  }

  /**
   * Attempt a single durable retention_boundary diagnostic when policy allows.
   * boundaryWritten is set only after durable commit succeeds.
   * I/O failures propagate so callers do not enter a dropped/observed pseudo-success state.
   */
  private async commitRetentionBoundaryIfAllowed(reason: string): Promise<void> {
    const message = redactRunnerEventText(
      `retention boundary at sequence ${this.sequence}; ordinary data dropped (${reason}); control evidence (lifecycle, artifact, terminal, diagnostic, interaction, session config) continues using reserve. See events.ndjson for boundary.`
    ).text;
    const body = normalizedDiagnosticBody("retention_boundary", message);
    const boundaryEvent = normalizedRunnerEventSchema.parse({
      version: "planweave.runner-event/v1",
      sequence: this.sequence + 1,
      timestamp: new Date().toISOString(),
      identity: this.options.identity,
      runner: this.options.runner,
      body
    });
    const encoded = encodeNormalizedRunnerEvent(boundaryEvent);
    const encodedLen = Buffer.byteLength(encoded);
    const admission = this.policy.decideBoundaryAdmission(encodedLen, this.budgetSnapshot());
    if (admission.action === "skip") {
      if (admission.reason === "hard_exhausted") {
        throw new AcpEventStoreLimitError({
          code: "retention_truncation",
          line: null,
          message:
            "ACP event retention hard budget is exhausted; ordinary data cannot be dropped without a durable retention boundary."
        });
      }
      return;
    }
    // Durable append first; only then mark boundary committed / observed.
    await this.appendNormalizedText(encoded);
    this.sequence = boundaryEvent.sequence;
    this.bytes += encodedLen;
    this.events.push(boundaryEvent);
    this.boundaryWritten = true;
    this.conversationProjectionDirty = true;
    try {
      this.publisher.publish(boundaryEvent);
    } catch (error) {
      await this.recordDerivedFailure("publisher_failed", error);
    }
    this.diagnostics.push({
      code: "retention_boundary",
      line: null,
      message: body.message
    });
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
    const encodedLen = Buffer.byteLength(encoded);
    const admission = this.policy.decideEventAdmission(
      diagnostic.body,
      encodedLen,
      this.budgetSnapshot()
    );
    if (admission.action !== "persist") {
      return;
    }
    try {
      await this.appendNormalizedText(encoded);
    } catch {
      return;
    }
    this.sequence = diagnostic.sequence;
    this.bytes += encodedLen;
    this.events.push(diagnostic);
    if (code !== "publisher_failed") this.publisher.publish(diagnostic);
  }
}
