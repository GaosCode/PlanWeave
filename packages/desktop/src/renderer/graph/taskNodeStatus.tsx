import { CheckCircle2Icon, CircleAlertIcon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type TaskNodeStatusTone = "neutral" | "running" | "complete" | "problem";

type TaskNodeStatusVisual = {
  tone: TaskNodeStatusTone;
  cardClassName: string;
  markerClassName: string;
  iconName: "empty-circle" | "loader" | "check" | "alert";
  Icon: typeof CircleIcon;
};

const cardClassNames: Record<TaskNodeStatusTone, string> = {
  neutral: "border-border/80 bg-surface-raised text-text shadow-sm",
  running:
    "border-state-running/55 bg-state-running-surface text-text-strong shadow-sm ring-1 ring-state-running/15",
  complete:
    "border-state-success/55 bg-state-success-surface text-text-strong shadow-sm ring-1 ring-state-success/15",
  problem:
    "border-state-failed/60 bg-state-failed-surface text-text-strong shadow-sm ring-1 ring-state-failed/15"
};

const markerClassNames: Record<TaskNodeStatusTone, string> = {
  neutral: "border-border/80 bg-surface-muted text-text-muted",
  running: "border-state-running/45 bg-state-running-surface text-state-running",
  complete: "border-state-success/45 bg-state-success-surface text-state-success",
  problem: "border-state-failed/50 bg-state-failed-surface text-state-failed"
};

export function taskNodeStatusVisual(status: string, hasException: boolean): TaskNodeStatusVisual {
  if (hasException || status === "blocked" || status === "diverged" || status === "needs_changes") {
    return {
      tone: "problem",
      cardClassName: cardClassNames.problem,
      markerClassName: markerClassNames.problem,
      iconName: "alert",
      Icon: CircleAlertIcon
    };
  }
  if (status === "implemented" || status === "completed") {
    return {
      tone: "complete",
      cardClassName: cardClassNames.complete,
      markerClassName: markerClassNames.complete,
      iconName: "check",
      Icon: CheckCircle2Icon
    };
  }
  if (status === "in_progress") {
    return {
      tone: "running",
      cardClassName: cardClassNames.running,
      markerClassName: markerClassNames.running,
      iconName: "loader",
      Icon: LoaderCircleIcon
    };
  }
  return {
    tone: "neutral",
    cardClassName: cardClassNames.neutral,
    markerClassName: markerClassNames.neutral,
    iconName: "empty-circle",
    Icon: CircleIcon
  };
}

export function TaskNodeStatusMarker({
  hasException,
  label,
  status
}: {
  hasException: boolean;
  label: string;
  status: string;
}) {
  const visual = taskNodeStatusVisual(status, hasException);
  const Icon = visual.Icon;

  return (
    <Badge
      className={cn("h-6 shrink-0 gap-1.5 border px-2", visual.markerClassName)}
      data-status-tone={visual.tone}
      data-testid="task-node-status-marker"
      variant="outline"
    >
      <Icon
        className={visual.iconName === "loader" ? "animate-spin" : undefined}
        data-status-icon={visual.iconName}
        aria-hidden="true"
      />
      {label}
    </Badge>
  );
}
