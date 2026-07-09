import { ComponentIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { createTranslator } from "../i18n";
import type { DesktopUiSettings, PaletteDropComponent } from "../types";

type ComponentPaletteProps = {
  addPaletteComponent: (type: PaletteDropComponent) => Promise<void>;
  handlePaletteDragStart: (event: React.DragEvent, type: PaletteDropComponent) => void;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
};

export function ComponentPalette({
  addPaletteComponent,
  handlePaletteDragStart,
  settings,
  t
}: ComponentPaletteProps) {
  const renderPaletteButton = (type: PaletteDropComponent, label: string) => (
    <Button
      className="h-9 justify-start border-border/80 bg-surface-raised text-text hover:bg-surface-muted hover:text-text-strong active:bg-state-selected-surface [&_svg]:size-4"
      draggable
      variant="outline"
      onClick={() => void addPaletteComponent(type)}
      onDragStart={(event) => handlePaletteDragStart(event, type)}
    >
      <ComponentIcon data-icon="inline-start" />
      {label}
    </Button>
  );

  return (
    <>
      <div className="grid grid-cols-1 gap-3 bg-app-panel p-3 pt-4 text-text">
        <div>
          <div className="text-sm font-semibold text-text-strong">{t("componentPalette")}</div>
          {settings.palette.dragHint ? (
            <div className="mt-1 text-xs leading-5 text-text-muted">{t("dragHint")}</div>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.08em] text-text-faint">
            {t("nodeComponents")}
          </div>
          {settings.palette.visible.task ? renderPaletteButton("task", t("taskNode")) : null}
        </div>
        <div className="grid grid-cols-1 gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.08em] text-text-faint">
            {t("blockComponents")}
          </div>
          {settings.palette.visible.implementation
            ? renderPaletteButton("implementation", t("implementationBlock"))
            : null}
          {settings.palette.visible.review ? renderPaletteButton("review", t("reviewBlock")) : null}
        </div>
      </div>
      <Separator className="bg-border/80" />
    </>
  );
}
