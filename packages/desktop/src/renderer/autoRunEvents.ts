import type { DesktopAutoRunEvent, DesktopAutoRunPhase } from "@planweave-ai/runtime";

export function autoRunEventMatchesCanvas(event: DesktopAutoRunEvent, projectRoot: string, canvasId: string | null): boolean {
  return event.projectRoot === projectRoot && (event.canvasId ?? null) === (canvasId ?? null);
}

export function shouldRefreshGraphForAutoRunEvent(event: DesktopAutoRunEvent): boolean {
  return event.eventType === "step_finish" || isAutoRunSettledPhase(event.phase);
}

export function isAutoRunSettledPhase(phase: DesktopAutoRunPhase): boolean {
  return phase !== "running" && phase !== "pausing";
}
