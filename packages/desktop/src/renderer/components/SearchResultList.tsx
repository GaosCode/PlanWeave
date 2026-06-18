import type { DesktopSearchResult } from "@planweave-ai/runtime";
import { Badge } from "@/components/ui/badge";

export type SearchNavigationTarget =
  | { kind: "task"; ref: string }
  | { kind: "block"; ref: string }
  | { kind: "record"; recordId: string }
  | { kind: "none" };

export function searchNavigationTarget(result: DesktopSearchResult): SearchNavigationTarget {
  const targetRef = result.targetRef ?? result.ref;
  if (result.kind === "run_record") {
    return result.recordId ? { kind: "record", recordId: result.recordId } : { kind: "none" };
  }
  if (targetRef.includes("#")) {
    return { kind: "block", ref: targetRef };
  }
  if (result.kind === "task" || result.kind === "prompt") {
    return { kind: "task", ref: targetRef };
  }
  return { kind: "none" };
}

export function SearchResultList({
  onOpenResult,
  results,
  targetMissingLabel
}: {
  results: DesktopSearchResult[];
  targetMissingLabel: string;
  onOpenResult: (result: DesktopSearchResult) => void | Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-2 pr-2">
      {results.map((result) => {
        const target = searchNavigationTarget(result);
        return (
          <button
            className="flex flex-col gap-1 rounded-md border border-border/80 bg-surface-raised p-3 text-left text-text shadow-sm transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            key={`${result.canvasId ?? "project"}-${result.kind}-${result.ref}`}
            type="button"
            onClick={() => void onOpenResult(result)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{result.title}</span>
              <Badge variant={target.kind === "none" ? "destructive" : "outline"}>{result.kind}</Badge>
            </div>
            <div className="line-clamp-2 text-xs text-muted-foreground">{result.excerpt}</div>
            {target.kind === "none" ? <div className="text-xs text-destructive">{targetMissingLabel}</div> : null}
          </button>
        );
      })}
    </div>
  );
}
