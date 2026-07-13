import { useMemo, useState } from "react";
import { DownloadIcon, RefreshCwIcon, RotateCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppUpdateState } from "../../shared/appUpdate";
import type { createTranslator } from "../i18n";

type AppUpdateToastProps = {
  onCheck: () => Promise<void>;
  onDismiss?: () => void;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  state: AppUpdateState;
  t: ReturnType<typeof createTranslator>;
};

function toastKey(state: AppUpdateState): string | null {
  if (state.status === "available" || state.status === "downloaded") {
    return `${state.status}:${state.update.version}`;
  }
  if (state.status === "downloading") {
    return `downloading:${state.update.version}`;
  }
  if (state.status === "error") {
    return `error:${state.error}`;
  }
  return null;
}

function updateLabel(state: AppUpdateState, t: ReturnType<typeof createTranslator>): string {
  if (state.update?.version) {
    return `${t("appUpdateVersion")} ${state.update.version}`;
  }
  return t("appUpdateUnknownVersion");
}

export function AppUpdateToast({ onCheck, onDismiss, onDownload, onInstall, state, t }: AppUpdateToastProps) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const key = toastKey(state);
  const hidden = !key || dismissedKey === key || state.status === "unsupported";
  const progressPercent = state.status === "downloading" ? Math.round(state.progress.percent) : 0;
  const title = useMemo(() => {
    switch (state.status) {
      case "available":
        return t("appUpdateAvailable");
      case "downloading":
        return t("appUpdateDownloading");
      case "downloaded":
        return t("appUpdateDownloaded");
      case "error":
        return t("appUpdateFailed");
      default:
        return "";
    }
  }, [state.status, t]);

  if (hidden) {
    return null;
  }

  const dismiss = () => {
    setDismissedKey(key);
    onDismiss?.();
  };

  return (
    <aside
      aria-live="polite"
      className="app-no-drag fixed bottom-4 left-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-3 rounded-md border border-border/80 bg-surface-raised p-4 text-text shadow-xl animate-in fade-in slide-in-from-left-4 duration-[var(--motion-duration-base)] ease-[var(--motion-ease-emphasized)]"
      data-testid="app-update-toast"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-strong">{title}</div>
          <div className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words text-xs text-text-muted [overflow-wrap:anywhere]">
            {state.status === "error" ? state.error : updateLabel(state, t)}
          </div>
        </div>
        <Button aria-label={t("close")} size="icon-sm" variant="ghost" onClick={dismiss}>
          <XIcon data-icon="inline-start" />
        </Button>
      </div>
      {state.status === "downloading" ? (
        <div className="flex flex-col gap-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="text-xs text-text-muted">{`${progressPercent}%`}</div>
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        {state.status === "available" ? (
          <Button size="sm" onClick={() => void onDownload()}>
            <DownloadIcon data-icon="inline-start" />
            {t("downloadAppUpdate")}
          </Button>
        ) : null}
        {state.status === "downloaded" ? (
          <Button size="sm" onClick={() => void onInstall()}>
            <RotateCwIcon data-icon="inline-start" />
            {t("restartToInstallUpdate")}
          </Button>
        ) : null}
        {state.status === "error" ? (
          <Button size="sm" variant="outline" onClick={() => void onCheck()}>
            <RefreshCwIcon data-icon="inline-start" />
            {t("checkForAppUpdate")}
          </Button>
        ) : null}
      </div>
    </aside>
  );
}
