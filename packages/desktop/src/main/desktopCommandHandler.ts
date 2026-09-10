import { ipcMain } from "electron";
import { desktopCommandFailureSchema } from "../shared/desktopCommandFailure.js";
import { recordDesktopError, redactDiagnostic } from "./desktopDiagnosticsLog.js";

/** Expected command failures retain their classification across Electron's serialization boundary. */
export function handleDesktopCommand(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      await recordDesktopError(channel, error);
      const record = error && typeof error === "object" ? error : {};
      const kind = "kind" in record && typeof record.kind === "string" ? record.kind : "unknown";
      const code =
        "code" in record && typeof record.code === "string"
          ? record.code
          : "desktop_command_failed";
      return desktopCommandFailureSchema.parse({
        desktopCommandFailure: true,
        error: {
          kind: kind.slice(0, 64),
          code: code.slice(0, 128),
          message:
            redactDiagnostic(error instanceof Error ? error.message : code).slice(0, 512) || code,
          retryable:
            "retryable" in record && typeof record.retryable === "boolean"
              ? record.retryable
              : kind === "offline" || kind === "timeout",
          ...("httpStatus" in record &&
          typeof record.httpStatus === "number" &&
          Number.isInteger(record.httpStatus)
            ? { httpStatus: record.httpStatus }
            : {})
        }
      });
    }
  });
}
