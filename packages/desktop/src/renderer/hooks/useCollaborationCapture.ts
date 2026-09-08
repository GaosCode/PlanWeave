import { useCallback, useEffect, useRef, useState } from "react";
import { rendererCapture } from "../collaboration/collaborationCapture.js";
import type { CaptureExport, CollaborationCaptureApi } from "../../shared/collaborationCapture.js";

/** Browser timing capabilities stay here; no DOM is used as collaboration state. */
function observeFrames(): { stop(): void; longTaskSupported: boolean } {
  let previous: number | null = null;
  let frame = 0;
  const tick = (time: number) => {
    if (!rendererCapture.running()) return;
    if (!document.hidden && previous !== null) {
      rendererCapture.record("frame", { durationMs: time - previous });
    }
    previous = document.hidden ? null : time;
    frame = requestAnimationFrame(tick);
  };
  const visibility = () => {
    previous = null;
    rendererCapture.record(document.hidden ? "hidden" : "visible");
  };
  visibility();
  document.addEventListener("visibilitychange", visibility);
  frame = requestAnimationFrame(tick);
  const longTaskSupported =
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("longtask");
  const observer = longTaskSupported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          rendererCapture.record("long_task", { durationMs: entry.duration });
      })
    : null;
  observer?.observe({ type: "longtask" });
  return {
    longTaskSupported,
    stop: () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    }
  };
}

export function useCollaborationCapture(injectedApi?: CollaborationCaptureApi) {
  const api = injectedApi ?? window.planweaveCollaborationCapture;
  const [phase, setPhase] = useState<
    "idle" | "starting" | "running" | "stopping" | "stop_failed" | "complete"
  >("idle");
  const [error, setError] = useState<"start" | "stop" | "export" | null>(null);
  const [result, setResult] = useState<CaptureExport | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const owned = useRef(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const observation = useRef<ReturnType<typeof observeFrames> | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const releaseObservers = useCallback(() => {
    observation.current?.stop();
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseObservers();
      if (owned.current) {
        rendererCapture.stop("scope_changed");
        owned.current = false;
        void api?.stop().catch(() => console.error("Collaboration capture cleanup failed."));
      }
    };
  }, [api, releaseObservers]);

  const stop = async () => {
    if (!api || !owned.current || busy.current) return;
    busy.current = true;
    setPhase("stopping");
    rendererCapture.stop();
    releaseObservers();
    const renderer = rendererCapture.snapshot();
    try {
      const transport = await api.stop();
      if (!renderer || !transport || renderer.captureId !== transport.captureId)
        throw new Error("capture_missing_trace");
      if (mounted.current) {
        setResult({
          renderer,
          transport,
          longTaskSupported: observation.current?.longTaskSupported === true
        });
        setElapsed(renderer.durationMs);
        setPhase("complete");
        setError(null);
      }
      owned.current = false;
    } catch {
      if (mounted.current) {
        setError("stop");
        setPhase("stop_failed");
      }
    } finally {
      busy.current = false;
    }
  };

  const start = async (captureId: string) => {
    if (!api || busy.current || owned.current) return;
    busy.current = true;
    setError(null);
    setPhase("starting");
    const scopeKey = rendererCapture.scopeKey();
    try {
      if (!scopeKey) throw new Error("capture_scope_unavailable");
      await api.start({ captureId, scopeKey });
      owned.current = true;
      if (!mounted.current || rendererCapture.scopeKey() !== scopeKey) {
        await api.stop();
        owned.current = false;
        throw new Error("capture_scope_changed");
      }
      rendererCapture.start(captureId, scopeKey);
      observation.current = observeFrames();
      const started = performance.now();
      setElapsed(0);
      setResult(null);
      setPhase("running");
      timer.current = setInterval(() => {
        setElapsed(performance.now() - started);
        if (!rendererCapture.running()) void stop();
      }, 500);
    } catch {
      releaseObservers();
      if (owned.current) rendererCapture.stop();
      if (mounted.current) {
        setError(owned.current ? "stop" : "start");
        setPhase(owned.current ? "stop_failed" : "idle");
      }
    } finally {
      busy.current = false;
    }
  };

  const exportResult = async (): Promise<boolean> => {
    if (!api || !result || busy.current) return false;
    busy.current = true;
    setError(null);
    try {
      return await api.export(result);
    } catch {
      setError("export");
      return false;
    } finally {
      busy.current = false;
    }
  };

  return { available: Boolean(api), phase, error, result, elapsed, start, stop, exportResult };
}
