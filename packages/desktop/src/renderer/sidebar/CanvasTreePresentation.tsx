import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { forwardRef, type ComponentProps, type ReactNode } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";
import { statusVariant } from "../viewHelpers";

type TaskTreeRow = Pick<
  DesktopGraphViewModel["tasks"][number],
  "taskId" | "title" | "status" | "exceptions"
>;

type CanvasTreeSelectButtonProps = Omit<
  ComponentProps<typeof Button>,
  "aria-current" | "aria-label" | "children" | "onClick" | "title" | "variant"
> & {
  ariaLabel?: string;
  canvasId?: string;
  label: string;
  onClick: () => void;
  selected: boolean;
  testId?: string;
  title?: string;
  trailing: ReactNode;
};

export const CanvasTreeSelectButton = forwardRef<HTMLButtonElement, CanvasTreeSelectButtonProps>(
  function CanvasTreeSelectButton(
    { ariaLabel, canvasId, label, onClick, selected, testId, title, trailing, ...buttonProps },
    ref
  ) {
    return (
      <Button
        {...buttonProps}
        ref={ref}
        aria-label={ariaLabel}
        aria-current={selected ? "page" : undefined}
        className="h-8 w-full min-w-0 max-w-full flex-1 justify-between gap-2 overflow-hidden rounded-md px-2 text-xs text-text-muted hover:bg-surface-muted hover:text-text-strong data-[variant=secondary]:border-state-selected/25 data-[variant=secondary]:bg-state-selected-surface data-[variant=secondary]:text-text-strong data-[variant=secondary]:shadow-sm [&_svg]:size-4"
        data-canvas-id={canvasId}
        data-testid={testId}
        title={title}
        variant={selected ? "secondary" : "ghost"}
        onClick={onClick}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
          <WorkflowIcon className="shrink-0" data-icon="inline-start" />
          <span className="truncate">{label}</span>
        </span>
        {trailing}
      </Button>
    );
  }
);

type CanvasTreeToggleButtonProps = {
  expanded: boolean;
  onToggle: ComponentProps<typeof Button>["onClick"];
  t: ReturnType<typeof createTranslator>;
  testId?: string;
};

export function CanvasTreeToggleButton({
  expanded,
  onToggle,
  t,
  testId
}: CanvasTreeToggleButtonProps) {
  return (
    <Button
      aria-expanded={expanded}
      aria-label={expanded ? t("collapseTaskCanvas") : t("expandTaskCanvas")}
      className="relative z-10 h-8 w-7 shrink-0 border-0 bg-transparent text-text-faint shadow-none opacity-100 hover:bg-surface-muted hover:text-text-strong focus-visible:ring-ring/40"
      data-testid={testId}
      size="icon-sm"
      variant="ghost"
      onClick={onToggle}
    >
      <ChevronRightIcon
        className={cn(
          "size-4 transition-transform duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)]",
          expanded ? "rotate-90" : "rotate-0"
        )}
      />
    </Button>
  );
}

type TaskTreeSelectButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "onClick" | "variant"
> & {
  onSelect: () => void;
  selected: boolean;
  task: TaskTreeRow;
};

export const TaskTreeSelectButton = forwardRef<HTMLButtonElement, TaskTreeSelectButtonProps>(
  function TaskTreeSelectButton({ onSelect, selected, task, ...buttonProps }, ref) {
    return (
      <Button
        {...buttonProps}
        ref={ref}
        className="h-8 w-full min-w-0 max-w-full shrink justify-start gap-2 overflow-hidden rounded-md bg-surface-muted/60 px-2 text-xs text-text hover:bg-surface-muted hover:text-text-strong data-[variant=secondary]:border-state-selected/25 data-[variant=secondary]:bg-state-selected-surface data-[variant=secondary]:text-text-strong data-[variant=secondary]:shadow-sm"
        variant={selected ? "secondary" : "ghost"}
        onClick={onSelect}
      >
        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{task.title}</span>
        <Badge
          className="ml-auto shrink-0 border-border/80 bg-surface-raised text-xs text-text"
          variant={task.exceptions.length > 0 ? "destructive" : statusVariant[task.status]}
        >
          {task.taskId}
        </Badge>
      </Button>
    );
  }
);
