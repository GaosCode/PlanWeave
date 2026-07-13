import { parseBlockRef } from "../graph/compileTaskGraph.js";

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
