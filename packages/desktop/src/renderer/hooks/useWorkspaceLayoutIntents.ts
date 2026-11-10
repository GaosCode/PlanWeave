import { useCallback, useLayoutEffect, useMemo, useState, useRef } from "react";
import type { DesktopLayout } from "@planweave-ai/runtime";
import type { WorkspaceCanvasSessionView } from "./useWorkspaceCanvasSession";
import type { WorkspaceCanvasSubmitResult } from "./useWorkspaceCanvasCommands";

type LayoutNode = DesktopLayout["nodes"][number];
type LayoutIntent = {
  nodes: LayoutNode[];
  defaults: LayoutNode[];
  updatedAt: string;
};
export type WorkspaceLayoutIntents = {
  layout: DesktopLayout | null;
  stageLayout: (intent: LayoutIntent) => {
    discard: () => void;
    submit: (isOwnerCurrent: () => boolean) => Promise<WorkspaceCanvasSubmitResult>;
  };
};

function mergeNodes(base: LayoutNode[], patch: LayoutNode[]): LayoutNode[] {
  const nodes = new Map(base.map((node) => [node.nodeId, node]));
  for (const node of patch) nodes.set(node.nodeId, node);
  return [...nodes.values()];
}

export function useWorkspaceLayoutIntents(
  session: WorkspaceCanvasSessionView
): WorkspaceLayoutIntents {
  const scope = useMemo(
    () => ({ authority: session.sessionAuthority, pending: new Set<LayoutIntent>() }),
    [session.sessionAuthority]
  );
  const activeScope = useRef<typeof scope | null>(null);
  const [pending, setPending] = useState({ scope, intents: [] as LayoutIntent[] });
  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = null;
      scope.pending.clear();
    };
  }, [scope]);
  const stageLayout = useCallback(
    (intent: LayoutIntent) => {
      if (activeScope.current === scope) {
        scope.pending.add(intent);
        setPending({ scope, intents: [...scope.pending] });
      }
      const discard = () => {
        const removed = scope.pending.delete(intent);
        if (removed && activeScope.current === scope)
          setPending({ scope, intents: [...scope.pending] });
      };
      return {
        discard,
        submit: async (isOwnerCurrent: () => boolean): Promise<WorkspaceCanvasSubmitResult> => {
          if (activeScope.current !== scope) {
            return { status: "retired", ok: false, error: null, staleConflict: null };
          }
          try {
            const replica = session.readProjection();
            if (!replica) throw new Error("Workspace layout authority is unavailable.");
            const taskIds = new Set(replica.content.tasks.map((task) => task.taskId));
            const nodes = mergeNodes(
              mergeNodes(intent.defaults, replica.content.layout.nodes),
              intent.nodes
            ).filter((node) => taskIds.has(node.nodeId));
            return await session.submit({
              intent: { kind: "update_layout", nodes, updatedAt: intent.updatedAt },
              isOwnerCurrent
            });
          } finally {
            discard();
          }
        }
      };
    },
    [scope, session.readProjection, session.submit]
  );
  const base = session.projection?.content.layout ?? null;
  const layout = useMemo(() => {
    let visible = base;
    for (const intent of pending.scope === scope ? pending.intents : []) {
      if (visible)
        visible = {
          ...visible,
          nodes: mergeNodes(visible.nodes, intent.nodes),
          updatedAt: intent.updatedAt
        };
    }
    return visible;
  }, [base, scope, pending]);
  return useMemo(() => ({ layout, stageLayout }), [layout, stageLayout]);
}
