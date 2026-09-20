import { ManagementDialog } from "../components/ManagementDialog";
import { useState } from "react";
import { useServerManagementAuthorization } from "../hooks/useServerManagementAuthorization";
import { Button } from "@/components/ui/button";
import { operatorControlBridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { serverProfileLabel } from "./serverProfileLabel";
import { formatHostAdministrationError } from "./hostAdministrationErrors";

export function ServerManagementAuthorization({ t }: { t: ReturnType<typeof createTranslator> }) {
  const {
    status,
    profileId,
    profile,
    busy,
    checking,
    management,
    error,
    verifiedId,
    importCredential,
    reauthorize,
    recover,
    revoke,
    selectProfile,
    refresh
  } = useServerManagementAuthorization();
  const [open, setOpen] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState("");
  const displayedError = error ?? management?.errorCode;
  const endpointUnavailable = displayedError === "operator_management_upgrade_required";
  const recoveryNeeded = [
    "operator_management_recovery_required",
    "operator_unauthorized",
    "operator_credential_missing",
    "operator_device_revoked"
  ].includes(displayedError ?? "");
  const authorized = Boolean(management?.authorization && !displayedError);
  const stateText =
    status?.profiles.length === 0
      ? t("serverManagementEmpty")
      : checking
        ? t("serverManagementChecking")
        : authorized
          ? t("serverManagementAutomatic")
          : recoveryNeeded
            ? t("serverManagementNeedsRecovery")
            : endpointUnavailable
              ? t("serverManagementUpgradeRequired")
              : t("serverManagementUnavailable");
  const quotedOperatorId = `'${(profile?.operatorId ?? "<operator-id>").replace(/'/g, "'\\''")}'`;
  return (
    <section
      className="mt-6 flex max-w-3xl flex-col gap-3 rounded-lg border border-border/70 p-5"
      data-testid="server-management-authorization"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-text-strong">
            {t("serverManagementAuthorization")}
          </h2>
          <p role="status" className="mt-1 text-sm text-text-muted">
            {stateText}
          </p>
          {profile ? (
            <p className="mt-1 text-xs text-text-muted">{serverProfileLabel(profile, t)}</p>
          ) : null}
        </div>
        <Button variant="outline" disabled={!profile || checking} onClick={() => setOpen(true)}>
          {t(recoveryNeeded ? "serverManagementRestoreAccess" : "serverManagementDetails")}
        </Button>
      </div>
      {profile?.operatorCredentialPersistence === "session-only" && authorized ? (
        <p className="text-sm text-text-muted">{t("serverManagementSessionOnly")}</p>
      ) : null}
      <ManagementDialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setRecoveryCode("");
            setRevokeId(null);
          }
        }}
        title={t("serverManagementAuthorization")}
        t={t}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">{t("serverManagementAuthorizationHint")}</p>
          {!operatorControlBridge ? <p role="alert">{t("hostAdminBridgeUnavailable")}</p> : null}
          {status?.profiles.length === 0 ? <p>{t("serverManagementEmpty")}</p> : null}
          {status && status.profiles.length > 0 ? (
            <select
              aria-label={t("serverManagementAuthorization")}
              value={profileId ?? ""}
              disabled={busy || checking}
              className="max-w-full rounded-md border border-border bg-background p-2 text-sm"
              onChange={(event) => {
                setRecoveryCode("");
                selectProfile(event.target.value);
                setRevokeId(null);
              }}
            >
              <option value="" disabled>
                {t("settingsServer")}
              </option>
              {status.profiles.map((item) => (
                <option key={item.profileId} value={item.profileId}>
                  {serverProfileLabel(item, t)} · {item.operatorId} · {item.profileId.slice(-6)}
                </option>
              ))}
            </select>
          ) : null}
          {profile ? (
            <p
              className="break-all text-xs text-text-muted"
              data-testid="management-server-identity"
            >
              {profile.serverBaseUrl} · {t("serverManagementAdministrator")}: {profile.operatorId}
            </p>
          ) : null}
          {checking ? (
            <p role="status" className="text-sm text-text-muted">
              {t("serverManagementChecking")}
            </p>
          ) : null}
          {management?.authorization && management.profileId === profileId ? (
            <p role="status" className="text-sm text-text-muted">
              {t(
                management.deviceId ? "serverManagementDeviceRemembered" : "serverManagementLegacy"
              )}
            </p>
          ) : null}
          {!authorized ? (
            <Button
              className="w-fit"
              disabled={!profile || busy || checking || endpointUnavailable}
              onClick={() => void reauthorize()}
            >
              {busy ? t("serverManagementWorking") : t("serverManagementReauthorize")}
            </Button>
          ) : null}
          {!authorized ? (
            <p className="text-xs text-text-muted">{t("serverManagementReauthorizeHint")}</p>
          ) : null}
          {displayedError ? (
            <p role="alert" className="text-sm text-destructive">
              {formatHostAdministrationError(
                displayedError === "operator_unauthorized"
                  ? "operator_management_recovery_required"
                  : displayedError,
                t
              )}
            </p>
          ) : null}
          {displayedError && !endpointUnavailable ? (
            <Button
              className="w-fit"
              variant="outline"
              disabled={!profile || busy || checking}
              onClick={refresh}
            >
              {t("serverManagementCheckAgain")}
            </Button>
          ) : null}
          {endpointUnavailable ? (
            <div
              className="rounded-md border border-border/70 p-3 text-sm"
              data-testid="management-upgrade-guide"
            >
              <h3 className="font-medium">{t("serverManagementUpgradeTitle")}</h3>
              <p className="mt-2 text-text-muted">
                {t(
                  profile?.hostedByThisDesktop
                    ? "serverManagementUpgradeLocal"
                    : "serverManagementUpgradeRemote"
                )}
              </p>
              <ol className="my-3 list-decimal space-y-2 pl-5 text-text-muted">
                <li>{t("serverManagementUpgradeDeploy")}</li>
                <li>{t("serverManagementUpgradeProxy")}</li>
                <li>{t("serverManagementUpgradeThenAuthorize")}</li>
              </ol>
              <Button variant="outline" disabled={!profile || busy || checking} onClick={refresh}>
                {t("serverManagementCheckAgain")}
              </Button>
            </div>
          ) : null}
          {!authorized && !endpointUnavailable ? (
            <details
              key={profileId}
              open={recoveryNeeded || Boolean(recoveryCode) || undefined}
              className="border-t border-border/70 pt-3"
            >
              <summary className="cursor-pointer text-sm">{t("serverManagementRecovery")}</summary>
              <p className="my-3 text-sm text-text-muted">{t("serverManagementRecoveryHint")}</p>
              <p className="mb-1 text-xs text-text-muted">Docker Compose</p>
              <code className="block break-all rounded bg-surface-muted p-3 text-xs">
                docker compose exec server node /app/dist/bin.js auth recover --operator{" "}
                {quotedOperatorId}
              </code>
              <p className="mb-1 mt-2 text-xs text-text-muted">{t("serverManagementStandalone")}</p>
              <code className="block break-all rounded bg-surface-muted p-3 text-xs">
                planweave-server auth recover --config /path/to/server.json --operator{" "}
                {quotedOperatorId}
              </code>
              <form
                className="mt-3 flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void recover(recoveryCode.trim()).then((success) => {
                    if (success) setRecoveryCode("");
                  });
                }}
              >
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={recoveryCode}
                  aria-label={t("serverManagementRecoveryCode")}
                  placeholder={t("serverManagementRecoveryCode")}
                  disabled={busy || endpointUnavailable}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background p-2 text-sm"
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={
                    !profile || busy || checking || endpointUnavailable || !recoveryCode.trim()
                  }
                >
                  {t("serverManagementRecover")}
                </Button>
              </form>
            </details>
          ) : null}
          {authorized && management?.devices ? (
            <div className="border-t border-border/70 pt-3">
              <h3 className="text-sm font-medium">{t("serverManagementDevices")}</h3>
              <p className="my-2 text-xs text-text-muted">{t("serverManagementDevicesHint")}</p>
              {management.devices
                .filter((device) => !device.revokedAt)
                .map((device) => (
                  <div
                    key={device.deviceId}
                    className="flex items-center justify-between gap-3 border-b border-border/50 py-3"
                  >
                    <div className="min-w-0 text-sm">
                      <p className="break-words">
                        {device.deviceName}
                        {device.deviceId === management.deviceId
                          ? ` · ${t("serverManagementThisDevice")}`
                          : ""}
                      </p>
                      <p className="text-xs text-text-muted">
                        {t("serverManagementLastUsed")}{" "}
                        {new Date(device.lastUsedAt).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRevokeId(device.deviceId)}
                    >
                      {t("serverManagementRevoke")}
                    </Button>
                  </div>
                ))}
              {revokeId ? (
                <div className="mt-3 rounded border border-border p-3">
                  <p className="mb-3 text-sm">{t("serverManagementRevokeConfirm")}</p>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void revoke(revokeId).then((success) => {
                          if (success) setRevokeId(null);
                        })
                      }
                    >
                      {t("serverManagementRevoke")}
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => setRevokeId(null)}>
                      {t("accessCancelChanges")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <details className="border-t border-border/70 pt-3">
            <summary className="cursor-pointer text-sm">{t("serverManagementAdvanced")}</summary>
            <p className="my-3 text-sm text-text-muted">{t("serverManagementImportHint")}</p>
            <Button
              className="w-fit"
              variant="outline"
              disabled={!profile || busy || checking}
              onClick={() => void importCredential()}
            >
              {t("serverManagementImport")}
            </Button>
          </details>
          {profile && verifiedId === profile.profileId ? (
            <p role="status" className="text-sm">
              {t(
                profile.operatorCredentialPersistence === "session-only"
                  ? "serverManagementSessionOnly"
                  : "serverManagementVerified"
              )}
            </p>
          ) : null}
        </div>
      </ManagementDialog>
    </section>
  );
}
