import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import { PanelLeftOpenIcon, PanelRightCloseIcon } from "lucide-react";
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
  if (rightSidebarCollapsed) {
    return null;
  }

  return (
    <aside className="relative flex shrink-0 flex-col overflow-hidden border-l bg-background" style={{ width }}>
      {onResizeStart ? (
        <div
          aria-label={t("resizeSidebar")}
          aria-orientation="vertical"
          className="app-no-drag absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-border active:bg-ring"
          role="separator"
          tabIndex={0}
          onPointerDown={onResizeStart}
        />
      ) : null}
      <div className="app-drag-region flex h-11 shrink-0 items-center justify-end border-b px-2">
        <Button className="app-no-drag" size="icon-sm" variant="ghost" aria-label={t("collapseSidebar")} onClick={() => setRightSidebarCollapsed(true)}>
          <PanelRightCloseIcon data-icon="inline-start" />
        </Button>
      </div>
      <ComponentPalette addPaletteComponent={addPaletteComponent} handlePaletteDragStart={handlePaletteDragStart} settings={settings} t={t} />
    </aside>
  );
}

export function CollapsedSidebarControls({
  leftSidebarCollapsed,
  rightSidebarCollapsed,
  setLeftSidebarCollapsed,
  setRightSidebarCollapsed,
  t
}: Pick<AppSidebarsProps, "leftSidebarCollapsed" | "rightSidebarCollapsed" | "setLeftSidebarCollapsed" | "setRightSidebarCollapsed" | "t">) {
  return (
    <>
      {leftSidebarCollapsed ? (
        <div className="app-drag-region absolute left-0 top-0 z-20 flex h-11 w-[280px] items-center border-b bg-background px-3 pl-[124px]">
          <div className="app-no-drag flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" aria-label={t("expandSidebar")} onClick={() => setLeftSidebarCollapsed(false)}>
              <PanelLeftOpenIcon data-icon="inline-start" />
            </Button>
            <HistoryNavigationButtons t={t} />
          </div>
        </div>
      ) : null}
      {rightSidebarCollapsed ? (
        <div className="app-drag-region absolute right-0 top-0 z-30 flex h-11 w-11 items-center justify-center border-b bg-background">
          <Button className="app-no-drag" size="icon-sm" variant="ghost" aria-label={t("expandSidebar")} onClick={() => setRightSidebarCollapsed(false)}>
            <PanelRightCloseIcon data-icon="inline-start" />
          </Button>
        </div>
      ) : null}
    </>
  );
}
