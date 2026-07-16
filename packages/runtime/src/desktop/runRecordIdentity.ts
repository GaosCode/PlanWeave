import { parseBlockRef } from "../graph/blockRef.js";

export function runRecordId(blockRef: string, runId: string): string {
  return `${blockRef}::${runId}`;
}

export function feedbackRunRecordId(feedbackId: string, runId: string): string {
  return `${feedbackId}::${runId}`;
}

export type ParsedRunRecordId =
  | { kind: "block"; blockRef: string; runId: string }
  | { kind: "feedback"; feedbackId: string; runId: string };

export function parseRunRecordId(recordId: string): ParsedRunRecordId {
  const [ref, runId, extra] = recordId.split("::");
  if (!ref || !runId || extra !== undefined) {
    throw new Error(`Run record id '${recordId}' is invalid.`);
  }
  if (ref.includes("#")) {
    parseBlockRef(ref);
    return { kind: "block", blockRef: ref, runId };
  }
  return { kind: "feedback", feedbackId: ref, runId };
}

/**
 * Stable newest-first sort token for a runId.
 * Used by Task Workspace cursors and locator ordering.
 */
export function runSortKey(runId: string): string {
  const desktopMatch = /^DESKTOP-RUN-(\d{4,})$/.exec(runId);
  if (desktopMatch) {
    return `d:${desktopMatch[1]!.padStart(20, "0")}`;
  }
  const runMatch = /^RUN-(\d+)$/i.exec(runId);
  if (runMatch) {
    return `r:${runMatch[1]!.padStart(20, "0")}`;
  }
  return `s:${runId}`;
}
