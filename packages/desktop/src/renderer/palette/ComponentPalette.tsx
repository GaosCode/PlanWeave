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

export function ComponentPalette({ addPaletteComponent, handlePaletteDragStart, settings, t }: ComponentPaletteProps) {
  const renderPaletteButton = (type: PaletteDropComponent, label: string) => (
    <Button className="justify-start" draggable variant="outline" onClick={() => void addPaletteComponent(type)} onDragStart={(event) => handlePaletteDragStart(event, type)}>
      <ComponentIcon data-icon="inline-start" />
      {label}
    </Button>
  );

  return (
    <>
      <div className="grid grid-cols-1 gap-3 p-3 pt-4">
        <div className="text-sm font-semibold">{t("componentPalette")}</div>
        {settings.palette.dragHint ? <div className="text-xs text-muted-foreground">{t("dragHint")}</div> : null}
        <div className="grid grid-cols-1 gap-2">
          <div className="text-xs font-medium text-muted-foreground">{t("nodeComponents")}</div>
          {settings.palette.visible.task ? renderPaletteButton("task", t("taskNode")) : null}
        </div>
        <div className="grid grid-cols-1 gap-2">
          <div className="text-xs font-medium text-muted-foreground">{t("blockComponents")}</div>
          {settings.palette.visible.implementation ? renderPaletteButton("implementation", t("implementationBlock")) : null}
          {settings.palette.visible.review ? renderPaletteButton("review", t("reviewBlock")) : null}
        </div>
      </div>
      <Separator />
    </>
  );
}
