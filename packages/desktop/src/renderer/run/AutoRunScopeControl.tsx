import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator
} from "@/components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { AutoRunScopeMode } from "../types";
import type { AutoRunScopeModeSetter, FloatingAutoRunTranslator } from "./floatingAutoRunTypes";

type AutoRunScopeControlProps = {
  autoRunScopeMode: AutoRunScopeMode;
  hasProject: boolean;
  selectedBlockPresent: boolean;
  selectedTaskPanelId: string | null;
  setAutoRunScopeMode: AutoRunScopeModeSetter;
  t: FloatingAutoRunTranslator;
};

type AutoRunScopeContextMenuProps = AutoRunScopeControlProps & {
  setMiniRunPanelOpen: (open: boolean) => void;
};

export function AutoRunScopeContextMenu({
  autoRunScopeMode,
  hasProject,
  selectedBlockPresent,
  selectedTaskPanelId,
  setAutoRunScopeMode,
  setMiniRunPanelOpen,
  t
}: AutoRunScopeContextMenuProps) {
  return (
    <ContextMenuContent>
      <ContextMenuLabel>{t("autoRunScope")}</ContextMenuLabel>
      <ContextMenuRadioGroup
        value={autoRunScopeMode}
        onValueChange={(value) => setAutoRunScopeMode(value as AutoRunScopeMode)}
      >
        <ContextMenuRadioItem disabled={!hasProject} value="project">
          {t("projectScope")}
        </ContextMenuRadioItem>
        <ContextMenuRadioItem
          disabled={!hasProject || (!selectedTaskPanelId && !selectedBlockPresent)}
          value="selectedTask"
        >
          {t("selectedTaskScope")}
        </ContextMenuRadioItem>
        <ContextMenuRadioItem disabled={!hasProject || !selectedBlockPresent} value="selectedBlock">
          {t("selectedBlockScope")}
        </ContextMenuRadioItem>
      </ContextMenuRadioGroup>
      <ContextMenuSeparator />
      <ContextMenuItem data-testid="auto-run-open-panel" onSelect={() => setMiniRunPanelOpen(true)}>
        {t("miniRunPanel")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

export function AutoRunScopeControl({
  autoRunScopeMode,
  hasProject,
  selectedBlockPresent,
  selectedTaskPanelId,
  setAutoRunScopeMode,
  t
}: AutoRunScopeControlProps) {
  return (
    <Select
      value={autoRunScopeMode}
      onValueChange={(value) => setAutoRunScopeMode(value as AutoRunScopeMode)}
    >
      <SelectTrigger className="h-9 w-36" disabled={!hasProject} title={t("autoRunScope")}>
        <SelectValue aria-label={t("autoRunScope")} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="project">{t("projectScope")}</SelectItem>
          <SelectItem disabled={!selectedTaskPanelId && !selectedBlockPresent} value="selectedTask">
            {t("selectedTaskScope")}
          </SelectItem>
          <SelectItem disabled={!selectedBlockPresent} value="selectedBlock">
            {t("selectedBlockScope")}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
