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
  const label = t("accessScopeLabel");
  return (
    <div className="px-1 pb-4" data-testid="workspace-access-scope-selector">
      <div className="flex min-w-0 flex-col gap-2">
        <label
          id="workspace-access-scope-label"
          htmlFor="workspace-access-scope"
          className="text-xs font-semibold text-text-strong"
        >
          {label}
        </label>
        <Select
          value={selectedKey ?? undefined}
          onValueChange={onSelect}
          disabled={loading || busy || options.length === 0}
        >
          <SelectTrigger
            id="workspace-access-scope"
            aria-labelledby="workspace-access-scope-label"
            className="h-9 w-full max-w-xl"
            data-testid="workspace-access-scope-select"
            data-value={selectedKey ?? ""}
          >
            <SelectValue placeholder={t("accessScopeEmpty")} />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {options.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.projectLabel} / {option.canvasLabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {loading ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {t("accessScopeLoading")}
        </p>
      ) : error ? (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
