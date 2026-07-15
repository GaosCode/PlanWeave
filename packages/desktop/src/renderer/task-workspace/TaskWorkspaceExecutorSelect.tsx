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
import { executorOptionName, executorOptionNames } from "../executors/executorOptionViewModel";

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
  inheritLabel: string;
  label: string;
  labels: { saved: string; saving: string };
  onSave: (executorName: string | null) => Promise<void>;
  packageExecutorNames: readonly string[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ExecutorSaveStatus>("idle");
  const selectedValue = executorName
    ? executorOptionName(executorName, packageExecutorNames)
    : inheritExecutorValue;
  const options = useMemo(
    () =>
      executorOptionNames({
        currentExecutorNames: executorName ? [executorName] : [],
        executorOptions,
        literalExecutorNames: packageExecutorNames
      }),
    [executorName, executorOptions, packageExecutorNames]
  );

  useEffect(() => {
    setError(null);
    setStatus("idle");
  }, [executorName]);

  const save = async (value: string) => {
    setError(null);
    setStatus("saving");
    try {
      await onSave(value === inheritExecutorValue ? null : value);
      setStatus("saved");
    } catch (caught: unknown) {
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
        value={selectedValue}
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
            <SelectItem value={inheritExecutorValue}>{inheritLabel}</SelectItem>
            {options.map((executor) => (
              <SelectItem key={executor} value={executor}>
                {executor}
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
