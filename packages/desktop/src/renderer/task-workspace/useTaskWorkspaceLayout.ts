import { useEffect, useMemo, useState } from "react";

const defaultTimelineWidth = 280;
const defaultInspectorWidth = 320;
const minPanelWidth = 220;
const maxPanelWidth = 520;

function clampPanelWidth(width: number): number {
  return Math.min(maxPanelWidth, Math.max(minPanelWidth, Math.round(width)));
}

export function useTaskWorkspaceLayout(sessionKey: string) {
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [timelineWidth, setTimelineWidthState] = useState(defaultTimelineWidth);
  const [inspectorWidth, setInspectorWidthState] = useState(defaultInspectorWidth);

  useEffect(() => {
    setTimelineCollapsed(false);
    setInspectorCollapsed(false);
    setTimelineWidthState(defaultTimelineWidth);
    setInspectorWidthState(defaultInspectorWidth);
  }, [sessionKey]);

  return useMemo(
    () => ({
      inspectorCollapsed,
      inspectorWidth,
      setInspectorCollapsed,
      setInspectorWidth: (width: number) => setInspectorWidthState(clampPanelWidth(width)),
      setTimelineCollapsed,
      setTimelineWidth: (width: number) => setTimelineWidthState(clampPanelWidth(width)),
      timelineCollapsed,
      timelineWidth
    }),
    [inspectorCollapsed, inspectorWidth, timelineCollapsed, timelineWidth]
  );
}

export type TaskWorkspaceLayout = ReturnType<typeof useTaskWorkspaceLayout>;
