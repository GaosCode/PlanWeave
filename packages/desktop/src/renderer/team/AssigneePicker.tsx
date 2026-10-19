import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import type { AssignmentTarget } from "@planweave-ai/collaboration-protocol/work/assignment";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type {
  AssigneeOption,
  AssigneePickerViewModel,
  AssigneeSection,
  AssigneeUnavailableReason
} from "../collaboration/assignmentViewModels";
import type { createTranslator } from "../i18n";

export type AssigneePickerProps = {
  /** Session/work-item identity for scoped controllers; unscoped callers only fence unmount. */
  interactionScope?: object;
  viewModel: AssigneePickerViewModel;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (target: AssignmentTarget) => Promise<boolean> | boolean;
  onRefresh: () => Promise<void> | void;
  onRetry: () => Promise<boolean> | boolean;
  /** Notifies when the popover opens/closes so eligible options load on demand. */
  onOpenChange?: (open: boolean) => void;
  t: ReturnType<typeof createTranslator>;
  className?: string;
};

function reasonLabel(
  reason: AssigneeUnavailableReason | null | undefined,
  t: ReturnType<typeof createTranslator>
): string | null {
  if (!reason) return null;
  switch (reason) {
    case "task_disallows_machine":
      return t("assigneeReasonTaskNoMachine");
    case "host_missing":
      return t("assigneeReasonHostMissing");
    case "host_revoked":
      return t("assigneeReasonHostRevoked");
    case "host_not_authorized":
      return t("assigneeReasonHostNotAuthorized");
    case "host_capability_mismatch":
      return t("assigneeReasonHostCapability");
    case "host_offline":
      return t("assigneeReasonHostOffline");
    case "host_at_capacity":
      return t("assigneeReasonHostCapacity");
    case "human_membership_inactive":
      return t("assigneeReasonHumanInactive");
    case "role_insufficient":
      return t("assigneeReasonRole");
    case "not_connected":
      return t("assigneeReasonNotConnected");
    case "offline":
      return t("assigneeReasonOffline");
    case "submitting":
      return t("assigneeReasonSubmitting");
    case "stale_conflict":
      return t("assigneeReasonStale");
    case "work_item_missing":
      return t("assigneeReasonWorkItemMissing");
    case "forbidden":
      return t("assigneeReasonForbidden");
    case "auth_expired":
      return t("assigneeReasonAuthExpired");
    case "server_error":
      return t("assigneeReasonServerError");
    default:
      return null;
  }
}

function sectionHeading(section: AssigneeSection, t: ReturnType<typeof createTranslator>): string {
  switch (section.id) {
    case "unassigned":
      return t("assigneeSectionUnassigned");
    case "people":
      return t("assigneeSectionPeople");
    case "hosts":
      return t("assigneeSectionHosts");
    case "automatic":
      return t("assigneeSectionAutomatic");
    default:
      return section.id;
  }
}

function modeMessage(
  viewModel: AssigneePickerViewModel,
  t: ReturnType<typeof createTranslator>
): string | null {
  switch (viewModel.mode) {
    case "disconnected":
      return t("assigneeDisconnected");
    case "connecting":
      return t("assigneeConnecting");
    case "loading":
      return t("assigneeLoading");
    case "offline":
      return t("assigneeOffline");
    case "forbidden":
      return t("assigneeForbidden");
    case "auth_expired":
      return t("assigneeAuthExpired");
    case "error":
      return viewModel.lastError ?? t("assigneeError");
    case "stale_conflict":
      return t("assigneeStaleConflict");
    default:
      return null;
  }
}

function OptionRow({
  option,
  active,
  onSelect,
  t,
  optionId
}: {
  option: AssigneeOption;
  active: boolean;
  onSelect: () => void;
  t: ReturnType<typeof createTranslator>;
  optionId: string;
}) {
  const reason = reasonLabel(option.unavailableReason ?? option.warningReason, t);
  return (
    <div>
      <button
        type="button"
        id={optionId}
        role="option"
        aria-selected={option.selected}
        aria-disabled={!option.selectable}
        data-testid="assignee-option"
        data-option-id={option.id}
        data-selectable={option.selectable ? "true" : "false"}
        disabled={!option.selectable}
        className={cn(
          "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm outline-none",
          option.selectable
            ? "hover:bg-app-hover focus-visible:bg-app-hover"
            : "cursor-not-allowed opacity-60",
          active ? "bg-state-selected-surface" : null,
          option.selected ? "ring-1 ring-border" : null
        )}
        onClick={() => {
          if (option.selectable) onSelect();
        }}
      >
        <span className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate font-medium">{option.label}</span>
          {option.selected ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {t("assigneeCurrent")}
            </span>
          ) : null}
        </span>
        {option.secondaryLabel ? (
          <span className="text-[11px] text-muted-foreground">{option.secondaryLabel}</span>
        ) : null}
        {reason ? (
          <span
            className="text-[11px] text-amber-800 dark:text-amber-100"
            data-testid="assignee-option-reason"
          >
            {reason}
          </span>
        ) : null}
      </button>
    </div>
  );
}

/**
 * Accessible Task/Block assignee picker driven by a strict view model.
 * Machine selection only updates assignment; it never dispatches remote work.
 */
export function AssigneePicker({
  interactionScope,
  viewModel,
  query,
  onQueryChange,
  onSelect,
  onRefresh,
  onRetry,
  onOpenChange,
  t,
  className
}: AssigneePickerProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const currentInteractionScope = useRef<object | null | undefined>(interactionScope);
  useLayoutEffect(() => {
    currentInteractionScope.current = interactionScope;
    return () => {
      currentInteractionScope.current = null;
    };
  }, [interactionScope]);
  const options = viewModel.filteredOptions;

  const setOpenState = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: remount focus when work item changes
  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, viewModel.workItemKey]);

  useEffect(() => {
    if (activeIndex >= options.length) {
      setActiveIndex(Math.max(0, options.length - 1));
    }
  }, [activeIndex, options.length]);

  const currentIssue = reasonLabel(viewModel.current.issueReason, t);
  const banner = modeMessage(viewModel, t);

  const activeOption = options[activeIndex] ?? null;
  const activeOptionId = activeOption ? `${listboxId}-opt-${activeOption.id}` : undefined;

  const triggerLabel = useMemo(() => {
    if (viewModel.pending) return t("assigneeSubmitting");
    return viewModel.current.label;
  }, [t, viewModel.current.label, viewModel.pending]);

  const handleSelect = async (target: AssignmentTarget) => {
    const ok = await onSelect(target);
    if (ok && currentInteractionScope.current === interactionScope) {
      setOpenState(false);
      onQueryChange("");
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(options.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, options.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option?.selectable) {
        void handleSelect(option.target);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpenState(false);
    }
  };

  return (
    <div
      className={cn("flex flex-col gap-1", className)}
      data-testid="assignee-picker"
      data-mode={viewModel.mode}
      data-work-item={viewModel.workItemKey}
    >
      <div className="text-xs font-medium text-muted-foreground">{t("assignee")}</div>
      <Popover open={open} onOpenChange={setOpenState}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 justify-between gap-2 px-2 font-normal"
            data-testid="assignee-picker-trigger"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listboxId}
            disabled={viewModel.pending}
          >
            <span className="flex min-w-0 items-center gap-2">
              {viewModel.current.initials ? (
                <span
                  aria-hidden="true"
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-state-selected-surface text-[9px] font-semibold"
                >
                  {viewModel.current.initials}
                </span>
              ) : null}
              <span className="min-w-0 truncate" data-testid="assignee-current-label">
                {triggerLabel}
              </span>
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[min(22rem,calc(100vw-2rem))] p-2"
          onKeyDown={onKeyDown}
        >
          <div className="flex flex-col gap-2">
            <Input
              ref={searchRef}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t("assigneeSearchPlaceholder")}
              aria-label={t("assigneeSearchPlaceholder")}
              data-testid="assignee-search"
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              autoComplete="off"
            />
            <div
              id={listboxId}
              role="listbox"
              aria-label={t("assignee")}
              data-testid="assignee-listbox"
              className="max-h-64 space-y-2 overflow-auto"
            >
              {viewModel.sections.length === 0 ? (
                <div
                  className="px-2 py-3 text-xs text-muted-foreground"
                  data-testid="assignee-empty"
                >
                  {t("assigneeNoMatches")}
                </div>
              ) : (
                viewModel.sections.map((section) => (
                  <fieldset
                    key={section.id}
                    data-testid={`assignee-section-${section.id}`}
                    className="m-0 min-w-0 space-y-0.5 border-0 p-0"
                  >
                    <legend className="float-left w-full px-2 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      {sectionHeading(section, t)}
                    </legend>
                    {section.options.map((option) => {
                      const flatIndex = options.findIndex((item) => item.id === option.id);
                      return (
                        <OptionRow
                          key={option.id}
                          option={option}
                          active={flatIndex === activeIndex}
                          optionId={`${listboxId}-opt-${option.id}`}
                          t={t}
                          onSelect={() => void handleSelect(option.target)}
                        />
                      );
                    })}
                  </fieldset>
                ))
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {currentIssue ? (
        <p
          className="text-[11px] text-amber-800 dark:text-amber-100"
          data-testid="assignee-current-issue"
          role="status"
        >
          {currentIssue}
        </p>
      ) : null}

      {banner ? (
        <p
          className={cn(
            "text-[11px]",
            viewModel.mode === "stale_conflict" || viewModel.mode === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
          data-testid="assignee-mode-banner"
          role="status"
        >
          {banner}
        </p>
      ) : null}

      {viewModel.lastError && viewModel.mode !== "error" ? (
        <p
          className="text-[11px] text-destructive"
          data-testid="assignee-action-error"
          role="alert"
        >
          {viewModel.lastError}
        </p>
      ) : null}

      {viewModel.staleConflict ? (
        <div className="flex flex-wrap items-center gap-1" data-testid="assignee-stale-actions">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="assignee-refresh"
            onClick={() => void onRefresh()}
          >
            <RefreshCwIcon className="size-3.5" data-icon="inline-start" />
            {t("assigneeRefresh")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="assignee-retry"
            disabled={viewModel.pending}
            onClick={() => void onRetry()}
          >
            {t("assigneeRetry")}
          </Button>
        </div>
      ) : null}

      <p className="sr-only" data-testid="assignee-revision">
        {t("assigneeRevision").replace("{revision}", String(viewModel.expectedRevision))}
      </p>
    </div>
  );
}
