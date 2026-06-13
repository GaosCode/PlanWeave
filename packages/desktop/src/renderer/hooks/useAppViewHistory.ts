import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import type { AppView } from "../types";

export const appViewHistoryChangedEvent = "planweave:app-view-history-changed";

type AppViewHistoryState = {
  planweaveAppView?: AppView;
  planweaveHistoryIndex?: number;
  planweaveHistoryMaxIndex?: number;
};

const appViews = new Set<AppView>(["new-task", "graph", "canvas-map", "review-pipeline", "todo", "statistics", "search", "notifications", "settings"]);

function isAppView(value: unknown): value is AppView {
  return typeof value === "string" && appViews.has(value as AppView);
}

function readAppViewHistoryState(state: unknown): AppViewHistoryState {
  if (!state || typeof state !== "object") {
    return {};
  }
  const candidate = state as AppViewHistoryState;
  return {
    planweaveAppView: isAppView(candidate.planweaveAppView) ? candidate.planweaveAppView : undefined,
    planweaveHistoryIndex: typeof candidate.planweaveHistoryIndex === "number" ? candidate.planweaveHistoryIndex : undefined,
    planweaveHistoryMaxIndex: typeof candidate.planweaveHistoryMaxIndex === "number" ? candidate.planweaveHistoryMaxIndex : undefined
  };
}

export function readAppViewHistoryAvailability() {
  const state = readAppViewHistoryState(window.history.state);
  const index = state.planweaveHistoryIndex ?? 0;
  const maxIndex = state.planweaveHistoryMaxIndex ?? index;
  return {
    canGoBack: index > 0,
    canGoForward: index < maxIndex
  };
}

export function useAppViewHistory(initialView: AppView): [AppView, Dispatch<SetStateAction<AppView>>] {
  const [activeView, setActiveViewState] = useState<AppView>(() => readAppViewHistoryState(window.history.state).planweaveAppView ?? initialView);
  const activeViewRef = useRef(activeView);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    const historyState = readAppViewHistoryState(window.history.state);
    const initialHistoryView = historyState.planweaveAppView ?? initialView;
    const initialIndex = historyState.planweaveHistoryIndex ?? 0;
    const initialMaxIndex = historyState.planweaveHistoryMaxIndex ?? initialIndex;
    window.history.replaceState(
      {
        ...window.history.state,
        planweaveAppView: initialHistoryView,
        planweaveHistoryIndex: initialIndex,
        planweaveHistoryMaxIndex: initialMaxIndex
      },
      ""
    );
    setActiveViewState(initialHistoryView);
    activeViewRef.current = initialHistoryView;
    window.dispatchEvent(new Event(appViewHistoryChangedEvent));

    const handlePopState = (event: PopStateEvent) => {
      const nextView = readAppViewHistoryState(event.state).planweaveAppView ?? initialView;
      activeViewRef.current = nextView;
      setActiveViewState(nextView);
      window.dispatchEvent(new Event(appViewHistoryChangedEvent));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [initialView]);

  const setActiveView = useCallback<Dispatch<SetStateAction<AppView>>>((nextAction) => {
    const currentView = activeViewRef.current;
    const nextView = typeof nextAction === "function" ? nextAction(currentView) : nextAction;
    if (nextView === currentView) {
      return;
    }

    const historyState = readAppViewHistoryState(window.history.state);
    const currentIndex = historyState.planweaveHistoryIndex ?? 0;
    const nextIndex = currentIndex + 1;
    window.history.pushState(
      {
        ...window.history.state,
        planweaveAppView: nextView,
        planweaveHistoryIndex: nextIndex,
        planweaveHistoryMaxIndex: nextIndex
      },
      ""
    );
    activeViewRef.current = nextView;
    setActiveViewState(nextView);
    window.dispatchEvent(new Event(appViewHistoryChangedEvent));
  }, []);

  return [activeView, setActiveView];
}
