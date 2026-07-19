import { useState, type ReactNode } from "react";
import type { ValidationIssue } from "@planweave-ai/runtime";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from "@/components/ui/popover";
import { formatElapsed } from "../viewHelpers";
import type { FloatingAutoRunTranslator } from "./floatingAutoRunTypes";

type FileSyncPopoverProps = {
  affectedTasks: string[];
  diagnostics: ValidationIssue[];
  dirtyPromptRefs: string[];
  disabled: boolean;
  issueCount: number;
  onOpenChange: (open: boolean) => void;
  onOpenFileSyncRef: (ref: string) => void;
  open: boolean;
  refreshConcurrency: number | null;
  refreshPackageFiles: () => Promise<void>;
  refreshedPromptCount: number;
  showUnreadCount: boolean;
  t: FloatingAutoRunTranslator;
  watcherBackendKind?: "native" | "polling";
  watcherChangedPathCount?: number;
  watcherRefreshElapsedMs?: number;
};

function DisclosureSection({
  children,
  defaultOpen = false,
  testId,
  title
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border bg-muted/20 text-xs" data-testid={testId}>
      <Button
        className="h-auto w-full justify-start gap-1.5 rounded-none px-2 py-1.5 text-left text-xs font-medium"
        size="sm"
        type="button"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? (
          <ChevronDownIcon data-icon="inline-start" />
        ) : (
          <ChevronRightIcon data-icon="inline-start" />
        )}
        {title}
      </Button>
      {open ? <div className="border-t border-border/70 p-2">{children}</div> : null}
    </div>
  );
}

function FileSyncRefList({
  emptyLabel,
  items,
  label,
  onOpenFileSyncRef
}: {
  emptyLabel: string;
  items: string[];
  label: string;
  onOpenFileSyncRef: (ref: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold text-text-strong">{label}</div>
      {items.length > 0 ? (
        <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
          {items.map((item) => (
            <Button
              className="h-auto justify-start px-2 py-1.5 text-left text-xs"
              data-testid="file-sync-ref"
              key={item}
              size="sm"
              variant="ghost"
              onClick={() => onOpenFileSyncRef(item)}
            >
              <span className="min-w-0 break-all">{item}</span>
            </Button>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}

function FileSyncDiagnosticsList({
  diagnostics,
  emptyLabel,
  label
}: {
  diagnostics: ValidationIssue[];
  emptyLabel: string;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold text-text-strong">{label}</div>
      {diagnostics.length > 0 ? (
        <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
          {diagnostics.map((diagnostic) => (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs"
              data-testid="file-sync-diagnostic"
              key={`${diagnostic.code}:${diagnostic.path ?? ""}:${diagnostic.message}`}
            >
              <div className="font-medium text-destructive">{diagnostic.code}</div>
              <div className="break-words text-muted-foreground">{diagnostic.message}</div>
              {diagnostic.path ? (
                <div className="mt-1 break-all text-text-faint">{diagnostic.path}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}

export function FileSyncPopover({
  affectedTasks,
  diagnostics,
  dirtyPromptRefs,
  disabled,
  issueCount,
  onOpenChange,
  onOpenFileSyncRef,
  open,
  refreshConcurrency,
  refreshPackageFiles,
  refreshedPromptCount,
  showUnreadCount,
  t,
  watcherBackendKind,
  watcherChangedPathCount,
  watcherRefreshElapsedMs
}: FileSyncPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          className="relative"
          data-testid="file-sync-trigger"
          size="icon-sm"
          variant={issueCount ? "outline" : "ghost"}
          aria-label={t("viewFileSyncChanges")}
          title={t("viewFileSyncChanges")}
          disabled={disabled}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {showUnreadCount ? (
            <span
              className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full border border-background bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
              data-testid="file-sync-unread-count"
            >
              {issueCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" data-testid="file-sync-popover">
        <PopoverHeader>
          <PopoverTitle>{t("fileSyncChanges")}</PopoverTitle>
          <PopoverDescription>
            {issueCount > 0 ? t("fileSyncChangesHint") : t("fileSyncNoChanges")}
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void refreshPackageFiles()}>
              <RefreshCwIcon data-icon="inline-start" />
              {t("recheckFiles")}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
            <span>{t("refreshedPrompts")}</span>
            <span data-testid="file-sync-refreshed-prompt-count">{refreshedPromptCount}</span>
            <span>{t("refreshConcurrency")}</span>
            <span data-testid="file-sync-refresh-concurrency">{refreshConcurrency ?? "-"}</span>
            <span>{t("changedPaths")}</span>
            <span data-testid="file-sync-changed-path-count">{watcherChangedPathCount ?? "-"}</span>
            <span>{t("watchBackend")}</span>
            <span data-testid="file-sync-watch-backend">{watcherBackendKind ?? "-"}</span>
            <span>{t("watchElapsed")}</span>
            <span data-testid="file-sync-watch-elapsed">
              {watcherRefreshElapsedMs === undefined ? "-" : formatElapsed(watcherRefreshElapsedMs)}
            </span>
          </div>
          <DisclosureSection title={t("dirtyPrompts")} testId="file-sync-dirty-prompts-section">
            <FileSyncRefList
              emptyLabel={t("fileSyncNoChanges")}
              items={dirtyPromptRefs}
              label={t("dirtyPrompts")}
              onOpenFileSyncRef={onOpenFileSyncRef}
            />
          </DisclosureSection>
          <DisclosureSection title={t("affectedTasks")} testId="file-sync-affected-tasks-section">
            <FileSyncRefList
              emptyLabel={t("fileSyncNoChanges")}
              items={affectedTasks}
              label={t("affectedTasks")}
              onOpenFileSyncRef={onOpenFileSyncRef}
            />
          </DisclosureSection>
          <DisclosureSection title={t("diagnostics")} testId="file-sync-diagnostics-section">
            <FileSyncDiagnosticsList
              diagnostics={diagnostics}
              emptyLabel={t("fileSyncNoChanges")}
              label={t("diagnostics")}
            />
          </DisclosureSection>
        </div>
      </PopoverContent>
    </Popover>
  );
}
