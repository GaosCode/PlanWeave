import { Badge } from "@/components/ui/badge";
import { SafeMarkdown } from "../inspector/SafeMarkdown";
import type { TaskWorkspaceLabels, TaskWorkspaceSelectedAnnotation } from "./contracts";
import { ReviewResultContent } from "./ReviewResultContent";

function annotationIdentity(selected: TaskWorkspaceSelectedAnnotation): string {
  const { annotation } = selected;
  if (annotation.kind === "review_attempt") {
    return annotation.attemptId;
  }
  if (annotation.kind === "feedback") {
    return annotation.feedbackId;
  }
  return annotation.recordId;
}

function annotationOccurredAt(selected: TaskWorkspaceSelectedAnnotation): string | null {
  const { annotation } = selected;
  if (annotation.kind === "review_attempt") {
    return annotation.reviewedAt;
  }
  if (annotation.kind === "feedback") {
    return annotation.createdAt;
  }
  return annotation.startedAt;
}

function annotationStatus(
  selected: TaskWorkspaceSelectedAnnotation,
  labels: TaskWorkspaceLabels
): string {
  const { annotation } = selected;
  if (annotation.kind === "review_attempt") {
    if (annotation.verdict) {
      return labels.reviewVerdict[annotation.verdict];
    }
    return labels.unavailable;
  }
  if (annotation.status) {
    return labels.feedbackStatus[annotation.status];
  }
  return labels.unavailable;
}

function annotationContent(selected: TaskWorkspaceSelectedAnnotation): string {
  const { annotation } = selected;
  if (annotation.kind === "feedback_run") {
    return annotation.contentPreview;
  }
  return annotation.content;
}

export function TaskWorkspaceAnnotationDetail({
  labels,
  selected
}: {
  labels: TaskWorkspaceLabels;
  selected: TaskWorkspaceSelectedAnnotation;
}) {
  const { annotation, block } = selected;
  const occurredAt = annotationOccurredAt(selected);
  const content = annotationContent(selected);
  const occurredAtLabel = occurredAt ? labels.formatDateTime(occurredAt) : labels.unavailable;
  let result = <p className="text-sm text-text-muted">{labels.unavailable}</p>;
  if (content.trim()) {
    result =
      annotation.kind === "review_attempt" ? (
        <ReviewResultContent content={content} />
      ) : (
        <SafeMarkdown markdown={content} />
      );
  }
  return (
    <section
      className="h-full overflow-y-auto bg-app-canvas [scrollbar-gutter:stable]"
      data-annotation-id={annotation.annotationId}
      data-testid="task-workspace-annotation-detail"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6 sm:px-8">
        <header className="border-b border-border/70 pb-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline">{labels.annotationKinds[annotation.kind]}</Badge>
            <Badge variant="secondary">{annotationStatus(selected, labels)}</Badge>
          </div>
          <h2 className="text-base font-semibold tracking-tight text-text">{block.title}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
            <span className="font-mono">{block.ref}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{annotationIdentity(selected)}</span>
            <span aria-hidden="true">·</span>
            <time>{occurredAtLabel}</time>
          </div>
        </header>
        <article>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {labels.annotationResult}
          </h3>
          {result}
        </article>
      </div>
    </section>
  );
}
