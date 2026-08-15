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

type HostAdministrationSectionProps = {
  diagnosticsEnabled?: boolean;
  showDeploymentConnection?: boolean;
  showHeader?: boolean;
  t: ReturnType<typeof createTranslator>;
};

type HostAdministrationContentProps = HostAdministrationSectionProps & {
  controller: HostAdministrationController;
};

function errorLabel(code: string | null, t: ReturnType<typeof createTranslator>): string | null {
  if (!code) return null;
  if (code === "local_agent_host_unavailable") {
    return t("hostAdminLocalHostUnsupported");
  }
  if (code === "local_agent_host_custom_ca_unsupported") {
    return t("hostAdminLocalHostCustomCaUnsupported");
  }
  if (code === "local_agent_host_handoff_invalid") {
    return t("hostAdminLocalHostHandoffInvalid");
  }
  if (code === "local_agent_host_handoff_expired") {
    return t("hostAdminLocalHostHandoffExpired");
  }
  if (
    code === "agent_host_enrollment_rejected" ||
    code === "agent_host_enrollment_response_expired" ||
    code === "agent_host_enrollment_response_mismatch"
  ) {
    return t("hostAdminLocalHostEnrollmentRejected");
  }
  if (code === "agent_host_enrollment_exchange_failed") {
    return t("hostAdminLocalHostEnrollmentUnreachable");
  }
  if (
    code === "agent_host_enrollment_transport_insecure" ||
    code === "agent_host_enrollment_transport_unsupported"
  ) {
    return t("hostAdminLocalHostEnrollmentTransportUnsupported");
  }
  if (
    code === "agent_host_enrollment_response_malformed" ||
    code === "agent_host_enrollment_response_too_large"
  ) {
    return t("hostAdminLocalHostEnrollmentResponseInvalid");
  }
  if (
    code === "agent_host_enrollment_already_pending" ||
    code === "agent_host_handoff_config_conflict" ||
    code === "agent_host_handoff_pending_conflict" ||
    code === "agent_host_handoff_credential_conflict" ||
    code === "agent_host_handoff_provenance_invalid"
  ) {
    return t("hostAdminLocalHostEnrollmentConflict");
  }
  if (code === "agent_host_windows_user_sid_unavailable") {
    return t("hostAdminLocalHostWindowsIdentityUnavailable");
  }
  if (code === "agent_host_preset_binary_missing") {
    return t("hostAdminLocalHostAgentMissing");
  }
  if (code === "agent_host_background_setup_required") {
    return t("hostAdminLocalHostSetupRequired");
  }
  const key =
    code === "operator_bridge_unavailable"
      ? "hostAdminBridgeUnavailable"
      : code === "operator_credential_missing"
        ? "hostAdminCredentialMissing"
        : code === "operator_profile_missing" || code === "operator_profile_not_found"
          ? "hostAdminProfileMissing"
          : code === "operator_offline" || code === "operator_timeout"
            ? "hostAdminOffline"
            : code === "operator_unauthorized" || code === "operator_credential_invalid"
              ? "hostAdminUnauthorized"
              : code === "operator_admin_required" ||
                  code === "operator_server_admin_required" ||
                  code === "operator_forbidden"
                ? "hostAdminForbidden"
                : "hostAdminErrorGeneric";
  return t(key);
}

export function HostAdministrationSection({ ...props }: HostAdministrationSectionProps) {
  const controller = useHostAdministrationController();
  return <HostAdministrationContent {...props} controller={controller} />;
}

export function HostAdministrationContent({
  controller,
  diagnosticsEnabled = false,
  showDeploymentConnection = true,
  showHeader = true,
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

  const currentError = errorLabel(error, t);

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
      ) : null}

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
