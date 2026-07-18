import type { DesktopRunRecord } from "../desktop/types/recordsTypes.js";
import {
  containsUnredactedRunnerSecret,
  redactRunnerEventPayload,
  redactRunnerEventText,
  utf8ByteLength
} from "./runnerEventRedaction.js";

const MAX_RECOVERY_TOOL_SUMMARY_BYTES = 4096;
const MAX_NESTED_JSON_BYTES = 65_536;
const MAX_NESTED_JSON_DEPTH = 4;
const REDACTED_NESTED_JSON = "[REDACTED:SENSITIVE_CONTENT]";

function looksLikeNestedJson(value: string): boolean {
  const first = value.trimStart()[0];
  return first === "{" || first === "[" || first === '"';
}

function parseNestedJson(value: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(value) as unknown };
  } catch (error) {
    if (error instanceof SyntaxError) return { parsed: false };
    throw error;
  }
}

function redactNestedRecoveryValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (looksLikeNestedJson(value)) {
      if (depth >= MAX_NESTED_JSON_DEPTH || utf8ByteLength(value) > MAX_NESTED_JSON_BYTES) {
        return REDACTED_NESTED_JSON;
      }
      const nested = parseNestedJson(value);
      if (nested.parsed) {
        return JSON.stringify(redactNestedRecoveryValue(nested.value, depth + 1));
      }
    }
    return redactRunnerEventText(value).text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactNestedRecoveryValue(item, depth));
  }
  if (value !== null && typeof value === "object") {
    return redactRunnerEventPayload(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, redactNestedRecoveryValue(item, depth)])
      )
    );
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Recovery tool state summary must be well-formed Unicode.");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error("Recovery tool state summary must be well-formed Unicode.");
    }
  }
  if (utf8ByteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let truncated = "";
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (bytes + codePointBytes > maxBytes) break;
    truncated += codePoint;
    bytes += codePointBytes;
  }
  return truncated;
}

export function normalizeAcpRecoveryToolSummary(value: string): string {
  const redacted = redactNestedRecoveryValue(value);
  const serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  const summary = truncateUtf8(
    redactRunnerEventText(serialized).text,
    MAX_RECOVERY_TOOL_SUMMARY_BYTES
  );
  if (containsUnredactedRunnerSecret(summary)) {
    throw new Error("Recovery tool state summary contains unredacted credential material.");
  }
  return summary;
}

export function normalizeAcpRecoveryToolSummaryValue(value: unknown): string {
  const serialized = JSON.stringify(redactNestedRecoveryValue(value));
  const summary = truncateUtf8(
    redactRunnerEventText(serialized).text,
    MAX_RECOVERY_TOOL_SUMMARY_BYTES
  );
  if (containsUnredactedRunnerSecret(summary)) {
    throw new Error("Recovery tool state summary contains unredacted credential material.");
  }
  return summary;
}

export function projectAcpRecoveryToolSummary(record: DesktopRunRecord): string | null {
  const event = [...(record.runnerReadModel?.events ?? [])]
    .reverse()
    .find(
      (candidate) => candidate.body.kind === "tool_call" || candidate.body.kind === "tool_update"
    );
  if (!event || (event.body.kind !== "tool_call" && event.body.kind !== "tool_update")) return null;
  return normalizeAcpRecoveryToolSummaryValue({
    callId: event.body.callId,
    status: event.body.status ?? null,
    title: event.body.title ?? null,
    toolKind: event.body.toolKind ?? null,
    content: event.body.content?.content ?? null
  });
}
