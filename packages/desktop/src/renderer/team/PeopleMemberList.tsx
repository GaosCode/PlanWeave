import { useState, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
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
  const selected = members.find((member) => member.humanPrincipalId === accessId);
  const deviceMember = members.find((member) => member.humanPrincipalId === deviceId);
  return (
    <section aria-label={t("peopleMembers")} data-testid="people-members-section">
      <div className="grid grid-cols-[minmax(10rem,1.4fr)_minmax(6rem,.7fr)_minmax(8rem,1fr)] gap-4 border-b border-border/70 pb-3 text-xs text-text-muted">
        <span>{t("peopleMembers")}</span>
        <span>{t("workspaceRoleColumn")}</span>
        <span className="text-right">{t("workspaceAccessSettings")}</span>
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
                className="grid grid-cols-[minmax(10rem,1.4fr)_minmax(6rem,.7fr)_minmax(8rem,1fr)] items-center gap-4 py-4"
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
                      onClick={() => setAccessId(member.humanPrincipalId)}
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
      <ManagementDialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setAccessId(null);
        }}
        title={`${selected?.displayName ?? ""} · ${t("workspaceAccessSettings")}`}
        t={t}
      >
        <div className="flex flex-col gap-5" data-testid="people-member-access">
          {accessScope}
          {selected && canManageMemberAccess ? renderMemberAccess?.(selected) : null}
        </div>
      </ManagementDialog>
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
