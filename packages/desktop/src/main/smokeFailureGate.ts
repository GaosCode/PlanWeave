export const rendererUncaughtSmokeEvent = "PLANWEAVE_DESKTOP_RENDERER_UNCAUGHT";

const fatalSmokeEvents = new Set([
  rendererUncaughtSmokeEvent,
  "PLANWEAVE_DESKTOP_LOAD_FAILED",
  "PLANWEAVE_DESKTOP_RENDERER_GONE"
]);

export function isRendererUncaughtConsoleMessage(details: {
  level: string;
  message: string;
}): boolean {
  return details.level === "error" && /^Uncaught\b/.test(details.message.trim());
}

export function smokeOutputFailure(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { event?: unknown; message?: unknown };
      if (typeof parsed.event === "string" && fatalSmokeEvents.has(parsed.event)) {
        return typeof parsed.message === "string"
          ? `${parsed.event}: ${parsed.message}`
          : parsed.event;
      }
    } catch {
      continue;
    }
  }
  return null;
}
