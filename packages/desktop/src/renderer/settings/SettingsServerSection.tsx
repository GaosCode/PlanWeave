import { useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LocalServerLifecycleControls } from "../collaboration/LocalServerLifecycleControls";
import { collaborationBridge } from "../bridge";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import type { createTranslator } from "../i18n";
import { CollaborationConnectForm } from "../team/CollaborationConnectForm";
import { DeploymentConnectionCard } from "./DeploymentConnectionCard";
import { ServerDataMigrationCard } from "./ServerDataMigrationCard";

export type SettingsServerSectionProps = {
  t: ReturnType<typeof createTranslator>;
  showHeader?: boolean;
  maintenance?: boolean;
};

/** Server hosting, remote endpoint, and device connection for an existing Server. */
export function SettingsServerSection({
  t,
  showHeader = true,
  maintenance = false
}: SettingsServerSectionProps) {
  const [existingServer, setExistingServer] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [statusEpoch, setStatusEpoch] = useState(0);
  const { status, refresh } = useCollaborationStatus({ api: collaborationBridge });
  const handleConnectionApplied = async () => {
    await refresh();
    setStatusEpoch((epoch) => epoch + 1);
  };
  const handleExistingServerChange = (existing: boolean) => {
    setExistingServer(existing);
    if (!existing) setPasteOpen(false);
  };
  return (
    <section
      data-testid="settings-server-section"
      className={maintenance ? "flex max-w-3xl flex-col gap-6" : "flex flex-col gap-6"}
    >
      {showHeader ? (
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
            {t("settingsServer")}
          </h1>
          <p className="mt-1 text-sm text-text-muted">{t("settingsServerHint")}</p>
        </div>
      ) : null}

      <div
        className={
          maintenance
            ? "flex flex-col rounded-lg border border-border/70 px-5 pb-4 pt-2"
            : "flex max-w-3xl flex-col"
        }
        data-testid="settings-server-panels"
      >
        {maintenance ? (
          <div data-testid="settings-server-lifecycle-block">
            <LocalServerLifecycleControls
              api={collaborationBridge}
              t={t}
              localOnly
              showIdleStart
              refreshToken={statusEpoch}
              onRetried={handleConnectionApplied}
            />
          </div>
        ) : null}
        <div data-testid="settings-server-connection-block">
          {maintenance ? (
            <p className="pt-4 text-xs leading-5 text-text-muted">{t("serverLocalHostingHint")}</p>
          ) : null}
          <DeploymentConnectionCard
            presentation="plain"
            connectionOnly={!maintenance}
            localOnly={maintenance}
            showHeading={false}
            t={t}
            onExistingServerChange={handleExistingServerChange}
            existingServerTools={maintenance ? "visible" : "hidden"}
            showAdvertisedOrigin={false}
            onConnected={handleConnectionApplied}
            onNeedConnectionDetails={() => setPasteOpen(true)}
            connectAlternative={
              existingServer ? (
                <div className="flex flex-col gap-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-fit px-0 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-text-strong"
                    aria-expanded={pasteOpen}
                    data-testid="people-connect-handoff-fallback"
                    onClick={() => setPasteOpen((open) => !open)}
                  >
                    {pasteOpen ? (
                      <ChevronUpIcon className="size-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronDownIcon className="size-3.5" aria-hidden="true" />
                    )}
                    {t("settingsServerHandoffFallback")}
                  </Button>
                  {pasteOpen ? (
                    <div data-testid="settings-server-existing-connect">
                      <CollaborationConnectForm
                        api={collaborationBridge}
                        diagnosticsEnabled={false}
                        status={status}
                        t={t}
                        fixedMode="setup"
                        showHeader={false}
                        showConnectionSummary={false}
                        showWorkspacePicker={false}
                        showSetupTrustNote={false}
                        setupSubmitAfterPaste
                        handoffAsFallback={false}
                        submitAlign="start"
                        submitSize="sm"
                        submitLabel={t("settingsServerConnect")}
                        onConnected={handleConnectionApplied}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null
            }
          />
        </div>
      </div>

      {maintenance ? <ServerDataMigrationCard api={collaborationBridge} t={t} /> : null}
    </section>
  );
}
