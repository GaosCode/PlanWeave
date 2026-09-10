import type { OperatorHostView } from "@planweave-ai/agent-host-protocol/operator-control";
import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DesktopServerExposureView } from "../../shared/deploymentExposure";
import type { createTranslator } from "../i18n";
import { collaborationBridge } from "../bridge";
import {
  type HostAdministrationController,
  useHostAdministrationController
} from "../hooks/useHostAdministrationController";
import { HostBootstrapCard } from "./HostBootstrapCard";
import { LocalAgentHostCard } from "./LocalAgentHostCard";
import { HostAvailabilityCard } from "./HostAvailabilityCard";
import { DeploymentConnectionCard } from "./DeploymentConnectionCard";
import { RemoteAgentManagementCard } from "./RemoteAgentManagementCard";
import { formatHostAdministrationError } from "./hostAdministrationErrors";

type HostAdministrationSectionProps = {
  diagnosticsEnabled?: boolean;
  showDeploymentConnection?: boolean;
  showHeader?: boolean;
  setupOnly?: boolean;
  t: ReturnType<typeof createTranslator>;
};

type HostAdministrationContentProps = HostAdministrationSectionProps & {
  controller: HostAdministrationController;
};

export function HostAdministrationSection({ ...props }: HostAdministrationSectionProps) {
  const controller = useHostAdministrationController();
  return <HostAdministrationContent {...props} controller={controller} />;
}

export function HostAdministrationContent({
  controller,
  diagnosticsEnabled = false,
  showDeploymentConnection = true,
  showHeader = true,
  setupOnly = false,
  t
}: HostAdministrationContentProps) {
  const [desktopServerExposure, setDesktopServerExposure] =
    useState<DesktopServerExposureView | null>(null);
  const handleExposureChange = useCallback((exposure: DesktopServerExposureView) => {
    setDesktopServerExposure(exposure);
  }, []);

  useEffect(() => {
    if (
      !collaborationBridge ||
      typeof collaborationBridge.getDesktopServerExposure !== "function"
    ) {
      return;
    }
    let cancelled = false;
    void collaborationBridge.getDesktopServerExposure().then(
      (exposure) => {
        if (!cancelled) setDesktopServerExposure(exposure);
      },
      () => {
        if (!cancelled) setDesktopServerExposure(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const {
    activeProfile,
    busy,
    copyBootstrapHandoff,
    credentialLifetimeDays,
    dismissHandoff,
    enrollLocalAgentHost,
    error,
    handoff,
    hosts,
    hostsHasMore,
    hostInventoryState,
    hostsLoading,
    loadMoreHosts,
    loadState,
    localAgentHost,
    localAgentHostLoading,
    refresh,
    refreshHosts,
    registerLocalAgentHost,
    repairLocalAgentHost,
    renewHostCredential,
    setCredentialLifetimeDays
  } = controller;

  const handleRevoke = async (host: OperatorHostView) => {
    if (host.revokedAt || busy) return;
    if (!window.confirm(`${t("hostAdminRevokeConfirm")}\n\n${host.displayName}`)) return;
    await controller.revokeHost(host.id);
  };

  const currentError = formatHostAdministrationError(error, t);

  return (
    <div className="flex flex-col" data-testid="host-administration">
      {showHeader ? (
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text-strong">
              {t("hostAdminTitle")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-text-muted">
              {t("hostAdminDescription")}
            </p>
            <p
              className="mt-2 max-w-2xl text-xs leading-5 text-text-muted"
              data-testid="host-admin-server-binding"
            >
              {t("hostAdminServerBinding")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="host-admin-refresh"
            disabled={busy || loadState === "loading"}
            onClick={() => void refresh().then(refreshHosts)}
          >
            <RefreshCwIcon data-icon="inline-start" />
            {t("hostAdminRefresh")}
          </Button>
        </header>
      ) : (
        <p
          className="max-w-2xl pb-4 text-xs leading-5 text-text-muted"
          data-testid="host-admin-server-binding"
        >
          {t("hostAdminServerBinding")}
        </p>
      )}

      {loadState === "unavailable" ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
          data-testid="host-admin-unavailable"
        >
          {t("hostAdminBridgeUnavailable")}
        </div>
      ) : null}
      {currentError ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
          data-testid="host-admin-error"
        >
          <p>{currentError}</p>
          {diagnosticsEnabled && error ? (
            <p className="mt-2 font-mono text-xs" data-testid="host-admin-error-code">
              {t("hostAdminDiagnosticCode")}: {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {showDeploymentConnection ? (
        <DeploymentConnectionCard
          presentation="section"
          t={t}
          onExposureChange={handleExposureChange}
        />
      ) : null}

      {!setupOnly ? (
        <>
          <HostAvailabilityCard
            busy={busy}
            hosts={hosts}
            hasMore={hostsHasMore}
            inventoryState={hostInventoryState}
            loading={hostsLoading}
            onLoadMore={() => void loadMoreHosts()}
            onRefresh={() => void refreshHosts()}
            onRevoke={(host) => void handleRevoke(host)}
            onRenew={(host) => void renewHostCredential(host.id)}
            t={t}
          />

          <RemoteAgentManagementCard hosts={hosts} t={t} />
        </>
      ) : null}

      <HostBootstrapCard
        activeProfile={activeProfile}
        busy={busy}
        copyBootstrapHandoff={copyBootstrapHandoff}
        credentialLifetimeDays={credentialLifetimeDays}
        dismissHandoff={dismissHandoff}
        handoff={handoff}
        handoffState={busy ? "pending" : handoff ? "ready" : error ? "failed" : "idle"}
        onRetry={copyBootstrapHandoff}
        setCredentialLifetimeDays={setCredentialLifetimeDays}
        t={t}
      />

      <LocalAgentHostCard
        activeProfile={activeProfile}
        busy={busy}
        localServerHosted={desktopServerExposure?.lifecycle === "ready"}
        loading={localAgentHostLoading}
        status={localAgentHost}
        register={registerLocalAgentHost}
        repair={repairLocalAgentHost}
        enroll={enrollLocalAgentHost}
        t={t}
      />
    </div>
  );
}
