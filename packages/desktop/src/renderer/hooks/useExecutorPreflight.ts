import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopCanvasReference, ExecutorPreflightResult } from "@planweave-ai/runtime";
import { bridge } from "../bridge";

type ExecutorPreflightState = {
  error: string | null;
  loading: boolean;
  result: ExecutorPreflightResult | null;
};

type UseExecutorPreflightArgs = {
  bridgeUnavailableMessage: string;
  cacheKey?: string | null;
  canvasRef: DesktopCanvasReference | null;
  executorName: string | null;
};

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function preflightCacheKey(canvasRef: DesktopCanvasReference, executorName: string, cacheKey: string | null | undefined): string {
  return JSON.stringify({
    projectRoot: canvasRef.projectRoot,
    canvasId: canvasRef.canvasId ?? null,
    executorName,
    cacheKey: cacheKey ?? null
  });
}

export function useExecutorPreflight({ bridgeUnavailableMessage, cacheKey, canvasRef, executorName }: UseExecutorPreflightArgs) {
  const cacheRef = useRef(new Map<string, ExecutorPreflightResult>());
  const currentCacheKeyRef = useRef<string | null>(null);
  const latestRequestRef = useRef<{ key: string; requestId: number } | null>(null);
  const nextRequestIdRef = useRef(0);
  const [state, setState] = useState<ExecutorPreflightState>({
    error: null,
    loading: false,
    result: null
  });
  const currentCacheKey = canvasRef && executorName ? preflightCacheKey(canvasRef, executorName, cacheKey) : null;

  useEffect(() => {
    currentCacheKeyRef.current = currentCacheKey;
    if (!currentCacheKey) {
      setState({ error: null, loading: false, result: null });
      return;
    }
    const cached = cacheRef.current.get(currentCacheKey) ?? null;
    setState({ error: null, loading: false, result: cached });
  }, [currentCacheKey]);

  const runPreflight = useCallback(async () => {
    if (!bridge) {
      setState({ error: bridgeUnavailableMessage, loading: false, result: null });
      return null;
    }
    if (!canvasRef || !executorName || !currentCacheKey) {
      setState({ error: null, loading: false, result: null });
      return null;
    }
    const requestId = nextRequestIdRef.current + 1;
    nextRequestIdRef.current = requestId;
    latestRequestRef.current = { key: currentCacheKey, requestId };
    setState((current) => ({ ...current, error: null, loading: true }));
    try {
      const result = await bridge.testExecutorProfile(canvasRef, executorName);
      cacheRef.current.set(currentCacheKey, result);
      if (latestRequestRef.current?.requestId === requestId && latestRequestRef.current.key === currentCacheKey && currentCacheKeyRef.current === currentCacheKey) {
        setState({ error: null, loading: false, result });
      }
      return result;
    } catch (caught) {
      const message = errorMessage(caught);
      if (latestRequestRef.current?.requestId === requestId && latestRequestRef.current.key === currentCacheKey && currentCacheKeyRef.current === currentCacheKey) {
        setState({ error: message, loading: false, result: null });
      }
      return null;
    }
  }, [bridgeUnavailableMessage, canvasRef, currentCacheKey, executorName]);

  return {
    ...state,
    runPreflight
  };
}
