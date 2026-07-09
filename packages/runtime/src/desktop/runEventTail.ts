import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../types.js";
import {
  isFailedAutoRunTerminalPhase,
  isTerminalAutoRunPhase,
  parseAutoRunNdjsonLine
} from "./autoRunEventSchema.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { readPersistedAutoRunState } from "./runStateRepository.js";
import { autoRunRoot } from "./runStateStore.js";
import type { DesktopAutoRunLogEvent, DesktopAutoRunPhase } from "./types.js";

async function resolveWorkspace(
  projectRoot: PackageWorkspaceRef,
  canvasId: string | null | undefined
): Promise<ProjectWorkspace> {
  return typeof projectRoot === "string"
    ? resolveTaskCanvasWorkspace(projectRoot, canvasId)
    : projectRoot;
}

export type AutoRunEventTailItem =
  | { kind: "event"; event: DesktopAutoRunLogEvent }
  | { kind: "parse_error"; line: number; message: string; path: string; rawLine: string }
  | { kind: "terminal"; phase: DesktopAutoRunPhase; runId: string };

export type TailAutoRunEventsOptions = {
  /** Byte offset into `events.ndjson` (default 0). */
  fromOffset?: number;
  signal?: AbortSignal;
  /** Polling fallback interval in ms (default 500). */
  pollIntervalMs?: number;
};

async function countNewlines(path: string, byteLength: number): Promise<number> {
  if (byteLength <= 0) {
    return 0;
  }
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(byteLength);
      const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
      let count = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 0x0a) {
          count += 1;
        }
      }
      return count;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return 0;
    }
    throw error;
  }
}

async function readBytesFrom(
  path: string,
  offset: number
): Promise<{ content: string; nextOffset: number } | null> {
  try {
    const fileStat = await stat(path);
    if (fileStat.size <= offset) {
      return null;
    }
    const handle = await open(path, "r");
    try {
      const length = fileStat.size - offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return {
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        nextOffset: offset + bytesRead
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Tail a run's `events.ndjson` across process boundaries.
 * Yields Zod-validated events (or explicit parse_error items), then a terminal marker when the run ends.
 * Cleans up fs.watch + poll interval on abort, terminal state, or generator return.
 */
export async function* tailAutoRunEvents(
  projectRoot: PackageWorkspaceRef,
  canvasId: string | null | undefined,
  runId: string,
  options: TailAutoRunEventsOptions = {}
): AsyncGenerator<AutoRunEventTailItem> {
  const workspace = await resolveWorkspace(projectRoot, canvasId);
  const path = join(autoRunRoot(workspace, runId), "events.ndjson");
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const signal = options.signal;

  let offset = Math.max(0, options.fromOffset ?? 0);
  let lineNumber = await countNewlines(path, offset);
  let pending = "";
  let terminalPhase: DesktopAutoRunPhase | null = null;

  let watcher: FSWatcher | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let wake: (() => void) | null = null;
  let aborted = false;

  const notify = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const onAbort = (): void => {
    aborted = true;
    notify();
  };

  if (signal) {
    if (signal.aborted) {
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    try {
      watcher = watch(dirname(path), () => notify());
      watcher.on("error", () => {
        /* directory may appear later; polling covers growth */
      });
    } catch {
      watcher = null;
    }

    interval = setInterval(notify, pollIntervalMs);
    if (typeof interval.unref === "function") {
      interval.unref();
    }

    while (!aborted && !signal?.aborted) {
      const chunk = await readBytesFrom(path, offset);
      if (chunk) {
        offset = chunk.nextOffset;
        pending += chunk.content;
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? "";
        for (const rawLine of parts) {
          if (rawLine.length === 0) {
            lineNumber += 1;
            continue;
          }
          lineNumber += 1;
          const parsed = parseAutoRunNdjsonLine(rawLine, lineNumber, path, runId);
          if (!parsed.ok) {
            yield {
              kind: "parse_error",
              line: parsed.parseError.line,
              message: parsed.parseError.message,
              path: parsed.parseError.path,
              rawLine: parsed.parseError.rawLine
            };
            continue;
          }
          yield { kind: "event", event: parsed.event };
          if (isTerminalAutoRunPhase(parsed.event.phase)) {
            terminalPhase = parsed.event.phase;
          }
        }
      }

      if (!terminalPhase) {
        const state = await readPersistedAutoRunState(workspace, runId);
        if (state && isTerminalAutoRunPhase(state.phase)) {
          terminalPhase = state.phase;
        }
      }

      if (terminalPhase) {
        yield { kind: "terminal", phase: terminalPhase, runId };
        return;
      }

      await new Promise<void>((resolve) => {
        if (aborted || signal?.aborted) {
          resolve();
          return;
        }
        wake = resolve;
      });
    }
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    wake = null;
  }
}

export { isFailedAutoRunTerminalPhase, isTerminalAutoRunPhase };
