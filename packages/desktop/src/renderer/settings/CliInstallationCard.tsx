import { desktopCommandBridge } from "../desktopCommandBridge.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cliInstallCommand, type CliInstallation } from "../../shared/cliInstallation";
import type { createTranslator } from "../i18n";

export function CliInstallationCard({ t }: { t: ReturnType<typeof createTranslator> }) {
  const [installation, setInstallation] = useState<CliInstallation | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const api = window.planweaveCliInstallation
    ? desktopCommandBridge(window.planweaveCliInstallation)
    : undefined;
  const refresh = useCallback(async () => {
    if (!api) return;
    const id = ++request.current;
    setChecking(true);
    setError(null);
    setCopied(false);
    try {
      const result = await api.detect();
      if (id === request.current) setInstallation(result);
    } catch (cause) {
      if (id === request.current) {
        setInstallation(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (id === request.current) setChecking(false);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);

  const cli = installation?.cli;
  const canInstall = installation?.nodeSupported && installation.npm.status === "available";
  const copy = async () => {
    if (!api) return;
    try {
      await api.copyInstallCommand();
      setCopied(true);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section data-testid="settings-cli-installation" className="flex min-w-0 flex-col gap-3">
      <h2 className="text-base font-semibold text-text-strong">{t("cliTools")}</h2>
      <div className="min-w-0 rounded-md border border-border/80 bg-surface-raised px-5 py-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-56">
            <h3 className="text-sm font-semibold">PlanWeave CLI</h3>
            <p className="mt-1 text-sm text-text-muted">{t("cliToolsHint")}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!api || checking}
            onClick={() => void refresh()}
          >
            {checking ? t("cliChecking") : t("cliRefresh")}
          </Button>
        </div>
        <div className="mt-3 space-y-2 text-sm" aria-live="polite" aria-busy={checking}>
          {!api ? <p>{t("cliDesktopOnly")}</p> : null}
          {cli ? (
            <p className="font-medium">
              {t(
                cli.status === "available"
                  ? "cliInstalled"
                  : cli.status === "missing"
                    ? "cliMissing"
                    : "cliUnavailable"
              )}
              {cli.status === "available" ? ` · ${cli.version}` : null}
            </p>
          ) : null}
          {cli && cli.status !== "missing" ? (
            <p className="break-all font-mono text-xs text-text-muted">{cli.path}</p>
          ) : null}
          {cli?.status === "unavailable" ? (
            <p className="break-words text-destructive [overflow-wrap:anywhere]">{cli.error}</p>
          ) : null}
          {cli?.status === "missing" && installation ? (
            canInstall ? (
              <>
                <p className="text-text-muted">{t("cliInstallHint")}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <code className="min-w-0 break-all rounded bg-surface-muted px-3 py-2 text-xs">
                    {cliInstallCommand}
                  </code>
                  <Button size="sm" variant="outline" onClick={() => void copy()}>
                    {t(copied ? "cliCopied" : "cliCopyInstall")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-text-muted">{t("cliPrerequisiteHint")}</p>
                {[
                  { name: "Node.js", probe: installation.node },
                  { name: "npm", probe: installation.npm }
                ].map(({ name, probe }) =>
                  probe.status === "unavailable" ? (
                    <p key={name} className="break-words text-destructive [overflow-wrap:anywhere]">
                      {name}: {probe.error}
                    </p>
                  ) : null
                )}
              </>
            )
          ) : null}
          {error ? (
            <p role="alert" className="break-words text-destructive [overflow-wrap:anywhere]">
              {t("cliOperationFailed")}: {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
