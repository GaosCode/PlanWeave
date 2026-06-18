import type { createTranslator } from "../i18n";
import { HistoryNavigationButtons } from "./HistoryNavigationButtons";

type WindowTitleBarProps = {
  t: ReturnType<typeof createTranslator>;
};

export function WindowTitleBar({ t }: WindowTitleBarProps) {
  return (
    <header className="app-drag-region flex h-11 shrink-0 items-center gap-1 border-b border-border/80 bg-app-topbar px-3 pl-24 text-foreground">
      <div className="app-no-drag flex items-center gap-1">
        <HistoryNavigationButtons t={t} />
      </div>
    </header>
  );
}
