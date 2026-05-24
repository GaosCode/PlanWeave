export type OpencodeJsonOutput = {
  parsedAny: boolean;
  sessionId: string | null;
  error: string | null;
  text: string;
  toolSummaries: string[];
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractSessionIdFromObject(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return (
    stringValue(value.sessionID) ??
    stringValue(value.sessionId) ??
    stringValue(value.session_id) ??
    stringValue(value.threadId) ??
    stringValue(value.thread_id) ??
    extractSessionIdFromObject(value.part)
  );
}

export function extractOpencodeSessionId(output: string): string | null {
  const jsonSessionId = parseOpencodeJsonOutput(output).sessionId;
  if (jsonSessionId) {
    return jsonSessionId;
  }
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const sessionId = parsed.sessionID ?? parsed.sessionId ?? parsed.session_id ?? parsed.threadId ?? parsed.thread_id;
      if (typeof sessionId === "string" && sessionId.trim()) {
        return sessionId;
      }
    } catch {
      const match =
        trimmed.match(/^(?:opencodeSessionId|sessionId|session_id|session id|threadId|thread_id)\s*[:=]\s*([A-Za-z0-9_.:-]+)$/i) ??
        trimmed.match(/^\*\*Session ID:\*\*\s*([A-Za-z0-9_.:-]+)$/i) ??
        trimmed.match(/^Continue\s+opencode\s+-s\s+([A-Za-z0-9_.:-]+)$/i);
      if (match) {
        return match[1];
      }
    }
  }
  return null;
}

function textPart(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const part = value.part;
  if (isRecord(part) && part.type === "text") {
    return stringValue(part.text);
  }
  if (value.type === "text") {
    return stringValue(value.text);
  }
  return null;
}

function toolSummary(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const part = isRecord(value.part) ? value.part : value;
  if (part.type !== "tool" && value.type !== "tool_use") {
    return null;
  }
  const tool = stringValue(part.tool) ?? "tool";
  const title = stringValue(part.title);
  const state = isRecord(part.state) ? part.state : {};
  const status = stringValue(state.status);
  const output = stringValue(state.output);
  return [`- ${tool}`, title ? ` ${title}` : "", status ? ` (${status})` : "", output ? `: ${output}` : ""].join("");
}

function errorMessage(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "error") {
    return null;
  }
  const error = isRecord(value.error) ? value.error : {};
  const data = isRecord(error.data) ? error.data : {};
  return stringValue(data.message) ?? stringValue(error.message) ?? stringValue(error.name) ?? "OpenCode returned an error event.";
}

export function parseOpencodeJsonOutput(output: string): OpencodeJsonOutput {
  const textParts: string[] = [];
  const toolSummaries: string[] = [];
  let parsedAny = false;
  let sessionId: string | null = null;
  let error: string | null = null;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    parsedAny = true;
    sessionId = sessionId ?? extractSessionIdFromObject(parsed);
    error = error ?? errorMessage(parsed);
    const text = textPart(parsed);
    if (text) {
      textParts.push(text);
    }
    const summary = toolSummary(parsed);
    if (summary) {
      toolSummaries.push(summary);
    }
  }

  return {
    parsedAny,
    sessionId,
    error,
    text: textParts.join("\n\n").trim(),
    toolSummaries
  };
}

export function opencodeReport(output: OpencodeJsonOutput, fallbackStdout: string, fallbackStderr: string): string {
  if (output.text) {
    return output.text;
  }
  if (output.toolSummaries.length > 0) {
    return ["## OpenCode Tool Summary", "", ...output.toolSummaries].join("\n");
  }
  return fallbackStdout.trim() || fallbackStderr.trim();
}
