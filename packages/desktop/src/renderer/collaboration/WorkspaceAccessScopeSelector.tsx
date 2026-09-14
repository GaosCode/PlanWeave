import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { createTranslator } from "../i18n";
import type { WorkspaceAccessScopeOption } from "../hooks/useWorkspaceAccessScope";

export function WorkspaceAccessScopeSelector({
  options,
  selectedKey,
  loading,
  error,
  busy,
  t,
  onSelect
}: {
  options: readonly WorkspaceAccessScopeOption[];
  selectedKey: string | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  t: ReturnType<typeof createTranslator>;
  onSelect: (key: string) => void;
}) {
  const id = useId();
  const selected = options.find((option) => option.key === selectedKey);
  const projects = [
    ...new Map(options.map((option) => [option.projectId, option.projectLabel])).entries()
  ];
  const canvases = options.filter((option) => option.projectId === selected?.projectId);
  return (
    <div className="space-y-4 pb-3" data-testid="workspace-access-scope-selector">
      <div className="flex min-w-0 flex-col gap-2">
        <label htmlFor={`${id}-project`} className="text-xs font-semibold">
          {t("workspaceProjectColumn")}
        </label>
        <Select
          value={selected?.projectId ?? ""}
          disabled={loading || busy || projects.length === 0}
          onValueChange={(projectId) => {
            const first = options.find((option) => option.projectId === projectId);
            if (first) onSelect(first.key);
          }}
        >
          <SelectTrigger
            id={`${id}-project`}
            className="h-9 w-full"
            data-testid="workspace-access-project-select"
          >
            <SelectValue placeholder={t("accessScopeEmpty")} />
          </SelectTrigger>
          <SelectContent position="popper">
            {projects.map(([projectId, label]) => (
              <SelectItem key={projectId} value={projectId}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <label htmlFor={`${id}-canvas`} className="text-xs font-semibold">
          {t("workspaceCanvasColumn")}
        </label>
        <Select
          value={selectedKey ?? ""}
          disabled={loading || busy || canvases.length === 0}
          onValueChange={onSelect}
        >
          <SelectTrigger
            id={`${id}-canvas`}
            className="h-9 w-full"
            data-testid="workspace-access-scope-select"
            data-value={selectedKey ?? ""}
          >
            <SelectValue placeholder={t("accessScopeEmpty")} />
          </SelectTrigger>
          <SelectContent position="popper">
            {canvases.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.canvasLabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {loading ? (
        <p role="status" className="text-xs text-text-muted">
          {t("accessScopeLoading")}
        </p>
      ) : error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
