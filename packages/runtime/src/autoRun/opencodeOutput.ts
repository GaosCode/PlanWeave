export type OpencodeJsonOutput = {
  parsedAny: boolean;
  sessionId: string | null;
  error: string | null;
  text: string;
  toolSummaries: string[];
};

type OpencodeErrorDetails = {
  name: string | null;
  message: string | null;
  ref: string | null;
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

const ansiEscapePattern = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const sessionLabels = new Set(["opencodesessionid", "sessionid", "threadid"]);

function normalizeTerminalLine(line: string): string {
  return line.replace(ansiEscapePattern, "").trim();
}

function cleanSessionToken(value: string | undefined): string | null {
  const cleaned = value?.replace(/^[`'"]+|[`'",;]+$/g, "");
  if (!cleaned || !/^[A-Za-z0-9_.:-]+$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function firstSessionToken(value: string): string | null {
  for (const token of value.replaceAll("*", "").trim().split(/\s+/)) {
    const sessionId = cleanSessionToken(token);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

function labeledSessionId(line: string): string | null {
  const colonIndex = line.indexOf(":");
  const equalsIndex = line.indexOf("=");
  const separatorIndex =
    colonIndex === -1
      ? equalsIndex
      : equalsIndex === -1
        ? colonIndex
        : Math.min(colonIndex, equalsIndex);
  if (separatorIndex === -1) {
    return null;
  }
  const label = line
    .slice(0, separatorIndex)
    .replaceAll("*", "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  if (!sessionLabels.has(label)) {
    return null;
  }
  return firstSessionToken(line.slice(separatorIndex + 1));
}

function commandSessionId(line: string): string | null {
  const tokens = line.split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "opencode") {
      continue;
    }
    const option = tokens[index + 1];
    if (option === "-s" || option === "--session") {
      return cleanSessionToken(tokens[index + 2]);
    }
  }
  return null;
}

export function extractOpencodeSessionId(output: string): string | null {
  const jsonSessionId = parseOpencodeJsonOutput(output).sessionId;
  if (jsonSessionId) {
    return jsonSessionId;
  }
  for (const line of output.split(/\r?\n/)) {
    const trimmed = normalizeTerminalLine(line);
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const sessionId =
        parsed.sessionID ??
        parsed.sessionId ??
        parsed.session_id ??
        parsed.threadId ??
        parsed.thread_id;
      if (typeof sessionId === "string" && sessionId.trim()) {
        return sessionId;
      }
    } catch {
      const sessionId = labeledSessionId(trimmed) ?? commandSessionId(trimmed);
      if (sessionId) {
        return sessionId;
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
  return [
    `- ${tool}`,
    title ? ` ${title}` : "",
    status ? ` (${status})` : "",
    output ? `: ${output}` : ""
  ].join("");
}

function errorDetails(
  value: unknown,
  options: { allowBareErrorObject?: boolean } = {}
): OpencodeErrorDetails | null {
  if (!isRecord(value)) {
    return null;
  }
  let error: Record<string, unknown> | null = null;
  if (isRecord(value.error)) {
    error = value.error;
  } else if (value.type === "error" || options.allowBareErrorObject) {
    error = value;
  }
  if (!error) {
    return null;
  }
  const data = isRecord(error.data) ? error.data : {};
  const name = stringValue(error.name);
  const message = stringValue(data.message) ?? stringValue(error.message);
  const ref = stringValue(data.ref) ?? stringValue(error.ref);
  return name || message || ref ? { name, message, ref } : null;
}

function formatErrorDetails(details: OpencodeErrorDetails): string {
  const label = details.name ? `OpenCode error ${details.name}` : "OpenCode error";
  const message = details.message && details.message !== details.name ? `: ${details.message}` : "";
  const ref = details.ref ? ` (ref: ${details.ref})` : "";
  return `${label}${message}${ref}`;
}

function jsonObjectCandidates(input: string): Array<{ json: string; start: number }> {
  const candidates: Array<{ json: string; start: number }> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) {
      continue;
    }
    depth -= 1;
    if (depth === 0 && start >= 0) {
      candidates.push({ json: input.slice(start, index + 1), start });
      start = -1;
    }
  }
  return candidates;
}

function hasTerminalErrorPrefix(input: string, jsonStart: number): boolean {
  const prefix = input.slice(Math.max(0, jsonStart - 80), jsonStart);
  return /(?:^|\s)(?:Error|OpenCode error)\s*:\s*$/i.test(prefix);
}

export function formatOpencodeErrorOutput(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`.replace(ansiEscapePattern, "");
  for (const line of combined.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const details = errorDetails(JSON.parse(trimmed));
      if (details) {
        return formatErrorDetails(details);
      }
    } catch {
      // Fall through to JSON object extraction below.
    }
  }
  for (const candidate of jsonObjectCandidates(combined)) {
    try {
      const details = errorDetails(JSON.parse(candidate.json), {
        allowBareErrorObject: hasTerminalErrorPrefix(combined, candidate.start)
      });
      if (details) {
        return formatErrorDetails(details);
      }
    } catch {
      // Ignore non-error JSON fragments in mixed terminal output.
    }
  }
  return null;
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
    const details = errorDetails(parsed);
    error = error ?? (details ? formatErrorDetails(details) : null);
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

const sessionListHint =
  "OpenCode session id was not found in this run output. Run `opencode session list` in the execution directory to find the latest OpenCode session.";

function withSessionListHint(
  report: string,
  output: OpencodeJsonOutput,
  fallbackStdout: string,
  fallbackStderr: string,
  knownSessionId?: string | null
): string {
  const sessionId =
    knownSessionId ??
    output.sessionId ??
    extractOpencodeSessionId(`${fallbackStdout}\n${fallbackStderr}`);
  if (sessionId || !report.trim()) {
    return report;
  }
  return `${report.trim()}\n\n---\n${sessionListHint}`;
}

export function opencodeReport(
  output: OpencodeJsonOutput,
  fallbackStdout: string,
  fallbackStderr: string,
  knownSessionId?: string | null
): string {
  let report: string;
  if (output.text) {
    report = output.text;
  } else if (output.toolSummaries.length > 0) {
    report = ["## OpenCode Tool Summary", "", ...output.toolSummaries].join("\n");
  } else {
    report = fallbackStdout.trim() || fallbackStderr.trim();
  }
  return withSessionListHint(report, output, fallbackStdout, fallbackStderr, knownSessionId);
}
