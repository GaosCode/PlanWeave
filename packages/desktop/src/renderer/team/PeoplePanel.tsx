import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type {
  PeopleDeviceRow,
  PeopleInvitationRow,
  PeopleMemberRow,
  PeoplePanelMode,
  PeoplePresenceSummary
} from "../collaboration/peopleViewModels";
import type { CollaborationInvitationHandoffView } from "../../shared/collaboration.js";
import { CollaborationDiagnosticsDetails } from "./CollaborationDiagnosticsDetails";
import { MemberLoginDevices } from "./MemberLoginDevices";
import { OwnDisplayNameControl } from "./OwnDisplayNameControl";

export type PeoplePanelProps = {
  mode: PeoplePanelMode;
  presence: PeoplePresenceSummary;
  members: PeopleMemberRow[];
  invitations: PeopleInvitationRow[];
  devices: PeopleDeviceRow[];
  detailsLoading: boolean;
  detailsError: string | null;
  actionError: string | null;
  actionBusy: boolean;
  pendingInvitation: CollaborationInvitationHandoffView | null;
  /** Opens the existing owner invitation controls after a capacity-recovery navigation. */
  revealInvitationManagement?: boolean;
  t: ReturnType<typeof createTranslator>;
  onCreateInvitation: () => Promise<CollaborationInvitationHandoffView | null>;
  onViewInvitation: (invitationId: string) => Promise<CollaborationInvitationHandoffView | null>;
  onCopyInvitationToken: (token: string) => Promise<void>;
  onDismissPendingInvitation: () => void;
  onRevokeInvitation: (invitationId: string) => Promise<boolean>;
  onRevokeInvitations: (invitationIds: readonly string[]) => Promise<boolean>;
  onUpdateOwnDisplayName: (displayName: string) => Promise<boolean>;
  onPromoteMember: (humanPrincipalId: string) => Promise<boolean>;
  onDemoteMember: (humanPrincipalId: string) => Promise<boolean>;
  onRemoveMember: (humanPrincipalId: string) => Promise<boolean>;
  onRevokeDevice: (deviceCredentialId: string) => Promise<boolean>;
  onRefreshDetails: () => Promise<void>;
  /** Current-project access controls rendered below one expanded member row. */
  renderMemberAccess?: (member: PeopleMemberRow) => ReactNode;
  /** Optional connect form when disconnected. */
  connectSlot?: ReactNode;
  /** Allowlisted read/session context for cross-device troubleshooting. */
  diagnosticReport?: string | null;
  diagnosticsEnabled?: boolean;
  onCopyDiagnostics?: (report: string) => Promise<void>;
  /** Page shells may already expose the selected destination. */
  showTitle?: boolean;
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function shortIdentifier(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function MemberAvatar({ initials, label }: { initials: string; label: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-state-selected-surface text-xs font-semibold text-text-strong ring-1 ring-border/70"
      title={label}
    >
      {initials}
    </span>
  );
}

export function PeoplePanel({
  mode,
  presence,
  members,
  invitations,
  devices,
  detailsLoading,
  detailsError,
  actionError,
  actionBusy,
  pendingInvitation,
  revealInvitationManagement = false,
  t,
  onCreateInvitation,
  onViewInvitation,
  onCopyInvitationToken,
  onDismissPendingInvitation,
  onRevokeInvitation,
  onRevokeInvitations,
  onUpdateOwnDisplayName,
  onPromoteMember,
  onDemoteMember,
  onRemoveMember,
  onRevokeDevice,
  onRefreshDetails,
  renderMemberAccess,
  connectSlot,
  diagnosticReport = null,
  diagnosticsEnabled = false,
  onCopyDiagnostics,
  showTitle = true
}: PeoplePanelProps) {
  const [showOwnerDetails, setShowOwnerDetails] = useState(revealInvitationManagement);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const [expandedAccessPrincipalId, setExpandedAccessPrincipalId] = useState<string | null>(null);
  const [expandedDevicePrincipalIds, setExpandedDevicePrincipalIds] = useState<Set<string>>(
    () => new Set()
  );
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [selectedInvitationIds, setSelectedInvitationIds] = useState<Set<string>>(new Set());
  const liveRegionRef = useRef<HTMLDivElement>(null);
  const pendingInvitationRef = useRef<HTMLInputElement>(null);
  const pendingInvitationDetails = pendingInvitation?.handoff ?? null;

  useEffect(() => {
    setCopied(false);
    setCopyError(false);
    if (pendingInvitation) setShowOwnerDetails(true);
  }, [pendingInvitation]);

  useEffect(() => {
    if (pendingInvitation && showOwnerDetails && pendingInvitationRef.current) {
      pendingInvitationRef.current.focus();
      pendingInvitationRef.current.select();
    }
  }, [pendingInvitation, showOwnerDetails]);

  useEffect(() => {
    if (presence.currentUserIsOwner && (presence.memberCount <= 1 || revealInvitationManagement)) {
      setShowOwnerDetails(true);
    }
  }, [presence.currentUserIsOwner, presence.memberCount, revealInvitationManagement]);

  const openInvitations = useMemo(
    () => invitations.filter((invitation) => invitation.open),
    [invitations]
  );
  const openInvitationIds = useMemo(
    () => openInvitations.map((invitation) => invitation.invitationId),
    [openInvitations]
  );
  const allOpenInvitationsSelected =
    openInvitationIds.length > 0 &&
    openInvitationIds.every((invitationId) => selectedInvitationIds.has(invitationId));
  const someOpenInvitationsSelected = selectedInvitationIds.size > 0 && !allOpenInvitationsSelected;

  useEffect(() => {
    const openIds = new Set(openInvitationIds);
    setSelectedInvitationIds((current) => {
      const next = new Set([...current].filter((invitationId) => openIds.has(invitationId)));
      if (next.size === current.size) return current;
      return next;
    });
  }, [openInvitationIds]);

  const confirmDestructive = (message: string): boolean => window.confirm(message);

  const diagnostics = diagnosticReport ? (
    <CollaborationDiagnosticsDetails
      enabled={diagnosticsEnabled}
      report={diagnosticReport}
      t={t}
      onCopy={onCopyDiagnostics}
      testIdPrefix="people-read-diagnostics"
    />
  ) : null;

  const renderInlineInvitationSecret = (invitationId: string) => {
    if (pendingInvitation?.invitation.invitationId !== invitationId) return null;
    return (
      <section
        className="mt-2 flex flex-col gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3"
        data-testid="people-invitation-secret-once"
        aria-label={t("peopleInvitationCopyOnceTitle")}
      >
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <span className="shrink-0 text-xs font-semibold">
            {t("peopleInvitationCopyOnceTitle")}
          </span>
          <input
            ref={pendingInvitationRef}
            className="h-9 min-w-0 flex-1 truncate rounded-md border border-border bg-background px-3 font-mono text-xs"
            data-testid="people-invitation-token-value"
            readOnly
            value={pendingInvitationDetails ?? ""}
            aria-label={t("peopleInvitationDetails")}
          />
          <Button
            type="button"
            size="sm"
            className="h-9 shrink-0 px-3 text-xs"
            data-testid="people-invitation-copy"
            disabled={actionBusy}
            onClick={() => {
              void (async () => {
                try {
                  await onCopyInvitationToken(
                    pendingInvitationDetails ?? pendingInvitation.invitationToken
                  );
                  setCopied(true);
                  setCopyError(false);
                } catch {
                  setCopied(false);
                  setCopyError(true);
                }
              })();
            }}
          >
            {copied ? t("peopleInvitationCopied") : t("peopleInvitationCopyHandoff")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9 shrink-0 px-3 text-xs"
            data-testid="people-invitation-dismiss"
            onClick={() => {
              setCopied(false);
              onDismissPendingInvitation();
            }}
          >
            {t("peopleInvitationDismiss")}
          </Button>
        </div>
        {presence.credentialPersistence === "session-only" || presence.nonPersistenceWarning ? (
          <p className="text-xs leading-5 text-amber-900 dark:text-amber-100">
            {t("peopleInvitationSessionOnlyWarning")}
          </p>
        ) : null}
        {copyError ? (
          <p
            className="text-xs text-destructive"
            data-testid="people-invitation-copy-error"
            role="alert"
          >
            {t("peopleInvitationCopyFailed")}
          </p>
        ) : null}
      </section>
    );
  };

  if (mode === "disconnected" || mode === "connecting") {
    return (
      <div className="flex flex-col gap-2" data-testid="people-panel" data-mode={mode}>
        {showTitle ? (
          <h1 className="text-lg font-semibold text-text-strong">{t("peopleTitle")}</h1>
        ) : null}
        {mode === "connecting" ? (
          <p className="text-xs text-muted-foreground">{t("peopleConnecting")}</p>
        ) : null}
        {mode === "disconnected" ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3"
            data-testid="people-panel-disconnected"
          >
            <p className="text-xs text-muted-foreground" role="status">
              {t("peopleProjectSessionDisconnected")}
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="people-refresh-details"
              disabled={detailsLoading || actionBusy}
              onClick={() => void onRefreshDetails()}
            >
              {t("peopleRefresh")}
            </Button>
          </div>
        ) : null}
        {connectSlot}
        {diagnostics}
      </div>
    );
  }

  if (mode === "auth_expired" || mode === "forbidden") {
    return (
      <div className="flex flex-col gap-2" data-testid="people-panel" data-mode={mode}>
        {showTitle ? (
          <h1 className="text-lg font-semibold text-text-strong">{t("peopleTitle")}</h1>
        ) : null}
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          role="alert"
          data-testid="people-panel-auth-error"
        >
          {mode === "auth_expired" ? t("peopleAuthExpired") : t("peopleForbidden")}
        </div>
        {connectSlot}
        {diagnostics}
      </div>
    );
  }

  const memberStateText =
    mode === "ready" || mode === "empty"
      ? t("peopleMemberCount").replace("{count}", String(presence.memberCount))
      : mode === "loading"
        ? t("peopleLoading")
        : mode === "offline"
          ? t("peopleOffline")
          : t("peopleError");
  const emptyMemberStateText =
    mode === "empty"
      ? t("peopleEmptyMembers")
      : mode === "loading"
        ? t("peopleLoading")
        : mode === "offline"
          ? t("peopleOffline")
          : t("peopleError");
  const projectSessionStatusText =
    presence.sessionPhase === "connected"
      ? t("peopleProjectSessionConnected")
      : presence.sessionPhase === "connecting"
        ? t("peopleProjectSessionConnecting")
        : presence.sessionPhase === "error"
          ? t("peopleProjectSessionError")
          : t("peopleProjectSessionDisconnected");
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="people-panel" data-mode={mode}>
      <div
        className="flex flex-col gap-4 border-b border-border/70 px-1 pb-5 sm:flex-row sm:items-center sm:justify-between"
        data-testid="people-toolbar"
      >
        <div>
          {showTitle ? (
            <h1 className="text-lg font-semibold text-text-strong">{t("peopleTitle")}</h1>
          ) : null}
          <p className="text-sm text-muted-foreground" data-testid="people-presence-summary">
            {memberStateText}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2 py-0.5"
              data-testid="people-workspace-summary"
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${
                  presence.sessionPhase === "connected"
                    ? "bg-emerald-500"
                    : presence.sessionPhase === "error"
                      ? "bg-destructive"
                      : "bg-muted-foreground/50"
                }`}
              />
              {projectSessionStatusText}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {presence.currentUserIsOwner ? (
            <Button
              type="button"
              size="sm"
              data-testid="people-create-invitation"
              disabled={actionBusy || pendingInvitation !== null}
              onClick={() => {
                setShowOwnerDetails(true);
                void onCreateInvitation();
              }}
            >
              {t("peopleCreateInvitation")}
            </Button>
          ) : null}
          {connectSlot ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="people-toggle-connection-settings"
              aria-expanded={showConnectionSettings}
              onClick={() => setShowConnectionSettings((current) => !current)}
            >
              {t(
                showConnectionSettings ? "peopleHideConnectionSettings" : "peopleConnectionSettings"
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="people-refresh-details"
            disabled={detailsLoading || actionBusy}
            onClick={() => void onRefreshDetails()}
          >
            {t("peopleRefresh")}
          </Button>
        </div>
      </div>

      {presence.credentialPersistence === "session-only" || presence.nonPersistenceWarning ? (
        <p
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs"
          data-testid="people-session-only-banner"
          role="status"
        >
          {t("peopleSessionOnlyCredentialWarning")}
        </p>
      ) : null}

      {mode === "loading" ? (
        <div className="text-xs text-muted-foreground" data-testid="people-loading" role="status">
          {t("peopleLoading")}
        </div>
      ) : null}
      {mode === "offline" ? (
        <div
          className="text-xs text-amber-800 dark:text-amber-100"
          data-testid="people-offline"
          role="status"
        >
          {t("peopleOffline")}
        </div>
      ) : null}
      {mode === "error" ? (
        <div className="text-xs text-muted-foreground" data-testid="people-error" role="status">
          {t("peopleError")}
        </div>
      ) : null}

      {actionError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          data-testid="people-action-error"
          role="alert"
        >
          {actionError}
        </div>
      ) : null}
      {detailsError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          data-testid="people-details-error"
          role="alert"
        >
          {detailsError}
        </div>
      ) : null}

      {diagnostics}

      {connectSlot && showConnectionSettings ? (
        <div className="border-y border-border/70 py-4" data-testid="people-connection-settings">
          {connectSlot}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col gap-5">
        <div className="min-w-0">
          <section
            aria-label={t("peopleMembers")}
            data-testid="people-members-section"
            className="min-w-0 border-b border-border/70"
          >
            {members.length === 0 ? (
              <div
                className="px-1 py-5 text-xs text-muted-foreground"
                data-testid="people-members-empty"
              >
                {emptyMemberStateText}
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {members.map((member) => {
                  const promote = member.actions.find((action) => action.action === "promote");
                  const demote = member.actions.find((action) => action.action === "demote");
                  const remove = member.actions.find((action) => action.action === "remove");
                  const memberDevices = devices.filter(
                    (device) =>
                      device.humanPrincipalId === member.humanPrincipalId && !device.isRevoked
                  );
                  const canManageDevices = presence.currentUserIsOwner || member.isCurrentUser;
                  const memberDevicesPanelId = `people-member-devices-${member.humanPrincipalId}`;
                  return (
                    <li
                      key={member.membershipId}
                      className="min-w-0"
                      data-testid="people-member-row"
                      data-principal-id={member.humanPrincipalId}
                      data-role={member.role}
                    >
                      <div className="flex min-w-0 items-center gap-3 px-1 py-3.5">
                        <MemberAvatar initials={member.initials} label={member.displayName} />
                        <div className="min-w-0 flex-1">
                          {member.isCurrentUser ? (
                            <OwnDisplayNameControl
                              member={member}
                              actionBusy={actionBusy}
                              t={t}
                              onUpdate={onUpdateOwnDisplayName}
                            />
                          ) : (
                            <div className="truncate text-sm font-semibold text-text-strong">
                              {member.displayName}
                            </div>
                          )}
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span>
                              {member.role === "owner"
                                ? t("peopleRoleOwner")
                                : t("peopleRoleMember")}
                            </span>
                            {canManageDevices ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1.5 text-[11px] text-muted-foreground"
                                data-testid="people-member-devices-toggle"
                                aria-expanded={expandedDevicePrincipalIds.has(
                                  member.humanPrincipalId
                                )}
                                aria-controls={memberDevicesPanelId}
                                onClick={() =>
                                  setExpandedDevicePrincipalIds((current) => {
                                    const next = new Set(current);
                                    if (next.has(member.humanPrincipalId)) {
                                      next.delete(member.humanPrincipalId);
                                    } else {
                                      next.add(member.humanPrincipalId);
                                    }
                                    return next;
                                  })
                                }
                              >
                                {t("peopleLoginDevices").replace(
                                  "{count}",
                                  String(memberDevices.length)
                                )}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        {presence.currentUserIsOwner ? (
                          <div className="flex shrink-0 flex-wrap justify-end gap-1">
                            {renderMemberAccess && member.role !== "owner" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2 text-xs"
                                data-testid="people-member-access-toggle"
                                aria-expanded={
                                  expandedAccessPrincipalId === member.humanPrincipalId
                                }
                                aria-controls={`people-member-access-${member.humanPrincipalId}`}
                                onClick={() =>
                                  setExpandedAccessPrincipalId((current) =>
                                    current === member.humanPrincipalId
                                      ? null
                                      : member.humanPrincipalId
                                  )
                                }
                              >
                                {expandedAccessPrincipalId === member.humanPrincipalId
                                  ? t("peopleHidePermissions")
                                  : t("peopleManagePermissions")}
                              </Button>
                            ) : null}
                            {promote?.allowed ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2 text-xs"
                                data-testid="people-member-promote"
                                disabled={actionBusy}
                                onClick={() => void onPromoteMember(member.humanPrincipalId)}
                              >
                                {t("peoplePromote")}
                              </Button>
                            ) : null}
                            {demote?.allowed ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2 text-xs"
                                data-testid="people-member-demote"
                                disabled={actionBusy}
                                onClick={() => {
                                  if (!confirmDestructive(t("peopleDemoteConfirm"))) return;
                                  void onDemoteMember(member.humanPrincipalId);
                                }}
                              >
                                {t("peopleDemote")}
                              </Button>
                            ) : demote && !demote.allowed && demote.reason === "last_owner" ? (
                              <span
                                className="max-w-32 text-right text-[11px] leading-4 text-muted-foreground"
                                data-testid="people-last-owner-guard"
                              >
                                {t("peopleLastOwnerProtected")}
                              </span>
                            ) : null}
                            {remove?.allowed ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2 text-xs text-destructive"
                                data-testid="people-member-remove"
                                disabled={actionBusy}
                                onClick={() => {
                                  if (!confirmDestructive(t("peopleRemoveConfirm"))) return;
                                  void onRemoveMember(member.humanPrincipalId);
                                }}
                              >
                                {t("peopleRemove")}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {expandedAccessPrincipalId === member.humanPrincipalId &&
                      renderMemberAccess ? (
                        <div
                          id={`people-member-access-${member.humanPrincipalId}`}
                          className="border-t border-border/60 px-1 py-4"
                          data-testid="people-member-access"
                        >
                          {renderMemberAccess(member)}
                        </div>
                      ) : null}
                      {expandedDevicePrincipalIds.has(member.humanPrincipalId) &&
                      canManageDevices ? (
                        <MemberLoginDevices
                          id={memberDevicesPanelId}
                          devices={memberDevices}
                          loading={detailsLoading}
                          actionBusy={actionBusy}
                          t={t}
                          onSignOut={onRevokeDevice}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {presence.currentUserIsOwner ? (
          <section
            aria-labelledby="people-owner-heading"
            data-testid="people-owner-section"
            className="min-w-0"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-between rounded-none px-1 py-4 text-sm font-semibold hover:bg-transparent"
              data-testid="people-owner-toggle"
              aria-expanded={showOwnerDetails}
              onClick={() => setShowOwnerDetails((current) => !current)}
            >
              <span id="people-owner-heading">{t("peopleOwnerActions")}</span>
              <span aria-hidden="true">{showOwnerDetails ? "−" : "+"}</span>
            </Button>
            {showOwnerDetails ? (
              <div className="min-w-0 border-t border-border/70 py-4">
                <div className="min-w-0" data-testid="people-invitations-list">
                  <div
                    className={
                      openInvitationIds.length > 0
                        ? "flex flex-wrap items-center justify-end gap-2 px-1 py-2.5"
                        : "hidden"
                    }
                  >
                    {openInvitationIds.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
                          <input
                            type="checkbox"
                            className="size-3.5 accent-foreground"
                            data-testid="people-invitation-select-all"
                            checked={allOpenInvitationsSelected}
                            disabled={actionBusy}
                            aria-checked={
                              someOpenInvitationsSelected ? "mixed" : allOpenInvitationsSelected
                            }
                            ref={(element) => {
                              if (element) {
                                element.indeterminate = someOpenInvitationsSelected;
                              }
                            }}
                            onChange={(event) => {
                              setSelectedInvitationIds(
                                event.currentTarget.checked ? new Set(openInvitationIds) : new Set()
                              );
                            }}
                          />
                          {t("peopleSelectAllOpenInvitations")}
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2 text-[11px] text-destructive"
                          data-testid="people-invitation-revoke-selected"
                          disabled={actionBusy || selectedInvitationIds.size === 0}
                          onClick={() => {
                            const invitationIds = [...selectedInvitationIds];
                            if (
                              !confirmDestructive(
                                t("peopleRevokeSelectedInvitationsConfirm").replace(
                                  "{count}",
                                  String(invitationIds.length)
                                )
                              )
                            ) {
                              return;
                            }
                            void onRevokeInvitations(invitationIds).then((ok) => {
                              if (!ok) return;
                              setSelectedInvitationIds((current) => {
                                const next = new Set(current);
                                for (const invitationId of invitationIds) {
                                  next.delete(invitationId);
                                }
                                return next;
                              });
                            });
                          }}
                        >
                          {t("peopleRevokeSelected").replace(
                            "{count}",
                            String(selectedInvitationIds.size)
                          )}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {detailsLoading ? (
                    <div className="px-1 py-4 text-xs text-muted-foreground">
                      {t("peopleLoading")}
                    </div>
                  ) : openInvitations.length === 0 ? (
                    <div className="px-1 py-4 text-xs text-muted-foreground">
                      {t("peopleEmptyInvitations")}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {openInvitations.map((invitation) => {
                        const status = invitation.open
                          ? t("peopleInvitationOpen")
                          : invitation.consumedAt
                            ? t("peopleInvitationConsumed")
                            : invitation.revokedAt
                              ? t("peopleInvitationRevoked")
                              : t("peopleInvitationExpired");
                        return (
                          <li
                            key={invitation.invitationId}
                            className="flex min-w-0 flex-col px-1 py-3 text-xs"
                            data-testid="people-invitation-row"
                            data-open={invitation.open ? "true" : "false"}
                          >
                            <div className="flex min-w-0 items-start gap-3">
                              {invitation.open ? (
                                <input
                                  type="checkbox"
                                  className="size-3.5 shrink-0 accent-foreground"
                                  data-testid="people-invitation-select"
                                  aria-label={t("peopleSelectInvitation").replace(
                                    "{id}",
                                    shortIdentifier(invitation.invitationId)
                                  )}
                                  checked={selectedInvitationIds.has(invitation.invitationId)}
                                  disabled={actionBusy}
                                  onChange={(event) => {
                                    const checked = event.currentTarget.checked;
                                    const invitationId = invitation.invitationId;
                                    setSelectedInvitationIds((current) => {
                                      const next = new Set(current);
                                      if (checked) {
                                        next.add(invitationId);
                                      } else {
                                        next.delete(invitationId);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              ) : null}
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  <span className="font-medium text-text-strong">{status}</span>
                                  <span className="text-[10px] text-muted-foreground">
                                    {t("peopleInvitationCreated").replace(
                                      "{time}",
                                      formatTimestamp(invitation.createdAt)
                                    )}
                                  </span>
                                </div>
                                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">
                                  {t("peopleInvitationExpires").replace(
                                    "{time}",
                                    formatTimestamp(invitation.expiresAt)
                                  )}
                                  <span title={invitation.invitationId}>
                                    {t("peopleInvitationIdLabel").replace(
                                      "{id}",
                                      shortIdentifier(invitation.invitationId)
                                    )}
                                  </span>
                                </div>
                              </div>
                              {invitation.open ? (
                                <div className="flex shrink-0 items-center gap-1">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-8 px-2 text-[11px]"
                                    data-testid="people-invitation-view"
                                    disabled={actionBusy}
                                    onClick={() => void onViewInvitation(invitation.invitationId)}
                                  >
                                    {t("peopleViewInvitation")}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-8 px-2 text-[11px] text-destructive"
                                    data-testid="people-invitation-revoke"
                                    disabled={actionBusy}
                                    onClick={() => {
                                      if (!confirmDestructive(t("peopleRevokeInvitationConfirm")))
                                        return;
                                      void onRevokeInvitation(invitation.invitationId);
                                    }}
                                  >
                                    {t("peopleRevoke")}
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                            {renderInlineInvitationSecret(invitation.invitationId)}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      <div
        ref={liveRegionRef}
        className="sr-only"
        aria-live="polite"
        data-testid="people-live-region"
      >
        {actionError ?? detailsError ?? (copied ? t("peopleInvitationCopied") : "")}
      </div>
    </div>
  );
}
