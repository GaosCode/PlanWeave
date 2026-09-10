import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { WorkspacePickerPage } from "@planweave-ai/collaboration-protocol/connection";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { createTranslator } from "../i18n";
import { collaborationConnectionErrorMessage } from "../collaboration/formatCollaborationError";
import { workspaceDisplayName } from "./workspaceConnectionPresentation";

export function WorkspaceSwitcher({
  api,
  status,
  open,
  onOpenChange,
  onJoin,
  onManageServer,
  onSelected,
  t
}: {
  api: Pick<PlanWeaveCollaborationApi, "listWorkspacePicker" | "selectWorkspaceConnection"> | null;
  status: Pick<CollaborationStatus, "workspaceConnection"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJoin: () => void;
  onManageServer?: () => void;
  onSelected: () => Promise<unknown>;
  t: ReturnType<typeof createTranslator>;
}) {
  const connection = status?.workspaceConnection;
  const [items, setItems] = useState<WorkspacePickerPage["items"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected Server and explicit retry invalidate the directory.
  useEffect(() => {
    if (!open || !api) return;
    let current = true;
    setItems([]);
    setError(null);
    setLoading(true);
    void (async () => {
      const all: WorkspacePickerPage["items"] = [];
      const visited = new Set<number>();
      let cursor = 0;
      while (true) {
        if (visited.has(cursor)) throw new Error("workspace_picker_pagination_invalid");
        visited.add(cursor);
        const page = await api.listWorkspacePicker({ cursor, limit: 100 });
        if (!current) return;
        all.push(...page.items.filter((item) => item.membershipActive && item.archivedAt === null));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      setItems(all);
    })()
      .catch((cause: unknown) => {
        if (current) setError(collaborationConnectionErrorMessage(t, cause));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, open, connection?.profile?.profileId, epoch, t]);
  const select = async (workspaceId: string) => {
    if (!api || busy) return;
    if (workspaceId === connection?.workspaceId && connection.status === "connected") {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.selectWorkspaceConnection({ workspaceId });
      await onSelected();
      onOpenChange(false);
    } catch (cause) {
      setError(collaborationConnectionErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="mb-2 max-w-60 gap-2 px-0"
          data-testid="people-current-workspace-switch"
          aria-label={t("peopleWorkspaceSwitch")}
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${connection?.status === "connected" ? "bg-emerald-500" : "bg-amber-500"}`}
          />
          <span className="truncate">
            {workspaceDisplayName(connection?.workspaceDisplayName, t)}
          </span>
          <ChevronDownIcon className="size-4 text-text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-1 p-2" data-testid="workspace-switcher">
        <p
          className="truncate px-2 py-2 text-xs text-text-muted"
          title={connection?.profile?.serverBaseUrl}
        >
          {connection?.profile?.serverBaseUrl}
        </p>
        {loading ? (
          <p className="px-2 py-3 text-xs text-text-muted" role="status">
            {t("peopleWorking")}
          </p>
        ) : null}
        {items.map((item) => (
          <button
            key={item.workspaceId}
            type="button"
            disabled={busy}
            onClick={() => void select(item.workspaceId)}
            className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left hover:bg-muted disabled:opacity-50"
            data-testid={`workspace-switch-${item.workspaceId}`}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{item.displayName}</span>
            <span className="text-xs text-text-muted">
              {t(item.role === "owner" ? "peopleRoleOwner" : "peopleRoleMember")}
            </span>
            <CheckIcon
              className={`size-4 text-sky-600 ${item.workspaceId === connection?.workspaceId ? "" : "invisible"}`}
              aria-label={
                item.workspaceId === connection?.workspaceId ? t("workspaceCurrent") : undefined
              }
            />
          </button>
        ))}
        {error ? (
          <div className="rounded-md bg-amber-500/10 p-3 text-xs leading-5">
            <p role="status">{error}</p>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setEpoch((value) => value + 1)}
            >
              {t("settingsServerRetryConnection")}
            </Button>
          </div>
        ) : null}
        <div className="mt-1 border-t border-border pt-1">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              onOpenChange(false);
              onJoin();
            }}
          >
            <PlusIcon className="size-4" />
            {t("workspaceJoinAnother")}
          </Button>
          {onManageServer ? (
            <Button
              variant="ghost"
              className="w-full justify-start text-text-muted"
              onClick={() => {
                onOpenChange(false);
                onManageServer();
              }}
            >
              {t("serverConnections")}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
