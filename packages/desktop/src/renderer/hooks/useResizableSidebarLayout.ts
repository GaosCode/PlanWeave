import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction
} from "react";
import { desktopSidebarWidthBounds } from "../settings";
import type { DesktopUiSettings } from "../types";

export type ResizableSidebarSide = "left" | "right";

type SidebarLayoutSettingsPatch = {
  leftSidebar?: Partial<DesktopUiSettings["layout"]["leftSidebar"]>;
  rightSidebar?: Partial<DesktopUiSettings["layout"]["rightSidebar"]>;
};

type UseResizableSidebarLayoutArgs = {
  initialLayout: DesktopUiSettings["layout"];
  onLayoutPatch: (patch: SidebarLayoutSettingsPatch) => void;
};

type UseResizableSidebarLayoutResult = {
  leftSidebarCollapsed: boolean;
  rightSidebarCollapsed: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  setLeftSidebarCollapsedPreference: Dispatch<SetStateAction<boolean>>;
  setRightSidebarCollapsedPreference: Dispatch<SetStateAction<boolean>>;
  startSidebarResize: (event: ReactPointerEvent, side: ResizableSidebarSide) => void;
};

function clampSidebarWidth(width: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

export function useResizableSidebarLayout({
  initialLayout,
  onLayoutPatch
}: UseResizableSidebarLayoutArgs): UseResizableSidebarLayoutResult {
  const cleanupResizeRef = useRef<(() => void) | null>(null);
  const activeResizeSideRef = useRef<ResizableSidebarSide | null>(null);
  const localInteractionRef = useRef({
    leftCollapsed: false,
    leftWidth: false,
    rightCollapsed: false,
    rightWidth: false
  });
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(
    () => initialLayout.leftSidebar.collapsed
  );
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(
    () => initialLayout.rightSidebar.collapsed
  );
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() =>
    clampSidebarWidth(initialLayout.leftSidebar.width, desktopSidebarWidthBounds.left)
  );
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() =>
    clampSidebarWidth(initialLayout.rightSidebar.width, desktopSidebarWidthBounds.right)
  );

  useEffect(() => {
    if (!localInteractionRef.current.leftCollapsed) {
      setLeftSidebarCollapsed(initialLayout.leftSidebar.collapsed);
    }
    if (!localInteractionRef.current.rightCollapsed) {
      setRightSidebarCollapsed(initialLayout.rightSidebar.collapsed);
    }
    if (activeResizeSideRef.current !== "left" && !localInteractionRef.current.leftWidth) {
      setLeftSidebarWidth(
        clampSidebarWidth(initialLayout.leftSidebar.width, desktopSidebarWidthBounds.left)
      );
    }
    if (activeResizeSideRef.current !== "right" && !localInteractionRef.current.rightWidth) {
      setRightSidebarWidth(
        clampSidebarWidth(initialLayout.rightSidebar.width, desktopSidebarWidthBounds.right)
      );
    }
  }, [
    initialLayout.leftSidebar.collapsed,
    initialLayout.leftSidebar.width,
    initialLayout.rightSidebar.collapsed,
    initialLayout.rightSidebar.width
  ]);

  const setLeftSidebarCollapsedPreference: Dispatch<SetStateAction<boolean>> = useCallback(
    (action) => {
      setLeftSidebarCollapsed((current) => {
        localInteractionRef.current.leftCollapsed = true;
        const collapsed = typeof action === "function" ? action(current) : action;
        onLayoutPatch({ leftSidebar: { collapsed } });
        return collapsed;
      });
    },
    [onLayoutPatch]
  );

  const setRightSidebarCollapsedPreference: Dispatch<SetStateAction<boolean>> = useCallback(
    (action) => {
      setRightSidebarCollapsed((current) => {
        localInteractionRef.current.rightCollapsed = true;
        const collapsed = typeof action === "function" ? action(current) : action;
        onLayoutPatch({ rightSidebar: { collapsed } });
        return collapsed;
      });
    },
    [onLayoutPatch]
  );

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent, side: ResizableSidebarSide) => {
      event.preventDefault();
      cleanupResizeRef.current?.();
      activeResizeSideRef.current = side;
      if (side === "left") {
        localInteractionRef.current.leftWidth = true;
      } else {
        localInteractionRef.current.rightWidth = true;
      }

      const startX = event.clientX;
      const startWidth = side === "left" ? leftSidebarWidth : rightSidebarWidth;
      const bounds =
        side === "left" ? desktopSidebarWidthBounds.left : desktopSidebarWidthBounds.right;
      const updateWidth = side === "left" ? setLeftSidebarWidth : setRightSidebarWidth;
      const previousCursor = window.document.body.style.cursor;
      const previousUserSelect = window.document.body.style.userSelect;
      let finalWidth = clampSidebarWidth(startWidth, bounds);

      window.document.body.style.cursor = "col-resize";
      window.document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        finalWidth = clampSidebarWidth(
          side === "left" ? startWidth + delta : startWidth - delta,
          bounds
        );
        updateWidth(finalWidth);
      };

      const cleanupResize = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        window.document.body.style.cursor = previousCursor;
        window.document.body.style.userSelect = previousUserSelect;
        if (cleanupResizeRef.current === cleanupResize) {
          cleanupResizeRef.current = null;
          activeResizeSideRef.current = null;
        }
      };

      const stopResize = () => {
        cleanupResize();
        onLayoutPatch(
          side === "left"
            ? { leftSidebar: { width: finalWidth } }
            : { rightSidebar: { width: finalWidth } }
        );
      };

      cleanupResizeRef.current = cleanupResize;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
    [leftSidebarWidth, onLayoutPatch, rightSidebarWidth]
  );

  useEffect(() => () => cleanupResizeRef.current?.(), []);

  return {
    leftSidebarCollapsed,
    leftSidebarWidth,
    rightSidebarCollapsed,
    rightSidebarWidth,
    setLeftSidebarCollapsedPreference,
    setRightSidebarCollapsedPreference,
    startSidebarResize
  };
}
