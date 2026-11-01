export {
  runRecordId,
  feedbackRunRecordId,
  parseRunRecordId
} from "../runRecordIdentity.js";
export type { ParsedRunRecordId } from "../runRecordIdentity.js";

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
