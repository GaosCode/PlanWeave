import { useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { buildExecutorOptionViews, executorOptionName } from "../executors/executorOptionViewModel";

const inheritExecutorValue = "__inherit";

type ExecutorSaveStatus = "idle" | "saving" | "saved" | "error";

export function TaskWorkspaceExecutorSelect({
  className,
  compact = false,
  executorName,
  executorOptions,
  inheritLabel,
  label,
  labels,
  onSave,
  packageExecutorNames
}: {
  className?: string;
  compact?: boolean;
  executorName: string | null;
  executorOptions: readonly string[];
  inheritLabel?: string;
  label: string;
  labels: { custom: string; saved: string; saving: string };
  onSave: (executorName: string | null) => Promise<void>;
  packageExecutorNames: readonly string[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ExecutorSaveStatus>("idle");
  const selectedValue = executorOptionName(
    executorName ?? (inheritLabel ? inheritExecutorValue : "manual"),
    packageExecutorNames
  );
  const [displayedValue, setDisplayedValue] = useState(selectedValue);
  const options = useMemo(
    () =>
      buildExecutorOptionViews({
        currentExecutorNames: executorName ? [executorName] : inheritLabel ? [] : ["manual"],
        executorOptions,
        literalExecutorNames: packageExecutorNames
      }),
    [executorName, executorOptions, inheritLabel, packageExecutorNames]
  );

  useEffect(() => {
    setDisplayedValue(selectedValue);
    setError(null);
    setStatus("idle");
  }, [selectedValue]);

  const save = async (value: string) => {
    setDisplayedValue(value);
    setError(null);
    setStatus("saving");
    try {
      await onSave(value === inheritExecutorValue ? null : value);
      setStatus("saved");
    } catch (caught: unknown) {
      setDisplayedValue(selectedValue);
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("error");
    }
  };

  return (
    <div
      className={cn("min-w-0", className)}
      data-testid={`task-workspace-executor-select:${label}`}
    >
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
        {label}
      </div>
      <Select
        disabled={status === "saving"}
        onValueChange={(value) => void save(value)}
        value={displayedValue}
      >
        <SelectTrigger
          aria-label={label}
          className={cn("w-full", compact && "h-8 text-xs")}
          onClick={(event) => event.stopPropagation()}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {inheritLabel ? (
              <SelectItem value={inheritExecutorValue}>{inheritLabel}</SelectItem>
            ) : null}
            {options.map((executor) => (
              <SelectItem key={executor.name} value={executor.name}>
                <span className="flex min-w-0 items-center gap-2">
                  <span>{executor.label}</span>
                  {executor.custom ? (
                    <span className="text-xs text-muted-foreground">{labels.custom}</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {status === "saving" ? (
        <p className="mt-1 text-xs text-text-muted" role="status">
          {labels.saving}
        </p>
      ) : status === "saved" ? (
        <p className="mt-1 text-xs text-primary" role="status">
          {labels.saved}
        </p>
      ) : error ? (
        <p className="mt-1 max-w-72 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
