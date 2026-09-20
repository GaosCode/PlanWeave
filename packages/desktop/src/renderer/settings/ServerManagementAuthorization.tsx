import { useServerManagementAuthorization } from "../hooks/useServerManagementAuthorization";
import { Button } from "@/components/ui/button";
import { operatorControlBridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { formatHostAdministrationError } from "./hostAdministrationErrors";

export function ServerManagementAuthorization({ t }: { t: ReturnType<typeof createTranslator> }) {
  const { status, profileId, profile, busy, error, verifiedId, importCredential, selectProfile } =
    useServerManagementAuthorization();
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
          disabled={busy}
          className="max-w-full rounded-md border border-border bg-background p-2 text-sm"
          onChange={(event) => {
            selectProfile(event.target.value);
          }}
        >
          <option value="" disabled>
            {t("settingsServer")}
          </option>
          {status.profiles.map((item) => (
            <option key={item.profileId} value={item.profileId}>
              {item.displayName} — {item.serverBaseUrl}
            </option>
          ))}
        </select>
      ) : null}
      {profile ? (
        <p className="break-all text-xs text-text-muted">
          {profile.serverBaseUrl}
          {profile.operatorId ? ` · ${profile.operatorId}` : ""}
        </p>
      ) : null}
      <Button
        className="w-fit"
        variant="outline"
        disabled={!profile || busy}
        onClick={() => void importCredential()}
      >
        {t("serverManagementImport")}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {formatHostAdministrationError(error, t)}
        </p>
      ) : null}
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
