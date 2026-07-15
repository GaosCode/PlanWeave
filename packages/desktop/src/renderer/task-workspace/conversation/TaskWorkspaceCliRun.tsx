import type {
  DesktopBridgeApi,
  DesktopCanvasReference,
  DesktopRunRecord,
  DesktopTerminalAppDetection,
  DesktopTerminalAppId
} from "@planweave-ai/runtime";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { bridge } from "../../bridge";
import type { createTranslator } from "../../i18n";
import { SafeMarkdown } from "../../inspector/SafeMarkdown";
import { TerminalOpenButton } from "../../inspector/TerminalOpenButton";

type TerminalApi = Pick<
  DesktopBridgeApi,
  "detectTerminalApps" | "getTerminalPreferences" | "openTerminal" | "updateTerminalPreferences"
>;

export function TaskWorkspaceCliRun({
  api = bridge,
  canvasRef,
  record,
  t
}: {
  api?: Partial<TerminalApi> | null;
  canvasRef: DesktopCanvasReference;
  record: DesktopRunRecord;
  t: ReturnType<typeof createTranslator>;
}) {
  const [apps, setApps] = useState<DesktopTerminalAppDetection[]>([]);
  const [defaultAppId, setDefaultAppId] = useState<DesktopTerminalAppId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api?.detectTerminalApps || !api.getTerminalPreferences) return;
    let disposed = false;
    void Promise.all([api.detectTerminalApps(), api.getTerminalPreferences()])
      .then(([nextApps, preferences]) => {
        if (disposed) return;
        setApps(nextApps);
        setDefaultAppId(preferences.defaultTerminalAppId);
      })
      .catch((caught: unknown) => {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      disposed = true;
    };
  }, [api]);

  const displayMarkdown = record.displayMarkdown;
  const openTerminal = async (recordId: string | null, appId: DesktopTerminalAppId) => {
    if (!api?.openTerminal) {
      setError(t("taskWorkspaceTerminalUnavailable"));
      return;
    }
    try {
      setError(null);
      await api.openTerminal({ ref: canvasRef, recordId, appId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const updateDefault = async (appId: DesktopTerminalAppId) => {
    setDefaultAppId(appId);
    if (!api?.updateTerminalPreferences) return;
    try {
      await api.updateTerminalPreferences({ defaultTerminalAppId: appId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <section
      className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-y-auto p-5 pb-[calc(var(--task-workspace-composer-height,0px)+1.25rem)]"
      data-testid="task-workspace-cli-run"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline">CLI</Badge>
          <span className="text-sm font-medium">{record.executor ?? record.adapter ?? "CLI"}</span>
        </div>
        <TerminalOpenButton
          canvasRef={canvasRef}
          defaultTerminalAppId={defaultAppId}
          label={t("openTerminal")}
          onOpenTerminal={openTerminal}
          onTerminalDefaultAppChange={updateDefault}
          recordId={record.recordId}
          terminalApps={apps}
          tmuxAvailable={false}
          t={t}
        />
      </header>
      {error ? (
        <p
          className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {displayMarkdown ? (
        <article className="rounded-xl border bg-background p-5 text-sm shadow-sm">
          <SafeMarkdown markdown={displayMarkdown} />
        </article>
      ) : (
        <p className="rounded-xl border bg-muted/20 p-5 text-sm text-muted-foreground">
          {t("noRunReport")}
        </p>
      )}
      {record.stdoutSummary ? (
        <details className="rounded-lg border bg-background px-4 py-3" open={!displayMarkdown}>
          <summary className="cursor-pointer text-sm font-medium">{t("latestOutput")}</summary>
          <pre className="mt-3 whitespace-pre-wrap break-words text-xs">{record.stdoutSummary}</pre>
        </details>
      ) : null}
      {record.stderrSummary ? (
        <details className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">{t("stderr")}</summary>
          <pre className="mt-3 whitespace-pre-wrap break-words text-xs">{record.stderrSummary}</pre>
        </details>
      ) : null}
    </section>
  );
}
