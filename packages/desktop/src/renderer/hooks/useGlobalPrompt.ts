import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../bridge";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useGlobalPrompt(setError: (message: string | null) => void, planweaveHome: string) {
  const [globalPromptMarkdown, setGlobalPromptMarkdown] = useState<string | null>(null);

  const home = useMemo(() => ({ planweaveHome }), [planweaveHome]);
  const lifecycle = useRef({ home, mounted: false, generation: 0, write: 0 });
  useLayoutEffect(() => {
    lifecycle.current.home = home;
    lifecycle.current.mounted = true;
    lifecycle.current.generation += 1;
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.generation += 1;
    };
  }, [home]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing PlanWeave Home selects a different main-process prompt file.
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const write = lifecycle.current.write;
    setGlobalPromptMarkdown(null);
    void bridge
      .readGlobalPrompt()
      .then((markdown) => {
        if (!cancelled && lifecycle.current.write === write) setGlobalPromptMarkdown(markdown);
      })
      .catch((error: unknown) => {
        if (!cancelled && lifecycle.current.write === write) setError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [planweaveHome, setError]);

  const updateGlobalPrompt = useCallback(
    async (markdown: string): Promise<boolean> => {
      if (!bridge || !lifecycle.current.mounted || lifecycle.current.home !== home) return false;
      const generation = lifecycle.current.generation;
      const write = ++lifecycle.current.write;
      const current = () =>
        lifecycle.current.mounted &&
        lifecycle.current.home === home &&
        lifecycle.current.generation === generation &&
        lifecycle.current.write === write;
      try {
        const updated = await bridge.updateGlobalPrompt(markdown);
        if (!current()) return false;
        setGlobalPromptMarkdown(updated);
        return true;
      } catch (error) {
        if (current()) {
          setError(errorMessage(error));
          throw error;
        }
      }
      return false;
    },
    [home, setError]
  );

  return { globalPromptMarkdown, updateGlobalPrompt };
}
