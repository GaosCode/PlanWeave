import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, ServerIcon } from "lucide-react";
import { parseCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import {
  type ActiveWorkspaceConnectionView,
  type DeploymentEndpoint,
  type WorkspacePickerItem
} from "@planweave-ai/collaboration-protocol/connection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { createTranslator } from "../i18n";
import {
  collaborationRedeemSetupCodeInputSchema,
  collaborationUpsertProfileInputSchema,
  isLocalCollaborationProfileId,
  type CollaborationStatus,
  type PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import {
  collaborationConnectionErrorMessage,
  collaborationErrorMessage
} from "../collaboration/formatCollaborationError";
import {
  endpointForLegacyCollaborationInvitationHandoff,
  parseCollaborationInvitationHandoff
} from "./collaborationInvitationHandoff";
import { CollaborationInvitationJoinFields } from "./CollaborationInvitationJoinFields";
import { CollaborationSetupHandoffFields } from "./CollaborationSetupHandoffFields";
import { buildCollaborationDiagnosticReport } from "./collaborationDiagnostics";

export type CollaborationConnectFormProps = {
  api: PlanWeaveCollaborationApi | null;
  status: CollaborationStatus | null;
  t: ReturnType<typeof createTranslator>;
  onConnected?: () => void | Promise<void>;
  /** Restore focus to the people trigger after successful close actions. */
  onRequestClose?: () => void;
  /** Preferred entry point for the surrounding surface. */
  initialMode?: ConnectMode;
  /** Lock the form to one product flow and hide the protocol-oriented mode switcher. */
  fixedMode?: ConnectMode;
  /** Limit an embedded surface to joining or changing Workspace membership. */
  workspaceConnectionOnly?: boolean;
  /** Embedded onboarding already supplies the section heading. */
  showHeader?: boolean;
  /** Embedded onboarding does not need the stored Workspace summary. */
  showConnectionSummary?: boolean;
  /** Clipboard boundary supplied by the containing desktop view. */
  copyText?: (text: string) => Promise<void>;
  diagnosticsEnabled?: boolean;
  /** Rendered after the current-connection summary, before the paste editor. */
  afterSummary?: ReactNode;
  /** Override the setup-mode submit label, e.g. Settings "Connect". */
  submitLabel?: string;
  /** Hide the protocol-oriented setup-code trust note on product surfaces. */
  showSetupTrustNote?: boolean;
  connectionSummaryLabel?: string;
  connectionSummaryHint?: string;
  showWorkspacePicker?: boolean;
  /** Place the setup submit control under the paste field. */
  setupSubmitAfterPaste?: boolean;
  /** Hide the paste editor until the user asks for a blob from another device. */
  handoffAsFallback?: boolean;
  submitAlign?: "start" | "end";
  submitSize?: "sm" | "default";
};

export type ConnectMode = "setup" | "join" | "bootstrap" | "connect";

function newProfileId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `profile-${crypto.randomUUID()}`;
  }
  return `profile-${Date.now()}`;
}

function workspaceIdentityStatusLabel(
  connection: ActiveWorkspaceConnectionView | null | undefined,
  t: ReturnType<typeof createTranslator>
): string {
  if (!connection) return t("peopleWorkspaceIdentityMissingHint");
  switch (connection.status) {
    case "local_only":
      return t("peopleWorkspaceIdentityMissingHint");
    case "connecting":
      return t("peopleWorkspaceIdentityVerifying");
    case "connected":
      return t("peopleWorkspaceIdentityVerified");
    case "reconnecting":
      return t("peopleWorkspaceIdentityReverifying");
    case "error":
      return t("peopleWorkspaceIdentityError");
    case "disconnected":
      return t("peopleWorkspaceIdentityPending");
    default:
      return connection.status;
  }
}

/**
 * Join / bootstrap / setup-code / connect onboarding.
 * Setup codes and device tokens are never retained in renderer state.
 */
export function CollaborationConnectForm({
  api,
  status,
  t,
  onConnected,
  onRequestClose,
  initialMode = "setup",
  fixedMode,
  workspaceConnectionOnly = false,
  showHeader = true,
  showConnectionSummary = true,
  copyText,
  diagnosticsEnabled = false,
  afterSummary,
  submitLabel: submitLabelOverride,
  showSetupTrustNote = true,
  connectionSummaryLabel,
  connectionSummaryHint,
  showWorkspacePicker = true,
  setupSubmitAfterPaste = false,
  handoffAsFallback = false,
  submitAlign = "end",
  submitSize = "sm"
}: CollaborationConnectFormProps) {
  const formId = useId();
  const initialSelectedMode = fixedMode ?? (workspaceConnectionOnly ? "join" : initialMode);
  const [mode, setMode] = useState<ConnectMode>(initialSelectedMode);
  const [advancedModesOpen, setAdvancedModesOpen] = useState(
    initialSelectedMode === "connect" || initialSelectedMode === "bootstrap"
  );
  const [connectionEditorOpen, setConnectionEditorOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [serverBaseUrl, setServerBaseUrl] = useState("https://");
  const [projectId, setProjectId] = useState("");
  const [invitationToken, setInvitationToken] = useState("");
  const [invitationDetails, setInvitationDetails] = useState("");
  const [manualJoinOpen, setManualJoinOpen] = useState(
    !fixedMode && initialSelectedMode === "join"
  );
  const [manualSetupOpen, setManualSetupOpen] = useState(false);
  const [handoffFallbackOpen, setHandoffFallbackOpen] = useState(!handoffAsFallback);
  const setupHandoffInputRef = useRef<HTMLTextAreaElement>(null);
  const setupCodeInputRef = useRef<HTMLInputElement>(null);
  const [allowInsecureTransport, setAllowInsecureTransport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);

  const profiles = status?.profiles ?? [];
  const workspaceConnection = status?.workspaceConnection ?? null;
  const activeProfile =
    profiles.find((profile) => profile.profileId === status?.activeProfileId) ??
    profiles[0] ??
    null;
  const workspaceIdentityProfile =
    profiles.find((profile) => profile.profileId === workspaceConnection?.profile?.profileId) ??
    activeProfile;
  const workspaceCredentialMissing =
    workspaceConnection?.profile !== null &&
    workspaceConnection?.profile !== undefined &&
    workspaceIdentityProfile?.hasDeviceCredential === false;
  const localOwnerCredentialMissing =
    workspaceCredentialMissing &&
    workspaceIdentityProfile !== null &&
    isLocalCollaborationProfileId(workspaceIdentityProfile.profileId);
  const workspaceConnected = workspaceConnection?.status === "connected";
  const showConnectionEditor =
    fixedMode !== undefined || !workspaceConnected || connectionEditorOpen;
  const workspaceServerBaseUrl = workspaceConnection?.profile?.serverBaseUrl ?? null;
  const workspacePickerItems: WorkspacePickerItem[] = status?.workspacePicker?.items ?? [];
  const diagnosticReport =
    status && diagnosticsEnabled ? buildCollaborationDiagnosticReport(status) : null;
  const existingServerBaseUrl = activeProfile?.serverBaseUrl ?? "";
  const submitLabel =
    submitLabelOverride ??
    (mode === "setup"
      ? t("peopleConnectSetupSubmit")
      : mode === "join"
        ? t("peopleConnectJoinSubmit")
        : mode === "bootstrap"
          ? t("peopleConnectBootstrapSubmit")
          : t("peopleConnectExistingSubmit"));

  const submit = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "setup") {
        const setupHandoffInput = setupHandoffInputRef.current;
        const completeSetupDetails = setupHandoffInput?.value.trim() ?? "";
        if (setupHandoffInput) setupHandoffInput.value = "";

        let effectiveServerBaseUrl = serverBaseUrl.trim();
        let effectiveSetupCode = "";
        let effectiveAllowInsecureTransport = allowInsecureTransport;
        if (completeSetupDetails) {
          const handoff = parseCollaborationSetupHandoffV1(completeSetupDetails);
          if (!handoff) {
            setError(t("peopleSetupDetailsInvalid"));
            return;
          }
          effectiveServerBaseUrl = handoff.serverBaseUrl;
          effectiveSetupCode = handoff.setupCode;
          effectiveAllowInsecureTransport = handoff.allowInsecureTransport;
        } else if (!manualSetupOpen) {
          setError(t("peopleSetupDetailsInvalid"));
          return;
        } else {
          const setupCodeInput = setupCodeInputRef.current;
          if (!setupCodeInput) {
            throw new Error("Setup code input is unavailable.");
          }
          effectiveSetupCode = setupCodeInput.value.trim();
          setupCodeInput.value = "";
        }
        const candidate = {
          serverBaseUrl: effectiveServerBaseUrl,
          allowInsecureTransport: effectiveAllowInsecureTransport,
          setupCode: effectiveSetupCode,
          displayName: displayName.trim() || t("peopleDefaultProfileName")
        };
        const parsed = collaborationRedeemSetupCodeInputSchema.safeParse(candidate);
        if (!parsed.success) {
          const invalidFields = new Set(parsed.error.issues.map((issue) => issue.path[0]));
          const invalidServer = invalidFields.has("serverBaseUrl");
          const invalidCode = invalidFields.has("setupCode");
          setError(
            invalidServer && invalidCode
              ? t("peopleSetupCodeFieldsInvalid")
              : invalidServer
                ? t("peopleServerUrlInvalid")
                : t("peopleSetupCodeInvalid")
          );
          return;
        }
        await api.redeemCollaborationSetupCode(parsed.data);
        await onConnected?.();
        return;
      }

      if (mode === "connect") {
        if (!activeProfile) {
          throw new Error(t("peopleNoProfileToConnect"));
        }
        if (!activeProfile.hasDeviceCredential) {
          throw new Error(t("peopleMissingCredential"));
        }
        if (activeProfile.connectionState === "reconnect_required") {
          setError(t("peopleProfileReconnectRequired"));
          return;
        }
        // Main-owned local profiles are restored through coordinator activation, not
        // renderer upsert + bare connectSession (that path leaves content routes forbidden).
        if (isLocalCollaborationProfileId(activeProfile.profileId)) {
          if (typeof api.registerLocalCollaborationCurrentProject !== "function") {
            throw new Error(t("peopleMissingCredential"));
          }
          await api.registerLocalCollaborationCurrentProject({
            profileId: activeProfile.profileId
          });
          await onConnected?.();
          return;
        }
        const updatedProfile = collaborationUpsertProfileInputSchema.safeParse({
          profileId: activeProfile.profileId,
          displayName: activeProfile.displayName,
          serverBaseUrl: existingServerBaseUrl.trim(),
          projectId: activeProfile.projectId,
          allowInsecureTransport: activeProfile.allowInsecureTransport,
          endpoint: activeProfile.endpoint
        });
        if (!updatedProfile.success) {
          setError(t("peopleServerUrlInvalid"));
          return;
        }
        await api.upsertCollaborationProfile(updatedProfile.data);
        let workspaceConnectError: unknown = null;
        if (
          workspaceConnection?.status === "disconnected" ||
          workspaceConnection?.status === "error"
        ) {
          try {
            await api.connectWorkspaceConnection();
          } catch (caught) {
            // A Workspace connection is optional for a stored project profile. Preserve its
            // independent error state, but do not prevent the project session from connecting.
            workspaceConnectError = caught;
          }
        }
        await api.setActiveCollaborationProfile({ profileId: activeProfile.profileId });
        await api.connectCollaborationSession({ profileId: activeProfile.profileId });
        if (workspaceConnectError) {
          setInfo(
            `${t("peopleWorkspaceIdentityError")}: ${collaborationConnectionErrorMessage(t, workspaceConnectError)}`
          );
        }
        await onConnected?.();
        return;
      }

      let effectiveServerBaseUrl = serverBaseUrl.trim() || activeProfile?.serverBaseUrl || "";
      let effectiveProjectId = projectId.trim() || activeProfile?.projectId || "";
      let effectiveInvitationToken = invitationToken.trim();
      let effectiveAllowInsecureTransport = allowInsecureTransport;
      let effectiveEndpoint: DeploymentEndpoint | undefined = activeProfile?.endpoint ?? undefined;
      if (mode === "join" && invitationDetails.trim()) {
        const handoff = parseCollaborationInvitationHandoff(invitationDetails);
        if (!handoff) {
          setError(t("peopleInvitationDetailsInvalid"));
          return;
        }
        effectiveServerBaseUrl = handoff.serverBaseUrl;
        effectiveProjectId = handoff.projectId;
        effectiveInvitationToken = handoff.invitationToken;
        effectiveAllowInsecureTransport = handoff.allowInsecureTransport;
        effectiveEndpoint =
          handoff.endpoint ?? endpointForLegacyCollaborationInvitationHandoff(handoff) ?? undefined;
      } else if (mode === "join" && !manualJoinOpen) {
        setError(t("peopleInvitationDetailsInvalid"));
        return;
      }

      const profileId =
        mode === "join" ? newProfileId() : (activeProfile?.profileId ?? newProfileId());
      const profileDisplayName =
        displayName.trim() ||
        (mode === "join" ? t("peopleDefaultProfileName") : activeProfile?.displayName) ||
        t("peopleDefaultProfileName");
      const profile = collaborationUpsertProfileInputSchema.safeParse({
        profileId,
        displayName: profileDisplayName,
        serverBaseUrl: effectiveServerBaseUrl,
        projectId: effectiveProjectId,
        allowInsecureTransport: effectiveAllowInsecureTransport,
        endpoint: effectiveEndpoint
      });
      if (!profile.success) {
        setError(t("peopleProfileReconnectRequired"));
        return;
      }
      await api.upsertCollaborationProfile(profile.data);

      if (mode === "bootstrap") {
        const handoff = await api.bootstrapCollaborationOwner({
          profileId,
          request: { displayName: profileDisplayName }
        });
        if (
          handoff.nonPersistenceWarning ||
          handoff.deviceCredentialPersistence === "session-only"
        ) {
          setInfo(t("peopleSessionOnlyCredentialWarning"));
        }
      } else {
        const handoff = await api.consumeCollaborationInvitation({
          profileId,
          request: {
            invitationToken: effectiveInvitationToken,
            displayName: profileDisplayName
          }
        });
        if (
          handoff.nonPersistenceWarning ||
          handoff.deviceCredentialPersistence === "session-only"
        ) {
          setInfo(t("peopleSessionOnlyCredentialWarning"));
        }
      }

      await api.connectCollaborationSession({ profileId });
      setInvitationToken("");
      setInvitationDetails("");
      await onConnected?.();
    } catch (submitError) {
      setError(collaborationConnectionErrorMessage(t, submitError));
    } finally {
      setBusy(false);
    }
  };

  const selectWorkspace = async (workspaceId: string) => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.selectWorkspaceConnection({ workspaceId });
      await onConnected?.();
    } catch (selectError) {
      setError(collaborationErrorMessage(selectError));
    } finally {
      setBusy(false);
    }
  };

  const retryWorkspace = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.retryWorkspaceConnection();
      await onConnected?.();
    } catch (retryError) {
      setError(collaborationConnectionErrorMessage(t, retryError));
    } finally {
      setBusy(false);
    }
  };

  const restoreLocalOwner = async () => {
    if (
      !api ||
      busy ||
      !workspaceIdentityProfile ||
      typeof api.registerLocalCollaborationCurrentProject !== "function"
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.registerLocalCollaborationCurrentProject({
        profileId: workspaceIdentityProfile.profileId
      });
      await onConnected?.();
    } catch (restoreError) {
      setError(collaborationConnectionErrorMessage(t, restoreError));
    } finally {
      setBusy(false);
    }
  };

  const copyDiagnostics = async () => {
    if (!copyText || !diagnosticReport) return;
    try {
      await copyText(diagnosticReport);
      setDiagnosticsCopied(true);
    } catch {
      setError(t("peopleConnectionDiagnosticsCopyFailed"));
    }
  };

  const toggleConnectionEditor = () => {
    const nextOpen = !connectionEditorOpen;
    setConnectionEditorOpen(nextOpen);
    if (nextOpen) {
      setMode("join");
      setAdvancedModesOpen(false);
    }
  };

  const submitControls = (
    <div
      className={submitAlign === "start" ? "flex justify-start gap-2" : "flex justify-end gap-2"}
    >
      {onRequestClose ? (
        <Button type="button" size={submitSize} variant="ghost" onClick={onRequestClose}>
          {t("peopleClose")}
        </Button>
      ) : null}
      <Button
        type="button"
        size={submitSize}
        disabled={busy || !api}
        data-testid="people-connect-submit"
        onClick={() => void submit()}
      >
        {busy ? t("peopleWorking") : submitLabel}
      </Button>
    </div>
  );

  return (
    <section
      className="max-w-4xl"
      data-testid="people-connect-form"
      aria-label={showHeader ? undefined : t("peopleRemoteWorkspaceTitle")}
      aria-labelledby={showHeader ? "people-remote-workspace-title" : undefined}
    >
      {showHeader ? (
        <div className="flex items-start gap-3 pb-6">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-sky-700 dark:text-sky-300">
            <ServerIcon className="size-4" aria-hidden="true" />
          </div>
          <div>
            <h2
              id="people-remote-workspace-title"
              className="text-2xl font-semibold tracking-[-0.02em] text-text-strong"
            >
              {t("peopleRemoteWorkspaceTitle")}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
              {t("peopleRemoteWorkspaceDescription")}
            </p>
          </div>
        </div>
      ) : null}
      <div className={`flex flex-col gap-6 ${showHeader ? "" : "pt-0"}`}>
        {showConnectionSummary ? (
          <div className="flex flex-col gap-2">
            {connectionSummaryLabel ? (
              <h3 className="text-sm font-semibold text-text-strong">{connectionSummaryLabel}</h3>
            ) : null}
            <div
              className="flex flex-col gap-3 rounded-xl bg-surface-subtle px-4 py-4 text-sm sm:flex-row sm:items-center sm:justify-between"
              data-testid="people-workspace-connection-status"
              data-status={workspaceConnection?.status ?? "local_only"}
              role="status"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${
                    workspaceConnection?.status === "connected"
                      ? "bg-emerald-500"
                      : workspaceConnection?.status === "error"
                        ? "bg-destructive"
                        : "bg-muted-foreground/50"
                  }`}
                />
                <div className="min-w-0">
                  <div
                    className="font-semibold text-text-strong"
                    data-testid="people-workspace-current-name"
                  >
                    {workspaceConnection?.workspaceDisplayName ??
                      t("peopleWorkspaceIdentityMissing")}
                  </div>
                  <div
                    className="mt-0.5 truncate text-sm text-text-muted"
                    data-testid="people-workspace-identity-status"
                  >
                    {workspaceIdentityStatusLabel(workspaceConnection, t)}
                  </div>
                  {workspaceServerBaseUrl ? (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {workspaceServerBaseUrl}
                    </div>
                  ) : null}
                  {workspaceConnection?.status === "error" && workspaceConnection.error ? (
                    <div
                      className="mt-1 text-xs text-destructive"
                      data-testid="people-workspace-connection-error"
                    >
                      {workspaceConnection.error.message ?? workspaceConnection.error.code}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {!workspaceCredentialMissing &&
                (workspaceConnection?.status === "disconnected" ||
                  (workspaceConnection?.status === "error" &&
                    workspaceConnection.error?.retryable)) ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="people-workspace-retry"
                    disabled={busy || !api}
                    onClick={() => void retryWorkspace()}
                  >
                    {t("peopleWorkspaceIdentityRetry")}
                  </Button>
                ) : null}
                {localOwnerCredentialMissing ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="people-workspace-restore-local-owner"
                    disabled={
                      busy ||
                      !api ||
                      typeof api.registerLocalCollaborationCurrentProject !== "function"
                    }
                    onClick={() => void restoreLocalOwner()}
                  >
                    {t("peopleWorkspaceRestoreLocalOwner")}
                  </Button>
                ) : null}
                {workspaceConnected && !fixedMode ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="people-workspace-change-connection"
                    disabled={busy || !api}
                    onClick={toggleConnectionEditor}
                  >
                    {connectionEditorOpen
                      ? t("peopleWorkspaceCancelSwitch")
                      : t("peopleWorkspaceSwitch")}
                  </Button>
                ) : null}
              </div>
            </div>
            {connectionSummaryHint ? (
              <p className="text-xs leading-5 text-text-muted">{connectionSummaryHint}</p>
            ) : null}
          </div>
        ) : null}

        {afterSummary}

        {workspaceCredentialMissing ? (
          <p
            className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-950 dark:text-amber-100"
            data-testid="people-workspace-credential-missing"
            role="status"
          >
            {t("peopleMissingCredential")}{" "}
            {t(
              localOwnerCredentialMissing
                ? "peopleMissingLocalOwnerCredentialHint"
                : "peopleMissingRemoteCredentialHint"
            )}
          </p>
        ) : null}

        {showConnectionEditor ? (
          <>
            {showConnectionSummary && showWorkspacePicker && workspacePickerItems.length > 0 ? (
              <div
                className="flex flex-col"
                data-testid="people-workspace-picker"
                role="listbox"
                aria-label={t("peopleWorkspacePicker")}
              >
                <div className="pb-2 text-sm font-semibold text-text-strong">
                  {t("peopleWorkspacePicker")}
                </div>
                <div className="flex flex-col gap-1 rounded-xl bg-surface-subtle p-1">
                  {workspacePickerItems.map((item) => (
                    <button
                      key={item.workspaceId}
                      type="button"
                      role="option"
                      data-testid={`people-workspace-picker-item-${item.workspaceId}`}
                      className="flex w-full items-center justify-between gap-4 rounded-lg px-3 py-3 text-left hover:bg-background/70"
                      disabled={busy || !api}
                      onClick={() => void selectWorkspace(item.workspaceId)}
                    >
                      <div className="font-medium text-text-strong">{item.displayName}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.role ?? t("peopleWorkspaceRoleUnknown")}
                        {item.membershipActive
                          ? ""
                          : ` · ${t("peopleWorkspaceMembershipInactive")}`}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {(mode === "setup" && showSetupTrustNote) || mode === "join" ? (
              <p className="text-xs text-muted-foreground" data-testid="people-invite-trust-note">
                {mode === "setup"
                  ? t("peopleSetupCodeTrustNote")
                  : t("peopleInvitationBearerTrustNote")}
              </p>
            ) : null}
            {status?.credentialStorage === "unavailable" || status?.nonPersistenceWarning ? (
              <p
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-900 dark:text-amber-100"
                data-testid="people-session-only-warning"
                role="status"
              >
                {t("peopleSessionOnlyCredentialWarning")}
              </p>
            ) : null}

            {!fixedMode && !workspaceConnectionOnly ? (
              <div className="flex flex-col gap-3">
                <fieldset className="flex max-w-full flex-wrap gap-x-8 border-b border-border/70">
                  <legend className="sr-only">{t("peopleConnectModes")}</legend>
                  {(
                    [
                      ["join", "peopleConnectJoin"],
                      ["setup", "peopleConnectSetupCode"]
                    ] as const
                  ).map(([value, labelKey]) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant="ghost"
                      className={`relative rounded-none px-0 pb-3 text-sm font-semibold hover:bg-transparent ${
                        mode === value
                          ? "text-text-strong after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-text-strong"
                          : "text-muted-foreground"
                      }`}
                      data-testid={`people-connect-mode-${value}`}
                      aria-pressed={mode === value}
                      onClick={() => {
                        setMode(value);
                        setAdvancedModesOpen(false);
                        if (value === "join") setManualJoinOpen(true);
                      }}
                    >
                      {t(labelKey)}
                    </Button>
                  ))}
                </fieldset>
                <details
                  className="text-xs"
                  open={advancedModesOpen}
                  onToggle={(event) => setAdvancedModesOpen(event.currentTarget.open)}
                  data-testid="people-connect-advanced-modes"
                >
                  <summary
                    className="flex cursor-pointer list-none items-center gap-2 select-none text-muted-foreground hover:text-text-strong [&::-webkit-details-marker]:hidden"
                    data-testid="people-connect-advanced-toggle"
                  >
                    {advancedModesOpen ? (
                      <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    {t("peopleConnectAdvanced")}
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-2 border-l border-border/70 pl-3">
                    {activeProfile || workspaceConnection?.profile ? (
                      <Button
                        type="button"
                        size="sm"
                        variant={mode === "connect" ? "secondary" : "ghost"}
                        className="h-8 px-2.5 text-xs"
                        data-testid="people-connect-mode-connect"
                        aria-pressed={mode === "connect"}
                        onClick={() => setMode("connect")}
                      >
                        {t("peopleConnectExisting")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant={mode === "bootstrap" ? "secondary" : "ghost"}
                      className="h-8 px-2.5 text-xs"
                      data-testid="people-connect-mode-bootstrap"
                      aria-pressed={mode === "bootstrap"}
                      onClick={() => setMode("bootstrap")}
                    >
                      {t("peopleConnectBootstrap")}
                    </Button>
                  </div>
                </details>
              </div>
            ) : null}

            {mode === "setup" && !handoffFallbackOpen ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                data-testid="people-connect-handoff-fallback"
                onClick={() => setHandoffFallbackOpen(true)}
              >
                {t("settingsServerHandoffFallback")}
              </Button>
            ) : null}

            {mode === "setup" && handoffFallbackOpen ? (
              <CollaborationSetupHandoffFields
                formId={formId}
                t={t}
                handoffInputRef={setupHandoffInputRef}
                setupCodeInputRef={setupCodeInputRef}
                displayName={displayName}
                manualOpen={manualSetupOpen}
                serverBaseUrl={serverBaseUrl}
                allowInsecureTransport={allowInsecureTransport}
                onDisplayNameChange={setDisplayName}
                onManualOpenChange={setManualSetupOpen}
                onServerBaseUrlChange={setServerBaseUrl}
                onAllowInsecureTransportChange={setAllowInsecureTransport}
                action={setupSubmitAfterPaste ? submitControls : undefined}
              />
            ) : null}

            {mode === "join" ? (
              <CollaborationInvitationJoinFields
                formId={formId}
                t={t}
                invitationDetails={invitationDetails}
                displayName={displayName}
                manualJoinOpen={manualJoinOpen}
                serverBaseUrl={serverBaseUrl}
                projectId={projectId}
                invitationToken={invitationToken}
                allowInsecureTransport={allowInsecureTransport}
                onInvitationDetailsChange={setInvitationDetails}
                onDisplayNameChange={setDisplayName}
                onManualJoinOpenChange={setManualJoinOpen}
                onServerBaseUrlChange={setServerBaseUrl}
                onProjectIdChange={setProjectId}
                onInvitationTokenChange={setInvitationToken}
                onAllowInsecureTransportChange={setAllowInsecureTransport}
              />
            ) : null}

            {mode === "bootstrap" ? (
              <div className="grid grid-cols-1 gap-x-5 gap-y-3 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${formId}-name-legacy`}>{t("peopleDisplayName")}</Label>
                  <Input
                    id={`${formId}-name-legacy`}
                    data-testid="people-connect-display-name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    autoComplete="nickname"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${formId}-url-legacy`}>{t("peopleServerUrl")}</Label>
                  <Input
                    id={`${formId}-url-legacy`}
                    data-testid="people-connect-server-url"
                    value={serverBaseUrl}
                    onChange={(event) => setServerBaseUrl(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${formId}-project`}>{t("peopleProjectId")}</Label>
                  <Input
                    id={`${formId}-project`}
                    data-testid="people-connect-project-id"
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground md:col-span-2">
                  <input
                    type="checkbox"
                    data-testid="people-connect-allow-insecure"
                    checked={allowInsecureTransport}
                    onChange={(event) => setAllowInsecureTransport(event.target.checked)}
                  />
                  {t("peopleAllowInsecureTransport")}
                </label>
              </div>
            ) : null}

            {mode === "connect" ? (
              <div className="rounded-xl bg-surface-subtle px-4 py-3 text-xs">
                {activeProfile || workspaceConnection?.profile ? (
                  <div data-testid="people-connect-active-profile">
                    <div className="font-medium text-text-strong">
                      {workspaceConnection?.workspaceDisplayName ?? activeProfile?.displayName}
                    </div>
                    <div className="text-muted-foreground">
                      {workspaceConnection?.profile?.serverBaseUrl ?? activeProfile?.serverBaseUrl}
                    </div>
                    {activeProfile?.projectId ? (
                      <div className="text-muted-foreground">{activeProfile.projectId}</div>
                    ) : null}
                    {workspaceConnection?.workspaceId ? (
                      <div className="text-muted-foreground">{workspaceConnection.workspaceId}</div>
                    ) : null}
                    <div className="text-muted-foreground">
                      {workspaceIdentityProfile?.hasDeviceCredential ||
                      workspaceConnection?.status === "connected"
                        ? t("peopleCredentialPresent")
                        : t("peopleMissingCredential")}
                    </div>
                    {activeProfile ? (
                      <div className="mt-3 flex flex-col gap-1">
                        <Label htmlFor={`${formId}-existing-server-url`}>
                          {t("peopleExistingServerUrl")}
                        </Label>
                        <Input
                          id={`${formId}-existing-server-url`}
                          data-testid="people-connect-existing-server-url"
                          value={existingServerBaseUrl}
                          readOnly
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <p className="text-muted-foreground">
                          {activeProfile.connectionState === "reconnect_required"
                            ? t("peopleProfileReconnectRequired")
                            : t("peopleExistingServerUrlHint")}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div data-testid="people-connect-no-profile">{t("peopleNoProfileToConnect")}</div>
                )}
                {diagnosticReport ? (
                  <details className="mt-4" data-testid="people-connection-diagnostics">
                    <summary className="cursor-pointer select-none font-medium text-text-strong">
                      {t("peopleConnectionDiagnostics")}
                    </summary>
                    <p className="mt-2 text-muted-foreground">
                      {t("peopleConnectionDiagnosticsHint")}
                    </p>
                    <pre
                      className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-5 text-text-strong"
                      data-testid="people-connection-diagnostics-report"
                    >
                      {diagnosticReport}
                    </pre>
                    {copyText ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        data-testid="people-connection-diagnostics-copy"
                        onClick={() => void copyDiagnostics()}
                      >
                        {diagnosticsCopied
                          ? t("peopleConnectionDiagnosticsCopied")
                          : t("peopleConnectionDiagnosticsCopy")}
                      </Button>
                    ) : null}
                  </details>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {error ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            data-testid="people-connect-error"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        {info ? (
          <div
            className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs"
            data-testid="people-connect-info"
            role="status"
          >
            {info}
          </div>
        ) : null}

        {showConnectionEditor && !(setupSubmitAfterPaste && mode === "setup")
          ? submitControls
          : null}
      </div>
    </section>
  );
}
