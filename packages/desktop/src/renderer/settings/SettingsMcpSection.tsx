import { useEffect, useState } from "react";
import { CableIcon, CircleStopIcon, DownloadIcon, PlayIcon, SaveIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import { useMcpTunnelStatus } from "../hooks/useMcpTunnelStatus";
import type { createTranslator } from "../i18n";
import { phaseVariant, tunnelStatusLabel } from "./mcpTunnelStatusView";

type SettingsMcpSectionProps = {
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export function SettingsMcpSection({ setError, t }: SettingsMcpSectionProps) {
  const {
    available,
    status,
    downloadTunnelClient,
    setTunnelClientPath,
    startLocalMcp,
    stopLocalMcp,
    setTunnelAutoStart,
    startTunnel,
    stopTunnel
  } = useMcpTunnelStatus({ setError });
  const [binaryPath, setBinaryPath] = useState("");
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeApiKey, setRuntimeApiKey] = useState("");

  useEffect(() => {
    setBinaryPath(status.binary.path ?? "");
  }, [status.binary.path]);

  useEffect(() => {
    setTunnelId(status.config.tunnelId ?? "");
  }, [status.config.tunnelId]);

  const localBusy = status.localMcp.phase === "starting" || status.localMcp.phase === "stopping";
  const tunnelBusy = status.tunnel.phase === "starting" || status.tunnel.phase === "stopping";
  const downloadBusy = status.download.phase === "downloading";
  const binaryDescription =
    status.binary.error ?? status.binary.version ?? t("mcpTunnelClientReady");
  const checksumDescription = status.binary.assetSha256
    ? `${status.binary.assetName ?? t("mcpTunnelManagedAsset")}: ${status.binary.assetSha256}`
    : t("mcpTunnelClientSha256Hint");
  const tunnelDescription =
    status.tunnel.error ??
    (status.tunnel.ready && status.tunnel.healthUrl
      ? `${t("mcpTunnelReadyHint")}: ${status.tunnel.healthUrl}`
      : (status.tunnel.healthUrl ?? status.tunnel.tunnelId ?? t("mcpTunnelStatusHint")));
  const runtimeApiKeyDescription =
    status.config.runtimeApiKeyPersistence === "persisted"
      ? t("mcpRuntimeApiKeySavedHint")
      : status.config.runtimeApiKeyPersistence === "session-only"
        ? t("mcpRuntimeApiKeySessionOnlyHint")
        : status.config.runtimeApiKeyStorage === "available"
          ? t("mcpRuntimeApiKeyHint")
          : t("mcpRuntimeApiKeyStorageUnavailableHint");
  const autoStartDisabled = !available || status.config.runtimeApiKeyPersistence !== "persisted";
  const autoStartDescription =
    status.config.runtimeApiKeyPersistence === "persisted"
      ? t("mcpTunnelAutoStartHint")
      : t("mcpTunnelAutoStartRequiresPersistedKeyHint");

  return (
    <section data-testid="settings-section-mcp" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
          {t("settingsMcpTunnel")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">{t("settingsMcpTunnelHint")}</p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-text-strong">{t("mcpTunnelClient")}</h2>
        <FieldGroup className="gap-0 overflow-hidden rounded-md border border-border/80 bg-surface-raised shadow-sm">
          <Field
            orientation="horizontal"
            className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0"
          >
            <FieldContent>
              <FieldLabel className="text-sm font-semibold">{t("mcpTunnelClientPath")}</FieldLabel>
              <FieldDescription>{binaryDescription}</FieldDescription>
            </FieldContent>
            <div className="flex min-w-0 items-center gap-2">
              <Input
                className="w-80"
                value={binaryPath}
                aria-label={t("mcpTunnelClientPath")}
                onChange={(event) => setBinaryPath(event.target.value)}
              />
              <Button
                disabled={!available}
                size="icon"
                variant="outline"
                title={t("save")}
                onClick={() => void setTunnelClientPath(binaryPath)}
              >
                <SaveIcon />
              </Button>
            </div>
          </Field>
          <Field
            orientation="horizontal"
            className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0"
          >
            <FieldContent>
              <FieldLabel className="text-sm font-semibold">
                {t("mcpTunnelClientSha256")}
              </FieldLabel>
              <FieldDescription>{checksumDescription}</FieldDescription>
              {status.binary.sha256 ? (
                <FieldDescription>{status.binary.sha256}</FieldDescription>
              ) : null}
            </FieldContent>
          </Field>
          <Field
            orientation="horizontal"
            className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0"
          >
            <FieldContent>
              <FieldLabel className="text-sm font-semibold">{t("mcpTunnelDownload")}</FieldLabel>
              <FieldDescription>
                {status.download.error ?? status.download.assetName ?? status.downloadUrl}
              </FieldDescription>
            </FieldContent>
            <div className="flex items-center gap-2">
              <Button
                disabled={!available || downloadBusy}
                size="sm"
                variant="outline"
                onClick={() => void downloadTunnelClient()}
              >
                <DownloadIcon data-icon="inline-start" />
                {downloadBusy ? t("downloadingTunnelClient") : t("downloadTunnelClient")}
              </Button>
              <Button asChild size="sm" variant="outline">
                <a href={status.downloadUrl} target="_blank" rel="noreferrer">
                  {t("openTunnelClientRelease")}
                </a>
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-text-strong">{t("mcpLocalServer")}</h2>
        <FieldGroup className="gap-0 overflow-hidden rounded-md border border-border/80 bg-surface-raised shadow-sm">
          <Field
            orientation="horizontal"
            className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0"
          >
            <FieldContent>
              <FieldLabel className="flex items-center gap-2 text-sm font-semibold">
                {t("mcpLocalServerStatus")}
                <Badge variant={phaseVariant(status.localMcp.phase)}>{status.localMcp.phase}</Badge>
              </FieldLabel>
              <FieldDescription>
                {status.localMcp.error ?? status.localMcp.endpoint ?? t("mcpLocalServerHint")}
              </FieldDescription>
              <FieldDescription>
                {t("mcpPlanweaveHome")}: {status.localMcp.planweaveHome || "-"}
              </FieldDescription>
            </FieldContent>
            <div className="flex items-center gap-2">
              <Button
                disabled={!available || localBusy || status.localMcp.phase === "running"}
                size="sm"
                variant="outline"
                onClick={() => void startLocalMcp()}
              >
                <PlayIcon data-icon="inline-start" />
                {t("startLocalMcp")}
              </Button>
              <Button
                disabled={!available || localBusy || status.localMcp.phase !== "running"}
                size="sm"
                variant="outline"
                onClick={() => void stopLocalMcp()}
              >
                <CircleStopIcon data-icon="inline-start" />
                {t("stopLocalMcp")}
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-text-strong">{t("openaiSecureTunnel")}</h2>
        <FieldGroup className="gap-0 overflow-hidden rounded-md border border-border/80 bg-surface-raised shadow-sm">
          <Field
            orientation="horizontal"
            className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0"
          >
            <FieldContent>
              <FieldLabel className="text-sm font-semibold">{t("mcpTunnelId")}</FieldLabel>
              <FieldDescription>{t("mcpTunnelIdHint")}</FieldDescription>
            </FieldContent>
            <Input
              className="w-80"
              value={tunnelId}
              aria-label={t("mcpTunnelId")}
              onChange={(event) => setTunnelId(event.target.value)}
            />
          </Field>
          <Field
            orientation="horizontal"
            className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0"
          >
            <FieldContent>
              <FieldLabel className="text-sm font-semibold">{t("mcpRuntimeApiKey")}</FieldLabel>
              <FieldDescription>{runtimeApiKeyDescription}</FieldDescription>
            </FieldContent>
            <Input
              className="w-80"
              type="password"
              value={runtimeApiKey}
              aria-label={t("mcpRuntimeApiKey")}
              placeholder={
                status.config.runtimeApiKeyPersistence === "persisted"
                  ? t("mcpRuntimeApiKeySavedPlaceholder")
                  : undefined
              }
              onChange={(event) => setRuntimeApiKey(event.target.value)}
            />
          </Field>
          <SettingsSwitchRow
            checked={status.config.autoStart}
            description={autoStartDescription}
            disabled={autoStartDisabled}
            title={t("mcpTunnelAutoStart")}
            onCheckedChange={(checked) => void setTunnelAutoStart(checked)}
          />
          <Field
            orientation="horizontal"
            className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0"
          >
            <FieldContent>
              <FieldLabel className="flex items-center gap-2 text-sm font-semibold">
                {t("mcpTunnelStatus")}
                <Badge variant={phaseVariant(status.tunnel.phase)}>
                  {tunnelStatusLabel(status.tunnel, t)}
                </Badge>
              </FieldLabel>
              <FieldDescription>{tunnelDescription}</FieldDescription>
            </FieldContent>
            <div className="flex items-center gap-2">
              <Button
                disabled={!available || tunnelBusy || status.tunnel.phase === "running"}
                size="sm"
                variant="outline"
                onClick={() => void startTunnel({ tunnelId, runtimeApiKey })}
              >
                <CableIcon data-icon="inline-start" />
                {t("startTunnel")}
              </Button>
              <Button
                disabled={!available || tunnelBusy || status.tunnel.phase !== "running"}
                size="sm"
                variant="outline"
                onClick={() => void stopTunnel()}
              >
                <CircleStopIcon data-icon="inline-start" />
                {t("stopTunnel")}
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </section>
    </section>
  );
}
