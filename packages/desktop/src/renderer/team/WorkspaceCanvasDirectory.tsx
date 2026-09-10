import { useMemo, useState } from "react";
import { FileTextIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";
import type { createTranslator } from "../i18n";
import { collaborationConnectionErrorMessage } from "../collaboration/formatCollaborationError";
import { useWorkspaceCanvasDirectory } from "../hooks/useWorkspaceCanvasDirectory";

export function WorkspaceCanvasDirectory({
  api,
  connectionKey,
  workspaceId,
  connected,
  emptyWorkspace = false,
  onOpen,
  onReconnect,
  t
}: {
  api: PlanWeaveCollaborationApi | null;
  connectionKey: string | null;
  workspaceId?: string | null;
  connected: boolean;
  emptyWorkspace?: boolean;
  onOpen?: (locator: WorkspaceCanvasLocator) => void;
  onReconnect: () => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const directory = useWorkspaceCanvasDirectory({ api, connectionKey, workspaceId, connected });
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("all");
  const items = useMemo(
    () =>
      directory.canvases
        .filter((canvas) => canvas.visibility === "shared")
        .map((canvas) => {
          const local = directory.candidates.find(
            (candidate) =>
              candidate.workspaceCanvasId === canvas.registry.canvasId &&
              (candidate.localProjectId === canvas.registry.projectId ||
                candidate.localProjectId === canvas.publishSource?.localProjectId)
          );
          return {
            canvas,
            name: local?.canvasName ?? canvas.registry.canvasId,
            projectName: local?.projectName ?? canvas.registry.projectId
          };
        }),
    [directory.canvases, directory.candidates]
  );
  const projects = [
    ...new Map(items.map((item) => [item.canvas.registry.projectId, item.projectName])).entries()
  ];
  const visible = items.filter(
    (item) =>
      (projectId === "all" || item.canvas.registry.projectId === projectId) &&
      `${item.name} ${item.projectName}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase())
  );
  if (emptyWorkspace)
    return <p className="py-6 text-sm text-text-muted">{t("workspaceNoSharedCanvases")}</p>;
  if (!connected)
    return (
      <div className="flex items-center justify-between gap-4 rounded-md bg-amber-500/10 px-4 py-3 text-sm">
        <p>{t("workspaceUnavailable")}</p>
        <Button variant="outline" size="sm" onClick={onReconnect}>
          {t("peopleWorkspaceSwitch")}
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-6" data-testid="workspace-canvas-directory">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <SearchIcon className="absolute top-2 left-3 size-4 text-text-muted" />
          <Input
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("workspaceSearchCanvases")}
            aria-label={t("workspaceSearchCanvases")}
          />
        </div>
        <select
          className="h-8 rounded-md border border-border bg-background px-3 text-sm"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          aria-label={t("workspaceProjectColumn")}
        >
          <option value="all">{t("workspaceAllProjects")}</option>
          {projects.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label={t("managementRefresh")}
          disabled={directory.loading}
          onClick={() => void directory.refresh()}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      </div>
      {directory.error ? (
        <p className="text-sm text-destructive" role="alert">
          {collaborationConnectionErrorMessage(t, directory.error)}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="border-b border-border/70 text-xs text-text-muted">
            <tr>
              <th className="pb-3 font-medium">{t("workspaceCanvasColumn")}</th>
              <th className="pb-3 font-medium">{t("workspaceProjectColumn")}</th>
              <th className="pb-3 font-medium">{t("workspaceUpdatedColumn")}</th>
              <th className="pb-3">
                <span className="sr-only">{t("managementActions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ canvas, name, projectName }) => (
              <tr
                key={`${canvas.registry.projectId}:${canvas.registry.canvasId}`}
                className="border-b border-border/60"
                data-testid="workspace-directory-row"
              >
                <td className="py-5 pr-4">
                  <span className="flex items-center gap-3 font-medium text-text-strong">
                    <FileTextIcon className="size-4 shrink-0 text-text-muted" />
                    {name}
                  </span>
                </td>
                <td className="py-5 pr-4 text-text-muted">{projectName}</td>
                <td className="py-5 pr-4 text-text-muted">
                  {new Date(canvas.updatedAt).toLocaleDateString(t("hostAdminLocale"))}
                </td>
                <td className="py-5 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!onOpen || !connectionKey}
                    onClick={() => {
                      if (connectionKey)
                        onOpen?.({
                          kind: "workspace",
                          connectionProfileId: connectionKey,
                          workspaceId: canvas.registry.workspaceId,
                          projectId: canvas.registry.projectId,
                          canvasId: canvas.registry.canvasId
                        });
                    }}
                  >
                    {t("open")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {directory.loading ? (
        <p className="text-sm text-text-muted" role="status">
          {t("workspaceCanvasSharingLoading")}
        </p>
      ) : !directory.error && visible.length === 0 ? (
        <p className="py-6 text-sm text-text-muted">
          {t(items.length === 0 ? "workspaceNoSharedCanvases" : "workspaceNoResults")}
        </p>
      ) : (
        <p className="text-xs text-text-muted">
          {t("workspaceCanvasCount").replace("{count}", String(visible.length))}
        </p>
      )}
    </div>
  );
}
