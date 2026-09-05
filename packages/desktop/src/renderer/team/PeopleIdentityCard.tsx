import type { PeopleIdentity } from "../collaboration/peopleViewModels";
import type { createTranslator } from "../i18n";
import { OwnDisplayNameControl } from "./OwnDisplayNameControl";

function shortIdentifier(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function PeopleIdentityCard({
  identity,
  actionBusy,
  t,
  onUpdateDisplayName
}: {
  identity: PeopleIdentity;
  actionBusy: boolean;
  t: ReturnType<typeof createTranslator>;
  onUpdateDisplayName: (displayName: string) => Promise<boolean>;
}) {
  return (
    <section
      className="flex flex-col gap-3 border-b border-border/70 px-1 pb-5"
      data-testid="people-profile-card"
      aria-label={t("peopleProfile")}
    >
      <div>
        <h2 className="text-sm font-semibold text-text-strong">{t("peopleProfile")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("peopleProfileHint")}</p>
      </div>
      <OwnDisplayNameControl
        displayName={identity.displayName}
        actionBusy={actionBusy}
        t={t}
        onUpdate={onUpdateDisplayName}
        showYouLabel={false}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{identity.role === "owner" ? t("peopleRoleOwner") : t("peopleRoleMember")}</span>
        <span aria-hidden="true">·</span>
        <span data-testid="people-profile-device">
          {t("peopleThisDevice")}
          <span className="ml-1 font-mono" title={identity.deviceSessionId}>
            {shortIdentifier(identity.deviceSessionId)}
          </span>
        </span>
      </div>
    </section>
  );
}
