import type { CodexExecExecutorProfile } from "../types.js";

const CODEX_STATUS_SESSION_PATTERN = /(?:^|[\s│|>])Session\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|[│|]|$)/i;

export function codexExecArgs(profile: CodexExecExecutorProfile): string[] {
  if (!profile.sandbox) {
    return profile.args;
  }
  const stdinPromptIndex = profile.args.lastIndexOf("-");
  const sandboxArgs = ["--sandbox", profile.sandbox];
  if (stdinPromptIndex === -1) {
    return [...profile.args, ...sandboxArgs];
  }
  return [...profile.args.slice(0, stdinPromptIndex), ...sandboxArgs, ...profile.args.slice(stdinPromptIndex)];
}

export function codexResumeArgs(profile: CodexExecExecutorProfile, sessionId: string, prompt: string): string[] {
  const execIndex = profile.args.indexOf("exec");
  const prefix = execIndex === -1 ? [] : profile.args.slice(0, execIndex);
  const sandboxArgs = profile.sandbox ? ["--sandbox", profile.sandbox] : [];
  return [...prefix, "exec", ...sandboxArgs, "resume", sessionId, prompt];
}

function findSessionIdValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  for (const key of ["codexSessionId", "sessionId", "session_id", "threadId", "thread_id"]) {
    const sessionId = object[key];
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId;
    }
  }
  for (const key of ["session", "thread"]) {
    const nested = object[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const id = (nested as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim()) {
        return id;
      }
    }
  }
  for (const nested of Object.values(object)) {
    const sessionId = findSessionIdValue(nested);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

export function extractCodexSessionId(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const sessionId = findSessionIdValue(JSON.parse(trimmed));
      if (sessionId) {
        return sessionId;
      }
    } catch {
      const match = trimmed.match(/^(?:codexSessionId|sessionId|session_id|session id|threadId|thread_id)\s*[:=]\s*([A-Za-z0-9_.:-]+)$/i);
      if (match) {
        return match[1];
      }
      const statusSessionMatch = trimmed.match(CODEX_STATUS_SESSION_PATTERN);
      if (statusSessionMatch) {
        return statusSessionMatch[1];
      }
    }
  }
  return null;
}
