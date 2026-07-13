import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { z } from "zod";
import {
  graphAppViewSchema,
  nonGraphRegularAppViewSchema,
  regularAppViewSchema,
  type AppView
} from "../appViewContract";
import {
  graphNavigationSnapshotSchema,
  taskWorkspaceNavigationIdentity,
  taskWorkspaceNavigationIdentitySchema,
  type GraphNavigationSnapshot,
  type TaskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationSourceInput,
  type TaskWorkspaceNavigationTarget
} from "../taskWorkspaceNavigation";

export const appViewHistoryChangedEvent = "planweave:app-view-history-changed";

export const appHistoryRouteSchema = z.discriminatedUnion("view", [
  z
    .object({
      view: graphAppViewSchema,
      graphSnapshot: graphNavigationSnapshotSchema.optional()
    })
    .strict(),
  z.object({ view: nonGraphRegularAppViewSchema }).strict(),
  z
    .object({
      view: z.literal("task-workspace"),
      navigation: taskWorkspaceNavigationIdentitySchema
    })
    .strict()
]);

const appHistoryStateSchema = z
  .object({
    planweaveRoute: appHistoryRouteSchema,
    planweaveHistoryIndex: z.number().int().nonnegative(),
    planweaveHistoryMaxIndex: z.number().int().nonnegative()
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.planweaveHistoryMaxIndex < value.planweaveHistoryIndex) {
      context.addIssue({
        code: "custom",
        path: ["planweaveHistoryMaxIndex"],
        message: "History max index cannot precede the current index."
      });
    }
  });

const legacyAppHistoryStateSchema = z
  .object({
    planweaveAppView: regularAppViewSchema.optional(),
    planweaveHistoryIndex: z.number().int().nonnegative().optional(),
    planweaveHistoryMaxIndex: z.number().int().nonnegative().optional()
  })
  .passthrough();

export type AppHistoryRoute = z.output<typeof appHistoryRouteSchema>;

type AppHistoryState = z.output<typeof appHistoryStateSchema>;

type HistoryStateRead =
  | { status: "ready"; state: AppHistoryState }
  | { status: "invalid"; message: string };

function historyRecord(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === "object" ? { ...state } : {};
}

function canonicalHistoryRecord(state: unknown): Record<string, unknown> {
  const record = historyRecord(state);
  Reflect.deleteProperty(record, "planweaveAppView");
  return record;
}

function initialRoute(initialView: AppView): AppHistoryRoute {
  if (initialView === "task-workspace") {
    throw new Error("Task Workspace cannot be the initial route without a navigation identity.");
  }
  return appHistoryRouteSchema.parse({ view: initialView });
}

function invalidHistoryState(error?: z.ZodError): HistoryStateRead {
  return {
    status: "invalid",
    message: error
      ? `Browser history contains an invalid PlanWeave route.\n${z.prettifyError(error)}`
      : "Browser history contains an invalid PlanWeave route."
  };
}

function readHistoryState(state: unknown, fallbackRoute?: AppHistoryRoute): HistoryStateRead {
  const record = historyRecord(state);
  if (Object.hasOwn(record, "planweaveRoute")) {
    const canonical = appHistoryStateSchema.safeParse(state);
    return canonical.success
      ? { status: "ready", state: canonical.data }
      : invalidHistoryState(canonical.error);
  }
  const legacy = legacyAppHistoryStateSchema.safeParse(state);
  if (!legacy.success) {
    return invalidHistoryState(legacy.error);
  }
  const legacyView = legacy.data.planweaveAppView;
  const route = legacyView ? appHistoryRouteSchema.parse({ view: legacyView }) : fallbackRoute;
  if (!route) {
    return invalidHistoryState();
  }
  const index = legacy.data.planweaveHistoryIndex ?? 0;
  const maxIndex = legacy.data.planweaveHistoryMaxIndex ?? index;
  return {
    status: "ready",
    state: appHistoryStateSchema.parse({
      ...canonicalHistoryRecord(state),
      planweaveRoute: route,
      planweaveHistoryIndex: index,
      planweaveHistoryMaxIndex: Math.max(index, maxIndex)
    })
  };
}

function writeHistoryState(
  method: "push" | "replace",
  route: AppHistoryRoute,
  index: number,
  maxIndex: number
): AppHistoryState {
  const next = appHistoryStateSchema.parse({
    ...canonicalHistoryRecord(window.history.state),
    planweaveRoute: route,
    planweaveHistoryIndex: index,
    planweaveHistoryMaxIndex: maxIndex
  });
  window.history[`${method}State`](next, "");
  window.dispatchEvent(new Event(appViewHistoryChangedEvent));
  return next;
}

export function readAppViewHistoryAvailability() {
  const read = readHistoryState(window.history.state);
  if (read.status === "invalid") {
    return { canGoBack: false, canGoForward: false };
  }
  const state = read.state;
  return {
    canGoBack: state.planweaveHistoryIndex > 0,
    canGoForward: state.planweaveHistoryIndex < state.planweaveHistoryMaxIndex
  };
}

export type AppViewHistoryController = {
  graphSnapshot: GraphNavigationSnapshot | null;
  historyError: string | null;
  historyIndex: number;
  openTaskWorkspace: (
    target: TaskWorkspaceNavigationTarget,
    source: TaskWorkspaceNavigationSourceInput
  ) => void;
  replaceTaskWorkspaceTarget: (target: TaskWorkspaceNavigationTarget) => void;
  returnToTaskWorkspaceSource: () => void;
  route: AppHistoryRoute;
  taskWorkspaceNavigation: TaskWorkspaceNavigationIdentity | null;
};

export function useAppViewHistory(
  initialView: AppView
): [AppView, Dispatch<SetStateAction<AppView>>, AppViewHistoryController] {
  const fallbackRoute = useMemo(() => initialRoute(initialView), [initialView]);
  const initialRead = useMemo(
    () => readHistoryState(window.history.state, fallbackRoute),
    [fallbackRoute]
  );
  const initialState = useMemo(
    () =>
      initialRead.status === "ready"
        ? initialRead.state
        : appHistoryStateSchema.parse({
            planweaveRoute: fallbackRoute,
            planweaveHistoryIndex: 0,
            planweaveHistoryMaxIndex: 0
          }),
    [fallbackRoute, initialRead]
  );
  const [historyState, setHistoryState] = useState(initialState);
  const [historyError, setHistoryError] = useState<string | null>(
    initialRead.status === "invalid" ? initialRead.message : null
  );
  const historyStateRef = useRef(historyState);

  const commitState = useCallback((next: AppHistoryState) => {
    historyStateRef.current = next;
    setHistoryState(next);
    setHistoryError(null);
  }, []);

  useEffect(() => {
    const current = readHistoryState(window.history.state, fallbackRoute);
    if (current.status === "ready") {
      const normalized = writeHistoryState(
        "replace",
        current.state.planweaveRoute,
        current.state.planweaveHistoryIndex,
        current.state.planweaveHistoryMaxIndex
      );
      commitState(normalized);
    } else {
      setHistoryError(current.message);
    }

    const handlePopState = (event: PopStateEvent) => {
      const next = readHistoryState(event.state);
      if (next.status === "invalid") {
        setHistoryError(next.message);
        return;
      }
      const normalized = writeHistoryState(
        "replace",
        next.state.planweaveRoute,
        next.state.planweaveHistoryIndex,
        next.state.planweaveHistoryMaxIndex
      );
      commitState(normalized);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [commitState, fallbackRoute]);

  const pushRoute = useCallback(
    (route: AppHistoryRoute) => {
      const current = historyStateRef.current;
      const nextIndex = current.planweaveHistoryIndex + 1;
      writeHistoryState(
        "replace",
        current.planweaveRoute,
        current.planweaveHistoryIndex,
        nextIndex
      );
      const next = writeHistoryState("push", route, nextIndex, nextIndex);
      commitState(next);
    },
    [commitState]
  );

  const replaceRoute = useCallback(
    (route: AppHistoryRoute) => {
      const current = historyStateRef.current;
      const next = writeHistoryState(
        "replace",
        route,
        current.planweaveHistoryIndex,
        current.planweaveHistoryMaxIndex
      );
      commitState(next);
    },
    [commitState]
  );

  const setActiveView = useCallback<Dispatch<SetStateAction<AppView>>>(
    (action) => {
      const currentView = historyStateRef.current.planweaveRoute.view;
      const nextView = typeof action === "function" ? action(currentView) : action;
      if (nextView === currentView) {
        return;
      }
      if (nextView === "task-workspace") {
        throw new Error("Use openTaskWorkspace() with a strict navigation target.");
      }
      pushRoute(appHistoryRouteSchema.parse({ view: nextView }));
    },
    [pushRoute]
  );

  const openTaskWorkspace = useCallback(
    (target: TaskWorkspaceNavigationTarget, source: TaskWorkspaceNavigationSourceInput) => {
      const navigation = taskWorkspaceNavigationIdentity(target, source);
      if (navigation.source.view === "graph" && navigation.source.graphSnapshot) {
        replaceRoute(
          appHistoryRouteSchema.parse({
            view: navigation.source.view,
            graphSnapshot: navigation.source.graphSnapshot
          })
        );
      }
      pushRoute(appHistoryRouteSchema.parse({ view: "task-workspace", navigation }));
    },
    [pushRoute, replaceRoute]
  );

  const replaceTaskWorkspaceTarget = useCallback(
    (target: TaskWorkspaceNavigationTarget) => {
      const current = historyStateRef.current.planweaveRoute;
      if (current.view !== "task-workspace") {
        throw new Error("Cannot replace a Task Workspace target outside its route.");
      }
      replaceRoute(
        appHistoryRouteSchema.parse({
          view: "task-workspace",
          navigation: taskWorkspaceNavigationIdentity(target, current.navigation.source)
        })
      );
    },
    [replaceRoute]
  );

  const returnToTaskWorkspaceSource = useCallback(() => {
    const current = historyStateRef.current;
    if (current.planweaveRoute.view !== "task-workspace") {
      throw new Error("Cannot return to a Task Workspace source outside its route.");
    }
    if (current.planweaveHistoryIndex <= 0) {
      throw new Error("Task Workspace source history is unavailable.");
    }
    window.history.back();
  }, []);

  const route = historyState.planweaveRoute;
  const controller = useMemo<AppViewHistoryController>(
    () => ({
      graphSnapshot: route.view === "graph" ? (route.graphSnapshot ?? null) : null,
      historyError,
      historyIndex: historyState.planweaveHistoryIndex,
      openTaskWorkspace,
      replaceTaskWorkspaceTarget,
      returnToTaskWorkspaceSource,
      route,
      taskWorkspaceNavigation: route.view === "task-workspace" ? route.navigation : null
    }),
    [
      historyError,
      historyState.planweaveHistoryIndex,
      openTaskWorkspace,
      replaceTaskWorkspaceTarget,
      returnToTaskWorkspaceSource,
      route
    ]
  );

  return [route.view, setActiveView, controller];
}
