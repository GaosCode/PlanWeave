import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";

const HOVER_LEAVE_DELAY_MS = 150;

/**
 * Canvas lock highlight/pin state for mutex-group overlays.
 * Esc clears pin via a dedicated window keydown listener (browser-capability hook).
 */
export function useLockHighlight(graph: DesktopGraphViewModel | null) {
  const [hoveredLock, setHoveredLock] = useState<string | null>(null);
  const [pinnedLock, setPinnedLock] = useState<string | null>(null);
  const [releaseEpochByLock, setReleaseEpochByLock] = useState<Record<string, number>>({});
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousHoldersRef = useRef<Map<string, string | null>>(new Map());

  const activeLock = pinnedLock ?? hoveredLock;

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimerRef.current != null) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const onLockHover = useCallback(
    (name: string | null) => {
      clearLeaveTimer();
      if (name != null) {
        setHoveredLock(name);
        return;
      }
      leaveTimerRef.current = setTimeout(() => {
        setHoveredLock(null);
        leaveTimerRef.current = null;
      }, HOVER_LEAVE_DELAY_MS);
    },
    [clearLeaveTimer]
  );

  const onLockPin = useCallback((name: string | null) => {
    setPinnedLock((current) => {
      if (name == null) {
        return null;
      }
      return current === name ? null : name;
    });
  }, []);

  const clearPin = useCallback(() => {
    setPinnedLock(null);
    setHoveredLock(null);
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

  useEffect(() => {
    return () => clearLeaveTimer();
  }, [clearLeaveTimer]);

  // Track holder → null transitions for one-shot release pulse epochs.
  useEffect(() => {
    if (!graph) {
      previousHoldersRef.current = new Map();
      return;
    }
    const released: string[] = [];
    for (const group of graph.lockGroups ?? []) {
      const previous = previousHoldersRef.current.get(group.name);
      if (previous != null && group.holderRef == null) {
        released.push(group.name);
      }
      previousHoldersRef.current.set(group.name, group.holderRef);
    }
    if (released.length === 0) {
      return;
    }
    setReleaseEpochByLock((current) => {
      const next = { ...current };
      for (const name of released) {
        next[name] = (current[name] ?? 0) + 1;
      }
      return next;
    });
  }, [graph]);

  const lockGroupByName = useMemo(() => {
    const map = new Map<string, NonNullable<DesktopGraphViewModel["lockGroups"]>[number]>();
    for (const group of graph?.lockGroups ?? []) {
      map.set(group.name, group);
    }
    return map;
  }, [graph]);

  return {
    activeLock,
    hoveredLock,
    pinnedLock,
    releaseEpochByLock,
    lockGroupByName,
    onLockHover,
    onLockPin,
    clearPin,
    setPinnedLock
  };
}
