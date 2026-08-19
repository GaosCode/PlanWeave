import { useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LocalServerLifecycleControls } from "../collaboration/LocalServerLifecycleControls";
import type { LiveWorkspaceSnapshot } from "../collaboration/liveServerStatus";
import { collaborationBridge } from "../bridge";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import type { createTranslator } from "../i18n";
import { CollaborationConnectForm } from "../team/CollaborationConnectForm";
import { DeploymentConnectionCard } from "./DeploymentConnectionCard";
import { ServerDataMigrationCard } from "./ServerDataMigrationCard";

function workspaceSnapshot(
  status: ReturnType<typeof useCollaborationStatus>["status"]
): LiveWorkspaceSnapshot | null {
  const connection = status?.workspaceConnection;
  if (!connection) return null;
  return {
    status: connection.status,
    serverBaseUrl: connection.profile?.serverBaseUrl ?? null,
    displayName: connection.workspaceDisplayName ?? null
  };
}

export type SettingsServerSectionProps = {
  t: ReturnType<typeof createTranslator>;
  showHeader?: boolean;
};

/** Server hosting, remote endpoint, and device connection for an existing Server. */
export function SettingsServerSection({ t, showHeader = true }: SettingsServerSectionProps) {
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
    <section data-testid="settings-server-section" className="flex flex-col gap-6">
      {showHeader ? (
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
            {t("settingsServer")}
          </h1>
          <p className="mt-1 text-sm text-text-muted">{t("settingsServerHint")}</p>
        </div>
      ) : null}

      <div className="flex max-w-3xl flex-col" data-testid="settings-server-panels">
        <div data-testid="settings-server-lifecycle-block">
          <LocalServerLifecycleControls
            api={collaborationBridge}
            t={t}
            workspace={workspaceSnapshot(status)}
            showIdleStart={!existingServer}
            refreshToken={statusEpoch}
            onRetried={handleConnectionApplied}
          />
        </div>
        <div data-testid="settings-server-connection-block">
          <DeploymentConnectionCard
            presentation="plain"
            showHeading={false}
            t={t}
            onExistingServerChange={handleExistingServerChange}
            existingServerTools="collapsed"
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

      <ServerDataMigrationCard api={collaborationBridge} t={t} />
    </section>
  );
}
