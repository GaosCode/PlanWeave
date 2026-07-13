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

export function highlightedSearchExcerpt(result: DesktopSearchResult): Array<{ text: string; highlighted: boolean }> {
  const excerpt = result.match?.excerpt ?? result.excerpt;
  const match = result.match;
  if (!match || match.length <= 0) {
    return [{ text: excerpt, highlighted: false }];
  }
  const highlightStart = match.start - match.excerptStart;
  const highlightEnd = highlightStart + match.length;
  if (highlightStart < 0 || highlightEnd > excerpt.length) {
    return [{ text: excerpt, highlighted: false }];
  }
  return [
    { text: excerpt.slice(0, highlightStart), highlighted: false },
    { text: excerpt.slice(highlightStart, highlightEnd), highlighted: true },
    { text: excerpt.slice(highlightEnd), highlighted: false }
  ].filter((part) => part.text.length > 0);
}

export function searchMatchSourceLabel(
  result: DesktopSearchResult,
  labels: {
    blockBody: string;
    blockTitle: string;
    feedback: string;
    prompt: string;
    reviewAttempt: string;
    runRecord: string;
    taskBody: string;
    taskTitle: string;
  }
): string {
  if (result.kind === "task") {
    return result.match?.field === "body" ? labels.taskBody : labels.taskTitle;
  }
  if (result.kind === "block") {
    return result.match?.field === "body" ? labels.blockBody : labels.blockTitle;
  }
  switch (result.kind) {
    case "prompt":
      return labels.prompt;
    case "run_record":
      return labels.runRecord;
    case "review_attempt":
      return labels.reviewAttempt;
    case "feedback":
      return labels.feedback;
  }
  const exhaustiveKind: never = result.kind;
  return exhaustiveKind;
}

export function SearchResultList({
  canvasLabel,
  kindLabels,
  matchSourceLabels,
  onOpenResult,
  refLabel,
  results,
  targetLabel,
  targetMissingLabel
}: {
  canvasLabel: string;
  kindLabels: Record<DesktopSearchResult["kind"], string>;
  matchSourceLabels: Parameters<typeof searchMatchSourceLabel>[1];
  results: DesktopSearchResult[];
  refLabel: string;
  targetLabel: string;
  targetMissingLabel: string;
  onOpenResult: (result: DesktopSearchResult) => void | Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-2 pr-2">
      {results.map((result, index) => {
        const target = searchNavigationTarget(result);
        const resultContent = (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{result.title}</span>
              <Badge variant={target.kind === "none" ? "destructive" : "outline"}>{kindLabels[result.kind]}</Badge>
            </div>
            <div className="grid gap-1 text-xs text-text-muted sm:grid-cols-2">
              <div className="min-w-0 truncate">
                <span className="font-medium text-text">{canvasLabel}: </span>
                {result.canvasName ?? result.canvasId ?? "project"}
                {result.canvasName && result.canvasId ? ` (${result.canvasId})` : null}
              </div>
              <div className="min-w-0 truncate">
                <span className="font-medium text-text">{refLabel}: </span>
                {result.ref}
              </div>
              <div className="min-w-0 truncate">
                <span className="font-medium text-text">{targetLabel}: </span>
                {result.targetRef ?? result.ref}
              </div>
              <div className="min-w-0 truncate">
                <span className="font-medium text-text">{searchMatchSourceLabel(result, matchSourceLabels)}</span>
              </div>
            </div>
            <div className="line-clamp-2 text-xs leading-5 text-muted-foreground">
              {highlightedSearchExcerpt(result).map((part, index) =>
                part.highlighted ? (
                  <mark className="rounded-sm bg-state-warning-surface px-0.5 text-text-strong" key={index}>
                    {part.text}
                  </mark>
                ) : (
                  <span key={index}>{part.text}</span>
                )
              )}
            </div>
            {target.kind === "none" ? <div className="text-xs text-destructive">{targetMissingLabel}</div> : null}
          </>
        );
        const key = `${result.canvasId ?? "project"}-${result.kind}-${result.ref}`;
        const animClass = "animate-in fade-in slide-in-from-bottom-2 duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)] fill-mode-both";
        const animStyle = { animationDelay: `${index * 35}ms` };
        if (target.kind === "none") {
          return (
            <article className={`flex flex-col gap-1 rounded-md border border-border/80 bg-surface-raised p-3 text-left text-text shadow-sm ${animClass}`} key={key} style={animStyle}>
              {resultContent}
            </article>
          );
        }
        return (
          <button
            className={`flex flex-col gap-1 rounded-md border border-border/80 bg-surface-raised p-3 text-left text-text shadow-sm transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${animClass}`}
            key={key}
            style={animStyle}
            type="button"
            onClick={() => void onOpenResult(result)}
          >
            {resultContent}
          </button>
        );
      })}
    </div>
  );
}
