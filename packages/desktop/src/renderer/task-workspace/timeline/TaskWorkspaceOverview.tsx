import type { TaskWorkspace } from "@planweave-ai/runtime";
import type { ReactNode } from "react";
import type { TaskWorkspaceTimelineLabels } from "./types";

export function TaskWorkspaceOverview({
  labels,
  workspace
}: {
  labels: TaskWorkspaceTimelineLabels;
  workspace: TaskWorkspace;
}) {
  const activeRuns = workspace.blocks.flatMap((block) =>
    block.runs
      .filter((item) => item.active)
      .map((item) => ({ blockTitle: block.title, recordId: item.run.record.recordId }))
  );
  const artifactPath =
    workspace.latestArtifact?.reference?.relativePath ??
    workspace.latestArtifact?.reportPath ??
    null;
  let activeRunContent: ReactNode = (
    <p className="mt-1 text-xs text-text-muted">{labels.noActiveRuns}</p>
  );
  if (activeRuns.length > 0) {
    activeRunContent = (
      <ul className="mt-1 space-y-1">
        {activeRuns.map((run) => (
          <li className="truncate text-xs" key={run.recordId}>
            {run.blockTitle}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="space-y-3 border-b border-border/80 p-3" aria-label={workspace.task.title}>
      <div>
        <h2 className="text-xs font-semibold tracking-wide text-text-muted uppercase">
          {labels.activeRuns(activeRuns.length)}
        </h2>
        {activeRunContent}
      </div>
      <div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium">{labels.dependencies}</span>
          <span className="text-text-muted">
            {labels.dependencyProgress(
              workspace.dependencyProgress.completed,
              workspace.dependencyProgress.total,
              workspace.dependencyProgress.percent
            )}
          </span>
        </div>
        <progress
          aria-label={labels.dependencies}
          className="mt-1 h-1.5 w-full accent-primary"
          max={100}
          value={workspace.dependencyProgress.percent}
        />
      </div>
      <div className="text-xs">
        <div className="font-medium">{labels.latestArtifact}</div>
        <div className="mt-1 truncate text-text-muted" title={artifactPath ?? undefined}>
          {artifactPath ?? labels.noArtifact}
        </div>
      </div>
    </section>
  );
}
