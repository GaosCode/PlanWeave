import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
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
  const [sourceId, setSourceId] = useState<ServerDataExportSource["id"]>("this_computer");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshSources = useCallback(async () => {
    if (!api) return;
    const result = await api.listServerDataExportSources();
    setSources(result.sources);
    setSourceId((current) =>
      result.sources.some((source: ServerDataExportSource) => source.id === current)
        ? current
        : (result.sources[0]?.id ?? "this_computer")
    );
  }, [api]);

  useEffect(() => {
    void refreshSources().catch((error: unknown) => {
      logCollaborationRendererError("server-data-sources", error);
    });
  }, [refreshSources]);

  const selected = sources.find((source) => source.id === sourceId) ?? sources[0];
  const running = selected?.running === true;
  const exportDisabled = !api || busy || running;

  const handleExport = async () => {
    if (!api) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.exportServerDataArchive({ sourceId });
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
    <section className="flex flex-col gap-3" data-testid="server-data-migration">
      <div className="max-w-3xl">
        <h2 className="text-sm font-semibold text-text-strong">{t("settingsServerDataTitle")}</h2>
        <p className="mt-1 text-sm leading-6 text-text-muted">{t("settingsServerDataHint")}</p>
      </div>
      <div className="flex max-w-xl flex-col gap-3">
        <div className="flex flex-col gap-2">
          <label
            id="server-data-export-source-label"
            htmlFor="server-data-export-source"
            className="text-xs font-semibold text-text-strong"
          >
            {t("settingsServerDataExportSource")}
          </label>
          <Select value={sourceId} onValueChange={(value) => setSourceId(value as typeof sourceId)}>
            <SelectTrigger
              id="server-data-export-source"
              aria-labelledby="server-data-export-source-label"
              className="h-9 w-full"
              data-testid="server-data-export-source"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value="this_computer"
                data-testid="server-data-export-source-this-computer"
              >
                {t("settingsServerDataExportThisComputer")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={exportDisabled}
            data-testid="server-data-export"
            onClick={() => void handleExport()}
          >
            {t("settingsServerDataExport")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!api || busy || running}
            data-testid="server-data-import"
            onClick={() => void handleImport()}
          >
            {t("settingsServerDataImport")}
          </Button>
        </div>
        <p className="text-xs leading-5 text-text-muted">{t("settingsServerDataImportHint")}</p>
        {running ? (
          <p
            className="text-sm text-text-strong"
            data-testid="server-data-migration-status"
            role="status"
          >
            {t("settingsServerDataRunning")}
          </p>
        ) : null}
        {message && !running ? (
          <p
            className="text-sm text-text-strong"
            data-testid="server-data-migration-status"
            role="status"
          >
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
