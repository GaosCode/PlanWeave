import { useState, type ReactNode } from "react";
import { EllipsisIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ManagementDialog } from "../components/ManagementDialog";
import { MemberAvatar } from "./MemberAvatar";
import { MemberLoginDevices } from "./MemberLoginDevices";
import { PeopleIdentityCard } from "./PeopleIdentityCard";
import { OwnDisplayNameControl } from "./OwnDisplayNameControl";
import type { PeoplePanelProps } from "./PeoplePanel";

type Props = Pick<
  PeoplePanelProps,
  | "members"
  | "identity"
  | "presence"
  | "devices"
  | "detailsLoading"
  | "actionBusy"
  | "canManageMemberAccess"
  | "renderMemberAccess"
  | "selectedMemberId"
  | "onSelectMember"
  | "onUpdateOwnDisplayName"
  | "onPromoteMember"
  | "onDemoteMember"
  | "onRemoveMember"
  | "onRevokeDevice"
  | "t"
> & { emptyText: string; accessScope?: ReactNode };

export function PeopleMemberList({
  members,
  identity,
  presence,
  devices,
  detailsLoading,
  actionBusy,
  canManageMemberAccess,
  renderMemberAccess,
  selectedMemberId,
  onSelectMember,
  onUpdateOwnDisplayName,
  onPromoteMember,
  onDemoteMember,
  onRemoveMember,
  onRevokeDevice,
  emptyText,
  accessScope,
  t
}: Props) {
  const [accessId, setAccessId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const selected = members.find(
    (member) =>
      member.humanPrincipalId === (selectedMemberId === undefined ? accessId : selectedMemberId)
  );
  const selectMember = (id: string | null) => {
    setAccessId(id);
    onSelectMember?.(id);
  };
  const deviceMember = members.find((member) => member.humanPrincipalId === deviceId);
  return (
    <section aria-label={t("peopleMembers")} data-testid="people-members-section">
      <div
        className={
          selected ? "grid min-w-0 gap-7 xl:grid-cols-[minmax(18rem,.8fr)_minmax(24rem,1.2fr)]" : ""
        }
      >
        <div className="min-w-0">
          <div className="grid grid-cols-[minmax(8rem,1fr)_4rem_7rem] gap-3 border-b border-border/70 px-2 pb-3 text-xs text-text-muted">
            <span>{t("peopleMembers")}</span>
            <span>{t("workspaceRoleColumn")}</span>
            <span className="sr-only">{t("managementActions")}</span>
          </div>
          {members.length === 0 ? (
            <p className="py-6 text-sm text-text-muted" data-testid="people-members-empty">
              {emptyText}
            </p>
          ) : (
            <ul className="divide-y divide-border/60 border-b border-border/70">
              {members.map((member) => {
                const promote = member.actions.find((action) => action.action === "promote");
                const demote = member.actions.find((action) => action.action === "demote");
                const remove = member.actions.find((action) => action.action === "remove");
                const canManageDevices = presence.currentUserIsOwner || member.isCurrentUser;
                return (
                  <li
                    key={member.membershipId}
                    className={`grid grid-cols-[minmax(8rem,1fr)_4rem_7rem] items-center gap-3 rounded-md px-2 py-4 ${selected?.humanPrincipalId === member.humanPrincipalId ? "bg-sky-50 dark:bg-sky-950/30" : ""}`}
                    data-testid="people-member-row"
                    data-principal-id={member.humanPrincipalId}
                    data-role={member.role}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <MemberAvatar
                        identity={member.humanPrincipalId}
                        initials={member.initials}
                        label={member.displayName}
                      />
                      <div className="min-w-0">
                        {member.isCurrentUser && !identity ? (
                          <OwnDisplayNameControl
                            displayName={member.displayName}
                            actionBusy={actionBusy}
                            t={t}
                            onUpdate={onUpdateOwnDisplayName}
                          />
                        ) : (
                          <span className="block truncate text-sm font-medium text-text-strong">
                            {member.displayName}
                            {member.isCurrentUser ? (
                              <span className="ml-1 font-normal text-text-muted">
                                ({t("peopleYou")})
                              </span>
                            ) : null}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-sm text-text-muted">
                      {t(member.role === "owner" ? "peopleRoleOwner" : "peopleRoleMember")}
                    </span>
                    <div className="flex items-center justify-end gap-1">
                      {member.role !== "owner" && canManageMemberAccess && renderMemberAccess ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-sky-700 dark:text-sky-400"
                          data-testid="people-member-access-toggle"
                          aria-expanded={selected?.humanPrincipalId === member.humanPrincipalId}
                          onClick={() =>
                            selectMember(
                              selected?.humanPrincipalId === member.humanPrincipalId
                                ? null
                                : member.humanPrincipalId
                            )
                          }
                        >
                          {t("peopleManagePermissions")}
                        </Button>
                      ) : null}
                      {presence.currentUserIsOwner || member.isCurrentUser ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${t("managementActions")}: ${member.displayName}`}
                            >
                              <EllipsisIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {member.isCurrentUser && identity ? (
                              <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
                                {t("peopleProfile")}
                              </DropdownMenuItem>
                            ) : null}
                            {canManageDevices ? (
                              <DropdownMenuItem
                                data-testid="people-member-devices-toggle"
                                onSelect={() => setDeviceId(member.humanPrincipalId)}
                              >
                                {t("peopleLoginDevices").replace(
                                  "{count}",
                                  String(
                                    devices.filter(
                                      (device) =>
                                        device.humanPrincipalId === member.humanPrincipalId &&
                                        !device.isRevoked
                                    ).length
                                  )
                                )}
                              </DropdownMenuItem>
                            ) : null}
                            {promote?.allowed ? (
                              <DropdownMenuItem
                                data-testid="people-member-promote"
                                disabled={actionBusy}
                                onSelect={() => void onPromoteMember(member.humanPrincipalId)}
                              >
                                {t("peoplePromote")}
                              </DropdownMenuItem>
                            ) : null}
                            {demote?.allowed ? (
                              <DropdownMenuItem
                                data-testid="people-member-demote"
                                disabled={actionBusy}
                                onSelect={() => {
                                  if (window.confirm(t("peopleDemoteConfirm")))
                                    void onDemoteMember(member.humanPrincipalId);
                                }}
                              >
                                {t("peopleDemote")}
                              </DropdownMenuItem>
                            ) : demote?.reason === "last_owner" ? (
                              <DropdownMenuItem disabled data-testid="people-last-owner-guard">
                                {t("peopleLastOwnerProtected")}
                              </DropdownMenuItem>
                            ) : null}
                            {remove?.allowed ? (
                              <DropdownMenuItem
                                className="text-destructive"
                                data-testid="people-member-remove"
                                disabled={actionBusy}
                                onSelect={() => {
                                  if (window.confirm(t("peopleRemoveConfirm")))
                                    void onRemoveMember(member.humanPrincipalId);
                                }}
                              >
                                {t("peopleRemove")}
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {selected ? (
          <aside
            className="min-w-0 rounded-lg border border-border/70 p-5"
            data-testid="people-member-access"
            aria-label={`${selected.displayName} · ${t("accessResources")}`}
          >
            <div className="mb-5 flex items-center gap-3">
              <MemberAvatar
                identity={selected.humanPrincipalId}
                initials={selected.initials}
                label={selected.displayName}
              />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold">{selected.displayName}</h2>
                <p className="mt-1 text-xs text-text-muted">{t("accessResources")}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-text-muted"
                data-testid="people-member-access-close"
                onClick={() => selectMember(null)}
              >
                <XIcon className="size-4" />
                {t("accessCloseDetails")}
              </Button>
            </div>
            {accessScope}
            {canManageMemberAccess ? renderMemberAccess?.(selected) : null}
          </aside>
        ) : null}
      </div>
      <ManagementDialog
        open={Boolean(deviceMember)}
        onOpenChange={(open) => {
          if (!open) setDeviceId(null);
        }}
        title={deviceMember?.displayName ?? t("peopleThisDevice")}
        t={t}
      >
        {deviceMember && (presence.currentUserIsOwner || deviceMember.isCurrentUser) ? (
          <MemberLoginDevices
            id={`people-member-devices-${deviceMember.humanPrincipalId}`}
            devices={devices.filter(
              (device) =>
                device.humanPrincipalId === deviceMember.humanPrincipalId && !device.isRevoked
            )}
            loading={detailsLoading}
            actionBusy={actionBusy}
            t={t}
            onSignOut={onRevokeDevice}
          />
        ) : null}
      </ManagementDialog>
      <ManagementDialog
        open={profileOpen}
        onOpenChange={setProfileOpen}
        title={t("peopleProfile")}
        t={t}
      >
        {identity ? (
          <PeopleIdentityCard
            identity={identity}
            actionBusy={actionBusy}
            t={t}
            onUpdateDisplayName={onUpdateOwnDisplayName}
          />
        ) : null}
      </ManagementDialog>
    </section>
  );
}
