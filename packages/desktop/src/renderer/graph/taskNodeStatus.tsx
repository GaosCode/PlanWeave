import { ActivityIcon, CheckCircle2Icon, CircleAlertIcon, CircleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type TaskNodeStatusTone = "neutral" | "running" | "complete" | "problem";

type TaskNodeStatusVisual = {
  tone: TaskNodeStatusTone;
  cardClassName: string;
  markerClassName: string;
  iconName: "empty-circle" | "activity" | "check" | "alert";
  Icon: typeof CircleIcon;
};

const cardClassNames: Record<TaskNodeStatusTone, string> = {
  neutral: "border-border bg-white shadow-sm dark:bg-card",
  running: "border-sky-200 bg-sky-50 shadow-sky-950/10 dark:border-sky-700/60 dark:bg-sky-950/35",
  complete: "border-emerald-200 bg-emerald-50 shadow-emerald-950/10 dark:border-emerald-700/60 dark:bg-emerald-950/35",
  problem: "border-rose-200 bg-rose-50 shadow-rose-950/10 dark:border-rose-700/60 dark:bg-rose-950/35"
};

const markerClassNames: Record<TaskNodeStatusTone, string> = {
  neutral: "border-foreground/15 bg-transparent text-muted-foreground dark:border-foreground/20",
  running: "border-sky-300 bg-transparent text-sky-700 dark:border-sky-500/60 dark:text-sky-300",
  complete: "border-emerald-300 bg-transparent text-emerald-700 dark:border-emerald-500/60 dark:text-emerald-300",
  problem: "border-rose-300 bg-transparent text-rose-700 dark:border-rose-500/60 dark:text-rose-300"
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
      iconName: "activity",
      Icon: ActivityIcon
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

export function TaskNodeStatusMarker({ hasException, label, status }: { hasException: boolean; label: string; status: string }) {
  const visual = taskNodeStatusVisual(status, hasException);
  const Icon = visual.Icon;

  return (
    <Badge
      className={cn("h-6 shrink-0 gap-1.5 border px-2", visual.markerClassName)}
      data-status-tone={visual.tone}
      data-testid="task-node-status-marker"
      variant="outline"
    >
      <Icon data-status-icon={visual.iconName} aria-hidden="true" />
      {label}
    </Badge>
  );
}
