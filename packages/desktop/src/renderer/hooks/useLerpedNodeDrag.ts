import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  alpha?: number;
  epsilon?: number;
};

type DragTarget = {
  position: XYPosition;
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
  alpha = DEFAULT_DRAG_LERP_ALPHA,
  epsilon = DEFAULT_DRAG_LERP_EPSILON
}: UseLerpedNodeDragOptions<NodeType>) {
  const targetsRef = useRef(new Map<string, DragTarget>());
  const latestNodesRef = useRef(nodes);
  const frameRef = useRef<number | null>(null);
  const [systemReducedMotion, setSystemReducedMotion] = useState(supportsReducedMotion);
  const [isAnimating, setIsAnimating] = useState(false);
  const shouldAnimate = enabled && !systemReducedMotion;
  latestNodesRef.current = nodes;

  const cancelFrame = useCallback(() => {
    if (frameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const stopAnimation = useCallback(() => {
    cancelFrame();
    setIsAnimating(false);
  }, [cancelFrame]);

  const tick = useCallback(() => {
    frameRef.current = null;
    if (targetsRef.current.size === 0) {
      setIsAnimating(false);
      return;
    }

    const activeTargets = new Map(targetsRef.current);
    const nextTargets = new Map<string, DragTarget>();
    for (const [nodeId, target] of activeTargets) {
      const node = latestNodesRef.current.find((currentNode) => currentNode.id === nodeId);
      if (node && !isNearPosition(node.position, target.position, epsilon)) {
        nextTargets.set(nodeId, target);
      }
    }
    targetsRef.current = nextTargets;

    setNodes((currentNodes) => {
      let moved = false;
      const nextNodes = currentNodes.map((node) => {
        const target = activeTargets.get(node.id);
        if (!target) {
          return node;
        }

        if (isNearPosition(node.position, target.position, epsilon)) {
          moved = true;
          return {
            ...node,
            position: target.position
          };
        }

        moved = true;
        return {
          ...node,
          position: lerpPosition(node.position, target.position, alpha)
        };
      });

      if (moved) {
        latestNodesRef.current = nextNodes;
      }
      return moved ? nextNodes : currentNodes;
    });

    if (targetsRef.current.size > 0) {
      frameRef.current = window.requestAnimationFrame(tick);
      return;
    }
    setIsAnimating(false);
  }, [alpha, epsilon, setNodes]);

  const scheduleFrame = useCallback(() => {
    if (frameRef.current !== null) {
      return;
    }
    setIsAnimating(true);
    frameRef.current = window.requestAnimationFrame(tick);
  }, [tick]);

  const clearTargets = useCallback(() => {
    targetsRef.current.clear();
    stopAnimation();
  }, [stopAnimation]);

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

  useEffect(() => {
    if (!shouldAnimate) {
      clearTargets();
    }
  }, [clearTargets, shouldAnimate]);

  useEffect(
    () => () => {
      targetsRef.current.clear();
      cancelFrame();
    },
    [cancelFrame]
  );

  const handleNodesChange = useCallback<OnNodesChange<NodeType>>(
    (changes) => {
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
    [onNodesChange, scheduleFrame, shouldAnimate]
  );

  const commitDragTargets = useCallback(
    (fallbackNode?: DragStopFallback) => {
      const targets = new Map(targetsRef.current);
      targetsRef.current.clear();
      stopAnimation();

      const committedNodes = commitPositions(latestNodesRef.current, targets, fallbackNode);
      latestNodesRef.current = committedNodes;
      setNodes((currentNodes) => {
        const nextNodes = commitPositions(currentNodes, targets, fallbackNode);
        latestNodesRef.current = nextNodes;
        return nextNodes;
      });
      return committedNodes;
    },
    [setNodes, stopAnimation]
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
