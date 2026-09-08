import { randomUUID } from "node:crypto";
import { CollaborationCaptureRecorder } from "../../shared/CollaborationCaptureRecorder.js";
import type { CanvasPresenceTrace } from "@planweave-ai/collaboration-protocol/canvas/presence";

export const transportCapture = new CollaborationCaptureRecorder();
let stream: { ticket: number; id: string; sequence: number } | null = null;
let lagTimer: ReturnType<typeof setTimeout> | null = null;

export function nextPresenceTrace(): CanvasPresenceTrace | undefined {
  const ticket = transportCapture.ticket();
  if (ticket === null) return undefined;
  if (stream?.ticket !== ticket) stream = { ticket, id: randomUUID(), sequence: 0 };
  return { streamId: stream.id, sequence: stream.sequence++ };
}

/** Timer lateness measures local scheduling delay, not network latency. */
export function startCaptureLoopProbe(): void {
  if (lagTimer !== null) clearTimeout(lagTimer);
  const ticket = transportCapture.ticket();
  if (ticket === null) return;
  let due = performance.now() + 100;
  const sample = () => {
    lagTimer = null;
    if (ticket !== transportCapture.ticket()) return;
    const now = performance.now();
    transportCapture.record("main_event_loop_delay", { durationMs: Math.max(0, now - due) });
    due = now + 100;
    lagTimer = setTimeout(sample, 100);
  };
  lagTimer = setTimeout(sample, 100);
}
