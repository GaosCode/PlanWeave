import type { TaskWorkspace, TaskWorkspaceBlock } from "@planweave-ai/runtime";
import { useEffect, useSyncExternalStore } from "react";
import type { TaskWorkspacePromptDraft } from "./taskWorkspacePromptDraft";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TaskWorkspacePromptLabels } from "./contracts";

type PromptSaveStatus = "idle" | "saving" | "saved" | "error" | "retired";

function PromptStateBadge({
  empty,
  labels,
  missing
}: {
  empty: boolean;
  labels: TaskWorkspacePromptLabels;
  missing: boolean;
}) {
  if (missing) {
    return <Badge variant="destructive">{labels.missing}</Badge>;
  }
  if (empty) {
    return <Badge variant="secondary">{labels.empty}</Badge>;
  }
  return null;
}

function promptStatusText(status: PromptSaveStatus, labels: TaskWorkspacePromptLabels) {
  if (status === "saving") {
    return labels.saving;
  }
  if (status === "saved") {
    return labels.saved;
  }
  return null;
}

function PromptBody({
  label,
  markdown,
  missing,
  labels,
  compact = false
}: {
  label: string;
  markdown: string;
  missing: boolean;
  labels: TaskWorkspacePromptLabels;
  compact?: boolean;
}) {
  const empty = markdown.length === 0;
  const heightClass = compact ? "max-h-52" : "max-h-80 min-h-20";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">{label}</h4>
        <PromptStateBadge empty={empty} labels={labels} missing={missing} />
      </div>
      <pre
        aria-label={label}
        className={cn(
          "overflow-auto rounded-md border border-border/80 bg-app-panel p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap",
          heightClass
        )}
        role="document"
      >
        {markdown}
      </pre>
    </div>
  );
}

function EditablePromptBody({
  label,
  markdown,
  missing,
  labels,
  owner
}: {
  label: string;
  markdown: string;
  missing: boolean;
  labels: TaskWorkspacePromptLabels;
  owner: TaskWorkspacePromptDraft;
}) {
  const draftOwner = owner;
  const { baseline, draft, composing, error, pending, status } = useSyncExternalStore(
    draftOwner.subscribe,
    draftOwner.getSnapshot
  );
  const dirty = draft !== baseline;
  const save = draftOwner.save;
  useEffect(() => draftOwner.updateSource(markdown), [draftOwner, markdown]);
  useEffect(() => () => draftOwner.setComposing(false), [draftOwner]);

  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="text-xs font-semibold">{label}</h4>
          <PromptStateBadge empty={draft.length === 0} labels={labels} missing={missing} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span aria-live="polite" className="text-xs text-text-muted">
            {promptStatusText(status, labels)}
          </span>
          <Button
            disabled={!dirty || composing || pending}
            size="sm"
            type="submit"
            variant="outline"
          >
            {labels.savePrompt}
          </Button>
        </div>
      </div>
      <Textarea
        aria-label={label}
        className="min-h-48 resize-y bg-app-panel font-mono text-xs leading-relaxed"
        onChange={(event) => draftOwner.edit(event.target.value)}
        onCompositionStart={() => draftOwner.setComposing(true)}
        onCompositionEnd={() => draftOwner.setComposing(false)}
        onBlur={() => {
          void save();
        }}
        spellCheck={false}
        value={draft}
      />
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function PromptSources({
  block,
  labels
}: {
  block: TaskWorkspaceBlock;
  labels: TaskWorkspacePromptLabels;
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold">{labels.promptSources}</h4>
      <div className="flex flex-wrap gap-1">
        {block.promptSources.map((source) => {
          const status = source.missing
            ? labels.missing
            : source.empty
              ? labels.empty
              : source.included
                ? labels.included
                : labels.disabled;
          return (
            <Badge
              key={source.kind}
              title={source.disabledReason ?? (source.preview || undefined)}
              variant={source.included ? "outline" : "secondary"}
            >
              {source.label}: {status}
            </Badge>
          );
        })}
      </div>
    </div>
  );
}

export function TaskWorkspaceTaskPrompt({
  compact,
  labels,
  owner,
  task
}: {
  compact?: boolean;
  labels: TaskWorkspacePromptLabels;
  owner?: TaskWorkspacePromptDraft;
  task: TaskWorkspace["task"];
}) {
  if (owner) {
    return (
      <EditablePromptBody
        label={labels.taskPrompt}
        labels={labels}
        markdown={task.promptMarkdown}
        missing={task.promptMissing}
        owner={owner}
      />
    );
  }
  return (
    <PromptBody
      compact={compact}
      label={labels.taskPrompt}
      labels={labels}
      markdown={task.promptMarkdown}
      missing={task.promptMissing}
    />
  );
}

export function TaskWorkspaceBlockPrompts({
  block,
  compact,
  labels,
  owner
}: {
  block: TaskWorkspaceBlock;
  compact?: boolean;
  labels: TaskWorkspacePromptLabels;
  owner?: TaskWorkspacePromptDraft;
}) {
  let blockPrompt = (
    <PromptBody
      compact={compact}
      label={labels.blockPrompt}
      labels={labels}
      markdown={block.promptMarkdown}
      missing={block.promptMissing}
    />
  );
  if (owner) {
    blockPrompt = (
      <EditablePromptBody
        label={labels.blockPrompt}
        labels={labels}
        markdown={block.promptMarkdown}
        missing={block.promptMissing}
        owner={owner}
      />
    );
  }

  return (
    <div className="space-y-4" data-testid={`task-workspace-block-prompts:${block.ref}`}>
      <PromptSources block={block} labels={labels} />
      {blockPrompt}
      <PromptBody
        compact={compact}
        label={labels.effectivePrompt}
        labels={labels}
        markdown={block.promptSurfaceMarkdown}
        missing={false}
      />
    </div>
  );
}
