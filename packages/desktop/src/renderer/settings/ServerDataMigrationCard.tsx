import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type {
  ExportServerDataArchiveResult,
  RestoreServerDataArchiveResult,
  ServerDataExportSource
} from "../../shared/serverDataMigration";
import { logCollaborationRendererError } from "../collaboration/formatCollaborationError";
import type { createTranslator } from "../i18n";

function resultCopy(
  status: ExportServerDataArchiveResult["status"] | RestoreServerDataArchiveResult["status"],
  t: ReturnType<typeof createTranslator>
): string {
  switch (status) {
    case "exported":
      return t("settingsServerDataExported");
    case "restored":
      return t("settingsServerDataImported");
    case "cancelled":
      return t("settingsServerDataCancelled");
    case "running":
      return t("settingsServerDataRunning");
    case "empty":
      return t("settingsServerDataEmpty");
    case "unavailable":
      return t("settingsServerDataUnavailable");
    case "invalid_archive":
      return t("settingsServerDataInvalid");
    case "needs_overwrite":
      return t("settingsServerDataOverwriteConfirm");
    default:
      return "";
  }
}

export function ServerDataMigrationCard({
  api,
  t
}: {
  api: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
}) {
  const [sources, setSources] = useState<ServerDataExportSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshSources = useCallback(async () => {
    if (!api) return;
    const result = await api.listServerDataExportSources();
    setSources(result.sources);
  }, [api]);

  useEffect(() => {
    void refreshSources().catch((error: unknown) => {
      logCollaborationRendererError("server-data-sources", error);
    });
  }, [refreshSources]);

  const selected = sources.find((source) => source.id === "this_computer");
  const running = selected?.running === true;
  const exportDisabled = !api || busy || running;

  const handleExport = async () => {
    if (!api) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.exportServerDataArchive({ sourceId: "this_computer" });
      setMessage(resultCopy(result.status, t));
      await refreshSources();
    } catch (error) {
      logCollaborationRendererError("server-data-export", error);
      setMessage(t("settingsServerDataUnavailable"));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!api) return;
    setBusy(true);
    setMessage(null);
    try {
      let result = await api.restoreServerDataArchive();
      if (result.status === "needs_overwrite") {
        if (!window.confirm(t("settingsServerDataOverwriteConfirm"))) {
          setMessage(t("settingsServerDataCancelled"));
          return;
        }
        result = await api.restoreServerDataArchive({ overwrite: true });
      }
      setMessage(resultCopy(result.status, t));
      await refreshSources();
    } catch (error) {
      logCollaborationRendererError("server-data-import", error);
      setMessage(t("settingsServerDataUnavailable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-lg border border-border/70 px-5 py-5"
      data-testid="server-data-migration"
    >
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-text-strong">{t("settingsServerDataTitle")}</h2>
        <p className="mt-1 text-xs leading-5 text-text-muted">{t("serverDataLocalScope")}</p>
      </div>
      <div className="divide-y divide-border/60">
        <div className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">{t("serverDataExportTitle")}</h3>
            <p className="mt-1 text-xs leading-5 text-text-muted">{t("serverDataExportHint")}</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={exportDisabled}
            data-testid="server-data-export"
            onClick={() => void handleExport()}
          >
            {t("settingsServerDataExport")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">{t("serverDataImportTitle")}</h3>
            <p className="mt-1 text-xs leading-5 text-text-muted">{t("serverDataImportHint")}</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!api || busy || running}
            data-testid="server-data-import"
            onClick={() => void handleImport()}
          >
            {t("settingsServerDataImport")}
          </Button>
        </div>
      </div>
      <details className="mt-2 border-t border-border/60 pt-4 text-xs text-text-muted">
        <summary className="w-fit cursor-pointer">{t("serverDataMigrationDetails")}</summary>
        <p className="mt-3 leading-5">{t("settingsServerDataHint")}</p>
        <p className="mt-2 leading-5">{t("settingsServerDataImportHint")}</p>
      </details>
      {running || message ? (
        <p
          className="mt-4 rounded-md bg-muted/50 px-3 py-2 text-sm text-text-strong"
          data-testid="server-data-migration-status"
          role="status"
        >
          {running ? t("settingsServerDataRunning") : message}
        </p>
      ) : null}
    </section>
  );
}
