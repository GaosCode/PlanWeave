import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveCanvasPersonGrant,
  AccessMutationResult,
  CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import type { ActiveWorkspaceConnectionStatus } from "@planweave-ai/collaboration-protocol/connection";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import type {
  CollaborationSessionPhase,
  CollaborationAccessMutationInput,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";

export type CurrentCanvasAccessApi = Pick<
  PlanWeaveCollaborationApi,
  "getCurrentCanvasAccess" | "mutateCurrentCanvasAccess"
>;

export type UseCurrentCanvasAccessArgs = {
  api: CurrentCanvasAccessApi | null;
  canvasId: string | null | undefined;
  projectId?: string;
  status: {
    session: { phase: CollaborationSessionPhase };
    workspaceConnection: { status: ActiveWorkspaceConnectionStatus };
  } | null;
};

export type CurrentCanvasVisibilityScope = "project" | "canvas";

export type UseCurrentCanvasAccessResult = {
  view: CurrentCanvasAccessView | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  updateVisibility: (
    scopeKind: CurrentCanvasVisibilityScope,
    visibility: "private" | "shared"
  ) => Promise<AccessMutationResult | null>;
  grant: (
    humanPrincipalId: CurrentCanvasAccessView["people"][number]["humanPrincipalId"],
    role: "viewer" | "editor",
    scopeKind: CurrentCanvasVisibilityScope
  ) => Promise<AccessMutationResult | null>;
  revoke: (grant: ActiveCanvasPersonGrant) => Promise<AccessMutationResult | null>;
};

function canLoadCurrentCanvasAccess(
  args: UseCurrentCanvasAccessArgs
): args is UseCurrentCanvasAccessArgs & {
  api: CurrentCanvasAccessApi;
  canvasId: string;
} {
  return (
    args.api !== null &&
    typeof args.canvasId === "string" &&
    args.canvasId.length > 0 &&
    (args.status?.workspaceConnection.status === "connected" ||
      isCollaborationSessionConnected(args.status))
  );
}

/** Current-canvas ACL state is loaded only for an explicit Workspace or collaboration session. */
export function useCurrentCanvasAccess(
  args: UseCurrentCanvasAccessArgs
): UseCurrentCanvasAccessResult {
  const { api, canvasId, projectId, status } = args;
  const workspaceConnectionStatus = status?.workspaceConnection.status ?? "local_only";
  const sessionPhase = status?.session.phase ?? "idle";
  const generation = useRef(0);
  const [view, setView] = useState<CurrentCanvasAccessView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const id = ++generation.current;
    const currentArgs = {
      api,
      canvasId,
      status: {
        session: { phase: sessionPhase },
        workspaceConnection: { status: workspaceConnectionStatus }
      }
    };
    if (!canLoadCurrentCanvasAccess(currentArgs)) {
      setView(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await currentArgs.api.getCurrentCanvasAccess({
        canvasId: currentArgs.canvasId,
        ...(projectId ? { projectId } : {})
      });
      if (id === generation.current) setView(next);
    } catch (nextError) {
      if (id === generation.current) {
        setView(null);
        setError(collaborationErrorMessage(nextError));
      }
    } finally {
      if (id === generation.current) setLoading(false);
    }
  }, [api, canvasId, projectId, sessionPhase, workspaceConnectionStatus]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  const mutate = useCallback(
    async (
      request: CollaborationAccessMutationInput["request"]
    ): Promise<AccessMutationResult | null> => {
      const currentArgs = {
        api,
        canvasId,
        status: {
          session: { phase: sessionPhase },
          workspaceConnection: { status: workspaceConnectionStatus }
        }
      };
      if (!canLoadCurrentCanvasAccess(currentArgs) || !view || busy) return null;
      const input: CollaborationAccessMutationInput = {
        canvasId: view.scope.canvasId,
        ...(projectId ? { projectId } : {}),
        request
      };
      setBusy(true);
      setError(null);
      try {
        const result = await currentArgs.api.mutateCurrentCanvasAccess(input);
        if (result.status === "conflict") {
          setError(result.reason);
        } else if (result.status === "denied") {
          setError(result.reason);
        }
        await refresh();
        return result;
      } catch (nextError) {
        setError(collaborationErrorMessage(nextError));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, busy, canvasId, projectId, refresh, sessionPhase, view, workspaceConnectionStatus]
  );

  const scopeFor = useCallback(
    (scopeKind: CurrentCanvasVisibilityScope) => {
      if (!view) return null;
      return scopeKind === "project"
        ? {
            scope: {
              scopeKind: "project" as const,
              workspaceId: view.scope.workspaceId,
              projectId: view.scope.projectId,
              canvasId: null
            },
            expectedAclRevision: view.projectAclRevision
          }
        : { scope: view.scope, expectedAclRevision: view.canvasAclRevision };
    },
    [view]
  );

  const updateVisibility = useCallback(
    async (scopeKind: CurrentCanvasVisibilityScope, visibility: "private" | "shared") => {
      const target = scopeFor(scopeKind);
      return target ? mutate({ operation: "visibility", ...target, visibility }) : null;
    },
    [mutate, scopeFor]
  );

  const grant = useCallback(
    async (
      humanPrincipalId: CurrentCanvasAccessView["people"][number]["humanPrincipalId"],
      role: "viewer" | "editor",
      scopeKind: CurrentCanvasVisibilityScope
    ) => {
      const target = scopeFor(scopeKind);
      return target ? mutate({ operation: "grant", ...target, humanPrincipalId, role }) : null;
    },
    [mutate, scopeFor]
  );

  const revoke = useCallback(
    async (grantToRevoke: ActiveCanvasPersonGrant) => {
      const target = scopeFor(grantToRevoke.scopeKind);
      return target
        ? mutate({ operation: "revoke", ...target, grantId: grantToRevoke.grantId })
        : null;
    },
    [mutate, scopeFor]
  );

  return { view, loading, error, busy, refresh, updateVisibility, grant, revoke };
}
