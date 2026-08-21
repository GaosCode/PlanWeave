import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isLocalCollaborationProfileId,
  type CollaborationContentBootstrapResult,
  type LocalCollaborationServerStatus,
  type PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { Button } from "@/components/ui/button";
import { collaborationBridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { useCollaborationReadModels } from "../hooks/useCollaborationReadModels";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import { usePeoplePanelController } from "../hooks/usePeoplePanelController";
import { CollaborationConnectForm } from "../team/CollaborationConnectForm";
import { buildCollaborationDiagnosticReport } from "../team/collaborationDiagnostics";
import { CollaborationWorkspaceOnboarding } from "../team/CollaborationWorkspaceOnboarding";
import { PeoplePanel } from "../team/PeoplePanel";
import { WorkspaceManagementPanel } from "../team/WorkspaceManagementPanel";
import {
  CurrentCanvasAccessPanel,
  CurrentCanvasMemberAccess
} from "../collaboration/CurrentCanvasAccessPanel";
import { LocalCollaborationServerPanel } from "../collaboration/LocalCollaborationServerPanel";
import { LocalServerLifecycleControls } from "../collaboration/LocalServerLifecycleControls";
import { ContentAuthorityPanel } from "../collaboration/ContentAuthorityPanel";
import { WorkspaceAccessScopeSelector } from "../collaboration/WorkspaceAccessScopeSelector";
import { WorkspaceCanvasSharingPanel } from "../collaboration/WorkspaceCanvasSharingPanel";
import { DeploymentConnectionCard } from "../settings/DeploymentConnectionCard";
import { HostMemberSetupCard } from "../settings/HostMemberSetupCard";
import { useHostAdministrationController } from "../hooks/useHostAdministrationController";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import {
  collaborationConnectionErrorMessage,
  collaborationDeveloperErrorDetail,
  collaborationErrorCode,
  collaborationErrorMessage
} from "../collaboration/formatCollaborationError";
import type { DesktopUiSettings } from "../types";
import type { DesktopServerExposureView } from "../../shared/deploymentExposure";
import { useWorkspaceAccessScope } from "../hooks/useWorkspaceAccessScope";

export type PeopleViewProps = {
  t: ReturnType<typeof createTranslator>;
  diagnosticsEnabled?: boolean;
  /** Injected API for tests. */
  api?: PlanWeaveCollaborationApi | null;
  /** Optional clipboard writer; defaults to navigator.clipboard. */
  copyText?: (text: string) => Promise<void>;
  onContentReplicaReady?: (result: CollaborationContentBootstrapResult) => Promise<void>;
  onMembershipOutcome?: (outcome: { ok: boolean; message: string }) => void;
  collaborationScopeLayout: DesktopUiSettings["layout"]["collaborationScope"];
  onCollaborationScopeLayoutChange: (
    patch: Partial<DesktopUiSettings["layout"]["collaborationScope"]>
  ) => void;
  localInvitationHandoff?: string | null;
  onLocalInvitationHandoffChange?: (handoff: string | null) => void;
  onManageServer?: () => void;
};

async function defaultCopyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("clipboard_unavailable");
}

export function formatPeoplePanelError(
  t: ReturnType<typeof createTranslator>,
  error: unknown,
  diagnosticsEnabled = false
): string {
  const code = collaborationErrorCode(error);
  const formatted =
    code === "human_rate_limited"
      ? t("peopleRequestRateLimited")
      : code === "human_limit_exceeded"
        ? t("localServerInvitationCapacityExceeded")
        : collaborationErrorMessage(error);
  if (!diagnosticsEnabled) return formatted;
  const detail = collaborationDeveloperErrorDetail(error, formatted);
  return detail ? `${formatted}\n${detail}` : formatted;
}

/** Workspace-wide member, device, and shared-content administration. */
export function PeopleView({
  t,
  diagnosticsEnabled = false,
  api: apiProp,
  copyText = defaultCopyText,
  onContentReplicaReady,
  onMembershipOutcome,
  collaborationScopeLayout,
  onCollaborationScopeLayoutChange,
  localInvitationHandoff: controlledLocalInvitationHandoff,
  onLocalInvitationHandoffChange,
  onManageServer
}: PeopleViewProps) {
  const api = apiProp === undefined ? collaborationBridge : apiProp;
  const hostController = useHostAdministrationController();
  const [localHostingOpen, setLocalHostingOpen] = useState(false);
  const [connectedSection, setConnectedSection] = useState<"members" | "workspace">("members");
  const [revealInvitationManagement, setRevealInvitationManagement] = useState(false);
  const [reconnectPending, setReconnectPending] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [desktopServerExposure, setDesktopServerExposure] =
    useState<DesktopServerExposureView | null>(null);
  const [internalLocalInvitationHandoff, setInternalLocalInvitationHandoff] = useState<
    string | null
  >(null);
  const localInvitationHandoff =
    controlledLocalInvitationHandoff === undefined
      ? internalLocalInvitationHandoff
      : controlledLocalInvitationHandoff;
  const setLocalInvitationHandoff =
    onLocalInvitationHandoffChange ?? setInternalLocalInvitationHandoff;
  const desktopServerExposureRef = useRef<DesktopServerExposureView | null>(null);
  const handleDesktopServerExposureChange = useCallback(
    (nextExposure: DesktopServerExposureView) => {
      const previousExposure = desktopServerExposureRef.current;
      const endpointChanged =
        previousExposure !== null &&
        (previousExposure.mode !== nextExposure.mode ||
          previousExposure.advertisedOrigin !== nextExposure.advertisedOrigin);
      desktopServerExposureRef.current = nextExposure;
      setDesktopServerExposure(nextExposure);
      if (endpointChanged) setLocalInvitationHandoff(null);
    },
    [setLocalInvitationHandoff]
  );
  const {
    status,
    loading: collaborationStatusLoading,
    error: collaborationStatusError,
    refresh: refreshCollaborationStatus
  } = useCollaborationStatus({ api });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected = isCollaborationSessionConnected(status);
  const workspaceAccessScope = useWorkspaceAccessScope({
    api,
    connectionKey: activeProfile?.profileId ?? null,
    status
  });

  useEffect(() => {
    if (sessionConnected) setReconnectError(null);
  }, [sessionConnected]);
  const hasConfiguredWorkspace = status !== null && status.workspaceConnection.workspaceId !== null;
  const showOnboarding = !hasConfiguredWorkspace;
  const workspaceHostProfileId =
    status?.workspaceConnection.profile?.profileId ?? activeProfile?.profileId ?? null;
  const canControlLocalServer =
    workspaceHostProfileId !== null && isLocalCollaborationProfileId(workspaceHostProfileId);

  useEffect(() => {
    if (!api || typeof api.getDesktopServerExposure !== "function") return;
    let cancelled = false;
    void api.getDesktopServerExposure().then(
      (nextExposure) => {
        if (!cancelled) handleDesktopServerExposureChange(nextExposure);
      },
      () => {
        if (!cancelled) setDesktopServerExposure(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, handleDesktopServerExposureChange]);

  useEffect(() => {
    if (hasConfiguredWorkspace && localHostingOpen) {
      setLocalHostingOpen(false);
    }
  }, [hasConfiguredWorkspace, localHostingOpen]);

  const previousLocalServerStateRef = useRef<LocalCollaborationServerStatus["state"] | null>(null);
  const handleLocalServerStatusChange = useCallback(
    (nextStatus: LocalCollaborationServerStatus) => {
      const previous = previousLocalServerStateRef.current;
      previousLocalServerStateRef.current = nextStatus.state;
      const becameRunning =
        previous !== null && previous !== "running" && nextStatus.state === "running";
      const discoveredRunningDuringOnboarding =
        localHostingOpen && previous === null && nextStatus.state === "running";
      if (becameRunning || discoveredRunningDuringOnboarding) {
        void refreshCollaborationStatus();
      }
    },
    [localHostingOpen, refreshCollaborationStatus]
  );
  const formatPanelError = useCallback(
    (error: unknown) => formatPeoplePanelError(t, error, diagnosticsEnabled),
    [diagnosticsEnabled, t]
  );

  // Subscribe only: the project shell owns the shared hub's active project/canvas binding.
  const { snapshot, viewModel, controller } = useCollaborationReadModels({
    api,
    profileId: sessionConnected ? (activeProfile?.profileId ?? null) : null,
    projectId: sessionConnected ? (activeProfile?.projectId ?? null) : null,
    manageActiveProject: false
  });

  const panel = usePeoplePanelController({
    api,
    status,
    members: viewModel.members,
    hosts: viewModel.hosts,
    syncPhase: snapshot.syncPhase,
    detailsOpen: true,
    formatError: formatPanelError
  });
  const diagnosticReport = useMemo(() => {
    if (!diagnosticsEnabled || !status) return null;
    const report = buildCollaborationDiagnosticReport(
      status,
      undefined,
      snapshot,
      workspaceAccessScope.access.view
    );
    if (!panel.detailsError && !panel.actionError) return report;
    return [
      report,
      `people.details_error=${panel.detailsError ?? "none"}`,
      `people.action_error=${panel.actionError ?? "none"}`
    ].join("\n");
  }, [
    diagnosticsEnabled,
    panel.actionError,
    panel.detailsError,
    snapshot,
    status,
    workspaceAccessScope.access.view
  ]);

  const handleManageInvitations = useCallback(() => {
    setLocalHostingOpen(false);
    setConnectedSection("members");
    setRevealInvitationManagement(true);
    void panel.refreshDetails();
  }, [panel.refreshDetails]);

  const refreshMembers = async () => {
    if (controller && activeProfile) {
      await controller.refreshAuthoritative({ reason: "people_member_mutation" });
    }
  };

  const handleRefreshDetails = async () => {
    if (reconnectPending) return;
    setReconnectError(null);
    if (!sessionConnected && api && activeProfile?.hasDeviceCredential) {
      setReconnectPending(true);
      try {
        await api.connectCollaborationSession({ profileId: activeProfile.profileId });
      } catch (error) {
        setReconnectError(collaborationConnectionErrorMessage(t, error));
      } finally {
        await refreshCollaborationStatus();
        setReconnectPending(false);
      }
      return;
    }
    await panel.refreshDetails();
    await refreshMembers();
  };

  const reportMembership = (ok: boolean, message: string) => {
    onMembershipOutcome?.({ ok, message });
  };

  const membershipResult = (ok: boolean) =>
    ok ? t("notifyMembershipChanged") : (panel.actionError ?? t("peopleError"));

  const authoritativeCanvasAccess = (
    <CurrentCanvasAccessPanel
      view={workspaceAccessScope.access.view}
      loading={workspaceAccessScope.access.loading}
      error={workspaceAccessScope.access.error}
      busy={workspaceAccessScope.access.busy || workspaceAccessScope.loading}
      scopeSelector={
        <WorkspaceAccessScopeSelector
          options={workspaceAccessScope.options}
          selectedKey={workspaceAccessScope.selectedKey}
          loading={workspaceAccessScope.loading}
          error={workspaceAccessScope.error}
          busy={workspaceAccessScope.access.busy}
          t={t}
          onSelect={workspaceAccessScope.select}
        />
      }
      t={t}
      onRefresh={async () => {
        await Promise.all([
          workspaceAccessScope.refreshOptions(),
          workspaceAccessScope.access.refresh()
        ]);
      }}
      onUpdateVisibility={workspaceAccessScope.access.updateVisibility}
    />
  );

  return (
    <section
      className="h-full min-h-0 w-full overflow-y-auto [scrollbar-gutter:stable]"
      data-testid="people-view"
      aria-label={t("peopleTitle")}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col px-5 pb-12 pt-1 sm:px-7 lg:px-9">
        {collaborationStatusLoading && !status ? (
          <div className="py-8 text-xs text-muted-foreground" role="status">
            {t("peopleWorking")}
          </div>
        ) : showOnboarding ? (
          <>
            {collaborationStatusError ? (
              <div
                className="mb-5 border-l-2 border-destructive pl-3 text-xs text-destructive"
                role="alert"
              >
                {collaborationStatusError}
              </div>
            ) : null}
            <CollaborationWorkspaceOnboarding
              t={t}
              onLocalHostingOpenChange={setLocalHostingOpen}
              localHostingSlot={
                <div className="flex flex-col gap-6">
                  <DeploymentConnectionCard
                    presentation="plain"
                    showHeading={false}
                    t={t}
                    onExposureChange={handleDesktopServerExposureChange}
                  />
                  <LocalServerLifecycleControls
                    api={api}
                    t={t}
                    onStatusChange={handleLocalServerStatusChange}
                  />
                  <LocalCollaborationServerPanel
                    api={api}
                    t={t}
                    projectId={null}
                    canvasId={null}
                    scopeLayout={collaborationScopeLayout}
                    onScopeLayoutChange={onCollaborationScopeLayoutChange}
                    copyText={copyText}
                    invitationHandoff={localInvitationHandoff}
                    onInvitationHandoffChange={setLocalInvitationHandoff}
                    onManageInvitations={handleManageInvitations}
                    onStatusChange={handleLocalServerStatusChange}
                    serverExposure={desktopServerExposure}
                    onManageServer={onManageServer}
                  />
                </div>
              }
              existingServerSlot={
                <CollaborationConnectForm
                  api={api}
                  diagnosticsEnabled={diagnosticsEnabled}
                  status={status}
                  t={t}
                  fixedMode="setup"
                  showHeader={false}
                  showConnectionSummary={false}
                  copyText={copyText}
                  onConnected={refreshCollaborationStatus}
                />
              }
              joinSlot={
                <CollaborationConnectForm
                  api={api}
                  diagnosticsEnabled={diagnosticsEnabled}
                  status={status}
                  t={t}
                  fixedMode="join"
                  showHeader={false}
                  showConnectionSummary={false}
                  copyText={copyText}
                  onConnected={refreshCollaborationStatus}
                />
              }
            />
          </>
        ) : (
          <div className="flex flex-col gap-6" data-testid="people-workspace-section">
            <div
              className="flex items-center gap-7 border-b border-border/70"
              role="tablist"
              aria-label={t("peopleTitle")}
              data-testid="people-connected-sections"
            >
              {(
                [
                  ["members", "peopleSectionWorkspace"],
                  ["workspace", "peopleSectionHosting"]
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={connectedSection === value}
                  data-testid={`people-section-${value}`}
                  className={`relative pb-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    connectedSection === value
                      ? "text-text-strong after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-text-strong"
                      : "text-muted-foreground hover:text-text-strong"
                  }`}
                  onClick={() => setConnectedSection(value)}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            {reconnectError ? (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                data-testid="people-reconnect-error"
                role="alert"
              >
                {reconnectError}
              </div>
            ) : null}
            {connectedSection === "members" ? (
              <>
                {hostController.activeProfile?.hasOperatorCredential ? (
                  <HostMemberSetupCard
                    activeProfile={hostController.activeProfile}
                    busy={hostController.busy}
                    copyMemberSetupCode={hostController.copyMemberSetupCode}
                    dismissMemberSetupCodeHandoff={hostController.dismissMemberSetupCodeHandoff}
                    memberSetupCodeHandoff={hostController.memberSetupCodeHandoff}
                    t={t}
                  />
                ) : null}
                <PeoplePanel
                  mode={panel.mode}
                  presence={panel.presence}
                  members={panel.members}
                  invitations={panel.invitations}
                  devices={panel.devices}
                  detailsLoading={panel.detailsLoading || reconnectPending}
                  detailsError={panel.detailsError}
                  actionError={panel.actionError}
                  actionBusy={panel.actionBusy}
                  pendingInvitation={panel.pendingInvitation}
                  revealInvitationManagement={revealInvitationManagement}
                  showTitle={false}
                  diagnosticReport={diagnosticReport}
                  diagnosticsEnabled={diagnosticsEnabled}
                  onCopyDiagnostics={copyText}
                  t={t}
                  onCreateInvitation={panel.createInvitation}
                  onViewInvitation={panel.viewInvitation}
                  onCopyInvitationToken={copyText}
                  onDismissPendingInvitation={panel.clearPendingInvitation}
                  onRevokeInvitation={async (invitationId) => {
                    const ok = await panel.revokeInvitation(invitationId);
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onRevokeInvitations={async (invitationIds) => {
                    const ok = await panel.revokeInvitations(invitationIds);
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onUpdateOwnDisplayName={async (displayName) => {
                    const ok = await panel.updateOwnDisplayName(displayName);
                    if (ok) {
                      await Promise.all([refreshMembers(), refreshCollaborationStatus()]);
                    }
                    return ok;
                  }}
                  onPromoteMember={async (humanPrincipalId) => {
                    const ok = await panel.promoteMember(humanPrincipalId);
                    if (ok) await refreshMembers();
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onDemoteMember={async (humanPrincipalId) => {
                    const ok = await panel.demoteMember(humanPrincipalId);
                    if (ok) await refreshMembers();
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onRemoveMember={async (humanPrincipalId) => {
                    const ok = await panel.removeMember(humanPrincipalId);
                    if (ok) await refreshMembers();
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onRevokeDevice={async (deviceCredentialId) => {
                    const ok = await panel.revokeDevice(deviceCredentialId);
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  renderMemberAccess={(member) => {
                    if (workspaceAccessScope.access.loading && !workspaceAccessScope.access.view) {
                      return <p className="text-xs text-muted-foreground">{t("accessLoading")}</p>;
                    }
                    const person = workspaceAccessScope.access.view?.people.find(
                      (candidate) => candidate.humanPrincipalId === member.humanPrincipalId
                    );
                    if (!workspaceAccessScope.access.view || !person) {
                      return (
                        <p className="text-xs text-muted-foreground">
                          {workspaceAccessScope.access.error ?? t("accessMemberUnavailable")}
                        </p>
                      );
                    }
                    return (
                      <CurrentCanvasMemberAccess
                        view={workspaceAccessScope.access.view}
                        person={person}
                        busy={workspaceAccessScope.access.busy}
                        t={t}
                        onGrant={workspaceAccessScope.access.grant}
                        onRevoke={workspaceAccessScope.access.revoke}
                      />
                    );
                  }}
                  onRefreshDetails={handleRefreshDetails}
                />
                {authoritativeCanvasAccess}
              </>
            ) : (
              <WorkspaceManagementPanel
                t={t}
                connection={
                  <CollaborationConnectForm
                    api={api}
                    diagnosticsEnabled={diagnosticsEnabled}
                    status={status}
                    t={t}
                    initialMode="join"
                    workspaceConnectionOnly
                    showHeader={false}
                    copyText={copyText}
                    onConnected={refreshCollaborationStatus}
                  />
                }
                hostedCanvases={
                  sessionConnected ? (
                    <div className="flex flex-col gap-8">
                      {canControlLocalServer ? (
                        <LocalCollaborationServerPanel
                          api={api}
                          t={t}
                          projectId={null}
                          canvasId={null}
                          scopeLayout={collaborationScopeLayout}
                          onScopeLayoutChange={onCollaborationScopeLayoutChange}
                          copyText={copyText}
                          showInvitationControls={false}
                          invitationHandoff={localInvitationHandoff}
                          onInvitationHandoffChange={setLocalInvitationHandoff}
                          onStatusChange={handleLocalServerStatusChange}
                          serverExposure={desktopServerExposure}
                          scopesRequireRunning
                          onManageServer={onManageServer}
                        />
                      ) : null}
                      <WorkspaceCanvasSharingPanel
                        api={api}
                        connected={sessionConnected}
                        connectionKey={activeProfile?.profileId ?? null}
                        t={t}
                      />
                    </div>
                  ) : null
                }
                contentAuthority={
                  sessionConnected ? (
                    <ContentAuthorityPanel
                      api={api ?? null}
                      connectionKey={activeProfile?.profileId ?? null}
                      authorityProjectId={activeProfile?.projectId ?? null}
                      localProjectId={null}
                      canvasId={null}
                      connected={sessionConnected}
                      diagnosticsEnabled={diagnosticsEnabled}
                      onReplicaReady={onContentReplicaReady}
                      t={t}
                    />
                  ) : (
                    <div className="flex flex-col items-start gap-3 py-1">
                      <div>
                        <h2 className="text-base font-semibold text-text-strong">
                          {t("contentAuthorityTitle")}
                        </h2>
                        <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
                          {t("settingsServerContentNeedsSession")}
                        </p>
                      </div>
                      {activeProfile?.hasDeviceCredential ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={reconnectPending}
                          onClick={() => void handleRefreshDetails()}
                          data-testid="people-workspace-reconnect-session"
                        >
                          {reconnectPending
                            ? t("settingsServerReconnectSessionBusy")
                            : t("settingsServerReconnectSession")}
                        </Button>
                      ) : null}
                    </div>
                  )
                }
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
