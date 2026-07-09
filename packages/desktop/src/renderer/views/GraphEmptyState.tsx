import { FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { createTranslator } from "../i18n";

type GraphEmptyStateProps = {
  handleOpenProject: () => Promise<void>;
  projectLoading: boolean;
  t: ReturnType<typeof createTranslator>;
};

export function GraphEmptyState({ handleOpenProject, projectLoading, t }: GraphEmptyStateProps) {
  if (projectLoading) {
    return (
      <div
        className="flex w-full max-w-[360px] flex-col gap-3 rounded-md border border-border/70 bg-surface-raised/70 p-4 shadow-sm"
        role="status"
        aria-live="polite"
      >
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        <span className="sr-only">{t("loadingProject")}</span>
      </div>
    );
  }

  return (
    <div className="flex max-w-[380px] flex-col gap-3 rounded-md border border-border/80 bg-surface-raised p-4 text-left shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/80 bg-surface-muted text-text-muted">
          <FolderOpenIcon className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-strong">{t("noProject")}</div>
          <div className="text-xs text-text-muted">{t("openProjectSecondaryHint")}</div>
        </div>
      </div>
      <div className="text-sm leading-5 text-text-muted">{t("openProjectHint")}</div>
      <div className="rounded-md border border-border/70 bg-surface-muted/70 px-3 py-2 text-xs text-text-muted">
        {t("exampleProjectHint")}
      </div>
      <Button
        className="h-8 w-fit gap-2 border-border/80 bg-surface-base text-text hover:bg-surface-muted hover:text-text-strong"
        variant="outline"
        onClick={handleOpenProject}
      >
        <FolderOpenIcon data-icon="inline-start" />
        {t("openProject")}
      </Button>
    </div>
  );
}
