import type { TaskWorkspace, TaskWorkspaceBlock } from "@planweave-ai/runtime";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TaskWorkspacePromptLabels, TaskWorkspacePromptSaveInput } from "./contracts";

type PromptSaveStatus = "idle" | "saving" | "saved" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

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
  onSave
}: {
  label: string;
  markdown: string;
  missing: boolean;
  labels: TaskWorkspacePromptLabels;
  onSave: (input: TaskWorkspacePromptSaveInput) => Promise<void>;
}) {
  const [baseline, setBaseline] = useState(markdown);
  const [draft, setDraft] = useState(markdown);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<PromptSaveStatus>("idle");
  const pendingSourceMarkdown = useRef<string | null>(null);
  const sourceMarkdown = useRef(markdown);
  const dirty = draft !== baseline;

  useEffect(() => {
    if (sourceMarkdown.current !== markdown) {
      sourceMarkdown.current = markdown;
      if (dirty) {
        pendingSourceMarkdown.current = markdown;
        return;
      }
      pendingSourceMarkdown.current = null;
      setBaseline(markdown);
      setDraft(markdown);
      setError(null);
      setStatus("idle");
      return;
    }
    if (!dirty && pendingSourceMarkdown.current !== null) {
      const pendingMarkdown = pendingSourceMarkdown.current;
      pendingSourceMarkdown.current = null;
      setBaseline(pendingMarkdown);
      setDraft(pendingMarkdown);
      setError(null);
      setStatus("idle");
    }
  }, [dirty, markdown]);

  const save = async () => {
    if (!dirty || status === "saving") {
      return;
    }
    const submitted = draft;
    setError(null);
    setStatus("saving");
    try {
      await onSave({ baseMarkdown: baseline, markdown: submitted });
      setBaseline(submitted);
      setStatus("saved");
    } catch (saveError: unknown) {
      setError(errorMessage(saveError));
      setStatus("error");
    }
  };

  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        save();
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
            disabled={!dirty || status === "saving"}
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
        disabled={status === "saving"}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
          setStatus("idle");
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
  onSave,
  task
}: {
  compact?: boolean;
  labels: TaskWorkspacePromptLabels;
  onSave?: (input: TaskWorkspacePromptSaveInput) => Promise<void>;
  task: TaskWorkspace["task"];
}) {
  if (onSave) {
    return (
      <EditablePromptBody
        label={labels.taskPrompt}
        labels={labels}
        markdown={task.promptMarkdown}
        missing={task.promptMissing}
        onSave={onSave}
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
  onSave
}: {
  block: TaskWorkspaceBlock;
  compact?: boolean;
  labels: TaskWorkspacePromptLabels;
  onSave?: (input: TaskWorkspacePromptSaveInput) => Promise<void>;
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
  if (onSave) {
    blockPrompt = (
      <EditablePromptBody
        label={labels.blockPrompt}
        labels={labels}
        markdown={block.promptMarkdown}
        missing={block.promptMissing}
        onSave={onSave}
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
