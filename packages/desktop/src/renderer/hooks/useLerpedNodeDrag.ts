import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { applyNodeChanges } from "@xyflow/react";
import type {
  Node,
  NodeChange,
  NodePositionChange,
  OnNodesChange,
  XYPosition
} from "@xyflow/react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const DEFAULT_DRAG_LERP_ALPHA = 0.78;
const DEFAULT_DRAG_LERP_EPSILON = 0.5;

type UseLerpedNodeDragOptions<NodeType extends Node> = {
  nodes: NodeType[];
  setNodes: Dispatch<SetStateAction<NodeType[]>>;
  onNodesChange: OnNodesChange<NodeType>;
  enabled: boolean;
  scopeKey: string;
  alpha?: number;
  epsilon?: number;
};

type DragTarget = {
  position: XYPosition;
};

type PendingDragFrame = {
  id: number;
  targets: ReadonlyMap<string, DragTarget>;
};

type DragStopFallback = {
  id: string;
  position: XYPosition;
};

type AnimatedDragPositionChange = NodePositionChange & {
  dragging: true;
  position: XYPosition;
};

function supportsReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function withoutPosition(change: NodePositionChange): NodePositionChange {
  return {
    id: change.id,
    type: "position",
    dragging: change.dragging
  };
}

function isAnimatedDragPositionChange<NodeType extends Node>(
  change: NodeChange<NodeType>
): change is AnimatedDragPositionChange {
  return change.type === "position" && change.dragging === true && change.position !== undefined;
}

function lerpNumber(current: number, target: number, alpha: number) {
  return current + (target - current) * alpha;
}

function isNearPosition(current: XYPosition, target: XYPosition, epsilon: number) {
  return Math.abs(current.x - target.x) <= epsilon && Math.abs(current.y - target.y) <= epsilon;
}

function lerpPosition(current: XYPosition, target: XYPosition, alpha: number): XYPosition {
  return {
    x: lerpNumber(current.x, target.x, alpha),
    y: lerpNumber(current.y, target.y, alpha)
  };
}

function commitPositions<NodeType extends Node>(
  nodes: NodeType[],
  targets: Map<string, DragTarget>,
  fallbackNode?: DragStopFallback
): NodeType[] {
  if (targets.size === 0 && !fallbackNode) {
    return nodes;
  }

  let moved = false;
  const committedNodes = nodes.map((node) => {
    const targetPosition =
      targets.get(node.id)?.position ??
      (fallbackNode?.id === node.id ? fallbackNode.position : undefined);
    if (!targetPosition) {
      return node;
    }
    moved = true;
    return {
      ...node,
      position: targetPosition
    };
  });

  return moved ? committedNodes : nodes;
}

export function useLerpedNodeDrag<NodeType extends Node>({
  nodes,
  setNodes,
  onNodesChange,
  enabled,
  scopeKey,
  alpha = DEFAULT_DRAG_LERP_ALPHA,
  epsilon = DEFAULT_DRAG_LERP_EPSILON
}: UseLerpedNodeDragOptions<NodeType>) {
  const targetsRef = useRef(new Map<string, DragTarget>());
  const latestNodesRef = useRef(nodes);
  const frameRef = useRef<number | null>(null);
  const pendingFrameRef = useRef<PendingDragFrame | null>(null);
  const scope = useMemo(() => ({ key: scopeKey }), [scopeKey]);
  const activeScopeRef = useRef<typeof scope | null>(null);
  const [systemReducedMotion, setSystemReducedMotion] = useState(supportsReducedMotion);
  const [isAnimating, setIsAnimating] = useState(false);
  const [appliedFrameId, setAppliedFrameId] = useState<number | null>(null);
  const shouldAnimate = enabled && !systemReducedMotion;

  const cancelFrame = useCallback(() => {
    if (frameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const clearTargets = useCallback(() => {
    targetsRef.current.clear();
    pendingFrameRef.current = null;
    cancelFrame();
    setIsAnimating(false);
  }, [cancelFrame]);

  useLayoutEffect(() => {
    activeScopeRef.current = scope;
    setIsAnimating(false);
    return () => {
      activeScopeRef.current = null;
      targetsRef.current.clear();
      pendingFrameRef.current = null;
      cancelFrame();
    };
  }, [cancelFrame, scope]);

  const tick = useCallback(
    (frameId: number) => {
      if (activeScopeRef.current !== scope || frameRef.current !== frameId) {
        return;
      }
      frameRef.current = null;
      const targets = new Map(targetsRef.current);
      pendingFrameRef.current = { id: frameId, targets };

      setNodes((currentNodes) => {
        if (activeScopeRef.current !== scope) {
          return currentNodes;
        }
        let moved = false;
        const nextNodes = currentNodes.map((node) => {
          const target = targets.get(node.id);
          if (!target) {
            return node;
          }
          moved = true;
          return {
            ...node,
            position: isNearPosition(node.position, target.position, epsilon)
              ? target.position
              : lerpPosition(node.position, target.position, alpha)
          };
        });
        return moved ? nextNodes : currentNodes;
      });
      setAppliedFrameId(frameId);
    },
    [alpha, epsilon, scope, setNodes]
  );

  const scheduleFrame = useCallback(() => {
    if (frameRef.current !== null || pendingFrameRef.current !== null) {
      return;
    }
    setIsAnimating(true);
    const frameId = window.requestAnimationFrame(() => tick(frameId));
    frameRef.current = frameId;
  }, [tick]);

  useLayoutEffect(() => {
    latestNodesRef.current = nodes;
  }, [nodes]);

  useLayoutEffect(() => {
    if (!shouldAnimate) {
      clearTargets();
    }
  }, [clearTargets, shouldAnimate]);

  useLayoutEffect(() => {
    const pendingFrame = pendingFrameRef.current;
    if (!pendingFrame || pendingFrame.id !== appliedFrameId) {
      return;
    }
    pendingFrameRef.current = null;

    const { targets } = pendingFrame;
    const nextTargets = new Map<string, DragTarget>();
    let remainingTargets = targets.size;
    for (const node of nodes) {
      const target = targets.get(node.id);
      if (!target) {
        continue;
      }
      if (node.position.x !== target.position.x || node.position.y !== target.position.y) {
        nextTargets.set(node.id, target);
      }
      remainingTargets -= 1;
      if (remainingTargets === 0) {
        break;
      }
    }
    for (const [id, target] of targetsRef.current) {
      if (targets.get(id) !== target) {
        nextTargets.set(id, target);
      }
    }
    targetsRef.current = nextTargets;

    if (nextTargets.size > 0) {
      scheduleFrame();
    } else {
      setIsAnimating(false);
    }
  }, [appliedFrameId, nodes, scheduleFrame]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = () => setSystemReducedMotion(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const handleNodesChange = useCallback<OnNodesChange<NodeType>>(
    (changes) => {
      if (activeScopeRef.current !== scope) {
        return;
      }
      if (!shouldAnimate) {
        latestNodesRef.current = applyNodeChanges(changes, latestNodesRef.current);
        onNodesChange(changes);
        return;
      }

      const directChanges: NodeChange<NodeType>[] = [];
      let recordedTarget = false;

      for (const change of changes) {
        if (isAnimatedDragPositionChange(change)) {
          targetsRef.current.set(change.id, { position: change.position });
          directChanges.push(withoutPosition(change));
          recordedTarget = true;
        } else {
          directChanges.push(change);
        }
      }

      if (directChanges.length > 0) {
        latestNodesRef.current = applyNodeChanges(directChanges, latestNodesRef.current);
        onNodesChange(directChanges);
      }
      if (recordedTarget) {
        scheduleFrame();
      }
    },
    [onNodesChange, scheduleFrame, scope, shouldAnimate]
  );

  const commitDragTargets = useCallback(
    (fallbackNode?: DragStopFallback) => {
      if (activeScopeRef.current !== scope) {
        return latestNodesRef.current;
      }
      const targets = new Map(targetsRef.current);
      clearTargets();

      const committedNodes = commitPositions(latestNodesRef.current, targets, fallbackNode);
      latestNodesRef.current = committedNodes;
      setNodes((currentNodes) => {
        if (activeScopeRef.current !== scope) {
          return currentNodes;
        }
        return commitPositions(currentNodes, targets, fallbackNode);
      });
      return committedNodes;
    },
    [clearTargets, scope, setNodes]
  );

  return useMemo(
    () => ({
      commitDragTargets,
      isAnimating,
      onNodesChange: handleNodesChange
    }),
    [commitDragTargets, handleNodesChange, isAnimating]
  );
}
