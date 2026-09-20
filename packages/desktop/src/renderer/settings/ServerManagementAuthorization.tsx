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
    selectProfile,
    refresh
  } = useServerManagementAuthorization();
  const [recoveryCode, setRecoveryCode] = useState("");
  const displayedError = error ?? management?.errorCode;
  const endpointUnavailable = displayedError === "operator_management_upgrade_required";
  const recoveryNeeded = displayedError === "operator_management_recovery_required";
  const quotedOperatorId = `'${(profile?.operatorId ?? "<operator-id>").replace(/'/g, "'\\''")}'`;
  return (
    <section
      className="mt-6 flex max-w-3xl flex-col gap-3 rounded-lg border border-border/70 p-5"
      data-testid="server-management-authorization"
    >
      <h2 className="text-sm font-medium text-text-strong">{t("serverManagementAuthorization")}</h2>
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
        <p className="break-all text-xs text-text-muted" data-testid="management-server-identity">
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
          {t("serverManagementAutomatic")} · {t("serverManagementExpires")}{" "}
          {new Date(management.authorization.expiresAt).toLocaleString()}
        </p>
      ) : null}
      <Button
        className="w-fit"
        disabled={!profile || busy || checking || endpointUnavailable}
        onClick={() => void reauthorize()}
      >
        {busy ? t("serverManagementWorking") : t("serverManagementReauthorize")}
      </Button>
      <p className="text-xs text-text-muted">{t("serverManagementReauthorizeHint")}</p>
      {displayedError ? (
        <p role="alert" className="text-sm text-destructive">
          {formatHostAdministrationError(displayedError, t)}
        </p>
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
          planweave-server auth recover --config /path/to/server.json --operator {quotedOperatorId}
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
            disabled={!profile || busy || checking || endpointUnavailable || !recoveryCode.trim()}
          >
            {t("serverManagementRecover")}
          </Button>
        </form>
      </details>
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
    </section>
  );
}
