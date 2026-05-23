import type { BlockType } from "@planweave/runtime";
import type { createTranslator } from "./i18n";

export const statusVariant = {
  planned: "outline",
  ready: "secondary",
  in_progress: "default",
  implemented: "secondary",
  completed: "secondary",
  needs_changes: "destructive",
  blocked: "destructive",
  diverged: "destructive"
} as const;

export function defaultBlockTitleForUi(type: BlockType, t: ReturnType<typeof createTranslator>): string {
  if (type === "check") {
    return t("defaultCheckBlockTitle");
  }
  if (type === "review") {
    return t("defaultReviewBlockTitle");
  }
  return t("defaultImplementationBlockTitle");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
