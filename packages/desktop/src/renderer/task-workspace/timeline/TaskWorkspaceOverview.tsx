import type { TaskWorkspace } from "@planweave-ai/runtime";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { TaskWorkspaceExecutorSelect } from "../TaskWorkspaceExecutorSelect";
import { TaskWorkspaceBlockPrompts, TaskWorkspaceTaskPrompt } from "../TaskWorkspacePrompts";
import type { TaskWorkspaceLabels, TaskWorkspacePromptSaveInput } from "../contracts";
import type { TaskWorkspaceTimelineLabels } from "./types";

function activeRuns(workspace: TaskWorkspace) {
  return workspace.blocks.flatMap((block) =>
    block.runs
      .filter((item) => item.active)
      .map((item) => ({
        agent:
          item.run.metadata.agentId ??
          item.run.metadata.executor ??
          item.run.metadata.adapter ??
          block.effectiveExecutor,
        blockTitle: block.title,
        recordId: item.run.record.recordId,
        runId: item.run.record.runId
      }))
  );
}

function artifactPath(workspace: TaskWorkspace): string | null {
  return (
    workspace.latestArtifact?.reference?.relativePath ??
    workspace.latestArtifact?.reportPath ??
    null
  );
}

function BlockPromptDisclosure({
  initiallyOpen,
  executorOptions,
  labels,
  block,
  onSaveExecutor,
  packageExecutorNames,
  onSavePrompt
}: {
  initiallyOpen: boolean;
  executorOptions: readonly string[];
  labels: TaskWorkspaceLabels;
  block: TaskWorkspace["blocks"][number];
  onSaveExecutor: (executorName: string | null) => Promise<void>;
  packageExecutorNames: readonly string[];
  onSavePrompt: (input: TaskWorkspacePromptSaveInput) => Promise<void>;
}) {
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <details
      className="group rounded-lg border border-border/80"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 p-3 outline-none hover:bg-app-hover focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-open:rotate-90"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{block.title}</div>
          <div className="mt-1 truncate font-mono text-xs text-text-muted">{block.ref}</div>
        </div>
        <TaskWorkspaceExecutorSelect
          className="w-48 shrink-0"
          compact
          executorName={block.executor}
          executorOptions={executorOptions}
          inheritLabel={labels.inheritTaskExecutor}
          label={labels.blockExecutor}
          labels={{ saved: labels.executorSaved, saving: labels.executorSaving }}
          onSave={onSaveExecutor}
          packageExecutorNames={packageExecutorNames}
        />
        <Badge variant="outline">{block.status}</Badge>
      </summary>
      <div className="border-t border-border/80 p-4">
        <TaskWorkspaceBlockPrompts
          block={block}
          labels={labels.promptLabels}
          onSave={onSavePrompt}
        />
      </div>
    </details>
  );
}

export function TaskWorkspaceOverview({
  labels,
  onSelect,
  selected,
  workspace
}: {
  labels: TaskWorkspaceTimelineLabels;
  onSelect: () => void;
  selected: boolean;
  workspace: TaskWorkspace;
}) {
  const runs = activeRuns(workspace);
  const latestArtifact = artifactPath(workspace);

  return (
    <button
      aria-current={selected ? "page" : undefined}
      className={cn(
        "w-full space-y-3 border-b border-border/80 p-3 text-left outline-none transition-colors",
        "hover:bg-app-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        selected && "bg-primary/10"
      )}
      data-testid="task-workspace-overview-entry"
      onClick={onSelect}
      type="button"
    >
      <div>
        <h2 className="text-xs font-semibold tracking-wide text-text-muted uppercase">
          {labels.overview}
        </h2>
        <p className="mt-1 truncate text-sm font-medium">{workspace.task.title}</p>
        <p className="mt-2 text-xs font-medium">{labels.activeRuns(runs.length)}</p>
        <p className="mt-1 truncate text-xs text-text-muted">
          {runs.length > 0 ? runs.map((run) => run.blockTitle).join(" · ") : labels.noActiveRuns}
        </p>
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
        <div className="mt-1 truncate text-text-muted" title={latestArtifact ?? undefined}>
          {latestArtifact ?? labels.noArtifact}
        </div>
      </div>
    </button>
  );
}

export function TaskWorkspaceOverviewPanel({
  executorOptions,
  focusedBlockRef,
  labels,
  onSaveBlockExecutor,
  onSaveBlockPrompt,
  onSaveTaskExecutor,
  onSaveTaskPrompt,
  packageExecutorNames,
  workspace
}: {
  executorOptions: readonly string[];
  focusedBlockRef: string | null;
  labels: TaskWorkspaceLabels;
  onSaveBlockExecutor: (blockRef: string, executorName: string | null) => Promise<void>;
  onSaveBlockPrompt: (blockRef: string, input: TaskWorkspacePromptSaveInput) => Promise<void>;
  onSaveTaskExecutor: (executorName: string | null) => Promise<void>;
  onSaveTaskPrompt: (input: TaskWorkspacePromptSaveInput) => Promise<void>;
  packageExecutorNames: readonly string[];
  workspace: TaskWorkspace;
}) {
  const runs = activeRuns(workspace);
  const latestArtifact = artifactPath(workspace);

  return (
    <article
      className="h-full min-h-0 w-full overflow-y-auto [scrollbar-gutter:stable]"
      data-testid="task-workspace-overview-panel"
    >
      <div className="mx-auto w-full max-w-5xl space-y-8 p-6 sm:p-8">
        <header className="grid gap-5 border-b border-border/80 pb-6 md:grid-cols-[minmax(0,1fr)_18rem] md:items-end">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{labels.overview}</Badge>
              <Badge variant="secondary">{labels.taskStatus[workspace.task.status]}</Badge>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{workspace.task.title}</h1>
            <p className="font-mono text-xs text-text-muted">{workspace.task.taskId}</p>
          </div>
          <TaskWorkspaceExecutorSelect
            executorName={workspace.task.executor}
            executorOptions={executorOptions}
            inheritLabel={labels.inheritCanvasExecutor}
            label={labels.taskExecutor}
            labels={{ saved: labels.executorSaved, saving: labels.executorSaving }}
            onSave={onSaveTaskExecutor}
            packageExecutorNames={packageExecutorNames}
          />
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border border-border/80 p-4 lg:col-span-2">
            <h2 className="text-sm font-semibold">{labels.activeRuns(runs.length)}</h2>
            {runs.length === 0 ? (
              <p className="mt-3 text-sm text-text-muted">{labels.noActiveRuns}</p>
            ) : (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {runs.map((run) => (
                  <li className="rounded-md bg-app-panel p-3" key={run.recordId}>
                    <div className="truncate text-sm font-medium">{run.blockTitle}</div>
                    <div className="mt-1 truncate font-mono text-xs text-text-muted">
                      {run.agent ?? labels.unavailable} · {run.runId}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border border-border/80 p-4">
            <h2 className="text-sm font-semibold">{labels.dependencies}</h2>
            <div className="mt-3 text-2xl font-semibold tabular-nums">
              {workspace.dependencyProgress.percent}%
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {labels.dependencyProgress(
                workspace.dependencyProgress.completed,
                workspace.dependencyProgress.total,
                workspace.dependencyProgress.percent
              )}
            </p>
            <progress
              aria-label={labels.dependencies}
              className="mt-3 h-2 w-full accent-primary"
              max={100}
              value={workspace.dependencyProgress.percent}
            />
          </div>
        </section>

        <section className="space-y-3">
          <TaskWorkspaceTaskPrompt
            labels={labels.promptLabels}
            onSave={onSaveTaskPrompt}
            task={workspace.task}
          />
        </section>

        <section>
          <h2 className="text-sm font-semibold">{labels.acceptanceCriteria}</h2>
          {workspace.task.acceptance.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">{labels.unavailable}</p>
          ) : (
            <ol className="mt-3 space-y-2">
              {workspace.task.acceptance.map((criterion, index) => (
                <li className="flex gap-3 text-sm" key={`${index}:${criterion}`}>
                  <span className="font-mono text-xs text-text-muted">{index + 1}.</span>
                  <span>{criterion}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold">{labels.blocks}</h2>
          <div className="mt-3 space-y-3">
            {workspace.blocks.map((block) => {
              const initiallyOpen = block.ref === focusedBlockRef || workspace.blocks.length === 1;
              return (
                <BlockPromptDisclosure
                  block={block}
                  executorOptions={executorOptions}
                  initiallyOpen={initiallyOpen}
                  key={`${block.ref}:${initiallyOpen}`}
                  labels={labels}
                  onSaveExecutor={(executorName) => onSaveBlockExecutor(block.ref, executorName)}
                  onSavePrompt={(input) => onSaveBlockPrompt(block.ref, input)}
                  packageExecutorNames={packageExecutorNames}
                />
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-border/80 p-4">
          <h2 className="text-sm font-semibold">{labels.latestArtifact}</h2>
          <p className="mt-2 break-all font-mono text-xs text-text-muted">
            {latestArtifact ?? labels.noArtifact}
          </p>
        </section>
      </div>
    </article>
  );
}
