import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { desktopHomePaths } from "./planweaveHomePaths.js";
import { redactCollaborationText } from "./collaboration/redaction.js";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
let pending: Promise<void> = Promise.resolve();

export function desktopDiagnosticsLogPath(): string {
  return join(desktopHomePaths().planweaveHome, "desktop", "logs", "diagnostics.jsonl");
}

export async function ensureDesktopDiagnosticsLog(): Promise<string> {
  const path = desktopDiagnosticsLogPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, "", { mode: 0o600 });
  return path;
}

export function redactDiagnostic(value: string): string {
  return redactCollaborationText(
    value.replace(/\bpw_(?:operator|agent|host|setup|hdev|hid|inv)_[A-Za-z0-9_-]+/gi, "[REDACTED]")
  );
}

function errorChain(error: unknown, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (!(error instanceof Error)) return redactDiagnostic(String(error)).slice(0, 4096);
  return {
    name: error.name,
    code: "code" in error && typeof error.code === "string" ? error.code : undefined,
    message: redactDiagnostic(error.message).slice(0, 4096),
    stack: error.stack ? redactDiagnostic(error.stack).slice(0, 8192) : undefined,
    cause: error.cause === undefined ? undefined : errorChain(error.cause, depth + 1)
  };
}

export function recordDesktopError(operation: string, error: unknown): Promise<void> {
  const entry = JSON.stringify({
    time: new Date().toISOString(),
    level: "error",
    operation,
    error: errorChain(error)
  });
  pending = pending
    .then(async () => {
      const path = desktopDiagnosticsLogPath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const size = await stat(path).then(
        (value) => value.size,
        (cause: unknown) => {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
            return 0;
          throw cause;
        }
      );
      if (size >= MAX_LOG_BYTES) await rename(path, `${path}.previous`);
      await appendFile(path, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
    })
    .catch(() => {
      console.error("Could not write Desktop diagnostics log.");
    });
  return pending;
}
