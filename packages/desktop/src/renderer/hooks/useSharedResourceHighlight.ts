import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";

const HOVER_LEAVE_DELAY_MS = 150;

export function useSharedResourceHighlight(graph: DesktopGraphViewModel | null) {
  const [hoveredResource, setHoveredResource] = useState<string | null>(null);
  const [pinnedResource, setPinnedResource] = useState<string | null>(null);
  const [transitionEpochByResource, setTransitionEpochByResource] = useState<
    Record<string, number>
  >({});
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousActiveRefs = useRef<Map<string, string>>(new Map());

  const activeResource = pinnedResource ?? hoveredResource;

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimerRef.current != null) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const onResourceHover = useCallback(
    (name: string | null) => {
      clearLeaveTimer();
      if (name != null) {
        setHoveredResource(name);
        return;
      }
      leaveTimerRef.current = setTimeout(() => {
        setHoveredResource(null);
        leaveTimerRef.current = null;
      }, HOVER_LEAVE_DELAY_MS);
    },
    [clearLeaveTimer]
  );

  const onResourcePin = useCallback((name: string | null) => {
    setPinnedResource((current) => (name == null || current === name ? null : name));
  }, []);

  const clearPin = useCallback(() => {
    setPinnedResource(null);
    setHoveredResource(null);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement)
      ) {
        return;
      }
      clearPin();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clearPin]);

  useEffect(() => () => clearLeaveTimer(), [clearLeaveTimer]);

  useEffect(() => {
    if (!graph) {
      previousActiveRefs.current = new Map();
      return;
    }
    const transitioned: string[] = [];
    const currentActiveRefs = new Map<string, string>();
    for (const group of graph.sharedResourceGroups) {
      const activeKey = group.activeBlockRefs.join("\u0000");
      currentActiveRefs.set(group.name, activeKey);
      const previous = previousActiveRefs.current.get(group.name);
      if (previous !== undefined && previous !== activeKey) {
        transitioned.push(group.name);
      }
    }
    previousActiveRefs.current = currentActiveRefs;
    if (transitioned.length > 0) {
      setTransitionEpochByResource((current) => {
        const next = { ...current };
        for (const name of transitioned) {
          next[name] = (current[name] ?? 0) + 1;
        }
        return next;
      });
    }
  }, [graph]);

  return {
    activeResource,
    pinnedResource,
    transitionEpochByResource,
    onResourceHover,
    onResourcePin,
    clearPin,
    setPinnedResource
  };
}
