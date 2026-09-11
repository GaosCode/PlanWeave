import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type LocalCollaborationServerStatus,
  type PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator.js";
import { collaborationBridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { useCollaborationReadModels } from "../hooks/useCollaborationReadModels";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import { usePeoplePanelController } from "../hooks/usePeoplePanelController";
import { CollaborationConnectForm } from "../team/CollaborationConnectForm";
import { buildCollaborationDiagnosticReport } from "../team/collaborationDiagnostics";
import { CollaborationWorkspaceOnboarding } from "../team/CollaborationWorkspaceOnboarding";
import { PeoplePanel } from "../team/PeoplePanel";
import { WorkspaceInformation } from "../team/WorkspaceInformation";
import { WorkspaceSwitcher } from "../team/WorkspaceSwitcher";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import { ManagementDialog } from "../components/ManagementDialog";
import { WorkspaceCanvasDirectory } from "../team/WorkspaceCanvasDirectory";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CurrentCanvasAccessPanel,
  CurrentCanvasMemberAccess
} from "../collaboration/CurrentCanvasAccessPanel";
import { LocalCollaborationServerPanel } from "../collaboration/LocalCollaborationServerPanel";
import { LocalServerLifecycleControls } from "../collaboration/LocalServerLifecycleControls";
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
  onWorkspaceCanvasPublished?: (locator: WorkspaceCanvasLocator) => void;
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
  onWorkspaceCanvasPublished,
  onMembershipOutcome,
  collaborationScopeLayout,
  onCollaborationScopeLayoutChange,
  localInvitationHandoff: controlledLocalInvitationHandoff,
  onLocalInvitationHandoffChange,
  onManageServer
}: PeopleViewProps) {
  const api = apiProp === undefined ? collaborationBridge : apiProp;
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [joiningOpen, setJoiningOpen] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [invitationOpen, setInvitationOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [directoryEpoch, setDirectoryEpoch] = useState(0);
  const [localHostingOpen, setLocalHostingOpen] = useState(false);
  const [connectedSection, setConnectedSection] = useState<"members" | "workspace" | "information">(
    "workspace"
  );
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
  const hostController = useHostAdministrationController();

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const connectedWorkspace = status?.workspaceConnection;
  const invitationWorkspace =
    connectedWorkspace?.status === "connected" &&
    connectedWorkspace.profile &&
    connectedWorkspace.workspaceId
      ? {
          workspaceId: connectedWorkspace.workspaceId,
          displayName:
            connectedWorkspace.workspaceDisplayName ?? connectedWorkspace.profile.displayName,
          serverBaseUrl: connectedWorkspace.profile.serverBaseUrl
        }
      : null;
  const invitationOperator =
    hostController.status?.profiles.find(
      (profile) =>
        profile.hasOperatorCredential &&
        invitationWorkspace &&
        new URL(profile.serverBaseUrl).origin === new URL(invitationWorkspace.serverBaseUrl).origin
    ) ?? null;

  const sessionConnected = isCollaborationSessionConnected(status);
  const workspaceConnected = connectedWorkspace?.status === "connected";
  const canShareCanvas = workspaceConnected;
  const workspaceAccessScope = useWorkspaceAccessScope({
    api,
    connectionKey: connectedWorkspace?.profile?.profileId ?? null,
    status
  });

  useEffect(() => {
    if (sessionConnected) setReconnectError(null);
  }, [sessionConnected]);
  const hasConfiguredWorkspace = status !== null && status.workspaceConnection.workspaceId !== null;
  const showOnboarding = !hasConfiguredWorkspace;

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
    setInvitationOpen(true);
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

  const invitationSetup =
    invitationWorkspace && invitationOperator ? (
      <HostMemberSetupCard
        activeProfile={invitationOperator}
        showWorkspace={false}
        workspace={invitationWorkspace}
        busy={hostController.busy}
        error={hostController.error}
        copyMemberSetupCode={() =>
          hostController.copyMemberSetupCode({
            profileId: invitationOperator.profileId,
            workspaceId: invitationWorkspace.workspaceId,
            serverBaseUrl: invitationWorkspace.serverBaseUrl
          })
        }
        dismissMemberSetupCodeHandoff={hostController.dismissMemberSetupCodeHandoff}
        memberSetupCodeHandoff={hostController.memberSetupCodeHandoff}
        t={t}
      />
    ) : null;

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
              className="flex flex-wrap items-center gap-5 border-b border-border/70"
              data-testid="people-connected-sections"
            >
              <WorkspaceSwitcher
                api={api}
                status={status}
                open={connectionOpen}
                onOpenChange={setConnectionOpen}
                onJoin={() => setJoiningOpen(true)}
                onManageServer={onManageServer}
                onSelected={refreshCollaborationStatus}
                t={t}
              />
              <span className="mb-2 h-5 border-l border-border" aria-hidden="true" />
              <Tabs
                value={connectedSection}
                onValueChange={(value) => {
                  if (value === "workspace" || value === "members" || value === "information")
                    setConnectedSection(value);
                }}
              >
                <TabsList variant="line" aria-label={t("workspaceNavigation")}>
                  <TabsTrigger value="workspace" data-testid="people-section-workspace">
                    {t("workspaceSharedCanvases")}
                  </TabsTrigger>
                  <TabsTrigger value="members" data-testid="people-section-members">
                    {t("workspaceMembersAccess")}
                  </TabsTrigger>
                  <TabsTrigger value="information" data-testid="people-section-information">
                    {t("workspaceInformation")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {connectedSection === "workspace" ? (
                <Button
                  className="mb-2 ml-auto"
                  size="sm"
                  disabled={!canShareCanvas}
                  onClick={() => setSharingOpen(true)}
                >
                  <PlusIcon className="size-3.5" />
                  {t("workspaceShareAction")}
                </Button>
              ) : connectedSection === "members" &&
                (panel.presence.currentUserIsOwner || invitationSetup) ? (
                <Button
                  className="mb-2 ml-auto"
                  size="sm"
                  onClick={() => setConnectedSection("information")}
                >
                  {t("workspaceInviteAction")}
                </Button>
              ) : null}
            </div>
            {reconnectError ? (
              <p role="alert" className="text-sm text-destructive">
                {reconnectError}
              </p>
            ) : null}
            {connectedSection === "members" ? (
              <PeoplePanel
                mode={panel.mode}
                presence={panel.presence}
                identity={panel.identity}
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
                invitationOpen={invitationOpen}
                onInvitationOpenChange={setInvitationOpen}
                accessScope={authoritativeCanvasAccess}
                onManageCanvasAccess={() => setAccessOpen(true)}
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
                canManageMemberAccess={
                  workspaceAccessScope.access.view?.project.capabilities.grant === true ||
                  workspaceAccessScope.access.view?.project.capabilities.revoke === true ||
                  workspaceAccessScope.access.view?.canvas.capabilities.grant === true ||
                  workspaceAccessScope.access.view?.canvas.capabilities.revoke === true
                }
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
            ) : connectedSection === "information" && connectedWorkspace ? (
              <WorkspaceInformation
                connection={connectedWorkspace}
                invitation={invitationSetup}
                onManageInvitations={
                  panel.presence.currentUserIsOwner ? handleManageInvitations : undefined
                }
                t={t}
              />
            ) : (
              <WorkspaceCanvasDirectory
                key={`${connectedWorkspace?.workspaceId ?? ""}:${directoryEpoch}`}
                api={api}
                connected={workspaceConnected}
                workspaceId={connectedWorkspace?.workspaceId}
                connectionKey={connectedWorkspace?.profile?.profileId ?? null}
                onOpen={onWorkspaceCanvasPublished}
                onReconnect={() => setConnectionOpen(true)}
                t={t}
              />
            )}
            <ManagementDialog
              open={joiningOpen}
              onOpenChange={setJoiningOpen}
              title={t("workspaceJoinAnother")}
              t={t}
            >
              <CollaborationConnectForm
                api={api}
                diagnosticsEnabled={diagnosticsEnabled}
                status={status}
                t={t}
                fixedMode="join"
                workspaceConnectionOnly
                showWorkspacePicker={false}
                showConnectionSummary={false}
                showHeader={false}
                copyText={copyText}
                onConnected={async () => {
                  await refreshCollaborationStatus();
                  setJoiningOpen(false);
                }}
              />
            </ManagementDialog>
            <ManagementDialog
              open={sharingOpen}
              onOpenChange={setSharingOpen}
              title={t("workspaceShareAction")}
              t={t}
            >
              <WorkspaceCanvasSharingPanel
                api={api}
                connected={canShareCanvas}
                connectionKey={connectedWorkspace?.profile?.profileId ?? null}
                workspaceProjectId={null}
                initialExpanded
                requireProjectSelection
                showHeader={false}
                onPublished={(result) => {
                  void workspaceAccessScope.refreshOptions();
                  setDirectoryEpoch((value) => value + 1);
                  setSharingOpen(false);
                  onWorkspaceCanvasPublished?.(result.locator);
                }}
                t={t}
              />
            </ManagementDialog>
            <ManagementDialog
              open={accessOpen}
              onOpenChange={setAccessOpen}
              title={t("workspaceAccessSettings")}
              t={t}
            >
              {authoritativeCanvasAccess}
            </ManagementDialog>
          </div>
        )}
      </div>
    </section>
  );
}
