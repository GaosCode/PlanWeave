import { useCallback, useEffect, useMemo, useState } from "react";
import { ServerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  LocalCollaborationServerStatus,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import type { createTranslator } from "../i18n";
import { collaborationErrorMessage } from "./formatCollaborationError";
import { classifyLiveServer, type LiveWorkspaceSnapshot } from "./liveServerStatus";

export function LocalServerLifecycleControls({
  api,
  t,
  onStatusChange,
  onRetried,
  workspace,
  showIdleStart = true,
  refreshToken = 0
}: {
  api: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
  onStatusChange?: (status: LocalCollaborationServerStatus) => void;
  onRetried?: () => void | Promise<void>;
  workspace?: LiveWorkspaceSnapshot | null;
  showIdleStart?: boolean;
  refreshToken?: number;
}) {
  const [status, setStatus] = useState<LocalCollaborationServerStatus | null>(null);
  const [advertisedOrigin, setAdvertisedOrigin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [nextStatus, exposure] = await Promise.all([
        api.getLocalCollaborationServerStatus(),
        typeof api.getDesktopServerExposure === "function"
          ? api.getDesktopServerExposure()
          : Promise.resolve(null)
      ]);
      setStatus(nextStatus);
      setAdvertisedOrigin(exposure?.advertisedOrigin ?? null);
      onStatusChange?.(nextStatus);
      setError(null);
    } catch (caught) {
      setError(collaborationErrorMessage(caught));
    }
  }, [api, onStatusChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken explicitly triggers a status refresh
  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const running = status?.state === "running";
  const live = useMemo(
    () =>
      classifyLiveServer({
        workspace: workspace ?? null,
        localRunning: running,
        localServerBaseUrl: status?.profile?.serverBaseUrl ?? null,
        advertisedOrigin
      }),
    [advertisedOrigin, running, status?.profile?.serverBaseUrl, workspace]
  );

  const statusLabel =
    status?.state === "error"
      ? status.reason === "stop_failed"
        ? t("localServerStopFailed")
        : status.reason === "unavailable"
          ? t("localServerUnavailable")
          : t("localServerStartFailed")
      : live.kind === "local"
        ? t("settingsServerLocalConnected")
        : live.kind === "remote"
          ? live.pending
            ? t("settingsServerRemoteConnecting")
            : workspace?.status === "error" || workspace?.status === "disconnected"
              ? t("settingsServerRemoteError")
              : t("settingsServerRemoteConnected")
          : t("settingsServerNotConnected");

  const failedRemote =
    live.kind === "remote" &&
    (workspace?.status === "error" || workspace?.status === "disconnected");
  const ready = live.kind === "local" || (live.kind === "remote" && !live.pending && !failedRemote);
  const pending = live.kind === "remote" && live.pending;
  const showStop = live.kind === "local";
  const showStart = live.kind === "idle" && showIdleStart;
  const showRetry = failedRemote && typeof api?.retryWorkspaceConnection === "function";

  const runAction = async (action: "start" | "stop" | "retry") => {
    setBusy(true);
    try {
      if (!api) return;
      if (action === "retry") {
        await api.retryWorkspaceConnection();
        setError(null);
        await refresh();
        await onRetried?.();
        return;
      }
      const nextStatus =
        action === "start"
          ? await api.startLocalCollaborationServer()
          : await api.stopLocalCollaborationServer();
      setStatus(nextStatus);
      onStatusChange?.(nextStatus);
      setError(null);
    } catch (caught) {
      setError(collaborationErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="grid gap-1 border-b border-border/80 py-3.5"
      data-testid="local-server-lifecycle"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ServerIcon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          <span className="text-sm font-medium text-text-strong">{t("localServerProcess")}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              ready
                ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                : pending
                  ? "bg-amber-500/10 text-amber-800 dark:text-amber-200"
                  : "bg-muted text-muted-foreground"
            }`}
            data-testid="local-server-lifecycle-status"
          >
            <span
              className={`size-1.5 rounded-full ${
                ready ? "bg-emerald-500" : pending ? "bg-amber-500" : "bg-muted-foreground/50"
              }`}
            />
            {statusLabel}
          </span>
          {showRetry ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !api}
              data-testid="local-server-lifecycle-retry"
              onClick={() => void runAction("retry")}
            >
              {t("settingsServerRetryConnection")}
            </Button>
          ) : null}
          {showStop ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !api}
              data-testid="local-server-lifecycle-stop"
              onClick={() => void runAction("stop")}
            >
              {t("localServerStop")}
            </Button>
          ) : null}
          {showStart ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || !api || !status}
              data-testid="local-server-lifecycle-start"
              onClick={() => void runAction("start")}
            >
              {t("localServerStart")}
            </Button>
          ) : null}
        </div>
      </div>
      {live.name || live.url ? (
        <div
          className="min-w-0 pl-6 text-xs leading-5 text-text-muted"
          data-testid="settings-server-status-detail"
        >
          {live.name ? (
            <div className="truncate font-medium text-text-strong">{live.name}</div>
          ) : null}
          {live.url ? <div className="truncate">{live.url}</div> : null}
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
