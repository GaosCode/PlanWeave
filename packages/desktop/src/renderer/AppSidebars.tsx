import { useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { MoveIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PanelRightCloseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "./i18n";
import { ComponentPalette } from "./palette/ComponentPalette";
import type { DesktopUiSettings, PaletteDropComponent } from "./types";
import { HistoryNavigationButtons } from "./components/HistoryNavigationButtons";

type AppSidebarsProps = {
  addPaletteComponent: (type: PaletteDropComponent) => Promise<void>;
  handlePaletteDragStart: (event: React.DragEvent, type: PaletteDropComponent) => void;
  leftSidebarCollapsed: boolean;
  onResizeStart?: (event: ReactPointerEvent) => void;
  rightSidebarCollapsed: boolean;
  setLeftSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  setRightSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  width?: number;
};

type FloatingSidebarPosition = { left: number; top: number };

export function RightPaletteSidebar({
  addPaletteComponent,
  handlePaletteDragStart,
  onResizeStart,
  rightSidebarCollapsed,
  setRightSidebarCollapsed,
  settings,
  t,
  width = 300
}: Pick<AppSidebarsProps, "addPaletteComponent" | "handlePaletteDragStart" | "onResizeStart" | "rightSidebarCollapsed" | "setRightSidebarCollapsed" | "settings" | "t" | "width">) {
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const collapsedDragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const collapsedHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressCollapsedClickRef = useRef(false);
  const [position, setPosition] = useState<FloatingSidebarPosition | null>(null);
  const [hoverExpanded, setHoverExpanded] = useState(false);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    const panel = panelRef.current;
    const container = panel?.parentElement;
    if (!panel || !container) {
      return;
    }
    const bounds = panel.getBoundingClientRect();
    dragRef.current = { offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    const container = panel?.parentElement;
    const drag = dragRef.current;
    if (!panel || !container || !drag) {
      return;
    }
    const containerBounds = container.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(event.clientX - containerBounds.left - drag.offsetX, containerBounds.width - panelBounds.width - 8)),
      top: Math.max(8, Math.min(event.clientY - containerBounds.top - drag.offsetY, containerBounds.height - panelBounds.height - 8))
    });
  };

  const stopDrag = () => {
    dragRef.current = null;
  };

  const clearCollapsedHoverTimer = () => {
    if (collapsedHoverTimerRef.current) {
      clearTimeout(collapsedHoverTimerRef.current);
      collapsedHoverTimerRef.current = null;
    }
  };

  const startCollapsedButtonDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    clearCollapsedHoverTimer();
    const button = event.currentTarget;
    const container = panelRef.current?.parentElement;
    if (!container) {
      return;
    }
    const bounds = button.getBoundingClientRect();
    collapsedDragRef.current = { offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
    suppressCollapsedClickRef.current = false;
    button.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveCollapsedButtonDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const container = panelRef.current?.parentElement;
    const drag = collapsedDragRef.current;
    if (!container || !drag) {
      return;
    }
    const containerBounds = container.getBoundingClientRect();
    const buttonLeft = event.clientX - containerBounds.left - drag.offsetX;
    const buttonTop = event.clientY - containerBounds.top - drag.offsetY;
    setPosition({
      left: Math.max(8, Math.min(buttonLeft - Math.max(0, width - 44), containerBounds.width - width - 8)),
      top: Math.max(8, Math.min(buttonTop, containerBounds.height - 44 - 8))
    });
    suppressCollapsedClickRef.current = true;
  };

  const stopCollapsedButtonDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    collapsedDragRef.current = null;
  };

  const scheduleHoverExpand = () => {
    clearCollapsedHoverTimer();
    collapsedHoverTimerRef.current = setTimeout(() => {
      setHoverExpanded(true);
      setRightSidebarCollapsed(false);
      collapsedHoverTimerRef.current = null;
    }, 180);
  };

  const collapseAfterHover = () => {
    if (!hoverExpanded) {
      return;
    }
    setHoverExpanded(false);
    setRightSidebarCollapsed(true);
  };

  const collapsedButtonStyle = position
    ? { left: position.left + Math.max(0, width - 44), top: position.top }
    : { right: 16, top: 64 };

  return (
    <>
      <aside
        aria-hidden={rightSidebarCollapsed}
        className="absolute z-30 flex max-h-[calc(100%-5rem)] flex-col overflow-hidden rounded-xl border border-border/80 bg-app-panel text-text shadow-xl transition-[opacity,clip-path] duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)]"
        ref={panelRef}
        onMouseLeave={collapseAfterHover}
        style={{ width, opacity: rightSidebarCollapsed ? 0 : 1, clipPath: rightSidebarCollapsed ? "inset(0 0 0 100%)" : "inset(0)", pointerEvents: rightSidebarCollapsed ? "none" : undefined, ...(position ?? { right: 16, top: 64 }) }}
      >
        <div className="w-[var(--sidebar-content-width)]" style={{ "--sidebar-content-width": `${width}px` } as React.CSSProperties}>
          <div
            className="app-no-drag flex h-10 shrink-0 touch-none select-none items-center justify-between border-b border-border/80 bg-app-topbar px-3"
            onPointerCancel={stopDrag}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={stopDrag}
          >
            <span className="flex items-center gap-2 text-sm font-medium"><MoveIcon className="size-3.5 text-text-faint" />{t("settingsComponents")}</span>
            <Button className="app-no-drag" size="icon-sm" variant="ghost" aria-label={t("collapseSidebar")} onClick={() => { setHoverExpanded(false); setRightSidebarCollapsed(true); }}>
              <PanelRightCloseIcon data-icon="inline-start" />
            </Button>
          </div>
          <ComponentPalette addPaletteComponent={addPaletteComponent} handlePaletteDragStart={handlePaletteDragStart} settings={settings} t={t} />
        </div>
      </aside>
      {rightSidebarCollapsed ? (
        <div
          className="app-drag-region absolute z-30 flex h-11 w-11 items-center justify-center rounded-xl border border-border/80 bg-app-topbar text-text animate-in fade-in zoom-in-95 duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-standard)]"
          onMouseEnter={scheduleHoverExpand}
          onMouseLeave={clearCollapsedHoverTimer}
          style={collapsedButtonStyle}
        >
          <Button
            className="app-no-drag cursor-move touch-none"
            size="icon-sm"
            variant="ghost"
            aria-label={t("expandSidebar")}
            onClick={() => {
              if (suppressCollapsedClickRef.current) {
                suppressCollapsedClickRef.current = false;
                return;
              }
              clearCollapsedHoverTimer();
              setHoverExpanded(false);
              setRightSidebarCollapsed(false);
            }}
            onPointerCancel={stopCollapsedButtonDrag}
            onPointerDown={startCollapsedButtonDrag}
            onPointerMove={moveCollapsedButtonDrag}
            onPointerUp={stopCollapsedButtonDrag}
          >
            <PanelRightCloseIcon data-icon="inline-start" />
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function CollapsedSidebarControls({
  leftSidebarCollapsed,
  setLeftSidebarCollapsed,
  t,
  width = 280
}: Pick<AppSidebarsProps, "leftSidebarCollapsed" | "setLeftSidebarCollapsed" | "t"> & { width?: number }) {
  const isMac = typeof navigator !== "undefined" && /mac|darwin/i.test(navigator.platform);
  return (
    <div
      className="app-drag-region absolute left-0 top-0 z-40 flex h-11 items-center gap-3 px-3 text-text"
      style={{
        width: leftSidebarCollapsed ? undefined : width,
        justifyContent: leftSidebarCollapsed ? "flex-start" : "flex-end",
        paddingLeft: (leftSidebarCollapsed && isMac) ? 78 : undefined,
      }}
    >
      <div className="app-no-drag flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={leftSidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
          onClick={() => setLeftSidebarCollapsed((current) => !current)}
        >
          {leftSidebarCollapsed ? <PanelLeftOpenIcon data-icon="inline-start" /> : <PanelLeftCloseIcon data-icon="inline-start" />}
        </Button>
        <HistoryNavigationButtons t={t} />
      </div>
    </div>
  );
}
