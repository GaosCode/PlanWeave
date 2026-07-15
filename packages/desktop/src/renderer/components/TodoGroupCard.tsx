import type { DesktopTodoItem } from "@planweave-ai/runtime";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  GitPullRequestArrowIcon,
  Loader2Icon,
  ShieldAlertIcon
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type TodoGroupCardLabels = {
  dependencyBlockers: string;
  dispatchability: string;
  dispatchable: string;
  notDispatchable: string;
  noBlockers: string;
  noSharedResources: string;
  sharedResources: string;
  reviewExecutor: string;
  reviewGate: string;
  reviewNeedsChangesReturnsTo: string;
  reviewRequired: string;
  reviewUnlocks: string;
};

const statusVisuals: Record<
  string,
  {
    accent: string;
    badge: "default" | "secondary" | "destructive" | "outline";
    icon: typeof CircleDotIcon;
  }
> = {
  ready: {
    accent: "from-emerald-500/80 to-cyan-500/70",
    badge: "secondary",
    icon: CircleDotIcon
  },
  in_progress: {
    accent: "from-sky-500/85 to-indigo-500/70",
    badge: "default",
    icon: Loader2Icon
  },
  needs_changes: {
    accent: "from-amber-500/90 to-orange-500/70",
    badge: "destructive",
    icon: GitPullRequestArrowIcon
  },
  blocked: {
    accent: "from-rose-500/90 to-red-500/70",
    badge: "destructive",
    icon: ShieldAlertIcon
  },
  diverged: {
    accent: "from-fuchsia-500/85 to-rose-500/70",
    badge: "destructive",
    icon: AlertTriangleIcon
  },
  implemented: {
    accent: "from-zinc-500/80 to-emerald-500/70",
    badge: "outline",
    icon: CheckCircle2Icon
  }
};

export function TodoGroupCard({
  items,
  labels,
  onSelect,
  status
}: {
  status: string;
  items: DesktopTodoItem[];
  labels: TodoGroupCardLabels;
  onSelect: (item: DesktopTodoItem) => void;
}) {
  const visual = statusVisuals[status] ?? statusVisuals.ready;
  const StatusIcon = visual.icon;

  return (
    <div className="relative flex min-h-80 flex-col gap-3 overflow-hidden rounded-md border border-border/80 bg-surface-raised p-3 text-text shadow-sm ring-1 ring-foreground/5">
      <div className={cn("absolute inset-y-0 left-0 w-1 bg-gradient-to-b", visual.accent)} />
      <div className="flex items-center justify-between gap-2 pl-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/80 bg-surface-base">
            <StatusIcon
              className={cn(
                "size-4 text-muted-foreground",
                status === "in_progress" ? "animate-spin" : null
              )}
              aria-hidden="true"
            />
          </div>
          <span className="truncate font-mono text-sm font-semibold">{status}</span>
        </div>
        <Badge className="font-mono tabular-nums" variant={visual.badge}>
          {items.length}
        </Badge>
      </div>
      {items.slice(0, 6).map((item) => (
        <button
          className="group flex flex-col gap-2 rounded-md border border-border/80 bg-surface-base px-3 py-2.5 text-left text-xs shadow-xs transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          key={`${item.canvasId ?? "default"}:${item.ref}`}
          type="button"
          onClick={() => onSelect(item)}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium group-hover:text-foreground">
                {item.title}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {item.taskId} / {item.blockId}
              </div>
            </div>
            <Badge className="shrink-0" variant={item.dispatchable ? "secondary" : "destructive"}>
              {item.dispatchable ? labels.dispatchable : labels.notDispatchable}
            </Badge>
          </div>
          <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md bg-surface-muted/70 p-2 text-muted-foreground">
            <span className="font-medium text-foreground/70">{labels.dependencyBlockers}</span>
            <span className="truncate font-mono">
              {item.dependencyBlockers.length
                ? item.dependencyBlockers.join(", ")
                : labels.noBlockers}
            </span>
            <span className="font-medium text-foreground/70">{labels.dispatchability}</span>
            <span>{item.dispatchable ? labels.dispatchable : labels.notDispatchable}</span>
            <span className="font-medium text-foreground/70">{labels.sharedResources}</span>
            <span className="truncate font-mono">
              {item.sharedResources.length
                ? item.sharedResources.join(", ")
                : labels.noSharedResources}
            </span>
            {item.reviewGate ? (
              <>
                <span className="font-medium text-foreground/70">{labels.reviewGate}</span>
                <span>
                  {item.reviewGate.required
                    ? labels.reviewRequired
                    : item.reviewGate.requiredReason}
                </span>
                <span className="font-medium text-foreground/70">{labels.reviewExecutor}</span>
                <span className="font-mono">{item.reviewGate.executorRole}</span>
                <span className="font-medium text-foreground/70">{labels.reviewUnlocks}</span>
                <span className="truncate font-mono">
                  {item.reviewGate.unlocksTasks.length
                    ? item.reviewGate.unlocksTasks.join(", ")
                    : labels.noBlockers}
                </span>
                <span className="font-medium text-foreground/70">
                  {labels.reviewNeedsChangesReturnsTo}
                </span>
                <span className="truncate font-mono">
                  {item.reviewGate.needsChangesReturnsTo.join(", ")}
                </span>
              </>
            ) : null}
          </div>
        </button>
      ))}
      {items.length > 6 ? (
        <div className="pl-2 text-xs text-muted-foreground">+{items.length - 6}</div>
      ) : null}
    </div>
  );
}
