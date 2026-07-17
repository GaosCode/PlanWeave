import { open, stat } from "node:fs/promises";
import type { AcpEventSubscription } from "./acpEventPublisher.js";
import { createAcpEventSubscriptionCloseResult } from "./acpEventPublisher.js";
import {
  RUNNER_EVENT_MAX_LINE_BYTES,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import {
  replayNormalizedRunnerEvents,
  type CanonicalRunnerEventIdentity,
  type RunnerEventCursor,
  type RunnerEventReplayDiagnostic
} from "./runnerEventReplay.js";

export type PersistedRunnerEventUpdate = {
  cursor: RunnerEventCursor;
  diagnostics: RunnerEventReplayDiagnostic[];
  events: NormalizedRunnerEvent[];
  terminal: boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_ENCODED_LINE_BYTES = RUNNER_EVENT_MAX_LINE_BYTES + Buffer.byteLength("\n");

/**
 * Follow an append-only normalized event log owned by another runtime instance.
 * This is the durable counterpart to the in-memory ACP publisher subscription.
 */
export function subscribePersistedRunnerEvents(options: {
  canonicalIdentity: CanonicalRunnerEventIdentity;
  cursor: RunnerEventCursor;
  eventsPath: string;
  initialByteOffset: number;
  onUpdate: (update: PersistedRunnerEventUpdate) => void | Promise<void>;
  pollIntervalMs?: number;
}): AcpEventSubscription {
  let byteOffset = options.initialByteOffset;
  let cursor = options.cursor;
  let pendingBytes = Buffer.alloc(0);
  let closed = false;
  let refreshChain = Promise.resolve();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let resolveClosed = (_result: Awaited<AcpEventSubscription["closed"]>): void => undefined;
  const closedPromise = new Promise<Awaited<AcpEventSubscription["closed"]>>((resolve) => {
    resolveClosed = resolve;
  });

  const close = (
    reason: Parameters<typeof createAcpEventSubscriptionCloseResult>[0],
    message?: string,
    waitForRefresh = true
  ): void => {
    if (closed) return;
    closed = true;
    if (pollTimer !== null) clearInterval(pollTimer);
    const result = createAcpEventSubscriptionCloseResult(reason, cursor.afterSequence, message);
    if (waitForRefresh) {
      void refreshChain.finally(() => resolveClosed(result));
    } else {
      resolveClosed(result);
    }
  };

  const refresh = async (): Promise<void> => {
    if (closed) return;
    let nextSize: number;
    try {
      nextSize = (await stat(options.eventsPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      close(
        "owner_disposed",
        `Persisted runner event log cannot be inspected: ${String(error)}`,
        false
      );
      return;
    }
    if (nextSize < byteOffset) {
      close(
        "not_subscribable",
        "Persisted runner event log was truncated while subscribed.",
        false
      );
      return;
    }
    if (nextSize === byteOffset) return;

    const byteLength = nextSize - byteOffset;
    const buffer = Buffer.allocUnsafe(byteLength);
    const handle = await open(options.eventsPath, "r");
    let bytesRead = 0;
    try {
      while (bytesRead < byteLength) {
        const result = await handle.read(
          buffer,
          bytesRead,
          byteLength - bytesRead,
          byteOffset + bytesRead
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
    } finally {
      await handle.close();
    }
    if (bytesRead === 0) return;
    byteOffset += bytesRead;

    const appendedBytes = Buffer.concat([pendingBytes, buffer.subarray(0, bytesRead)]);
    const finalNewline = appendedBytes.lastIndexOf(0x0a);
    if (finalNewline < 0) {
      pendingBytes = appendedBytes;
      if (pendingBytes.byteLength > MAX_ENCODED_LINE_BYTES) {
        close(
          "not_subscribable",
          "Persisted runner event line exceeds the encoded size limit.",
          false
        );
      }
      return;
    }
    pendingBytes = Buffer.from(appendedBytes.subarray(finalNewline + 1));
    const replay = replayNormalizedRunnerEvents({
      content: appendedBytes.subarray(0, finalNewline + 1).toString("utf8"),
      runId: cursor.runId,
      cursor,
      canonicalIdentity: options.canonicalIdentity
    });
    cursor = replay.nextCursor;
    const diagnostics = replay.diagnostics.filter(
      (diagnostic) => diagnostic.code !== "partial_line"
    );
    if (replay.events.length === 0 && diagnostics.length === 0) return;
    try {
      await options.onUpdate({
        cursor: replay.nextCursor,
        diagnostics,
        events: replay.events,
        terminal: replay.terminal
      });
    } catch (error) {
      close(
        "subscriber_callback_failed",
        `Persisted runner event subscriber failed: ${error instanceof Error ? error.message : String(error)}`,
        false
      );
      return;
    }
    if (diagnostics.some((diagnostic) => diagnostic.code === "identity_mismatch")) {
      close("not_subscribable", "Persisted runner event identity changed while subscribed.", false);
      return;
    }
    if (replay.terminal) close("terminal", undefined, false);
  };

  function scheduleRefresh(): void {
    if (closed) return;
    refreshChain = refreshChain.then(refresh).catch((error: unknown) => {
      close(
        "owner_disposed",
        `Persisted runner event subscription failed: ${error instanceof Error ? error.message : String(error)}`,
        false
      );
    });
  }

  pollTimer = setInterval(scheduleRefresh, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  pollTimer.unref();
  scheduleRefresh();

  return {
    unsubscribe: () => close("explicit_unsubscribe"),
    closed: closedPromise
  };
}
