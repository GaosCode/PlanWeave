import type { ResultIndex, TaskLifecycleEvent } from "../types.js";

export function appendTaskEvent(previous: ResultIndex | null, event: TaskLifecycleEvent): TaskLifecycleEvent[] {
  return [...(previous?.events ?? []), event];
}
