import type { DesktopTodoItem } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";

type TodoGroupCardLabels = {
  dependencyBlockers: string;
  locks: string;
  noBlockers: string;
  noLocks: string;
  parallelBlocked: string;
  parallelSafe: string;
  parallelSafety: string;
  reviewExecutor: string;
  reviewGate: string;
  reviewNeedsChangesReturnsTo: string;
  reviewRequired: string;
  reviewUnlocks: string;
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
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{status}</span>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {items.slice(0, 6).map((item) => (
        <button
          className="flex flex-col gap-2 rounded-md bg-muted/50 px-2 py-2 text-left text-xs"
          key={`${item.canvasId ?? "default"}:${item.ref}`}
          type="button"
          onClick={() => onSelect(item)}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{item.title}</span>
            <Badge variant={item.parallelSafe ? "secondary" : "destructive"}>{item.parallelSafe ? labels.parallelSafe : labels.parallelBlocked}</Badge>
          </div>
          <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 text-muted-foreground">
            <span>{labels.dependencyBlockers}</span>
            <span className="truncate">{item.dependencyBlockers.length ? item.dependencyBlockers.join(", ") : labels.noBlockers}</span>
            <span>{labels.parallelSafety}</span>
            <span>{item.parallelSafe ? labels.parallelSafe : labels.parallelBlocked}</span>
            <span>{labels.locks}</span>
            <span className="truncate">{item.locks.length ? item.locks.join(", ") : labels.noLocks}</span>
            {item.reviewGate ? (
              <>
                <span>{labels.reviewGate}</span>
                <span>{item.reviewGate.required ? labels.reviewRequired : item.reviewGate.requiredReason}</span>
                <span>{labels.reviewExecutor}</span>
                <span>{item.reviewGate.executorRole}</span>
                <span>{labels.reviewUnlocks}</span>
                <span className="truncate">{item.reviewGate.unlocksTasks.length ? item.reviewGate.unlocksTasks.join(", ") : labels.noBlockers}</span>
                <span>{labels.reviewNeedsChangesReturnsTo}</span>
                <span className="truncate">{item.reviewGate.needsChangesReturnsTo.join(", ")}</span>
              </>
            ) : null}
          </div>
        </button>
      ))}
    </div>
  );
}
