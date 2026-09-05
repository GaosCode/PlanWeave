import { Button } from "@/components/ui/button";
import type { PeopleDeviceRow } from "../collaboration/peopleViewModels";
import type { createTranslator } from "../i18n";

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

export function MemberLoginDevices({
  id,
  devices,
  loading,
  actionBusy,
  t,
  onSignOut
}: {
  id: string;
  devices: readonly PeopleDeviceRow[];
  loading: boolean;
  actionBusy: boolean;
  t: ReturnType<typeof createTranslator>;
  onSignOut: (deviceCredentialId: string) => Promise<boolean>;
}) {
  return (
    <div
      id={id}
      className="mx-12 mb-3 rounded-md bg-muted/25 px-3 py-2.5"
      data-testid="people-member-devices"
    >
      {loading ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t("peopleLoading")}
        </p>
      ) : devices.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("peopleNoLoginDevices")}</p>
      ) : (
        <ul className="space-y-2.5">
          {devices.map((device, index) => {
            const displayName =
              device.isCurrentDevice === true
                ? t("peopleThisDevice")
                : device.label !== device.deviceCredentialId
                  ? device.label
                  : t("peopleUnnamedDevice").replace("{number}", String(index + 1));
            return (
              <li
                key={device.deviceCredentialId}
                className="flex min-w-0 items-start gap-3 text-xs"
                data-testid="people-device-row"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-strong">{displayName}</div>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">
                    {t("peopleDeviceCreated").replace("{time}", formatTimestamp(device.createdAt))}
                    <span aria-hidden="true"> · </span>
                    {t("peopleDeviceLastSeen")}:{" "}
                    {device.lastSeenAt
                      ? formatTimestamp(device.lastSeenAt)
                      : t("peopleHostFieldUnavailable")}
                    <span aria-hidden="true"> · </span>
                    <span className="font-mono" title={device.deviceCredentialId}>
                      {t("peopleDeviceCredentialId").replace(
                        "{id}",
                        shortIdentifier(device.deviceCredentialId)
                      )}
                    </span>
                  </div>
                </div>
                {device.canRevoke === false ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 shrink-0 px-2 text-[11px] text-destructive"
                    data-testid="people-device-sign-out"
                    disabled={actionBusy}
                    onClick={() => {
                      if (!window.confirm(t("peopleSignOutDeviceConfirm"))) return;
                      void onSignOut(device.deviceCredentialId);
                    }}
                  >
                    {t("peopleSignOutDevice")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
